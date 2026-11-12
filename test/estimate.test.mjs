import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DATA_LABELS,
  DEFAULT_BEHAVIOR_OPTIONS,
  PARAMETER_STATUSES,
  TWIN_MODEL_VERSION,
  TWIN_PARAMETER_DEFINITIONS,
  TWIN_PARAMETER_NAMES,
  buildBehaviorObservations,
  drawdownBucket,
  estimateTwins
} from '../src/engine/index.mjs';
import { betaCdf, betaQuantile, digamma, gammaCdf, gammaQuantile, trigamma } from '../src/engine/stats.mjs';
import { generateBehavioralDataset } from '../src/synthetic/behavioral-generate.mjs';

// Unit tests for twin-0.2.1 on SYNTHETIC data. Recovery against known parameters is in
// test/twin-recovery.test.mjs.

const LABEL = 'SYNTHETIC';
const population = generateBehavioralDataset({ seed: 31, mode: 'population', traderCount: 60, sessionsPerTrader: { min: 2, max: 40, scale: 'log' } });
const fit = estimateTwins(population.events, { dataLabel: LABEL });
const plainEvents = population.events.map(({ balance_before: _before, balance_after: _after, ...event }) => event);
const plainFit = estimateTwins(plainEvents, { dataLabel: LABEL });

function records(result) {
  const all = [];
  for (const twin of result.twins) {
    for (const name of TWIN_PARAMETER_NAMES) {
      if (name === 'stopHazard') for (const [bucket, record] of Object.entries(twin.parameters.stopHazard)) all.push([`stopHazard.${bucket}`, record, twin]);
      else all.push([name, twin.parameters[name], twin]);
    }
  }
  return all;
}

const START = Date.parse('2026-01-05T00:00:00.000Z');
function eventsFor(token) {
  let row = 0;
  return (minute, stake, result) => {
    row += 1;
    return {
      event_id: `${token}_${row}`,
      trader_token: token,
      occurred_at: new Date(START + minute * 60000).toISOString(),
      type: 'trade',
      venue_id: 'synthetic-test-venue',
      stake_amount: stake,
      realized_result: result,
      source_row_number: row
    };
  };
}

test('dataLabel is required, validated, and carried into every output', () => {
  assert.throws(() => estimateTwins(population.events), TypeError);
  assert.throws(() => estimateTwins(population.events, {}), RangeError);
  assert.throws(() => estimateTwins(population.events, { dataLabel: 'synthetic' }), RangeError);
  assert.throws(() => estimateTwins(population.events, { dataLabel: LABEL, seed: 1 }), RangeError);
  assert.throws(() => estimateTwins(population.events, { dataLabel: LABEL, behaviorOptions: { sessionGap: 5 } }), RangeError);
  assert.deepEqual(DATA_LABELS, ['SYNTHETIC', 'OBSERVATIONAL', 'CUSTOMER']);

  for (const label of DATA_LABELS) {
    const result = estimateTwins(population.events.slice(0, 400), { dataLabel: label });
    assert.equal(result.dataLabel, label);
    assert.equal(result.priors.dataLabel, label);
    assert.ok(result.twins.every((twin) => twin.dataLabel === label && twin.modelVersion === TWIN_MODEL_VERSION));
  }
  assert.equal(fit.modelVersion, 'twin-0.2.1');
  assert.equal(fit.behaviorVersion, 'behavior-0.2.0');
});

test('market and contract fields are never read, and event order does not matter', () => {
  const withMarkets = population.events.map((event, index) => ({
    ...event,
    market_id: `m${index % 7}`,
    market_type: index % 2 ? 'moneyline' : 'spread',
    side: 'back',
    price: 1.5 + (index % 5),
    quantity: 3
  }));
  assert.deepEqual(estimateTwins(withMarkets, { dataLabel: LABEL }), fit);
  assert.deepEqual(estimateTwins([...population.events].reverse(), { dataLabel: LABEL }), fit);
});

