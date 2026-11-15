import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GENERATOR_RULES,
  INTERVENTION_POINTS,
  NO_INTERVENTION,
  SIMULATION_DEFAULTS,
  SIMULATION_METRIC_NAMES,
  SIMULATOR_VERSION,
  TWIN_MODEL_VERSION,
  buildBehaviorObservations,
  buildSignals,
  buildTwins,
  estimateTwins,
  lastObservedBalances,
  metricsFromEvents,
  simulateBaseline,
  simulateTwin,
  simulateTwinV2
} from '../src/engine/index.mjs';
import { quantile, sum } from '../src/engine/stats.mjs';
import { ARCHETYPES, MODEL_CONSTANTS, generateBehavioralDataset } from '../src/synthetic/behavioral-generate.mjs';
import { truthFit, truthTwin } from '../src/synthetic/truth-twins.mjs';

// simulator-0.2.0 on SYNTHETIC data. Populations and replicate counts are small so the
// file runs in about a second: the default of 200 replicates is for real runs. The
// reproduce-training calibration is in test/simulation-calibration.test.mjs.

const LABEL = 'SYNTHETIC';
const population = generateBehavioralDataset({ seed: 41, mode: 'population', traderCount: 40, sessionsPerTrader: { min: 2, max: 120, scale: 'log' } });
const fit = estimateTwins(population.events, { dataLabel: LABEL });
const tokens = fit.twins.map((twin) => twin.traderToken);
const byHistory = [...fit.twins].sort((a, b) => a.inputs.sessionCount - b.inputs.sessionCount);
const longest = byHistory.at(-1).traderToken;
const archetypeData = generateBehavioralDataset({ seed: 42, mode: 'archetypes', sessionsPerTrader: 150 });
const archetypeTruth = truthFit(archetypeData);
const archetypeOf = Object.fromEntries(archetypeData.truth.traders.map((trader) => [trader.traderToken, trader.archetype]));

function byArchetype(result) {
  return Object.fromEntries(result.traders.map((trader) => [archetypeOf[trader.traderToken], trader.metrics]));
}

// A fit holding one point-mass twin with the given generator parameters.
function pointFit(overrides) {
  const parameters = { ...ARCHETYPES.steady.parameters, ...overrides, stopHazard: { ...ARCHETYPES.steady.parameters.stopHazard, ...overrides.stopHazard } };
  const twin = truthTwin({ traderToken: 'point_0001', parameters, sessionCount: 1 }, archetypeTruth.behaviorOptions);
  return { ...archetypeTruth, twins: [twin] };
}

test('every result carries the data label, versions, seed, replicate count, and assumptions', () => {
  const result = simulateTwinV2(fit, { replicates: 5, horizonDays: 7, traders: tokens.slice(0, 3) });
  assert.equal(result.dataLabel, LABEL);
  assert.equal(result.modelVersion, TWIN_MODEL_VERSION);
  assert.equal(result.modelVersion, 'twin-0.3.0');
  assert.equal(result.simulatorVersion, SIMULATOR_VERSION);
  assert.equal(result.seed, SIMULATION_DEFAULTS.seed);
  assert.equal(result.replicates, 5);
  assert.deepEqual(result.horizon, { days: 7 });
  assert.match(result.claim, /not a causal claim/i);
  assert.ok(result.assumptions.some((line) => /not a causal estimate/.test(line)));
  assert.ok(result.assumptions.some((line) => /independent across parameters/.test(line) && /shared stop propensity/.test(line)));
  assert.ok(result.assumptions.some((line) => /winRate \+ pushRate exceeds 1/.test(line)));
  assert.ok(result.assumptions.some((line) => /Generator rules used/.test(line)));
  assert.equal(result.traders.length, 3);
  for (const trader of result.traders) {
    assert.equal(trader.dataLabel, LABEL);
    assert.equal(trader.simulable, true);
    for (const pattern of [/^parameter sources/, /^starting balance/, /^stopBasis/, /^refuelTrigger/, /^loss ratio/]) {
      assert.ok(trader.assumptions.some((line) => pattern.test(line)), `${trader.traderToken}: ${pattern}`);
    }
    for (const name of SIMULATION_METRIC_NAMES) {
      const { median, p10, p90, n } = trader.metrics[name];
      if (n === 0) continue;
      assert.ok(p10 <= median && median <= p90, `${name}: ${p10} ${median} ${p90}`);
    }
    assert.ok(trader.metrics.trades.median > 0);
  }
  assert.equal(result.population.traders, 3);
  assert.equal(result.population.notSimulable, 0);
  assert.equal(result.population.metrics.trades.n, 5);
});

