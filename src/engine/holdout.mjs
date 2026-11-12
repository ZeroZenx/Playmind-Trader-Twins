/**
 * Held-out validation, version holdout-0.1.0 (ADR-014).
 *
 * runHoldoutValidation(events, options) fits twins on each trader's earlier data,
 * simulates the later period, and compares what the models simulate with what the trader
 * then did. It returns evidence about a model on stated data: never an accuracy
 * headline, and never a causal claim.
 *
 * Split. Time-based per trader, never random. A trader's active period runs from their
 * first to their last trade, deposit, or withdrawal. The cut is the start of the first
 * session (behavior-0.2.0's sessionGapMinutes rule) that starts at or after trainShare
 * (default 0.75) of the way through it, so no session is cut in half. Events before the
 * cut train; events at or after it test. Because the period ends at the trader's last
 * event, every trader is active through their whole test window: the twin is not tested
 * on churn. A trader whose windows are too small gets null plus a reason.
 *
 * Models.
 * - twin: twin-0.2.1 from estimateTwins on every trader's training events, simulated with
 *   simulator-0.2.0 (uncertainty on) from the trader's cut for their test window length
 *   in days, starting at their last observed training balance_after.
 * - baseline: baseline-0.1 (simulateBaseline on buildTwins(buildSignals(training
 *   events))), through the adapter baselineEventsToAnalytical.
 * - naive: naive-0.1, each trader's training value of each metric, with no dependence on
 *   the last outcome (NAIVE_DEFINITION).
 * - truth: SYNTHETIC only, an optional reference fit on the generator's true parameters,
 *   uncertainty off. It is the best this model shape can do.
 *
 * Comparison. Observed and simulated values come from events through the same function,
 * holdoutEventMetrics (buildBehaviorObservations and metricsFromEvents), with every stake
 * scaled by the training fit's estimated baseStake on both sides. Only event-observable
 * quantities are compared: forced stops, refuel deposits, and stop causes are simulator
 * decisions that real data doesn't show. Each metric gets quantiles with simulated bands,
 * the two-sample KS statistic D (no p-value), per-trader calibration (observed value
 * inside the simulated p10-p90 band), and each model's point error. summarizeHoldout
 * turns that into pass/fail against tolerances and says whether the twin beats both
 * baseline-0.1 and naive-0.1.
 *
 * Pure and deterministic: no I/O, and the same events and options give the same result.
 */

import { BEHAVIOR_VERSION, buildBehaviorObservations } from './behavior.mjs';
import { DATA_LABELS, TWIN_MODEL_VERSION, estimateTwins } from './estimate.mjs';
import { stableSeed } from './rng.mjs';
import {
  BASELINE_SIMULATOR_VERSION,
  SIMULATOR_VERSION,
  lastObservedBalances,
  metricsFromEvents,
  prepareSimulation,
  simulateBaseline,
  simulateReplicate,
  summarizeDistribution
} from './simulate.mjs';
import { buildSignals } from './signals.mjs';
import { mean, median } from './stats.mjs';
import { buildTwins } from './twin.mjs';

export const HOLDOUT_VERSION = 'holdout-0.1.0';
export const NAIVE_MODEL_VERSION = 'naive-0.1';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/**
 * Tolerances for summarizeHoldout. Set before any result was seen; don't loosen them
 * until the twin passes (ADR-014).
 * - coverage: the share of traders whose observed test value lies inside their simulated
 *   p10-p90 band, nominally 0.8. continuous for metrics without many ties; ties for
 *   metrics whose ties put more values inside the band, so only the floor binds.
 * - maxKsD: the largest acceptable KS distance between the observed and simulated
 *   distributions.
 * - errorMargin, dMargin: how much better the twin must be to beat a comparator. The twin
 *   wins on point error when its median absolute error is below the comparator's x
 *   (1 - errorMargin), and on distribution when its D is below the comparator's D - dMargin.
 * - beatsShare: the twin beats a comparator overall when it beats it on more than this
 *   share of the compared metrics.
 * - passShare: calibration and distribution pass overall when at least this share of the
 *   scored metrics pass.
 */
export const HOLDOUT_TOLERANCES = deepFreeze({
  nominalCoverage: 0.8,
  coverage: { continuous: [0.65, 0.95], ties: [0.65, 1] },
  maxKsD: 0.1,
  errorMargin: 0,
  dMargin: 0,
  beatsShare: 0.5,
  passShare: 1
});

export const HOLDOUT_DEFAULTS = deepFreeze({
  // Split (splitHoldout).
  trainShare: 0.75,
  minTrainSessions: 2,
  minTestSessions: 3,
  minTestTrades: 10,
  // The simulator starts its first session at a uniform time within 24 hours of the start
  // (GENERATOR_RULES), so a test window shorter than a day can't be simulated fairly.
  minTestDays: 1,
  // Simulation.
  seed: 20261116,
  replicates: 200,
  // The pooled simulated sample behind each KS statistic uses the first ksReplicates
  // replicates, so memory doesn't grow with the replicate count.
  ksReplicates: 50,
  // A trader's simulated point and band need a value in at least this share of replicates.
  minReplicateShare: 0.5,
  // Comparators. naive and baseline are on by default; the claim needs both.
  baseline: true,
  naive: true,
  // SYNTHETIC only: { fit } shaped like an estimateTwins fit (truth-twins.mjs).
  reference: null,
  behaviorOptions: {},
  tolerances: HOLDOUT_TOLERANCES,
  includeTraders: false,
  onProgress: null
});

const SPLIT_OPTION_KEYS = Object.freeze(['trainShare', 'minTrainSessions', 'minTestSessions', 'minTestTrades', 'minTestDays', 'behaviorOptions']);

export const SPLIT_RULE = 'Time-based per trader, never random. The active period runs from the trader\'s first to last trade, deposit, or withdrawal. The cut is the start of the first session (sessionGapMinutes rule) that starts at or after trainShare of the way through the active period, so no session is split. Events before the cut train; events at or after it test.';

export const CHURN_CAVEAT = 'The active period ends at each trader\'s last event, so every trader is active through their whole test window by construction. The twin is not tested on churn: whether a trader stops coming back is outside this validation.';

/**
 * The compared metrics. level 'unit' metrics have one value per trade, session, or gap;
 * level 'trader' metrics have one value per trader. ties marks metrics whose many tied
 * values put more traders inside a band (as CALIBRATION_METRICS' count flag does).
 * scored: false marks a diagnostic metric, reported but left out of pass/fail and "beats".
 */
export const HOLDOUT_METRICS = deepFreeze({
  stakeAfterLoss: {
    level: 'unit', unit: 'trade', scale: 'stake / training baseStake', ties: false, scored: true,
    sample: 'Each trade whose previous trade (in any session) was a realized loss: its stake divided by the training fit\'s baseStake.',
    traderStatistic: 'median'
  },
  stakeAfterWin: {
    level: 'unit', unit: 'trade', scale: 'stake / training baseStake', ties: false, scored: true,
    sample: 'Each trade whose previous trade (in any session) was a realized win: its stake divided by the training fit\'s baseStake.',
    traderStatistic: 'median'
  },
  stakeLossMinusWin: {
    level: 'trader', unit: 'trader', scale: 'stake / training baseStake', ties: false, scored: true,
    sample: 'One value per trader: the median stake after a loss minus the median stake after a win (signal 1\'s lossMinusWin, on the training baseStake scale).',
    traderStatistic: 'the value itself'
  },
  tradesPerSession: {
    level: 'unit', unit: 'session', scale: 'trades', ties: true, scored: true,
    sample: 'Trades in each session with at least one trade: session length in trades.',
    traderStatistic: 'mean (metricsFromEvents tradesPerSession)'
  },
  sessionMinutes: {
    level: 'unit', unit: 'session', scale: 'minutes', ties: false, scored: true,
    sample: 'Minutes from the first to the last event of each session with at least one trade.',
    traderStatistic: 'median'
  },
  interTradeMinutes: {
    level: 'unit', unit: 'within-session gap', scale: 'minutes', ties: false, scored: true,
    sample: 'Minutes between consecutive trades in the same session.',
    traderStatistic: 'median'
  },
  depositsAfterLoss: {
    level: 'unit', unit: 'session', scale: 'deposits', ties: true, scored: true, money: true,
    sample: 'Deposits within refuelWindowMinutes after a realized loss, counted in the session each deposit falls in, for each session with at least one trade.',
    traderStatistic: 'per session (metricsFromEvents depositsAfterLossPerSession)'
  },
  idleMinutes: {
    level: 'unit', unit: 'between-session gap', scale: 'minutes', ties: false, scored: false,
    sample: 'Minutes from one session\'s last event to the next session\'s first event, within the window. Diagnostic: shows the session-timing shape.',
    traderStatistic: 'median'
  }
});

