import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ARCHETYPES,
  ARCHETYPE_NAMES,
  BEHAVIORAL_GENERATOR_VERSION,
  POPULATION_DISTRIBUTIONS,
  generateBehavioralDataset
} from '../src/synthetic/behavioral-generate.mjs';
import { writeBehavioralDataset } from '../src/synthetic/behavioral-write.mjs';
import {
  BEHAVIOR_VERSION,
  DEFAULT_BEHAVIOR_OPTIONS,
  buildBehaviorSignals,
  validateEvents
} from '../src/engine/index.mjs';

// Everything here is SYNTHETIC. The archetype tests check the direction of each
// effect in the behavior-0.2.0 signals, not exact recovery. Signal 1 divides by a
// rolling median stake, and the stop buckets use the observed median stake rather
// than baseStake, so the signals don't equal the true parameters. Recovery is the
// twin-0.2.0 estimator's job (Prompt 3).
//
// Thresholds were checked on 40 seeds at 250 sessions per trader. Worst cases:
// steady |loss minus win| 0.037, steady |escalation - 1| 0.02, quits-when-down
// down_large minus up 0.45, refueler minus steady low-balance refuel 0.77, refueler
// minus steady losing-streak refuel 0.12, steady low-balance triggers n = 7.

const SEED = 20260302;
const SESSIONS = 250;
const MIN_N = DEFAULT_BEHAVIOR_OPTIONS.minSampleSize;
// Steady has no outcome dependence. Its loss-minus-win stake ratio and its
// escalation multiplier minus 1 must both be within this of zero.
const STEADY_TOLERANCE = 0.1;
// Steady's median latency is 5 minutes after both outcomes.
const STEADY_LATENCY_TOLERANCE_MINUTES = 1;

const ALLOWED_FIELDS = new Set([
  'event_id',
  'trader_token',
  'occurred_at',
  'type',
  'venue_id',
  'stake_amount',
  'realized_result',
  'deposit_amount',
  'balance_before',
  'balance_after',
  'source_row_number'
]);
const BALANCE_FIELDS = ['balance_before', 'balance_after'];

const cents = (value) => Math.round(value * 100);

function withoutFields(event, fields) {
  const copy = { ...event };
  for (const field of fields) delete copy[field];
  return copy;
}

function archetypeRun(options = {}) {
  const dataset = generateBehavioralDataset({ seed: SEED, sessionsPerTrader: SESSIONS, ...options });
  const signals = buildBehaviorSignals(dataset.events);
  const byArchetype = {};
  for (const truth of dataset.truth.traders) {
    byArchetype[truth.archetype] = { truth, signals: signals.find((record) => record.traderToken === truth.traderToken) };
  }
  return { dataset, signals, byArchetype };
}

const withBalances = archetypeRun();
const withoutBalances = archetypeRun({ includeBalances: false });

// A signal value the test relies on: it must be computed (n at or above the default minimum).
function measured(signal, label) {
  assert.ok(signal.n >= MIN_N, `${label}: n=${signal.n} is below the default minimum ${MIN_N}`);
  assert.notEqual(signal.value, null, `${label}: ${signal.reason}`);
  return signal.value;
}