test('options and fits are validated', () => {
  assert.throws(() => simulateTwinV2(fit, { replicate: 3 }), /unknown option "replicate"/);
  assert.throws(() => simulateTwinV2(fit, { horizonDays: 7, sessions: 3 }), /not both/);
  assert.throws(() => simulateTwinV2(fit, { traders: ['nobody'] }), /not in the fit/);
  assert.throws(() => simulateTwinV2(fit, { traders: tokens.slice(0, 2), sessions: { [tokens[0]]: 3 } }), /no count/);
  assert.throws(() => simulateTwinV2(fit, { reseedStreams: { stake: 'x' } }), /unknown stream/);
  assert.throws(() => simulateTwinV2({ ...fit, modelVersion: 'twin-0.2.0' }), /twin-0.3.0/);
  assert.throws(() => simulateTwinV2({ ...fit, dataLabel: 'synthetic' }), /dataLabel/);
  assert.throws(() => simulateTwinV2([]), TypeError);
});

test('deterministic under a seed, and different under another', () => {
  const options = { replicates: 4, horizonDays: 10, traders: tokens.slice(0, 4), keepRuns: true };
  const first = simulateTwinV2(fit, options);
  assert.deepEqual(simulateTwinV2(fit, options), first);
  const other = simulateTwinV2(fit, { ...options, seed: 7 });
  assert.notDeepEqual(other.traders[0].metrics, first.traders[0].metrics);
  // Replicate r of a trader is seeded by stableSeed(`${seed}:${traderToken}:${r}`), so it
  // doesn't depend on which other traders are simulated.
  const alone = simulateTwinV2(fit, { ...options, traders: [tokens[2]] });
  assert.deepEqual(alone.traders[0], first.traders[2]);
});

test('common random numbers: re-seeding the stake-noise stream leaves outcomes, stop draws, and latencies identical', () => {
  const options = { traders: [longest], replicates: 3, sessions: 25, keepEvents: true };
  const base = simulateTwinV2(fit, options).traders[0].runs;
  const reseeded = simulateTwinV2(fit, { ...options, reseedStreams: { stakeNoise: 'alt' } }).traders[0].runs;
  let stakesDiffer = 0;
  base.forEach((run, replicate) => {
    const other = reseeded[replicate];
    assert.deepEqual(other.parameters, run.parameters, 'parameter draws are their own stream');
    const shared = Math.min(run.trace.length, other.trace.length);
    assert.ok(shared >= 50, `only ${shared} trades to compare`);
    for (let index = 0; index < shared; index += 1) {
      const a = run.trace[index];
      const b = other.trace[index];
      assert.equal(b.outcome, a.outcome, `trade ${index} outcome`);
      assert.equal(b.outcomeDraw, a.outcomeDraw);
      assert.equal(b.payoutDraw, a.payoutDraw);
      assert.equal(b.lossDraw, a.lossDraw);
      assert.equal(b.stopDraw, a.stopDraw, `trade ${index} stop draw`);
      assert.equal(b.latencySeconds, a.latencySeconds, `trade ${index} latency`);
      if (b.stakeCents !== a.stakeCents) stakesDiffer += 1;
    }
  });
  assert.ok(stakesDiffer > 0, 'the re-seeded stream changed the stakes');

  // The other way round: re-seeding outcomes changes outcomes, not the stake noise of the first stake.
  const outcomes = simulateTwinV2(fit, { ...options, reseedStreams: { outcomes: 'alt' } }).traders[0].runs;
  assert.equal(outcomes[0].trace[0].stakeCents, base[0].trace[0].stakeCents);
  assert.notDeepEqual(outcomes[0].trace.map((row) => row.outcome), base[0].trace.map((row) => row.outcome));
});