export const HOLDOUT_METRIC_NAMES = Object.freeze(Object.keys(HOLDOUT_METRICS));

/** Known differences between the simulator's shape and the synthetic generator's (ADR-012 point 7). */
export const SYNTHETIC_SHAPE_DIFFERENCES = deepFreeze({
  idleMinutes: 'Idle time between sessions: the simulator draws sessionGapMinutes + Exponential(meanIdleMinutes - sessionGapMinutes); the generator draws max(sessionGapMinutes, refuelWindowMinutes) + 1 minute + Exponential. Same mean, different shape, so this mismatch is expected even with true parameters.',
  depositsAfterLoss: 'A simulated idle time can be shorter than refuelWindowMinutes, so a session-start deposit can land within the refuel window after the previous session\'s last loss. The generator\'s minimum idle time rules that out. Expect more simulated deposits after a loss, even with true parameters.'
});

export const NAIVE_DEFINITION = 'naive-0.1 repeats each trader\'s training values with no dependence on the last outcome. Point prediction per trader and metric: the same per-trader statistic computed on the trader\'s training events with the same definitions, except that stake after a loss and stake after a win are both the median of every training stake / training baseStake, and their difference is 0. Distribution: the pooled training sample (every training stake for both stake metrics; 0 per trader for the difference). It has no band, so it gets no calibration.';

export const BASELINE_ADAPTER = 'baseline-0.1 adapter: simulateBaseline runs buildTwins(buildSignals(training events)) for max(1, test days) days; its first session is at its hard-coded 2026-01-01T12:00Z start, so every event is shifted by (cut - that start) and the first session lands on the cut. Events are mapped to the analytical schema (occurredAt -> occurred_at, stakeAmount -> stake_amount, realizedResult -> realized_result, amount -> deposit_amount), with a fresh event_id, the trader token, venue_id simulated-baseline-0.1, and source_row_number; marketType is dropped (market fields are optional). It has no balances. Its sessions sit at fixed hours, so a long session can run into the next one, and the event data then sees one session: we keep what its events say. Replicates vary its seed: stableSeed(seed:baseline-0.1:traderToken:replicate).';

export const BASELINE_START = '2026-01-01T12:00:00.000Z';

const QUANTILE_POINTS = Object.freeze([0.1, 0.25, 0.5, 0.75, 0.9]);
const SLACK = 1e-9;
const DAY_MS = 86400000;
const MINUTE_MS = 60000;
const TRADER_ACTIONS = new Set(['trade', 'deposit', 'withdrawal']);
const MODEL_KEYS = Object.freeze(['twin', 'baseline', 'naive', 'truth']);
const COMPARATORS = Object.freeze(['baseline', 'naive']);

const qKey = (p) => `p${Math.round(p * 100)}`;

// --- Validation ------------------------------------------------------------------------