function assertClose(actual, expected, tolerance, label) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} +/- ${tolerance}, got ${actual}`);
}

test('same seed gives identical output, and a different seed does not', () => {
  for (const options of [
    { seed: 7, sessionsPerTrader: 20 },
    { seed: 7, mode: 'population', traderCount: 12, sessionsPerTrader: { min: 5, max: 15 }, missingOutcomeShare: 0.1 },
    { seed: 7, includeBalances: false, sessionsPerTrader: 20 }
  ]) {
    const first = generateBehavioralDataset(options);
    assert.deepEqual(generateBehavioralDataset(options), first);
    assert.notDeepEqual(generateBehavioralDataset({ ...options, seed: 8 }).events, first.events);
  }

  // Each trader has its own random streams, so adding traders doesn't change existing ones.
  const small = generateBehavioralDataset({ seed: 7, mode: 'population', traderCount: 5, sessionsPerTrader: 10 });
  const large = generateBehavioralDataset({ seed: 7, mode: 'population', traderCount: 9, sessionsPerTrader: 10 });
  assert.deepEqual(large.truth.traders.slice(0, 5), small.truth.traders);
});

test('events match the analytical event schema and pass validateEvents', () => {
  const { events } = withBalances.dataset;
  const quality = validateEvents(events);
  assert.equal(quality.valid, true, quality.errors.join('\n'));
  assert.equal(quality.stats.traderCount, ARCHETYPE_NAMES.length);

  assert.equal(new Set(events.map((event) => event.event_id)).size, events.length);
  events.forEach((event, index) => {
    assert.equal(event.source_row_number, index + 1);
    if (index) assert.ok(event.occurred_at >= events[index - 1].occurred_at, 'events are in time order');
    for (const field of Object.keys(event)) assert.ok(ALLOWED_FIELDS.has(field), `unexpected field ${field}`);
    assert.ok(['trade', 'deposit'].includes(event.type));
    assert.equal(event.venue_id, 'synthetic-venue-001');
    if (event.type === 'trade') {
      assert.ok(event.stake_amount > 0);
      assert.ok(Number.isFinite(event.realized_result));
      assert.equal(event.deposit_amount, undefined);
    } else {
      assert.ok(event.deposit_amount > 0);
      assert.equal(event.stake_amount, undefined);
    }
    for (const field of ['stake_amount', 'realized_result', 'deposit_amount', ...BALANCE_FIELDS]) {
      if (event[field] !== undefined) assert.equal(cents(event[field]) / 100, event[field], `${field} is in whole cents`);
    }
  });
});

test('balances: a trade moves the balance by its realized result, a deposit by its amount, and balances chain', () => {
  const lastBalance = new Map();
  for (const event of withBalances.dataset.events) {
    const change = cents(event.balance_after) - cents(event.balance_before);
    if (event.type === 'trade') {
      assert.equal(change, cents(event.realized_result));
      assert.ok(cents(event.stake_amount) <= cents(event.balance_before), 'never stakes more than the balance');
    } else {
      assert.equal(change, cents(event.deposit_amount));
    }
    assert.ok(event.balance_after >= 0);
    assert.equal(cents(event.balance_before), lastBalance.get(event.trader_token) ?? 0);
    lastBalance.set(event.trader_token, cents(event.balance_after));
  }
  for (const { truth } of Object.values(withBalances.byArchetype)) {
    assert.equal(lastBalance.get(truth.traderToken), cents(truth.realized.finalBalance));
  }
});

test('balance-free mode leaves out only the balance fields', () => {
  const plain = withoutBalances.dataset.events;
  assert.ok(plain.every((event) => BALANCE_FIELDS.every((field) => !(field in event))));
  assert.deepEqual(plain, withBalances.dataset.events.map((event) => withoutFields(event, BALANCE_FIELDS)));
  assert.deepEqual(withoutBalances.dataset.truth.traders, withBalances.dataset.truth.traders);
  assert.equal(validateEvents(plain).valid, true);
});

test('missingOutcomeShare blanks realized_result on that share of trades and leaves everything else alone', () => {
  const blanked = generateBehavioralDataset({ seed: SEED, sessionsPerTrader: SESSIONS, missingOutcomeShare: 0.2 });
  const fewer = generateBehavioralDataset({ seed: SEED, sessionsPerTrader: SESSIONS, missingOutcomeShare: 0.1 });
  const full = withBalances.dataset.events;
  const trades = full.filter((event) => event.type === 'trade').length;
  const blankIds = (events) => new Set(events.filter((event) => event.type === 'trade' && event.realized_result === null).map((event) => event.event_id));

  const missing = blankIds(blanked.events);
  assertClose(missing.size / trades, 0.2, 0.03, 'blanked share');
  for (const id of blankIds(fewer.events)) assert.ok(missing.has(id), 'a larger share blanks a superset of trades');
  assert.equal(
    blanked.truth.traders.reduce((total, trader) => total + trader.realized.blankedOutcomes, 0),
    missing.size
  );

  // Only realized_result changes. Balances still carry the true result.
  assert.deepEqual(
    blanked.events.map((event) => withoutFields(event, ['realized_result'])),
    full.map((event) => withoutFields(event, ['realized_result']))
  );
  blanked.events.forEach((event, index) => {
    if (!missing.has(event.event_id)) assert.equal(event.realized_result, full[index].realized_result);
  });
  assert.equal(validateEvents(blanked.events).valid, true);

  const signals = buildBehaviorSignals(blanked.events);
  assert.equal(signals.reduce((total, record) => total + record.inputs.tradesMissingOutcome, 0), missing.size);
});

test('the signals see the sessions, trades, deposits, and stops the generator created', () => {
  const population = generateBehavioralDataset({ seed: 3, mode: 'population', traderCount: 30, sessionsPerTrader: 30 });
  const custom = generateBehavioralDataset({
    seed: 4,
    sessionsPerTrader: 40,
    behaviorOptions: { sessionGapMinutes: 15, refuelWindowMinutes: 45 }
  });
  const runs = [
    [withBalances.dataset, {}],
    [withoutBalances.dataset, {}],
    [population, {}],
    [custom, { sessionGapMinutes: 15, refuelWindowMinutes: 45 }]
  ];
  for (const [dataset, options] of runs) {
    const signals = buildBehaviorSignals(dataset.events, options);
    assert.equal(signals.length, dataset.truth.traders.length);
    for (const truth of dataset.truth.traders) {
      const record = signals.find((item) => item.traderToken === truth.traderToken);
      const { realized } = truth;
      assert.equal(record.inputs.sessionCount, realized.sessions, truth.traderToken);
      assert.equal(record.inputs.sessionCount, truth.sessionCount, truth.traderToken);
      assert.equal(record.inputs.tradeCount, realized.trades, truth.traderToken);
      assert.equal(record.inputs.depositCount, realized.deposits.sessionStart + realized.deposits.refuel, truth.traderToken);

      // Every session ends in exactly one recorded stop. The signals count each of
      // them as a stop, except the last session in the data, which they may censor.
      const sum = (counts) => Object.values(counts).reduce((total, value) => total + value, 0);
      const truthStops = sum(realized.stops.hazard) + sum(realized.stops.forced) + realized.stops.sessionCap;
      assert.equal(truthStops, realized.sessions, truth.traderToken);
      const { buckets, excluded } = record.stopBehavior;
      assert.equal(sum(Object.fromEntries(Object.entries(buckets).map(([key, bucket]) => [key, bucket.stops]))) + excluded.censored, truthStops);
    }
  }
});

test('truth records the label, versions, seed, options, and each trader\'s true parameters and archetype', () => {
  const { truth } = withBalances.dataset;
  assert.equal(truth.label, 'SYNTHETIC');
  assert.equal(truth.generatorVersion, BEHAVIORAL_GENERATOR_VERSION);
  assert.equal(truth.behaviorVersion, BEHAVIOR_VERSION);
  assert.equal(truth.seed, SEED);
  assert.equal(truth.options.sessionsPerTrader, SESSIONS);
  assert.equal(truth.options.includeBalances, true);
  assert.equal(truth.options.missingOutcomeShare, 0);
  for (const key of ['sessionGapMinutes', 'refuelWindowMinutes', 'lowBalanceStakeMultiple', 'flatBandStakes', 'largeDrawdownStakes']) {
    assert.equal(truth.options.behaviorOptions[key], DEFAULT_BEHAVIOR_OPTIONS[key], key);
  }
  assert.equal(truth.populationDistributions, null);
  assert.equal(truth.eventCount, withBalances.dataset.events.length);
  assert.deepEqual(truth.traders.map((trader) => trader.archetype), ARCHETYPE_NAMES);
  for (const trader of truth.traders) {
    assert.deepEqual(trader.parameters, ARCHETYPES[trader.archetype].parameters);
    assert.equal(trader.sessionCount, SESSIONS);
  }
});

test('each archetype has enough history for every signal it is tested on', () => {
  const required = {
    steady: [
      ['postOutcomeStake', (record) => record.postOutcomeStake.lossMinusWin],
      ['escalation', (record) => record.escalation],
      ['latency after loss', (record) => record.reentryLatency.withinSession.afterLoss],
      ['latency after win', (record) => record.reentryLatency.withinSession.afterWin],
      ['stop up', (record) => record.stopBehavior.buckets.up],
      ['stop down_large', (record) => record.stopBehavior.buckets.down_large],
      ['refuel lowBalance', (record) => record.refuel.lowBalance]
    ],
    chaser: [
      ['postOutcomeStake', (record) => record.postOutcomeStake.lossMinusWin],
      ['escalation', (record) => record.escalation],
      ['latency', (record) => record.reentryLatency.withinSession.lossMinusWin]
    ],
    shrinker: [
      ['postOutcomeStake', (record) => record.postOutcomeStake.lossMinusWin],
      ['escalation', (record) => record.escalation],
      ['latency', (record) => record.reentryLatency.withinSession.lossMinusWin]
    ],
    'quits-when-down': [
      ['stop up', (record) => record.stopBehavior.buckets.up],
      ['stop down_large', (record) => record.stopBehavior.buckets.down_large]
    ],
    refueler: [['refuel lowBalance', (record) => record.refuel.lowBalance]]
  };
  for (const [archetype, signals] of Object.entries(required)) {
    for (const [label, pick] of signals) measured(pick(withBalances.byArchetype[archetype].signals), `${archetype} ${label}`);
  }
  for (const archetype of ['steady', 'refueler']) {
    measured(withoutBalances.byArchetype[archetype].signals.refuel.losingStreak, `${archetype} refuel losingStreak (no balances)`);
  }
});

test('chaser: bets more after a loss, escalates through a losing run, and comes back faster', () => {
  const { truth, signals } = withBalances.byArchetype.chaser;
  assert.ok(truth.parameters.chaseCoefficient > 1 && truth.parameters.escalationPerLoss > 1);

  assert.ok(measured(signals.postOutcomeStake.lossMinusWin, 'chaser lossMinusWin') > 0);
  assert.ok(signals.postOutcomeStake.lossMinusWin.logRatioDifference > 0);
  assert.ok(measured(signals.postOutcomeStake.afterLoss, 'chaser afterLoss') > 1);
  assert.ok(measured(signals.escalation, 'chaser escalation') > 1);
  assert.ok(measured(signals.reentryLatency.withinSession.lossMinusWin, 'chaser latency') < 0);
});

test('shrinker: bets less after a loss, scales down through a losing run, and waits longer', () => {
  const { truth, signals } = withBalances.byArchetype.shrinker;
  assert.ok(truth.parameters.chaseCoefficient < 1 && truth.parameters.escalationPerLoss < 1);

  assert.ok(measured(signals.postOutcomeStake.lossMinusWin, 'shrinker lossMinusWin') < 0);
  assert.ok(signals.postOutcomeStake.lossMinusWin.logRatioDifference < 0);
  assert.ok(measured(signals.postOutcomeStake.afterLoss, 'shrinker afterLoss') < 1);
  assert.ok(measured(signals.escalation, 'shrinker escalation') < 1);
  assert.ok(measured(signals.reentryLatency.withinSession.lossMinusWin, 'shrinker latency') > 0);
});

test(`steady: stake and latency don't depend on the last outcome (tolerance ${STEADY_TOLERANCE})`, () => {
  const { signals } = withBalances.byArchetype.steady;
  assertClose(measured(signals.postOutcomeStake.lossMinusWin, 'steady lossMinusWin'), 0, STEADY_TOLERANCE, 'steady loss minus win');
  assertClose(measured(signals.escalation, 'steady escalation'), 1, STEADY_TOLERANCE, 'steady escalation');
  assertClose(
    measured(signals.reentryLatency.withinSession.lossMinusWin, 'steady latency'),
    0,
    STEADY_LATENCY_TOLERANCE_MINUTES,
    'steady latency loss minus win (minutes)'
  );
});

