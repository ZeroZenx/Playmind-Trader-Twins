import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BASELINE_START,
  CHURN_CAVEAT,
  HOLDOUT_METRICS,
  HOLDOUT_METRIC_NAMES,
  HOLDOUT_TOLERANCES,
  HOLDOUT_VERSION,
  NAIVE_MODEL_VERSION,
  OBSERVATIONAL_HOOK,
  bandCoverage,
  baselineEventsToAnalytical,
  holdoutEventMetrics,
  holdoutQuantiles,
  ksStatistic,
  naivePrediction,
  runHoldoutValidation,
  runObservationalHoldout,
  splitHoldout,
  summarizeHoldout
} from '../src/engine/holdout.mjs';
import { estimateTwins } from '../src/engine/estimate.mjs';
import { metricsFromEvents, prepareSimulation, simulateBaseline, simulateReplicate, simulateTwinV2 } from '../src/engine/simulate.mjs';
import { buildSignals } from '../src/engine/signals.mjs';
import { buildTwins } from '../src/engine/twin.mjs';
import { validateEvents } from '../src/engine/validate.mjs';
import * as engine from '../src/engine/index.mjs';
import { generateBehavioralDataset } from '../src/synthetic/behavioral-generate.mjs';
import { truthFit } from '../src/synthetic/truth-twins.mjs';

// Held-out validation (holdout-0.1.0, ADR-014). Small populations and few replicates keep
// these fast. Validation numbers stay in test thresholds and gitignored output.

const DAY = 86400000;
const MINUTE = 60000;
const T0 = Date.parse('2026-04-01T10:00:00.000Z');

let row = 0;
function trade(token, ms, stake = 10, result = -10) {
  row += 1;
  return { event_id: `h_${row}`, trader_token: token, occurred_at: new Date(ms).toISOString(), type: 'trade', venue_id: 'v', stake_amount: stake, realized_result: result, source_row_number: row };
}
function session(token, startMs, trades, stepMinutes = 5) {
  return Array.from({ length: trades }, (_, index) => trade(token, startMs + index * stepMinutes * MINUTE));
}

// A: 8 daily sessions of 3 trades. B: a long session that spans its 75% point. C: three
// sessions, so one test session. D: one session.
function handBuilt() {
  const events = [];
  for (let day = 0; day < 8; day += 1) events.push(...session('A', T0 + day * DAY, 3));
  events.push(...session('B', T0, 1), ...session('B', T0 + 10 * 60 * MINUTE, 31, 20), ...session('B', T0 + 21 * 60 * MINUTE, 1));
  for (let day = 0; day < 3; day += 1) events.push(...session('C', T0 + day * DAY, 4));
  events.push(...session('D', T0, 5));
  return events;
}
const SMALL_SPLIT = { minTrainSessions: 2, minTestSessions: 2, minTestTrades: 4, minTestDays: 1 };

const dataset = generateBehavioralDataset({ seed: 41, name: 'holdout-unit', mode: 'population', traderCount: 14, sessionsPerTrader: { min: 20, max: 40 } });
const behaviorOptions = dataset.truth.options.behaviorOptions;
const RUN = { dataLabel: 'SYNTHETIC', behaviorOptions, seed: 7, replicates: 6, ksReplicates: 6 };
const result = runHoldoutValidation(dataset.events, { ...RUN, reference: { fit: truthFit(dataset) }, includeTraders: true });