function fail(caller, message, ErrorType = RangeError) {
  throw new ErrorType(`${caller}: ${message}`);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value >= 1;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function resolveSplitOptions(options, caller) {
  const supplied = Object.fromEntries(Object.entries(options ?? {}).filter(([, value]) => value !== undefined));
  const settings = Object.fromEntries(SPLIT_OPTION_KEYS.map((key) => [key, supplied[key] ?? HOLDOUT_DEFAULTS[key]]));
  if (!(isFiniteNumber(settings.trainShare) && settings.trainShare > 0 && settings.trainShare < 1)) fail(caller, 'trainShare must be a number between 0 and 1 (exclusive)');
  if (!isPositiveInteger(settings.minTrainSessions)) fail(caller, 'minTrainSessions must be a positive integer');
  if (!isPositiveInteger(settings.minTestSessions)) fail(caller, 'minTestSessions must be a positive integer');
  if (!(Number.isInteger(settings.minTestTrades) && settings.minTestTrades >= 0)) fail(caller, 'minTestTrades must be a non-negative integer');
  if (!(isFiniteNumber(settings.minTestDays) && settings.minTestDays > 0)) fail(caller, 'minTestDays must be a positive number');
  if (!isPlainObject(settings.behaviorOptions)) fail(caller, 'behaviorOptions must be an object', TypeError);
  return settings;
}

function resolveTolerances(supplied, caller) {
  if (supplied === undefined || supplied === null) return HOLDOUT_TOLERANCES;
  if (!isPlainObject(supplied)) fail(caller, 'tolerances must be an object', TypeError);
  for (const key of Object.keys(supplied)) {
    if (!Object.hasOwn(HOLDOUT_TOLERANCES, key)) fail(caller, `unknown tolerance "${key}"`);
  }
  const coverage = { ...HOLDOUT_TOLERANCES.coverage, ...(supplied.coverage ?? {}) };
  const tolerances = { ...HOLDOUT_TOLERANCES, ...supplied, coverage };
  for (const kind of ['continuous', 'ties']) {
    const range = coverage[kind];
    if (!Array.isArray(range) || range.length !== 2 || !range.every((value) => isFiniteNumber(value) && value >= 0 && value <= 1) || range[0] > range[1]) {
      fail(caller, `tolerances.coverage.${kind} must be [low, high] with 0 <= low <= high <= 1`);
    }
  }
  for (const key of Object.keys(coverage)) {
    if (!['continuous', 'ties'].includes(key)) fail(caller, `unknown coverage tolerance "${key}"`);
  }
  const check = (key, low, high) => {
    if (!(isFiniteNumber(tolerances[key]) && tolerances[key] >= low && tolerances[key] <= high)) fail(caller, `tolerances.${key} must be a number in [${low}, ${high}]`);
  };
  check('nominalCoverage', 0, 1);
  check('maxKsD', 0, 1);
  check('errorMargin', 0, 1);
  check('dMargin', 0, 1);
  check('beatsShare', 0, 1);
  check('passShare', 0, 1);
  return deepFreeze(tolerances);
}

// --- Small numeric helpers -------------------------------------------------------------

// Only finite numbers: a null is dropped, never read as 0.
function finiteSorted(values) {
  const kept = [];
  for (const value of values) if (isFiniteNumber(value)) kept.push(value);
  const sorted = Float64Array.from(kept);
  sorted.sort();
  return sorted;
}

// Linear interpolation between order statistics, as summarizeDistribution does.
function sortedQuantile(sorted, p) {
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

/** p10, p25, p50, p75, p90 of the finite values, or null when there are none. */
export function holdoutQuantiles(values) {
  const sorted = finiteSorted(values);
  if (!sorted.length) return null;
  return Object.fromEntries(QUANTILE_POINTS.map((p) => [qKey(p), sortedQuantile(sorted, p)]));
}

/**
 * Two-sample Kolmogorov-Smirnov statistic D = sup |F_a(x) - F_b(x)| between the two
 * empirical CDFs. Non-finite values are dropped; null when either sample is empty.
 *
 * Ties: both ECDFs are stepped past every copy of a value before the difference is taken,
 * so D is evaluated at each distinct value. That is the exact supremum for right-continuous
 * step functions, so D is correct for discrete metrics too. Its null distribution is not
 * the continuous one with ties, and a pooled simulated sample is far larger than any real
 * one, so no p-value is reported: D is a distance, read against a tolerance.
 */
export function ksStatistic(a, b) {
  const x = finiteSorted(a);
  const y = finiteSorted(b);
  if (!x.length || !y.length) return null;
  let i = 0;
  let j = 0;
  let d = 0;
  while (i < x.length && j < y.length) {
    const value = x[i] < y[j] ? x[i] : y[j];
    while (i < x.length && x[i] <= value) i += 1;
    while (j < y.length && y[j] <= value) j += 1;
    const gap = Math.abs(i / x.length - j / y.length);
    if (gap > d) d = gap;
  }
  return d;
}

/**
 * Per-trader calibration, with the rule simulation-calibration.mjs uses: among rows with
 * an observed value and a band, the share whose observed value lies in [p10, p90]
 * (within 1e-9). rows: [{ observed, band: { p10, p90 } }].
 */
export function bandCoverage(rows) {
  let traders = 0;
  let inside = 0;
  let below = 0;
  let above = 0;
  for (const { observed, band } of rows) {
    if (!isFiniteNumber(observed) || !band || !isFiniteNumber(band.p10) || !isFiniteNumber(band.p90)) continue;
    traders += 1;
    if (observed < band.p10 - SLACK) below += 1;
    else if (observed > band.p90 + SLACK) above += 1;
    else inside += 1;
  }
  return { traders, inside, below, above, share: traders ? inside / traders : null };
}

// --- Split ---------------------------------------------------------------------------------

/**
 * Splits events per trader by time (SPLIT_RULE). Options: trainShare, minTrainSessions,
 * minTestSessions, minTestTrades, minTestDays, behaviorOptions (for sessionGapMinutes).
 *
 * Returns { holdoutVersion, rule, churnCaveat, settings, trainEvents, testEvents,
 * skippedEvents, traders }. Each trader is { traderToken, eligible, reason, activeStart,
 * activeEnd, nominalCut, cut, trainSessions, testSessions, trainTrades, testTrades,
 * testDays }; eligible is false, with a reason, when the windows are too small. A trader
 * with a cut contributes the events before it to trainEvents, eligible or not; a trader
 * with no cut contributes every event. testEvents holds eligible traders' events from the
 * cut on. Input events are not modified or copied.
 */
export function splitHoldout(events, options = {}) {
  const caller = 'splitHoldout';
  if (options !== undefined && !isPlainObject(options)) fail(caller, 'options must be an object', TypeError);
  for (const key of Object.keys(options ?? {})) {
    if (!SPLIT_OPTION_KEYS.includes(key)) fail(caller, `unknown option "${key}"`);
  }
  const settings = resolveSplitOptions(options, caller);
  const records = buildBehaviorObservations(events, { ...settings.behaviorOptions, observationEnd: null });
  const behavior = records[0]?.options ?? null;

  const traders = records.map((record) => {
    const { sessions } = record;
    const base = { traderToken: record.traderToken, eligible: false, reason: null, activeStart: null, activeEnd: null, nominalCut: null, cut: null, trainSessions: null, testSessions: null, trainTrades: null, testTrades: null, testDays: null };
    if (!sessions.length) return { ...base, reason: 'no trade, deposit, or withdrawal' };
    const startMs = sessions[0].start;
    const endMs = sessions.at(-1).end;
    const nominalMs = startMs + settings.trainShare * (endMs - startMs);
    Object.assign(base, { activeStart: iso(startMs), activeEnd: iso(endMs), nominalCut: iso(nominalMs) });
    if (sessions.length < 2) return { ...base, reason: 'one session: nothing to split' };
    const cutIndex = sessions.findIndex((session, index) => index >= 1 && session.start >= nominalMs);
    if (cutIndex === -1) return { ...base, reason: `no session starts at or after ${settings.trainShare} of the active period (the last session spans that point)` };

    const trainSessions = cutIndex;
    const testSessions = sessions.length - cutIndex;
    const trainTrades = sessions.slice(0, cutIndex).reduce((total, session) => total + session.tradeCount, 0);
    const testTrades = sessions.slice(cutIndex).reduce((total, session) => total + session.tradeCount, 0);
    const cutMs = sessions[cutIndex].start;
    const testDays = (endMs - cutMs) / DAY_MS;
    const row = { ...base, cut: iso(cutMs), cutMs, trainSessions, testSessions, trainTrades, testTrades, testDays };
    let reason = null;
    if (trainSessions < settings.minTrainSessions) reason = `${trainSessions} training session(s), below the minimum of ${settings.minTrainSessions}`;
    else if (testSessions < settings.minTestSessions) reason = `${testSessions} test session(s), below the minimum of ${settings.minTestSessions}`;
    else if (testTrades < settings.minTestTrades) reason = `${testTrades} test trade(s), below the minimum of ${settings.minTestTrades}`;
    else if (!(testDays >= settings.minTestDays)) reason = `test window of ${testDays.toFixed(3)} days, below the minimum of ${settings.minTestDays} (the simulator's first session starts within 24 hours of the cut)`;
    return { ...row, eligible: reason === null, reason };
  });

  const byToken = new Map(traders.map((trader) => [trader.traderToken, trader]));
  const trainEvents = [];
  const testEvents = [];
  let skippedEvents = 0;
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || event.trader_token === undefined || event.trader_token === null || event.trader_token === '') { skippedEvents += 1; continue; }
    const t = Date.parse(event.occurred_at);
    const trader = byToken.get(String(event.trader_token));
    if (Number.isNaN(t) || !trader) { skippedEvents += 1; continue; }
    if (trader.cutMs === undefined || t < trader.cutMs) trainEvents.push(event);
    else if (trader.eligible) testEvents.push(event);
  }
  for (const trader of traders) delete trader.cutMs;

  return {
    holdoutVersion: HOLDOUT_VERSION,
    rule: SPLIT_RULE,
    churnCaveat: CHURN_CAVEAT,
    settings: {
      trainShare: settings.trainShare,
      minTrainSessions: settings.minTrainSessions,
      minTestSessions: settings.minTestSessions,
      minTestTrades: settings.minTestTrades,
      minTestDays: settings.minTestDays,
      sessionGapMinutes: behavior?.sessionGapMinutes ?? null
    },
    trainEvents,
    testEvents,
    skippedEvents,
    traders
  };
}

function iso(ms) {
  return new Date(ms).toISOString();
}

// --- Shared metric definitions -------------------------------------------------------------

function emptyTraderMetrics() {
  const names = [...HOLDOUT_METRIC_NAMES, 'stakeAll'];
  return {
    stats: Object.fromEntries(names.map((name) => [name, null])),
    samples: Object.fromEntries(names.map((name) => [name, []])),
    unassignedDepositsAfterLoss: 0
  };
}

/**
 * The holdout metrics for every trader in `events`, from buildBehaviorObservations and
 * metricsFromEvents: the same function for observed test events, training events, and
 * every model's simulated events. options: baseStakes (traderToken -> the training fit's
 * baseStake; stake metrics are empty without one) and behaviorOptions (observationEnd is
 * ignored: none of these metrics depends on censoring).
 *
 * Returns traderToken -> { stats, samples, unassignedDepositsAfterLoss }: stats holds each
 * HOLDOUT_METRICS trader statistic (null when undefined), samples each unit-level sample.
 * Both also hold stakeAll (every stake / baseStake), which the naive model uses.
 */
