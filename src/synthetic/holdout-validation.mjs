/**
 * Held-out validation (holdout-0.1.0, ADR-014) on a SYNTHETIC behavioral population.
 *
 * scripts/twin-holdout.mjs (npm run twin:holdout) calls this module, and
 * test/holdout-validation.test.mjs calls it at a small scale, so the local results file
 * and the tests come from one computation. It generates a behavioral-synthetic population
 * in population mode, with enough sessions per trader for a usable test window, and runs
 * runHoldoutValidation on it once per data path:
 * - balances: events with balance_before and balance_after;
 * - no-balances: the same traders and events without balance fields, so stop hazards are
 *   all-cause and refuel is the losing-streak proxy. This is the path closest to what we
 *   expect from Sporttrade.
 * Each path also simulates the truth reference: twins on the generator's true parameters,
 * uncertainty off (truth-twins.mjs).
 *
 * Validation numbers (coverage, D, errors, pass/fail counts) belong only in test
 * thresholds and the gitignored output the script writes. Don't copy them into docs or
 * commit messages. Pure: no I/O.
 */

import { BEHAVIORAL_GENERATOR_VERSION, SYNTHETIC_LABEL, generateBehavioralDataset } from './behavioral-generate.mjs';
import { truthFit } from './truth-twins.mjs';
import { HOLDOUT_DEFAULTS, HOLDOUT_METRICS, HOLDOUT_VERSION, runHoldoutValidation } from '../engine/holdout.mjs';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export const HOLDOUT_PATHS = deepFreeze({
  balances: { includeBalances: true, description: 'with balance fields: voluntary stop hazards, low-balance refuel' },
  'no-balances': { includeBalances: false, description: 'without balance fields: all-cause stop hazards, proxy (losing-streak) refuel' }
});

export const HOLDOUT_PATH_NAMES = Object.freeze(Object.keys(HOLDOUT_PATHS));

/** The default run. Scale down with traderCount, replicates, ksReplicates, or paths. */
export const HOLDOUT_RUN_DEFAULTS = deepFreeze({
  seed: 20261117,
  traderCount: 200,
  // At least 20 sessions, so a 25% test window has about 5 or more.
  sessionsPerTrader: { min: 20, max: 80 },
  simulationSeed: HOLDOUT_DEFAULTS.seed,
  replicates: 100,
  ksReplicates: HOLDOUT_DEFAULTS.ksReplicates,
  paths: HOLDOUT_PATH_NAMES,
  includeTraders: false
});

/**
 * Generates the population and runs held-out validation on each path. Options:
 * HOLDOUT_RUN_DEFAULTS and onProgress({ path, model, replicate, of }). Returns { label,
 * holdoutVersion, generatorVersion, scenario, runs }, with runs keyed by path name.
 */
export function runSyntheticHoldout(options = {}) {
  const { onProgress, ...rest } = options;
  for (const key of Object.keys(rest)) {
    if (!Object.hasOwn(HOLDOUT_RUN_DEFAULTS, key)) throw new RangeError(`runSyntheticHoldout: unknown option "${key}"`);
  }
  const settings = { ...HOLDOUT_RUN_DEFAULTS, ...rest };
  if (!Array.isArray(settings.paths) || !settings.paths.length || settings.paths.some((path) => !HOLDOUT_PATH_NAMES.includes(path))) {
    throw new RangeError(`runSyntheticHoldout: paths must be a non-empty list from ${HOLDOUT_PATH_NAMES.join(', ')}`);
  }
  const runs = {};
  for (const path of settings.paths) {
    const dataset = generateBehavioralDataset({
      seed: settings.seed,
      name: 'twin-holdout',
      mode: 'population',
      traderCount: settings.traderCount,
      sessionsPerTrader: settings.sessionsPerTrader,
      includeBalances: HOLDOUT_PATHS[path].includeBalances
    });
    const result = runHoldoutValidation(dataset.events, {
      dataLabel: SYNTHETIC_LABEL,
      behaviorOptions: dataset.truth.options.behaviorOptions,
      seed: settings.simulationSeed,
      replicates: settings.replicates,
      ksReplicates: settings.ksReplicates,
      reference: { fit: truthFit(dataset) },
      includeTraders: settings.includeTraders,
      onProgress: onProgress ? (progress) => onProgress({ path, ...progress }) : null
    });
    runs[path] = { path, pathDescription: HOLDOUT_PATHS[path].description, ...result };
  }
  return {
    label: SYNTHETIC_LABEL,
    holdoutVersion: HOLDOUT_VERSION,
    generatorVersion: BEHAVIORAL_GENERATOR_VERSION,
    scenario: {
      seed: settings.seed,
      mode: 'population',
      traderCount: settings.traderCount,
      sessionsPerTrader: settings.sessionsPerTrader,
      simulationSeed: settings.simulationSeed,
      replicates: settings.replicates,
      ksReplicates: settings.ksReplicates,
      paths: [...settings.paths]
    },
    runs
  };
}