test('the split is time-based, lands on a session boundary, and train and test do not overlap', () => {
  const events = handBuilt();
  const split = splitHoldout(events, SMALL_SPLIT);
  const a = split.traders.find((trader) => trader.traderToken === 'A');
  // Active period: day 0 10:00 to day 7 10:10. 75% of it is day 5 16:07:30, inside no
  // session, so the cut is the next session start: day 6 10:00.
  assert.equal(a.activeStart, new Date(T0).toISOString());
  assert.equal(a.activeEnd, new Date(T0 + 7 * DAY + 10 * MINUTE).toISOString());
  assert.equal(a.nominalCut, new Date(T0 + 0.75 * (7 * DAY + 10 * MINUTE)).toISOString());
  assert.equal(a.cut, new Date(T0 + 6 * DAY).toISOString());
  assert.deepEqual([a.trainSessions, a.testSessions, a.trainTrades, a.testTrades], [6, 2, 18, 6]);
  assert.ok(Math.abs(a.testDays - (DAY + 10 * MINUTE) / DAY) < 1e-12);
  assert.equal(a.eligible, true);

  // B's 75% point (15:45 after its start) falls inside its 10-hour session, which stays
  // whole in training: the cut is the next session's start.
  const b = split.traders.find((trader) => trader.traderToken === 'B');
  assert.ok(Date.parse(b.nominalCut) > T0 + 10 * 60 * MINUTE && Date.parse(b.nominalCut) < T0 + 20 * 60 * MINUTE);
  assert.equal(b.cut, new Date(T0 + 21 * 60 * MINUTE).toISOString());
  assert.equal(b.trainTrades, 32);

  for (const trader of split.traders.filter((item) => item.cut)) {
    const cut = Date.parse(trader.cut);
    const train = split.trainEvents.filter((event) => event.trader_token === trader.traderToken).map((event) => Date.parse(event.occurred_at));
    assert.ok(Math.max(...train) < cut, `${trader.traderToken}: training ends before the cut`);
    // The cut starts a session: the last training event is more than the session gap earlier.
    assert.ok(cut - Math.max(...train) > split.settings.sessionGapMinutes * MINUTE);
    assert.ok(cut >= Date.parse(trader.nominalCut));
    const test = split.testEvents.filter((event) => event.trader_token === trader.traderToken).map((event) => Date.parse(event.occurred_at));
    if (trader.eligible) assert.equal(Math.min(...test), cut);
    else assert.equal(test.length, 0);
  }
  const trainIds = new Set(split.trainEvents.map((event) => event.event_id));
  assert.ok(split.testEvents.every((event) => !trainIds.has(event.event_id)), 'no event is in both');

  // Deterministic, and independent of input order.
  const again = splitHoldout([...events].reverse(), SMALL_SPLIT);
  assert.deepEqual(again.traders, split.traders);
  assert.deepEqual(new Set(again.trainEvents.map((event) => event.event_id)), trainIds);
  // The share is configurable: at 0.5, A's cut is day 4 (its midpoint is day 3 22:05).
  assert.equal(splitHoldout(events, { ...SMALL_SPLIT, trainShare: 0.5 }).traders.find((trader) => trader.traderToken === 'A').cut, new Date(T0 + 4 * DAY).toISOString());
  assert.throws(() => splitHoldout(events, { trainShare: 1 }), /trainShare/);
  assert.throws(() => splitHoldout(events, { shuffle: true }), /unknown option "shuffle"/);
});

test('short test windows give null with a reason, never a number', () => {
  const split = splitHoldout(handBuilt(), SMALL_SPLIT);
  const byToken = Object.fromEntries(split.traders.map((trader) => [trader.traderToken, trader]));
  assert.equal(byToken.B.eligible, false);
  assert.match(byToken.B.reason, /1 test session\(s\), below the minimum of 2/);
  assert.equal(byToken.C.eligible, false);
  assert.match(byToken.C.reason, /test session/);
  assert.equal(byToken.D.eligible, false);
  assert.equal(byToken.D.reason, 'one session: nothing to split');
  assert.equal(byToken.D.cut, null);
  assert.equal(byToken.D.testDays, null);
  // D has no cut, so every event trains; B and C train on the events before their cut.
  assert.equal(split.trainEvents.filter((event) => event.trader_token === 'D').length, 5);
  assert.equal(split.testEvents.filter((event) => event.trader_token !== 'A').length, 0);
  assert.match(splitHoldout(handBuilt(), { ...SMALL_SPLIT, minTestSessions: 1, minTestTrades: 1 }).traders.find((trader) => trader.traderToken === 'B').reason, /test window of 0\.000 days/);
  assert.match(splitHoldout(handBuilt(), { ...SMALL_SPLIT, minTestTrades: 7 }).traders.find((trader) => trader.traderToken === 'A').reason, /6 test trade\(s\), below the minimum of 7/);

  // In a full run, an ineligible trader is listed with its reason and gets no metric row.
  const short = generateBehavioralDataset({ seed: 5, name: 'holdout-short', mode: 'population', traderCount: 10, sessionsPerTrader: { min: 2, max: 30, scale: 'log' } });
  const run = runHoldoutValidation(short.events, { dataLabel: 'SYNTHETIC', behaviorOptions: short.truth.options.behaviorOptions, replicates: 2, includeTraders: true });
  const ineligible = run.traders.filter((trader) => !trader.eligible);
  assert.ok(ineligible.length > 0, 'the population has short histories');
  for (const trader of ineligible) {
    assert.equal(typeof trader.reason, 'string');
    assert.equal(trader.compared, false);
    assert.ok(!run.perTrader.some((item) => item.traderToken === trader.traderToken));
  }
  assert.equal(run.perTrader.length, run.inputs.compared);
});

