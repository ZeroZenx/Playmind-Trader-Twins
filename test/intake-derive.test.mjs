import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateEvents } from '../src/engine/validate.mjs';
import { DERIVE_VERSION, METHODS } from '../src/intake/derive.mjs';
import { buildLedgerFixture } from '../src/intake/fixture.mjs';
import { mapAndDerive, runIntakePipeline } from '../src/intake/pipeline.mjs';
import { assessReadiness, renderReadinessMarkdown } from '../src/intake/readiness.mjs';
import { normalizeIntakeConfig } from '../src/intake/tables.mjs';

// Multi-table intake and the derive stage (intake-0.2.0, ADR-017). All data is SYNTHETIC.

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SALT = 'test-salt-not-a-secret-0002';
const fixture = buildLedgerFixture();
const ledgerConfig = JSON.parse(await readFile(join(repo, 'test', 'fixtures', 'intake', 'ledger-mapping.json'), 'utf8'));

const TRADES = [
  '# SYNTHETIC unit table',
  'row_ref,acct,at,kind,stake,pnl,credit,debit,mkt',
  'R-1,A-1,2026-05-01T10:00:00Z,BET,10,-10,,,M-1',
  'R-2,A-1,2026-05-01T10:05:00Z,BET,20,,30,,M-2',
  'R-3,A-1,2026-05-01T10:09:00Z,BET,5,,,,M-1',
  'R-4,A-2,2026-05-01T11:00:00Z,BET,8,4,,,M-3',
  'R-5,A-2,2026-05-01T11:01:00Z,DEP,,,,,',
  'R-6,A-2,2026-05-01T11:02:00Z,BET,8,,0,0,M-3'
].join('\n');
const MARKETS = ['market,closes', 'M-1,2026-05-01T12:00:00Z', 'M-2,2026-05-02T00:00:00Z', 'M-3,2026-05-01T11:30:00Z'].join('\n');

function multiConfig(overrides = {}) {
  return {
    name: 'unit-multi',
    label: 'SYNTHETIC',
    venueId: 'unit-venue',
    tables: {
      trades: {
        input: 'trades.csv',
        trader: { column: 'acct' },
        eventId: { column: 'row_ref' },
        timestamp: { column: 'at', timezone: 'UTC' },
        eventType: { column: 'kind', values: { BET: 'trade', DEP: 'deposit' } },
        fields: { stake_amount: { column: 'stake', units: 'dollars' } },
        attributes: {
          pnl: { column: 'pnl', kind: 'number', units: 'dollars' },
          credit: { column: 'credit', kind: 'number', units: 'dollars' },
          debit: { column: 'debit', kind: 'number', units: 'dollars' },
          market_key: { column: 'mkt', kind: 'key' }
        }
      },
      markets: {
        role: 'lookup',
        input: 'markets.csv',
        key: 'market_key',
        timezone: 'UTC',
        attributes: { market_key: { column: 'market', kind: 'key' }, close_time: { column: 'closes', kind: 'timestamp' } }
      }
    },
    joins: { market: { from: 'trades.market_key', to: 'markets.market_key' } },
    derive: {
      realized_result: [
        { method: 'signed-pnl', column: 'pnl' },
        { method: 'credit-minus-debit-0.1', credit: 'credit', debit: 'debit' }
      ]
    },
    ...overrides
  };
}

const multiInput = { tables: { trades: { text: TRADES, fileName: 'trades.csv' }, markets: { text: MARKETS, fileName: 'markets.csv' } } };

test('a single-file config maps exactly as before, and derive only adds provenance', () => {
  const { events, report, config } = mapAndDerive({ text: fixture.csv, fileName: 'ledger-export.csv' }, { config: ledgerConfig, salt: SALT, label: 'SYNTHETIC' });
  assert.equal(config.multiTable, false);
  const trades = events.filter((event) => event.type === 'trade');
  assert.equal(trades.length, fixture.expected.trades);
  for (const trade of trades) {
    assert.equal(trade.provenance.stake_amount, 'observed');
    assert.equal(trade.provenance.placed_at, 'assumed');
    if (trade.realized_result === null) {
      assert.equal(trade.provenance.realized_result, undefined, 'an unavailable result has no source');
      assert.equal(trade.provenance.settled_at, undefined, 'no outcome, so no outcome time');
    } else {
      assert.equal(trade.provenance.realized_result, 'derived:credit-minus-debit-0.1', 'the split mode is the credit-minus-debit method');
      assert.equal(trade.provenance.settled_at, 'assumed');
    }
    assert.equal(trade.settled_at, undefined);
  }
  for (const deposit of events.filter((event) => event.type === 'deposit')) assert.equal(deposit.provenance, undefined, 'no derivable field applies');
  const byField = report.derive.byField;
  assert.equal(byField.realized_result.unavailable, fixture.expected.missingResults);
  assert.equal(byField.realized_result['derived:credit-minus-debit-0.1'], fixture.expected.trades - fixture.expected.missingResults);
  assert.equal(byField.settled_at.assumed, fixture.expected.trades - fixture.expected.missingResults);
  assert.equal(report.derive.deriveVersion, DERIVE_VERSION);
  assert.ok(validateEvents(events).valid);
});

