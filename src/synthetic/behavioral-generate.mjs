/**
 * Behavioral synthetic traders, generator version behavioral-synthetic-0.1.0.
 *
 * Every output is SYNTHETIC. Each trader is simulated trade by trade from
 * explicit parameters whose meanings match the behavior-0.2.0 signal
 * definitions in src/engine/behavior.mjs, so an estimator can be checked
 * against known true values. Shared constants (session gap, refuel window,
 * low-balance multiple, drawdown bucket edges) come from
 * DEFAULT_BEHAVIOR_OPTIONS and drawdownBucket, never from local copies.
 *
 * generateBehavioralDataset(options) is pure and deterministic: the same
 * options give the same { events, truth }. It does no I/O. Use
 * writeBehavioralDataset in ./behavioral-write.mjs to write files.
 *
 * Parameters, archetypes, the money model, and population distributions are
 * documented in docs/BEHAVIORAL-SYNTHETIC.md. ADR-010 in docs/DECISIONS.md
 * lists the modelling choices the twin-0.2.0 estimator has to account for.
 */

import { createRng, stableSeed } from '../engine/rng.mjs';
import {
  BEHAVIOR_VERSION,
  DEFAULT_BEHAVIOR_OPTIONS,
  DRAWDOWN_BUCKETS,
  drawdownBucket
} from '../engine/behavior.mjs';

export const BEHAVIORAL_GENERATOR_VERSION = 'behavioral-synthetic-0.1.0';
export const SYNTHETIC_LABEL = 'SYNTHETIC';

// behavior-0.2.0 options that also drive the generator. Defaults come from DEFAULT_BEHAVIOR_OPTIONS.
export const SHARED_BEHAVIOR_OPTION_KEYS = Object.freeze([
  'sessionGapMinutes',
  'refuelWindowMinutes',
  'lowBalanceStakeMultiple',
  'flatBandStakes',
  'largeDrawdownStakes'
]);

// Fixed parts of the money and timing model. See docs/BEHAVIORAL-SYNTHETIC.md.
export const MODEL_CONSTANTS = Object.freeze({
  // Delay from a session-start deposit to the session's first trade.
  firstTradeDelaySeconds: Object.freeze([60, 300]),
  // Lower clamp on within-session latency. The upper clamp is sessionGapMinutes.
  minLatencySeconds: 2,
  // Earliest refuel deposit after the trigger trade when the session stops right after it.
  minRefuelDelaySeconds: 60
});

const PARAMETER_KEYS = Object.freeze([
  'baseStake',
  'stakeNoise',
  'chaseCoefficient',
  'escalationPerLoss',
  'reentryLatencyAfterLoss',
  'reentryLatencyAfterWin',
  'latencyNoise',
  'stopHazard',
  'refuelProbability',
  'depositAmount',
  'depositNoise',
  'winProbability',
  'pushProbability',
  'payoutMultiple',
  'payoutNoise',
  'sessionsPerDay'
]);

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

const STEADY_PARAMETERS = {
  baseStake: 20,
  stakeNoise: 0.2,
  chaseCoefficient: 1,
  escalationPerLoss: 1,
  reentryLatencyAfterLoss: 5,
  reentryLatencyAfterWin: 5,
  latencyNoise: 0.4,
  stopHazard: { up: 0.12, flat: 0.12, down_small: 0.12, down_large: 0.12 },
  refuelProbability: 0,
  depositAmount: 200,
  depositNoise: 0.2,
  winProbability: 0.48,
  pushProbability: 0,
  payoutMultiple: 0.85,
  payoutNoise: 0.3,
  sessionsPerDay: 1.5
};

/**
 * Five archetypes. Each differs from steady only in the parameters named in
 * its description, so each one isolates one behavior.
 */
export const ARCHETYPES = deepFreeze({
  steady: {
    description: 'Reference trader. Stake, latency, and stopping do not depend on outcomes. Never refuels.',
    parameters: STEADY_PARAMETERS
  },
  chaser: {
    description: 'Bets 1.8x after a loss, grows the stake 1.3x per additional loss in a session, and comes back faster after a loss.',
    parameters: { ...STEADY_PARAMETERS, chaseCoefficient: 1.8, escalationPerLoss: 1.3, reentryLatencyAfterLoss: 2 }
  },
  shrinker: {
    description: 'Bets 0.6x after a loss, scales down 0.85x per additional loss in a session, and waits longer after a loss.',
    parameters: { ...STEADY_PARAMETERS, chaseCoefficient: 0.6, escalationPerLoss: 0.85, reentryLatencyAfterLoss: 12 }
  },
  'quits-when-down': {
    description: 'Stop hazard rises with session drawdown: 0.05 when up, 0.6 when down more than two base stakes.',
    parameters: { ...STEADY_PARAMETERS, stopHazard: { up: 0.05, flat: 0.08, down_small: 0.25, down_large: 0.6 } }
  },
  refueler: {
    description: 'Deposits again with probability 0.85 when the balance drops below one base stake. Deposits are 3 base stakes, so the balance runs low often.',
    parameters: { ...STEADY_PARAMETERS, refuelProbability: 0.85, depositAmount: 60 }
  }
});

export const ARCHETYPE_NAMES = Object.freeze(Object.keys(ARCHETYPES));