test('quits-when-down: the down_large stop rate is well above the up stop rate', () => {
  const stopGap = (archetype) => {
    const { buckets } = withBalances.byArchetype[archetype].signals.stopBehavior;
    return measured(buckets.down_large, `${archetype} down_large`) - measured(buckets.up, `${archetype} up`);
  };
  const quitterGap = stopGap('quits-when-down');
  assert.ok(quitterGap >= 0.3, `down_large minus up stop rate: ${quitterGap}`);
  // Steady's hazard is flat, so its gap comes only from forced stops and noise.
  assert.ok(quitterGap - stopGap('steady') >= 0.25);
});

test('refueler: refuels after a low balance far more often than steady, with and without balance fields', () => {
  const refueler = withBalances.byArchetype.refueler.signals.refuel;
  const steady = withBalances.byArchetype.steady.signals.refuel;
  assert.equal(refueler.primary, 'lowBalance');
  assert.equal(steady.primary, 'lowBalance');
  const lowBalanceGap = measured(refueler.lowBalance, 'refueler lowBalance') - measured(steady.lowBalance, 'steady lowBalance');
  assert.ok(lowBalanceGap >= 0.5, `low-balance refuel gap: ${lowBalanceGap}`);

  // Without balances, signal 5 falls back to the losing-streak trigger, which still separates them.
  const refuelerPlain = withoutBalances.byArchetype.refueler.signals.refuel;
  const steadyPlain = withoutBalances.byArchetype.steady.signals.refuel;
  assert.equal(refuelerPlain.primary, 'losingStreak');
  assert.equal(steadyPlain.primary, 'losingStreak');
  assert.equal(refuelerPlain.lowBalance.value, null);
  assert.match(refuelerPlain.lowBalance.reason, /balance_before and balance_after unavailable/);
  const streakGap = measured(refuelerPlain.losingStreak, 'refueler losingStreak') - measured(steadyPlain.losingStreak, 'steady losingStreak');
  assert.ok(streakGap >= 0.1, `losing-streak refuel gap: ${streakGap}`);
});