test('with uncertainty off, every run uses the twin\'s stored estimates exactly', () => {
  const result = simulateTwinV2(fit, { replicates: 3, sessions: 5, traders: tokens.slice(0, 5), uncertainty: false, keepRuns: true });
  for (const trader of result.traders) {
    const twin = fit.twins.find((item) => item.traderToken === trader.traderToken);
    for (const run of trader.runs) {
      const p = run.parameters;
      assert.equal(p.baseStake, twin.parameters.baseStake.estimate);
      assert.equal(p.stakeDispersion, twin.parameters.stakeDispersion.estimate);
      assert.equal(p.chaseCoefficient, twin.parameters.chaseCoefficient.estimate);
      assert.equal(p.escalationPerLoss, twin.parameters.escalationPerLoss.estimate);
      assert.equal(p.latencySpread, twin.parameters.latencySpread.estimate);
      assert.equal(p.depositSpread, twin.parameters.depositSpread.estimate);
      assert.equal(p.winRate, twin.parameters.winRate.estimate);
      assert.equal(p.meanIdleMinutes, twin.parameters.meanIdleMinutes.estimate);
      for (const [bucket, value] of Object.entries(p.stopHazard)) assert.equal(value, twin.parameters.stopHazard[bucket].estimate);
    }
  }
});

test('with point-mass posteriors, the simulator follows the twin\'s parameters exactly', () => {
  const pointed = pointFit({
    stakeNoise: 0,
    latencyNoise: 0,
    chaseCoefficient: 2,
    escalationPerLoss: 1.5,
    reentryLatencyAfterLoss: 3,
    reentryLatencyAfterWin: 7,
    stopHazard: { up: 0.15, flat: 0.15, down_small: 0.15, down_large: 1 },
    depositAmount: 400
  });
  const options = { replicates: 3, sessions: 40, keepEvents: true };
  const off = simulateTwinV2(pointed, { ...options, uncertainty: false });
  const on = simulateTwinV2(pointed, { ...options, uncertainty: true });
  // A point mass draws its own value, so uncertainty changes nothing.
  assert.deepEqual(on.traders[0].metrics, off.traders[0].metrics);
  assert.ok(Object.values(off.traders[0].parameterSources).every((source) => source === 'known value (point mass)'));

  let escalated = 0;
  let downLarge = 0;
  for (const run of off.traders[0].runs) {
    let previous = null;
    let lossRun = 0;
    let session = -1;
    for (const row of run.trace) {
      if (row.session !== session) {
        session = row.session;
        lossRun = 0;
      }
      let expected = 2000;
      if (previous === 'loss') expected *= 2;
      if (lossRun >= 2) {
        expected *= 1.5 ** (lossRun - 1);
        escalated += 1;
      }
      assert.equal(row.stakeCents, Math.round(expected));
      assert.equal(row.latencySeconds, (row.outcome === 'loss' ? 3 : 7) * 60);
      if (row.bucket === 'down_large') {
        assert.equal(row.ends, 'hazard', 'hazard 1 in down_large ends the session');
        downLarge += 1;
      }
      previous = row.outcome;
      lossRun = row.outcome === 'loss' ? lossRun + 1 : 0;
    }
    // Consecutive trades in a session are exactly one latency apart (deposits never move trades).
    const records = buildBehaviorObservations(run.events, pointed.behaviorOptions);
    const trades = records[0].trades;
    for (let index = 1; index < trades.length; index += 1) {
      if (trades[index].session !== trades[index - 1].session) continue;
      assert.equal((trades[index].t - trades[index - 1].t) / 1000, (trades[index - 1].outcome === 'loss' ? 3 : 7) * 60);
    }
  }
  assert.ok(escalated > 0 && downLarge > 0);
});

