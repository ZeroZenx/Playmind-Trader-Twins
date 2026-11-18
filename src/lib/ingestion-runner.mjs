import { createHash } from 'node:crypto';
import { readPrivateBlob, scanPrivateBlob } from './blob.mjs';

const LEASE_SECONDS = 300;

const forbidden = new Set([
  'name', 'full_name', 'first_name', 'last_name', 'username', 'user_name', 'customer_name',
  'email', 'email_address', 'phone', 'address', 'date_of_birth', 'dob', 'government_id',
  'ip', 'ip_address', 'device_fingerprint', 'unmasked_account_id', 'account_id', 'customer_id',
]);
const requiredHeaders = ['event_id', 'trader_token', 'occurred_at', 'type', 'venue_id', 'source_row_number'];

function parseCsvLine(line) {
  const cells = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    const next = line[index + 1];
    if (character === '"' && quoted && next === '"') { current += '"'; index += 1; }
    else if (character === '"') quoted = !quoted;
    else if (character === ',' && !quoted) { cells.push(current); current = ''; }
    else current += character;
  }
  cells.push(current);
  return cells;
}

function normalizeHeader(header) { return header.trim().toLowerCase().replace(/\s+/g, '_'); }

function numberOrNull(value, field) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${field}: Expected a finite number`);
  return Number.isFinite(number) ? number : null;
}

function parseEvent(raw, rowNumber) {
  const required = ['event_id', 'trader_token', 'occurred_at', 'type', 'venue_id', 'source_row_number'];
  for (const field of required) if (!raw[field]) throw new Error(`${field}: Required`);
  if (Number.isNaN(Date.parse(raw.occurred_at))) throw new Error('occurred_at: Invalid date');
  const types = new Set(['trade', 'deposit', 'withdrawal', 'balance_snapshot', 'policy_event', 'restriction_event', 'self_exclusion_event']);
  if (!types.has(raw.type)) throw new Error(`type: Invalid enum value`);
  const event = {
    event_id: raw.event_id,
    trader_token: raw.trader_token,
    occurred_at: new Date(raw.occurred_at).toISOString(),
    type: raw.type,
    venue_id: raw.venue_id,
    market_id: raw.market_id || null,
    market_type: raw.market_type || null,
    side: raw.side || null,
    price: numberOrNull(raw.price, 'price'), quantity: numberOrNull(raw.quantity, 'quantity'), stake_amount: numberOrNull(raw.stake_amount, 'stake_amount'),
    payout_amount: numberOrNull(raw.payout_amount, 'payout_amount'), deposit_amount: numberOrNull(raw.deposit_amount, 'deposit_amount'), withdrawal_amount: numberOrNull(raw.withdrawal_amount, 'withdrawal_amount'),
    balance_before: numberOrNull(raw.balance_before, 'balance_before'), balance_after: numberOrNull(raw.balance_after, 'balance_after'),
    policy_event_type: raw.policy_event_type || null, policy_event_value: raw.policy_event_value || null,
    realized_result: numberOrNull(raw.realized_result, 'realized_result'), placed_at: raw.placed_at || null, settled_at: raw.settled_at || null,
    provenance: raw.provenance ? JSON.parse(raw.provenance) : {}, source_row_number: Number(raw.source_row_number),
  };
  if (!Number.isInteger(event.source_row_number) || event.source_row_number < 1) throw new Error('source_row_number: Expected a positive integer');
  for (const field of ['placed_at', 'settled_at']) if (event[field] && Number.isNaN(Date.parse(event[field]))) throw new Error(`${field}: Invalid date`);
  return event;
}

export function parseTokenizedCsv(csv) {
  const lines = csv.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (!lines.length) throw new Error('CSV is empty');
  const headers = parseCsvLine(lines[0]).map((header) => header.trim());
  const normalized = headers.map((header) => header.toLowerCase());
  const prohibited = [...new Set(headers.map(normalizeHeader).filter((header) => forbidden.has(header)))];
  if (prohibited.length) throw new Error(`Direct PII fields are prohibited: ${prohibited.join(', ')}`);
  const missing = requiredHeaders.filter((header) => !normalized.includes(header));
  if (missing.length) throw new Error(`Required columns are missing: ${missing.join(', ')}`);
  if (new Set(normalized).size !== normalized.length) throw new Error('CSV contains duplicate column headers');
  const events = [];
  const errors = [];
  const seen = new Set();
  for (let index = 1; index < lines.length; index += 1) {
    const values = parseCsvLine(lines[index]);
    const raw = Object.fromEntries(headers.map((header, valueIndex) => [header, values[valueIndex] || null]));
    try {
      const event = parseEvent(raw, index + 1);
      if (seen.has(event.event_id)) throw new Error(`Duplicate event_id: ${event.event_id}`);
      seen.add(event.event_id);
      events.push(event);
    } catch (error) {
      errors.push({ row: index + 1, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { events, errors, headers };
}

function rowValues(event, workspaceId, datasetId) {
  const values = event;
  return [workspaceId, datasetId, values.event_id, values.trader_token, values.occurred_at, values.type, values.venue_id,
    values.market_id ?? null, values.market_type ?? null, values.side ?? null, values.price ?? null, values.quantity ?? null,
    values.stake_amount ?? null, values.payout_amount ?? null, values.deposit_amount ?? null, values.withdrawal_amount ?? null,
    values.balance_before ?? null, values.balance_after ?? null, values.policy_event_type ?? null, values.policy_event_value ?? null,
    values.realized_result ?? null, values.placed_at ?? null, values.settled_at ?? null, JSON.stringify(values.provenance ?? {}), values.source_row_number];
}

async function claimJob(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `SELECT j.id, j.workspace_id, j.dataset_id, j.source_filename, j.storage_path, j.attempts, j.content_type,
              j.size_bytes, d.storage_etag
         FROM ingestion_jobs j
         JOIN datasets d ON d.id = j.dataset_id
        WHERE status = 'queued'
           OR (status = 'running' AND lease_expires_at < now())
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED LIMIT 1`,
    );
    if (!result.rows[0]) {
      await client.query('COMMIT');
      return null;
    }
    const job = result.rows[0];
    await client.query(
      `UPDATE ingestion_jobs
          SET status = 'running', attempts = attempts + 1, started_at = coalesce(started_at, now()),
              lease_expires_at = now() + ($2 || ' seconds')::interval, updated_at = now()
        WHERE id = $1`,
      [job.id, String(LEASE_SECONDS)],
    );
    await client.query(
      `UPDATE datasets SET status = 'validating', upload_status = 'processing', updated_at = now() WHERE id = $1`,
      [job.dataset_id],
    );
    await client.query('COMMIT');
    return job;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function markFailed(pool, job, error) {
  const message = error instanceof Error ? error.message : String(error);
  await pool.query(
    `UPDATE ingestion_jobs SET status = 'failed', error_message = $2, errors = jsonb_build_array(jsonb_build_object('message', $2)), finished_at = now(), lease_expires_at = NULL, updated_at = now() WHERE id = $1`,
    [job.id, message.slice(0, 2000)],
  );
  await pool.query(
    `UPDATE datasets SET status = 'rejected', upload_status = 'failed', updated_at = now() WHERE id = $1`,
    [job.dataset_id],
  );
  return { jobId: job.id, datasetId: job.dataset_id, status: 'failed', error: message };
}

async function persistEvents(pool, job, dataset, parsed, sourceSha256) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const priorExperiments = await client.query(`SELECT count(*)::int AS count FROM experiments WHERE dataset_id = $1`, [job.dataset_id]);
    if (priorExperiments.rows[0].count > 0) throw new Error('Dataset already has an experiment. Create a new dataset for replacement.');
    await client.query(`DELETE FROM signal_runs WHERE dataset_id = $1`, [job.dataset_id]);
    await client.query(`DELETE FROM trader_events WHERE dataset_id = $1`, [job.dataset_id]);
    const traders = new Set();
    const dates = [];
    for (const event of parsed.events) {
      const values = rowValues(event, job.workspace_id, job.dataset_id);
      traders.add(event.trader_token);
      dates.push(new Date(event.occurred_at).getTime());
      await client.query(
        `INSERT INTO trader_events
          (workspace_id, dataset_id, event_id, trader_token, occurred_at, type, venue_id, market_id, market_type,
           side, price, quantity, stake_amount, payout_amount, deposit_amount, withdrawal_amount, balance_before,
           balance_after, policy_event_type, policy_event_value, realized_result, placed_at, settled_at, provenance, source_row_number)
         VALUES ($1, $2, $3, $4, $5, $6::event_type, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24::jsonb, $25)
         ON CONFLICT (dataset_id, event_id) DO NOTHING`, values,
      );
    }
    const startsAt = dates.length ? new Date(Math.min(...dates)).toISOString() : null;
    const endsAt = dates.length ? new Date(Math.max(...dates)).toISOString() : null;
    const qualityReport = {
      parser: 'tokenized-csv-v1',
      validRows: parsed.events.length,
      rejectedRows: parsed.errors.length,
      duplicateEventIds: parsed.errors.filter((error) => error.message.startsWith('Duplicate event_id:')).length,
      directPiiHeadersRejected: false,
      headers: parsed.headers,
      source: 'private-object-storage',
      sourceSha256,
    };
    const finalStatus = parsed.errors.length ? 'rejected' : parsed.events.length ? 'ready' : 'rejected';
    await client.query(
      `UPDATE datasets SET status = $1::dataset_status, upload_status = $2, source_sha256 = $3,
          row_count = $4, trader_count = $5, starts_at = $6, ends_at = $7, quality_report = $8::jsonb, updated_at = now()
        WHERE id = $9`,
      [finalStatus, finalStatus === 'ready' ? 'processed' : 'failed', sourceSha256, parsed.events.length, traders.size, startsAt, endsAt, JSON.stringify(qualityReport), job.dataset_id],
    );
    await client.query(
      `UPDATE ingestion_jobs SET status = $1::job_status, row_count = $2, error_count = $3, errors = $4::jsonb,
          source_sha256 = $5, finished_at = now(), lease_expires_at = NULL, updated_at = now() WHERE id = $6`,
      [parsed.errors.length ? 'failed' : 'succeeded', parsed.events.length, parsed.errors.length, JSON.stringify(parsed.errors), sourceSha256, job.id],
    );
    await client.query('COMMIT');
    return { jobId: job.id, datasetId: job.dataset_id, status: parsed.errors.length ? 'failed' : 'succeeded', rowCount: parsed.events.length, errorCount: parsed.errors.length };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function processNextIngestionJob(pool) {
  const job = await claimJob(pool);
  if (!job) return { status: 'idle' };
  try {
    if (!job.storage_path) throw new Error('Ingestion job has no storage path');
    const scanStatus = await scanPrivateBlob({ pathname: job.storage_path, etag: job.storage_etag, sizeBytes: job.size_bytes });
    await pool.query(`UPDATE datasets SET malware_scan_status = $2, updated_at = now() WHERE id = $1`, [job.dataset_id, scanStatus]);
    const blob = await readPrivateBlob(job.storage_path);
    if (!blob) throw new Error('Uploaded file was not found in private storage');
    const sourceSha256 = createHash('sha256').update(blob.text).digest('hex');
    const parsed = parseTokenizedCsv(blob.text);
    const dataset = { id: job.dataset_id, workspace_id: job.workspace_id };
    return await persistEvents(pool, job, dataset, parsed, sourceSha256);
  } catch (error) {
    return markFailed(pool, job, error);
  }
}
