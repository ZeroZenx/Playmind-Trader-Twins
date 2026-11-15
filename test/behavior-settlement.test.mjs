import test from 'node:test';
import assert from 'node:assert/strict';
import { BEHAVIOR_0_3_ADDITIONS, BEHAVIOR_VERSION, buildBehaviorObservations, buildBehaviorSignals } from '../src/engine/behavior.mjs';
import { generateBehavioralDataset } from '../src/synthetic/behavioral-generate.mjs';
import * as frozen from './fixtures/engine/behavior-0.2.0.mjs';

// behavior-0.3.0 outcome timing (ADR-018). All data is SYNTHETIC.

function strip(record, kind) {
  const copy = structuredClone(record);
  delete copy.version;
  for (const key of BEHAVIOR_0_3_ADDITIONS.inputs) delete copy.inputs[key];
  if (kind === 'observations') {
    for (const trade of copy.trades) for (const key of BEHAVIOR_0_3_ADDITIONS.trades) delete trade[key];
  }
  for (const key of BEHAVIOR_0_3_ADDITIONS.postOutcomeStakeExcluded) delete copy.postOutcomeStake.excluded[key];
  for (const key of BEHAVIOR_0_3_ADDITIONS.reentryLatencyExcluded) delete copy.reentryLatency.excluded[key];
  for (const key of BEHAVIOR_0_3_ADDITIONS.escalationExcluded) delete copy.escalation.excluded[key];
  return copy;
}

function withoutVersion(record) {
  const copy = structuredClone(record);
  delete copy.version;
  return copy;
}

// Simultaneous trades, deposits, withdrawals, snapshots, policy events, missing results, and balances.
function edgeCaseEvents() {
  const events = [];
  let row = 0;
  const add = (trader, minute, type, fields = {}) => {
    row += 1;
    events.push({ event_id: `e${row}`, trader_token: trader, occurred_at: new Date(Date.UTC(2026, 4, 1) + minute * 60000).toISOString(), type, venue_id: 'v', source_row_number: row, ...fields });
  };
  const results = [-5, -5, -5, 4, null, -3, -3, 0, 6, -2, -2, -2, -2, 7];
  results.forEach((result, index) => {
    const minute = Math.floor(index / 2) * 3 + (index > 8 ? 120 : 0);
    add('t1', minute, 'trade', { stake_amount: 5 + index, realized_result: result });
    if (index === 3) add('t1', minute, 'deposit', { deposit_amount: 50 });
    if (index === 6) add('t1', minute + 1, 'withdrawal', { withdrawal_amount: 10 });
    if (index === 7) add('t1', minute, 'policy_event', { policy_event_type: 'nudge' });
  });
  let balance = 100;
  for (let index = 0; index < 12; index += 1) {
    const result = index % 3 === 0 ? 8 : -6;
    add('t2', index * 4, 'trade', { stake_amount: 6, realized_result: result, balance_before: balance, balance_after: balance + result });
    balance += result;
    if (index === 5) add('t2', index * 4 + 1, 'balance_snapshot', { balance_before: balance, balance_after: balance });
  }
  return events;
}

const DATASETS = [
  ['archetypes with balances', () => generateBehavioralDataset({ seed: 41, tradersPerArchetype: 2, sessionsPerTrader: 30 }).events],
  ['population, no balances, 20% missing results', () => generateBehavioralDataset({ seed: 42, mode: 'population', traderCount: 25, sessionsPerTrader: { min: 3, max: 40 }, includeBalances: false, missingOutcomeShare: 0.2 }).events],
  ['edge cases', edgeCaseEvents]
];

for (const [name, build] of DATASETS) {
  test(`without settled_at and placed_at, behavior-0.3.0 equals behavior-0.2.0 exactly: ${name}`, () => {
    const events = build();
    const options = { observationEnd: '2026-12-31T00:00:00Z' };
    const now = buildBehaviorObservations(events, options);
    const before = frozen.buildBehaviorObservations(events, options);
    assert.equal(now.length, before.length);
    assert.deepEqual(now.map((record) => strip(record, 'observations')), before.map(withoutVersion));
    const signals = buildBehaviorSignals(events, {});
    const oldSignals = frozen.buildBehaviorSignals(events, {});
    assert.deepEqual(signals.map((record) => strip(record, 'signals')), oldSignals.map(withoutVersion));
    for (const record of now) {
      assert.equal(record.inputs.tradesWithSettledAt, 0);
      assert.ok(record.trades.every((trade) => trade.fresh === trade.index > 0 && trade.knownBefore === trade.index));
    }
  });
}

test('behavior-0.3.0 is the version, and a frozen 0.2.0 copy is what the equality is checked against', () => {
  assert.equal(BEHAVIOR_VERSION, 'behavior-0.3.0');
  assert.equal(frozen.BEHAVIOR_VERSION, 'behavior-0.2.0');
});

