/**
 * Parameter recovery for twin-0.3.0 on SYNTHETIC traders with known parameters.
 *
 * test/twin-recovery.test.mjs and scripts/twin-recovery.mjs both call this module,
 * so the test thresholds and the local results file come from one computation. It
 * generates a behavioral-synthetic population, fits it with estimateTwins, and
 * compares estimates and 90% intervals with the truth. Pure: no I/O.
 *
 * Recovery numbers (correlations, coverage) belong only in test thresholds and in
 * the gitignored output the script writes. Don't copy them into docs or commits.
 */

import { BEHAVIORAL_GENERATOR_VERSION, SYNTHETIC_LABEL, generateBehavioralDataset } from './behavioral-generate.mjs';
import { BEHAVIOR_VERSION, DRAWDOWN_BUCKETS } from '../engine/behavior.mjs';
import { ESTIMATE_CONSTANTS, TWIN_MODEL_VERSION, TWIN_PARAMETER_NAMES, estimateTwins } from '../engine/estimate.mjs';
import { mean, pearson, sum } from '../engine/stats.mjs';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export const RECOVERY_DEFAULTS = deepFreeze({
  seed: 20261112,
  traderCount: 500,
  // Log-uniform, so the population has many short histories as well as long ones.
  sessionsPerTrader: { min: 2, max: 150, scale: 'log' },
  includeBalances: true,
  missingOutcomeShare: 0,
  // Chase is judged on traders with at least this many signal-1 post-loss episodes,
  minLossEpisodes: 20,
  // and its sign on those whose true coefficient is at least this far from 1.
  signMargin: 0.1,
  // Shrinkage is checked on traders with at most this many sessions.
  lowHistorySessions: 10
});

// The generator's minimum idle time between sessions (docs/BEHAVIORAL-SYNTHETIC.md, Timing).
export function minIdleMinutes(behaviorOptions) {
  const seconds = Math.ceil(Math.max(behaviorOptions.sessionGapMinutes, behaviorOptions.refuelWindowMinutes) * 60) + 60;
  return seconds / 60;
}

/**
 * Each estimated parameter and the true value it should recover. scale 'log' compares
 * on the log scale, 'probability' on the natural scale.
 */
export const RECOVERY_TARGETS = deepFreeze({
  baseStake: { scale: 'log', truth: (p) => p.baseStake },
  stakeDispersion: { scale: 'log', truth: (p) => p.stakeNoise },
  chaseCoefficient: { scale: 'log', truth: (p) => p.chaseCoefficient },
  escalationPerLoss: { scale: 'log', truth: (p) => p.escalationPerLoss },
  reentryLatencyAfterLoss: { scale: 'log', truth: (p) => p.reentryLatencyAfterLoss },
  reentryLatencyAfterWin: { scale: 'log', truth: (p) => p.reentryLatencyAfterWin },
  latencySpread: { scale: 'log', truth: (p) => p.latencyNoise },
  depositSize: { scale: 'log', truth: (p) => p.depositAmount },
  depositSpread: { scale: 'log', truth: (p) => p.depositNoise },
  winRate: { scale: 'probability', truth: (p) => p.winProbability },
  pushRate: { scale: 'probability', truth: (p) => p.pushProbability },
  payoutMultiple: { scale: 'log', truth: (p) => p.payoutMultiple },
  payoutSpread: { scale: 'log', truth: (p) => p.payoutNoise },
  refuelProbability: { scale: 'probability', truth: (p) => p.refuelProbability },
  meanIdleMinutes: { scale: 'log', truth: (p, context) => context.minIdle + 1440 / p.sessionsPerDay },
  ...Object.fromEntries(DRAWDOWN_BUCKETS.map((bucket) => [
    `stopHazard.${bucket}`,
    { scale: 'probability', truth: (p) => p.stopHazard[bucket] }
  ]))
});

export const RECOVERY_TARGET_NAMES = Object.freeze(Object.keys(RECOVERY_TARGETS));