export function holdoutEventMetrics(events, options = {}) {
  const baseStakes = options.baseStakes ?? {};
  const behaviorOptions = { ...(options.behaviorOptions ?? {}), observationEnd: null };
  const records = buildBehaviorObservations(events, behaviorOptions);
  if (!records.length) return {};
  const fromEvents = metricsFromEvents(events, { baseStakes, behaviorOptions });
  const output = {};
  for (const record of records) {
    const token = record.traderToken;
    const base = isFiniteNumber(baseStakes[token]) && baseStakes[token] > 0 ? baseStakes[token] : null;
    const windowMs = record.options.refuelWindowMinutes * MINUTE_MS;
    const { trades, sessions } = record;
    const result = emptyTraderMetrics();
    const { samples, stats } = result;

    if (base !== null) {
      for (const trade of trades) {
        if (trade.stake === null) continue;
        const ratio = trade.stake / base;
        samples.stakeAll.push(ratio);
        if (trade.previousOutcome === 'loss') samples.stakeAfterLoss.push(ratio);
        else if (trade.previousOutcome === 'win') samples.stakeAfterWin.push(ratio);
      }
    }
    const tradeSessions = sessions.filter((session) => session.tradeCount > 0);
    samples.tradesPerSession = tradeSessions.map((session) => session.tradeCount);
    samples.sessionMinutes = tradeSessions.map((session) => (session.end - session.start) / MINUTE_MS);
    for (let index = 1; index < trades.length; index += 1) {
      if (trades[index].session === trades[index - 1].session) samples.interTradeMinutes.push((trades[index].t - trades[index - 1].t) / MINUTE_MS);
    }
    for (let index = 1; index < sessions.length; index += 1) {
      samples.idleMinutes.push((sessions[index].start - sessions[index - 1].end) / MINUTE_MS);
    }

    // Deposits after a loss: metricsFromEvents' rule, with each deposit counted in its session.
    const perSession = new Map();
    let pointer = 0;
    let lastLoss = null;
    for (const item of record.deposits) {
      if (!item.refuel) continue;
      while (pointer < trades.length && trades[pointer].action < item.action) {
        if (trades[pointer].outcome === 'loss') lastLoss = trades[pointer].t;
        pointer += 1;
      }
      if (lastLoss !== null && item.t - lastLoss <= windowMs) perSession.set(item.session, (perSession.get(item.session) ?? 0) + 1);
    }
    samples.depositsAfterLoss = tradeSessions.map((session) => perSession.get(session.index) ?? 0);
    const assigned = samples.depositsAfterLoss.reduce((total, count) => total + count, 0);
    result.unassignedDepositsAfterLoss = [...perSession.values()].reduce((total, count) => total + count, 0) - assigned;

    stats.stakeAll = median(samples.stakeAll);
    stats.stakeAfterLoss = median(samples.stakeAfterLoss);
    stats.stakeAfterWin = median(samples.stakeAfterWin);
    stats.stakeLossMinusWin = stats.stakeAfterLoss === null || stats.stakeAfterWin === null ? null : stats.stakeAfterLoss - stats.stakeAfterWin;
    stats.tradesPerSession = fromEvents[token]?.tradesPerSession ?? null;
    stats.sessionMinutes = median(samples.sessionMinutes);
    stats.interTradeMinutes = median(samples.interTradeMinutes);
    stats.depositsAfterLoss = fromEvents[token]?.depositsAfterLossPerSession ?? null;
    stats.idleMinutes = median(samples.idleMinutes);
    output[token] = result;
  }
  return output;
}

/** The naive-0.1 prediction (NAIVE_DEFINITION) from one trader's training metrics. */
export function naivePrediction(trainingMetrics) {
  const metrics = trainingMetrics ?? emptyTraderMetrics();
  const stats = {};
  const samples = {};
  for (const name of HOLDOUT_METRIC_NAMES) {
    if (name === 'stakeAfterLoss' || name === 'stakeAfterWin') {
      stats[name] = metrics.stats.stakeAll;
      samples[name] = metrics.samples.stakeAll;
    } else if (name === 'stakeLossMinusWin') {
      stats[name] = metrics.stats.stakeAll === null ? null : 0;
      samples[name] = [];
    } else {
      stats[name] = metrics.stats[name];
      samples[name] = metrics.samples[name];
    }
  }
  return { stats, samples };
}

// --- baseline-0.1 adapter ---------------------------------------------------------------------

/**
 * Maps simulateBaseline events ({ type, occurredAt, stakeAmount, realizedResult, amount,
 * marketType }) to the analytical event schema, shifted so the baseline's hard-coded start
 * (BASELINE_START) lands on `start`. marketType is dropped. See BASELINE_ADAPTER.
 */
export function baselineEventsToAnalytical(baselineEvents, { traderToken, start, replicate = 0, venueId = 'simulated-baseline-0.1' } = {}) {
  const startMs = Date.parse(start);
  if (Number.isNaN(startMs)) fail('baselineEventsToAnalytical', 'start must be a valid timestamp');
  if (traderToken === undefined || traderToken === null || traderToken === '') fail('baselineEventsToAnalytical', 'traderToken is required');
  const shift = startMs - Date.parse(BASELINE_START);
  const width = Math.max(6, String(baselineEvents.length).length);
  return baselineEvents.map((event, index) => {
    const row = {
      event_id: `base_${replicate}_${String(index + 1).padStart(width, '0')}`,
      trader_token: String(traderToken),
      occurred_at: new Date(Date.parse(event.occurredAt) + shift).toISOString(),
      type: event.type,
      venue_id: venueId
    };
    if (event.type === 'trade') {
      row.stake_amount = event.stakeAmount;
      row.realized_result = event.realizedResult;
    } else if (event.type === 'deposit') {
      row.deposit_amount = event.amount;
    }
    row.source_row_number = index + 1;
    return row;
  });
}

// --- Models -------------------------------------------------------------------------------------

function twinModel(key, fit, traders, settings, uncertainty, startingBalances) {
  const tokens = new Set(fit.twins.map((twin) => twin.traderToken));
  const entries = new Map();
  for (const trader of traders) {
    const token = trader.traderToken;
    if (!tokens.has(token)) {
      entries.set(token, { simulable: false, reason: `${key}: no twin for this trader in the fit` });
      continue;
    }
    const balance = startingBalances[token];
    const prepared = prepareSimulation(fit, {
      seed: settings.seed,
      replicates: settings.replicates,
      uncertainty,
      start: trader.cut,
      horizonDays: trader.testDays,
      traders: [token],
      startingBalances: isFiniteNumber(balance) && balance >= 0 ? { [token]: balance } : {},
      keepEvents: true
    });
    const plan = prepared.plans[0];
    if (!plan.simulable) {
      entries.set(token, { simulable: false, reason: `${key} not simulable: ${plan.reasons.join('; ')}` });
      continue;
    }
    entries.set(token, {
      simulable: true,
      moneySimulated: plan.mechanisms.money.simulated,
      stopBasis: plan.stopBasis,
      refuelTrigger: plan.refuel.trigger,
      startingBalanceRule: plan.startingBalance.rule,
      prepared,
      plan
    });
  }
  return {
    key,
    entries,
    assumptions: null,
    run(trader, replicate) {
      const entry = entries.get(trader.traderToken);
      return simulateReplicate(entry.prepared, entry.plan, replicate).events;
    }
  };
}