test('session drawdown is the same with and without balance fields, from different sources', () => {
  for (const archetype of ARCHETYPE_NAMES) {
    const balance = withBalances.byArchetype[archetype].signals.sessionDrawdown;
    const realized = withoutBalances.byArchetype[archetype].signals.sessionDrawdown;
    assert.equal(balance.n, SESSIONS, archetype);
    assert.equal(realized.n, balance.n, archetype);
    for (const field of ['value', 'valueInStakes', 'worst']) {
      assertClose(realized[field], balance[field], 1e-9, `${archetype} ${field}`);
    }
    assert.deepEqual(balance.sources, { balance: SESSIONS, realized_result: 0 }, archetype);
    assert.deepEqual(realized.sources, { balance: 0, realized_result: SESSIONS }, archetype);
  }
});

test('forced stops are recorded separately from hazard stops in the truth', () => {
  const { realized } = withBalances.byArchetype.chaser.truth;
  const forced = Object.values(realized.stops.forced).reduce((total, value) => total + value, 0);
  // The chaser's big post-loss stakes run out of money, mostly deep in a drawdown.
  assert.ok(forced > 0);
  assert.ok(realized.stops.forced.down_large >= realized.stops.forced.up);
  for (const bucket of Object.keys(realized.stops.hazard)) {
    assert.ok(realized.stops.hazard[bucket] + realized.stops.forced[bucket] <= realized.tradesByBucket[bucket]);
  }
});