/**
 * Population mode draws each trader's parameters from these distributions.
 * They are modelling assumptions, loosely informed by the OBSERVATIONAL
 * Polymarket follow-up (analysis/reports/polymarket-loss-vs-win-follow-up.md:
 * roughly as many wallets bet less after losses as bet more, and the median
 * normalized ratio after losses was about 0.95 of the one after wins). They are
 * not a calibration to that data or to any venue.
 *
 * lognormal: median * exp(N(0, sigma)). logitnormal: 1 / (1 + exp(-N(mean, sigma))).
 * Every draw is clamped to [min, max] when given. Derived parameters:
 * - reentryLatencyAfterLoss = reentryLatencyAfterWin * lossLatencyRatio
 * - stopHazard on the logit scale: flat = stopHazardFlat, up = flat + stopHazardUpShift,
 *   down_small = flat + stopHazardDownStep, down_large = flat + 2 * stopHazardDownStep,
 *   each clamped to [0.01, 0.95]
 * - depositAmount = baseStake * depositStakes
 */
export const POPULATION_DISTRIBUTIONS = deepFreeze({
  baseStake: { kind: 'lognormal', median: 20, sigma: 0.8, min: 2, max: 500 },
  stakeNoise: { kind: 'uniform', min: 0.1, max: 0.4 },
  chaseCoefficient: { kind: 'lognormal', median: 0.95, sigma: 0.35, min: 0.3, max: 3 },
  escalationPerLoss: { kind: 'lognormal', median: 1, sigma: 0.12, min: 0.7, max: 1.6 },
  reentryLatencyAfterWin: { kind: 'lognormal', median: 4, sigma: 0.5, min: 0.5, max: 20 },
  lossLatencyRatio: { kind: 'lognormal', median: 1.1, sigma: 0.4, min: 0.25, max: 4 },
  latencyNoise: { kind: 'uniform', min: 0.3, max: 0.7 },
  stopHazardFlat: { kind: 'uniform', min: 0.06, max: 0.2 },
  stopHazardUpShift: { kind: 'normal', mean: 0, sigma: 0.3 },
  stopHazardDownStep: { kind: 'normal', mean: 0.4, sigma: 0.5 },
  refuelProbability: { kind: 'logitnormal', mean: -1, sigma: 1.2, min: 0, max: 0.98 },
  depositStakes: { kind: 'lognormal', median: 6, sigma: 0.4, min: 3, max: 30 },
  depositNoise: { kind: 'uniform', min: 0.1, max: 0.4 },
  winProbability: { kind: 'normal', mean: 0.47, sigma: 0.04, min: 0.3, max: 0.65 },
  pushProbability: { kind: 'uniform', min: 0, max: 0.02 },
  payoutMultiple: { kind: 'lognormal', median: 0.85, sigma: 0.1, min: 0.5, max: 1.5 },
  payoutNoise: { kind: 'uniform', min: 0.2, max: 0.6 },
  sessionsPerDay: { kind: 'lognormal', median: 1.5, sigma: 0.5, min: 0.2, max: 8 }
});

const MODES = Object.freeze(['archetypes', 'population', 'custom']);

export const DEFAULT_GENERATOR_OPTIONS = deepFreeze({
  seed: 20260302,
  name: 'behavioral-synthetic',
  // archetypes: tradersPerArchetype of each name in `archetypes`.
  // population: traderCount traders drawn from POPULATION_DISTRIBUTIONS.
  // custom: one trader per entry of `traders`, each { archetype?, parameters? }.
  mode: 'archetypes',
  archetypes: ARCHETYPE_NAMES,
  tradersPerArchetype: 1,
  traderCount: 100,
  traders: [],
  // A positive integer, or { min, max } for a uniform integer draw per trader. Add
  // scale: 'log' for a log-uniform draw, which gives many short histories.
  sessionsPerTrader: 100,
  // false leaves balance_before and balance_after out of every event. Balances are still simulated.
  includeBalances: true,
  // Share of trades whose realized_result is set to null after simulation. Balances are kept.
  missingOutcomeShare: 0,
  startDate: '2026-03-02T00:00:00.000Z',
  venueId: 'synthetic-venue-001',
  // Safety cap. A session that reaches it ends and is counted in realized.stops.sessionCap.
  maxTradesPerSession: 200,
  // Overrides for SHARED_BEHAVIOR_OPTION_KEYS. Pass the same values to buildBehaviorSignals.
  behaviorOptions: {},
  // Settlement delay (ADR-018): null (outcomes known at once, as before), or { medianMinutes,
  // spread }: each trade settles after a lognormal lag, and the trader reacts only to settled
  // outcomes. Trades then carry settled_at. See simulateTraderDelayed.
  settlementDelay: null
});

// --- Validation --------------------------------------------------------------

function fail(message) {
  throw new RangeError(`generateBehavioralDataset: ${message}`);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value >= 1;
}

function requireNumber(value, label, { min = -Infinity, max = Infinity, exclusiveMin = false } = {}) {
  const tooLow = exclusiveMin ? value <= min : value < min;
  if (!isFiniteNumber(value) || tooLow || value > max) {
    const lower = exclusiveMin ? `> ${min}` : `>= ${min}`;
    fail(`${label} must be a finite number ${lower}${max === Infinity ? '' : ` and <= ${max}`}`);
  }
}