function baselineModel(trainEvents, traders, settings) {
  const twins = new Map(buildTwins(buildSignals(trainEvents)).map((twin) => [twin.profile.traderToken, twin]));
  const entries = new Map();
  for (const trader of traders) {
    const twin = twins.get(trader.traderToken);
    entries.set(trader.traderToken, twin
      ? { simulable: true, moneySimulated: true, twin }
      : { simulable: false, reason: 'baseline-0.1: no training events' });
  }
  return {
    key: 'baseline',
    entries,
    run(trader, replicate) {
      const { twin } = entries.get(trader.traderToken);
      const result = simulateBaseline(twin, {
        horizonDays: Math.max(1, trader.testDays),
        seed: stableSeed(`${settings.seed}:${BASELINE_SIMULATOR_VERSION}:${trader.traderToken}:${replicate}`)
      });
      return baselineEventsToAnalytical(result.events, { traderToken: trader.traderToken, start: trader.cut, replicate });
    }
  };
}

/**
 * Runs one simulated model for every compared trader, replicate by replicate. Each run's
 * events are reduced to metrics and dropped at once. Keeps, per trader and metric, the
 * statistic of every replicate; per metric, each replicate's pooled quantiles; and the
 * pooled sample of the first ksReplicates replicates.
 */
function runSimulatedModel(model, traders, context) {
  const { replicates, ksReplicates, baseStakes, behaviorOptions, onProgress } = context;
  const stats = new Map(traders.map((trader) => [trader.traderToken, Object.fromEntries(HOLDOUT_METRIC_NAMES.map((name) => [name, new Array(replicates).fill(null)]))]));
  const replicateQuantiles = Object.fromEntries(HOLDOUT_METRIC_NAMES.map((name) => [name, Object.fromEntries(QUANTILE_POINTS.map((p) => [qKey(p), []]))]));
  const pooled = Object.fromEntries(HOLDOUT_METRIC_NAMES.map((name) => [name, []]));
  const emptyRuns = new Map(traders.map((trader) => [trader.traderToken, 0]));

  for (let replicate = 0; replicate < replicates; replicate += 1) {
    const population = Object.fromEntries(HOLDOUT_METRIC_NAMES.map((name) => [name, []]));
    for (const trader of traders) {
      const token = trader.traderToken;
      const entry = model.entries.get(token);
      const events = model.run(trader, replicate);
      if (!events.some((event) => event.type === 'trade')) emptyRuns.set(token, emptyRuns.get(token) + 1);
      const metrics = holdoutEventMetrics(events, { baseStakes: { [token]: baseStakes[token] }, behaviorOptions })[token] ?? emptyTraderMetrics();
      const traderStats = stats.get(token);
      for (const name of HOLDOUT_METRIC_NAMES) {
        const blank = HOLDOUT_METRICS[name].money && !entry.moneySimulated;
        const value = blank ? null : metrics.stats[name];
        traderStats[name][replicate] = value;
        if (blank) continue;
        const target = population[name];
        if (HOLDOUT_METRICS[name].level === 'trader') {
          if (value !== null) target.push(value);
        } else {
          for (const item of metrics.samples[name]) target.push(item);
        }
      }
    }
    for (const name of HOLDOUT_METRIC_NAMES) {
      const quantiles = holdoutQuantiles(population[name]);
      if (quantiles) for (const [key, value] of Object.entries(quantiles)) replicateQuantiles[name][key].push(value);
      if (replicate < ksReplicates) for (const item of population[name]) pooled[name].push(item);
    }
    if (onProgress) onProgress({ model: model.key, replicate: replicate + 1, of: replicates });
  }
  return { stats, replicateQuantiles, pooled, emptyRuns };
}

function traderBand(values, replicates, minReplicateShare) {
  const summary = summarizeDistribution(values);
  if (summary.n === 0) return { median: null, p10: null, p90: null, n: 0, reason: 'no replicate has a value' };
  if (summary.n < minReplicateShare * replicates) {
    return { median: null, p10: null, p90: null, n: summary.n, reason: `only ${summary.n} of ${replicates} replicates have a value (needs ${minReplicateShare} of them)` };
  }
  return { median: summary.median, p10: summary.p10, p90: summary.p90, n: summary.n, reason: null };
}

function pointErrors(pairs) {
  const errors = pairs.map(({ observed, point }) => Math.abs(point - observed));
  return { traders: errors.length, medianAbsoluteError: median(errors), meanAbsoluteError: mean(errors) };
}

// --- Comparison ----------------------------------------------------------------------------------

function compareMetric(name, context) {
  const { compared, observed, simulated, naive, settings, dataLabel } = context;
  const definition = HOLDOUT_METRICS[name];
  const unitSample = (perTrader) => {
    const values = [];
    for (const trader of compared) {
      const metrics = perTrader[trader.traderToken];
      if (!metrics) continue;
      if (definition.level === 'trader') {
        if (metrics.stats[name] !== null) values.push(metrics.stats[name]);
      } else {
        for (const item of metrics.samples[name]) values.push(item);
      }
    }
    return values;
  };
  const observedSample = unitSample(observed);
  const observedQuantiles = holdoutQuantiles(observedSample);
  const observedStat = (token) => observed[token]?.stats[name] ?? null;

  const models = {};
  const points = {};
  for (const [key, result] of Object.entries(simulated)) {
    const bands = {};
    for (const trader of compared) {
      bands[trader.traderToken] = traderBand(result.stats.get(trader.traderToken)[name], settings.replicates, settings.minReplicateShare);
    }
    points[key] = Object.fromEntries(Object.entries(bands).map(([token, band]) => [token, band.median]));
    const quantiles = observedQuantiles === null ? null : Object.fromEntries(QUANTILE_POINTS.map((p) => {
      const key2 = qKey(p);
      const band = summarizeDistribution(result.replicateQuantiles[name][key2]);
      const value = observedQuantiles[key2];
      const inside = band.p10 !== null && value >= band.p10 - SLACK && value <= band.p90 + SLACK;
      return [key2, { observed: value, median: band.median, p10: band.p10, p90: band.p90, inside }];
    }));
    models[key] = {
      sampleSize: result.pooled[name].length,
      pooledQuantiles: holdoutQuantiles(result.pooled[name]),
      quantiles,
      quantilesInsideBand: quantiles ? Object.values(quantiles).filter((cell) => cell.inside).length : null,
      ksD: ksStatistic(observedSample, result.pooled[name]),
      calibration: bandCoverage(compared.map((trader) => ({ observed: observedStat(trader.traderToken), band: bands[trader.traderToken] }))),
      bands
    };
  }
  if (naive) {
    const naiveSample = [];
    for (const trader of compared) {
      const prediction = naive[trader.traderToken];
      if (definition.level === 'trader') {
        if (prediction.stats[name] !== null) naiveSample.push(prediction.stats[name]);
      } else {
        for (const item of prediction.samples[name]) naiveSample.push(item);
      }
    }
    points.naive = Object.fromEntries(compared.map((trader) => [trader.traderToken, naive[trader.traderToken].stats[name]]));
    const quantiles = holdoutQuantiles(naiveSample);
    models.naive = {
      sampleSize: naiveSample.length,
      pooledQuantiles: quantiles,
      quantiles: observedQuantiles === null || quantiles === null ? null : Object.fromEntries(QUANTILE_POINTS.map((p) => [qKey(p), { observed: observedQuantiles[qKey(p)], value: quantiles[qKey(p)] }])),
      quantilesInsideBand: null,
      ksD: ksStatistic(observedSample, naiveSample),
      calibration: null
    };
  }

  // Point errors on the paired set: traders with an observed value and a point from every
  // compared model (twin, baseline, naive). The truth reference uses the same set.
  const comparedKeys = ['twin', ...COMPARATORS].filter((key) => points[key]);
  const paired = compared.map((trader) => trader.traderToken).filter((token) => observedStat(token) !== null && comparedKeys.every((key) => points[key][token] !== null && points[key][token] !== undefined));
  for (const key of Object.keys(models)) {
    const tokens = paired.filter((token) => points[key][token] !== null && points[key][token] !== undefined);
    models[key].pointError = pointErrors(tokens.map((token) => ({ observed: observedStat(token), point: points[key][token] })));
  }
  return {
    definition,
    knownShapeDifference: dataLabel === 'SYNTHETIC' ? SYNTHETIC_SHAPE_DIFFERENCES[name] ?? null : null,
    observed: {
      sampleSize: observedSample.length,
      traders: compared.filter((trader) => observedStat(trader.traderToken) !== null).length,
      quantiles: observedQuantiles
    },
    pairedTraders: paired.length,
    models
  };
}

