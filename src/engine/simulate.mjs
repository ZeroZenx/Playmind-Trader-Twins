/**
 * State-dependent twin simulator, version simulator-0.3.0 (ADR-012, ADR-018).
 *
 * simulator-0.3.0 is simulator-0.2.0 plus outcome timing. When a twin has its own
 * settlement-lag estimate (twin-0.3.0, from settled_at), each simulated trade settles after
 * a lag drawn from it, and the trader reacts only to settled outcomes (settlement mode,
 * below). A twin without one runs exactly as in simulator-0.2.0.
 *
 * simulateTwinV2(fit, options) takes an estimateTwins fit (model twin-0.3.0) and
 * simulates every twin trade by trade through sessions, many seeded replicates per
 * trader. It returns distributions (median, 10th and 90th percentiles) of harm and
 * activity metrics per trader and for the population, never single numbers.
 *
 * Results are simulations under stated assumptions, never causal claims. Every
 * result carries the fit's data label (SYNTHETIC, OBSERVATIONAL, or CUSTOMER), the
 * model and simulator versions, the seed, the replicate count, and an assumptions list.
 *
 * One run of one trader:
 * - Parameters are drawn once, at the start of the run, from each parameter's stored
 *   posterior (normal: exp(N(mean, sd)); beta: Beta(a, b); inverse-gamma:
 *   offsetMinutes + scale / Gamma(shape)), independently across parameters. A
 *   not-estimable parameter with a population-prior fallback draws from the fallback,
 *   labelled "population prior, not this trader". With uncertainty off, every run uses
 *   the stored estimates (the posterior centers).
 * - Stake = baseStake x chaseCoefficient (if the previous trade, in any session, was a
 *   realized loss) x escalationPerLoss^(k - 1) (after the k-th consecutive loss in this
 *   session, k >= 2) x exp(N(0, stakeDispersion)), rounded to cents, at least 1 cent.
 * - Outcome: a win with winRate, result = stake x exp(N(log payoutMultiple,
 *   payoutSpread)); a push with pushRate, result 0; otherwise a loss, result = stake x a
 *   ratio drawn from the trader's stored loss quantiles (-1 when there are none).
 * - After each trade the session ends with probability stopHazard[drawdown bucket]. Then
 *   the broke rule ends it if the next stake exceeds the balance (after any refuel).
 * - Latency to the next trade: lognormal with the after-loss or after-win median
 *   (after-win after a push) and latencySpread, clamped to [2 s, sessionGapMinutes].
 * - Idle time between sessions: sessionGapMinutes + Exponential(meanIdleMinutes -
 *   sessionGapMinutes), the estimator's model.
 * - Deposits: the generator's session-start rule, and a refuel trigger (low balance, or
 *   the losing-streak proxy when the twin has no refuelProbability).
 *
 * Common random numbers: each kind of decision draws from its own stream (STREAMS), and
 * each stream is used a fixed number of times per event of its kind. A policy that
 * changes one decision never shifts another decision's draws. The policy layer
 * (policy-sim.mjs, ADR-013) compares policy and no-policy runs this way, through the
 * single hook `intervention` (INTERVENTION_POINTS, contract below). simulateTwinV2 always
 * uses NO_INTERVENTION and implements no policy; a run with NO_INTERVENTION never calls
 * the hook, so no-policy runs are exactly simulator-0.2.0's.
 *
 * Pure and deterministic: the same fit and options give the same result.
 */

import {
  DEFAULT_BEHAVIOR_OPTIONS,
  DRAWDOWN_BUCKETS,
  buildBehaviorObservations,
  drawdownBucket
} from './behavior.mjs';
import { DATA_LABELS, TWIN_MODEL_VERSION } from './estimate.mjs';
import { createRng, stableSeed } from './rng.mjs';
import { betaSample, gammaSample, median, sum } from './stats.mjs';
import { simulateTwin } from './twin.mjs';

export const SIMULATOR_VERSION = 'simulator-0.3.0';
export const BASELINE_SIMULATOR_VERSION = 'baseline-0.1';
export const SUPPORTED_MODEL_VERSIONS = Object.freeze([TWIN_MODEL_VERSION]);

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export const SIMULATION_DEFAULTS = deepFreeze({
  seed: 20261113,
  // Seeded replicates per trader. 200 is for real runs; tests use far fewer.
  replicates: 200,
  // false: every run uses the stored estimates (posterior centers) instead of draws.
  uncertainty: true,
  // Horizon: days from `start`, or a fixed number of sessions (a positive integer, or an
  // object mapping each simulated traderToken to one). Pass one, not both.
  horizonDays: 28,
  sessions: null,
  // ISO timestamp. Default: the end of the fit's training window.
  start: null,
  // traderTokens to simulate. Default: every twin in the fit.
  traders: null,
  // traderToken -> starting balance (currency): the last observed balance_after, from
  // lastObservedBalances(events). A trader without one starts at 0.
  startingBalances: {},
  // Safety cap, as in the generator.
  maxTradesPerSession: 200,
  // Keep each run's drawn parameters and metrics, and with keepEvents also its events
  // (analytical schema) and a per-trade trace of the random draws.
  keepRuns: false,
  keepEvents: false,
  // Stream name -> salt. Re-seeds that decision's stream only: a common-random-numbers check.
  reseedStreams: {}
});

// Rules from the behavioral generator (docs/BEHAVIORAL-SYNTHETIC.md) used where twin-0.2.1
// has no estimate. test/simulate.test.mjs checks they match the generator's constants.
export const GENERATOR_RULES = deepFreeze({
  // The first session starts at a uniform time within this many seconds of `start`.
  firstSessionWithinSeconds: 86400,
  // Delay from a session-start deposit to the session's first trade.
  firstTradeDelaySeconds: [60, 300],
  // Lower clamp on latency. The upper clamp is sessionGapMinutes.
  minLatencySeconds: 2,
  // Earliest refuel deposit after the trigger trade when the session stops right after it.
  minRefuelDelaySeconds: 60
});

export const METRIC_SETTINGS = deepFreeze({
  // A chase episode: a stake at least this many drawn baseStakes on the trade after a loss.
  chaseStakeMultiple: 1.25,
  quantiles: [0.1, 0.5, 0.9]
});

// One random stream per kind of decision. 'parameters' has a sub-stream per parameter.
// 'policy' is drawn only by an intervention (runInfo.policyStream), never by the simulator.
// Every stream is seeded by name, so adding one moves no other.
// 'settlement' (lags) and 'settlementLatency' (re-entry after a settlement) are drawn only in
// settlement mode, so a run without it draws exactly what simulator-0.2.0 drew.
export const STREAMS = Object.freeze(['parameters', 'outcomes', 'stakeNoise', 'latency', 'stops', 'refuel', 'deposits', 'idle', 'policy', 'settlement', 'settlementLatency']);

/**
 * The one hook policies use (ADR-012 point 11, extended in ADR-013). The simulator calls
 * intervention(point, proposal, state) and uses the returned object. INTERVENTION_POINTS
 * keeps simulator-0.2.0's three points; ADR-013 added SESSION_START_POINT. Each point's
 * return is checked, and a policy can only restrict or delay what the trader proposes,
 * except where noted:
 * - 'sessionStart', { seconds, earliestSeconds, lastEventSeconds }: a session is about to
 *   start at `seconds` (after the idle draws). Return { seconds, depositCents? }. The start
 *   may move later (a cooldown, leaving for the day) or earlier (a quick return), never
 *   before earliestSeconds (more than sessionGapMinutes after the last event, so the event
 *   data sees a new session). depositCents > 0 lands a deferred deposit at the start,
 *   before the session-start deposit rule; it passes through 'beforeDeposit'.
 * - 'beforeStake', { stakeCents }: the stake about to be placed, before the broke rule.
 *   Return { stakeCents } (a positive integer) or { skip: true }. A skipped attempt places
 *   nothing but uses the attempt's outcome, stop, and latency draws (below).
 * - 'beforeDeposit', { kind, amountCents, seconds }: a deposit about to be made at
 *   `seconds` ('sessionStart', 'refuel', or 'deferred'). Return { amountCents } between 0
 *   and the proposed amount. 0 makes no deposit.
 * - 'afterTrade', { endSession }: after a trade settles and after the trader's own stop
 *   decision (endSession: true when the stop hazard or the session cap ends the session).
 *   Return { endSession, resumeAtSeconds?, reset? }. A policy can't overrule the trader's
 *   own stop: when the proposal's endSession is true the session ends whatever is
 *   returned. Otherwise endSession: true ends it (counted as an intervention stop), and
 *   resumeAtSeconds pauses it: the next attempt comes no earlier than that time. reset:
 *   true (with a pause) starts the return as a new session: running result, losing run,
 *   bucket, and drawdown start over, with no idle draw and no session-start deposit.
 * state is a snapshot: { traderToken, replicate, seconds, session, tradesInSession,
 * balanceCents, runningCents, lossRun, lastOutcome, bucket }. An intervention must not
 * draw from the run's streams except runInfo.policyStream. NO_INTERVENTION returns every
 * proposal unchanged, and the simulator skips the call entirely when it is the hook in use.
 *
 * Draws per trade attempt, so later attempts stay aligned with the baseline: an attempt
 * that reaches the outcome (placed, capped, or skipped) uses 4 outcome, 1 stop, and 2
 * latency draws, and its next stake 2 stake-noise draws; an attempt the broke rule ends
 * uses none of them, as in simulator-0.2.0. A skipped attempt's stop draw is the trader's
 * own decision at the unchanged bucket, and its latency is the one for the last outcome.
 * The session cap counts attempts, which equals trades in a run without skips.
 */