function validateParameters(parameters, label) {
  for (const key of Object.keys(parameters)) {
    if (!PARAMETER_KEYS.includes(key)) fail(`${label} has unknown parameter "${key}"`);
  }
  for (const key of PARAMETER_KEYS) {
    if (parameters[key] === undefined) fail(`${label} is missing parameter "${key}"`);
  }
  const p = parameters;
  requireNumber(p.baseStake, `${label}.baseStake`, { min: 0.01 });
  requireNumber(p.stakeNoise, `${label}.stakeNoise`, { min: 0, max: 2 });
  requireNumber(p.chaseCoefficient, `${label}.chaseCoefficient`, { min: 0, exclusiveMin: true });
  requireNumber(p.escalationPerLoss, `${label}.escalationPerLoss`, { min: 0, exclusiveMin: true });
  requireNumber(p.reentryLatencyAfterLoss, `${label}.reentryLatencyAfterLoss`, { min: 0, exclusiveMin: true });
  requireNumber(p.reentryLatencyAfterWin, `${label}.reentryLatencyAfterWin`, { min: 0, exclusiveMin: true });
  requireNumber(p.latencyNoise, `${label}.latencyNoise`, { min: 0, max: 3 });
  if (!isPlainObject(p.stopHazard)) fail(`${label}.stopHazard must be an object keyed by drawdown bucket`);
  for (const key of Object.keys(p.stopHazard)) {
    if (!DRAWDOWN_BUCKETS.includes(key)) fail(`${label}.stopHazard has unknown bucket "${key}"`);
  }
  for (const bucket of DRAWDOWN_BUCKETS) requireNumber(p.stopHazard[bucket], `${label}.stopHazard.${bucket}`, { min: 0, max: 1 });
  requireNumber(p.refuelProbability, `${label}.refuelProbability`, { min: 0, max: 1 });
  requireNumber(p.depositAmount, `${label}.depositAmount`, { min: 0.01 });
  requireNumber(p.depositNoise, `${label}.depositNoise`, { min: 0, max: 2 });
  requireNumber(p.winProbability, `${label}.winProbability`, { min: 0, max: 1 });
  requireNumber(p.pushProbability, `${label}.pushProbability`, { min: 0, max: 1 });
  if (p.winProbability + p.pushProbability > 1) fail(`${label}: winProbability + pushProbability must be <= 1`);
  requireNumber(p.payoutMultiple, `${label}.payoutMultiple`, { min: 0, exclusiveMin: true });
  requireNumber(p.payoutNoise, `${label}.payoutNoise`, { min: 0, max: 2 });
  requireNumber(p.sessionsPerDay, `${label}.sessionsPerDay`, { min: 0, exclusiveMin: true });
}

const SESSION_SCALES = Object.freeze(['uniform', 'log']);

function validateSessionsSpec(spec, label) {
  if (isPositiveInteger(spec)) return;
  if (isPlainObject(spec) && isPositiveInteger(spec.min) && isPositiveInteger(spec.max) && spec.min <= spec.max
    && (spec.scale === undefined || SESSION_SCALES.includes(spec.scale))
    && Object.keys(spec).every((key) => ['min', 'max', 'scale'].includes(key))) return;
  fail(`${label} must be a positive integer or { min, max, scale? } with positive integers min <= max and scale ${SESSION_SCALES.join(' or ')}`);
}

/**
 * One trader's session count. { min, max } (scale 'uniform', the default) is a
 * uniform integer draw. scale 'log' is log-uniform: floor(exp(U(log min,
 * log(max + 1)))), so each count k has probability log((k + 1) / k) /
 * log((max + 1) / min) and short histories are common. Each uses one draw.
 */
function drawSessionCount(spec, rng) {
  if (isPositiveInteger(spec)) return spec;
  if (spec.scale === 'log') {
    const logMin = Math.log(spec.min);
    const count = Math.floor(Math.exp(logMin + rng.next() * (Math.log(spec.max + 1) - logMin)));
    return clamp(count, spec.min, spec.max);
  }
  return rng.integer(spec.min, spec.max);
}

function resolveBehaviorOptions(supplied) {
  if (!isPlainObject(supplied)) fail('behaviorOptions must be an object');
  for (const key of Object.keys(supplied)) {
    if (!SHARED_BEHAVIOR_OPTION_KEYS.includes(key)) {
      fail(`behaviorOptions.${key} is not used by the generator (allowed: ${SHARED_BEHAVIOR_OPTION_KEYS.join(', ')})`);
    }
  }
  const resolved = Object.fromEntries(SHARED_BEHAVIOR_OPTION_KEYS.map((key) => [key, supplied[key] ?? DEFAULT_BEHAVIOR_OPTIONS[key]]));
  requireNumber(resolved.sessionGapMinutes, 'behaviorOptions.sessionGapMinutes', { min: 1 });
  requireNumber(resolved.refuelWindowMinutes, 'behaviorOptions.refuelWindowMinutes', { min: 1 });
  requireNumber(resolved.lowBalanceStakeMultiple, 'behaviorOptions.lowBalanceStakeMultiple', { min: 0, exclusiveMin: true });
  requireNumber(resolved.flatBandStakes, 'behaviorOptions.flatBandStakes', { min: 0 });
  requireNumber(resolved.largeDrawdownStakes, 'behaviorOptions.largeDrawdownStakes', { min: resolved.flatBandStakes, exclusiveMin: true });
  return resolved;
}