const fixed = (value, digits = 3) => (value === null || value === undefined ? 'n/a' : Number(value).toFixed(digits));
const verdict = (value) => (value === null ? 'n/a' : value ? 'yes' : 'no');

/** A short plain-text summary of runSyntheticHoldout output, for the console. */
export function formatHoldoutSummary(results) {
  const { scenario } = results;
  const lines = [
    `${results.holdoutVersion} held-out validation (${results.label})`,
    `${scenario.traderCount} traders, ${scenario.sessionsPerTrader.min}-${scenario.sessionsPerTrader.max} sessions, seed ${scenario.seed}, simulation seed ${scenario.simulationSeed}, ${scenario.replicates} replicates (KS on ${Math.min(scenario.ksReplicates, scenario.replicates)})`
  ];
  for (const run of Object.values(results.runs)) {
    const { overall, perMetric } = run.summary;
    lines.push(
      '',
      `[${run.path}] ${run.pathDescription}`,
      `  ${run.modelVersion} vs ${run.baselineVersion} and ${run.naiveVersion}; split: trainShare ${run.split.trainShare}, session boundary; ${run.inputs.compared} of ${run.inputs.traders} traders compared`,
      `  labels: ${run.labels.allCauseStops.length} all-cause stops, ${run.labels.proxyRefuel.length} proxy refuel, ${run.labels.notCompared.length} not compared`,
      '  metric: calibration | KS D twin / truth / baseline / naive | median abs error twin / baseline / naive | beats baseline, naive | pass'
    );
    for (const [name, cell] of Object.entries(perMetric)) {
      const metric = run.metrics[name];
      const d = (key) => fixed(metric.models[key]?.ksD);
      const e = (key) => fixed(metric.models[key]?.pointError?.medianAbsoluteError);
      lines.push(`  ${name}${HOLDOUT_METRICS[name].scored ? '' : ' (diagnostic)'}: ${fixed(cell.calibration.share)} | ${d('twin')} / ${d('truth')} / ${d('baseline')} / ${d('naive')} | ${e('twin')} / ${e('baseline')} / ${e('naive')} | ${verdict(cell.beats.baseline?.beats ?? null)}, ${verdict(cell.beats.naive?.beats ?? null)} | ${verdict(cell.pass)}`);
    }
    lines.push(
      `  beats baseline-0.1 on ${overall.beats.baseline.metricsBeaten} of ${overall.beats.baseline.metricsCompared} metrics, naive-0.1 on ${overall.beats.naive.metricsBeaten} of ${overall.beats.naive.metricsCompared}`,
      `  calibration pass on ${overall.calibration.metricsPassed} of ${overall.calibration.metricsScored}, distribution pass on ${overall.distribution.metricsPassed} of ${overall.distribution.metricsScored}; overall pass: ${verdict(overall.pass)}`,
      `  ${overall.claim.statement}`
    );
  }
  return lines.join('\n');
}