export const INTERVENTION_POINTS = Object.freeze(['beforeStake', 'beforeDeposit', 'afterTrade']);
export const SESSION_START_POINT = 'sessionStart';
export const NO_INTERVENTION = Object.freeze(function noIntervention(point, proposal) {
  return proposal;
});

const BUCKET_PARAMETERS = DRAWDOWN_BUCKETS.map((bucket) => `stopHazard.${bucket}`);

/**
 * Mechanisms and the parameters each needs. A required mechanism that can't be simulated
 * makes the trader not simulable. An optional one is switched off and reported.
 * The refuel mechanism picks its parameter by rule (see planRefuel).
 */
export const MECHANISMS = deepFreeze({
  stake: { required: true, parameters: ['baseStake', 'stakeDispersion'] },
  outcomes: { required: true, parameters: ['winRate', 'pushRate', 'payoutMultiple', 'payoutSpread'] },
  latency: { required: true, parameters: ['reentryLatencyAfterLoss', 'reentryLatencyAfterWin', 'latencySpread'] },
  stops: { required: true, parameters: BUCKET_PARAMETERS },
  sessions: { required: true, parameters: ['meanIdleMinutes'] },
  chase: { required: false, parameters: ['chaseCoefficient'] },
  escalation: { required: false, parameters: ['escalationPerLoss'] },
  money: { required: false, parameters: ['depositSize', 'depositSpread'] },
  refuel: { required: false, parameters: ['refuelProbability', 'refuelAfterLosingStreak'] },
  // Simulated only from the trader's own estimate (not a population fallback): a trader whose
  // training had no settled_at keeps the behavior-0.2.0 rule.
  settlement: { required: false, parameters: ['settlementLagMinutes', 'settlementLagSpread'] }
});

const DRAW_ORDER = Object.freeze([
  'baseStake', 'stakeDispersion', 'chaseCoefficient', 'escalationPerLoss',
  'reentryLatencyAfterLoss', 'reentryLatencyAfterWin', 'latencySpread', ...BUCKET_PARAMETERS,
  'refuelProbability', 'refuelAfterLosingStreak', 'depositSize', 'depositSpread',
  'winRate', 'pushRate', 'payoutMultiple', 'payoutSpread', 'meanIdleMinutes',
  'settlementLagMinutes', 'settlementLagSpread'
]);

const sumOf = (unit, group, description, extra = {}) => ({ group, unit, description, population: { kind: 'sum' }, ...extra });
const meanOf = (unit, group, description, extra = {}) => ({ group, unit, description, population: { kind: 'mean' }, ...extra });
const ratioOf = (numerator, denominator, unit, description, extra = {}) => ({
  group: 'rate', unit, description, population: { kind: 'ratio', numerator, denominator }, ...extra
});

/**
 * Per-run metrics. `money: true` marks metrics that need the money model; they are null
 * when deposits can't be simulated. Population aggregates: 'sum' and 'ratio' metrics sum
 * each replicate across traders first; 'mean' metrics (drawdowns) average it. Then the
 * percentiles are taken across replicates.
 */
export const SIMULATION_METRICS = deepFreeze({
  // Harm
  maxSessionDrawdown: meanOf('currency', 'harm', 'Deepest session drawdown in the run: how far the running session result, net of deposits, fell below the session start.'),
  maxSessionDrawdownStakes: meanOf('base stakes', 'harm', 'maxSessionDrawdown divided by the run\'s drawn baseStake.'),
  chaseEpisodes: sumOf('trades', 'harm', 'Trades right after a realized loss (in any session) with a stake of at least chaseStakeMultiple x the run\'s drawn baseStake.'),
  chaseNoiseFloor: sumOf('trades', 'harm', 'The same count right after a realized win: what stake noise alone produces.'),
  depositsAfterLoss: sumOf('deposits', 'harm', 'Deposits within refuelWindowMinutes after a realized loss.', { money: true }),
  totalNetLoss: sumOf('currency', 'harm', 'Negative sum of trade results: positive when the trader lost money.'),
  forcedStops: sumOf('sessions', 'harm', 'Sessions ended by the broke rule: the next stake exceeded the balance.', { money: true }),
  // Activity
  trades: sumOf('trades', 'activity', 'Trades placed.'),
  totalStake: sumOf('currency', 'activity', 'Sum of stakes.'),
  sessions: sumOf('sessions', 'activity', 'Sessions with at least one trade.'),
  activeDays: sumOf('days', 'activity', 'Distinct UTC dates with a trade.'),
  deposits: sumOf('deposits', 'activity', 'Deposits made.', { money: true }),
  depositAmount: sumOf('currency', 'activity', 'Sum of deposits.', { money: true }),
  // Accounting
  sessionStartDeposits: sumOf('deposits', 'accounting', 'Deposits made by the session-start rule.', { money: true }),
  refuelDeposits: sumOf('deposits', 'accounting', 'Deposits made by the refuel mechanism.', { money: true }),
  hazardStops: sumOf('sessions', 'accounting', 'Sessions ended by the stop hazard.'),
  capStops: sumOf('sessions', 'accounting', 'Sessions ended by maxTradesPerSession.'),
  wins: sumOf('trades', 'accounting', 'Winning trades.'),
  losses: sumOf('trades', 'accounting', 'Losing trades.'),
  pushes: sumOf('trades', 'accounting', 'Trades that pushed.'),
  sessionsDownLarge: sumOf('sessions', 'accounting', 'Sessions whose running result reached the down_large bucket.'),
  tradesOnceDownLarge: sumOf('trades', 'accounting', 'Trades placed after the session first reached down_large.'),
  // Rates
  tradesPerSession: ratioOf('trades', 'sessions', 'trades', 'Trades per session.'),
  meanStake: ratioOf('totalStake', 'trades', 'currency', 'Mean stake.'),
  winShare: ratioOf('wins', 'trades', 'share', 'Share of trades that won.'),
  chaseEpisodesPerSession: ratioOf('chaseEpisodes', 'sessions', 'trades', 'Chase episodes per session.'),
  forcedStopsPerSession: ratioOf('forcedStops', 'sessions', 'sessions', 'Forced stops per session.', { money: true }),
  refuelDepositsPerSession: ratioOf('refuelDeposits', 'sessions', 'deposits', 'Refuel deposits per session.', { money: true }),
  depositsAfterLossPerSession: ratioOf('depositsAfterLoss', 'sessions', 'deposits', 'Deposits within the refuel window after a loss, per session.', { money: true }),
  tradesPerSessionOnceDownLarge: ratioOf('tradesOnceDownLarge', 'sessionsDownLarge', 'trades', 'Trades a session continues for once it is down large.'),
  medianSessionDrawdown: meanOf('currency', 'rate', 'Median over the run\'s sessions of each session\'s maximum drawdown.')
});

export const SIMULATION_METRIC_NAMES = Object.freeze(Object.keys(SIMULATION_METRICS));

const LOSS_QUANTILE_POINTS = Object.freeze([[0.1, 'p10'], [0.25, 'p25'], [0.5, 'p50'], [0.75, 'p75'], [0.9, 'p90']]);
const DAY_SECONDS = 86400;
const FALLBACK_START = '2026-01-01T00:00:00.000Z';
const REFUEL_LOW_BALANCE = 'lowBalance';
const REFUEL_PROXY = 'losingStreak (proxy)';
const REFUEL_NONE = 'none';

// --- Validation ------------------------------------------------------------------------

function fail(message, ErrorType = RangeError) {
  throw new ErrorType(`simulateTwinV2: ${message}`);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value >= 1;
}

function validateFit(fit) {
  if (!isPlainObject(fit) || !Array.isArray(fit.twins)) fail('fit must be the output of estimateTwins (an object with twins)', TypeError);
  if (!DATA_LABELS.includes(fit.dataLabel)) fail(`fit.dataLabel must be one of ${DATA_LABELS.join(', ')}`);
  if (!SUPPORTED_MODEL_VERSIONS.includes(fit.modelVersion)) {
    fail(`needs a ${SUPPORTED_MODEL_VERSIONS.join(' or ')} fit from estimateTwins, got model version ${fit.modelVersion}`);
  }
  if (!isPlainObject(fit.behaviorOptions)) fail('fit.behaviorOptions must be an object');
}

