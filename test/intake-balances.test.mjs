import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateEvents } from '../src/engine/validate.mjs';
import { LEDGER_FIXTURE_OPTIONS, ledgerFixtureFromDataset, rawAccountId } from '../src/intake/fixture.mjs';
import { traderToken } from '../src/intake/map.mjs';
import { mapAndDerive } from '../src/intake/pipeline.mjs';
import { normalizeIntakeConfig } from '../src/intake/tables.mjs';
import { generateBehavioralDataset } from '../src/synthetic/behavioral-generate.mjs';

// Balance reconstruction from a cash ledger (ledger-replay-0.1, ADR-019). All data is
// SYNTHETIC: the intake ledger fixture's generator run, with the generator's true balances as
// the truth. The fixture's FEE rows are dump artifacts outside the generator's money model, so
// the flows here leave them out; fees as a flow are tested on a hand-made ledger below.

const SALT = 'test-salt-not-a-secret-0004';
const fixtureConfig = JSON.parse(await readFile(new URL('./fixtures/intake/ledger-mapping.json', import.meta.url), 'utf8'));
const FLOWS = [
  { when: ['DEPOSIT'], add: ['amount'] },
  { when: ['WITHDRAWAL'], subtract: ['amount'] },
  { when: ['BET'], add: ['credit'], subtract: ['debit'] }
];

function generate(missingOutcomeShare) {
  return generateBehavioralDataset({
    seed: LEDGER_FIXTURE_OPTIONS.seed,
    name: 'intake-ledger-fixture',
    mode: 'population',
    traderCount: LEDGER_FIXTURE_OPTIONS.traderCount,
    sessionsPerTrader: { ...LEDGER_FIXTURE_OPTIONS.sessionsPerTrader },
    includeBalances: true,
    missingOutcomeShare
  });
}

function config({ anchor = 'opening', snapshot = false, tolerance = {} } = {}) {
  const ignore = snapshot ? ['FEE', 'BALANCE'] : ['FEE'];
  return {
    ...fixtureConfig,
    eventType: { ...fixtureConfig.eventType, ignore },
    attributes: {
      amount: { column: 'amount_cents', kind: 'number', units: 'cents' },
      credit: { column: 'settle_credit_cents', kind: 'number', units: 'cents' },
      debit: { column: 'settle_debit_cents', kind: 'number', units: 'cents' }
    },
    derive: {
      balances: [{
        method: 'ledger-replay',
        ledger: 'main',
        flows: FLOWS,
        ...(snapshot ? { snapshot: { when: ['BALANCE'], balance: 'amount' } } : {}),
        anchor,
        ...tolerance
      }]
    }
  };
}

// Snapshot rows from the truth: each listed account's balance after its event at that time.
function withSnapshots(csv, dataset, picks, adjust = () => 0) {
  const lines = csv.trimEnd().split('\n');
  const indexByToken = new Map(dataset.truth.traders.map((trader, index) => [trader.traderToken, index]));
  let id = 0;
  for (const [token, eventIndex] of picks) {
    const events = dataset.events.filter((event) => event.trader_token === token);
    const event = events[eventIndex];
    const sameTime = events.filter((item) => item.occurred_at === event.occurred_at).at(-1);
    const cents = Math.round((sameTime.balance_after + adjust(token, eventIndex)) * 100);
    id += 1;
    lines.push(['SNP-' + String(id).padStart(6, '0'), rawAccountId(indexByToken.get(token)), event.occurred_at.slice(0, 19).replace('T', ' '), 'BALANCE', '', cents, '', '', 'web', 'USD'].join(','));
  }
  return `${lines.join('\n')}\n`;
}

function truthByToken(dataset) {
  const map = new Map();
  for (const event of dataset.events) {
    if (!map.has(event.trader_token)) map.set(event.trader_token, []);
    map.get(event.trader_token).push(event);
  }
  return map;
}