test('observed and simulated metrics use identical definitions, and the same-window check is internally consistent', () => {
  const fit = estimateTwins(dataset.events, { dataLabel: 'SYNTHETIC', behaviorOptions });
  const baseStakes = Object.fromEntries(fit.twins.map((twin) => [twin.traderToken, twin.parameters.baseStake.estimate]));
  const observed = holdoutEventMetrics(dataset.events, { baseStakes, behaviorOptions });
  const reference = metricsFromEvents(dataset.events, { baseStakes, behaviorOptions });
  for (const [token, metrics] of Object.entries(observed)) {
    assert.equal(metrics.stats.tradesPerSession, reference[token].tradesPerSession);
    assert.equal(metrics.stats.depositsAfterLoss, reference[token].depositsAfterLossPerSession);
    assert.equal(metrics.samples.tradesPerSession.reduce((a, b) => a + b, 0) / metrics.samples.tradesPerSession.length, reference[token].tradesPerSession);
    assert.equal(metrics.samples.depositsAfterLoss.reduce((a, b) => a + b, 0), reference[token].depositsAfterLoss);
    assert.equal(metrics.unassignedDepositsAfterLoss, 0);
    assert.equal(metrics.samples.tradesPerSession.length, reference[token].sessions);
  }

  // The simulator's own run metrics agree with the event-derived ones on the same run.
  const prepared = prepareSimulation(fit, { seed: 3, replicates: 1, horizonDays: 10, keepEvents: true, traders: [fit.twins[0].traderToken] });
  const run = simulateReplicate(prepared, prepared.plans[0], 0);
  const fromRun = holdoutEventMetrics(run.events, { baseStakes, behaviorOptions })[fit.twins[0].traderToken];
  assert.equal(fromRun.stats.tradesPerSession, run.metrics.tradesPerSession);
  assert.equal(fromRun.stats.depositsAfterLoss, run.metrics.depositsAfterLossPerSession);

  // Same-window check: naive-0.1 judged on its own training window reproduces it exactly,
  // except the stake metrics, which it predicts without the last outcome.
  for (const metrics of Object.values(observed)) {
    const naive = naivePrediction(metrics);
    for (const name of HOLDOUT_METRIC_NAMES) {
      if (name.startsWith('stake')) continue;
      assert.equal(naive.stats[name], metrics.stats[name], name);
      if (metrics.samples[name].length) assert.equal(ksStatistic(metrics.samples[name], naive.samples[name]), 0, name);
    }
    assert.equal(naive.stats.stakeAfterLoss, metrics.stats.stakeAll);
    assert.equal(naive.stats.stakeAfterWin, metrics.stats.stakeAll);
    assert.equal(naive.stats.stakeLossMinusWin, 0);
    // And a band that is the observed value itself covers it.
    assert.equal(bandCoverage([{ observed: metrics.stats.sessionMinutes, band: { p10: metrics.stats.sessionMinutes, p90: metrics.stats.sessionMinutes } }]).share, 1);
  }

  // A missing realized outcome stays unavailable: the next trade is in neither stake sample.
  const missing = [trade('M', T0, 10, -10), { ...trade('M', T0 + MINUTE, 10, 5), realized_result: null }, trade('M', T0 + 2 * MINUTE, 20, 5)];
  const m = holdoutEventMetrics(missing, { baseStakes: { M: 10 } }).M;
  assert.deepEqual(m.samples.stakeAfterLoss, [1]);
  assert.deepEqual(m.samples.stakeAfterWin, []);
  assert.equal(m.stats.stakeAfterWin, null);
  assert.equal(m.stats.stakeLossMinusWin, null);
});

test('per-trader runs from the cut equal a batch simulateTwinV2 run', () => {
  const fit = estimateTwins(dataset.events, { dataLabel: 'SYNTHETIC', behaviorOptions });
  const options = { seed: 11, replicates: 2, start: '2026-06-01T00:00:00.000Z', horizonDays: 3, keepEvents: true };
  const batch = simulateTwinV2(fit, options);
  for (const trader of batch.traders.slice(0, 4)) {
    const prepared = prepareSimulation(fit, { ...options, traders: [trader.traderToken] });
    for (let replicate = 0; replicate < 2; replicate += 1) {
      assert.deepEqual(simulateReplicate(prepared, prepared.plans[0], replicate).events, trader.runs[replicate].events);
    }
  }
});