function resolveOptions(fit, options) {
  if (options !== undefined && !isPlainObject(options)) fail('options must be an object', TypeError);
  const supplied = Object.fromEntries(Object.entries(options ?? {}).filter(([, value]) => value !== undefined));
  for (const key of Object.keys(supplied)) {
    if (!Object.hasOwn(SIMULATION_DEFAULTS, key)) fail(`unknown option "${key}"`);
  }
  if (supplied.horizonDays !== undefined && supplied.sessions !== undefined && supplied.sessions !== null) {
    fail('pass horizonDays or sessions, not both');
  }
  const settings = { ...SIMULATION_DEFAULTS, ...supplied };
  const tokens = new Set(fit.twins.map((twin) => twin.traderToken));

  if (!Number.isInteger(settings.seed) || settings.seed < 0) fail('seed must be a non-negative integer');
  if (!isPositiveInteger(settings.replicates)) fail('replicates must be a positive integer');
  if (typeof settings.uncertainty !== 'boolean') fail('uncertainty must be true or false');
  if (!(Number.isFinite(settings.horizonDays) && settings.horizonDays > 0)) fail('horizonDays must be a positive number');
  if (settings.sessions !== null && !isPositiveInteger(settings.sessions)) {
    if (!isPlainObject(settings.sessions)) fail('sessions must be null, a positive integer, or an object of traderToken -> positive integer');
    for (const [token, count] of Object.entries(settings.sessions)) {
      if (!isPositiveInteger(count)) fail(`sessions.${token} must be a positive integer`);
    }
  }
  if (settings.traders !== null) {
    if (!Array.isArray(settings.traders)) fail('traders must be null or an array of traderTokens');
    for (const token of settings.traders) if (!tokens.has(token)) fail(`traders names "${token}", which is not in the fit`);
  }
  if (!isPlainObject(settings.startingBalances)) fail('startingBalances must be an object of traderToken -> balance');
  for (const [token, balance] of Object.entries(settings.startingBalances)) {
    if (!(Number.isFinite(balance) && balance >= 0)) fail(`startingBalances.${token} must be a finite number >= 0`);
  }
  if (!isPositiveInteger(settings.maxTradesPerSession)) fail('maxTradesPerSession must be a positive integer');
  if (typeof settings.keepRuns !== 'boolean') fail('keepRuns must be true or false');
  if (typeof settings.keepEvents !== 'boolean') fail('keepEvents must be true or false');
  if (!isPlainObject(settings.reseedStreams)) fail('reseedStreams must be an object of stream name -> salt');
  for (const [stream, salt] of Object.entries(settings.reseedStreams)) {
    if (!STREAMS.includes(stream)) fail(`reseedStreams names an unknown stream "${stream}" (streams: ${STREAMS.join(', ')})`);
    if (typeof salt !== 'string' || !salt) fail(`reseedStreams.${stream} must be a non-empty string`);
  }

  const start = settings.start ?? fit.trainingWindow?.end ?? FALLBACK_START;
  const startMs = Date.parse(start instanceof Date ? start.toISOString() : start);
  if (Number.isNaN(startMs)) fail('start must be a valid timestamp');
  const startSeconds = Math.floor(startMs / 1000);
  const twins = settings.traders === null ? fit.twins : settings.traders.map((token) => fit.twins.find((twin) => twin.traderToken === token));
  if (isPlainObject(settings.sessions)) {
    for (const twin of twins) {
      if (!Object.hasOwn(settings.sessions, twin.traderToken)) fail(`sessions has no count for trader ${twin.traderToken}`);
    }
  }
  return {
    ...settings,
    twins,
    start: new Date(startSeconds * 1000).toISOString(),
    startSeconds,
    horizonEndSeconds: settings.sessions === null ? startSeconds + Math.round(settings.horizonDays * DAY_SECONDS) : null,
    horizon: settings.sessions === null ? { days: settings.horizonDays } : { sessions: settings.sessions }
  };
}

// --- Parameter sources and draws ---------------------------------------------------------

function parameterRecord(twin, name) {
  const [head, bucket] = name.split('.');
  const record = twin.parameters?.[head];
  return bucket ? record?.[bucket] : record;
}

function validDistribution(distribution) {
  if (!isPlainObject(distribution)) return false;
  const positive = (value) => Number.isFinite(value) && value > 0;
  switch (distribution.family) {
    case 'point': return Number.isFinite(distribution.value);
    case 'normal': return distribution.scale === 'log' && Number.isFinite(distribution.mean)
      && (distribution.sd === null || (Number.isFinite(distribution.sd) && distribution.sd >= 0));
    case 'beta': return positive(distribution.a) && positive(distribution.b);
    case 'inverse-gamma': return positive(distribution.shape) && positive(distribution.scale) && Number.isFinite(distribution.offsetMinutes);
    default: return false;
  }
}

/**
 * Where one parameter's runs come from. estimated and prior_only draw from `posterior`
 * (prior_only already holds the trader's prior). not_estimable draws from `fallback` when
 * it has one, labelled. With no fallback the parameter can't be simulated.
 */
function sourceFor(record) {
  if (!record) return { available: false, reason: 'missing from the fit' };
  let distribution;
  let center;
  let source;
  if (record.status === 'not_estimable') {
    if (!record.fallback) return { available: false, reason: record.reason ?? 'not estimable, with no fallback' };
    distribution = record.fallback;
    center = record.fallback.estimate;
    source = 'population prior, not this trader';
  } else {
    distribution = record.posterior;
    center = record.estimate;
    if (distribution?.family === 'point') source = 'known value (point mass)';
    else source = record.status === 'prior_only' ? 'trader prior (no own observations)' : 'posterior';
  }
  if (!validDistribution(distribution) || !Number.isFinite(center)) return { available: false, reason: 'no usable stored distribution' };
  return { available: true, source, distribution, center };
}

function drawValue(distribution, rng) {
  switch (distribution.family) {
    case 'point': return distribution.value;
    case 'normal': return Math.exp(distribution.mean + (distribution.sd ?? 0) * rng.normal());
    case 'beta': return betaSample(rng, distribution.a, distribution.b);
    default: return distribution.offsetMinutes + distribution.scale / gammaSample(rng, distribution.shape);
  }
}

function planRefuel(twin, sources, moneySimulated, behavior) {
  if (!moneySimulated) return { trigger: REFUEL_NONE, parameter: null, reason: 'deposits are not simulated, so neither is refuel' };
  const primary = parameterRecord(twin, 'refuelProbability');
  if (primary && primary.status !== 'not_estimable' && sources.refuelProbability) {
    return { trigger: REFUEL_LOW_BALANCE, parameter: 'refuelProbability', reason: null };
  }
  // ADR-011 point 11: without refuelProbability, switch the trigger to the losing streak and
  // use its own probability. The proxy is never applied to the low-balance trigger, and
  // refuelProbability's population fallback is not used: it would replace this trader's
  // own proxy evidence with the population's low-balance behavior.
  const why = primary?.reason ?? 'missing from the fit';
  if (sources.refuelAfterLosingStreak) {
    return {
      trigger: REFUEL_PROXY,
      parameter: 'refuelAfterLosingStreak',
      reason: `refuelProbability not estimable (${why}); the trigger is ${behavior.losingStreakLength} consecutive realized losses, with refuelAfterLosingStreak as its probability`
    };
  }
  return { trigger: REFUEL_NONE, parameter: null, reason: `refuelProbability not estimable (${why}), and refuelAfterLosingStreak can't be simulated either` };
}

function lossRatioPlan(twin) {
  const losses = twin.payoutDistribution?.resultPerStake?.losses;
  const quantiles = losses?.quantiles;
  if (quantiles && LOSS_QUANTILE_POINTS.every(([, key]) => Number.isFinite(quantiles[key]) && quantiles[key] < 0)) {
    return {
      points: LOSS_QUANTILE_POINTS.map(([p, key]) => [p, quantiles[key]]),
      source: losses.source ?? `empirical: interpolated between the trader's ${LOSS_QUANTILE_POINTS.length} stored loss quantiles of result / stake (n=${losses.n}), p10 and p90 held in the tails`
    };
  }
  return { points: null, source: 'no observed losses: a loss forfeits the whole stake (ratio -1)' };
}

// Piecewise-linear inverse CDF through the stored quantiles, flat below p10 and above p90.
function lossRatio(points, u) {
  if (!points) return -1;
  if (u <= points[0][0]) return points[0][1];
  for (let index = 1; index < points.length; index += 1) {
    const [p, value] = points[index];
    if (u <= p) {
      const [p0, value0] = points[index - 1];
      return value0 + (value - value0) * (u - p0) / (p - p0);
    }
  }
  return points.at(-1)[1];
}

function startingBalancePlan(twin, settings, moneySimulated) {
  if (!moneySimulated) return { amount: null, cents: 0, rule: 'no money model: deposits are not simulated' };
  const supplied = settings.startingBalances[twin.traderToken];
  if (supplied !== undefined) {
    return { amount: supplied, cents: Math.round(supplied * 100), rule: 'last observed balance_after (supplied in startingBalances)' };
  }
  const rule = twin.inputs?.hasCompleteBalances
    ? '0, with the session-start deposit rule: training had balances, but no starting balance was supplied'
    : '0, with the session-start deposit rule (no balance fields in training)';
  return { amount: 0, cents: 0, rule };
}