function trade(minute, result, { stake = 10, settle = null, placed = null, row } = {}) {
  const at = (value) => new Date(Date.UTC(2026, 4, 1) + value * 60000).toISOString();
  const event = { event_id: `e${row}`, trader_token: 'tr', occurred_at: at(minute), type: 'trade', venue_id: 'v', source_row_number: row, stake_amount: stake, realized_result: result };
  if (settle !== null) event.settled_at = at(settle);
  if (placed !== null) event.placed_at = at(placed);
  return event;
}

test('an outcome affects the first trade placed at or after it settles, and latency runs from settlement', () => {
  // Trade 0 loses, but only settles at minute 7. Trades 1 and 2 are placed while it is open.
  const events = [
    trade(0, -10, { settle: 7, row: 1 }),
    trade(2, 5, { settle: 3, row: 2 }),
    trade(5, -10, { settle: 6, row: 3 }),
    trade(8, 5, { row: 4 }),
    trade(9, 5, { row: 5 })
  ];
  const [record] = buildBehaviorObservations(events);
  const byIndex = record.trades;
  assert.equal(byIndex[1].previousOutcome, null, 'trade 1: nothing had settled yet');
  assert.equal(byIndex[1].fresh, false);
  assert.equal(byIndex[2].previousOutcome, 'win', 'trade 2 reacts to trade 1, settled at minute 3');
  assert.equal(byIndex[3].previousOutcome, 'loss', 'trade 3: trade 2 settled at 6 and trade 0 at 7; the latest is a loss');
  assert.equal(record.postOutcomeStake.excluded.superseded, 1, 'trade 2\'s loss (settled at 6) is superseded by trade 0\'s (settled at 7)');
  assert.equal(record.postOutcomeStake.excluded.noNewOutcome, 1);
  assert.deepEqual(record.reentryLatency.anySession.loss, [1], 'from settlement at minute 7 to the trade at minute 8');
  assert.deepEqual(record.reentryLatency.anySession.win, [2, 1], 'trade 1: 3 -> 5; trade 3 (settles at once): 8 -> 9');
  assert.equal(record.reentryLatency.excluded.superseded, 1);
  // The running result after each trade counts what had settled at its placement, plus its own
  // outcome when it settled at once (trades 3 and 4): 5 at minute 3, -10 at 6, -10 at 7.
  assert.deepEqual(byIndex.map((item) => item.running), [0, 0, 5, -10, -5]);
  assert.deepEqual(byIndex.map((item) => item.afterOutcome), [null, null, 'win', 'win', 'win']);
  assert.equal(byIndex[0].settlement.knownBeforeNextTrade, false);
  assert.equal(byIndex[1].settlement.knownBeforeNextTrade, true);
  assert.equal(byIndex[0].settlement.lagMinutes, 7);
  assert.equal(record.inputs.tradesWithSettledAt, 3);
  assert.equal(record.sessions[0].source, 'realized_result');
});

test('placed_at is the trade time, and a settled_at before the trade is ignored and counted', () => {
  const events = [trade(10, -5, { placed: 2, row: 1 }), trade(12, 5, { settle: 1, row: 2 }), trade(45, 5, { placed: 39, row: 3 })];
  const [record] = buildBehaviorObservations(events);
  assert.equal(record.trades[0].t, Date.UTC(2026, 4, 1) + 2 * 60000);
  assert.equal(record.inputs.tradesWithPlacedAt, 2);
  assert.equal(record.inputs.settlementTimesBeforeTrade, 1);
  assert.equal(record.trades[1].settlement.basis, 'assumed');
  assert.equal(record.sessions.length, 1, 'placed_at sets the session gaps: 12 -> 39 is 27 minutes (12 -> 45 would be 33)');
});

test('escalation and losing streaks follow settlement order within the session', () => {
  // Three losses settle at minutes 1, 2, 3; the trader places trades in between.
  const events = [
    trade(0, -10, { settle: 1, row: 1, stake: 10 }),
    trade(1.5, -10, { settle: 2, row: 2, stake: 20 }),
    trade(2.5, -10, { settle: 3, row: 3, stake: 40 }),
    trade(3.5, 5, { row: 4, stake: 80 })
  ];
  const [record] = buildBehaviorObservations(events, { losingStreakLength: 3, observationEnd: '2026-05-02T00:00:00Z' });
  assert.deepEqual(record.escalation.points.map((point) => [point.step, point.reference, point.response]), [[1, 1, 2], [2, 1, 3]]);
  assert.equal(record.refuel.losingStreak.length, 1);
  assert.equal(record.refuel.losingStreak[0].t, Date.UTC(2026, 4, 1) + 3 * 60000, 'the streak completes when the third loss settles');
});
