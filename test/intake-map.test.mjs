import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLedgerFixture } from '../src/intake/fixture.mjs';
import { checkSalt, eventIdToken, mapSource, normalizeMappingConfig, SALT_ENV_VAR, traderToken } from '../src/intake/map.mjs';
import { parseSource } from '../src/intake/source.mjs';
import { parseTimestamp, resolveTimeZone } from '../src/intake/values.mjs';

// Intake map (intake-map-0.1.0). All data here is SYNTHETIC.

const repo = fileURLToPath(new URL('..', import.meta.url));
const fixtures = join(repo, 'test', 'fixtures', 'intake');
const SALT = 'test-salt-not-a-secret-0001';
const OTHER_SALT = 'test-salt-not-a-secret-0002';

const BASE_CONFIG = {
  name: 'unit',
  venueId: 'unit-venue',
  trader: { column: 'acct' },
  timestamp: { column: 'when', timezone: 'UTC' },
  eventType: { column: 'kind', values: { trade: 'trade', deposit: 'deposit', withdrawal: 'withdrawal' }, ignore: ['fee'] },
  fields: {
    stake_amount: { column: 'stake', units: 'cents' },
    deposit_amount: { column: 'amount', units: 'dollars', appliesTo: ['deposit'] },
    withdrawal_amount: { column: 'amount', units: 'dollars', sign: 'absolute', appliesTo: ['withdrawal'] },
    realized_result: { mode: 'signed', column: 'pnl', units: 'cents' }
  }
};

function mapCsv(csv, overrides = {}, options = {}) {
  const config = { ...BASE_CONFIG, ...overrides, fields: { ...BASE_CONFIG.fields, ...(overrides.fields ?? {}) } };
  for (const [key, value] of Object.entries(config.fields)) if (value === null) delete config.fields[key];
  return mapSource(parseSource(csv, { fileName: 'unit.csv' }), config, { salt: SALT, label: 'SYNTHETIC', ...options });
}

const CSV = [
  'acct,when,kind,stake,amount,pnl,channel,note',
  'A-1,2026-07-01 12:00:00,trade,1050,,-1050,web,x',
  'A-1,2026-07-01 12:05:00,TRADE ,2000,,,web,x',
  'A-1,2026-07-01 12:06:00,Trade,500,,0,web,x',
  'A-2,2026-07-01 13:00:00,deposit,,25.50,,ios,x',
  'A-2,2026-07-01 13:01:00,withdrawal,,-10.25,,ios,x',
  'A-2,2026-07-01 13:02:00,fee,,1,,ios,x',
  'A-2,2026-07-01 13:03:00,bonus,,1,,ios,x'
].join('\n');

test('units: cents and dollars per field', () => {
  const { events } = mapCsv(CSV);
  const trades = events.filter((event) => event.type === 'trade');
  assert.deepEqual(trades.map((event) => event.stake_amount), [10.5, 20, 5]);
  assert.equal(events.find((event) => event.type === 'deposit').deposit_amount, 25.5);
  assert.equal(events.find((event) => event.type === 'withdrawal').withdrawal_amount, 10.25, 'sign absolute');
  assert.ok(!('deposit_amount' in trades[0]), 'a field is set only on the event types it applies to');
});

test('event types: mapping, case and whitespace, ignored and unknown values', () => {
  const { events, report } = mapCsv(CSV);
  assert.deepEqual(events.map((event) => event.type), ['trade', 'trade', 'trade', 'deposit', 'withdrawal']);
  const dropped = Object.fromEntries(report.dropped.map((entry) => [entry.reason, entry.count]));
  assert.equal(dropped['event type value ignored by the mapping ("fee")'], 1);
  assert.equal(dropped['event type value not in the mapping'], 1);
  assert.deepEqual(report.unknownTypeValues, [{ shape: 'AAAAA', count: 1 }], 'unknown values are reported by shape only');
  assert.ok(!JSON.stringify(report).includes('bonus'));
  const fixed = Object.fromEntries(report.fixed.map((entry) => [entry.reason, entry.count]));
  assert.equal(fixed['event type value matched ignoring case'], 2);
  assert.equal(fixed['stray whitespace trimmed from a cell'], 1);
  assert.throws(() => mapCsv(CSV, { eventType: { ...BASE_CONFIG.eventType, values: { trade: 'bet' } } }), /not an event type/);
});