test('every parameter has a status, n, and weight, and an estimate inside its interval', () => {
  assert.deepEqual(TWIN_PARAMETER_NAMES, Object.keys(TWIN_PARAMETER_DEFINITIONS));
  for (const [name, record] of records(fit)) {
    assert.ok(PARAMETER_STATUSES.includes(record.status), name);
    assert.ok(Number.isInteger(record.n) && record.n >= 0, name);
    if (record.status === 'not_estimable') {
      assert.equal(record.estimate, null, name);
      assert.match(record.reason, /\w/, name);
      continue;
    }
    assert.ok(record.weight >= 0 && record.weight <= 1, name);
    assert.ok(record.interval[0] <= record.estimate && record.estimate <= record.interval[1], name);
    if (record.status === 'prior_only') assert.equal(record.weight, 0, name);
  }
  // With balances on every trade, no parameter in this population is not_estimable.
  assert.ok(records(fit).every(([, record]) => record.status !== 'not_estimable'));
});

test('shrinkage follows the documented conjugate formulas', () => {
  for (const [name, record] of records(fit)) {
    if (record.status !== 'estimated') continue;
    const w = record.weight;
    if (record.posterior.family === 'normal') {
      // Log scale: log estimate = w log raw + (1 - w) log prior.
      const expected = w * Math.log(record.raw) + (1 - w) * Math.log(record.priorEstimate);
      assert.ok(Math.abs(Math.log(record.estimate) - expected) < 1e-9, name);
    } else if (record.posterior.family === 'beta') {
      assert.ok(Math.abs(record.estimate - (w * record.raw + (1 - w) * record.priorEstimate)) < 1e-12, name);
      assert.ok(Math.abs(w - record.n / (record.posterior.a + record.posterior.b)) < 1e-12, name);
    } else {
      const gap = record.posterior.offsetMinutes;
      const expected = gap + w * (record.raw - gap) + (1 - w) * (record.priorEstimate - gap);
      assert.ok(Math.abs(record.estimate - expected) < 1e-6, name);
    }
  }
});

test('a trader with no observations gets exactly the population prior, with weight 0', () => {
  let checked = 0;
  for (const [name, record] of records(fit)) {
    if (record.status !== 'prior_only' || name.startsWith('stopHazard')) continue;
    const prior = fit.priors[name];
    assert.equal(record.estimate, prior.estimate, name);
    assert.deepEqual(record.interval, prior.interval, name);
    assert.equal(record.weight, 0, name);
    checked += 1;
  }
  assert.ok(checked > 0, 'some trader has a prior_only parameter');

  // One-session traders have no idle time between sessions.
  const short = generateBehavioralDataset({ seed: 32, mode: 'population', traderCount: 30, sessionsPerTrader: { min: 1, max: 3 } });
  const shortFit = estimateTwins(short.events, { dataLabel: LABEL });
  const single = shortFit.twins.filter((twin) => twin.inputs.sessionCount === 1);
  assert.ok(single.length > 0);
  for (const twin of single) {
    const record = twin.parameters.meanIdleMinutes;
    assert.equal(record.status, 'prior_only');
    assert.equal(record.estimate, shortFit.priors.meanIdleMinutes.estimate);
    assert.equal(record.weight, 0);
  }
});

test('a trader missing an input other traders have is not_estimable, with the prior as fallback', () => {
  const token = population.truth.traders[0].traderToken;
  const events = population.events.map((event) => (event.trader_token === token ? { ...event, realized_result: null } : event));
  const result = estimateTwins(events, { dataLabel: LABEL });
  const twin = result.twins.find((item) => item.traderToken === token);
  for (const name of ['baseStake', 'chaseCoefficient', 'escalationPerLoss', 'reentryLatencyAfterLoss', 'winRate', 'payoutMultiple', 'refuelProbability']) {
    const record = twin.parameters[name];
    assert.equal(record.status, 'not_estimable', name);
    assert.match(record.reason, /realized_result unavailable|baseStake/, name);
    assert.deepEqual(record.fallback, result.priors[name], name);
  }
  for (const record of Object.values(twin.parameters.stopHazard)) assert.equal(record.status, 'not_estimable');
  // Deposit size and idle time don't need outcomes.
  assert.equal(twin.parameters.depositSize.status, 'estimated');
  assert.equal(twin.parameters.meanIdleMinutes.status, 'estimated');
});