function stopBasisText(basis) {
  if (basis === 'all-cause') {
    return 'stopBasis all-cause (no balance fields in training): the stop hazard already includes running out of money, and the simulated broke rule still applies, because a simulated balance can\'t go negative. Stopping is double-counted in low-balance states.';
  }
  if (basis === 'voluntary') return 'stopBasis voluntary (balance fields in training): the stop hazard excludes running out of money, and the simulated broke rule adds forced stops.';
  return `stopBasis ${basis}: the stop hazards are not this trader's own fitted hazards.`;
}

function planTrader(twin, settings, behavior) {
  const traderToken = twin.traderToken;
  const reasons = [];
  if (twin.inputs?.hasOutcomes === false) {
    reasons.push('no realized outcome in training: every outcome-driven parameter would be the population prior, not this trader');
  }
  const sources = {};
  const unavailable = {};
  for (const name of DRAW_ORDER) {
    const source = sourceFor(parameterRecord(twin, name));
    if (source.available) sources[name] = source;
    else unavailable[name] = source.reason;
  }
  const mechanisms = {};
  for (const [mechanism, spec] of Object.entries(MECHANISMS)) {
    if (mechanism === 'refuel') continue;
    const missing = spec.parameters.filter((name) => !sources[name] || (mechanism === 'settlement' && parameterRecord(twin, name)?.status === 'not_estimable'));
    const reason = missing.length
      ? missing.map((name) => `${name}: ${unavailable[name] ?? parameterRecord(twin, name)?.reason ?? 'not estimable'}`).join('; ')
      : null;
    mechanisms[mechanism] = { simulated: !missing.length, reason };
    if (missing.length && spec.required) reasons.push(`the ${mechanism} mechanism can't be simulated (${reason})`);
  }
  if (reasons.length) return { traderToken, simulable: false, reasons };

  const refuel = planRefuel(twin, sources, mechanisms.money.simulated, behavior);
  mechanisms.refuel = { simulated: refuel.trigger !== REFUEL_NONE, reason: refuel.reason };
  const draw = DRAW_ORDER.filter((name) => {
    if (name === 'refuelProbability' || name === 'refuelAfterLosingStreak') return name === refuel.parameter;
    if (name === 'chaseCoefficient') return mechanisms.chase.simulated;
    if (name === 'escalationPerLoss') return mechanisms.escalation.simulated;
    if (name === 'depositSize' || name === 'depositSpread') return mechanisms.money.simulated;
    if (name === 'settlementLagMinutes' || name === 'settlementLagSpread') return mechanisms.settlement.simulated;
    return true;
  });
  const parameterSources = Object.fromEntries(draw.map((name) => [name, sources[name].source]));
  const startingBalance = startingBalancePlan(twin, settings, mechanisms.money.simulated);
  const lossRatios = lossRatioPlan(twin);
  const stopBasis = twin.stopHazardBasis ?? 'population prior';

  const assumptions = [];
  const bySource = new Map();
  for (const name of draw) {
    if (!bySource.has(parameterSources[name])) bySource.set(parameterSources[name], []);
    bySource.get(parameterSources[name]).push(name);
  }
  if (bySource.size === 1) {
    assumptions.push(`parameter sources: all ${draw.length} parameters: ${[...bySource.keys()][0]}`);
  } else {
    const others = [...bySource.entries()].filter(([source]) => source !== 'posterior');
    assumptions.push(`parameter sources: posterior, except ${others.map(([source, names]) => `${source}: ${names.join(', ')}`).join('; ')}`);
  }
  assumptions.push(`starting balance: ${startingBalance.rule}`);
  assumptions.push(stopBasisText(stopBasis));
  if (refuel.trigger === REFUEL_LOW_BALANCE) {
    assumptions.push('refuelTrigger lowBalance: a trade takes the balance from at or above lowBalanceStakeMultiple x the drawn baseStake to below it; the trader refuels with refuelProbability.');
  } else if (refuel.trigger === REFUEL_PROXY) {
    assumptions.push(`refuelTrigger losingStreak (proxy): ${refuel.reason}. Refuel behavior is proxied.`);
  } else {
    assumptions.push(`refuelTrigger none: ${refuel.reason}.`);
  }
  assumptions.push(`loss ratio: ${lossRatios.source}`);
  for (const [mechanism, state] of Object.entries(mechanisms)) {
    if (!state.simulated && mechanism !== 'refuel' && mechanism !== 'settlement') assumptions.push(`${mechanism} not simulated: ${state.reason}`);
  }
  assumptions.push(mechanisms.settlement.simulated
    ? 'settlement: each trade settles after a lag drawn from settlementLagMinutes and settlementLagSpread; the stake is debited at placement and the payout credited at settlement; the trader reacts only to settled outcomes, and re-enters after a settlement with the latency for that outcome.'
    : 'settlement: outcomes are known at once, before the next trade (no settled_at in training).');

  return {
    traderToken,
    simulable: true,
    sources,
    draw,
    parameterSources,
    mechanisms,
    refuel,
    startingBalance,
    lossRatios,
    stopBasis,
    assumptions
  };
}

function drawParameters(plan, runSeed, settings) {
  const salt = settings.reseedStreams.parameters ? `:${settings.reseedStreams.parameters}` : '';
  const values = {};
  for (const name of plan.draw) {
    const { distribution, center } = plan.sources[name];
    values[name] = settings.uncertainty
      ? drawValue(distribution, createRng(stableSeed(`${runSeed}:parameters:${name}${salt}`)))
      : center;
  }
  let renormalized = false;
  if (values.winRate + values.pushRate > 1) {
    const total = values.winRate + values.pushRate;
    values.winRate /= total;
    values.pushRate /= total;
    renormalized = true;
  }
  return { values, renormalized };
}

function runParameters(plan, values) {
  return {
    baseStake: values.baseStake,
    stakeDispersion: values.stakeDispersion,
    chaseCoefficient: plan.mechanisms.chase.simulated ? values.chaseCoefficient : null,
    escalationPerLoss: plan.mechanisms.escalation.simulated ? values.escalationPerLoss : null,
    reentryLatencyAfterLoss: values.reentryLatencyAfterLoss,
    reentryLatencyAfterWin: values.reentryLatencyAfterWin,
    latencySpread: values.latencySpread,
    stopHazard: Object.fromEntries(DRAWDOWN_BUCKETS.map((bucket) => [bucket, values[`stopHazard.${bucket}`]])),
    refuel: plan.refuel.parameter ? { trigger: plan.refuel.trigger, probability: values[plan.refuel.parameter] } : null,
    depositSize: plan.mechanisms.money.simulated ? values.depositSize : null,
    depositSpread: plan.mechanisms.money.simulated ? values.depositSpread : null,
    winRate: values.winRate,
    pushRate: values.pushRate,
    payoutMultiple: values.payoutMultiple,
    payoutSpread: values.payoutSpread,
    meanIdleMinutes: values.meanIdleMinutes,
    settlementLag: plan.mechanisms.settlement.simulated
      ? { medianMinutes: values.settlementLagMinutes, spread: values.settlementLagSpread }
      : null
  };
}

// --- One run ------------------------------------------------------------------------------

function makeStreams(runSeed, reseed) {
  const streams = {};
  for (const name of STREAMS) {
    if (name === 'parameters') continue;
    streams[name] = createRng(stableSeed(`${runSeed}:${name}${reseed[name] ? `:${reseed[name]}` : ''}`));
  }
  return streams;
}

function ratio(numerator, denominator) {
  return numerator === null || denominator === null || denominator === 0 ? null : numerator / denominator;
}

function toIso(seconds) {
  return new Date(seconds * 1000).toISOString();
}

// --- Hook return checks (a policy bug fails loudly instead of corrupting a run) ------------

function hookError(point, message) {
  return new TypeError(`simulateTwinV2: intervention at '${point}' ${message}`);
}

function checkSessionStart(decision) {
  if (!isPlainObject(decision) || !Number.isInteger(decision.seconds)) throw hookError(SESSION_START_POINT, 'must return { seconds } with integer seconds');
  const deposit = decision.depositCents ?? 0;
  if (!Number.isInteger(deposit) || deposit < 0) throw hookError(SESSION_START_POINT, 'returned a depositCents that is not a non-negative integer');
  return { seconds: decision.seconds, depositCents: deposit };
}

function checkStake(decision) {
  if (isPlainObject(decision) && decision.skip === true) return { skip: true };
  if (!isPlainObject(decision) || !Number.isInteger(decision.stakeCents) || decision.stakeCents < 1) {
    throw hookError('beforeStake', 'must return { stakeCents } (a positive integer) or { skip: true }');
  }
  return { skip: false, stakeCents: decision.stakeCents };
}

function checkDeposit(decision, proposed) {
  const amount = isPlainObject(decision) ? decision.amountCents : undefined;
  if (!Number.isInteger(amount) || amount < 0 || amount > proposed) {
    throw hookError('beforeDeposit', `must return { amountCents } between 0 and the proposed ${proposed}`);
  }
  return amount;
}