test('the baseline-0.1 adapter produces valid analytical events that line up with each trader\'s cut', () => {
  const split = splitHoldout(dataset.events, { behaviorOptions });
  const twins = new Map(buildTwins(buildSignals(split.trainEvents)).map((twin) => [twin.profile.traderToken, twin]));
  for (const trader of split.traders.filter((item) => item.eligible).slice(0, 5)) {
    const raw = simulateBaseline(twins.get(trader.traderToken), { horizonDays: trader.testDays, seed: 9 }).events;
    const events = baselineEventsToAnalytical(raw, { traderToken: trader.traderToken, start: trader.cut, replicate: 2 });
    const validation = validateEvents(events);
    assert.equal(validation.valid, true, validation.errors.join('; '));
    assert.equal(events.length, raw.length);
    const times = events.map((event) => Date.parse(event.occurred_at));
    assert.equal(Math.min(...times), Date.parse(trader.cut), 'the first baseline session is at the cut');
    const shift = Date.parse(trader.cut) - Date.parse(BASELINE_START);
    events.forEach((event, index) => {
      assert.equal(event.trader_token, trader.traderToken);
      assert.equal(Date.parse(event.occurred_at), Date.parse(raw[index].occurredAt) + shift);
      assert.ok(!('marketType' in event) && !('market_type' in event), 'market fields are dropped');
      assert.ok(!('balance_before' in event), 'baseline-0.1 has no balances');
      if (event.type === 'trade') {
        assert.equal(event.stake_amount, raw[index].stakeAmount);
        assert.equal(event.realized_result, raw[index].realizedResult);
      } else {
        assert.equal(event.type, 'deposit');
        assert.equal(event.deposit_amount, raw[index].amount);
      }
    });
    assert.ok(events[0].event_id.startsWith('base_2_'));
    assert.ok(holdoutEventMetrics(events, { baseStakes: { [trader.traderToken]: 10 } })[trader.traderToken].samples.tradesPerSession.length > 0);
  }
  assert.throws(() => baselineEventsToAnalytical([], { traderToken: 'x', start: 'not a date' }), /start/);
});

test('the naive model is the training values', () => {
  const split = splitHoldout(dataset.events, { behaviorOptions });
  const fit = estimateTwins(split.trainEvents, { dataLabel: 'SYNTHETIC', behaviorOptions });
  const baseStakes = Object.fromEntries(fit.twins.map((twin) => [twin.traderToken, twin.parameters.baseStake.estimate]));
  const training = holdoutEventMetrics(split.trainEvents, { baseStakes, behaviorOptions });
  assert.ok(result.perTrader.length > 0);
  for (const row of result.perTrader) {
    const stats = training[row.traderToken].stats;
    for (const name of HOLDOUT_METRIC_NAMES) {
      let expected = stats[name];
      if (name === 'stakeAfterLoss' || name === 'stakeAfterWin') expected = stats.stakeAll;
      if (name === 'stakeLossMinusWin') expected = 0;
      assert.equal(row.metrics[name].naive, expected, `${row.traderToken} ${name}`);
    }
  }
  assert.equal(result.models.naive.version, NAIVE_MODEL_VERSION);
  assert.equal(result.naiveVersion, NAIVE_MODEL_VERSION);
});

test('calibration coverage is computed like simulation-calibration.mjs', () => {
  const band = { p10: 1, p90: 2 };
  const share = bandCoverage([
    { observed: 1, band }, { observed: 2, band }, { observed: 1.5, band },
    { observed: 1 - 1e-12, band }, // within the 1e-9 slack: inside
    { observed: 0.5, band }, { observed: 3, band },
    { observed: null, band }, { observed: 1.5, band: { p10: null, p90: null } }, { observed: 1.5, band: null }
  ]);
  assert.deepEqual(share, { traders: 6, inside: 4, below: 1, above: 1, share: 4 / 6 });
  assert.deepEqual(bandCoverage([]), { traders: 0, inside: 0, below: 0, above: 0, share: null });

  // The run's per-metric calibration is bandCoverage over its per-trader bands.
  for (const name of HOLDOUT_METRIC_NAMES) {
    const recomputed = bandCoverage(result.perTrader.map((item) => ({ observed: item.metrics[name].observed, band: item.metrics[name].twin })));
    assert.deepEqual(result.metrics[name].models.twin.calibration, recomputed, name);
    assert.equal(result.metrics[name].models.naive.calibration, null, 'naive has no band');
  }
});

