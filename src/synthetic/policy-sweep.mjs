/**
 * The policy-0.2.0 sensitivity sweep (ADR-013) on a SYNTHETIC behavioral population.
 *
 * scripts/policy-sweep.mjs (npm run policy:sweep) calls this module, and
 * test/policy-sweep.test.mjs calls it at a small scale, so the local results file and the
 * tests come from one computation. It generates a behavioral-synthetic population, fits
 * twins with estimateTwins (the same pipeline customer data will go through), starts each
 * trader at their last observed balance, and runs runPolicySweep.
 *
 * Every number it produces is a simulation under stated assumptions, with trader responses
 * assumed rather than estimated. Policy result numbers belong only in test thresholds and
 * the gitignored output the script writes. Don't copy them into docs or commit messages.
 * Pure: no I/O.
 */

import { BEHAVIORAL_GENERATOR_VERSION, SYNTHETIC_LABEL, generateBehavioralDataset } from './behavioral-generate.mjs';
import { estimateTwins } from '../engine/estimate.mjs';
import { DEFAULT_POLICY_SWEEP, POLICY_V2_TYPES, runPolicySweep } from '../engine/policy-sim.mjs';
import { SIMULATION_DEFAULTS, lastObservedBalances } from '../engine/simulate.mjs';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/**
 * The default run. Scale down with traderCount, replicates, policies, or design: the cost
 * is about (cells + 1) x traders x replicates simulated runs.
 */
export const POLICY_SWEEP_RUN_DEFAULTS = deepFreeze({
  seed: 20261115,
  traderCount: 500,
  sessionsPerTrader: { min: 10, max: 120, scale: 'log' },
  // false drops balance fields from the training events: all-cause stops and proxy refuel.
  includeBalances: true,
  simulationSeed: 5200,
  replicates: SIMULATION_DEFAULTS.replicates,
  horizonDays: SIMULATION_DEFAULTS.horizonDays,
  design: DEFAULT_POLICY_SWEEP.design,
  policies: POLICY_V2_TYPES
});

/**
 * Generates the population, fits it, and runs the sweep. Options: POLICY_SWEEP_RUN_DEFAULTS
 * and onProgress({ traders, of }). Returns runPolicySweep's result plus `label`,
 * `generatorVersion`, and `scenario` (the run's settings).
 */
export function runSyntheticPolicySweep(options = {}) {
  const { onProgress, ...rest } = options;
  for (const key of Object.keys(rest)) {
    if (!Object.hasOwn(POLICY_SWEEP_RUN_DEFAULTS, key)) throw new RangeError(`runSyntheticPolicySweep: unknown option "${key}"`);
  }
  const settings = { ...POLICY_SWEEP_RUN_DEFAULTS, ...rest };
  const dataset = generateBehavioralDataset({
    seed: settings.seed,
    name: 'policy-sweep',
    mode: 'population',
    traderCount: settings.traderCount,
    sessionsPerTrader: settings.sessionsPerTrader,
    includeBalances: settings.includeBalances
  });
  const fit = estimateTwins(dataset.events, { dataLabel: SYNTHETIC_LABEL, behaviorOptions: dataset.truth.options.behaviorOptions });
  const startingBalances = settings.includeBalances ? lastObservedBalances(dataset.events) : {};
  const results = runPolicySweep(fit, { policies: [...settings.policies], design: settings.design }, {
    seed: settings.simulationSeed,
    replicates: settings.replicates,
    horizonDays: settings.horizonDays,
    startingBalances,
    onProgress
  });
  return {
    label: SYNTHETIC_LABEL,
    generatorVersion: BEHAVIORAL_GENERATOR_VERSION,
    scenario: {
      seed: settings.seed,
      traderCount: settings.traderCount,
      sessionsPerTrader: settings.sessionsPerTrader,
      includeBalances: settings.includeBalances,
      simulationSeed: settings.simulationSeed,
      replicates: settings.replicates,
      horizonDays: settings.horizonDays,
      design: settings.design,
      policies: [...settings.policies],
      startingBalances: settings.includeBalances ? 'each trader\'s last observed balance_after' : '0, with the session-start deposit rule (no balance fields)'
    },
    ...results
  };
}

const band = (summary) => (summary && summary.median !== null
  ? `${summary.median.toFixed(3)} [${summary.p10.toFixed(3)}, ${summary.p90.toFixed(3)}]`
  : 'n/a');

/** A short plain-text summary of runSyntheticPolicySweep output, for the console. */
export function formatPolicySweepSummary(results) {
  const { scenario, primary, labels } = results;
  const simulable = results.traders.filter((trader) => trader.simulable).length;
  const lines = [
    `${results.policyVersion} sweep on ${results.modelVersion} twins, ${results.simulatorVersion} (${results.label})`,
    `${scenario.traderCount} traders (${simulable} simulable), seed ${scenario.seed}, simulation seed ${results.seed}, ${results.replicates} replicates, ${results.horizon.days}-day horizon, ${results.design}, ${results.cellCount} cells`,
    results.claim,
    `Population medians [p10, p90] with every response assumption at its default. Harm: ${primary.harm}; activity: ${primary.activity}; beyond = harm reduction - (1 - activity retained).`
  ];
  for (const policy of results.policies) {
    lines.push('', `${policy.type}`);
    const defaults = policy.chart.series.find((series) => series.isDefault) ?? policy.chart.series[0];
    for (const point of defaults.points) {
      lines.push(`  ${point.settingLabel}: harm reduction ${band(point.harmReduction)}, activity retained ${band(point.activityRetained)}, beyond ${band(point.beyondActivityCut)}`);
    }
    lines.push(`  Driver: ${policy.driver.statement}`);
  }
  lines.push('', `Labels: ${labels.allCauseStops.length} all-cause stops, ${labels.proxyRefuel.length} proxy refuel, ${labels.moneyNotSimulated.length} without a money model (deposit_limit not applicable), ${labels.notSimulable.length} not simulable.`);
  return lines.join('\n');
}