function checkAfterTrade(decision) {
  if (!isPlainObject(decision) || typeof decision.endSession !== 'boolean') throw hookError('afterTrade', 'must return { endSession } with a boolean');
  const resume = decision.resumeAtSeconds ?? null;
  if (resume !== null && !Number.isInteger(resume)) throw hookError('afterTrade', 'returned a resumeAtSeconds that is not an integer');
  if (decision.reset !== undefined && typeof decision.reset !== 'boolean') throw hookError('afterTrade', 'returned a reset that is not a boolean');
  if (decision.reset && resume === null) throw hookError('afterTrade', 'returned reset without resumeAtSeconds');
  return { endSession: decision.endSession, resumeAtSeconds: resume, reset: decision.reset === true };
}

/**
 * Simulates one run. p holds the run's parameters (runParameters). Money is in integer
 * cents. Draws per event, each from its own stream: outcomes 4 per trade (outcome, payout
 * normal, loss ratio), stops 1 per trade, latency 2 per trade (drawn even when the session
 * ends), stake noise 2 per intended stake, refuel 2 per trigger (decision, timing), deposits
 * 2 per intended deposit, idle 2 per session (start time, first-trade delay). With a hook,
 * "per trade" means per attempt that reaches the outcome (INTERVENTION_POINTS above).
 */