test('KS D is correct on hand-built samples, ties included', () => {
  assert.equal(ksStatistic([1, 2, 3], [1, 2, 3]), 0);
  assert.equal(ksStatistic([1, 2, 3], [4, 5, 6]), 1);
  assert.equal(ksStatistic([1, 2, 3, 4], [3, 4, 5, 6]), 0.5);
  // Ties: F1 = .25, .75, 1, 1 and F2 = 0, .75, .75, 1 at 1, 2, 3, 4, so D = 0.25. A version
  // that stepped through tied values one at a time would report more.
  assert.equal(ksStatistic([1, 2, 2, 3], [2, 2, 2, 4]), 0.25);
  assert.equal(ksStatistic([0, 0, 0, 1], [0, 1, 1, 1]), 0.5);
  assert.equal(ksStatistic([2, 1], [1, 2]), 0, 'order does not matter');
  assert.equal(ksStatistic([1, null, Number.NaN, 2], [1, 2]), 0, 'non-finite values are dropped, never read as 0');
  assert.equal(ksStatistic([], [1]), null);
  assert.deepEqual(holdoutQuantiles([5, 1, 3, 2, 4]), { p10: 1.4, p25: 2, p50: 3, p75: 4, p90: 4.6 });
  assert.equal(holdoutQuantiles([null]), null);
});

test('pass/fail responds to tolerances', () => {
  const loose = summarizeHoldout(result, { maxKsD: 1, coverage: { continuous: [0, 1], ties: [0, 1] } });
  assert.equal(loose.overall.calibration.pass, true);
  assert.equal(loose.overall.distribution.pass, true);
  const strict = summarizeHoldout(result, { maxKsD: 0, coverage: { continuous: [1, 1] } });
  assert.equal(strict.overall.distribution.pass, false);
  assert.equal(strict.overall.pass, false);
  assert.ok(Object.values(strict.perMetric).every((cell) => cell.distribution.pass === false));
  // errorMargin 1 asks for a point error below zero, so the twin can't win on error.
  const impossible = summarizeHoldout(result, { errorMargin: 1 });
  for (const cell of Object.values(impossible.perMetric)) {
    for (const comparison of Object.values(cell.beats)) if (comparison.errorWin !== null) assert.equal(comparison.errorWin, false);
  }
  assert.equal(impossible.overall.claim.earned, false);
  // beatsShare: with 1 nobody can beat more than every metric; with 0 one metric is enough.
  assert.equal(summarizeHoldout(result, { beatsShare: 1 }).overall.beats.baseline.beats, false);
  const anyMetric = summarizeHoldout(result, { beatsShare: 0 });
  assert.equal(anyMetric.overall.beats.baseline.beats, anyMetric.overall.beats.baseline.metricsBeaten > 0);
  // The default summary is the one the run carries.
  assert.deepEqual(summarizeHoldout(result), result.summary);
  assert.deepEqual(result.summary.tolerances, HOLDOUT_TOLERANCES);
  assert.throws(() => summarizeHoldout(result, { maxKsD: 2 }), /maxKsD/);
  assert.throws(() => summarizeHoldout(result, { coverage: { continuous: [0.9, 0.1] } }), /coverage/);
  assert.throws(() => summarizeHoldout(result, { alpha: 0.05 }), /unknown tolerance "alpha"/);
});

test('held-out validation is deterministic under a seed', () => {
  const small = { ...RUN, replicates: 3 };
  const first = runHoldoutValidation(dataset.events, small);
  assert.deepEqual(runHoldoutValidation(dataset.events, small), first);
  const other = runHoldoutValidation(dataset.events, { ...small, seed: 8 });
  assert.notDeepEqual(other.metrics.sessionMinutes.models.twin, first.metrics.sessionMinutes.models.twin);
  // The naive model and the observed side don't depend on the simulation seed.
  assert.deepEqual(other.metrics.sessionMinutes.observed, first.metrics.sessionMinutes.observed);
  assert.deepEqual(other.metrics.sessionMinutes.models.naive.ksD, first.metrics.sessionMinutes.models.naive.ksD);
});

