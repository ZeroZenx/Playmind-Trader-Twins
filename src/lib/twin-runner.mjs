import { stableSeed } from '../engine/rng.mjs';
import { runTwinPipeline } from '../engine/pipeline.mjs';

const DEFAULT_RUN_OPTIONS = Object.freeze({
  seed: 42,
  holdoutSeed: 7100,
  sweepSeed: 7200,
  holdoutReplicates: 3,
  sweepReplicates: 3,
  horizonDays: 30
});

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function jsonValue(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function mapDatabaseEvent(row) {
  const event = {
    event_id: row.event_id,
    trader_token: row.trader_token,
    occurred_at: new Date(row.occurred_at).toISOString(),
    type: row.type,
    venue_id: row.venue_id,
    market_id: row.market_id ?? null,
    market_type: row.market_type ?? null,
    side: row.side ?? null,
    price: finiteNumber(row.price),
    quantity: finiteNumber(row.quantity),
    stake_amount: finiteNumber(row.stake_amount),
    payout_amount: finiteNumber(row.payout_amount),
    deposit_amount: finiteNumber(row.deposit_amount),
    withdrawal_amount: finiteNumber(row.withdrawal_amount),
    balance_before: finiteNumber(row.balance_before),
    balance_after: finiteNumber(row.balance_after),
    policy_event_type: row.policy_event_type ?? null,
    policy_event_value: row.policy_event_value ?? null,
    realized_result: finiteNumber(row.realized_result),
    placed_at: row.placed_at ? new Date(row.placed_at).toISOString() : null,
    settled_at: row.settled_at ? new Date(row.settled_at).toISOString() : null,
    source_row_number: Number(row.source_row_number)
  };
  const provenance = jsonValue(row.provenance, null);
  if (provenance && typeof provenance === 'object' && !Array.isArray(provenance)) event.provenance = provenance;
  return event;
}

function runOptions(payload) {
  const input = jsonValue(payload, {});
  return {
    ...DEFAULT_RUN_OPTIONS,
    ...input,
    policies: Array.isArray(input.policies) ? input.policies : undefined
  };
}

function rangeBounds(trainingWindow, dataset) {
  return {
    start: trainingWindow?.start ?? dataset.starts_at ?? null,
    end: trainingWindow?.end ?? dataset.ends_at ?? null
  };
}

function parameterRows(twin) {
  const rows = [];
  for (const [name, value] of Object.entries(twin.parameters ?? {})) {
    const entries = name === 'stopHazard' && value && typeof value === 'object' && !Array.isArray(value)
      ? Object.entries(value).map(([bucket, record]) => [`${name}.${bucket}`, record])
      : [[name, value]];
    for (const [parameter, record] of entries) {
      if (!record || typeof record !== 'object') continue;
      rows.push({
        parameter,
        status: record.status,
        estimate: record.estimate ?? null,
        intervalLower: record.interval?.[0] ?? null,
        intervalUpper: record.interval?.[1] ?? null,
        intervalLevel: 0.9,
        n: record.n ?? 0,
        shrinkageWeight: record.weight ?? null,
        rawEstimate: record.raw ?? null,
        priorEstimate: record.priorEstimate ?? null,
        reason: record.reason ?? null,
        posterior: record.posterior ?? null,
        details: record
      });
    }
  }
  return rows;
}

async function withTransaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const value = await work(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function persistPipeline(pool, job, dataset, result) {
  return withTransaction(pool, async (client) => {
    await client.query(
      `DELETE FROM twin_population_priors WHERE dataset_id = $1 AND model_version = $2`,
      [dataset.id, result.fit.modelVersion],
    );
    const priorResult = await client.query(
      `INSERT INTO twin_population_priors
        (workspace_id, dataset_id, model_version, behavior_version, data_label, training_window,
         trader_count, behavior_options, priors)
       VALUES ($1, $2, $3, $4, $5, tstzrange($6::timestamptz, $7::timestamptz, '[]'), $8, $9::jsonb, $10::jsonb)
       RETURNING id`,
      [
        dataset.workspace_id,
        dataset.id,
        result.fit.modelVersion,
        result.fit.behaviorVersion,
        result.fit.dataLabel,
        result.fit.trainingWindow.start,
        result.fit.trainingWindow.end,
        result.fit.inputs.traderCount,
        JSON.stringify(result.fit.behaviorOptions),
        JSON.stringify(result.fit.priors)
      ],
    );
    const priorId = priorResult.rows[0].id;

    for (const twin of result.fit.twins) {
      const bounds = rangeBounds(twin.trainingWindow, dataset);
      const twinResult = await client.query(
        `INSERT INTO trader_twins
          (workspace_id, dataset_id, trader_token, model_name, model_version, random_seed,
           training_window, validation_window, profile, validation, data_label, behavior_version,
           population_prior_id, stop_hazard_basis)
         VALUES ($1, $2, $3, 'behavioral-twin', $4, $5,
                 tstzrange($6::timestamptz, $7::timestamptz, '[]'), NULL, $8::jsonb, $9::jsonb,
                 $10, $11, $12, $13)
         RETURNING id`,
        [
          dataset.workspace_id,
          dataset.id,
          twin.traderToken,
          twin.modelVersion,
          stableSeed(`${job.id}:${twin.traderToken}`),
          bounds.start,
          bounds.end,
          JSON.stringify({ inputs: twin.inputs, descriptive: twin.descriptive, payoutDistribution: twin.payoutDistribution }),
          JSON.stringify({ holdoutVersion: result.holdout.holdoutVersion, summary: result.holdout.summary }),
          twin.dataLabel,
          twin.behaviorVersion,
          priorId,
          twin.stopHazardBasis
        ],
      );
      for (const parameter of parameterRows(twin)) {
        await client.query(
          `INSERT INTO trader_twin_parameters
            (twin_id, parameter, status, estimate, interval_lower, interval_upper, interval_level,
             n, shrinkage_weight, raw_estimate, prior_estimate, reason, posterior, details)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb)
           ON CONFLICT (twin_id, parameter) DO UPDATE SET
             status = EXCLUDED.status,
             estimate = EXCLUDED.estimate,
             interval_lower = EXCLUDED.interval_lower,
             interval_upper = EXCLUDED.interval_upper,
             interval_level = EXCLUDED.interval_level,
             n = EXCLUDED.n,
             shrinkage_weight = EXCLUDED.shrinkage_weight,
             raw_estimate = EXCLUDED.raw_estimate,
             prior_estimate = EXCLUDED.prior_estimate,
             reason = EXCLUDED.reason,
             posterior = EXCLUDED.posterior,
             details = EXCLUDED.details`,
          [
            twinResult.rows[0].id,
            parameter.parameter,
            parameter.status,
            parameter.estimate,
            parameter.intervalLower,
            parameter.intervalUpper,
            parameter.intervalLevel,
            parameter.n,
            parameter.shrinkageWeight,
            parameter.rawEstimate,
            parameter.priorEstimate,
            parameter.reason,
            JSON.stringify(parameter.posterior),
            JSON.stringify(parameter.details)
          ],
        );
      }
    }

    const resultRows = [
      {
        scenario: 'fit',
        metrics: { pipelineVersion: result.pipelineVersion, modelVersion: result.fit.modelVersion, inputs: result.fit.inputs, priors: result.fit.priors },
        coverage: { dataLabel: result.fit.dataLabel, trainingWindow: result.fit.trainingWindow },
        limitations: { claim: 'Parameter estimates describe the supplied dataset. They do not infer intent.' }
      },
      {
        scenario: 'holdout',
        metrics: { summary: result.holdout.summary, metrics: result.holdout.metrics },
        coverage: result.holdout.inputs,
        limitations: { claim: result.holdout.claim, assumptions: result.holdout.assumptions, labels: result.holdout.labels }
      },
      {
        scenario: 'policy_sweep',
        metrics: { cellCount: result.sweep.cellCount, baseline: result.sweep.baseline, policies: result.sweep.policies },
        coverage: { dataLabel: result.sweep.dataLabel, replicates: result.sweep.replicates, traderCount: result.sweep.traders?.length ?? 0 },
        limitations: { claim: result.sweep.claim, assumptions: result.sweep.assumptions }
      }
    ];
    for (const item of resultRows) {
      await client.query(
        `INSERT INTO experiment_results (experiment_id, scenario, metrics, coverage, limitations)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb)
         ON CONFLICT (experiment_id, scenario) DO UPDATE SET
           metrics = EXCLUDED.metrics, coverage = EXCLUDED.coverage, limitations = EXCLUDED.limitations, created_at = now()`,
        [job.experiment_id, item.scenario, JSON.stringify(item.metrics), JSON.stringify(item.coverage ?? {}), JSON.stringify(item.limitations ?? {})],
      );
    }
    const reportResult = await client.query(
      `INSERT INTO reports (workspace_id, experiment_id, version, report_json)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (experiment_id, version) DO UPDATE SET report_json = EXCLUDED.report_json, created_at = now()
       RETURNING id`,
      [dataset.workspace_id, job.experiment_id, result.report.reportVersion, JSON.stringify(result.report)],
    );
    await client.query(
      `UPDATE experiments SET status = 'succeeded', updated_at = now() WHERE id = $1 AND workspace_id = $2`,
      [job.experiment_id, dataset.workspace_id],
    );
    await client.query(
      `UPDATE analysis_jobs SET status = 'succeeded', error_message = NULL, finished_at = now(), updated_at = now()
       WHERE id = $1`,
      [job.id],
    );
    return { reportId: reportResult.rows[0].id, experimentId: job.experiment_id, status: 'succeeded' };
  });
}

async function markFailed(pool, job, error) {
  const message = error instanceof Error ? error.message : String(error);
  await pool.query(
    `UPDATE analysis_jobs SET status = 'failed', error_message = $2, finished_at = now(), updated_at = now() WHERE id = $1`,
    [job.id, message.slice(0, 2000)],
  );
  await pool.query(
    `UPDATE experiments SET status = 'failed', updated_at = now() WHERE id = $1`,
    [job.experiment_id],
  );
  return { jobId: job.id, experimentId: job.experiment_id, status: 'failed', error: message };
}

async function claimJob(pool, { workspaceId = null, jobId = null } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const values = [];
    const where = ["j.status = 'queued'"];
    if (workspaceId) { values.push(workspaceId); where.push(`j.workspace_id = $${values.length}`); }
    if (jobId) { values.push(jobId); where.push(`j.id = $${values.length}`); }
    const result = await client.query(
      `SELECT j.id, j.workspace_id, j.experiment_id, j.dataset_id, j.payload, j.attempts
         FROM analysis_jobs j
        WHERE ${where.join(' AND ')}
        ORDER BY j.created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1`,
      values,
    );
    if (!result.rows[0]) {
      await client.query('COMMIT');
      return null;
    }
    const job = result.rows[0];
    await client.query(
      `UPDATE analysis_jobs SET status = 'running', attempts = attempts + 1, started_at = now(), updated_at = now() WHERE id = $1`,
      [job.id],
    );
    await client.query(
      `UPDATE experiments SET status = 'running', updated_at = now() WHERE id = $1`,
      [job.experiment_id],
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

export async function processNextAnalysisJob(pool, filters = {}) {
  const job = await claimJob(pool, filters);
  if (!job) return { status: 'idle' };
  try {
    const datasetResult = await pool.query(
      `SELECT id, workspace_id, name, data_label, source_filename, is_synthetic, quality_report,
              starts_at, ends_at
         FROM datasets WHERE id = $1 AND workspace_id = $2`,
      [job.dataset_id, job.workspace_id],
    );
    const dataset = datasetResult.rows[0];
    if (!dataset) throw new Error('Dataset not found for analysis job');
    const eventsResult = await pool.query(
      `SELECT event_id, trader_token, occurred_at, type::text, venue_id, market_id, market_type,
              side, price, quantity, stake_amount, payout_amount, deposit_amount, withdrawal_amount,
              balance_before, balance_after, policy_event_type, policy_event_value, realized_result,
              placed_at, settled_at, provenance, source_row_number
         FROM trader_events WHERE dataset_id = $1 AND workspace_id = $2 ORDER BY occurred_at, id`,
      [dataset.id, dataset.workspace_id],
    );
    const events = eventsResult.rows.map(mapDatabaseEvent);
    const options = runOptions(job.payload);
    const pipeline = runTwinPipeline(events, {
      ...options,
      dataLabel: dataset.data_label || (dataset.is_synthetic ? 'SYNTHETIC' : 'CUSTOMER'),
      dataset: { name: dataset.name, venueId: events[0]?.venue_id ?? null },
      generatedAt: new Date().toISOString()
    });
    return await persistPipeline(pool, job, dataset, pipeline);
  } catch (error) {
    return markFailed(pool, job, error);
  }
}