test('without balance fields: refuelProbability is not estimable, stopHazard is all-cause, and the proxy is labelled', () => {
  for (const twin of plainFit.twins) {
    assert.equal(twin.parameters.refuelProbability.status, 'not_estimable');
    assert.match(twin.parameters.refuelProbability.reason, /balance_before and balance_after unavailable/);
    assert.equal(twin.parameters.refuelProbability.fallback, null, 'no trader had balances, so there is no prior');
    assert.equal(twin.parameters.refuelAfterLosingStreak.proxyFor, 'refuelProbability');
    assert.equal(twin.stopHazardBasis, 'all-cause');
    assert.equal(twin.stopSample.includesForcedStops, true);
    assert.equal(twin.stopSample.leftOutUnaffordable, 0);
    for (const record of Object.values(twin.parameters.stopHazard)) {
      if (record.status !== 'not_estimable') assert.equal(record.includesForcedStops, true);
    }
  }
  assert.equal(plainFit.priors.refuelProbability, null);
  for (const twin of fit.twins) {
    assert.equal(twin.stopHazardBasis, 'voluntary');
    assert.equal(twin.stopSample.includesForcedStops, false);
  }
  // The voluntary sample leaves out trades the trader probably couldn't follow, and says how many.
  assert.ok(fit.twins.reduce((total, twin) => total + twin.stopSample.leftOutUnaffordable, 0) > 0);
});

test('bucket edges and the low-balance threshold use the estimated baseStake, not the median stake', () => {
  const observations = new Map(buildBehaviorObservations(plainEvents).map((record) => [record.traderToken, record]));
  let differs = 0;
  for (const twin of plainFit.twins) {
    const baseStake = twin.parameters.baseStake.estimate;
    const tally = (reference) => {
      const counts = {};
      for (const trade of observations.get(twin.traderToken).trades) {
        if (trade.running === null || trade.censored) continue;
        const bucket = drawdownBucket(trade.running, reference);
        counts[bucket] ??= { n: 0, stops: 0 };
        counts[bucket].n += 1;
        if (trade.endsSession) counts[bucket].stops += 1;
      }
      return counts;
    };
    const byBase = tally(baseStake);
    for (const [bucket, record] of Object.entries(twin.parameters.stopHazard)) {
      assert.equal(record.n, byBase[bucket]?.n ?? 0, `${twin.traderToken} ${bucket}`);
      assert.equal(record.stops, byBase[bucket]?.stops ?? 0, `${twin.traderToken} ${bucket}`);
    }
    if (JSON.stringify(tally(twin.inputs.medianStake)) !== JSON.stringify(byBase)) differs += 1;
  }
  assert.ok(differs > 0, 'median-stake edges would bucket some traders differently');

  for (const twin of fit.twins) {
    const record = twin.parameters.refuelProbability;
    const expected = DEFAULT_BEHAVIOR_OPTIONS.lowBalanceStakeMultiple * twin.parameters.baseStake.estimate;
    assert.equal(record.threshold, expected);
  }
});

test('within-session latency uses the median, which latencies clamped at the session gap do not move', () => {
  const trade = eventsFor('patient');
  // Latencies after a win: 2, 3, 4, 30, 30 minutes. A 30-minute gap stays in the session.
  const events = [trade(0, 10, 5), trade(2, 10, 5), trade(5, 10, 5), trade(9, 10, 5), trade(39, 10, 5), trade(69, 10, 5)];
  const result = estimateTwins(events, { dataLabel: LABEL });
  const record = result.twins[0].parameters.reentryLatencyAfterWin;
  assert.equal(record.n, 5);
  assert.ok(Math.abs(record.raw - 4) < 1e-9, `raw ${record.raw}`);
  assert.equal(result.twins[0].inputs.sessionCount, 1);
});