test('the no-balance path labels all-cause stops and proxy refuel', () => {
  const plain = generateBehavioralDataset({ seed: 41, name: 'holdout-unit', mode: 'population', traderCount: 14, sessionsPerTrader: { min: 20, max: 40 }, includeBalances: false });
  const run = runHoldoutValidation(plain.events, { ...RUN, replicates: 3 });
  assert.equal(run.inputs.tradersWithCompleteBalances, 0);
  assert.match(run.inputs.balancePath, /no balance fields: all-cause stop hazards and proxy \(losing-streak\) refuel/);
  assert.equal(run.labels.allCauseStops.length, run.inputs.compared);
  assert.equal(run.labels.proxyRefuel.length, run.inputs.compared);
  assert.ok(run.traders.filter((trader) => trader.compared).every((trader) => trader.stopBasis === 'all-cause' && trader.refuelTrigger === 'losingStreak (proxy)'));
  assert.equal(result.labels.allCauseStops.length, 0, 'with balances the hazards are voluntary');
  assert.equal(result.inputs.balancePath, 'balance fields on every trader');
});

test('every output carries its label, versions, seed, replicates, split rule, and assumptions', () => {
  assert.equal(result.holdoutVersion, HOLDOUT_VERSION);
  assert.equal(result.dataLabel, 'SYNTHETIC');
  assert.equal(result.modelVersion, 'twin-0.3.0');
  assert.equal(result.simulatorVersion, 'simulator-0.3.0');
  assert.equal(result.baselineVersion, 'baseline-0.1');
  assert.equal(result.seed, 7);
  assert.equal(result.replicates, 6);
  assert.equal(result.split.trainShare, 0.75);
  assert.match(result.split.rule, /never random/);
  assert.equal(result.split.churnCaveat, CHURN_CAVEAT);
  assert.match(result.claim, /not an accuracy headline and not a causal claim/i);
  assert.ok(result.assumptions.includes(CHURN_CAVEAT));
  assert.ok(result.assumptions.some((line) => /No p-values/.test(line)));
  assert.ok(result.assumptions.some((line) => /event-observable/.test(line)));
  assert.deepEqual(Object.keys(result.models).sort(), ['baseline', 'naive', 'truth', 'twin']);
  assert.equal(result.models.truth.uncertainty, false);
  assert.equal(result.models.twin.uncertainty, true);
  assert.ok(result.perTrader.every((item) => item.dataLabel === 'SYNTHETIC'));
  for (const [name, metric] of Object.entries(result.metrics)) {
    assert.deepEqual(metric.definition, HOLDOUT_METRICS[name]);
    assert.ok(!JSON.stringify(metric).match(/pValue|p_value|auc/i), 'no p-values and no AUC');
  }
  assert.ok(result.metrics.idleMinutes.knownShapeDifference, 'the known idle-time shape difference is reported on SYNTHETIC data');
  assert.equal(result.summary.perMetric.idleMinutes.scored, false);
  assert.ok(Object.values(result.summary.perMetric).every((cell) => cell.diagnosis === null || typeof cell.diagnosis === 'string'));
  assert.equal(typeof result.summary.overall.claim.earned, 'boolean');

  // Labels are required and checked; the truth reference is SYNTHETIC only.
  assert.throws(() => runHoldoutValidation(dataset.events, { replicates: 2 }), /dataLabel is required/);
  assert.throws(() => runHoldoutValidation(dataset.events, { ...RUN, dataLabel: 'CUSTOMER', reference: { fit: truthFit(dataset) } }), /only for SYNTHETIC/);
  assert.throws(() => runHoldoutValidation(dataset.events, { ...RUN, sessions: 3 }), /unknown option "sessions"/);
  const customer = runHoldoutValidation(dataset.events, { ...RUN, dataLabel: 'CUSTOMER', replicates: 2 });
  assert.equal(customer.dataLabel, 'CUSTOMER');
  assert.equal(customer.metrics.sessionMinutes.knownShapeDifference, null, 'the synthetic shape notes apply to SYNTHETIC data only');
  assert.match(customer.summary.overall.claim.statement, /CUSTOMER/);

  // The OBSERVATIONAL hook: an entry point that takes events and the label; loading is not wired.
  assert.equal(OBSERVATIONAL_HOOK.status, 'not wired');
  const observational = runObservationalHoldout(dataset.events, { behaviorOptions, replicates: 2 });
  assert.equal(observational.dataLabel, 'OBSERVATIONAL');
  assert.throws(() => runObservationalHoldout(dataset.events, { dataLabel: 'CUSTOMER' }), /only takes the OBSERVATIONAL label/);
  assert.equal(engine.runHoldoutValidation, runHoldoutValidation);
  assert.equal(engine.HOLDOUT_VERSION, HOLDOUT_VERSION);
});