test('with uncertainty on, bands are wider, and wider still for low-history traders than for long-history ones', () => {
  const low = byHistory.slice(0, 6).map((twin) => twin.traderToken);
  const long = byHistory.slice(-6).map((twin) => twin.traderToken);
  assert.ok(byHistory[5].inputs.sessionCount <= 5 && byHistory.at(-6).inputs.sessionCount >= 50);
  // Same seed: the process streams are common, so only the parameter draws differ.
  const options = { replicates: 60, sessions: 20, traders: [...low, ...long] };
  const on = simulateTwinV2(fit, { ...options, uncertainty: true });
  const off = simulateTwinV2(fit, { ...options, uncertainty: false });
  const widening = (index, metric) => {
    const width = (trader) => trader.metrics[metric].p90 - trader.metrics[metric].p10;
    return width(on.traders[index]) / width(off.traders[index]);
  };
  const average = (values) => sum(values) / values.length;
  for (let index = 0; index < 12; index += 1) {
    assert.ok(widening(index, 'totalStake') > 1, `${options.traders[index]}: total stake band not wider`);
  }
  for (const metric of ['totalStake', 'meanStake']) {
    const lowWidening = average(low.map((_, index) => widening(index, metric)));
    const longWidening = average(long.map((_, index) => widening(index + 6, metric)));
    assert.ok(lowWidening > longWidening, `${metric}: low-history ${lowWidening} vs long-history ${longWidening}`);
  }
  assert.ok(average(low.map((_, index) => widening(index, 'meanStake'))) > 2);
});

test('archetypes from the truth: chaser vs shrinker, quits-when-down, and refueler vs steady', () => {
  const metrics = byArchetype(simulateTwinV2(archetypeTruth, { replicates: 40, sessions: 60, uncertainty: false }));
  const { chaser, shrinker, steady, refueler } = metrics;
  const quitter = metrics['quits-when-down'];
  assert.ok(chaser.chaseEpisodes.median > shrinker.chaseEpisodes.median);
  assert.ok(chaser.chaseEpisodes.p10 > chaser.chaseNoiseFloor.p90, 'chasing clears the noise floor');
  assert.ok(shrinker.chaseEpisodes.p90 <= shrinker.chaseNoiseFloor.median, 'a shrinker chases less than noise alone');
  assert.ok(chaser.maxSessionDrawdown.median > shrinker.maxSessionDrawdown.median);
  assert.ok(chaser.maxSessionDrawdownStakes.median > shrinker.maxSessionDrawdownStakes.median);
  assert.ok(chaser.medianSessionDrawdown.median > shrinker.medianSessionDrawdown.median);
  assert.ok(quitter.tradesPerSessionOnceDownLarge.p90 < steady.tradesPerSessionOnceDownLarge.p10, 'shorter sessions once down large');
  assert.ok(refueler.depositsAfterLoss.median > steady.depositsAfterLoss.p90);
  assert.ok(refueler.refuelDeposits.median > 0);
  assert.equal(steady.refuelDeposits.p90, 0, 'steady never refuels');
});

test('archetypes fitted from their events show the same directions', () => {
  const fitted = estimateTwins(archetypeData.events, { dataLabel: LABEL });
  const metrics = byArchetype(simulateTwinV2(fitted, { replicates: 40, sessions: 60 }));
  assert.ok(metrics.chaser.chaseEpisodes.median > metrics.shrinker.chaseEpisodes.median);
  assert.ok(metrics.chaser.maxSessionDrawdownStakes.median > metrics.shrinker.maxSessionDrawdownStakes.median);
  assert.ok(metrics['quits-when-down'].tradesPerSessionOnceDownLarge.median < metrics.steady.tradesPerSessionOnceDownLarge.median);
  assert.ok(metrics.refueler.depositsAfterLoss.median > metrics.steady.depositsAfterLoss.median);
});