export function parameterRecord(twin, target) {
  const [name, bucket] = target.split('.');
  return bucket ? twin.parameters[name][bucket] : twin.parameters[name];
}

function distance(a, b, scale) {
  return scale === 'log' ? Math.abs(Math.log(a) - Math.log(b)) : Math.abs(a - b);
}

function round(value, digits = 6) {
  if (value === null || value === undefined || !Number.isFinite(value)) return value ?? null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function share(count, total) {
  return total ? count / total : null;
}

// --- Evaluation ------------------------------------------------------------------

function coverageFor(rows, target) {
  const spec = RECOVERY_TARGETS[target];
  const counts = { estimated: 0, prior_only: 0, not_estimable: 0 };
  let traders = 0;
  let covered = 0;
  let below = 0;
  let above = 0;
  for (const { twin, truth, context } of rows) {
    const record = parameterRecord(twin, target);
    counts[record.status] += 1;
    if (!record.interval) continue;
    const value = spec.truth(truth.parameters, context);
    traders += 1;
    if (value < record.interval[0]) below += 1;
    else if (value > record.interval[1]) above += 1;
    else covered += 1;
  }
  return { traders, covered, below, above, share: share(covered, traders), statuses: counts };
}

function chaseRecovery(rows, settings) {
  const eligible = rows.filter(({ twin }) => {
    const record = twin.parameters.chaseCoefficient;
    return record.status === 'estimated' && record.nLoss >= settings.minLossEpisodes;
  });
  const truthLog = eligible.map(({ truth }) => Math.log(truth.parameters.chaseCoefficient));
  const estimateLog = eligible.map(({ twin }) => Math.log(twin.parameters.chaseCoefficient.estimate));
  const signed = eligible.filter(({ truth }) => Math.abs(truth.parameters.chaseCoefficient - 1) >= settings.signMargin);
  const recovered = signed.filter(({ twin, truth }) => Math.sign(Math.log(twin.parameters.chaseCoefficient.estimate))
    === Math.sign(Math.log(truth.parameters.chaseCoefficient)));
  return {
    minLossEpisodes: settings.minLossEpisodes,
    traders: eligible.length,
    pearsonLog: pearson(truthLog, estimateLog),
    signMargin: settings.signMargin,
    signTraders: signed.length,
    signRecovered: recovered.length,
    signShare: share(recovered.length, signed.length)
  };
}

// Low-history traders: each estimate should sit between its raw value and its prior
// center, and on average be closer to the truth than the raw value is. A posterior mean
// minimizes squared error, so "closer on average" is judged by mean squared error (on the
// log scale for log parameters). Mean absolute error is reported too.
function shrinkageFor(rows, target, settings) {
  const spec = RECOVERY_TARGETS[target];
  const low = rows.filter(({ twin, truth }) => {
    const record = parameterRecord(twin, target);
    return truth.sessionCount <= settings.lowHistorySessions && record.status === 'estimated'
      && record.raw !== null && record.priorEstimate !== null;
  });
  let between = 0;
  const estimateErrors = [];
  const rawErrors = [];
  const weights = [];
  for (const { twin, truth, context } of low) {
    const record = parameterRecord(twin, target);
    const lower = Math.min(record.raw, record.priorEstimate);
    const upper = Math.max(record.raw, record.priorEstimate);
    const slack = 1e-9 * Math.max(1, Math.abs(upper));
    if (record.estimate >= lower - slack && record.estimate <= upper + slack) between += 1;
    weights.push(record.weight);
    const value = spec.truth(truth.parameters, context);
    estimateErrors.push(distance(record.estimate, value, spec.scale));
    rawErrors.push(distance(record.raw, value, spec.scale));
  }
  const squared = (errors) => mean(errors.map((error) => error * error));
  return {
    traders: low.length,
    betweenRawAndPrior: between,
    meanWeight: mean(weights),
    meanSquaredErrorEstimate: squared(estimateErrors),
    meanSquaredErrorRaw: squared(rawErrors),
    meanAbsoluteErrorEstimate: mean(estimateErrors),
    meanAbsoluteErrorRaw: mean(rawErrors)
  };
}

// Traders with no observations: status prior_only, weight 0, estimate = their prior center.
function priorOnlyFor(rows, target) {
  const records = rows.map(({ twin }) => parameterRecord(twin, target)).filter((record) => record.status === 'prior_only');
  return {
    traders: records.length,
    weightZero: records.filter((record) => record.weight === 0).length,
    atPrior: records.filter((record) => record.estimate === record.priorEstimate).length
  };
}

// Mean shrinkage weight by tercile of n, among estimated traders.
function weightTrend(rows, target) {
  const records = rows.map(({ twin }) => parameterRecord(twin, target))
    .filter((record) => record.status === 'estimated' && record.weight !== null)
    .sort((a, b) => a.n - b.n);
  if (records.length < 3) return null;
  const cut = (k) => Math.round((records.length * k) / 3);
  return [0, 1, 2].map((part) => {
    const slice = records.slice(cut(part), cut(part + 1));
    return { maxN: slice.at(-1).n, meanWeight: mean(slice.map((record) => record.weight)) };
  });
}

function stopAccounting(rows) {
  let leftOut = 0;
  let leftOutStops = 0;
  let forced = 0;
  let residualLowerBound = 0;
  let sessions = 0;
  const pooled = Object.fromEntries(DRAWDOWN_BUCKETS.map((bucket) => [bucket, { truthTrades: 0, truthStops: 0, sampleTrades: 0, sampleStops: 0 }]));
  for (const { twin, truth } of rows) {
    const { realized } = truth;
    const traderForced = sum(Object.values(realized.stops.forced));
    const traderLeftOutStops = twin.stopSample?.leftOutUnaffordableStops ?? 0;
    leftOut += twin.stopSample?.leftOutUnaffordable ?? 0;
    leftOutStops += traderLeftOutStops;
    forced += traderForced;
    sessions += realized.sessions;
    // A forced stop the rule didn't leave out stays in the stop sample. At least this many did.
    residualLowerBound += Math.max(0, traderForced - traderLeftOutStops);
    for (const bucket of DRAWDOWN_BUCKETS) {
      pooled[bucket].truthTrades += realized.tradesByBucket[bucket];
      pooled[bucket].truthStops += realized.stops.hazard[bucket] + realized.stops.forced[bucket];
      const record = twin.parameters.stopHazard[bucket];
      if (record.status === 'estimated') {
        pooled[bucket].sampleTrades += record.n;
        pooled[bucket].sampleStops += record.stops;
      }
    }
  }
  return {
    basis: [...new Set(rows.map(({ twin }) => twin.stopHazardBasis))],
    leftOutUnaffordable: leftOut,
    leftOutUnaffordableStops: leftOutStops,
    truthSessions: sessions,
    truthForcedStops: forced,
    residualForcedStopsLowerBound: residualLowerBound,
    // Descriptive only (ADR-011): the truth's hazard + forced stops per trade come from the
    // same trades the estimator sees, so they are a sample proportion, not a parameter.
    pooledStopRates: Object.fromEntries(DRAWDOWN_BUCKETS.map((bucket) => {
      const p = pooled[bucket];
      return [bucket, { truthAllCause: share(p.truthStops, p.truthTrades), stopSample: share(p.sampleStops, p.sampleTrades) }];
    }))
  };
}

function traderRow(twin, truth, context) {
  const row = {
    traderToken: twin.traderToken,
    sessionCount: truth.sessionCount,
    nLoss: twin.parameters.chaseCoefficient.nLoss ?? null,
    stopHazardBasis: twin.stopHazardBasis,
    parameters: {}
  };
  for (const target of RECOVERY_TARGET_NAMES) {
    const record = parameterRecord(twin, target);
    row.parameters[target] = {
      truth: round(RECOVERY_TARGETS[target].truth(truth.parameters, context)),
      status: record.status,
      estimate: round(record.estimate),
      interval: record.interval ? record.interval.map((bound) => round(bound)) : null,
      raw: round(record.raw),
      priorEstimate: round(record.priorEstimate),
      n: record.n,
      weight: round(record.weight)
    };
  }
  return row;
}

/**
 * Compares a fit with the truth of the dataset it was fitted on. Returns a
 * SYNTHETIC-labelled summary; with includeTraders, also one row per trader.
 */
export function evaluateRecovery(dataset, fit, options = {}) {
  const settings = { ...RECOVERY_DEFAULTS, ...options };
  const context = { minIdle: minIdleMinutes(dataset.truth.options.behaviorOptions) };
  const truthByToken = new Map(dataset.truth.traders.map((trader) => [trader.traderToken, trader]));
  const rows = fit.twins.map((twin) => ({ twin, truth: truthByToken.get(twin.traderToken), context }));

  const perTarget = (compute) => Object.fromEntries(RECOVERY_TARGET_NAMES.map((target) => [target, compute(target)]));
  const results = {
    label: SYNTHETIC_LABEL,
    modelVersion: TWIN_MODEL_VERSION,
    behaviorVersion: BEHAVIOR_VERSION,
    generatorVersion: BEHAVIORAL_GENERATOR_VERSION,
    dataLabel: fit.dataLabel,
    scenario: {
      seed: dataset.truth.seed,
      traderCount: dataset.truth.traderCount,
      sessionsPerTrader: dataset.truth.options.sessionsPerTrader,
      includeBalances: dataset.truth.options.includeBalances,
      missingOutcomeShare: dataset.truth.options.missingOutcomeShare
    },
    settings: {
      intervalLevel: ESTIMATE_CONSTANTS.intervalLevel,
      minLossEpisodes: settings.minLossEpisodes,
      signMargin: settings.signMargin,
      lowHistorySessions: settings.lowHistorySessions
    },
    inputs: fit.inputs,
    coverage: perTarget((target) => coverageFor(rows, target)),
    chase: chaseRecovery(rows, settings),
    shrinkage: perTarget((target) => shrinkageFor(rows, target, settings)),
    priorOnly: perTarget((target) => priorOnlyFor(rows, target)),
    weightTrend: perTarget((target) => weightTrend(rows, target)),
    stops: stopAccounting(rows),
    priors: fit.priors
  };
  if (settings.includeTraders) results.traders = rows.map(({ twin, truth }) => traderRow(twin, truth, context));
  return results;
}

/**
 * Generates a population with known parameters, fits it, and evaluates recovery.
 * Options: seed, traderCount, sessionsPerTrader, includeBalances, missingOutcomeShare,
 * the evaluation settings in RECOVERY_DEFAULTS, and includeTraders.
 */
export function runTwinRecovery(options = {}) {
  const settings = { ...RECOVERY_DEFAULTS, ...options };
  const dataset = generateBehavioralDataset({
    seed: settings.seed,
    name: 'twin-recovery',
    mode: 'population',
    traderCount: settings.traderCount,
    sessionsPerTrader: settings.sessionsPerTrader,
    includeBalances: settings.includeBalances,
    missingOutcomeShare: settings.missingOutcomeShare
  });
  const fit = estimateTwins(dataset.events, { dataLabel: SYNTHETIC_LABEL, behaviorOptions: dataset.truth.options.behaviorOptions });
  return { dataset, fit, results: evaluateRecovery(dataset, fit, settings) };
}

// Parameters that need a realized outcome (TWIN_PARAMETER_DEFINITIONS), with stopHazard per bucket.
export const OUTCOME_DEPENDENT_TARGETS = Object.freeze([
  'baseStake', 'stakeDispersion', 'chaseCoefficient', 'escalationPerLoss', 'reentryLatencyAfterLoss',
  'reentryLatencyAfterWin', 'latencySpread', 'refuelProbability', 'refuelAfterLosingStreak', 'winRate', 'pushRate',
  'payoutMultiple', 'payoutSpread', ...DRAWDOWN_BUCKETS.map((bucket) => `stopHazard.${bucket}`)
]);

/**
 * A dataset with no realized outcomes and no balance fields: every outcome-dependent
 * parameter should be not_estimable. Returns the status counts per parameter.
 */
export function runNoOutcomeCheck(options = {}) {
  const settings = { seed: RECOVERY_DEFAULTS.seed, traderCount: 40, sessionsPerTrader: { min: 2, max: 20 }, ...options };
  const dataset = generateBehavioralDataset({
    seed: settings.seed,
    mode: 'population',
    traderCount: settings.traderCount,
    sessionsPerTrader: settings.sessionsPerTrader,
    includeBalances: false
  });
  const events = dataset.events.map(({ realized_result: _omitted, ...event }) => event);
  const fit = estimateTwins(events, { dataLabel: SYNTHETIC_LABEL });
  const statuses = {};
  for (const target of [...TWIN_PARAMETER_NAMES.filter((name) => name !== 'stopHazard'), ...DRAWDOWN_BUCKETS.map((bucket) => `stopHazard.${bucket}`)]) {
    statuses[target] = { estimated: 0, prior_only: 0, not_estimable: 0 };
    for (const twin of fit.twins) statuses[target][parameterRecord(twin, target).status] += 1;
  }
  return { label: SYNTHETIC_LABEL, traderCount: fit.twins.length, statuses, fit };
}

export const RECOVERY_SCENARIOS = deepFreeze({
  withBalances: {},
  withoutBalances: { includeBalances: false },
  missingOutcomes: { missingOutcomeShare: 0.3 }
});

/** Runs every scenario in RECOVERY_SCENARIOS plus the no-outcome check. */
export function runRecoveryScenarios(options = {}) {
  const scenarios = Object.fromEntries(Object.entries(RECOVERY_SCENARIOS).map(([name, scenario]) => [
    name,
    runTwinRecovery({ ...options, ...scenario }).results
  ]));
  const { fit: _fit, ...noOutcomes } = runNoOutcomeCheck({ seed: options.seed ?? RECOVERY_DEFAULTS.seed });
  return { label: SYNTHETIC_LABEL, modelVersion: TWIN_MODEL_VERSION, scenarios, noOutcomes };
}

function percent(value) {
  return value === null ? 'n/a' : `${(100 * value).toFixed(1)}%`;
}

/** A short plain-text summary of runRecoveryScenarios output, for the console. */
export function formatRecoverySummary(report) {
  const lines = [`${report.modelVersion} parameter recovery (${report.label})`];
  for (const [name, results] of Object.entries(report.scenarios)) {
    const { chase, coverage, stops, scenario } = results;
    lines.push('');
    lines.push(`${name}: ${scenario.traderCount} traders, seed ${scenario.seed}, balances ${scenario.includeBalances ? 'yes' : 'no'}, missing outcomes ${scenario.missingOutcomeShare}`);
    lines.push(`  chase (>= ${chase.minLossEpisodes} loss episodes, ${chase.traders} traders): log-scale r = ${chase.pearsonLog?.toFixed(3)}, sign ${chase.signRecovered}/${chase.signTraders}`);
    const cells = RECOVERY_TARGET_NAMES
      .filter((target) => coverage[target].traders)
      .map((target) => `${target} ${percent(coverage[target].share)}`);
    lines.push(`  90% interval coverage: ${cells.join(', ')}`);
    lines.push(`  stop basis ${stops.basis.join('/')}; left out as unaffordable ${stops.leftOutUnaffordable} trades (${stops.leftOutUnaffordableStops} stops); truth forced stops ${stops.truthForcedStops}, at least ${stops.residualForcedStopsLowerBound} left in the sample`);
  }
  const stuck = Object.entries(report.noOutcomes.statuses)
    .filter(([target, counts]) => OUTCOME_DEPENDENT_TARGETS.includes(target) && counts.not_estimable === report.noOutcomes.traderCount);
  lines.push('');
  lines.push(`no outcomes, no balances: ${stuck.length} of ${OUTCOME_DEPENDENT_TARGETS.length} outcome-dependent parameters not estimable for all ${report.noOutcomes.traderCount} traders`);
  return lines.join('\n');
}
