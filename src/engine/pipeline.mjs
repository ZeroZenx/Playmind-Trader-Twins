import { estimateTwins } from './estimate.mjs';
import { runHoldoutValidation } from './holdout.mjs';
import { POLICY_V2_TYPES, runPolicySweep } from './policy-sim.mjs';
import { buildReportV2 } from './report-v2.mjs';
import { lastObservedBalances } from './simulate.mjs';
import { validateEvents } from './validate.mjs';

export const PIPELINE_VERSION = 'analysis-pipeline-0.1.0';

const LABELS = new Set(['SYNTHETIC', 'OBSERVATIONAL', 'CUSTOMER']);

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value >= 1 ? value : fallback;
}

function validateOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('runTwinPipeline: options must be an object');
  if (!LABELS.has(options.dataLabel)) throw new RangeError('runTwinPipeline: dataLabel must be SYNTHETIC, OBSERVATIONAL, or CUSTOMER');
  if (!options.dataset || typeof options.dataset.name !== 'string') throw new RangeError('runTwinPipeline: dataset.name is required');
  const policies = options.policies ?? POLICY_V2_TYPES;
  if (!Array.isArray(policies) || !policies.length || policies.some((policy) => !POLICY_V2_TYPES.includes(policy))) {
    throw new RangeError(`runTwinPipeline: policies must come from ${POLICY_V2_TYPES.join(', ')}`);
  }
  return {
    ...options,
    policies,
    seed: Number.isInteger(options.seed) ? options.seed : 42,
    holdoutSeed: Number.isInteger(options.holdoutSeed) ? options.holdoutSeed : 7100,
    sweepSeed: Number.isInteger(options.sweepSeed) ? options.sweepSeed : 7200,
    holdoutReplicates: positiveInteger(options.holdoutReplicates, 3),
    sweepReplicates: positiveInteger(options.sweepReplicates, 3),
    horizonDays: positiveInteger(options.horizonDays, 30),
    generatedAt: options.generatedAt ?? new Date().toISOString()
  };
}

/**
 * Runs the same pure pipeline used by the CLI demo, with database work kept outside this
 * module. This gives API routes and the worker one deterministic implementation to call.
 */
export function runTwinPipeline(events, options) {
  const settings = validateOptions(options);
  const quality = validateEvents(events);
  if (!quality.valid) throw new Error(`Dataset failed validation: ${quality.errors.slice(0, 5).join(' ')}`);
  const behaviorOptions = settings.behaviorOptions ?? {};
  const fit = estimateTwins(events, { dataLabel: settings.dataLabel, behaviorOptions });
  const holdout = runHoldoutValidation(events, {
    dataLabel: settings.dataLabel,
    behaviorOptions,
    seed: settings.holdoutSeed,
    replicates: settings.holdoutReplicates,
    ksReplicates: Math.min(settings.holdoutReplicates, 2),
    includeTraders: false
  });
  const sweep = runPolicySweep(
    fit,
    { policies: settings.policies },
    {
      seed: settings.sweepSeed,
      replicates: settings.sweepReplicates,
      horizonDays: settings.horizonDays,
      startingBalances: lastObservedBalances(events)
    },
  );
  const report = buildReportV2({
    dataset: {
      events,
      name: settings.dataset.name,
      venueId: settings.dataset.venueId ?? null,
      generator: settings.dataset.generator ?? null
    },
    quality,
    fit,
    holdout,
    sweep,
    traderGroups: settings.traderGroups ?? null,
    generatedAt: settings.generatedAt
  });
  return { pipelineVersion: PIPELINE_VERSION, settings, quality, fit, holdout, sweep, report };
}