test('latencySpread is the pooled MAD around each side\'s median observation, which a cut-off latency does not move', () => {
  // Latencies after a win: 1, 2, 4, 8, and then 30 or 29 minutes. The median observation (4) is
  // left out; the rest deviate by log 4, log 2, log 2, and log(30 / 4) or log(29 / 4).
  const spreadFor = (last) => {
    const trade = eventsFor(`spread${last}`);
    const events = [trade(0, 10, 5), trade(1, 10, 5), trade(3, 10, 5), trade(7, 10, 5), trade(15, 10, 5), trade(15 + last, 10, 5)];
    return estimateTwins(events, { dataLabel: LABEL }).twins[0].parameters.latencySpread;
  };
  const expected = 1.4826 * (Math.log(2) + Math.log(4)) / 2;
  for (const last of [30, 29]) {
    const record = spreadFor(last);
    assert.equal(record.n, 4);
    assert.ok(Math.abs(record.raw - expected) < 1e-9, `raw ${record.raw}`);
    assert.equal(record.posterior.family, 'normal');
  }
  assert.ok(TWIN_PARAMETER_DEFINITIONS.latencySpread.requires.includes('realized_result'));
  assert.ok(TWIN_PARAMETER_DEFINITIONS.depositSpread.requires.includes('deposit_amount'));
});

test('depositSpread is the log-scale SD of deposit amounts, with the same shrinkage as stakeDispersion', () => {
  let checked = 0;
  for (const twin of fit.twins) {
    const record = twin.parameters.depositSpread;
    if (record.status !== 'estimated') continue;
    assert.equal(record.n, twin.parameters.depositSize.n);
    assert.ok(record.n >= 2);
    checked += 1;
  }
  assert.ok(checked > 0);
  assert.ok(fit.priors.depositSpread && fit.priors.latencySpread);
});

test('mean idle time is sessionGapMinutes plus the mean excess idle time', () => {
  const trade = eventsFor('idle');
  // Sessions end at minutes 10 and 120 and the next ones start at 110 and 320: idle 100 and 200.
  const events = [trade(0, 10, 5), trade(10, 10, -10), trade(110, 10, 5), trade(120, 10, 5), trade(320, 10, -10)];
  const record = estimateTwins(events, { dataLabel: LABEL }).twins[0].parameters.meanIdleMinutes;
  assert.equal(record.n, 2);
  assert.ok(Math.abs(record.raw - 150) < 1e-9);
  assert.equal(record.posterior.offsetMinutes, DEFAULT_BEHAVIOR_OPTIONS.sessionGapMinutes);
  assert.ok(record.interval[0] > DEFAULT_BEHAVIOR_OPTIONS.sessionGapMinutes);
});

test('a dataset with no realized outcomes marks every outcome-dependent parameter not estimable', () => {
  const bare = plainEvents.map(({ realized_result: _result, ...event }) => event);
  const result = estimateTwins(bare, { dataLabel: LABEL });
  for (const twin of result.twins) {
    for (const name of TWIN_PARAMETER_NAMES) {
      const needsOutcome = TWIN_PARAMETER_DEFINITIONS[name].requires.includes('realized_result');
      if (name === 'stopHazard') {
        for (const record of Object.values(twin.parameters.stopHazard)) assert.equal(record.status, 'not_estimable');
      } else if (needsOutcome) {
        assert.equal(twin.parameters[name].status, 'not_estimable', name);
        assert.equal(twin.parameters[name].fallback, null, `${name}: no trader had outcomes, so there is no prior`);
      } else {
        assert.notEqual(twin.parameters[name].status, 'not_estimable', name);
      }
    }
  }
  assert.equal(estimateTwins([], { dataLabel: LABEL }).twins.length, 0);
});

test('statistics helpers match known values', () => {
  const close = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} vs ${expected}`);
  close(digamma(1), -0.5772156649015329);
  close(trigamma(1), Math.PI ** 2 / 6);
  close(trigamma(0.5), Math.PI ** 2 / 2);
  close(gammaCdf(2, 3), 1 - Math.exp(-2) * 5);
  close(gammaQuantile(0.5, 1), Math.log(2));
  close(betaCdf(0.3, 2, 3), 0.3483);
  // Beta(2, 8) CDF at x is P(Binomial(9, x) >= 2).
  const x = betaQuantile(0.05, 2, 8);
  close(1 - (1 - x) ** 9 - 9 * x * (1 - x) ** 8, 0.05);
});