// --- Summary --------------------------------------------------------------------------------------

function beatsCell(twin, comparator, tolerances) {
  if (!twin || !comparator) return { errorWin: null, dWin: null, beats: null, reason: 'model not run' };
  const twinError = twin.pointError?.medianAbsoluteError ?? null;
  const comparatorError = comparator.pointError?.medianAbsoluteError ?? null;
  const errorWin = twinError === null || comparatorError === null ? null : twinError < comparatorError * (1 - tolerances.errorMargin);
  const dWin = twin.ksD === null || comparator.ksD === null ? null : twin.ksD < comparator.ksD - tolerances.dMargin;
  const beats = errorWin === null && dWin === null ? null : errorWin !== false && dWin !== false;
  return {
    twinError, comparatorError, errorWin,
    twinD: twin.ksD, comparatorD: comparator.ksD, dWin,
    beats,
    reason: beats === null ? 'neither point errors nor D could be computed for both models' : null
  };
}

function shareAtLeast(passed, scored, share) {
  return scored === 0 ? null : passed / scored >= share - SLACK;
}

/**
 * Pass/fail for a runHoldoutValidation result (or its `metrics` and `models`), against
 * tolerances (HOLDOUT_TOLERANCES, overridable). Pure: recompute it with other tolerances
 * without simulating again. "Beats" (ADR-014): on a metric, the twin beats a comparator
 * when its median absolute point error is below the comparator's x (1 - errorMargin) and
 * its KS D is below the comparator's D - dMargin (either alone when the other can't be
 * computed). Overall it beats a comparator when it beats it on more than beatsShare of the
 * scored metrics they were compared on. The twin earns a claim only when it beats both
 * baseline-0.1 and naive-0.1.
 */
export function summarizeHoldout(validation, tolerancesInput) {
  const tolerances = resolveTolerances(tolerancesInput, 'summarizeHoldout');
  const perMetric = {};
  const findings = [];
  for (const [name, metric] of Object.entries(validation.metrics)) {
    const { scored, ties } = metric.definition;
    const twin = metric.models.twin ?? null;
    const truth = metric.models.truth ?? null;
    const range = ties ? tolerances.coverage.ties : tolerances.coverage.continuous;
    const share = twin?.calibration?.share ?? null;
    const calibration = { share, range: [...range], pass: share === null ? null : share >= range[0] - SLACK && share <= range[1] + SLACK };
    const distribution = { ksD: twin?.ksD ?? null, maxKsD: tolerances.maxKsD, pass: twin?.ksD === null || twin?.ksD === undefined ? null : twin.ksD <= tolerances.maxKsD + SLACK };
    const beats = Object.fromEntries(COMPARATORS.filter((key) => metric.models[key]).map((key) => [key, beatsCell(twin, metric.models[key], tolerances)]));
    let diagnosis = null;
    if (truth && truth.ksD !== null && distribution.pass !== null) {
      const truthPass = truth.ksD <= tolerances.maxKsD + SLACK;
      if (distribution.pass && truthPass) diagnosis = 'within tolerance with fitted and true parameters';
      else if (!distribution.pass && truthPass) diagnosis = 'estimation error: true parameters are within tolerance, fitted ones are not';
      else if (!distribution.pass && !truthPass) diagnosis = 'model shape: outside tolerance even with true parameters';
      else diagnosis = 'fitted parameters are within tolerance where true parameters are not';
    }
    const parts = [calibration.pass, distribution.pass, ...Object.values(beats).map((cell) => cell.beats)];
    const pass = parts.some((part) => part === null) ? null : parts.every(Boolean);
    perMetric[name] = {
      scored,
      calibration,
      distribution,
      beats,
      diagnosis,
      knownShapeDifference: metric.knownShapeDifference ?? null,
      pass
    };
    if (!scored) continue;
    for (const [key, cell] of Object.entries(beats)) {
      if (cell.beats === false) {
        findings.push(`${name}: the twin does not beat ${validation.models?.[key]?.version ?? key} (point error ${fmt(cell.twinError)} vs ${fmt(cell.comparatorError)}, D ${fmt(cell.twinD)} vs ${fmt(cell.comparatorD)}).`);
      }
    }
    if (calibration.pass === false) findings.push(`${name}: calibration ${fmt(share)} is outside [${range.join(', ')}].`);
    if (distribution.pass === false) findings.push(`${name}: KS D ${fmt(distribution.ksD)} is above ${tolerances.maxKsD}${diagnosis ? ` (${diagnosis})` : ''}${metric.knownShapeDifference ? '; a known model-shape difference on synthetic data' : ''}.`);
  }

  const scoredNames = Object.keys(perMetric).filter((name) => perMetric[name].scored);
  const beatsOverall = {};
  for (const key of COMPARATORS) {
    const cells = scoredNames.map((name) => perMetric[name].beats[key]).filter((cell) => cell && cell.beats !== null);
    if (!cells.length) {
      beatsOverall[key] = { metricsCompared: 0, metricsBeaten: 0, share: null, beats: null, reason: validation.models?.[key] ? 'no metric could be compared' : 'comparator not run' };
      continue;
    }
    const beaten = cells.filter((cell) => cell.beats).length;
    beatsOverall[key] = { metricsCompared: cells.length, metricsBeaten: beaten, share: beaten / cells.length, beats: beaten / cells.length > tolerances.beatsShare + SLACK, reason: null };
  }
  const versions = COMPARATORS.map((key) => validation.models?.[key]?.version ?? key);
  const earned = COMPARATORS.every((key) => beatsOverall[key].beats === true);
  const missing = COMPARATORS.filter((key) => beatsOverall[key].beats !== true).map((key) => validation.models?.[key]?.version ?? key);
  const label = validation.dataLabel ?? 'unlabelled';
  const statement = earned
    ? `On this ${label} data, under the configured criteria, ${TWIN_MODEL_VERSION} beats both ${versions.join(' and ')}. This is evidence about the model on this data, not an accuracy claim and not a causal claim.`
    : `${TWIN_MODEL_VERSION} does not earn a claim on this ${label} data: it does not beat ${missing.join(' or ')} under the configured criteria. Reported as a finding; the definitions and tolerances were not changed to make it pass.`;

  const tally = (part) => {
    const values = scoredNames.map((name) => perMetric[name][part].pass).filter((value) => value !== null);
    const passed = values.filter(Boolean).length;
    return { metricsScored: values.length, metricsPassed: passed, pass: shareAtLeast(passed, values.length, tolerances.passShare) };
  };
  const calibration = tally('calibration');
  const distribution = tally('distribution');
  const pass = earned && calibration.pass === true && distribution.pass === true;
  return {
    tolerances,
    perMetric,
    overall: {
      beats: beatsOverall,
      claim: { earned, statement },
      calibration,
      distribution,
      pass,
      findings
    }
  };
}

function fmt(value) {
  return value === null || value === undefined ? 'n/a' : Number(value).toPrecision(3);
}

// --- Entry points -----------------------------------------------------------------------------------