test('population mode: parameters come from the documented distributions, with chasers and shrinkers', () => {
  const { truth } = generateBehavioralDataset({ seed: 11, mode: 'population', traderCount: 300, sessionsPerTrader: { min: 2, max: 4 } });
  assert.deepEqual(truth.populationDistributions, POPULATION_DISTRIBUTIONS);
  assert.ok(truth.traders.every((trader) => trader.archetype === 'population'));

  const chase = truth.traders.map((trader) => trader.parameters.chaseCoefficient).sort((a, b) => a - b);
  const share = (predicate) => chase.filter(predicate).length / chase.length;
  assert.ok(share((value) => value > 1.1) >= 0.2, 'chasers appear');
  assert.ok(share((value) => value < 0.9) >= 0.2, 'shrinkers appear');
  const median = chase[Math.floor(chase.length / 2)];
  assert.ok(median >= 0.85 && median <= 1, `median chase coefficient ${median}`);

  for (const trader of truth.traders) {
    const p = trader.parameters;
    const within = (key, value) => {
      const { min, max } = POPULATION_DISTRIBUTIONS[key];
      assert.ok(value >= min && value <= max, `${key} = ${value}`);
    };
    for (const key of ['baseStake', 'stakeNoise', 'chaseCoefficient', 'escalationPerLoss', 'reentryLatencyAfterWin', 'refuelProbability', 'winProbability']) {
      within(key, p[key]);
    }
    for (const hazard of Object.values(p.stopHazard)) assert.ok(hazard >= 0.01 && hazard <= 0.95);
    assert.ok(trader.sessionCount >= 2 && trader.sessionCount <= 4);
  }
});