function resolveOptions(options) {
  if (options !== undefined && !isPlainObject(options)) fail('options must be an object');
  const supplied = Object.fromEntries(Object.entries(options ?? {}).filter(([, value]) => value !== undefined));
  for (const key of Object.keys(supplied)) {
    if (!Object.hasOwn(DEFAULT_GENERATOR_OPTIONS, key)) fail(`unknown option "${key}"`);
  }
  const resolved = { ...DEFAULT_GENERATOR_OPTIONS, ...supplied };

  if (!Number.isInteger(resolved.seed) || resolved.seed < 0) fail('seed must be a non-negative integer');
  if (typeof resolved.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(resolved.name)) {
    fail('name must start with a letter or digit and use only letters, digits, ".", "_", or "-"');
  }
  if (!MODES.includes(resolved.mode)) fail(`mode must be one of ${MODES.join(', ')}`);
  if (!Array.isArray(resolved.archetypes) || !resolved.archetypes.length) fail('archetypes must be a non-empty array');
  for (const name of resolved.archetypes) {
    if (!Object.hasOwn(ARCHETYPES, name)) fail(`unknown archetype "${name}"`);
  }
  if (!isPositiveInteger(resolved.tradersPerArchetype)) fail('tradersPerArchetype must be a positive integer');
  if (!isPositiveInteger(resolved.traderCount)) fail('traderCount must be a positive integer');
  if (!Array.isArray(resolved.traders)) fail('traders must be an array');
  if (resolved.mode === 'custom' && !resolved.traders.length) fail('custom mode needs at least one entry in traders');
  validateSessionsSpec(resolved.sessionsPerTrader, 'sessionsPerTrader');
  if (typeof resolved.includeBalances !== 'boolean') fail('includeBalances must be true or false');
  requireNumber(resolved.missingOutcomeShare, 'missingOutcomeShare', { min: 0, max: 1 });
  if (Number.isNaN(Date.parse(resolved.startDate))) fail('startDate must be a valid timestamp');
  if (typeof resolved.venueId !== 'string' || !resolved.venueId) fail('venueId must be a non-empty string');
  if (!isPositiveInteger(resolved.maxTradesPerSession)) fail('maxTradesPerSession must be a positive integer');
  if (resolved.settlementDelay !== null) {
    const delay = resolved.settlementDelay;
    if (!isPlainObject(delay) || Object.keys(delay).some((key) => !['medianMinutes', 'spread'].includes(key))) fail('settlementDelay must be null or { medianMinutes, spread }');
    requireNumber(delay.medianMinutes, 'settlementDelay.medianMinutes', { min: 0, exclusiveMin: true });
    requireNumber(delay.spread, 'settlementDelay.spread', { min: 0, max: 3 });
  }
  resolved.behaviorOptions = resolveBehaviorOptions(resolved.behaviorOptions);
  resolved.startDate = new Date(Date.parse(resolved.startDate)).toISOString();
  return resolved;
}

// --- Parameter sources ---------------------------------------------------------

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