test('multi-table config: methods run in the configured order, falling back, and never invent a result', () => {
  const { events, report } = mapAndDerive(multiInput, { config: multiConfig(), salt: SALT, label: 'SYNTHETIC' });
  const trades = events.filter((event) => event.type === 'trade');
  assert.deepEqual(trades.map((event) => event.realized_result), [-10, 30, null, 4, 0]);
  assert.deepEqual(trades.map((event) => event.provenance.realized_result), ['derived:signed-pnl-0.1', 'derived:credit-minus-debit-0.1', undefined, 'derived:signed-pnl-0.1', 'derived:credit-minus-debit-0.1']);
  assert.deepEqual(report.derive.byField.realized_result, { 'derived:signed-pnl-0.1': 2, 'derived:credit-minus-debit-0.1': 2, unavailable: 1 });
  assert.deepEqual(report.derive.methods.realized_result, ['derived:signed-pnl-0.1', 'derived:credit-minus-debit-0.1']);
  assert.equal(report.output.events, 6);
  assert.equal(report.output.traders, 2);
  assert.equal(report.tables.markets.output.rows, 3);
  assert.deepEqual(report.joins, [{ name: 'market', from: 'trades.market_key', to: 'markets.market_key' }]);
  for (const event of events) {
    for (const key of Object.keys(event)) assert.ok(!['pnl', 'credit', 'debit', 'market_key', 'close_time'].includes(key), 'attributes are never written to events');
  }
  assert.ok(validateEvents(events).valid);
});

test('derive is deterministic, leaves the mapped input alone, and its report holds no raw value', () => {
  const first = mapAndDerive(multiInput, { config: multiConfig(), salt: SALT, label: 'SYNTHETIC' });
  const again = mapAndDerive(multiInput, { config: multiConfig(), salt: SALT, label: 'SYNTHETIC' });
  assert.deepEqual(first.events, again.events);
  assert.deepEqual(first.report, again.report);
  const text = JSON.stringify(first.report) + JSON.stringify(first.events);
  for (const raw of ['A-1', 'A-2', 'R-1', 'M-1', 'M-3', '2026-05-02T00:00:00']) assert.ok(!text.includes(raw), `no raw value (${raw}) in events or report`);
});

