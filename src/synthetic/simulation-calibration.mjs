/**
 * Simulator calibration on SYNTHETIC traders: does simulateTwinV2 reproduce the
 * training behavior of the traders it was given?
 *
 * test/simulation-calibration.test.mjs and scripts/twin-simulation.mjs both call this
 * module, so the test thresholds and the local results file come from one computation.
 * It generates a behavioral-synthetic population and simulates each trader for its
 * training session count twice:
 * - truth: twins built from the generator's known parameters (truth-twins.mjs), with
 *   uncertainty off. Only process noise is left, so about 80% of traders should have
 *   their observed value inside the simulated 10th-90th percentile band for a
 *   continuous metric, and more for a count with ties.
 * - fitted: twins from estimateTwins on the same events, with uncertainty on. This is
 *   in-sample (the twins were fitted to the data they are compared with), so coverage
 *   runs high. Held-out validation is holdout-validation.mjs (ADR-014).
 *
 * Calibration numbers belong only in test thresholds and the gitignored output the
 * script writes. Don't copy them into docs or commit messages. Pure: no I/O.
 */

import { BEHAVIORAL_GENERATOR_VERSION, SYNTHETIC_LABEL, generateBehavioralDataset } from './behavioral-generate.mjs';
import { truthFit } from './truth-twins.mjs';
import { TWIN_MODEL_VERSION, estimateTwins } from '../engine/estimate.mjs';
import { SIMULATOR_VERSION, metricsFromEvents, simulateTwinV2 } from '../engine/simulate.mjs';
import { sum } from '../engine/stats.mjs';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export const CALIBRATION_DEFAULTS = deepFreeze({
  seed: 20261114,
  traderCount: 60,
  sessionsPerTrader: { min: 10, max: 40 },
  replicates: 50,
  simulationSeed: 4100
});

/**
 * The compared metrics. count: true marks per-session counts, whose many ties put more
 * than 80% of observed values inside a 10th-90th percentile band.
 */
export const CALIBRATION_METRICS = deepFreeze({
  tradesPerSession: { count: false },
  meanStake: { count: false },
  chaseEpisodesPerSession: { count: true },
  forcedStopsPerSession: { count: true },
  medianSessionDrawdown: { count: false },
  refuelDepositsPerSession: { count: true },
  winShare: { count: false }
});

export const CALIBRATION_METRIC_NAMES = Object.freeze(Object.keys(CALIBRATION_METRICS));

/**
 * Each trader's observed training value of every calibration metric. Event-observable
 * metrics come from metricsFromEvents (the simulator's own definitions), with chase
 * episodes judged against `baseStakes`. Forced stops and refuel deposits are the
 * generator's internal decisions, so they come from the truth file.
 */
export function observedTrainingMetrics(dataset, baseStakes) {
  const fromEvents = metricsFromEvents(dataset.events, { baseStakes, behaviorOptions: dataset.truth.options.behaviorOptions });
  return Object.fromEntries(dataset.truth.traders.map((trader) => {
    const observed = fromEvents[trader.traderToken];
    const { realized } = trader;
    return [trader.traderToken, {
      tradesPerSession: observed.tradesPerSession,
      meanStake: observed.meanStake,
      chaseEpisodesPerSession: observed.chaseEpisodesPerSession,
      forcedStopsPerSession: sum(Object.values(realized.stops.forced)) / realized.sessions,
      medianSessionDrawdown: observed.medianSessionDrawdown,
      refuelDepositsPerSession: realized.deposits.refuel / realized.sessions,
      winShare: observed.winShare
    }];
  }));
}

// Share of traders whose observed value lies inside their simulated [p10, p90] band.
function coverage(simulation, observed) {
  const slack = 1e-9;
  return Object.fromEntries(CALIBRATION_METRIC_NAMES.map((metric) => {
    let traders = 0;
    let inside = 0;
    let below = 0;
    let above = 0;
    for (const trader of simulation.traders) {
      if (!trader.simulable) continue;
      const value = observed[trader.traderToken]?.[metric];
      const band = trader.metrics[metric];
      if (value === null || value === undefined || band.p10 === null) continue;
      traders += 1;
      if (value < band.p10 - slack) below += 1;
      else if (value > band.p90 + slack) above += 1;
      else inside += 1;
    }
    return [metric, { traders, inside, below, above, share: traders ? inside / traders : null }];
  }));
}

