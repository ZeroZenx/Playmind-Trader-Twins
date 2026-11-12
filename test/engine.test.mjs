import test from 'node:test';
import assert from 'node:assert/strict';
import { generateSyntheticDataset } from '../src/synthetic/generate.mjs';
import {
  buildReport,
  buildSignals,
  buildTwins,
  comparePolicy,
  sanitizeCsvCell,
  simulateTwin,
  validateEvents
} from '../src/engine/index.mjs';

test('synthetic dataset passes validation and has useful coverage', () => {
  const dataset = generateSyntheticDataset({ seed: 424242, traderCount: 6, days: 7 });
  const quality = validateEvents(dataset.events);
  assert.equal(quality.valid, true, quality.errors.join('\n'));
  assert.ok(quality.stats.rowCount > 0);
  assert.equal(quality.stats.traderCount, 6);
  assert.ok(quality.stats.realizedOutcomeCoverage > 0);
  assert.ok(quality.stats.realizedOutcomeCoverage < 1);
});

test('validator rejects direct PII and duplicate event IDs', () => {
  const events = [
    {
      event_id: 'dup',
      trader_token: 't1',
      name: 'Not allowed',
      occurred_at: '2026-01-01T00:00:00Z',
      type: 'trade',
      venue_id: 'v1',
      source_row_number: 1
    },
    {
      event_id: 'dup',
      trader_token: 't1',
      occurred_at: '2026-01-01T01:00:00Z',
      type: 'trade',
      venue_id: 'v1',
      source_row_number: 2
    }
  ];
  const quality = validateEvents(events);
  assert.equal(quality.valid, false);
  assert.ok(quality.errors.some((error) => error.includes('prohibited field')));
  assert.ok(quality.errors.some((error) => error.includes('Duplicate event_id')));
});

test('missing realized outcomes stay outside loss counts', () => {
  const events = [
    { event_id: '1', trader_token: 't1', occurred_at: '2026-01-01T00:00:00Z', type: 'trade', venue_id: 'v1', stake_amount: 10, realized_result: null, source_row_number: 1 },
    { event_id: '2', trader_token: 't1', occurred_at: '2026-01-01T01:00:00Z', type: 'trade', venue_id: 'v1', stake_amount: 10, realized_result: -5, source_row_number: 2 }
  ];
  const signals = buildSignals(events);
  assert.equal(signals[0].realizedOutcomeCount, 1);
  assert.equal(signals[0].missingRealizedOutcomeCount, 1);
  assert.equal(signals[0].realizedLossCount, 1);
});

test('twin builds are deterministic for the same input seed', () => {
  const dataset = generateSyntheticDataset({ seed: 99, traderCount: 4, days: 5 });
  const signals = buildSignals(dataset.events);
  assert.deepEqual(buildTwins(signals, 99), buildTwins(signals, 99));
});

test('policy comparison produces separate baseline and policy results', () => {
  const dataset = generateSyntheticDataset({ seed: 424242, traderCount: 8, days: 10 });
  const signals = buildSignals(dataset.events);
  const twins = buildTwins(signals, dataset.seed);
  const run = comparePolicy(twins, { type: 'cooldown', durationMinutes: 30 }, { horizonDays: 7, seed: 7000 });
  assert.equal(run.results.length, 8);
  assert.ok(run.aggregate.policyTriggers > 0);
  assert.ok(run.aggregate.policyTradeCount <= run.aggregate.baselineTradeCount);
  assert.equal(run.aggregate.policyTotalDeposits, run.aggregate.baselineTotalDeposits);
});

test('stake limit caps trades at maxStake instead of dropping them', () => {
  // Every proposed stake is 100 * (0.55..1.45), so every trade exceeds maxStake = 20.
  const twin = {
    twinId: 'twin_cap',
    randomSeed: 11,
    profile: {
      traderToken: 'cap',
      sessionRatePerDay: 2,
      tradesPerSession: 4,
      averageStake: 100,
      averageDeposit: 50,
      lossRate: 0.5,
      marketMix: {}
    }
  };
  const baseline = simulateTwin(twin, { horizonDays: 3, seed: 11 });
  const capped = simulateTwin(twin, { horizonDays: 3, seed: 11, policy: { type: 'stake_limit', maxStake: 20 } });
  const cappedTrades = capped.events.filter((event) => event.type === 'trade');

  assert.ok(baseline.tradeCount > 0);
  assert.equal(capped.tradeCount, baseline.tradeCount);
  assert.equal(capped.blockedTrades, 0);
  assert.equal(capped.policyTriggers, capped.tradeCount);
  assert.ok(cappedTrades.every((event) => event.stakeAmount === 20));
  assert.equal(capped.totalStake, 20 * capped.tradeCount);
});

test('CSV formula values receive a neutralizing prefix', () => {
  assert.equal(sanitizeCsvCell('=SUM(A1:A2)'), "'=SUM(A1:A2)");
  assert.equal(sanitizeCsvCell('normal'), 'normal');
});

test('report marks synthetic evidence and limitations', () => {
  const dataset = generateSyntheticDataset({ seed: 7, traderCount: 2, days: 3 });
  const quality = validateEvents(dataset.events);
  const signals = buildSignals(dataset.events);
  const twins = buildTwins(signals, dataset.seed);
  const policyRun = comparePolicy(twins, { type: 'stake_limit', maxStake: 20 }, { horizonDays: 2, seed: 7 });
  const report = buildReport({
    dataset: { ...dataset, eventCount: dataset.events.length, traderCount: signals.length },
    quality,
    signals,
    twins,
    policyRun
  });
  assert.equal(report.label, 'SYNTHETIC DEMO ONLY');
  assert.ok(report.limitations.some((item) => item.includes('causal')));
});