test('in-run metrics match the same metrics computed from the run\'s events', () => {
  const result = simulateTwinV2(fit, { replicates: 2, horizonDays: 14, traders: [longest, ...tokens.slice(0, 3)], keepEvents: true });
  let compared = 0;
  for (const trader of result.traders) {
    for (const run of trader.runs) {
      const fromEvents = metricsFromEvents(run.events, { baseStakes: { [trader.traderToken]: run.parameters.baseStake }, behaviorOptions: fit.behaviorOptions })[trader.traderToken];
      if (!fromEvents) {
        assert.equal(run.metrics.trades, 0);
        continue;
      }
      for (const [name, value] of Object.entries(fromEvents)) {
        const simulated = run.metrics[name];
        if (value === null || simulated === null) assert.equal(simulated, value, name);
        else assert.ok(Math.abs(simulated - value) < 1e-6 * Math.max(1, Math.abs(value)), `${name}: ${simulated} vs ${value}`);
      }
      compared += 1;
    }
  }
  assert.ok(compared >= 6);
});

test('population aggregates sum each replicate across traders, then take percentiles', () => {
  const result = simulateTwinV2(fit, { replicates: 9, horizonDays: 7, traders: tokens.slice(0, 6), keepRuns: true });
  const totals = Array.from({ length: 9 }, (_, replicate) => sum(result.traders.map((trader) => trader.runs[replicate].metrics.totalStake)));
  const { metrics } = result.population;
  assert.ok(Math.abs(metrics.totalStake.median - quantile(totals, 0.5)) < 1e-6);
  assert.ok(Math.abs(metrics.totalStake.p10 - quantile(totals, 0.1)) < 1e-6);
  assert.ok(Math.abs(metrics.totalStake.p90 - quantile(totals, 0.9)) < 1e-6);
  const perSession = Array.from({ length: 9 }, (_, replicate) => {
    const runs = result.traders.map((trader) => trader.runs[replicate].metrics);
    return sum(runs.map((run) => run.trades)) / sum(runs.map((run) => run.sessions));
  });
  assert.ok(Math.abs(metrics.tradesPerSession.median - quantile(perSession, 0.5)) < 1e-9);
});

test('without balance fields: all-cause stops, the losing-streak refuel proxy, and forced stops still reported', () => {
  const plainEvents = population.events.map(({ balance_before: _before, balance_after: _after, ...event }) => event);
  const plainFit = estimateTwins(plainEvents, { dataLabel: LABEL });
  const result = simulateTwinV2(plainFit, { replicates: 8, sessions: 30 });
  assert.ok(result.population.traders > 30);
  let refuels = 0;
  for (const trader of result.traders.filter((item) => item.simulable)) {
    assert.equal(trader.stopBasis, 'all-cause');
    assert.equal(trader.refuelTrigger, 'losingStreak (proxy)');
    assert.ok(trader.assumptions.some((line) => /double-counted/.test(line)));
    assert.ok(trader.assumptions.some((line) => /Refuel behavior is proxied/.test(line)));
    assert.equal(trader.startingBalance.amount, 0);
    assert.equal(typeof trader.metrics.forcedStops.median, 'number');
    refuels += trader.metrics.refuelDeposits.mean;
  }
  assert.ok(refuels > 0, 'the proxy trigger refuels');
  assert.equal(typeof result.population.metrics.forcedStops.median, 'number');
});

test('a trader without balances in a dataset with balances uses the proxy, not the population refuel prior', () => {
  const token = tokens[3];
  const events = population.events.map((event) => {
    if (event.trader_token !== token) return event;
    const { balance_before: _before, balance_after: _after, ...rest } = event;
    return rest;
  });
  const mixed = estimateTwins(events, { dataLabel: LABEL });
  const twin = mixed.twins.find((item) => item.traderToken === token);
  assert.equal(twin.parameters.refuelProbability.status, 'not_estimable');
  assert.ok(twin.parameters.refuelProbability.fallback, 'a population fallback exists');
  const trader = simulateTwinV2(mixed, { replicates: 3, sessions: 10, traders: [token] }).traders[0];
  assert.equal(trader.refuelTrigger, 'losingStreak (proxy)');
  assert.equal(trader.stopBasis, 'all-cause');
  assert.equal(trader.parameterSources.refuelProbability, undefined);
  assert.ok(['posterior', 'trader prior (no own observations)'].includes(trader.parameterSources.refuelAfterLosingStreak));
});