function compare(events, dataset) {
  // Intake tokens are HMACs of raw account IDs; map them back through the fixture's account IDs.
  const tokens = new Map(dataset.truth.traders.map((trader, index) => [traderToken(SALT, rawAccountId(index), { prefix: 'tr_', hexLength: 16 }), trader.traderToken]));
  const truth = truthByToken(dataset);
  let compared = 0;
  const mine = new Map();
  for (const event of events) {
    if (!mine.has(event.trader_token)) mine.set(event.trader_token, []);
    mine.get(event.trader_token).push(event);
  }
  for (const [token, list] of mine) {
    const expected = truth.get(tokens.get(token));
    assert.equal(list.length, expected.length);
    list.forEach((event, index) => {
      if (event.balance_before === undefined) return;
      assert.equal(event.balance_before, expected[index].balance_before, `${token} event ${index} before`);
      assert.equal(event.balance_after, expected[index].balance_after, `${token} event ${index} after`);
      compared += 1;
    });
  }
  return compared;
}

test('the replay of the full ledger, anchored at zero from opening, gives the generator\'s true balances', () => {
  const dataset = generate(0);
  const { csv } = ledgerFixtureFromDataset(dataset, { file: 'ledger-export.csv' });
  assert.doesNotMatch(csv.split('\n')[1], /balance/i, 'the fixture has no balance column: balances are removed');
  const { events, report } = mapAndDerive({ text: csv, fileName: 'ledger-export.csv' }, { config: config(), salt: SALT, label: 'SYNTHETIC' });
  const balances = report.derive.balances;
  assert.equal(balances.accounts, LEDGER_FIXTURE_OPTIONS.traderCount);
  assert.equal(balances.replayed, LEDGER_FIXTURE_OPTIONS.traderCount);
  assert.deepEqual(balances.rejected, {});
  assert.equal(compare(events, dataset), events.length, 'every event matches the truth');
  assert.ok(events.every((event) => event.provenance.balance_before === 'derived:ledger-replay-0.1'));
  assert.equal(report.derive.byField.balance_after['derived:ledger-replay-0.1'], events.length);
  assert.ok(validateEvents(events).valid);
});

test('anchored to a balance snapshot, the replay matches the truth; drift beyond the tolerance and missing amounts are refused by reason', () => {
  const dataset = generate(0);
  const tokens = dataset.truth.traders.map((trader) => trader.traderToken);
  // Three accounts lose one settlement amount from the ledger (both columns blank); the truth keeps it.
  const blanked = new Set(tokens.slice(-3));
  const ledgerView = { ...dataset, events: dataset.events.map((event) => event) };
  for (const token of blanked) {
    const index = ledgerView.events.findIndex((event) => event.trader_token === token && event.type === 'trade' && ledgerView.events.filter((other) => other.trader_token === token).indexOf(event) > 20);
    ledgerView.events[index] = { ...ledgerView.events[index], realized_result: null };
  }
  const { csv } = ledgerFixtureFromDataset(ledgerView, { file: 'ledger-export.csv' });
  const clean = tokens.filter((token) => !blanked.has(token));
  assert.ok(clean.length >= 3, 'some accounts have every result');
  const [tampered] = clean;
  const picks = tokens.flatMap((token) => [[token, 3], [token, 12]]);
  // The tampered account's second snapshot is 5 cents off: the first one anchors it, the second drifts.
  const text = withSnapshots(csv, dataset, picks, (token, eventIndex) => (token === tampered && eventIndex === 12 ? 0.05 : 0));
  const run = (tolerance) => mapAndDerive({ text, fileName: 'ledger-export.csv' }, { config: config({ anchor: 'snapshot', snapshot: true, tolerance }), salt: SALT, label: 'SYNTHETIC' });

  const strict = run({});
  const balances = strict.report.derive.balances;
  assert.equal(balances.rejected['a flow row has no amount, so the replay would be wrong after it'], blanked.size);
  assert.equal(balances.rejected['replayed balance drifts from a snapshot beyond the tolerance'], 1);
  assert.equal(balances.replayed, clean.length - 1);
  assert.equal(compare(strict.events, dataset), strict.events.filter((event) => event.balance_before !== undefined).length);
  const derivedTraders = new Set(strict.events.filter((event) => event.balance_before !== undefined).map((event) => event.trader_token));
  assert.equal(derivedTraders.size, clean.length - 1, 'a refused account gets no derived balances');

  const loose = run({ toleranceAbsolute: 0.1 });
  assert.equal(loose.report.derive.balances.rejected['replayed balance drifts from a snapshot beyond the tolerance'], undefined, 'the tolerance is configurable');
  assert.equal(loose.report.derive.balances.replayed, clean.length);
});