function resolveRunOptions(options, caller) {
  if (!isPlainObject(options)) fail(caller, `options must be an object with a dataLabel (${DATA_LABELS.join(', ')})`, TypeError);
  const supplied = Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined));
  for (const key of Object.keys(supplied)) {
    if (key !== 'dataLabel' && !Object.hasOwn(HOLDOUT_DEFAULTS, key)) fail(caller, `unknown option "${key}"`);
  }
  if (!DATA_LABELS.includes(supplied.dataLabel)) fail(caller, `dataLabel is required and must be one of ${DATA_LABELS.join(', ')}`);
  const settings = { ...HOLDOUT_DEFAULTS, ...supplied };
  if (!Number.isInteger(settings.seed) || settings.seed < 0) fail(caller, 'seed must be a non-negative integer');
  if (!isPositiveInteger(settings.replicates)) fail(caller, 'replicates must be a positive integer');
  if (!isPositiveInteger(settings.ksReplicates)) fail(caller, 'ksReplicates must be a positive integer');
  if (!(isFiniteNumber(settings.minReplicateShare) && settings.minReplicateShare > 0 && settings.minReplicateShare <= 1)) fail(caller, 'minReplicateShare must be in (0, 1]');
  for (const key of ['baseline', 'naive', 'includeTraders']) {
    if (typeof settings[key] !== 'boolean') fail(caller, `${key} must be true or false`);
  }
  if (settings.onProgress !== null && typeof settings.onProgress !== 'function') fail(caller, 'onProgress must be a function or null', TypeError);
  if (settings.reference !== null) {
    if (settings.dataLabel !== 'SYNTHETIC') fail(caller, 'a truth reference exists only for SYNTHETIC data');
    if (!isPlainObject(settings.reference) || !isPlainObject(settings.reference.fit)) fail(caller, 'reference must be { fit } with a fit-shaped object', TypeError);
    if (settings.reference.fit.dataLabel !== 'SYNTHETIC') fail(caller, 'the reference fit must be labelled SYNTHETIC');
  }
  settings.tolerances = resolveTolerances(supplied.tolerances, caller);
  return settings;
}

function globalAssumptions(settings, split) {
  return [
    'Held-out validation is evidence about a model on stated data, not an accuracy headline and not a causal claim.',
    `Split: ${split.rule} trainShare ${split.settings.trainShare}; a trader needs at least ${split.settings.minTrainSessions} training sessions, ${split.settings.minTestSessions} test sessions, ${split.settings.minTestTrades} test trades, and ${split.settings.minTestDays} test days, or gets null with a reason.`,
    CHURN_CAVEAT,
    'Twins are fitted with estimateTwins on every trader\'s training events (before the cut, or every event for a trader with no cut), with the same data label and behaviorOptions. Priors use every trader\'s training data. Cuts differ by trader, so one trader\'s training period can overlap another\'s test period in calendar time: shocks common to all traders are not held out.',
    'Training ends at a session boundary. A refuel deposit that would open the first test session within refuelWindowMinutes of the last training trade is not in the training data.',
    `Each trader is simulated on their own: start at the cut, horizon = their test window in days, ${settings.replicates} replicates (seed ${settings.seed}). A replicate doesn't depend on which other traders are simulated, so this equals a batch run. The simulator's first session starts at a uniform time within 24 hours of the start, while the observed first test session starts at the cut; per-session and per-trade distributions don't depend on that offset.`,
    'Starting balance: the last observed balance_after in the trader\'s training events, or 0 with the session-start deposit rule when there is none (no balance fields).',
    'Only event-observable quantities are compared, all from events through holdoutEventMetrics (buildBehaviorObservations and metricsFromEvents) on both sides. Forced stops, refuel deposits, and stop causes are simulator decisions real data doesn\'t show, and are not compared.',
    'Stakes are divided by the training fit\'s estimated baseStake on every side, never by a run\'s drawn baseStake.',
    `Per trader, a simulated model's point is the median of the trader's per-replicate statistic, and its band the 10th to 90th percentile across replicates; at least ${settings.minReplicateShare} of the replicates must have a value. Calibration is the share of traders whose observed test statistic lies inside the band (nominally 0.8).`,
    `Population quantiles: observed quantiles of the pooled test sample, against the 10th to 90th percentile across replicates of each replicate's pooled quantile. KS D compares the pooled observed sample with the pooled simulated sample of the first ${Math.min(settings.ksReplicates, settings.replicates)} replicates. No p-values: the simulated sample is pooled over replicates, so a p-value would be meaningless.`,
    'Ties: discrete metrics (trades per session, deposits after a loss) have many ties. D is computed exactly at each distinct value, and those metrics\' calibration uses the ties tolerance, because ties put more traders inside a band.',
    NAIVE_DEFINITION,
    BASELINE_ADAPTER,
    'Missing realized outcomes stay unavailable: a trade with no realized_result has no outcome, so the next trade is in neither stake-after-loss nor stake-after-win, and nothing is filled with zero.'
  ];
}

/**
 * Held-out validation of twin-0.2.1 against baseline-0.1 and naive-0.1, with an optional
 * truth reference on SYNTHETIC data. options: dataLabel (required) and HOLDOUT_DEFAULTS.
 *
 * Returns { holdoutVersion, dataLabel, modelVersion, simulatorVersion, behaviorVersion,
 * seed, replicates, ksReplicates, split, claim, assumptions, inputs, labels, models,
 * traders, metricDefinitions, metrics, summary } and, with includeTraders, perTrader
 * rows. summary is summarizeHoldout(result, tolerances). Throws on invalid options.
 */