test('a not-estimable parameter with a fallback draws from the population prior, and says so', () => {
  const token = tokens[5];
  const events = population.events.map((event) => (event.trader_token === token && event.type === 'trade' ? { ...event, stake_amount: null } : event));
  const mixed = estimateTwins(events, { dataLabel: LABEL });
  const trader = simulateTwinV2(mixed, { replicates: 3, sessions: 10, traders: [token] }).traders[0];
  assert.equal(trader.simulable, true);
  for (const name of ['baseStake', 'stakeDispersion', 'chaseCoefficient', 'stopHazard.down_large']) {
    assert.equal(trader.parameterSources[name], 'population prior, not this trader', name);
  }
  assert.equal(trader.parameterSources.winRate, 'posterior');
  assert.ok(trader.assumptions.some((line) => /population prior, not this trader: baseStake/.test(line)));
});

test('with no deposit amounts anywhere, the money model is switched off and its metrics are unavailable, not zero', () => {
  const noDeposits = population.events
    .filter((event) => event.type !== 'deposit')
    .map(({ balance_before: _before, balance_after: _after, ...event }) => event);
  const bareFit = estimateTwins(noDeposits, { dataLabel: LABEL });
  for (const twin of bareFit.twins) {
    assert.equal(twin.parameters.depositSize.status, 'not_estimable');
    assert.equal(twin.parameters.depositSize.fallback, null, 'no trader had deposits, so there is no prior');
  }
  const result = simulateTwinV2(bareFit, { replicates: 3, sessions: 10 });
  assert.ok(result.population.traders > 30);
  for (const trader of result.traders.filter((item) => item.simulable)) {
    assert.equal(trader.mechanisms.money.simulated, false);
    assert.equal(trader.refuelTrigger, 'none');
    assert.ok(trader.assumptions.some((line) => /^money not simulated/.test(line)));
    for (const name of ['deposits', 'depositsAfterLoss', 'forcedStops', 'refuelDeposits']) {
      assert.equal(trader.metrics[name].median, null, name);
      assert.equal(trader.metrics[name].n, 0, name);
    }
    assert.ok(trader.metrics.trades.median > 0);
  }
  assert.equal(result.population.metrics.deposits.median, null);
});

test('a trader whose outcomes are all missing is not simulable, with reasons', () => {
  const token = tokens[1];
  const events = population.events.map((event) => (event.trader_token === token ? { ...event, realized_result: null } : event));
  const mixed = simulateTwinV2(estimateTwins(events, { dataLabel: LABEL }), { replicates: 2, sessions: 3 });
  const trader = mixed.traders.find((item) => item.traderToken === token);
  assert.equal(trader.simulable, false);
  assert.equal(trader.metrics, undefined);
  assert.ok(trader.reasons.some((reason) => /no realized outcome/.test(reason)));
  assert.equal(mixed.population.notSimulable, 1);
  assert.equal(mixed.population.traders, tokens.length - 1);

  // With no outcomes anywhere there is no fallback either: the core mechanisms can't be simulated.
  const bare = population.events.map(({ realized_result: _result, balance_before: _before, balance_after: _after, ...event }) => event);
  const none = simulateTwinV2(estimateTwins(bare, { dataLabel: LABEL }), { replicates: 2, sessions: 3 });
  assert.equal(none.population.traders, 0);
  for (const item of none.traders) {
    assert.equal(item.simulable, false);
    for (const mechanism of ['stake', 'outcomes', 'latency']) {
      assert.ok(item.reasons.some((reason) => reason.startsWith(`the ${mechanism} mechanism can't be simulated`)), `${item.traderToken}: ${mechanism}`);
    }
  }
  assert.equal(none.population.metrics.trades.median, null);
});