test('missing realized results stay null, never 0; an observed 0 stays 0', () => {
  const { events, report } = mapCsv(CSV);
  const trades = events.filter((event) => event.type === 'trade');
  assert.deepEqual(trades.map((event) => event.realized_result), [-10.5, null, 0]);
  assert.equal(report.notes[0].count, 1);
  // Split columns: both blank is unavailable; one side blank is 0 on that side.
  const split = mapCsv([
    'acct,when,kind,stake,amount,win,loss',
    'A,2026-07-01 12:00:00,trade,100,,250,',
    'A,2026-07-01 12:01:00,trade,100,,,100',
    'A,2026-07-01 12:02:00,trade,100,,,',
    'A,2026-07-01 12:03:00,trade,100,,0,0',
    'A,2026-07-01 12:04:00,trade,100,,,-100'
  ].join('\n'), { fields: { realized_result: { mode: 'split', gainColumn: 'win', lossColumn: 'loss', units: 'cents' } } });
  assert.deepEqual(split.events.map((event) => event.realized_result), [2.5, -1, null, 0, -1]);
  assert.ok(split.report.fixed.some((entry) => /other sign than lossSign/.test(entry.reason)));
  // Payout minus stake: a blank payout is unavailable; a 0 payout is a full loss.
  const payout = mapCsv([
    'acct,when,kind,stake,amount,payout',
    'A,2026-07-01 12:00:00,trade,100,,190',
    'A,2026-07-01 12:01:00,trade,100,,0',
    'A,2026-07-01 12:02:00,trade,100,,'
  ].join('\n'), { fields: { realized_result: { mode: 'payout_minus_stake', payoutColumn: 'payout', units: 'cents' } } });
  assert.deepEqual(payout.events.map((event) => event.realized_result), [0.9, -1, null]);
});

test('sign conventions: house perspective, negate, accounting parentheses', () => {
  const house = mapCsv(CSV, { fields: { realized_result: { mode: 'signed', column: 'pnl', units: 'cents', perspective: 'house' } } });
  assert.deepEqual(house.events.filter((event) => event.type === 'trade').map((event) => event.realized_result), [10.5, null, 0]);
  const negated = mapCsv([
    'acct,when,kind,stake,amount,pnl',
    'A,2026-07-01 12:00:00,trade,-1050,,(1050)',
    'A,2026-07-01 12:01:00,trade,"-2,000",,"$1,234"'
  ].join('\n'), { fields: { stake_amount: { column: 'stake', units: 'cents', sign: 'negate' } } });
  assert.deepEqual(negated.events.map((event) => event.stake_amount), [10.5, 20]);
  assert.deepEqual(negated.events.map((event) => event.realized_result), [-10.5, 12.34]);
  const fixes = negated.report.fixed.map((entry) => entry.reason).join(' | ');
  assert.match(fixes, /accounting parentheses/);
  assert.match(fixes, /thousands separators/);
});

test('timezone: source wall-clock times become UTC ISO, across daylight-saving changes', () => {
  const ny = resolveTimeZone('America/New_York');
  assert.equal(parseTimestamp('2026-07-01 12:00:00', { zone: ny }).iso, '2026-07-01T16:00:00.000Z', 'EDT is UTC-4');
  assert.equal(parseTimestamp('2026-01-15 09:30:00', { zone: ny }).iso, '2026-01-15T14:30:00.000Z', 'EST is UTC-5');
  assert.match(parseTimestamp('2026-03-08 02:30:00', { zone: ny }).error, /skipped/, 'spring-forward gap');
  const fallBack = parseTimestamp('2026-11-01 01:30:00', { zone: ny });
  assert.equal(fallBack.iso, '2026-11-01T05:30:00.000Z', 'ambiguous: the earlier instant (EDT)');
  assert.match(fallBack.notes[0], /ambiguous/);
  assert.equal(parseTimestamp('2026-07-01T12:00:00+02:00', { zone: ny }).iso, '2026-07-01T10:00:00.000Z', 'explicit offset wins');
  assert.equal(parseTimestamp('7/1/2026 1:05 PM', { format: 'mdy', zone: resolveTimeZone('+05:30') }).iso, '2026-07-01T07:35:00.000Z');
  assert.equal(parseTimestamp('1/7/2026 13:05', { format: 'dmy', zone: resolveTimeZone('UTC') }).iso, '2026-07-01T13:05:00.000Z');
  assert.equal(parseTimestamp('1782907200', { format: 'epoch_seconds', zone: ny }).iso, '2026-07-01T12:00:00.000Z');
  assert.equal(parseTimestamp('2026-02-30 10:00:00', { zone: ny }).iso, null);

  const { events, report } = mapCsv([
    'acct,when,kind,stake,amount,pnl',
    'A,2026-07-01 12:00:00,trade,100,,',
    'A,2026-03-08 02:30:00,trade,100,,',
    'A,not a time,trade,100,,'
  ].join('\n'), { timestamp: { column: 'when', timezone: 'America/New_York' } });
  assert.deepEqual(events.map((event) => event.occurred_at), ['2026-07-01T16:00:00.000Z']);
  const reasons = report.dropped.map((entry) => entry.reason);
  assert.ok(reasons.includes('timestamp: local time skipped by a daylight-saving change'));
  assert.ok(reasons.includes('timestamp: unparseable timestamp'));
  assert.throws(() => normalizeMappingConfig({ ...BASE_CONFIG, timestamp: { column: 'when', timezone: 'Mars/Olympus' } }), /unknown time zone/);
  assert.throws(() => normalizeMappingConfig({ ...BASE_CONFIG, timestamp: { column: 'when' } }), /timezone must be a non-empty string/);
});