function roundCents(value) {
  return Math.round(value * 100) / 100;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function logistic(value) {
  return 1 / (1 + Math.exp(-value));
}

function logit(probability) {
  return Math.log(probability / (1 - probability));
}

function draw(spec, rng) {
  let value;
  if (spec.kind === 'lognormal') value = spec.median * Math.exp(rng.normal(0, spec.sigma));
  else if (spec.kind === 'uniform') value = spec.min + rng.next() * (spec.max - spec.min);
  else if (spec.kind === 'normal') value = rng.normal(spec.mean, spec.sigma);
  else if (spec.kind === 'logitnormal') value = logistic(rng.normal(spec.mean, spec.sigma));
  else throw new Error(`unknown distribution kind ${spec.kind}`);
  return clamp(value, spec.min ?? -Infinity, spec.max ?? Infinity);
}

/**
 * Draws one trader's parameters from POPULATION_DISTRIBUTIONS. Values are
 * rounded (money to cents, everything else to 4 decimals) before use, so the
 * recorded truth is exactly what the simulation used.
 */
export function drawPopulationParameters(rng) {
  const d = POPULATION_DISTRIBUTIONS;
  const baseStake = Math.max(0.01, roundCents(draw(d.baseStake, rng)));
  const stakeNoise = round4(draw(d.stakeNoise, rng));
  const chaseCoefficient = round4(draw(d.chaseCoefficient, rng));
  const escalationPerLoss = round4(draw(d.escalationPerLoss, rng));
  const reentryLatencyAfterWin = round4(draw(d.reentryLatencyAfterWin, rng));
  const reentryLatencyAfterLoss = round4(reentryLatencyAfterWin * draw(d.lossLatencyRatio, rng));
  const latencyNoise = round4(draw(d.latencyNoise, rng));
  const flat = logit(draw(d.stopHazardFlat, rng));
  const upShift = draw(d.stopHazardUpShift, rng);
  const downStep = draw(d.stopHazardDownStep, rng);
  const hazard = (value) => round4(clamp(logistic(value), 0.01, 0.95));
  const stopHazard = { up: hazard(flat + upShift), flat: hazard(flat), down_small: hazard(flat + downStep), down_large: hazard(flat + 2 * downStep) };
  const refuelProbability = round4(draw(d.refuelProbability, rng));
  const depositAmount = Math.max(0.01, roundCents(baseStake * draw(d.depositStakes, rng)));
  const depositNoise = round4(draw(d.depositNoise, rng));
  const winProbability = round4(draw(d.winProbability, rng));
  const pushProbability = round4(draw(d.pushProbability, rng));
  const payoutMultiple = round4(draw(d.payoutMultiple, rng));
  const payoutNoise = round4(draw(d.payoutNoise, rng));
  const sessionsPerDay = round4(draw(d.sessionsPerDay, rng));
  return {
    baseStake,
    stakeNoise,
    chaseCoefficient,
    escalationPerLoss,
    reentryLatencyAfterLoss,
    reentryLatencyAfterWin,
    latencyNoise,
    stopHazard,
    refuelProbability,
    depositAmount,
    depositNoise,
    winProbability,
    pushProbability,
    payoutMultiple,
    payoutNoise,
    sessionsPerDay
  };
}

function copyParameters(parameters) {
  return { ...parameters, stopHazard: { ...parameters.stopHazard } };
}

function customParameters(entry, index) {
  const label = `traders[${index}]`;
  if (!isPlainObject(entry)) fail(`${label} must be an object`);
  for (const key of Object.keys(entry)) {
    if (!['archetype', 'parameters'].includes(key)) fail(`${label} has unknown key "${key}"`);
  }
  const archetype = entry.archetype ?? null;
  if (archetype !== null && !Object.hasOwn(ARCHETYPES, archetype)) fail(`${label}.archetype "${archetype}" is unknown`);
  const overrides = entry.parameters ?? {};
  if (!isPlainObject(overrides)) fail(`${label}.parameters must be an object`);
  const base = ARCHETYPES[archetype ?? 'steady'].parameters;
  const parameters = { ...copyParameters(base), ...overrides };
  if (isPlainObject(overrides.stopHazard)) parameters.stopHazard = { ...base.stopHazard, ...overrides.stopHazard };
  validateParameters(parameters, label);
  return { archetype: archetype ?? 'custom', overrides: Object.keys(overrides).sort(), parameters: copyParameters(parameters) };
}

function traderSpecs(options) {
  if (options.mode === 'archetypes') {
    const specs = [];
    for (const name of options.archetypes) {
      for (let copy = 0; copy < options.tradersPerArchetype; copy += 1) {
        specs.push({ archetype: name, parameters: copyParameters(ARCHETYPES[name].parameters) });
      }
    }
    return specs;
  }
  if (options.mode === 'custom') return options.traders.map(customParameters);
  return Array.from({ length: options.traderCount }, () => ({ archetype: 'population', parameters: null }));
}

// --- Simulation ----------------------------------------------------------------

const SECOND_MS = 1000;
const MINUTE_SECONDS = 60;
const DAY_SECONDS = 86400;
const OUTCOME_COUNT_KEYS = Object.freeze({ win: 'wins', loss: 'losses', push: 'pushes' });

function emptyBucketCounts() {
  return Object.fromEntries(DRAWDOWN_BUCKETS.map((bucket) => [bucket, 0]));
}

/**
 * Simulates one trader. Money is tracked in integer cents. Returns events
 * without event_id or source_row_number (those are assigned after the global
 * sort) and the realized counts for the truth file.
 */
function simulateTrader(trader, context) {
  const p = trader.parameters;
  const { behavior, maxTradesPerSession } = context;
  const rng = createRng(trader.simulationSeed);

  const gapSeconds = behavior.sessionGapMinutes * MINUTE_SECONDS;
  const refuelMaxSeconds = Math.floor(Math.min(behavior.sessionGapMinutes, behavior.refuelWindowMinutes) * MINUTE_SECONDS);
  const refuelMinSeconds = Math.min(MODEL_CONSTANTS.minRefuelDelaySeconds, refuelMaxSeconds);
  // A new session starts more than max(session gap, refuel window) after the previous one,
  // so a session-start deposit never lands in the refuel window of an earlier trade.
  const minIdleSeconds = Math.ceil(Math.max(behavior.sessionGapMinutes, behavior.refuelWindowMinutes) * MINUTE_SECONDS) + MINUTE_SECONDS;
  const meanExtraIdleSeconds = DAY_SECONDS / p.sessionsPerDay;
  const baseCents = p.baseStake * 100;
  // One low-balance threshold, in currency: it fires the refuel trigger mid-session, and a
  // session that would start below it (or below its first intended stake) starts with a deposit.
  // Comparisons use balance / 100, the exact value the events report, as signal 5 does.
  const lowBalance = behavior.lowBalanceStakeMultiple * p.baseStake;

  const events = [];
  const realized = {
    sessions: 0,
    trades: 0,
    wins: 0,
    losses: 0,
    pushes: 0,
    chaseEpisodes: 0,
    escalationEpisodes: 0,
    tradesByBucket: emptyBucketCounts(),
    stops: { hazard: emptyBucketCounts(), forced: emptyBucketCounts(), sessionCap: 0 },
    refuelTriggers: 0,
    deposits: { sessionStart: 0, sessionStartRaised: 0, refuel: 0 },
    blankedOutcomes: 0,
    finalBalance: 0,
    firstEventAt: null,
    lastEventAt: null
  };

  let balance = 0;
  let lastOutcome = null; // outcome of the previous trade, in any session
  let lastEventSeconds = 0;

  const emit = (seconds, type, fields) => {
    events.push({ seconds, order: events.length, type, ...fields });
    lastEventSeconds = seconds;
  };
  const deposit = (seconds, cents) => {
    emit(seconds, 'deposit', { depositCents: cents, balanceBeforeCents: balance, balanceAfterCents: balance + cents });
    balance += cents;
  };
  const drawDepositCents = () => Math.max(1, Math.round(p.depositAmount * 100 * Math.exp(rng.normal(0, p.depositNoise))));
  // Stake = baseStake x chase term x escalation term x lognormal noise with median 1.
  const intendedStakeCents = (lossRunInSession) => {
    let multiplier = 1;
    if (lastOutcome === 'loss') multiplier *= p.chaseCoefficient;
    if (lossRunInSession >= 2) multiplier *= p.escalationPerLoss ** (lossRunInSession - 1);
    return Math.max(1, Math.round(baseCents * multiplier * Math.exp(rng.normal(0, p.stakeNoise))));
  };
  // Lognormal latency with the parameter as its median, clamped so the next trade stays in the session.
  const latencySeconds = (outcome) => {
    const median = outcome === 'loss' ? p.reentryLatencyAfterLoss : p.reentryLatencyAfterWin;
    const seconds = Math.round(median * MINUTE_SECONDS * Math.exp(rng.normal(0, p.latencyNoise)));
    return clamp(seconds, MODEL_CONSTANTS.minLatencySeconds, gapSeconds);
  };

  let seconds = context.startSeconds + Math.floor(rng.next() * DAY_SECONDS);
  for (let session = 0; session < trader.sessionCount; session += 1) {
    if (session > 0) {
      const extraIdle = -Math.log(1 - rng.next()) * meanExtraIdleSeconds;
      seconds = lastEventSeconds + minIdleSeconds + Math.round(extraIdle);
    }
    realized.sessions += 1;
    let running = 0; // session result so far, net of deposits, in cents
    let lossRun = 0; // consecutive losses ending at the previous trade, this session only
    let tradesInSession = 0;

    let stake = intendedStakeCents(0);
    if (balance / 100 < lowBalance || balance < stake) {
      let amount = drawDepositCents();
      if (balance + amount < stake) {
        amount = stake - balance;
        realized.deposits.sessionStartRaised += 1;
      }
      deposit(seconds, amount);
      realized.deposits.sessionStart += 1;
      seconds += rng.integer(...MODEL_CONSTANTS.firstTradeDelaySeconds);
    }

    for (;;) {
      if (lastOutcome === 'loss' && lossRun < 2) realized.chaseEpisodes += 1;
      if (lossRun >= 2) realized.escalationEpisodes += 1;

      const before = balance;
      const u = rng.next();
      let outcome;
      let result;
      if (u < p.winProbability) {
        outcome = 'win';
        result = Math.max(1, Math.round(stake * p.payoutMultiple * Math.exp(rng.normal(0, p.payoutNoise))));
      } else if (u < p.winProbability + p.pushProbability) {
        outcome = 'push';
        result = 0;
      } else {
        outcome = 'loss';
        result = -stake; // a loss forfeits the whole stake
      }
      balance += result;
      running += result;
      emit(seconds, 'trade', { stakeCents: stake, resultCents: result, balanceBeforeCents: before, balanceAfterCents: balance });
      realized.trades += 1;
      realized[OUTCOME_COUNT_KEYS[outcome]] += 1;
      tradesInSession += 1;
      lastOutcome = outcome;
      lossRun = outcome === 'loss' ? lossRun + 1 : 0;

      const bucket = drawdownBucket(running / 100, p.baseStake, behavior);
      realized.tradesByBucket[bucket] += 1;

      // Refuel trigger, as in signal 5: this trade took the balance from at or above the threshold to below it.
      let refuel = false;
      if (before / 100 >= lowBalance && balance / 100 < lowBalance) {
        realized.refuelTriggers += 1;
        refuel = rng.next() < p.refuelProbability;
      }

      if (rng.next() < p.stopHazard[bucket]) {
        realized.stops.hazard[bucket] += 1;
        if (refuel) {
          deposit(seconds + rng.integer(refuelMinSeconds, refuelMaxSeconds), drawDepositCents());
          realized.deposits.refuel += 1;
        }
        break;
      }
      if (tradesInSession >= maxTradesPerSession) {
        realized.stops.sessionCap += 1;
        if (refuel) {
          deposit(seconds + rng.integer(refuelMinSeconds, refuelMaxSeconds), drawDepositCents());
          realized.deposits.refuel += 1;
        }
        break;
      }

      const latency = latencySeconds(outcome);
      const next = intendedStakeCents(lossRun);
      if (refuel) {
        // The deposit lands between this trade and the next, so it doesn't change trade timing.
        deposit(seconds + rng.integer(1, latency - 1), drawDepositCents());
        realized.deposits.refuel += 1;
      }
      if (next > balance) {
        // Broke rule: the trader can't stake more than the balance, so the session ends.
        // Stakes are never capped, so the stake model is never distorted.
        realized.stops.forced[bucket] += 1;
        break;
      }
      seconds += latency;
      stake = next;
    }
  }

  realized.finalBalance = balance / 100;
  return { events, realized };
}

/**
 * One trader with a settlement delay (ADR-018). The same parameters and rules as
 * simulateTrader, except:
 * - each trade settles settlementDelay.medianMinutes x exp(N(0, spread)) after it is placed;
 *   the stake is debited at placement and stake + result credited at settlement;
 * - the trader reacts only to settled outcomes: the chase term follows the latest settled
 *   outcome, and the session's running result and losing run update when an outcome settles
 *   (in the session current then);
 * - the stop decision after a trade uses what had settled when it was placed;
 * - each outcome that settles before the next trade moves it: the trader re-enters after the
 *   latency for that outcome, counted from the settlement, within the session gap;
 * - a refuel deposit (low-balance trigger, at placement) lands 1 second after the trade.
 * Outcomes landing between sessions change the balance and the latest settled outcome.
 */
function simulateTraderDelayed(trader, context) {
  const p = trader.parameters;
  const { behavior, maxTradesPerSession, settlementDelay } = context;
  const rng = createRng(trader.simulationSeed);
  const gapSeconds = behavior.sessionGapMinutes * MINUTE_SECONDS;
  const minIdleSeconds = Math.ceil(Math.max(behavior.sessionGapMinutes, behavior.refuelWindowMinutes) * MINUTE_SECONDS) + MINUTE_SECONDS;
  const meanExtraIdleSeconds = DAY_SECONDS / p.sessionsPerDay;
  const baseCents = p.baseStake * 100;
  const lowBalance = behavior.lowBalanceStakeMultiple * p.baseStake;

  const events = [];
  const realized = {
    sessions: 0, trades: 0, wins: 0, losses: 0, pushes: 0, chaseEpisodes: 0, escalationEpisodes: 0,
    tradesByBucket: emptyBucketCounts(),
    stops: { hazard: emptyBucketCounts(), forced: emptyBucketCounts(), sessionCap: 0 },
    refuelTriggers: 0,
    deposits: { sessionStart: 0, sessionStartRaised: 0, refuel: 0 },
    blankedOutcomes: 0, finalBalance: 0, firstEventAt: null, lastEventAt: null, settledDuringIdle: 0
  };

  let balance = 0;
  let lastOutcome = null; // the latest settled outcome, in any session
  let lastEventSeconds = 0;
  let running = 0;
  let lossRun = 0;
  let inSession = false;
  const pending = [];
  const emit = (seconds, type, fields) => {
    events.push({ seconds, order: events.length, type, ...fields });
    lastEventSeconds = seconds;
  };
  const deposit = (seconds, cents) => {
    emit(seconds, 'deposit', { depositCents: cents, balanceBeforeCents: balance, balanceAfterCents: balance + cents });
    balance += cents;
  };
  const settleUpTo = (time) => {
    while (pending.length && pending[0].at <= time) {
      const item = pending.shift();
      balance += item.creditCents;
      lastOutcome = item.outcome;
      if (inSession) {
        running += item.resultCents;
        lossRun = item.outcome === 'loss' ? lossRun + 1 : 0;
      } else {
        realized.settledDuringIdle += 1;
      }
    }
  };
  const drawDepositCents = () => Math.max(1, Math.round(p.depositAmount * 100 * Math.exp(rng.normal(0, p.depositNoise))));
  const intendedStakeCents = (lossRunInSession) => {
    let multiplier = 1;
    if (lastOutcome === 'loss') multiplier *= p.chaseCoefficient;
    if (lossRunInSession >= 2) multiplier *= p.escalationPerLoss ** (lossRunInSession - 1);
    return Math.max(1, Math.round(baseCents * multiplier * Math.exp(rng.normal(0, p.stakeNoise))));
  };
  const latencySeconds = (outcome) => {
    const median = outcome === 'loss' ? p.reentryLatencyAfterLoss : p.reentryLatencyAfterWin;
    return clamp(Math.round(median * MINUTE_SECONDS * Math.exp(rng.normal(0, p.latencyNoise))), MODEL_CONSTANTS.minLatencySeconds, gapSeconds);
  };

  let seconds = context.startSeconds + Math.floor(rng.next() * DAY_SECONDS);
  for (let session = 0; session < trader.sessionCount; session += 1) {
    if (session > 0) seconds = lastEventSeconds + minIdleSeconds + Math.round(-Math.log(1 - rng.next()) * meanExtraIdleSeconds);
    inSession = false;
    settleUpTo(seconds);
    inSession = true;
    realized.sessions += 1;
    running = 0;
    lossRun = 0;
    let tradesInSession = 0;

    let stake = intendedStakeCents(0);
    if (balance / 100 < lowBalance || balance < stake) {
      let amount = drawDepositCents();
      if (balance + amount < stake) {
        amount = stake - balance;
        realized.deposits.sessionStartRaised += 1;
      }
      deposit(seconds, amount);
      realized.deposits.sessionStart += 1;
      seconds += rng.integer(...MODEL_CONSTANTS.firstTradeDelaySeconds);
      settleUpTo(seconds);
    }

    for (;;) {
      if (lastOutcome === 'loss' && lossRun < 2) realized.chaseEpisodes += 1;
      if (lossRun >= 2) realized.escalationEpisodes += 1;
      const before = balance;
      const u = rng.next();
      let outcome;
      let result;
      if (u < p.winProbability) {
        outcome = 'win';
        result = Math.max(1, Math.round(stake * p.payoutMultiple * Math.exp(rng.normal(0, p.payoutNoise))));
      } else if (u < p.winProbability + p.pushProbability) {
        outcome = 'push';
        result = 0;
      } else {
        outcome = 'loss';
        result = -stake;
      }
      const lag = Math.max(0, Math.round(settlementDelay.medianMinutes * MINUTE_SECONDS * Math.exp(rng.normal(0, settlementDelay.spread))));
      balance -= stake;
      emit(seconds, 'trade', { stakeCents: stake, resultCents: result, balanceBeforeCents: before, balanceAfterCents: balance, settleSeconds: seconds + lag });
      let index = pending.length;
      while (index > 0 && pending[index - 1].at > seconds + lag) index -= 1;
      pending.splice(index, 0, { at: seconds + lag, outcome, resultCents: result, creditCents: stake + result });
      realized.trades += 1;
      realized[OUTCOME_COUNT_KEYS[outcome]] += 1;
      tradesInSession += 1;
      settleUpTo(seconds); // a zero lag settles at once

      const bucket = drawdownBucket(running / 100, p.baseStake, behavior);
      realized.tradesByBucket[bucket] += 1;
      let refuel = false;
      if (before / 100 >= lowBalance && balance / 100 < lowBalance) {
        realized.refuelTriggers += 1;
        refuel = rng.next() < p.refuelProbability;
      }
      const hazardStop = rng.next() < p.stopHazard[bucket];
      if (hazardStop || tradesInSession >= maxTradesPerSession) {
        if (hazardStop) realized.stops.hazard[bucket] += 1;
        else realized.stops.sessionCap += 1;
        if (refuel) {
          deposit(seconds + 1, drawDepositCents());
          realized.deposits.refuel += 1;
        }
        break;
      }
      if (refuel) {
        deposit(seconds + 1, drawDepositCents());
        realized.deposits.refuel += 1;
      }
      const limit = seconds + gapSeconds;
      let candidate = seconds + latencySeconds(lastOutcome);
      while (pending.length && pending[0].at <= candidate) {
        const at = pending[0].at;
        settleUpTo(at);
        candidate = Math.max(at, Math.min(limit, at + latencySeconds(lastOutcome)));
      }
      settleUpTo(candidate);
      const next = intendedStakeCents(lossRun);
      if (next > balance) {
        realized.stops.forced[drawdownBucket(running / 100, p.baseStake, behavior)] += 1;
        break;
      }
      seconds = candidate;
      stake = next;
    }
  }
  realized.finalBalance = balance / 100;
  return { events, realized };
}

function toIso(seconds) {
  return new Date(seconds * SECOND_MS).toISOString();
}

/**
 * Generates a SYNTHETIC behavioral dataset.
 *
 * Returns { events, truth }. Events follow the analytical event schema
 * (docs/DATA-DICTIONARY.md) with `type`, a unique event_id, and
 * source_row_number. They carry no market or contract fields. truth holds the
 * label, generator version, seed, resolved options, and each trader's true
 * parameters, archetype, and realized counts. Throws RangeError on invalid
 * options or parameters.
 */
export function generateBehavioralDataset(options = {}) {
  const resolved = resolveOptions(options);
  const { seed } = resolved;
  const context = {
    behavior: resolved.behaviorOptions,
    maxTradesPerSession: resolved.maxTradesPerSession,
    startSeconds: Math.floor(Date.parse(resolved.startDate) / SECOND_MS),
    settlementDelay: resolved.settlementDelay
  };

  const specs = traderSpecs(resolved);
  const width = Math.max(4, String(specs.length).length);
  const traders = specs.map((spec, index) => {
    // Separate streams per trader and purpose: adding traders or blanking outcomes never changes another stream.
    const parameterRng = createRng(stableSeed(`${seed}:parameters:${index}`));
    const parameters = spec.parameters ?? drawPopulationParameters(parameterRng);
    const sessionCount = drawSessionCount(resolved.sessionsPerTrader, parameterRng);
    return {
      index,
      traderToken: `syn_${String(index + 1).padStart(width, '0')}`,
      archetype: spec.archetype,
      overrides: spec.overrides,
      parameters,
      sessionCount,
      simulationSeed: stableSeed(`${seed}:simulation:${index}`),
      missingSeed: stableSeed(`${seed}:missing:${index}`)
    };
  });

  const rows = [];
  const truthTraders = traders.map((trader) => {
    const { events, realized } = resolved.settlementDelay ? simulateTraderDelayed(trader, context) : simulateTrader(trader, context);
    const missingRng = createRng(trader.missingSeed);
    for (const event of events) {
      event.traderIndex = trader.index;
      event.traderToken = trader.traderToken;
      if (event.type === 'trade') {
        // One draw per trade whatever the share, so a larger share blanks a superset of trades.
        event.blank = missingRng.next() < resolved.missingOutcomeShare;
        if (event.blank) realized.blankedOutcomes += 1;
      }
      rows.push(event);
    }
    realized.firstEventAt = events.length ? toIso(events[0].seconds) : null;
    realized.lastEventAt = events.length ? toIso(events.at(-1).seconds) : null;
    const record = {
      traderToken: trader.traderToken,
      archetype: trader.archetype,
      sessionCount: trader.sessionCount,
      parameters: trader.parameters,
      realized
    };
    if (trader.overrides) record.overrides = trader.overrides;
    return record;
  });

  rows.sort((a, b) => a.seconds - b.seconds || a.traderIndex - b.traderIndex || a.order - b.order);
  const idWidth = Math.max(7, String(rows.length).length);
  const events = rows.map((row, position) => {
    const event = {
      event_id: `bsyn_${String(position + 1).padStart(idWidth, '0')}`,
      trader_token: row.traderToken,
      occurred_at: toIso(row.seconds),
      type: row.type,
      venue_id: resolved.venueId
    };
    if (row.type === 'trade') {
      event.stake_amount = row.stakeCents / 100;
      event.realized_result = row.blank ? null : row.resultCents / 100;
      if (row.settleSeconds !== undefined && !row.blank) event.settled_at = toIso(row.settleSeconds);
    } else {
      event.deposit_amount = row.depositCents / 100;
    }
    if (resolved.includeBalances) {
      event.balance_before = row.balanceBeforeCents / 100;
      event.balance_after = row.balanceAfterCents / 100;
    }
    event.source_row_number = position + 1;
    return event;
  });

  // Plain copies: the truth never shares objects with the caller's options or module constants.
  const plain = (value) => JSON.parse(JSON.stringify(value));
  const truth = {
    label: SYNTHETIC_LABEL,
    name: resolved.name,
    generatorVersion: BEHAVIORAL_GENERATOR_VERSION,
    behaviorVersion: BEHAVIOR_VERSION,
    seed,
    options: plain(resolved),
    modelConstants: plain(MODEL_CONSTANTS),
    populationDistributions: resolved.mode === 'population' ? plain(POPULATION_DISTRIBUTIONS) : null,
    eventCount: events.length,
    traderCount: truthTraders.length,
    traders: truthTraders
  };
  return { events, truth };
}