test('starting balance: the last observed balance_after when supplied, otherwise 0 with the session-start rule', () => {
  const balances = lastObservedBalances(population.events);
  assert.equal(Object.keys(balances).length, tokens.length);
  const lastEvent = population.events.filter((event) => event.trader_token === tokens[0]).at(-1);
  assert.equal(balances[tokens[0]], lastEvent.balance_after);
  const result = simulateTwinV2(fit, { replicates: 1, sessions: 2, traders: tokens.slice(0, 2), startingBalances: { [tokens[0]]: balances[tokens[0]] }, keepEvents: true });
  const [supplied, missing] = result.traders;
  assert.match(supplied.startingBalance.rule, /last observed balance_after/);
  assert.equal(supplied.runs[0].events[0].balance_before, balances[tokens[0]]);
  assert.match(missing.startingBalance.rule, /^0, with the session-start deposit rule/);
  assert.equal(missing.runs[0].events[0].type, 'deposit', 'a zero balance starts with a deposit');
});

test('the horizon is a number of days from the start, or a fixed session count', () => {
  const start = '2026-06-01T00:00:00.000Z';
  const result = simulateTwinV2(fit, { replicates: 2, horizonDays: 5, start, traders: tokens.slice(0, 4), keepEvents: true });
  const end = Date.parse(start) + 5 * 86400000;
  for (const trader of result.traders) {
    for (const run of trader.runs) {
      for (const session of buildBehaviorObservations(run.events, fit.behaviorOptions)[0]?.sessions ?? []) {
        assert.ok(session.start >= Date.parse(start) && session.start < end);
      }
    }
  }
  const fixed = simulateTwinV2(fit, { replicates: 3, sessions: 7, traders: tokens.slice(0, 4) });
  for (const trader of fixed.traders) assert.equal(trader.metrics.sessions.p90, 7);
});

test('a drawn winRate + pushRate above 1 is renormalized and counted', () => {
  const result = simulateTwinV2(pointFit({ winProbability: 0.7, pushProbability: 0.5 }), { replicates: 4, sessions: 20 });
  const trader = result.traders[0];
  assert.equal(trader.renormalizedRuns, 4);
  assert.ok(Math.abs(trader.metrics.winShare.median - 0.7 / 1.2) < 0.1);
  assert.equal(trader.metrics.losses.p90, 0);
});

test('generator rules match the behavioral generator\'s constants', () => {
  assert.deepEqual(GENERATOR_RULES.firstTradeDelaySeconds, MODEL_CONSTANTS.firstTradeDelaySeconds);
  assert.equal(GENERATOR_RULES.minLatencySeconds, MODEL_CONSTANTS.minLatencySeconds);
  assert.equal(GENERATOR_RULES.minRefuelDelaySeconds, MODEL_CONSTANTS.minRefuelDelaySeconds);
});

test('the intervention hook exists and does nothing: no policy in this prompt', () => {
  assert.deepEqual(INTERVENTION_POINTS, ['beforeStake', 'beforeDeposit', 'afterTrade']);
  const proposal = { stakeCents: 1234 };
  for (const point of INTERVENTION_POINTS) assert.equal(NO_INTERVENTION(point, proposal, {}), proposal);
  assert.equal(Object.hasOwn(SIMULATION_DEFAULTS, 'intervention'), false);
  assert.equal(Object.hasOwn(SIMULATION_DEFAULTS, 'policy'), false);
});

test('the old simulateTwin is kept and labelled baseline-0.1', () => {
  const [twin] = buildTwins(buildSignals(population.events.slice(0, 400)));
  const labelled = simulateBaseline(twin, { seed: 3 });
  assert.equal(labelled.simulatorVersion, 'baseline-0.1');
  const { simulatorVersion: _version, ...rest } = labelled;
  assert.deepEqual(rest, simulateTwin(twin, { seed: 3 }));
});