test('without a snapshot or an opening anchor there are no derived balances', () => {
  assert.throws(() => normalizeIntakeConfig(config({ anchor: 'snapshot' })), /anchor "snapshot" needs snapshot rows/);
  const dataset = generate(0);
  const { csv } = ledgerFixtureFromDataset(dataset, { file: 'ledger-export.csv' });
  const { events, report } = mapAndDerive({ text: csv, fileName: 'ledger-export.csv' }, { config: config({ anchor: 'snapshot', snapshot: true }), salt: SALT, label: 'SYNTHETIC' });
  assert.equal(report.derive.balances.rejected['no balance snapshot to anchor the replay'], LEDGER_FIXTURE_OPTIONS.traderCount);
  assert.ok(events.every((event) => event.balance_before === undefined && event.provenance?.balance_before === undefined));
});

test('fees and withdrawals are flows; a session never mixes observed and derived balances', () => {
  const ledger = [
    'id,acct,at,kind,amount,balance',
    'L1,A-1,2026-05-01T10:00:00Z,DEPOSIT,100,',
    'L2,A-1,2026-05-01T10:01:00Z,BET,-10,90',
    'L3,A-1,2026-05-01T10:02:00Z,FEE,1,',
    'L4,A-1,2026-05-01T10:03:00Z,BET,15,',
    'L5,A-1,2026-05-01T10:04:00Z,WITHDRAWAL,50,',
    'L6,A-1,2026-05-01T14:00:00Z,BET,-4,50',
    'L7,A-1,2026-05-01T14:05:00Z,BET,6,56'
  ].join('\n');
  const cfg = {
    name: 'unit-ledger',
    label: 'SYNTHETIC',
    venueId: 'unit',
    trader: { column: 'acct' },
    eventId: { column: 'id' },
    timestamp: { column: 'at', timezone: 'UTC' },
    eventType: { column: 'kind', values: { DEPOSIT: 'deposit', BET: 'trade', WITHDRAWAL: 'withdrawal' }, ignore: ['FEE'] },
    fields: {
      realized_result: { column: 'amount', units: 'dollars', appliesTo: ['trade'] },
      deposit_amount: { column: 'amount', units: 'dollars', appliesTo: ['deposit'] },
      withdrawal_amount: { column: 'amount', units: 'dollars', appliesTo: ['withdrawal'] },
      balance_after: { column: 'balance', units: 'dollars' }
    },
    attributes: { amount: { column: 'amount', kind: 'number', units: 'dollars' } },
    derive: { balances: [{ method: 'ledger-replay', ledger: 'main', anchor: 'opening', flows: [
      { when: ['DEPOSIT', 'BET'], add: ['amount'] },
      { when: ['WITHDRAWAL', 'FEE'], subtract: ['amount'] }
    ] }] }
  };
  const { events, report } = mapAndDerive({ text: ledger, fileName: 'l.csv' }, { config: cfg, salt: SALT, label: 'SYNTHETIC' });
  // Session 1 had one observed balance_after (on L2) but no balance_before: it is mixed, so all of it is derived.
  assert.deepEqual(events.slice(0, 4).map((event) => [event.balance_before, event.balance_after]), [[0, 100], [100, 90], [89, 104], [104, 54]], 'the fee comes out between L2 and L4');
  assert.ok(events.slice(0, 4).every((event) => event.provenance.balance_after === 'derived:ledger-replay-0.1'));
  // Session 2 has balance_after but no balance_before on either trade: also mixed, so derived.
  assert.deepEqual(events.slice(4).map((event) => [event.balance_before, event.balance_after]), [[54, 50], [50, 56]]);
  assert.equal(report.derive.balances.observedReplaced, 3);
  assert.equal(report.derive.balances.sessionsKeptObserved, 0);
});
