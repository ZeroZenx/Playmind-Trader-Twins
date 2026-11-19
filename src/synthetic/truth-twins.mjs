/**
 * Twins built from the behavioral generator's known parameters (SYNTHETIC only).
 *
 * truthFit(dataset) turns a generateBehavioralDataset truth file into an object shaped
 * like an estimateTwins fit, so simulateTwinV2 can run each trader on its true
 * parameters. Every parameter is a point mass ({ family: 'point', value }), so draws and
 * point estimates are the same value. estimateTwins never produces a point mass: it is
 * only for known synthetic parameters. Pure: no I/O.
 *
 * Mapping (docs/BEHAVIORAL-SYNTHETIC.md):
 * - stakeDispersion = stakeNoise, latencySpread = latencyNoise, depositSize =
 *   depositAmount, depositSpread = depositNoise, winRate = winProbability, pushRate =
 *   pushProbability, payoutSpread = payoutNoise; the rest keep their names.
 * - meanIdleMinutes = minIdle + 1440 / sessionsPerDay, with minIdle the generator's
 *   minimum idle time. The generator's idle shape differs from the simulator's (ADR-012).
 * - stopHazard is the generator's hazard, which excludes the broke rule: basis voluntary.
 * - refuelProbability is the low-balance refuel probability. The generator has no
 *   losing-streak refuel, so refuelAfterLosingStreak is not estimable.
 * - Losses always forfeit the whole stake: every loss quantile is -1.
 */

import { BEHAVIORAL_GENERATOR_VERSION, SYNTHETIC_LABEL } from './behavioral-generate.mjs';
import { minIdleMinutes } from './twin-recovery.mjs';
import { BEHAVIOR_VERSION, DEFAULT_BEHAVIOR_OPTIONS, DRAWDOWN_BUCKETS } from '../engine/behavior.mjs';
import { TWIN_MODEL_VERSION } from '../engine/estimate.mjs';

const KNOWN_REASON = 'known generator parameter (SYNTHETIC truth), not an estimate';

function known(value) {
  return {
    status: 'estimated',
    estimate: value,
    interval: [value, value],
    n: null,
    weight: null,
    raw: value,
    priorEstimate: null,
    reason: KNOWN_REASON,
    posterior: { family: 'point', value }
  };
}

function wholeStakeLosses(count) {
  return {
    n: count,
    quantiles: { p10: -1, p25: -1, p50: -1, p75: -1, p90: -1 },
    source: 'generator rule: a loss forfeits the whole stake (ratio -1)'
  };
}

/**
 * One twin from one truth trader ({ traderToken, parameters, sessionCount, realized? }).
 * behaviorOptions are the generator's resolved options; includeBalances says whether the
 * training events carried balance fields.
 */
export function truthTwin(trader, behaviorOptions, { includeBalances = true } = {}) {
  const p = trader.parameters;
  const realized = trader.realized ?? {};
  return {
    traderToken: trader.traderToken,
    modelVersion: TWIN_MODEL_VERSION,
    dataLabel: SYNTHETIC_LABEL,
    source: 'generator truth',
    archetype: trader.archetype ?? null,
    trainingWindow: { start: realized.firstEventAt ?? null, end: realized.lastEventAt ?? null },
    inputs: {
      hasOutcomes: true,
      hasCompleteBalances: includeBalances,
      sessionCount: trader.sessionCount ?? null,
      tradeCount: realized.trades ?? null
    },
    parameters: {
      baseStake: known(p.baseStake),
      stakeDispersion: known(p.stakeNoise),
      chaseCoefficient: known(p.chaseCoefficient),
      escalationPerLoss: known(p.escalationPerLoss),
      reentryLatencyAfterLoss: known(p.reentryLatencyAfterLoss),
      reentryLatencyAfterWin: known(p.reentryLatencyAfterWin),
      latencySpread: known(p.latencyNoise),
      stopHazard: Object.fromEntries(DRAWDOWN_BUCKETS.map((bucket) => [bucket, known(p.stopHazard[bucket])])),
      refuelProbability: known(p.refuelProbability),
      refuelAfterLosingStreak: {
        status: 'not_estimable',
        estimate: null,
        interval: null,
        n: 0,
        weight: null,
        raw: null,
        priorEstimate: null,
        reason: 'not a generator parameter: the generator refuels on the low-balance trigger',
        posterior: null,
        fallback: null
      },
      depositSize: known(p.depositAmount),
      depositSpread: known(p.depositNoise),
      winRate: known(p.winProbability),
      pushRate: known(p.pushProbability),
      payoutMultiple: known(p.payoutMultiple),
      payoutSpread: known(p.payoutNoise),
      meanIdleMinutes: known(minIdleMinutes(behaviorOptions) + 1440 / p.sessionsPerDay)
    },
    stopHazardBasis: 'voluntary',
    payoutDistribution: {
      resultPerStake: {
        wins: { n: realized.wins ?? null, quantiles: null },
        losses: wholeStakeLosses(realized.losses ?? null)
      }
    }
  };
}

/** A fit-shaped object of truth twins for every trader in a generateBehavioralDataset result. */
export function truthFit(dataset) {
  const { truth } = dataset;
  const behaviorOptions = { ...DEFAULT_BEHAVIOR_OPTIONS, ...truth.options.behaviorOptions, minSampleSizes: {} };
  const twins = truth.traders.map((trader) => truthTwin(trader, behaviorOptions, { includeBalances: truth.options.includeBalances }));
  const starts = twins.map((twin) => twin.trainingWindow.start).filter(Boolean).sort();
  const ends = twins.map((twin) => twin.trainingWindow.end).filter(Boolean).sort();
  return {
    modelVersion: TWIN_MODEL_VERSION,
    behaviorVersion: BEHAVIOR_VERSION,
    generatorVersion: BEHAVIORAL_GENERATOR_VERSION,
    dataLabel: SYNTHETIC_LABEL,
    source: 'generator truth: known parameters as point-mass posteriors',
    behaviorOptions,
    trainingWindow: { start: starts[0] ?? null, end: ends.at(-1) ?? null },
    twins
  };
}