test('population mode: enough sessions per trader gives every trader 20+ loss episodes', () => {
  const { events, truth } = generateBehavioralDataset({ seed: 12, mode: 'population', traderCount: 40, sessionsPerTrader: 60 });
  assert.equal(validateEvents(events).valid, true);
  for (const record of buildBehaviorSignals(events)) {
    const trader = truth.traders.find((item) => item.traderToken === record.traderToken);
    assert.ok(trader.realized.chaseEpisodes >= 20, `${trader.traderToken}: ${trader.realized.chaseEpisodes} chase episodes`);
    assert.ok(record.postOutcomeStake.afterLoss.n >= 20, `${trader.traderToken}: afterLoss n=${record.postOutcomeStake.afterLoss.n}`);
  }
});

test('custom traders override archetype parameters, and invalid input is rejected', () => {
  const { truth } = generateBehavioralDataset({
    mode: 'custom',
    sessionsPerTrader: 5,
    traders: [
      { archetype: 'chaser', parameters: { chaseCoefficient: 2.5, stopHazard: { down_large: 0.9 } } },
      { parameters: { baseStake: 50 } }
    ]
  });
  const [chaser, custom] = truth.traders;
  assert.equal(chaser.archetype, 'chaser');
  assert.deepEqual(chaser.overrides, ['chaseCoefficient', 'stopHazard']);
  assert.equal(chaser.parameters.chaseCoefficient, 2.5);
  assert.equal(chaser.parameters.escalationPerLoss, ARCHETYPES.chaser.parameters.escalationPerLoss);
  assert.deepEqual(chaser.parameters.stopHazard, { ...ARCHETYPES.chaser.parameters.stopHazard, down_large: 0.9 });
  assert.equal(custom.archetype, 'custom');
  assert.deepEqual(custom.parameters, { ...ARCHETYPES.steady.parameters, baseStake: 50 });

  const rejects = (options) => assert.throws(() => generateBehavioralDataset(options), RangeError);
  rejects({ sessionsPerTrader: 0 });
  rejects({ sessionsPerTrader: { min: 5, max: 2 } });
  rejects({ archetypes: ['gambler'] });
  rejects({ sessionCount: 10 });
  rejects({ missingOutcomeShare: 1.5 });
  rejects({ name: '../escape' });
  rejects({ behaviorOptions: { minSampleSize: 3 } });
  rejects({ mode: 'custom', traders: [] });
  rejects({ mode: 'custom', traders: [{ parameters: { chaseCoeficient: 2 } }] });
  rejects({ mode: 'custom', traders: [{ parameters: { winProbability: 0.7, pushProbability: 0.4 } }] });
  rejects({ mode: 'custom', traders: [{ parameters: { stopHazard: { down_big: 0.5 } } }] });
});

test('writer puts SYNTHETIC events and truth files in the directory it is given', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'playmind-behavioral-'));
  try {
    const dataset = generateBehavioralDataset({ seed: 5, name: 'archetypes-small', sessionsPerTrader: 10, includeBalances: false });
    const { eventsPath, truthPath } = await writeBehavioralDataset(dataset, join(directory, 'out'));
    assert.deepEqual((await readdir(join(directory, 'out'))).sort(), ['archetypes-small.events.json', 'archetypes-small.truth.json']);
    assert.equal(eventsPath, join(directory, 'out', 'archetypes-small.events.json'));

    const eventsFile = JSON.parse(await readFile(eventsPath, 'utf8'));
    const truthFile = JSON.parse(await readFile(truthPath, 'utf8'));
    for (const file of [eventsFile, truthFile]) {
      assert.equal(file.label, 'SYNTHETIC');
      assert.equal(file.generatorVersion, BEHAVIORAL_GENERATOR_VERSION);
      assert.equal(file.seed, 5);
      assert.deepEqual(file.options, dataset.truth.options);
    }
    assert.deepEqual(eventsFile.events, dataset.events);
    assert.equal(eventsFile.eventCount, dataset.events.length);
    assert.equal(eventsFile.truthFile, 'archetypes-small.truth.json');
    assert.deepEqual(truthFile, dataset.truth);
    assert.ok(truthFile.traders.every((trader) => trader.archetype && trader.parameters.baseStake > 0));

    await assert.rejects(writeBehavioralDataset({ events: [], truth: { ...dataset.truth, label: 'CUSTOMER' } }, directory), TypeError);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