test('config errors name the problem', () => {
  const bad = (derive, pattern) => assert.throws(() => normalizeIntakeConfig(multiConfig({ derive })), pattern);
  bad({ realized_result: [{ method: 'guess' }] }, /not a realized_result method/);
  bad({ realized_result: [{ method: 'signed-pnl-9.9', column: 'pnl' }] }, /this intake has version 0\.1/);
  bad({ realized_result: [{ method: 'signed-pnl', column: 'nope' }] }, /no events table this method reads has a number attribute "nope"/);
  bad({ realized_result: [{ method: 'signed-pnl' }] }, /column is required/);
  bad({ realized_result: { method: 'signed-pnl', column: 'pnl' } }, /ordered list/);
  bad({ wishes: [] }, /not a derivable field/);
  assert.throws(() => normalizeIntakeConfig(multiConfig({ joins: { market: { from: 'trades.market_key', to: 'nowhere.key' } } })), /unknown table "nowhere"/);
  const shared = multiConfig();
  shared.tables.trades.venueId = 'x';
  assert.throws(() => normalizeIntakeConfig(shared), /set venueId once/);
  const lookupPerson = multiConfig();
  lookupPerson.tables.markets.attributes.owner = { column: 'customer_id', kind: 'key' };
  assert.throws(() => mapAndDerive({ tables: { ...multiInput.tables, markets: { text: 'market,closes,customer_id\nM-1,2026-05-01T12:00:00Z,C1', fileName: 'm.csv' } } }, { config: lookupPerson, salt: SALT, label: 'SYNTHETIC' }), /can't carry trader identity/);
  for (const [field, methods] of Object.entries(METHODS)) {
    for (const [name, method] of Object.entries(methods)) assert.match(method.version, /^\d+\.\d+$/, `${field} ${name} is versioned`);
  }
});

test('validateEvents accepts provenance and the optional timestamps, and rejects bad ones without echoing values', () => {
  const base = { event_id: 'e1', trader_token: 'tr_x', occurred_at: '2026-05-01T10:00:00.000Z', type: 'trade', venue_id: 'v', source_row_number: 1, stake_amount: 5, realized_result: -5 };
  assert.ok(validateEvents([{ ...base, settled_at: '2026-05-01T11:00:00.000Z', placed_at: '2026-05-01T09:59:00.000Z', provenance: { settled_at: 'derived:market-settlement-0.1', placed_at: 'assumed', stake_amount: 'observed' } }]).valid);
  const errors = (event) => validateEvents([{ ...base, ...event }]).errors.join(' ');
  assert.match(errors({ provenance: 'observed' }), /provenance must be an object/);
  assert.match(errors({ provenance: { stake_amount: 'guessed' } }), /must be observed, assumed, or derived/);
  assert.match(errors({ provenance: { trader_token: 'observed' } }), /not derivable: trader_token/);
  assert.match(errors({ settled_at: 'soon' }), /invalid settled_at/);
  assert.match(errors({ placed_at: 7 }), /invalid placed_at/);
  assert.match(errors({ settled_at: '2026-05-01T09:00:00.000Z' }), /settled_at before the trade/);
  assert.ok(!errors({ settled_at: 'soon' }).includes('soon'));
});

test('readiness reports coverage per field by provenance', () => {
  const { events } = mapAndDerive(multiInput, { config: multiConfig(), salt: SALT, label: 'SYNTHETIC' });
  const readiness = assessReadiness(events, { label: 'SYNTHETIC' });
  assert.deepEqual(readiness.provenance.realized_result, { appliesTo: 'trade', relevant: 5, observed: 0, derived: { 'signed-pnl-0.1': 2, 'credit-minus-debit-0.1': 2 }, assumed: 0, unavailable: 1 });
  assert.equal(readiness.provenance.placed_at.assumed, 5);
  assert.equal(readiness.provenance.balance_before.relevant, 6);
  const markdown = renderReadinessMarkdown(readiness);
  assert.match(markdown, /Where derived fields came from/);
  assert.match(markdown, /signed-pnl-0\.1: 2/);
  assert.match(markdown, /Assumed `placed_at`/);
});

test('the pipeline runs a multi-table config end to end, and the CLI reads each table next to the config', async () => {
  const result = runIntakePipeline({ ...multiInput, config: multiConfig(), salt: SALT, label: 'SYNTHETIC', options: { holdoutReplicates: 2, sweepReplicates: 2, policies: ['cooldown'], horizonDays: 2 } });
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.summary.tables, ['trades', 'markets']);
  assert.ok(result.outputs['profile.json'].tables.markets);
  assert.equal(result.summary.provenance.realized_result.unavailable, 1);

  const directory = await mkdtemp(join(tmpdir(), 'playmind-derive-'));
  try {
    await writeFile(join(directory, 'trades.csv'), TRADES);
    await writeFile(join(directory, 'markets.csv'), MARKETS);
    await writeFile(join(directory, 'config.json'), JSON.stringify(multiConfig()));
    const before = await readFile(join(directory, 'trades.csv'), 'utf8');
    const out = join(directory, 'out');
    const run = spawnSync(process.execPath, ['scripts/intake.mjs', 'map', '--config', join(directory, 'config.json'), '--label', 'SYNTHETIC', '--out', out], { cwd: repo, env: { ...process.env, PLAYMIND_TOKEN_SALT: SALT }, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /realized_result: derived:signed-pnl-0\.1 2, derived:credit-minus-debit-0\.1 2, unavailable 1/);
    assert.ok(!run.stdout.includes('A-1'));
    assert.equal(await readFile(join(directory, 'trades.csv'), 'utf8'), before, 'the raw file is not modified');
    const document = JSON.parse(await readFile(join(out, 'events.json'), 'utf8'));
    assert.equal(document.deriveVersion, DERIVE_VERSION);
    assert.equal(document.events.length, 6);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