export function runHoldoutValidation(events, options) {
  const caller = 'runHoldoutValidation';
  const settings = resolveRunOptions(options, caller);
  const split = splitHoldout(events, {
    trainShare: settings.trainShare,
    minTrainSessions: settings.minTrainSessions,
    minTestSessions: settings.minTestSessions,
    minTestTrades: settings.minTestTrades,
    minTestDays: settings.minTestDays,
    behaviorOptions: settings.behaviorOptions
  });
  const fit = estimateTwins(split.trainEvents, { dataLabel: settings.dataLabel, behaviorOptions: settings.behaviorOptions });
  const behaviorOptions = { ...fit.behaviorOptions, observationEnd: null };
  const fitTwins = new Map(fit.twins.map((twin) => [twin.traderToken, twin]));
  const baseStakes = {};
  for (const twin of fit.twins) {
    const record = twin.parameters.baseStake;
    baseStakes[twin.traderToken] = record && record.status !== 'not_estimable' && isFiniteNumber(record.estimate) && record.estimate > 0 ? record.estimate : null;
  }
  const startingBalances = lastObservedBalances(split.trainEvents);

  // Eligible traders, then the ones every simulated model can run.
  const eligible = split.traders.filter((trader) => trader.eligible);
  const twin = twinModel('twin', fit, eligible, settings, true, startingBalances);
  const truth = settings.reference ? twinModel('truth', settings.reference.fit, eligible, settings, false, startingBalances) : null;
  const exclusions = {};
  const compared = eligible.filter((trader) => {
    const token = trader.traderToken;
    const reasons = [];
    if (baseStakes[token] === null || baseStakes[token] === undefined) reasons.push('no estimated baseStake in training');
    for (const model of [twin, truth]) {
      const entry = model?.entries.get(token);
      if (entry && !entry.simulable) reasons.push(entry.reason);
    }
    if (reasons.length) exclusions[token] = reasons.join('; ');
    return !reasons.length;
  });
  const baseline = settings.baseline ? baselineModel(split.trainEvents, compared, settings) : null;

  const observed = holdoutEventMetrics(split.testEvents, { baseStakes, behaviorOptions });
  const training = settings.naive ? holdoutEventMetrics(split.trainEvents, { baseStakes, behaviorOptions }) : null;
  const naive = settings.naive ? Object.fromEntries(compared.map((trader) => [trader.traderToken, naivePrediction(training[trader.traderToken])])) : null;

  const context = {
    replicates: settings.replicates,
    ksReplicates: Math.min(settings.ksReplicates, settings.replicates),
    baseStakes,
    behaviorOptions,
    onProgress: settings.onProgress
  };
  const simulated = { twin: runSimulatedModel(twin, compared, context) };
  if (baseline) simulated.baseline = runSimulatedModel(baseline, compared, context);
  if (truth) simulated.truth = runSimulatedModel(truth, compared, context);

  const metrics = Object.fromEntries(HOLDOUT_METRIC_NAMES.map((name) => [name, compareMetric(name, {
    compared, observed, simulated, naive, settings, dataLabel: settings.dataLabel
  })]));

  const twinEntries = [...twin.entries.entries()].filter(([, entry]) => entry.simulable);
  const comparedTokens = new Set(compared.map((trader) => trader.traderToken));
  const labels = {
    allCauseStops: twinEntries.filter(([token, entry]) => comparedTokens.has(token) && entry.stopBasis === 'all-cause').map(([token]) => token),
    proxyRefuel: twinEntries.filter(([token, entry]) => comparedTokens.has(token) && entry.refuelTrigger === 'losingStreak (proxy)').map(([token]) => token),
    moneyNotSimulated: twinEntries.filter(([token, entry]) => comparedTokens.has(token) && !entry.moneySimulated).map(([token]) => token),
    notCompared: Object.keys(exclusions)
  };
  const emptyRuns = (key) => (simulated[key] ? [...simulated[key].emptyRuns.values()].reduce((total, count) => total + count, 0) : null);
  const models = {
    twin: {
      version: TWIN_MODEL_VERSION,
      simulatorVersion: SIMULATOR_VERSION,
      uncertainty: true,
      description: 'estimateTwins on the training events, simulated by simulateTwinV2 with parameter uncertainty on.',
      runsWithoutTrades: emptyRuns('twin')
    },
    baseline: baseline ? {
      version: BASELINE_SIMULATOR_VERSION,
      description: 'simulateBaseline on buildTwins(buildSignals(training events)), through the adapter.',
      adapter: BASELINE_ADAPTER,
      runsWithoutTrades: emptyRuns('baseline')
    } : null,
    naive: naive ? { version: NAIVE_MODEL_VERSION, description: NAIVE_DEFINITION } : null,
    truth: truth ? {
      version: `${TWIN_MODEL_VERSION} (truth reference)`,
      simulatorVersion: SIMULATOR_VERSION,
      uncertainty: false,
      description: 'Twins on the generator\'s true parameters (SYNTHETIC only), uncertainty off: the best this model shape can do. It separates estimation error from model misspecification.',
      runsWithoutTrades: emptyRuns('truth')
    } : null
  };
  for (const key of MODEL_KEYS) if (models[key] === null) delete models[key];

  const balanceTraders = fit.inputs.tradersWithCompleteBalances;
  const result = {
    holdoutVersion: HOLDOUT_VERSION,
    dataLabel: settings.dataLabel,
    modelVersion: TWIN_MODEL_VERSION,
    simulatorVersion: SIMULATOR_VERSION,
    baselineVersion: baseline ? BASELINE_SIMULATOR_VERSION : null,
    naiveVersion: naive ? NAIVE_MODEL_VERSION : null,
    behaviorVersion: BEHAVIOR_VERSION,
    seed: settings.seed,
    replicates: settings.replicates,
    ksReplicates: context.ksReplicates,
    split: { rule: split.rule, churnCaveat: split.churnCaveat, ...split.settings },
    claim: 'Held-out validation: evidence about a model on stated data. Not an accuracy headline and not a causal claim.',
    assumptions: globalAssumptions(settings, split),
    inputs: {
      traders: split.traders.length,
      eligible: eligible.length,
      compared: compared.length,
      trainEvents: split.trainEvents.length,
      testEvents: split.testEvents.length,
      skippedEvents: split.skippedEvents,
      tradersWithCompleteBalances: balanceTraders,
      balancePath: balanceTraders === 0
        ? 'no balance fields: all-cause stop hazards and proxy (losing-streak) refuel'
        : balanceTraders === fit.inputs.traderCount ? 'balance fields on every trader' : 'balance fields on some traders',
      ineligibleReasons: tallyReasons(split.traders.filter((trader) => !trader.eligible).map((trader) => trader.reason)),
      exclusionReasons: tallyReasons(Object.values(exclusions))
    },
    labels,
    models,
    traders: split.traders.map((trader) => ({
      ...trader,
      compared: comparedTokens.has(trader.traderToken),
      exclusion: exclusions[trader.traderToken] ?? null,
      baseStake: baseStakes[trader.traderToken] ?? null,
      stopBasis: twin.entries.get(trader.traderToken)?.stopBasis ?? fitTwins.get(trader.traderToken)?.stopHazardBasis ?? null,
      refuelTrigger: twin.entries.get(trader.traderToken)?.refuelTrigger ?? null
    })),
    metricDefinitions: HOLDOUT_METRICS,
    metrics: Object.fromEntries(Object.entries(metrics).map(([name, metric]) => [name, {
      ...metric,
      models: Object.fromEntries(Object.entries(metric.models).map(([key, model]) => {
        const { bands, ...rest } = model;
        return [key, rest];
      }))
    }]))
  };
  result.summary = summarizeHoldout(result, settings.tolerances);
  if (settings.includeTraders) result.perTrader = perTraderRows(compared, metrics, observed, naive, result.dataLabel);
  return result;
}

function tallyReasons(reasons) {
  const counts = {};
  for (const reason of reasons) {
    const key = String(reason).replace(/[0-9.]+/g, 'N');
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function perTraderRows(compared, metrics, observed, naive, dataLabel) {
  return compared.map((trader) => {
    const token = trader.traderToken;
    const row = { dataLabel, traderToken: token, cut: trader.cut, testDays: trader.testDays, testSessions: trader.testSessions, testTrades: trader.testTrades, metrics: {} };
    for (const [name, metric] of Object.entries(metrics)) {
      const cell = { observed: observed[token]?.stats[name] ?? null };
      for (const [key, model] of Object.entries(metric.models)) {
        if (key === 'naive') cell.naive = naive[token].stats[name];
        else {
          const band = model.bands[token];
          cell[key] = { median: band.median, p10: band.p10, p90: band.p90, n: band.n };
        }
      }
      row.metrics[name] = cell;
    }
    return row;
  });
}

/**
 * OBSERVATIONAL HOOK (Polymarket public data). The entry point exists; loading does not.
 *
 * runObservationalHoldout(events, options) runs runHoldoutValidation with the OBSERVATIONAL
 * label. `events` must already be in the analytical event schema (docs/DATA-DICTIONARY.md):
 * trader_token (a hashed wallet), occurred_at, type, stake_amount, realized_result where
 * realized, and no balance fields (the no-balance path: all-cause stops, proxy refuel).
 * There is no truth reference for public data.
 *
 * NOT WIRED: nothing here downloads Polymarket data or maps it to the event schema. The
 * download scripts in analysis/ and a wallet-to-event mapper are a later step.
 */
export function runObservationalHoldout(events, options = {}) {
  if (!isPlainObject(options)) fail('runObservationalHoldout', 'options must be an object', TypeError);
  if (options.dataLabel !== undefined && options.dataLabel !== 'OBSERVATIONAL') fail('runObservationalHoldout', 'the observational hook only takes the OBSERVATIONAL label');
  if (options.reference !== undefined && options.reference !== null) fail('runObservationalHoldout', 'a truth reference exists only for SYNTHETIC data');
  return runHoldoutValidation(events, { ...options, dataLabel: 'OBSERVATIONAL' });
}

export const OBSERVATIONAL_HOOK = deepFreeze({
  entryPoint: 'runObservationalHoldout(events, options)',
  label: 'OBSERVATIONAL',
  status: 'not wired',
  note: 'Loading Polymarket public data into the analytical event schema is not implemented. Pass already-mapped events to runObservationalHoldout.'
});