function simulateRun(plan, p, streams, context, replicate, intervention = NO_INTERVENTION) {
  const { behavior, settings } = context;
  const hook = intervention === NO_INTERVENTION ? null : intervention;
  const gapSeconds = Math.floor(behavior.sessionGapMinutes * 60);
  const windowSeconds = behavior.refuelWindowMinutes * 60;
  const refuelMaxSeconds = Math.floor(Math.min(behavior.sessionGapMinutes, behavior.refuelWindowMinutes) * 60);
  const refuelMinSeconds = Math.min(GENERATOR_RULES.minRefuelDelaySeconds, refuelMaxSeconds);
  const [delayMin, delayMax] = GENERATOR_RULES.firstTradeDelaySeconds;
  const meanExcessSeconds = Math.max(0, (p.meanIdleMinutes - behavior.sessionGapMinutes) * 60);
  const baseCents = p.baseStake * 100;
  const lowBalance = behavior.lowBalanceStakeMultiple * p.baseStake; // currency, as in the generator
  const chaseThreshold = METRIC_SETTINGS.chaseStakeMultiple * p.baseStake;
  const money = plan.mechanisms.money.simulated;
  const trigger = plan.refuel.trigger;
  const refuelProbability = p.refuel ? p.refuel.probability : 0;
  const streakLength = behavior.losingStreakLength;
  const sessionTarget = settings.sessions === null ? null
    : (typeof settings.sessions === 'number' ? settings.sessions : settings.sessions[plan.traderToken]);
  const horizonEnd = context.horizonEndSeconds;
  // Settlement mode (simulator-0.3.0, ADR-018). Off: every line below runs as in simulator-0.2.0.
  const settling = p.settlementLag !== null && p.settlementLag !== undefined;
  const pending = [];
  let settlementSeq = 0;

  const counts = {
    trades: 0, sessions: 0, wins: 0, losses: 0, pushes: 0, totalStakeCents: 0, totalResultCents: 0,
    chaseEpisodes: 0, chaseNoiseFloor: 0, depositsAfterLoss: 0, deposits: 0, depositCents: 0,
    sessionStartDeposits: 0, refuelDeposits: 0, refuelTriggers: 0, forcedStops: 0, hazardStops: 0,
    capStops: 0, interventionStops: 0, sessionsDownLarge: 0, tradesOnceDownLarge: 0
  };
  // Only runs with a hook report these (run.intervention).
  const hookCounts = { attempts: 0, skippedAttempts: 0, pausesApplied: 0, resetReturns: 0, deferredDeposits: 0, deferredDepositCents: 0 };
  const sessionDrawdowns = [];
  const days = new Set();
  const events = settings.keepEvents ? [] : null;
  const trace = settings.keepEvents ? [] : null;

  let balance = money ? plan.startingBalance.cents : 0;
  let lastOutcome = null; // previous trade's outcome, in any session
  let lastLossSeconds = null;
  let lastEventSeconds = null;
  let streak = 0; // signal-5 losing streak, across sessions; a deposit resets it
  let lowest = 0;
  let downLarge = false;

  let session = 0;
  let seconds = 0;
  let running = 0;
  let lossRun = 0;
  let tradesInSession = 0;
  let bucket = 'flat';
  const snapshot = () => ({
    traderToken: plan.traderToken, replicate, seconds, session, tradesInSession,
    balanceCents: balance, runningCents: running, lossRun, lastOutcome, bucket
  });

  const emit = (at, type, fields) => {
    lastEventSeconds = at;
    if (events) events.push({ seconds: at, type, ...fields });
  };
  const intendedStake = (runLength) => {
    let multiplier = 1;
    if (lastOutcome === 'loss' && p.chaseCoefficient !== null) multiplier *= p.chaseCoefficient;
    if (runLength >= 2 && p.escalationPerLoss !== null) multiplier *= p.escalationPerLoss ** (runLength - 1);
    return Math.max(1, Math.round(baseCents * multiplier * Math.exp(streams.stakeNoise.normal(0, p.stakeDispersion))));
  };
  // A deposit of depositSize x exp(N(0, depositSpread)), raised to `coverCents` when short.
  // A deferred deposit (only a hook makes one) has a fixed amount and draws nothing.
  const deposit = (at, kind, coverCents = 0, fixedCents = null) => {
    let amount = fixedCents;
    if (amount === null) {
      amount = Math.max(1, Math.round(p.depositSize * 100 * Math.exp(streams.deposits.normal(0, p.depositSpread))));
      if (balance + amount < coverCents) amount = coverCents - balance;
    }
    if (hook) amount = checkDeposit(hook('beforeDeposit', { kind, amountCents: amount, seconds: at }, snapshot()), amount);
    if (!(amount > 0)) return;
    emit(at, 'deposit', { amountCents: amount, beforeCents: balance, afterCents: balance + amount });
    balance += amount;
    counts.deposits += 1;
    counts.depositCents += amount;
    if (kind === 'sessionStart') counts.sessionStartDeposits += 1;
    else if (kind === 'refuel') counts.refuelDeposits += 1;
    else {
      hookCounts.deferredDeposits += 1;
      hookCounts.deferredDepositCents += amount;
    }
    if (lastLossSeconds !== null && at - lastLossSeconds <= windowSeconds) counts.depositsAfterLoss += 1;
    streak = 0;
  };
  // Settlement mode: an outcome lands. Its payout (stake + result) is credited, and the state
  // the trader reacts to moves on, in settlement order, in the session current at that time.
  const applySettlement = (item) => {
    if (money) balance += item.creditCents;
    running += item.resultCents;
    lastOutcome = item.outcome;
    lossRun = item.outcome === 'loss' ? lossRun + 1 : 0;
    streak = item.outcome === 'loss' ? streak + 1 : 0;
    if (item.outcome === 'loss') lastLossSeconds = item.at;
    if (running < lowest) lowest = running;
    bucket = drawdownBucket(running / 100, p.baseStake, behavior);
    if (bucket === 'down_large' && !downLarge && tradesInSession > 0) {
      downLarge = true;
      counts.sessionsDownLarge += 1;
    }
    if (trigger === REFUEL_PROXY && streak === streakLength) {
      counts.refuelTriggers += 1;
      const refuel = streams.refuel.next() < refuelProbability;
      streams.refuel.next();
      if (refuel) deposit(item.at + 1, 'refuel');
    }
  };
  const settleUpTo = (time) => {
    while (pending.length && pending[0].at <= time) applySettlement(pending.shift());
  };
  const schedule = (item) => {
    let index = pending.length;
    while (index > 0 && pending[index - 1].at > item.at) index -= 1;
    pending.splice(index, 0, item);
  };
  const settlementLatency = (fromSeconds, limitSeconds) => {
    const medianMinutes = lastOutcome === 'loss' ? p.reentryLatencyAfterLoss : p.reentryLatencyAfterWin;
    const latency = Math.max(GENERATOR_RULES.minLatencySeconds, Math.round(medianMinutes * 60 * Math.exp(p.latencySpread * streams.settlementLatency.normal())));
    return Math.min(limitSeconds, fromSeconds + latency);
  };

  let horizonReached = false;
  for (session = 0; sessionTarget === null || session < sessionTarget; session += 1) {
    const idleDraw = streams.idle.next();
    const delayDraw = streams.idle.next();
    if (session === 0) {
      seconds = settings.startSeconds + Math.floor(idleDraw * GENERATOR_RULES.firstSessionWithinSeconds);
    } else {
      // Strictly more than the session gap, so the signals see the same sessions.
      const excess = Math.max(1, Math.round(-Math.log(1 - idleDraw) * meanExcessSeconds));
      seconds = (lastEventSeconds ?? seconds) + gapSeconds + excess;
    }
    if (settling) settleUpTo(seconds);
    running = 0;
    lossRun = 0;
    tradesInSession = 0;
    bucket = 'flat';
    let deferredCents = 0;
    if (hook) {
      const earliestSeconds = session === 0 ? seconds : (lastEventSeconds ?? seconds) + gapSeconds + 1;
      const proposal = { seconds, earliestSeconds, lastEventSeconds: session === 0 ? null : lastEventSeconds };
      const decision = checkSessionStart(hook(SESSION_START_POINT, proposal, snapshot()));
      seconds = Math.max(earliestSeconds, decision.seconds);
      deferredCents = decision.depositCents;
    }
    if (horizonEnd !== null && seconds >= horizonEnd) break;

    const sessionStartSeconds = seconds;
    lowest = 0;
    downLarge = false;
    let attemptsInSession = 0;
    let stake = intendedStake(0);
    if (money && deferredCents > 0) deposit(seconds, 'deferred', 0, deferredCents);
    if (money && (balance / 100 < lowBalance || balance < stake)) {
      deposit(seconds, 'sessionStart', stake);
      seconds += Math.min(gapSeconds, delayMin + Math.floor(delayDraw * (delayMax - delayMin + 1)));
    }

    for (;;) {
      let skipped = false;
      if (hook) {
        const decision = checkStake(hook('beforeStake', { stakeCents: stake }, snapshot()));
        if (decision.skip) skipped = true;
        else stake = decision.stakeCents;
      }
      if (!skipped && money && stake > balance) {
        // Broke rule: the trader never stakes more than the balance.
        counts.forcedStops += 1;
        break;
      }

      // Every attempt that gets here uses its outcome draws, placed or skipped.
      const outcomeDraw = streams.outcomes.next();
      const payoutDraw = streams.outcomes.normal();
      const lossDraw = streams.outcomes.next();
      attemptsInSession += 1;
      hookCounts.attempts += 1;
      let outcome = null;
      let refuel = false;
      let timingDraw = 0;
      let triggered = false;
      if (skipped) {
        hookCounts.skippedAttempts += 1;
      } else {
        let result;
        if (outcomeDraw < p.winRate) {
          outcome = 'win';
          result = Math.max(1, Math.round(stake * p.payoutMultiple * Math.exp(p.payoutSpread * payoutDraw)));
        } else if (outcomeDraw < p.winRate + p.pushRate) {
          outcome = 'push';
          result = 0;
        } else {
          outcome = 'loss';
          result = Math.min(-1, Math.round(stake * lossRatio(plan.lossRatios.points, lossDraw)));
        }

        if (stake / 100 >= chaseThreshold) {
          if (lastOutcome === 'loss') counts.chaseEpisodes += 1;
          else if (lastOutcome === 'win') counts.chaseNoiseFloor += 1;
        }
        const before = balance;
        let settleAt = null;
        if (settling) {
          // The stake is debited now; the outcome lands after a drawn lag.
          if (money) balance -= stake;
          const lag = Math.max(0, Math.round(p.settlementLag.medianMinutes * 60 * Math.exp(p.settlementLag.spread * streams.settlement.normal())));
          settleAt = seconds + lag;
          schedule({ at: settleAt, seq: settlementSeq++, outcome, resultCents: result, creditCents: stake + result });
        } else {
          if (money) balance += result;
          running += result;
        }
        emit(seconds, 'trade', { stakeCents: stake, resultCents: result, beforeCents: before, afterCents: balance, settleAt });
        counts.trades += 1;
        counts.totalStakeCents += stake;
        counts.totalResultCents += result;
        counts[outcome === 'win' ? 'wins' : outcome === 'loss' ? 'losses' : 'pushes'] += 1;
        if (downLarge) counts.tradesOnceDownLarge += 1;
        days.add(Math.floor(seconds / DAY_SECONDS));
        tradesInSession += 1;
        if (settling) {
          settleUpTo(seconds); // a zero lag settles at once
        } else {
          lastOutcome = outcome;
          lossRun = outcome === 'loss' ? lossRun + 1 : 0;
          streak = outcome === 'loss' ? streak + 1 : 0;
          if (outcome === 'loss') lastLossSeconds = seconds;
          if (running < lowest) lowest = running;
          bucket = drawdownBucket(running / 100, p.baseStake, behavior);
          if (bucket === 'down_large' && !downLarge) {
            downLarge = true;
            counts.sessionsDownLarge += 1;
          }
        }

        // In settlement mode the losing-streak trigger fires when the streak completes (applySettlement).
        triggered = trigger === REFUEL_LOW_BALANCE
          ? before / 100 >= lowBalance && balance / 100 < lowBalance
          : !settling && trigger === REFUEL_PROXY && streak === streakLength;
        if (triggered) {
          counts.refuelTriggers += 1;
          refuel = streams.refuel.next() < refuelProbability;
          timingDraw = streams.refuel.next();
        }
      }
      const stopDraw = streams.stops.next();
      const latencyDraw = streams.latency.normal();
      // Time to the next attempt, from the latency for the last outcome (after-win after a push).
      const medianMinutes = lastOutcome === 'loss' ? p.reentryLatencyAfterLoss : p.reentryLatencyAfterWin;
      const latency = Math.min(gapSeconds, Math.max(GENERATOR_RULES.minLatencySeconds,
        Math.round(medianMinutes * 60 * Math.exp(p.latencySpread * latencyDraw))));

      // The trader's own stop decision comes first; a policy can end or pause, not overrule it.
      let ends = null;
      if (stopDraw < p.stopHazard[bucket]) ends = 'hazard';
      else if (attemptsInSession >= settings.maxTradesPerSession) ends = 'cap';
      let decision = null;
      if (hook && !skipped) {
        decision = checkAfterTrade(hook('afterTrade', { endSession: ends !== null }, snapshot()));
        if (!ends && decision.endSession) ends = 'intervention';
      }
      if (trace) {
        const row = { session, outcome, stakeCents: stake, outcomeDraw, payoutDraw, lossDraw, stopDraw, latencyDraw, latencySeconds: latency, bucket, triggered, refuel, ends };
        if (hook) Object.assign(row, { seconds, skipped, runningCents: running, resumeAtSeconds: ends ? null : decision?.resumeAtSeconds ?? null, reset: ends ? false : decision?.reset ?? false });
        trace.push(row);
      }
      if (ends) {
        counts[`${ends}Stops`] += 1;
        if (refuel) deposit(settling ? seconds + 1 : seconds + refuelMinSeconds + Math.floor(timingDraw * (refuelMaxSeconds - refuelMinSeconds + 1)), 'refuel');
        break;
      }

      const reset = decision !== null && decision.reset;
      let next;
      if (settling) {
        // The refuel deposit lands a second after the trigger trade. Each outcome that settles
        // before the next attempt moves it: the trader re-enters after the latency for that
        // outcome, from its settlement, within the session gap. The next stake is set then.
        if (refuel) deposit(seconds + 1, 'refuel');
        const limit = seconds + gapSeconds;
        let candidate = seconds + latency;
        while (pending.length && pending[0].at <= candidate) {
          const at = pending[0].at;
          settleUpTo(at);
          candidate = Math.max(at, settlementLatency(at, limit));
        }
        seconds = candidate;
        settleUpTo(seconds);
        next = intendedStake(reset ? 0 : lossRun);
      } else {
        next = intendedStake(reset ? 0 : lossRun);
        // The refuel deposit lands between this trade and the next, so it doesn't move trade timing.
        if (refuel) deposit(seconds + 1 + Math.floor(timingDraw * (latency - 1)), 'refuel');
        seconds += latency;
      }
      if (decision !== null && decision.resumeAtSeconds !== null) {
        // A pause: the next attempt comes when the latency or the pause ends, whichever is later.
        hookCounts.pausesApplied += 1;
        if (decision.resumeAtSeconds > seconds) seconds = decision.resumeAtSeconds;
        if (horizonEnd !== null && seconds >= horizonEnd) {
          horizonReached = true;
          break;
        }
        if (reset) {
          // The return starts a new session: the reference point starts over.
          hookCounts.resetReturns += 1;
          counts.sessions += 1;
          sessionDrawdowns.push(-lowest / 100);
          session += 1;
          running = 0;
          lossRun = 0;
          tradesInSession = 0;
          attemptsInSession = 0;
          bucket = 'flat';
          lowest = 0;
          downLarge = false;
        }
      }
      stake = next;
    }

    if (tradesInSession > 0) {
      counts.sessions += 1;
      sessionDrawdowns.push(-lowest / 100);
    } else if (lastEventSeconds === null || lastEventSeconds < sessionStartSeconds) {
      // A session with no event moves the clock: the next idle time runs from its start.
      // Without a hook every session trades (the session-start deposit covers the first
      // stake), so this only happens when a policy reduces that deposit.
      lastEventSeconds = sessionStartSeconds;
    }
    if (horizonReached) break;
  }

  const maxDrawdown = sessionDrawdowns.length ? Math.max(...sessionDrawdowns) : null;
  const moneyValue = (value) => (money ? value : null);
  const metrics = {
    maxSessionDrawdown: maxDrawdown,
    maxSessionDrawdownStakes: maxDrawdown === null ? null : maxDrawdown / p.baseStake,
    chaseEpisodes: counts.chaseEpisodes,
    chaseNoiseFloor: counts.chaseNoiseFloor,
    depositsAfterLoss: moneyValue(counts.depositsAfterLoss),
    totalNetLoss: -counts.totalResultCents / 100,
    forcedStops: moneyValue(counts.forcedStops),
    trades: counts.trades,
    totalStake: counts.totalStakeCents / 100,
    sessions: counts.sessions,
    activeDays: days.size,
    deposits: moneyValue(counts.deposits),
    depositAmount: moneyValue(counts.depositCents / 100),
    sessionStartDeposits: moneyValue(counts.sessionStartDeposits),
    refuelDeposits: moneyValue(counts.refuelDeposits),
    hazardStops: counts.hazardStops,
    capStops: counts.capStops,
    wins: counts.wins,
    losses: counts.losses,
    pushes: counts.pushes,
    sessionsDownLarge: counts.sessionsDownLarge,
    tradesOnceDownLarge: counts.tradesOnceDownLarge,
    tradesPerSession: ratio(counts.trades, counts.sessions),
    meanStake: ratio(counts.totalStakeCents / 100, counts.trades),
    winShare: ratio(counts.wins, counts.trades),
    chaseEpisodesPerSession: ratio(counts.chaseEpisodes, counts.sessions),
    forcedStopsPerSession: money ? ratio(counts.forcedStops, counts.sessions) : null,
    refuelDepositsPerSession: money ? ratio(counts.refuelDeposits, counts.sessions) : null,
    depositsAfterLossPerSession: money ? ratio(counts.depositsAfterLoss, counts.sessions) : null,
    tradesPerSessionOnceDownLarge: ratio(counts.tradesOnceDownLarge, counts.sessionsDownLarge),
    medianSessionDrawdown: median(sessionDrawdowns)
  };

  const run = { metrics, refuelTriggers: counts.refuelTriggers };
  if (hook) run.intervention = { ...hookCounts, interventionStops: counts.interventionStops, horizonReachedInPause: horizonReached };
  if (events) {
    run.events = events.map((event, index) => {
      const row = {
        event_id: `sim_${replicate}_${String(index + 1).padStart(6, '0')}`,
        trader_token: plan.traderToken,
        occurred_at: toIso(event.seconds),
        type: event.type,
        venue_id: 'simulated'
      };
      if (event.type === 'trade') {
        row.stake_amount = event.stakeCents / 100;
        row.realized_result = event.resultCents / 100;
        if (event.settleAt !== null && event.settleAt !== undefined) row.settled_at = toIso(event.settleAt);
      } else {
        row.deposit_amount = event.amountCents / 100;
      }
      if (money) {
        row.balance_before = event.beforeCents / 100;
        row.balance_after = event.afterCents / 100;
      }
      row.source_row_number = index + 1;
      return row;
    });
    run.trace = trace;
  }
  return run;
}