test('tokens: HMAC-SHA256 under the salt, deterministic, and different under another salt', () => {
  const first = mapCsv(CSV);
  const again = mapCsv(CSV);
  const other = mapCsv(CSV, {}, { salt: OTHER_SALT });
  const tokens = (result) => [...new Set(result.events.map((event) => event.trader_token))];
  assert.deepEqual(tokens(first), tokens(again));
  assert.equal(tokens(first).length, 2);
  assert.ok(tokens(first).every((token) => /^tr_[0-9a-f]{16}$/.test(token)));
  assert.ok(tokens(other).every((token) => !tokens(first).includes(token)), 'a different salt gives different tokens');
  const expected = `tr_${createHmac('sha256', SALT).update('A-1').digest('hex').slice(0, 16)}`;
  assert.equal(first.events[0].trader_token, expected);
  assert.equal(traderToken(SALT, ' A-1 '), expected, 'the raw ID is trimmed before hashing');
  assert.notEqual(traderToken(SALT, 'a-1'), expected, 'case-sensitive by default');
  assert.equal(traderToken(SALT, 'a-1', { caseSensitive: false }), traderToken(SALT, 'A-1', { caseSensitive: false }));
  assert.match(eventIdToken(SALT, 'X1'), /^ev_[0-9a-f]{20}$/);
  assert.notEqual(eventIdToken(SALT, 'A-1').slice(3), expected.slice(3), 'event IDs use a separate domain');
  assert.ok(!JSON.stringify(first).includes('A-1') && !JSON.stringify(first).includes('A-2'), 'no raw ID in the events or the report');
  assert.ok(!JSON.stringify(first).includes(SALT), 'the salt is never in the output');
  assert.deepEqual(first.events.map((event) => event.event_id), [2, 3, 4, 5, 6].map((line) => `row_${line}`), 'event IDs from source lines when not mapped');
});

test('refuses to run without a salt, and never falls back to a default', () => {
  for (const salt of [undefined, null, '']) {
    assert.throws(() => mapCsv(CSV, {}, { salt }), (error) => error.message.includes(`${SALT_ENV_VAR} is not set`));
  }
  assert.throws(() => checkSalt('short'), /too short/);
  assert.throws(() => mapCsv(CSV, {}, { salt: 'short-salt' }), (error) => !error.message.includes('short-salt'), 'the salt is not echoed');
  const env = { ...process.env };
  delete env[SALT_ENV_VAR];
  const result = spawnSync(process.execPath, ['scripts/intake.mjs', 'map', '--config', join(fixtures, 'ledger-mapping.json'), '--label', 'SYNTHETIC', '--name', 'never-written'], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /PLAYMIND_TOKEN_SALT is not set/);
  assert.doesNotMatch(result.stdout, /mapped/);
});

test('unmapped source columns are dropped and listed by name', () => {
  const { events, report } = mapCsv(CSV);
  assert.deepEqual(report.columns.unmapped.map((item) => item.column), ['channel', 'note']);
  assert.ok(events.every((event) => !('channel' in event) && !('note' in event)));
  assert.deepEqual(Object.keys(events[0]).sort(), ['event_id', 'occurred_at', 'realized_result', 'source_row_number', 'stake_amount', 'trader_token', 'type', 'venue_id']);
});

