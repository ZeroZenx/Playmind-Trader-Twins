/**
 * Report v2 (report-0.2.0) on a SYNTHETIC behavioral population: the pipeline behind
 * `npm run demo`.
 *
 * demo/run.mjs calls this module, and test/report-v2.test.mjs calls it at a small scale, so
 * the demo and the tests come from one computation. Steps, in the order customer data will
 * go through them:
 *   generate a behavioral-synthetic population -> validateEvents -> estimateTwins ->
 *   runHoldoutValidation (with the truth reference) -> runPolicySweep (starting at each
 *   trader's last observed balance) -> buildReportV2.
 *
 * The report contains held-out validation results, so its files belong in gitignored local
 * output (demo/output/ is gitignored). Pure: no I/O.
 */

import { BEHAVIORAL_GENERATOR_VERSION, SYNTHETIC_LABEL, generateBehavioralDataset } from './behavioral-generate.mjs';
import { truthFit } from './truth-twins.mjs';
import { estimateTwins } from '../engine/estimate.mjs';
import { runHoldoutValidation } from '../engine/holdout.mjs';
import { POLICY_V2_TYPES, runPolicySweep } from '../engine/policy-sim.mjs';
import { buildReportV2 } from '../engine/report-v2.mjs';
import { lastObservedBalances } from '../engine/simulate.mjs';
import { validateEvents } from '../engine/validate.mjs';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** The default demo. Scale down with traderCount, the replicate counts, or policies. */
export const REPORT_DEMO_DEFAULTS = deepFreeze({
  seed: 20261118,
  traderCount: 80,
  sessionsPerTrader: { min: 20, max: 80 },
  // false drops balance fields: all-cause stops and proxy refuel, closest to Sporttrade.
  includeBalances: true,
  holdoutSeed: 7100,
  holdoutReplicates: 40,
  sweepSeed: 7200,
  sweepReplicates: 30,
  horizonDays: 28,
  policies: POLICY_V2_TYPES
});

/**
 * Runs the pipeline and builds report v2. Options: REPORT_DEMO_DEFAULTS, generatedAt
 * (an ISO string or null), and onProgress({ step, ... }). Returns { dataset, report }.
 */
export function runReportDemo(options = {}) {
  const { onProgress = null, generatedAt = null, ...rest } = options;
  for (const key of Object.keys(rest)) {
    if (!Object.hasOwn(REPORT_DEMO_DEFAULTS, key)) throw new RangeError(`runReportDemo: unknown option "${key}"`);
  }
  const settings = { ...REPORT_DEMO_DEFAULTS, ...rest };
  const progress = (step, detail = {}) => { if (onProgress) onProgress({ step, ...detail }); };

  progress('generate');
  const dataset = generateBehavioralDataset({
    seed: settings.seed,
    name: 'behavioral-synthetic-report',
    mode: 'population',
    traderCount: settings.traderCount,
    sessionsPerTrader: settings.sessionsPerTrader,
    includeBalances: settings.includeBalances
  });
  const quality = validateEvents(dataset.events);
  if (!quality.valid) throw new Error(`runReportDemo: synthetic dataset failed validation: ${quality.errors.slice(0, 3).join(' ')}`);
  const behaviorOptions = dataset.truth.options.behaviorOptions;

  progress('fit');
  const fit = estimateTwins(dataset.events, { dataLabel: SYNTHETIC_LABEL, behaviorOptions });

  progress('holdout');
  const holdout = runHoldoutValidation(dataset.events, {
    dataLabel: SYNTHETIC_LABEL,
    behaviorOptions,
    seed: settings.holdoutSeed,
    replicates: settings.holdoutReplicates,
    reference: { fit: truthFit(dataset) },
    onProgress: onProgress ? (detail) => progress('holdout', detail) : null
  });

  progress('sweep');
  const sweep = runPolicySweep(fit, { policies: [...settings.policies] }, {
    seed: settings.sweepSeed,
    replicates: settings.sweepReplicates,
    horizonDays: settings.horizonDays,
    startingBalances: settings.includeBalances ? lastObservedBalances(dataset.events) : {},
    onProgress: onProgress ? (detail) => progress('sweep', detail) : undefined
  });

  progress('report');
  const archetypes = Object.fromEntries(dataset.truth.traders.map((trader) => [trader.traderToken, trader.archetype]));
  const report = buildReportV2({
    dataset: { events: dataset.events, name: dataset.truth.name, venueId: dataset.truth.options.venueId, generator: `${BEHAVIORAL_GENERATOR_VERSION} (population mode, seed ${settings.seed})` },
    quality,
    fit,
    holdout,
    sweep,
    traderGroups: archetypes,
    generatedAt
  });
  return { dataset, report, settings };
}