function traderRows(simulation, observed, run) {
  return simulation.traders.map((trader) => ({
    run,
    traderToken: trader.traderToken,
    simulable: trader.simulable,
    metrics: trader.simulable
      ? Object.fromEntries(CALIBRATION_METRIC_NAMES.map((metric) => [metric, {
        observed: observed[trader.traderToken]?.[metric] ?? null,
        p10: trader.metrics[metric].p10,
        median: trader.metrics[metric].median,
        p90: trader.metrics[metric].p90
      }]))
      : null
  }));
}

/**
 * Generates the population, simulates it on truth and on fitted parameters, and returns
 * the per-metric coverage of each run. Options: CALIBRATION_DEFAULTS and includeTraders.
 */
export function runSimulationCalibration(options = {}) {
  const settings = { ...CALIBRATION_DEFAULTS, ...options };
  const dataset = generateBehavioralDataset({
    seed: settings.seed,
    name: 'simulation-calibration',
    mode: 'population',
    traderCount: settings.traderCount,
    sessionsPerTrader: settings.sessionsPerTrader
  });
  const { truth } = dataset;
  const common = {
    seed: settings.simulationSeed,
    replicates: settings.replicates,
    sessions: Object.fromEntries(truth.traders.map((trader) => [trader.traderToken, trader.sessionCount])),
    start: truth.options.startDate
  };

  const truthSimulation = simulateTwinV2(truthFit(dataset), { ...common, uncertainty: false });
  const truthObserved = observedTrainingMetrics(dataset, Object.fromEntries(truth.traders.map((trader) => [trader.traderToken, trader.parameters.baseStake])));

  const fit = estimateTwins(dataset.events, { dataLabel: SYNTHETIC_LABEL, behaviorOptions: truth.options.behaviorOptions });
  const fittedSimulation = simulateTwinV2(fit, { ...common, uncertainty: true });
  const fittedObserved = observedTrainingMetrics(dataset, Object.fromEntries(fit.twins.map((twin) => [twin.traderToken, twin.parameters.baseStake.estimate])));

  const results = {
    label: SYNTHETIC_LABEL,
    modelVersion: TWIN_MODEL_VERSION,
    simulatorVersion: SIMULATOR_VERSION,
    generatorVersion: BEHAVIORAL_GENERATOR_VERSION,
    scenario: {
      seed: settings.seed,
      traderCount: settings.traderCount,
      sessionsPerTrader: settings.sessionsPerTrader,
      replicates: settings.replicates,
      simulationSeed: settings.simulationSeed,
      horizon: 'each trader\'s training session count'
    },
    band: 'observed training value inside the simulated [p10, p90]',
    truth: {
      parameters: 'generator truth (point masses)',
      uncertainty: false,
      coverage: coverage(truthSimulation, truthObserved),
      notSimulable: truthSimulation.population.notSimulable
    },
    fitted: {
      parameters: `estimateTwins (${TWIN_MODEL_VERSION}) on the same events: in-sample`,
      uncertainty: true,
      coverage: coverage(fittedSimulation, fittedObserved),
      notSimulable: fittedSimulation.population.notSimulable
    }
  };
  if (settings.includeTraders) {
    results.traders = [...traderRows(truthSimulation, truthObserved, 'truth'), ...traderRows(fittedSimulation, fittedObserved, 'fitted')];
  }
  return results;
}

function percent(value) {
  return value === null ? 'n/a' : `${(100 * value).toFixed(1)}%`;
}

/** A short plain-text summary of runSimulationCalibration output, for the console. */
export function formatCalibrationSummary(results) {
  const { scenario } = results;
  const lines = [
    `${results.simulatorVersion} calibration on ${results.modelVersion} twins (${results.label})`,
    `${scenario.traderCount} traders, seed ${scenario.seed}, ${scenario.replicates} replicates, horizon: ${scenario.horizon}`,
    `share of traders with the ${results.band}:`
  ];
  for (const run of ['truth', 'fitted']) {
    const { coverage: cells, uncertainty } = results[run];
    lines.push(`  ${run} (uncertainty ${uncertainty ? 'on' : 'off'}): ${CALIBRATION_METRIC_NAMES.map((metric) => `${metric} ${percent(cells[metric].share)}`).join(', ')}`);
  }
  return lines.join('\n');
}