test('a mapped column that is direct PII is rejected; an account column may only be the trader ID', async () => {
  const piiCsv = await readFile(join(fixtures, 'ledger-export-pii.csv'), 'utf8');
  const parsed = parseSource(piiCsv, { fileName: 'ledger-export-pii.csv' });
  const config = {
    name: 'pii',
    venueId: 'v',
    trader: { column: 'account_ref' },
    timestamp: { column: 'posted_at_utc', timezone: 'UTC' },
    eventType: { column: 'entry_type', values: { BET: 'trade', DEPOSIT: 'deposit' } },
    fields: { stake_amount: { column: 'stake_cents', units: 'cents' } }
  };
  // Unmapped PII columns are dropped and listed with their flags; the run succeeds.
  const ok = mapSource(parsed, config, { salt: SALT, label: 'SYNTHETIC' });
  const unmapped = Object.fromEntries(ok.report.columns.unmapped.map((item) => [item.column, item.flags.join(' ')]));
  assert.match(unmapped.contact, /PII/);
  assert.match(unmapped['Email Address'], /PII/);
  assert.ok(!JSON.stringify(ok).includes('example.invalid'));
  // Mapping one of them is rejected, without echoing a value.
  const rejected = (overrides) => assert.throws(() => mapSource(parsed, { ...config, ...overrides }, { salt: SALT, label: 'SYNTHETIC' }), (error) => /looks like direct PII/.test(error.message) && !error.message.includes('example.invalid'));
  rejected({ trader: { column: 'contact' } });
  rejected({ trader: { column: 'Email Address' } });
  rejected({ fields: { ...config.fields, side: { column: 'contact' } } });
  rejected({ eventId: { column: 'Email Address' } });
  assert.throws(() => mapSource(parsed, { ...config, fields: { ...config.fields, market_id: { column: 'account_ref' } } }, { salt: SALT, label: 'SYNTHETIC' }), /may only be the trader ID column/);
  assert.throws(() => normalizeMappingConfig({ ...config, fields: { email: { column: 'contact' } } }), /not a mappable schema field/);
});

test('the config is strict and the label must agree', () => {
  assert.throws(() => normalizeMappingConfig({ ...BASE_CONFIG, salt: 'x' }), /unknown key "salt"/);
  assert.throws(() => normalizeMappingConfig({ ...BASE_CONFIG, fields: { stake_amount: { column: 'stake' } } }), /units is required/);
  assert.throws(() => normalizeMappingConfig({ ...BASE_CONFIG, name: '../escape' }), /plain name/);
  assert.throws(() => mapCsv(CSV, { label: 'CUSTOMER' }), /config says CUSTOMER but the run is labelled SYNTHETIC/);
  assert.throws(() => mapCsv(CSV, {}, { label: undefined }), /data label is required/);
  assert.throws(() => mapCsv(CSV, { trader: { column: 'missing_column' } }), /Mapped columns not in the source: "missing_column"/);
});

test('the fixture maps back to the generator values, with every dump artifact handled', async () => {
  const fixture = buildLedgerFixture();
  const raw = JSON.parse(await readFile(join(fixtures, 'ledger-mapping.json'), 'utf8'));
  const text = await readFile(join(fixtures, 'ledger-export.csv'), 'utf8');
  const { events, report } = mapSource(parseSource(text, { fileName: 'ledger-export.csv' }), raw, { salt: SALT, label: 'SYNTHETIC' });
  const generated = fixture.dataset.events;
  assert.equal(events.length, generated.length);
  assert.equal(report.output.traders, fixture.expected.traders);
  for (let index = 0; index < generated.length; index += 1) {
    const [actual, truth] = [events[index], generated[index]];
    assert.equal(actual.occurred_at, truth.occurred_at);
    assert.equal(actual.type, truth.type);
    if (truth.type === 'trade') {
      assert.equal(actual.stake_amount, truth.stake_amount);
      assert.equal(actual.realized_result, truth.realized_result);
    } else {
      assert.equal(actual.deposit_amount, truth.deposit_amount);
    }
  }
  assert.equal(events.filter((event) => event.type === 'trade' && event.realized_result === null).length, fixture.expected.missingResults);
  assert.ok(events.every((event) => !('balance_before' in event) && !('market_id' in event)), 'no balances and no market fields');
  const dropped = Object.fromEntries(report.dropped.map((entry) => [entry.reason, entry.count]));
  assert.equal(dropped['blank row'], fixture.expected.blankRows);
  assert.equal(dropped['exact duplicate row'], fixture.expected.duplicateRows);
  assert.equal(dropped['event type value ignored by the mapping ("FEE")'], fixture.expected.fees);
  assert.equal(report.droppedTotal, fixture.expected.blankRows + fixture.expected.duplicateRows + fixture.expected.fees);
  assert.deepEqual(report.columns.unmapped.map((item) => item.column), ['channel', 'currency']);
  const text2 = JSON.stringify({ events, report });
  for (const id of [...fixture.rawAccountIds, ...fixture.rawEntryIds]) assert.ok(!text2.includes(id), 'no raw ID');
});