// --- Summaries --------------------------------------------------------------------------------

function sortedQuantile(sorted, p) {
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

/** median, p10, p90, mean, and n of the finite values; nulls when there are none. */
export function summarizeDistribution(values) {
  const known = values.filter((value) => value !== null && Number.isFinite(value)).sort((a, b) => a - b);
  if (!known.length) return { median: null, p10: null, p90: null, mean: null, n: 0 };
  return {
    median: sortedQuantile(known, 0.5),
    p10: sortedQuantile(known, 0.1),
    p90: sortedQuantile(known, 0.9),
    mean: sum(known) / known.length,
    n: known.length
  };
}

function aggregate(metricsList, name, population) {
  if (population.kind === 'ratio') {
    let numerator = 0;
    let denominator = 0;
    for (const metrics of metricsList) {
      const top = metrics[population.numerator];
      const bottom = metrics[population.denominator];
      if (top === null || bottom === null) continue;
      numerator += top;
      denominator += bottom;
    }
    return denominator > 0 ? numerator / denominator : null;
  }
  const values = metricsList.map((metrics) => metrics[name]).filter((value) => value !== null);
  if (!values.length) return null;
  return population.kind === 'sum' ? sum(values) : sum(values) / values.length;
}

function populationSummary(runsByTrader, replicates) {
  const metrics = {};
  for (const [name, spec] of Object.entries(SIMULATION_METRICS)) {
    const perReplicate = [];
    for (let replicate = 0; replicate < replicates; replicate += 1) {
      perReplicate.push(aggregate(runsByTrader.map((runs) => runs[replicate].metrics), name, spec.population));
    }
    metrics[name] = summarizeDistribution(perReplicate);
  }
  return { traders: runsByTrader.length, metrics };
}

function globalAssumptions(settings) {
  return [
    'Simulation under stated assumptions: not a causal estimate, and not a forecast for any real trader.',
    settings.uncertainty
      ? 'Each run draws every parameter once, at its start, from the parameter\'s stored posterior (normal: exp(N(mean, sd)); beta: Beta(a, b); inverse-gamma: offsetMinutes + scale / Gamma(shape)), never from interval endpoints. Draws are independent across parameters because only marginal posteriors are stored. The stop-hazard buckets were fitted with a shared stop propensity, so independent bucket draws ignore that correlation.'
      : 'Uncertainty off: every run uses each parameter\'s stored estimate (its posterior center), so the bands show process noise only.',
    'If a drawn winRate + pushRate exceeds 1, both are rescaled to sum to 1 (counted per trader in renormalizedRuns).',
    'Idle time between sessions is sessionGapMinutes + Exponential(meanIdleMinutes - sessionGapMinutes), the estimator\'s model. The synthetic generator uses minIdle + Exponential: the same mean, a different shape.',
    'Latency is lognormal with the after-loss or after-win median (the after-win median after a push) and latencySpread, rounded to whole seconds and clamped to [2 s, sessionGapMinutes]. The chase term follows a realized loss in any session; losing runs, and so escalation, reset at session boundaries.',
    'Generator rules used where twin-0.2.1 has no estimate (docs/BEHAVIORAL-SYNTHETIC.md): the first session starts at a uniform time within 24 hours of the start; a session starts with a deposit when the balance is below lowBalanceStakeMultiple x the drawn baseStake or below the first stake, raised to cover that stake if short, and the first trade follows 1 to 5 minutes later; a refuel deposit lands between the trigger trade and the next trade, or 1 minute to min(sessionGapMinutes, refuelWindowMinutes) after it when the session ends there; the broke rule ends a session when the next stake exceeds the balance (stakes are never capped); stakes are rounded to cents, at least 1 cent, and a win pays at least 1 cent; a session ends after maxTradesPerSession trades.',
    'Bands are the 10th and 90th percentiles across replicates. Population bands sum each replicate across traders first (drawdowns are averaged across traders), then take percentiles.'
  ];
}

function summarizeTrader(plan, runs, dataLabel, settings) {
  const metrics = Object.fromEntries(SIMULATION_METRIC_NAMES.map((name) => [name, summarizeDistribution(runs.map((run) => run.metrics[name]))]));
  const result = {
    traderToken: plan.traderToken,
    dataLabel,
    simulable: true,
    stopBasis: plan.stopBasis,
    refuelTrigger: plan.refuel.trigger,
    startingBalance: { amount: plan.startingBalance.amount, rule: plan.startingBalance.rule },
    lossRatioSource: plan.lossRatios.source,
    parameterSources: plan.parameterSources,
    mechanisms: plan.mechanisms,
    assumptions: plan.assumptions,
    renormalizedRuns: runs.filter((run) => run.renormalized).length,
    metrics
  };
  if (settings.keepRuns || settings.keepEvents) result.runs = runs;
  return result;
}

// --- Entry points --------------------------------------------------------------------------------

/**
 * Validates the fit and options and plans every trader, without simulating. Shared by
 * simulateTwinV2 and the policy layer (policy-sim.mjs), so both run exactly the same code.
 * Returns { settings, behavior, context, plans, assumptions }; each plan is internal.
 * Throws on an invalid fit or options.
 */
export function prepareSimulation(fit, options = {}) {
  validateFit(fit);
  const settings = resolveOptions(fit, options);
  const behavior = { ...DEFAULT_BEHAVIOR_OPTIONS, ...fit.behaviorOptions };
  const context = { behavior, settings, horizonEndSeconds: settings.horizonEndSeconds };
  return {
    settings,
    behavior,
    context,
    plans: settings.twins.map((twin) => planTrader(twin, settings, behavior)),
    assumptions: globalAssumptions(settings)
  };
}

/**
 * One run of one simulable trader: replicate `replicate` of `plan` from prepareSimulation.
 * makeIntervention, when given, is called once with runInfo { traderToken, replicate,
 * runSeed, parameters, moneySimulated, behavior, horizonEndSeconds, policyStream } and
 * returns the run's hook (INTERVENTION_POINTS, SESSION_START_POINT). Without it the run
 * uses NO_INTERVENTION and is exactly a simulateTwinV2 run. Returns { replicate, seed,
 * renormalized, parameters, metrics, refuelTriggers }, plus `intervention` (hook
 * accounting) with a hook, and events and trace with keepEvents.
 */
export function simulateReplicate(prepared, plan, replicate, makeIntervention = null) {
  const { settings, context } = prepared;
  const runSeed = stableSeed(`${settings.seed}:${plan.traderToken}:${replicate}`);
  const { values, renormalized } = drawParameters(plan, runSeed, settings);
  const parameters = runParameters(plan, values);
  const streams = makeStreams(runSeed, settings.reseedStreams);
  const intervention = makeIntervention === null ? NO_INTERVENTION : makeIntervention({
    traderToken: plan.traderToken,
    replicate,
    runSeed,
    parameters,
    moneySimulated: plan.mechanisms.money.simulated,
    behavior: context.behavior,
    horizonEndSeconds: context.horizonEndSeconds,
    policyStream: streams.policy
  });
  const run = simulateRun(plan, parameters, streams, context, replicate, intervention);
  return { replicate, seed: runSeed, renormalized, parameters, ...run };
}

/**
 * Simulates every twin in an estimateTwins fit (model twin-0.2.1). Options are in
 * SIMULATION_DEFAULTS. Returns { dataLabel, modelVersion, simulatorVersion,
 * behaviorVersion, seed, replicates, uncertainty, horizon, start, maxTradesPerSession,
 * reseedStreams, claim, assumptions, metricDefinitions, traders, population }.
 *
 * Each trader is { traderToken, dataLabel, simulable: false, reasons } or a simulable
 * trader with its stopBasis, refuelTrigger, startingBalance, lossRatioSource,
 * parameterSources, mechanisms, assumptions, renormalizedRuns, and metrics (each
 * { median, p10, p90, mean, n } across replicates); with keepRuns, also its runs.
 * population.metrics aggregates the simulable traders replicate by replicate.
 * Throws on an invalid fit or options.
 */
export function simulateTwinV2(fit, options = {}) {
  const prepared = prepareSimulation(fit, options);
  const { settings } = prepared;

  const traders = [];
  const runsByTrader = [];
  for (const plan of prepared.plans) {
    if (!plan.simulable) {
      traders.push({ traderToken: plan.traderToken, dataLabel: fit.dataLabel, simulable: false, reasons: plan.reasons });
      continue;
    }
    const runs = [];
    for (let replicate = 0; replicate < settings.replicates; replicate += 1) runs.push(simulateReplicate(prepared, plan, replicate));
    traders.push(summarizeTrader(plan, runs, fit.dataLabel, settings));
    runsByTrader.push(runs);
  }

  return {
    dataLabel: fit.dataLabel,
    modelVersion: fit.modelVersion,
    simulatorVersion: SIMULATOR_VERSION,
    behaviorVersion: fit.behaviorVersion ?? null,
    seed: settings.seed,
    replicates: settings.replicates,
    uncertainty: settings.uncertainty,
    horizon: settings.horizon,
    start: settings.start,
    maxTradesPerSession: settings.maxTradesPerSession,
    reseedStreams: { ...settings.reseedStreams },
    claim: 'Simulation under stated assumptions. Not a causal claim.',
    assumptions: prepared.assumptions,
    metricDefinitions: SIMULATION_METRICS,
    traders,
    population: {
      ...populationSummary(runsByTrader, settings.replicates),
      notSimulable: traders.filter((trader) => !trader.simulable).length
    }
  };
}

/**
 * The old simulateTwin (twin.mjs), unchanged, with its output labelled baseline-0.1 so
 * reports can compare it with simulateTwinV2.
 */
export function simulateBaseline(twin, options = {}) {
  return { simulatorVersion: BASELINE_SIMULATOR_VERSION, ...simulateTwin(twin, options) };
}

/**
 * Each trader's last observed balance_after (by time, then source_row_number), for the
 * startingBalances option. Traders without a balance_after are left out.
 */
export function lastObservedBalances(events) {
  const latest = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || event.trader_token === undefined || event.trader_token === null || event.trader_token === '') continue;
    if (!Number.isFinite(event.balance_after)) continue;
    const t = Date.parse(event.occurred_at);
    if (Number.isNaN(t)) continue;
    const row = Number.isFinite(event.source_row_number) ? event.source_row_number : -Infinity;
    const token = String(event.trader_token);
    const current = latest.get(token);
    if (!current || t > current.t || (t === current.t && row >= current.row)) latest.set(token, { t, row, balance: event.balance_after });
  }
  return Object.fromEntries([...latest.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([token, { balance }]) => [token, balance]));
}

/**
 * The event-observable simulation metrics, computed from analytical events (observed
 * training data, or a run's events) with the same definitions the simulator uses.
 * Stop causes and deposit kinds need the simulator's internal decisions, so forcedStops,
 * hazardStops, capStops, sessionStartDeposits, and refuelDeposits are not returned.
 *
 * options: baseStakes (traderToken -> baseStake, for chase episodes, drawdowns in base
 * stakes, and the down_large bucket) and behaviorOptions. Returns traderToken -> metrics.
 */
export function metricsFromEvents(events, options = {}) {
  const baseStakes = options.baseStakes ?? {};
  const records = buildBehaviorObservations(events, options.behaviorOptions ?? {});
  const output = {};
  for (const record of records) {
    const behavior = record.options;
    const windowMs = behavior.refuelWindowMinutes * 60000;
    const baseStake = Number.isFinite(baseStakes[record.traderToken]) ? baseStakes[record.traderToken] : null;
    const threshold = baseStake === null ? null : METRIC_SETTINGS.chaseStakeMultiple * baseStake;
    const { trades } = record;
    const tradeSessions = record.sessions.filter((session) => session.tradeCount > 0);
    const drawdowns = tradeSessions.filter((session) => session.complete).map((session) => session.maxDrawdown);
    const count = (outcome) => trades.filter((trade) => trade.outcome === outcome).length;
    const chase = (previous) => (threshold === null ? null
      : trades.filter((trade) => trade.previousOutcome === previous && trade.stake !== null && trade.stake >= threshold).length);
    const positiveDeposits = record.deposits.filter((item) => item.refuel);

    let depositsAfterLoss = 0;
    let pointer = 0;
    let lastLoss = null;
    for (const item of positiveDeposits) {
      while (pointer < trades.length && trades[pointer].action < item.action) {
        if (trades[pointer].outcome === 'loss') lastLoss = trades[pointer].t;
        pointer += 1;
      }
      if (lastLoss !== null && item.t - lastLoss <= windowMs) depositsAfterLoss += 1;
    }

    let sessionsDownLarge = null;
    let tradesOnceDownLarge = null;
    if (baseStake !== null) {
      sessionsDownLarge = 0;
      tradesOnceDownLarge = 0;
      let current = null;
      let reached = false;
      for (const trade of trades) {
        if (trade.session !== current) {
          current = trade.session;
          reached = false;
        }
        if (reached) tradesOnceDownLarge += 1;
        if (!reached && trade.running !== null && drawdownBucket(trade.running, baseStake, behavior) === 'down_large') {
          reached = true;
          sessionsDownLarge += 1;
        }
      }
    }

    const sessions = tradeSessions.length;
    const tradeCount = trades.length;
    const totalStake = sum(trades.map((trade) => trade.stake ?? 0));
    const wins = count('win');
    const maxDrawdown = drawdowns.length ? Math.max(...drawdowns) : null;
    output[record.traderToken] = {
      maxSessionDrawdown: maxDrawdown,
      maxSessionDrawdownStakes: maxDrawdown === null || baseStake === null ? null : maxDrawdown / baseStake,
      chaseEpisodes: chase('loss'),
      chaseNoiseFloor: chase('win'),
      depositsAfterLoss,
      totalNetLoss: trades.every((trade) => trade.result !== null) ? -sum(trades.map((trade) => trade.result)) : null,
      trades: tradeCount,
      totalStake,
      sessions,
      activeDays: new Set(trades.map((trade) => Math.floor(trade.t / 86400000))).size,
      deposits: positiveDeposits.length,
      depositAmount: sum(positiveDeposits.map((item) => item.amount ?? 0)),
      wins,
      losses: count('loss'),
      pushes: count('push'),
      sessionsDownLarge,
      tradesOnceDownLarge,
      tradesPerSession: ratio(tradeCount, sessions),
      meanStake: ratio(totalStake, tradeCount),
      winShare: ratio(wins, trades.filter((trade) => trade.outcome !== null).length),
      chaseEpisodesPerSession: ratio(chase('loss'), sessions),
      depositsAfterLossPerSession: ratio(depositsAfterLoss, sessions),
      tradesPerSessionOnceDownLarge: ratio(tradesOnceDownLarge, sessionsDownLarge),
      medianSessionDrawdown: median(drawdowns)
    };
  }
  return output;
}
