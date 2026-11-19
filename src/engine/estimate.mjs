/**
 * Twin parameter estimation, model version twin-0.3.0.
 *
 * twin-0.3.0 is twin-0.2.1 on behavior-0.3.0 observations (outcome timing,
 * ADR-018), plus a per-trader settlement-lag distribution (settlementLagMinutes
 * and settlementLagSpread) when trades carry settled_at. Base stakes include
 * trades placed before any outcome was known, and the stop sample's
 * affordability rule uses the outcome known after each trade. Without settled_at
 * and placed_at every other parameter equals twin-0.2.1's.
 *
 * twin-0.2.1 was twin-0.2.0 plus two spreads the Prompt 4 simulator needs:
 * latencySpread and depositSpread (ADR-012).
 *
 * A twin is a small set of interpretable behavioral parameters per trader. Each
 * parameter has a point estimate, a 90% interval, a sample size n, a shrinkage
 * weight, and a status. The estimator reads only the behavior-0.2.0
 * observations from buildBehaviorObservations (behavior.mjs), so it reuses the
 * signal definitions instead of re-implementing them. It never reads market or
 * contract fields, and a missing realized outcome is never treated as zero.
 *
 * Each parameter goes through three steps (docs/MODEL_CARD.md, ADR-011):
 * 1. Raw estimate. The trader's own estimate and its sampling variance.
 * 2. Population prior. Fitted by method of moments to every trader's raw
 *    estimate in the same dataset, with the sampling noise taken out.
 * 3. Shrinkage. A conjugate update of the prior with the trader's data:
 *    normal-normal on the log scale for stakes, multipliers, latencies, deposit
 *    size, and payout; beta-binomial for probabilities; inverse-gamma with
 *    exponential data for the mean idle time between sessions. Traders with
 *    little data stay near the prior; traders with more move to their own value.
 *
 * Parameters are defined the way the Prompt 4 simulator will use them:
 * next stake = baseStake x chaseCoefficient (after a loss) x
 * escalationPerLoss^(k - 1) (after the k-th consecutive loss in a session) x
 * exp(N(0, stakeDispersion)). Bucket edges and the low-balance threshold use
 * the estimated baseStake, as the generator does.
 *
 * estimateTwins is pure and deterministic. Every output carries the data label
 * (SYNTHETIC, OBSERVATIONAL, or CUSTOMER) passed in by the caller.
 */

import {
  BEHAVIOR_VERSION,
  DEFAULT_BEHAVIOR_OPTIONS,
  DRAWDOWN_BUCKETS,
  buildBehaviorObservations,
  drawdownBucket,
  lowBalanceRefuelEpisodes
} from './behavior.mjs';
import {
  betaQuantile,
  digamma,
  gammaQuantile,
  madSd,
  mean,
  median,
  normalCdf,
  quantile,
  sum,
  trigamma,
  variance
} from './stats.mjs';

export const TWIN_MODEL_VERSION = 'twin-0.3.0';
export const DATA_LABELS = Object.freeze(['SYNTHETIC', 'OBSERVATIONAL', 'CUSTOMER']);
export const PARAMETER_STATUSES = Object.freeze(['estimated', 'prior_only', 'not_estimable']);

export const ESTIMATE_CONSTANTS = Object.freeze({
  // Every interval is equal-tailed at this level.
  intervalLevel: 0.9,
  // A trader's own spread is averaged with the pooled spread of all traders, which
  // counts as this many extra observations (a moderated variance).
  pooledSpreadWeight: 5,
  // A population prior needs at least this many traders with observations.
  minPriorTraders: 3,
  // Floors on the fitted between-trader variance, so a prior never collapses to a point.
  logVarianceFloor: 1e-4, // SD 0.01 on the log scale
  probabilityVarianceFloor: 1e-5,
  idleRelativeSdFloor: 0.01, // SD 1% of the mean idle time
  // Smallest a + b of a beta prior.
  minBetaPriorStrength: 0.5,
  // Stop sample (balance fields present): leave out a trade when the chance that the
  // next stake exceeds the money available for it is at least this.
  unaffordableProbability: 0.05,
  // Latencies below this (simultaneous trades) are raised to it before taking logs.
  minLatencyMinutes: 1 / 60,
  payoutQuantiles: Object.freeze([0.1, 0.25, 0.5, 0.75, 0.9])
});

const Z = 1.6448536269514722; // standard normal 95th percentile: a two-sided 90% interval
const TAIL = (1 - ESTIMATE_CONSTANTS.intervalLevel) / 2;
// The MAD as a normal SD: 1.4826 x MAD, with asymptotic Var(log SD) = 1.3605 / n for normal data.
const MAD_LOG_VARIANCE = 1.3605;

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

const BASE_FIELDS = ['trader_token', 'occurred_at', 'type'];
const OUTCOME_FIELDS = [...BASE_FIELDS, 'stake_amount', 'realized_result'];

/**
 * What each parameter means, how it is estimated, and the fields it needs.
 * `fallback` says what a not_estimable parameter carries: 'prior' means the
 * population prior when other traders in the same dataset had the inputs.
 */
export const TWIN_PARAMETER_DEFINITIONS = deepFreeze({
  baseStake: {
    description: 'Median stake with no chase or escalation term, from the trader\'s first trade and trades after a realized win or push.',
    unit: 'currency',
    method: 'normal-normal, log scale',
    requires: OUTCOME_FIELDS,
    fallback: 'prior'
  },
  stakeDispersion: {
    description: 'Log-scale standard deviation of those base stakes: the noise on every stake.',
    unit: 'log SD',
    method: 'normal-normal on log SD',
    requires: OUTCOME_FIELDS,
    fallback: 'prior'
  },
  chaseCoefficient: {
    description: 'Stake multiplier on the trade after a realized loss: exp(mean signal-1 log ratio after a loss minus after a win).',
    unit: 'multiplier',
    method: 'normal-normal, log scale',
    requires: OUTCOME_FIELDS,
    fallback: 'prior'
  },
  escalationPerLoss: {
    description: 'Extra stake multiplier per additional consecutive loss in a session: exp(signal-6 log slope). Standard error clustered by losing run.',
    unit: 'multiplier',
    method: 'normal-normal, log scale',
    requires: OUTCOME_FIELDS,
    fallback: 'prior'
  },
  reentryLatencyAfterLoss: {
    description: 'Median minutes from a realized loss to the next trade in the same session.',
    unit: 'minutes',
    method: 'normal-normal on the median log latency',
    requires: [...BASE_FIELDS, 'realized_result'],
    fallback: 'prior'
  },
  reentryLatencyAfterWin: {
    description: 'Median minutes from a realized win to the next trade in the same session.',
    unit: 'minutes',
    method: 'normal-normal on the median log latency',
    requires: [...BASE_FIELDS, 'realized_result'],
    fallback: 'prior'
  },
  latencySpread: {
    description: 'Log-scale standard deviation of within-session latencies after a loss or a win, pooled over both: the noise on both latencies. 1.4826 x the median absolute deviation from each side\'s median observation, which latencies cut off at sessionGapMinutes don\'t move while they stay above each side\'s upper quartile.',
    unit: 'log SD',
    method: 'normal-normal on log SD (MAD-based)',
    requires: [...BASE_FIELDS, 'realized_result'],
    fallback: 'prior'
  },
  stopHazard: {
    description: 'Probability that the session ends after a trade, by drawdown bucket, with edges in units of the estimated baseStake. Voluntary (trades the trader probably could not follow are left out) when every trade has balance fields; otherwise all-cause, including stops from running out of money.',
    unit: 'probability per bucket',
    method: 'beta-binomial per bucket',
    requires: OUTCOME_FIELDS,
    voluntaryNeeds: ['balance_before', 'balance_after'],
    fallback: 'prior'
  },
  refuelProbability: {
    description: 'Probability of a deposit within the refuel window after a trade takes the balance below lowBalanceStakeMultiple x the estimated baseStake.',
    unit: 'probability',
    method: 'beta-binomial',
    requires: [...OUTCOME_FIELDS, 'balance_before', 'balance_after'],
    fallback: 'prior'
  },
  refuelAfterLosingStreak: {
    description: 'Proxy for refuelProbability: probability of a deposit within the refuel window after losingStreakLength consecutive realized losses. Not the same trigger.',
    unit: 'probability',
    method: 'beta-binomial',
    requires: [...BASE_FIELDS, 'realized_result'],
    proxyFor: 'refuelProbability',
    fallback: 'prior'
  },
  depositSize: {
    description: 'Median deposit amount.',
    unit: 'currency',
    method: 'normal-normal, log scale',
    requires: [...BASE_FIELDS, 'deposit_amount'],
    fallback: 'prior'
  },
  depositSpread: {
    description: 'Log-scale standard deviation of deposit amounts: the noise on every deposit.',
    unit: 'log SD',
    method: 'normal-normal on log SD',
    requires: [...BASE_FIELDS, 'deposit_amount'],
    fallback: 'prior'
  },
  winRate: {
    description: 'Share of trades with a realized result that won.',
    unit: 'probability',
    method: 'beta-binomial',
    requires: [...BASE_FIELDS, 'realized_result'],
    fallback: 'prior'
  },
  pushRate: {
    description: 'Share of trades with a realized result that pushed (result exactly 0).',
    unit: 'probability',
    method: 'beta-binomial',
    requires: [...BASE_FIELDS, 'realized_result'],
    fallback: 'prior'
  },
  payoutMultiple: {
    description: 'Median of realized result / stake on winning trades.',
    unit: 'multiplier',
    method: 'normal-normal, log scale',
    requires: OUTCOME_FIELDS,
    fallback: 'prior'
  },
  payoutSpread: {
    description: 'Log-scale standard deviation of realized result / stake on winning trades.',
    unit: 'log SD',
    method: 'normal-normal on log SD',
    requires: OUTCOME_FIELDS,
    fallback: 'prior'
  },
  settlementLagMinutes: {
    description: 'Median minutes from placing a trade to its outcome becoming known (settled_at), on trades with a result. Without settled_at, outcomes are assumed known before the next trade and this is not estimable.',
    unit: 'minutes',
    method: 'normal-normal on the median log lag',
    requires: [...BASE_FIELDS, 'realized_result', 'settled_at'],
    fallback: 'none: outcomes are known before the next trade (behavior-0.2.0 rule)'
  },
  settlementLagSpread: {
    description: 'Log-scale standard deviation of settlement lags: 1.4826 x the median absolute deviation from the median log lag.',
    unit: 'log SD',
    method: 'normal-normal on log SD (MAD-based)',
    requires: [...BASE_FIELDS, 'realized_result', 'settled_at'],
    fallback: 'none: outcomes are known before the next trade (behavior-0.2.0 rule)'
  },
  meanIdleMinutes: {
    description: 'Mean minutes from one session\'s last event to the next session\'s first event.',
    unit: 'minutes',
    method: 'inverse-gamma prior, exponential excess over sessionGapMinutes',
    requires: BASE_FIELDS,
    fallback: 'prior'
  }
});

export const TWIN_PARAMETER_NAMES = Object.freeze(Object.keys(TWIN_PARAMETER_DEFINITIONS));

// --- Options -------------------------------------------------------------------

function resolveOptions(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError(`estimateTwins: options must be an object with a dataLabel (${DATA_LABELS.join(', ')})`);
  }
  for (const key of Object.keys(options)) {
    if (!['dataLabel', 'behaviorOptions'].includes(key)) throw new RangeError(`estimateTwins: unknown option "${key}"`);
  }
  if (!DATA_LABELS.includes(options.dataLabel)) {
    throw new RangeError(`estimateTwins: dataLabel is required and must be one of ${DATA_LABELS.join(', ')}`);
  }
  const behaviorOptions = options.behaviorOptions ?? {};
  if (behaviorOptions === null || typeof behaviorOptions !== 'object' || Array.isArray(behaviorOptions)) {
    throw new TypeError('estimateTwins: behaviorOptions must be an object');
  }
  return { dataLabel: options.dataLabel, behaviorOptions };
}

// --- Parameter records -----------------------------------------------------------

// fallback: the population prior summary when other traders had the inputs, else null.
function notEstimable(reason, fallback, extra = {}) {
  return {
    status: 'not_estimable',
    estimate: null,
    interval: null,
    n: 0,
    weight: null,
    raw: null,
    priorEstimate: null,
    reason,
    posterior: null,
    fallback,
    ...extra
  };
}

function value(parameter) {
  if (!parameter) return null;
  if (parameter.status !== 'not_estimable') return parameter.estimate;
  return parameter.fallback?.estimate ?? null;
}

// --- Normal-normal on the log scale ------------------------------------------------

// n, center (mean, or median), and spread (variance, or squared MAD SD) of log-scale values.
function summarize(values, center = 'mean') {
  if (center === 'median') {
    const sd = madSd(values);
    // The sampling variance of a median is pi/2 times that of a mean, for normal data.
    return { n: values.length, center: median(values), spread: sd === null ? null : sd * sd, factor: Math.PI / 2 };
  }
  return { n: values.length, center: mean(values), spread: variance(values), factor: 1 };
}

// Pooled within-trader variance: sum (n - 1) s^2 / sum (n - 1) over traders with 2+ values.
function pooledSpread(summaries) {
  let numerator = 0;
  let denominator = 0;
  for (const summary of summaries) {
    if (!summary || summary.n < 2 || summary.spread === null) continue;
    numerator += (summary.n - 1) * summary.spread;
    denominator += summary.n - 1;
  }
  if (denominator > 0) return numerator / denominator;
  // Nobody has two values: the spread of single values across traders is an upper bound.
  return variance(summaries.filter((summary) => summary && summary.n >= 1).map((summary) => summary.center));
}

// Sampling variance of a trader's center, using the moderated spread
// (k0 * pooled + (n - 1) * own) / (k0 + n - 1).
function samplingVariance(summary, pooled) {
  const k0 = ESTIMATE_CONSTANTS.pooledSpreadWeight;
  const own = summary.n >= 2 ? summary.spread : null;
  let spread = pooled;
  if (own !== null && pooled !== null) spread = (k0 * pooled + (summary.n - 1) * own) / (k0 + summary.n - 1);
  else if (own !== null) spread = own;
  return spread === null ? null : summary.factor * spread / summary.n;
}

// Raw estimate of log SD from a variance summary, bias-corrected; Var(log s) = trigamma((n - 1) / 2) / 4.
function logSdRaw(summary) {
  if (summary.n < 2 || !(summary.spread > 0)) {
    return { n: summary.n, y: null, se2: null, emptyReason: 'needs 2 or more observations to measure a spread' };
  }
  const half = (summary.n - 1) / 2;
  return {
    n: summary.n,
    y: 0.5 * Math.log(summary.spread) - (digamma(half) - Math.log(half)) / 2,
    se2: trigamma(half) / 4
  };
}

/**
 * DerSimonian-Laird method of moments: with w = 1 / se^2, Q = sum w (y - ybar_w)^2 has
 * expectation (k - 1) + tau^2 (sum w - sum w^2 / sum w). Solve for tau^2, floor it,
 * then take the precision-weighted mean with weights 1 / (se^2 + tau^2).
 */
function fitNormalPrior(items) {
  if (items.length < ESTIMATE_CONSTANTS.minPriorTraders) return null;
  const weights = items.map((item) => 1 / item.se2);
  const totalWeight = sum(weights);
  const weightedMean = sum(items.map((item, index) => weights[index] * item.y)) / totalWeight;
  const q = sum(items.map((item, index) => weights[index] * (item.y - weightedMean) ** 2));
  const c = totalWeight - sum(weights.map((weight) => weight * weight)) / totalWeight;
  const tau2 = Math.max(ESTIMATE_CONSTANTS.logVarianceFloor, (q - (items.length - 1)) / c);
  const precision = items.map((item) => 1 / (item.se2 + tau2));
  const center = sum(items.map((item, index) => precision[index] * item.y)) / sum(precision);
  return { mean: center, variance: tau2, traders: items.length };
}

function normalPriorSummary(prior) {
  if (!prior) return null;
  const sd = Math.sqrt(prior.variance);
  return {
    family: 'normal',
    scale: 'log',
    mean: prior.mean,
    sd,
    estimate: Math.exp(prior.mean),
    interval: [Math.exp(prior.mean - Z * sd), Math.exp(prior.mean + Z * sd)],
    traders: prior.traders
  };
}

function normalRecord(status, center, varianceValue, { n, weight, raw, prior, reason, extra }) {
  const sd = varianceValue === null ? null : Math.sqrt(varianceValue);
  return {
    status,
    estimate: Math.exp(center),
    interval: sd === null ? null : [Math.exp(center - Z * sd), Math.exp(center + Z * sd)],
    n,
    weight,
    raw,
    priorEstimate: prior ? Math.exp(prior.mean) : null,
    reason,
    posterior: { family: 'normal', scale: 'log', mean: center, sd },
    ...extra
  };
}

/**
 * Shrinks each trader's raw log-scale estimate toward a fitted normal prior.
 * raws[i] is { reason } (inputs missing) or { n, y, se2, emptyReason?, extra? }.
 * Posterior: weight B = tau^2 / (tau^2 + se^2), mean = mu + B (y - mu),
 * variance = B se^2. With no observations the trader gets the prior, weight 0.
 */
function shrinkNormal(raws) {
  const items = raws.filter((raw) => !raw.reason && raw.n > 0 && raw.y !== null && raw.se2 > 0);
  const prior = fitNormalPrior(items);
  const priorSummary = normalPriorSummary(prior);
  const noPrior = `no population prior: fewer than ${ESTIMATE_CONSTANTS.minPriorTraders} traders have observations`;
  const results = raws.map((raw) => {
    const extra = raw.extra ?? {};
    if (raw.reason) return notEstimable(raw.reason, priorSummary, extra);
    const rawValue = raw.y === null ? null : Math.exp(raw.y);
    if (raw.y === null || raw.n === 0) {
      if (!prior) return notEstimable(`${raw.emptyReason ?? 'no observations'}, and no population prior`, null, { ...extra, n: raw.n });
      const reason = raw.emptyReason ?? 'no observations for this trader';
      return normalRecord('prior_only', prior.mean, prior.variance, { n: raw.n, weight: 0, raw: null, prior, reason, extra });
    }
    if (raw.se2 === null) {
      const reason = 'no spread to set an interval: no trader has 2 or more observations';
      return normalRecord('estimated', raw.y, null, { n: raw.n, weight: 1, raw: rawValue, prior: null, reason, extra });
    }
    if (!prior) {
      return normalRecord('estimated', raw.y, raw.se2, { n: raw.n, weight: 1, raw: rawValue, prior: null, reason: noPrior, extra });
    }
    const weight = prior.variance / (prior.variance + raw.se2);
    const center = prior.mean + weight * (raw.y - prior.mean);
    return normalRecord('estimated', center, weight * raw.se2, { n: raw.n, weight, raw: rawValue, prior, reason: null, extra });
  });
  return { prior: priorSummary, results };
}

// --- Beta-binomial ---------------------------------------------------------------

/**
 * Method of moments with the binomial noise taken out (DerSimonian-Laird on
 * proportions): m = sum k / sum n; with w = n / (m (1 - m)), Q = sum w (p - m)^2 has
 * expectation (K - 1) + tau^2 (sum w - sum w^2 / sum w). Then a + b = m (1 - m) / tau^2 - 1.
 * The center is the pooled proportion. Re-weighting it by 1 / (m (1 - m) / n + tau^2), as
 * fitNormalPrior does, was tried and made stop and refuel coverage worse (ADR-011).
 */
function fitBetaPrior(items) {
  if (items.length < ESTIMATE_CONSTANTS.minPriorTraders) return null;
  const totalN = sum(items.map((item) => item.n));
  const totalK = sum(items.map((item) => item.k));
  let m = totalK / totalN;
  // An all-zero or all-one population: move m half an observation inward so the prior is proper.
  if (m <= 0 || m >= 1) m = (totalK + 0.5) / (totalN + 1);
  const binomial = m * (1 - m);
  const weights = items.map((item) => item.n / binomial);
  const totalWeight = sum(weights);
  const q = sum(items.map((item, index) => weights[index] * (item.k / item.n - m) ** 2));
  const c = totalWeight - sum(weights.map((weight) => weight * weight)) / totalWeight;
  const tau2 = Math.max(ESTIMATE_CONSTANTS.probabilityVarianceFloor, c > 0 ? (q - (items.length - 1)) / c : 0);
  const strength = Math.max(ESTIMATE_CONSTANTS.minBetaPriorStrength, binomial / tau2 - 1);
  return { a: m * strength, b: (1 - m) * strength, mean: m, sd: Math.sqrt(tau2), traders: items.length };
}

function betaInterval(a, b) {
  return [betaQuantile(TAIL, a, b), betaQuantile(1 - TAIL, a, b)];
}

function betaPriorSummary(prior) {
  if (!prior) return null;
  return {
    family: 'beta',
    a: prior.a,
    b: prior.b,
    estimate: prior.a / (prior.a + prior.b),
    interval: betaInterval(prior.a, prior.b),
    sd: prior.sd,
    traders: prior.traders
  };
}

/**
 * Posterior Beta(a + k, b + n - k). Estimate = posterior mean = weight * k / n +
 * (1 - weight) * prior mean, with weight = n / (a + b + n). The 90% interval is the
 * posterior's 5th and 95th percentiles. raws[i] is { reason } or { k, n, extra? }.
 * centerFor(index), when given, moves trader i's prior mean and keeps its strength a + b
 * (stop hazards use it for the trader's stop propensity).
 */
function shrinkBeta(raws, centerFor = null) {
  const items = raws.filter((raw) => !raw.reason && raw.n > 0);
  const prior = fitBetaPrior(items);
  const priorSummary = betaPriorSummary(prior);
  const results = raws.map((raw, index) => {
    const extra = raw.extra ?? {};
    if (raw.reason) return notEstimable(raw.reason, priorSummary, extra);
    let own = prior;
    if (prior && centerFor) {
      const strength = prior.a + prior.b;
      const center = centerFor(index);
      own = { a: center * strength, b: (1 - center) * strength };
    }
    const priorEstimate = own ? own.a / (own.a + own.b) : null;
    if (raw.n === 0) {
      if (!own) return notEstimable(`${raw.emptyReason ?? 'no observations'}, and no population prior`, null, extra);
      return {
        status: 'prior_only',
        estimate: priorEstimate,
        interval: betaInterval(own.a, own.b),
        n: 0,
        weight: 0,
        raw: null,
        priorEstimate,
        reason: raw.emptyReason ?? 'no observations for this trader',
        posterior: { family: 'beta', a: own.a, b: own.b },
        ...extra
      };
    }
    // Without a prior, a Jeffreys Beta(1/2, 1/2) start gives the interval.
    const a = (own ? own.a : 0.5) + raw.k;
    const b = (own ? own.b : 0.5) + raw.n - raw.k;
    return {
      status: 'estimated',
      estimate: a / (a + b),
      interval: betaInterval(a, b),
      n: raw.n,
      weight: own ? raw.n / (own.a + own.b + raw.n) : 1,
      raw: raw.k / raw.n,
      priorEstimate,
      reason: own ? null : `no population prior: fewer than ${ESTIMATE_CONSTANTS.minPriorTraders} traders have observations`,
      posterior: { family: 'beta', a, b },
      ...extra
    };
  });
  return { prior: priorSummary, results };
}

// --- Inverse-gamma for the mean idle time -------------------------------------------

/**
 * Idle excess e = idle - sessionGapMinutes (positive by definition), modelled as
 * exponential with mean theta, and theta ~ InvGamma(alpha, beta). Method of moments:
 * m = sum e / N, and E[sum n_i (ebar_i - m)^2] = tau^2 sum (n_i + 1)(1 - n_i / N) +
 * (K - 1) m^2. Then alpha = 2 + m^2 / tau^2 and beta = m (alpha - 1).
 */
function fitInverseGammaPrior(items) {
  if (items.length < ESTIMATE_CONSTANTS.minPriorTraders) return null;
  const totalN = sum(items.map((item) => item.n));
  const m = sum(items.map((item) => item.total)) / totalN;
  const s = sum(items.map((item) => item.n * (item.total / item.n - m) ** 2));
  const c = sum(items.map((item) => (item.n + 1) * (1 - item.n / totalN)));
  const floor = (ESTIMATE_CONSTANTS.idleRelativeSdFloor * m) ** 2;
  const tau2 = Math.max(floor, c > 0 ? (s - (items.length - 1) * m * m) / c : 0);
  const shape = 2 + (m * m) / tau2;
  return { shape, scale: m * (shape - 1), mean: m, sd: Math.sqrt(tau2), traders: items.length };
}

// Equal-tailed interval of InvGamma(shape, scale): scale / Gamma(shape, 1) quantiles.
function inverseGammaInterval(shape, scale) {
  return [scale / gammaQuantile(1 - TAIL, shape), scale / gammaQuantile(TAIL, shape)];
}

/**
 * Posterior InvGamma(alpha + n, beta + sum e). Estimate = posterior mean
 * (beta + sum e) / (alpha + n - 1) = weight * mean e + (1 - weight) * m, with
 * weight = n / (alpha - 1 + n). sessionGapMinutes is added back to every number.
 */
function shrinkIdle(raws, offset) {
  const items = raws.filter((raw) => !raw.reason && raw.n > 0);
  const prior = fitInverseGammaPrior(items);
  const priorSummary = prior && {
    family: 'inverse-gamma',
    shape: prior.shape,
    scale: prior.scale,
    offsetMinutes: offset,
    estimate: offset + prior.mean,
    interval: inverseGammaInterval(prior.shape, prior.scale).map((bound) => offset + bound),
    sd: prior.sd,
    traders: prior.traders
  };
  const priorEstimate = priorSummary ? priorSummary.estimate : null;
  const results = raws.map((raw) => {
    if (raw.reason) return notEstimable(raw.reason, priorSummary);
    if (raw.n === 0) {
      if (!prior) return notEstimable('fewer than 2 sessions, and no population prior', null);
      return {
        status: 'prior_only',
        estimate: priorEstimate,
        interval: priorSummary.interval,
        n: 0,
        weight: 0,
        raw: null,
        priorEstimate,
        reason: 'fewer than 2 sessions, so no idle time between sessions',
        posterior: { family: 'inverse-gamma', shape: prior.shape, scale: prior.scale, offsetMinutes: offset }
      };
    }
    const rawMean = raw.total / raw.n;
    if (!prior) {
      // Without a prior, the reference prior 1 / theta gives InvGamma(n, sum e) for the interval.
      return {
        status: 'estimated',
        estimate: offset + rawMean,
        interval: inverseGammaInterval(raw.n, raw.total).map((bound) => offset + bound),
        n: raw.n,
        weight: 1,
        raw: offset + rawMean,
        priorEstimate: null,
        reason: `no population prior: fewer than ${ESTIMATE_CONSTANTS.minPriorTraders} traders have 2 or more sessions`,
        posterior: { family: 'inverse-gamma', shape: raw.n, scale: raw.total, offsetMinutes: offset }
      };
    }
    const shape = prior.shape + raw.n;
    const scale = prior.scale + raw.total;
    return {
      status: 'estimated',
      estimate: offset + scale / (shape - 1),
      interval: inverseGammaInterval(shape, scale).map((bound) => offset + bound),
      n: raw.n,
      weight: raw.n / (prior.shape - 1 + raw.n),
      raw: offset + rawMean,
      priorEstimate,
      reason: null,
      posterior: { family: 'inverse-gamma', shape, scale, offsetMinutes: offset }
    };
  });
  return { prior: priorSummary, results };
}

// --- Observations used by the parameters ----------------------------------------------

// Trades with no chase or escalation term: the trader's first trade, trades placed before any
// outcome was known (behavior-0.3.0), and trades whose latest known outcome was a win or push.
function baseLogStakes(record) {
  return record.trades
    .filter((trade) => trade.stake !== null && (trade.first || trade.knownBefore === 0 || trade.previousOutcome === 'win' || trade.previousOutcome === 'push'))
    .map((trade) => Math.log(trade.stake));
}

function winLogPayouts(record) {
  return record.trades
    .filter((trade) => trade.outcome === 'win' && trade.stake !== null)
    .map((trade) => Math.log(trade.result / trade.stake));
}

function idleExcessMinutes(record, gapMinutes) {
  const gaps = [];
  for (let index = 1; index < record.sessions.length; index += 1) {
    gaps.push((record.sessions[index].start - record.sessions[index - 1].end) / 60000 - gapMinutes);
  }
  return gaps;
}

// Money available for the trade after each trade: balance_after plus deposits made
// after it and before the next trade, within the same session. null without balances.
function fundsForNextTrade(record) {
  const { trades, deposits } = record;
  let pointer = 0;
  return trades.map((trade, index) => {
    if (trade.balanceAfter === null) return null;
    const next = trades[index + 1];
    const limit = next && next.session === trade.session ? next.action : Infinity;
    while (pointer < deposits.length && deposits[pointer].action < trade.action) pointer += 1;
    let added = 0;
    for (let cursor = pointer; cursor < deposits.length; cursor += 1) {
      const deposit = deposits[cursor];
      if (deposit.action > limit || deposit.session !== trade.session) break;
      added += deposit.amount ?? 0;
    }
    return trade.balanceAfter + added;
  });
}

function balancesComplete(record) {
  return record.trades.length > 0 && record.trades.every((trade) => trade.balanceBefore !== null && trade.balanceAfter !== null);
}

// --- Per-parameter fits ----------------------------------------------------------------

function inputGap(trader, keys) {
  for (const key of keys) if (trader.missing[key]) return trader.missing[key];
  return null;
}

function fitStakes(traders) {
  const summaries = traders.map((trader) => {
    const reason = inputGap(trader, ['stakes', 'outcomes']);
    return reason ? { reason } : summarize(baseLogStakes(trader.record));
  });
  const pooled = pooledSpread(summaries.filter((summary) => !summary.reason));
  const base = shrinkNormal(summaries.map((summary) => {
    if (summary.reason) return summary;
    if (!summary.n) return { n: 0, y: null, se2: null, emptyReason: 'no stake on a first trade or after a win or push' };
    return { n: summary.n, y: summary.center, se2: samplingVariance(summary, pooled) };
  }));
  const dispersion = shrinkNormal(summaries.map((summary) => (summary.reason ? summary : logSdRaw(summary))));
  traders.forEach((trader, index) => {
    trader.parameters.baseStake = base.results[index];
    trader.parameters.stakeDispersion = dispersion.results[index];
    // Log-scale stake noise, used by escalation's model variance and the affordability rule.
    trader.stakeLogSd = value(dispersion.results[index]) ?? (pooled === null ? null : Math.sqrt(pooled));
  });
  return { baseStake: base.prior, stakeDispersion: dispersion.prior };
}

function fitChase(traders) {
  const sides = traders.map((trader) => {
    const reason = inputGap(trader, ['stakes', 'outcomes']);
    if (reason) return { reason };
    const { loss, win } = trader.record.postOutcomeStake;
    return { loss: summarize(loss.map((episode) => episode.logRatio)), win: summarize(win.map((episode) => episode.logRatio)) };
  });
  const pooledLoss = pooledSpread(sides.map((side) => side.loss));
  const pooledWin = pooledSpread(sides.map((side) => side.win));
  const chase = shrinkNormal(sides.map((side) => {
    if (side.reason) return side;
    const extra = { nLoss: side.loss.n, nWin: side.win.n };
    if (!side.loss.n || !side.win.n) {
      return { n: 0, y: null, se2: null, extra, emptyReason: 'needs signal-1 stake episodes after both a loss and a win' };
    }
    const lossVariance = samplingVariance(side.loss, pooledLoss);
    const winVariance = samplingVariance(side.win, pooledWin);
    return {
      n: Math.min(side.loss.n, side.win.n),
      y: side.loss.center - side.win.center,
      se2: lossVariance === null || winVariance === null ? null : lossVariance + winVariance,
      extra
    };
  }));
  traders.forEach((trader, index) => { trader.parameters.chaseCoefficient = chase.results[index]; });
  return chase.prior;
}

/**
 * Signal-6 slope b = sum x y / sum x^2 through the origin, x = m - 1. Points from one
 * losing run share the reference stake (the stake after the run's first loss), so they
 * are not independent: y = x log(escalation) + e_m - e_1, where every e is the trader's
 * stake noise. The variance is clustered by run through that structure: each run adds
 * sigma^2 (sum x^2 + (sum x)^2) to Var(sum x y), so
 * Var(b) = sigma^2 sum_runs (sum x^2 + (sum x)^2) / (sum x^2)^2, with sigma the trader's
 * estimated stakeDispersion. ADR-011 explains why not a cluster-robust sandwich: a few
 * long losing runs carry most of the leverage, and the sandwich then runs too small.
 */
function escalationRaw(points, stakeLogSd) {
  const sxx = sum(points.map((point) => point.step * point.step));
  const slope = sum(points.map((point) => point.step * point.logRatio)) / sxx;
  const runs = new Map();
  for (const point of points) {
    if (!runs.has(point.run)) runs.set(point.run, []);
    runs.get(point.run).push(point.step);
  }
  let clusterTerm = 0;
  for (const steps of runs.values()) clusterTerm += sum(steps.map((step) => step * step)) + sum(steps) ** 2;
  const se2 = stakeLogSd === null ? null : (stakeLogSd ** 2) * clusterTerm / (sxx * sxx);
  return { n: points.length, y: slope, se2, extra: { runs: runs.size } };
}

function fitEscalation(traders) {
  const escalation = shrinkNormal(traders.map((trader) => {
    const reason = inputGap(trader, ['stakes', 'outcomes']);
    if (reason) return { reason };
    const { points } = trader.record.escalation;
    if (!points.length) {
      return { n: 0, y: null, se2: null, extra: { runs: 0 }, emptyReason: 'no stake after the second or later loss of a same-session losing run' };
    }
    return escalationRaw(points, trader.stakeLogSd);
  }));
  traders.forEach((trader, index) => { trader.parameters.escalationPerLoss = escalation.results[index]; });
  return escalation.prior;
}

// Median log latency, which clamping or truncation at sessionGapMinutes can't move while
// fewer than half the latencies reach it. Spread from the MAD, for the same reason.
function fitLatency(traders, side, name) {
  const floor = ESTIMATE_CONSTANTS.minLatencyMinutes;
  const summaries = traders.map((trader) => {
    const reason = inputGap(trader, ['outcomes']);
    if (reason) return { reason };
    const minutes = trader.record.reentryLatency.withinSession[side];
    return summarize(minutes.map((value) => Math.log(Math.max(value, floor))), 'median');
  });
  const pooled = pooledSpread(summaries.filter((summary) => !summary.reason));
  const latency = shrinkNormal(summaries.map((summary) => {
    if (summary.reason) return summary;
    if (!summary.n) return { n: 0, y: null, se2: null, emptyReason: `no realized ${side} followed by another trade in the same session` };
    return { n: summary.n, y: summary.center, se2: samplingVariance(summary, pooled) };
  }));
  traders.forEach((trader, index) => { trader.parameters[name] = latency.results[index]; });
  return latency.prior;
}

/**
 * latencySpread (twin-0.2.1, ADR-012). Each side (after a loss, after a win) with 2+
 * within-session latencies is centered at its median observation (the lower middle one
 * for an even count), which is then left out: its zero deviation would bias the MAD low in
 * small samples. SD = 1.4826 x the median of the remaining absolute log deviations, pooled
 * over both sides, with n = their count and Var(log SD) = 1.3605 / n (the MAD's asymptotic
 * variance for normal data). A latency cut off at sessionGapMinutes doesn't move it while
 * the cutoff stays above the side's upper quartile.
 */
function fitLatencySpread(traders) {
  const floor = ESTIMATE_CONSTANTS.minLatencyMinutes;
  const spread = shrinkNormal(traders.map((trader) => {
    const reason = inputGap(trader, ['outcomes']);
    if (reason) return { reason };
    const deviations = [];
    for (const side of ['loss', 'win']) {
      const logs = trader.record.reentryLatency.withinSession[side]
        .map((minutes) => Math.log(Math.max(minutes, floor)))
        .sort((a, b) => a - b);
      if (logs.length < 2) continue;
      const middle = Math.floor((logs.length - 1) / 2);
      logs.forEach((value, index) => { if (index !== middle) deviations.push(Math.abs(value - logs[middle])); });
    }
    const n = deviations.length;
    if (!n) return { n: 0, y: null, se2: null, emptyReason: 'needs 2 or more within-session latencies after a loss or after a win' };
    const sd = 1.4826 * median(deviations);
    if (!(sd > 0)) return { n, y: null, se2: null, emptyReason: 'within-session latencies have no spread (median absolute deviation 0)' };
    return { n, y: Math.log(sd), se2: MAD_LOG_VARIANCE / n };
  }));
  traders.forEach((trader, index) => { trader.parameters.latencySpread = spread.results[index]; });
  return spread.prior;
}

/**
 * Settlement lag (twin-0.3.0, ADR-018): minutes from a trade's time to its observed settled_at,
 * on trades with a result. Center: the median log lag (lags under minLatencyMinutes are raised
 * to it), shrunk like the latencies. Spread: 1.4826 x the median absolute deviation of the log
 * lags from their median, with Var(log SD) = 1.3605 / n, as latencySpread. A trader with no
 * observed settled_at is not estimable: outcomes are then known before the next trade.
 */
function fitSettlementLag(traders) {
  const floor = ESTIMATE_CONSTANTS.minLatencyMinutes;
  const logs = traders.map((trader) => {
    const reason = inputGap(trader, ['outcomes'])
      ?? (trader.record.inputs.tradesWithSettledAt > 0 ? null : 'settled_at absent: outcomes are assumed known before the next trade');
    if (reason) return { reason };
    return { values: trader.record.trades.filter((trade) => trade.settlement?.basis === 'observed').map((trade) => Math.log(Math.max(trade.settlement.lagMinutes, floor))) };
  });
  const summaries = logs.map((item) => (item.reason ? item : summarize(item.values, 'median')));
  const pooled = pooledSpread(summaries.filter((summary) => !summary.reason));
  const lag = shrinkNormal(summaries.map((summary) => {
    if (summary.reason) return summary;
    return { n: summary.n, y: summary.center, se2: samplingVariance(summary, pooled) };
  }));
  const spread = shrinkNormal(logs.map((item) => {
    if (item.reason) return item;
    const sorted = [...item.values].sort((a, b) => a - b);
    if (sorted.length < 2) return { n: sorted.length, y: null, se2: null, emptyReason: 'needs 2 or more observed settlement lags' };
    const center = median(sorted);
    const sd = 1.4826 * median(sorted.map((value) => Math.abs(value - center)));
    if (!(sd > 0)) return { n: sorted.length, y: null, se2: null, emptyReason: 'settlement lags have no spread (median absolute deviation 0)' };
    return { n: sorted.length, y: Math.log(sd), se2: MAD_LOG_VARIANCE / sorted.length };
  }));
  traders.forEach((trader, index) => {
    trader.parameters.settlementLagMinutes = lag.results[index];
    trader.parameters.settlementLagSpread = spread.results[index];
  });
  return { settlementLagMinutes: lag.prior, settlementLagSpread: spread.prior };
}

function fitDeposits(traders) {
  const summaries = traders.map((trader) => {
    const { deposits } = trader.record;
    if (deposits.length && deposits.every((deposit) => deposit.amount === null)) {
      return { reason: 'deposit amounts unavailable: no deposit_amount and no balance fields on deposits' };
    }
    return summarize(deposits.filter((deposit) => deposit.amount > 0).map((deposit) => Math.log(deposit.amount)));
  });
  const pooled = pooledSpread(summaries.filter((summary) => !summary.reason));
  const deposit = shrinkNormal(summaries.map((summary) => {
    if (summary.reason) return summary;
    if (!summary.n) return { n: 0, y: null, se2: null, emptyReason: 'no deposit with a positive amount' };
    return { n: summary.n, y: summary.center, se2: samplingVariance(summary, pooled) };
  }));
  // depositSpread (twin-0.2.1): fitted like stakeDispersion, on the same log amounts.
  const spread = shrinkNormal(summaries.map((summary) => (summary.reason ? summary : logSdRaw(summary))));
  traders.forEach((trader, index) => {
    trader.parameters.depositSize = deposit.results[index];
    trader.parameters.depositSpread = spread.results[index];
  });
  return { depositSize: deposit.prior, depositSpread: spread.prior };
}

function fitPayout(traders) {
  const summaries = traders.map((trader) => {
    const reason = inputGap(trader, ['stakes', 'outcomes']);
    return reason ? { reason } : summarize(winLogPayouts(trader.record));
  });
  const pooled = pooledSpread(summaries.filter((summary) => !summary.reason));
  const multiple = shrinkNormal(summaries.map((summary) => {
    if (summary.reason) return summary;
    if (!summary.n) return { n: 0, y: null, se2: null, emptyReason: 'no winning trade with a stake' };
    return { n: summary.n, y: summary.center, se2: samplingVariance(summary, pooled) };
  }));
  const spread = shrinkNormal(summaries.map((summary) => (summary.reason ? summary : logSdRaw(summary))));
  traders.forEach((trader, index) => {
    trader.parameters.payoutMultiple = multiple.results[index];
    trader.parameters.payoutSpread = spread.results[index];
  });
  return { payoutMultiple: multiple.prior, payoutSpread: spread.prior };
}

function fitOutcomeRates(traders) {
  const counts = traders.map((trader) => {
    const reason = inputGap(trader, ['outcomes']);
    if (reason) return { reason };
    const known = trader.record.trades.filter((trade) => trade.outcome !== null);
    return {
      n: known.length,
      wins: known.filter((trade) => trade.outcome === 'win').length,
      pushes: known.filter((trade) => trade.outcome === 'push').length
    };
  });
  const wins = shrinkBeta(counts.map((count) => (count.reason ? count : { n: count.n, k: count.wins })));
  const pushes = shrinkBeta(counts.map((count) => (count.reason ? count : { n: count.n, k: count.pushes })));
  traders.forEach((trader, index) => {
    trader.parameters.winRate = wins.results[index];
    trader.parameters.pushRate = pushes.results[index];
  });
  return { winRate: wins.prior, pushRate: pushes.prior };
}

/**
 * Stop sample. Each trade with a known running session result, whose session end
 * isn't censored, is one Bernoulli trial: did the session end after it? It is
 * bucketed by drawdownBucket(running, estimated baseStake).
 *
 * With balance fields on every trade, the target is the voluntary hazard: a trade is
 * left out when the chance that the next stake (baseStake x chase x escalation terms,
 * lognormal noise stakeDispersion) exceeds the money available (balance_after plus any
 * deposit before the next trade) is at least unaffordableProbability. Without balance
 * fields the two causes can't be separated, so the rate is all-cause.
 */
function stopSample(trader, behaviorOptions) {
  const { record, parameters } = trader;
  const baseStake = value(parameters.baseStake);
  const chase = value(parameters.chaseCoefficient) ?? 1;
  const escalation = value(parameters.escalationPerLoss) ?? 1;
  const sigma = trader.stakeLogSd;
  const voluntary = balancesComplete(record);
  const funds = voluntary ? fundsForNextTrade(record) : null;
  const tallies = Object.fromEntries(DRAWDOWN_BUCKETS.map((bucket) => [bucket, { n: 0, stops: 0 }]));
  const excluded = { unknownState: 0, censored: 0, unaffordable: 0, unaffordableStops: 0 };

  for (const trade of record.trades) {
    if (trade.running === null) { excluded.unknownState += 1; continue; }
    if (trade.censored) { excluded.censored += 1; continue; }
    if (voluntary) {
      // The outcome known after this trade (behavior-0.3.0); without settled_at, its own outcome.
      const known = trade.afterOutcome === undefined ? trade.outcome : trade.afterOutcome;
      let multiplier = 1;
      if (known === 'loss') {
        multiplier = chase * (trade.lossRun >= 2 ? escalation ** (trade.lossRun - 1) : 1);
      } else if (known === null) {
        multiplier = Math.max(1, chase); // outcome unknown: assume the larger stake
      }
      const nextStake = baseStake * multiplier;
      const available = funds[trade.index];
      let unaffordable;
      if (available <= 0) unaffordable = 1;
      else if (!(sigma > 0)) unaffordable = available < nextStake ? 1 : 0;
      else unaffordable = 1 - normalCdf((Math.log(available) - Math.log(nextStake)) / sigma);
      if (unaffordable >= ESTIMATE_CONSTANTS.unaffordableProbability) {
        excluded.unaffordable += 1;
        if (trade.endsSession) excluded.unaffordableStops += 1;
        continue;
      }
    }
    const tally = tallies[drawdownBucket(trade.running, baseStake, behaviorOptions)];
    tally.n += 1;
    if (trade.endsSession) tally.stops += 1;
  }
  return { basis: voluntary ? 'voluntary' : 'all-cause', tallies, excluded };
}

/**
 * Stop propensity, by indirect standardization. Bucket hazards move together: a trader
 * who quits early when a little down rarely reaches a large drawdown. So the traders with
 * down_large trades are mostly the ones who don't quit, a down_large prior fitted to them
 * is too low, and a trader with few down_large trades is likely a quitter. Each trader's
 * hazard in bucket b is modelled as the bucket rate m_b times a stop propensity r. With
 * O stops observed and E = sum_b n_b m_b expected at bucket rates, r = (O + alpha) /
 * (E + alpha): gamma-Poisson shrinkage toward 1, alpha = 1 / Var(r) by the method of
 * moments (E-weighted spread of O / E minus its Poisson part). m_b = sum k_b / sum n_b r
 * is refitted with the new r until stable.
 */
function fitStopPropensity(samples) {
  const usable = samples.filter((sample) => !sample.reason);
  const totals = (sample, rates, skip = null) => {
    let observed = 0;
    let expected = 0;
    for (const bucket of DRAWDOWN_BUCKETS) {
      if (bucket === skip) continue;
      observed += sample.tallies[bucket].stops;
      expected += sample.tallies[bucket].n * rates[bucket];
    }
    return { observed, expected };
  };
  const rateFor = (bucket, propensities) => {
    const stops = sum(usable.map((sample) => sample.tallies[bucket].stops));
    const exposure = sum(usable.map((sample, index) => sample.tallies[bucket].n * propensities[index]));
    // No stop anywhere in a bucket: half a stop keeps the rate positive.
    return stops > 0 ? stops / exposure : 0.5 / (exposure + 1);
  };

  let propensities = usable.map(() => 1);
  let rates = Object.fromEntries(DRAWDOWN_BUCKETS.map((bucket) => [bucket, rateFor(bucket, propensities)]));
  let alpha = null;
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const counts = usable.map((sample) => totals(sample, rates)).filter((count) => count.expected > 0);
    if (counts.length < ESTIMATE_CONSTANTS.minPriorTraders) return null;
    const totalExpected = sum(counts.map((count) => count.expected));
    const ratio = sum(counts.map((count) => count.observed)) / totalExpected;
    const spread = sum(counts.map((count) => count.expected * (count.observed / count.expected - ratio) ** 2)) / totalExpected;
    const propensityVariance = Math.max(1e-3, spread - ratio * counts.length / totalExpected);
    alpha = 1 / propensityVariance;
    propensities = usable.map((sample) => {
      const { observed, expected } = totals(sample, rates);
      return (observed + alpha) / (expected + alpha);
    });
    const next = Object.fromEntries(DRAWDOWN_BUCKETS.map((bucket) => [bucket, rateFor(bucket, propensities)]));
    const change = Math.max(...DRAWDOWN_BUCKETS.map((bucket) => Math.abs(next[bucket] - rates[bucket])));
    rates = next;
    if (change < 1e-12) break;
  }
  return {
    rates,
    alpha,
    // Propensity from the other three buckets, so a bucket's own data isn't counted twice.
    centerFor: (sample, bucket) => {
      const { observed, expected } = totals(sample, rates, bucket);
      return Math.min(0.99, rates[bucket] * (observed + alpha) / (expected + alpha));
    }
  };
}

function fitStops(traders, behaviorOptions) {
  const samples = traders.map((trader) => {
    const reason = inputGap(trader, ['stakes', 'outcomes'])
      ?? (value(trader.parameters.baseStake) === null ? 'no baseStake to set the bucket edges' : null);
    return reason ? { reason } : stopSample(trader, behaviorOptions);
  });
  const propensity = fitStopPropensity(samples);
  const priors = {};
  for (const bucket of DRAWDOWN_BUCKETS) {
    // The bucket's prior strength a + b comes from the plain beta fit, so the prior keeps
    // the bucket's full between-trader spread; the propensity only moves its center.
    const fit = shrinkBeta(samples.map((sample) => {
      if (sample.reason) return { reason: `bucket edges need an estimated baseStake (${sample.reason})` };
      const { n, stops } = sample.tallies[bucket];
      const extra = { stops, basis: sample.basis, includesForcedStops: sample.basis === 'all-cause' };
      return { n, k: stops, extra, emptyReason: 'no usable trade in this bucket' };
    }), propensity && ((index) => propensity.centerFor(samples[index], bucket)));
    priors[bucket] = fit.prior;
    if (fit.prior && propensity) {
      // Reported at propensity 1: the bucket rate, corrected for which traders reach the bucket.
      const strength = fit.prior.a + fit.prior.b;
      const rate = propensity.rates[bucket];
      priors[bucket] = {
        ...fit.prior,
        a: rate * strength,
        b: (1 - rate) * strength,
        estimate: rate,
        interval: betaInterval(rate * strength, (1 - rate) * strength),
        propensityAlpha: propensity.alpha
      };
    }
    traders.forEach((trader, index) => {
      trader.parameters.stopHazard ??= {};
      trader.parameters.stopHazard[bucket] = fit.results[index];
    });
  }
  traders.forEach((trader, index) => {
    const sample = samples[index];
    trader.stopHazardBasis = sample.reason ? null : sample.basis;
    trader.stopSample = sample.reason ? null : {
      basis: sample.basis,
      includesForcedStops: sample.basis === 'all-cause',
      leftOutUnaffordable: sample.excluded.unaffordable,
      leftOutUnaffordableStops: sample.excluded.unaffordableStops,
      unknownState: sample.excluded.unknownState,
      censored: sample.excluded.censored
    };
  });
  return priors;
}

function fitRefuel(traders, behaviorOptions) {
  const raws = traders.map((trader) => {
    const baseStake = value(trader.parameters.baseStake);
    const balanceReason = balancesComplete(trader.record) ? null : lowBalanceRefuelEpisodes(trader.record, 0).reason;
    if (balanceReason) return { reason: balanceReason };
    if (baseStake === null || trader.parameters.baseStake.status === 'not_estimable') {
      return { reason: `the low-balance threshold needs an estimated baseStake (${trader.parameters.baseStake.reason})` };
    }
    const threshold = behaviorOptions.lowBalanceStakeMultiple * baseStake;
    const { episodes } = lowBalanceRefuelEpisodes(trader.record, threshold);
    const observed = episodes.filter((episode) => !episode.censored);
    return {
      n: observed.length,
      k: observed.filter((episode) => episode.refueled).length,
      extra: { threshold, censored: episodes.length - observed.length },
      emptyReason: 'the balance never dropped below the low-balance threshold'
    };
  });
  const refuel = shrinkBeta(raws);

  const proxy = shrinkBeta(traders.map((trader) => {
    const reason = inputGap(trader, ['outcomes']);
    if (reason) return { reason };
    const episodes = trader.record.refuel.losingStreak;
    const observed = episodes.filter((episode) => !episode.censored);
    return {
      n: observed.length,
      k: observed.filter((episode) => episode.refueled).length,
      extra: { proxyFor: 'refuelProbability', streakLength: behaviorOptions.losingStreakLength, censored: episodes.length - observed.length },
      emptyReason: `no run of ${behaviorOptions.losingStreakLength} consecutive realized losses`
    };
  }));

  traders.forEach((trader, index) => {
    trader.parameters.refuelProbability = refuel.results[index];
    trader.parameters.refuelAfterLosingStreak = proxy.results[index];
  });
  return { refuelProbability: refuel.prior, refuelAfterLosingStreak: proxy.prior };
}

function fitIdle(traders, behaviorOptions) {
  const gapMinutes = behaviorOptions.sessionGapMinutes;
  const idle = shrinkIdle(traders.map((trader) => {
    const gaps = idleExcessMinutes(trader.record, gapMinutes);
    return { n: gaps.length, total: sum(gaps) };
  }), gapMinutes);
  traders.forEach((trader, index) => { trader.parameters.meanIdleMinutes = idle.results[index]; });
  return idle.prior;
}

// --- Descriptive outputs ----------------------------------------------------------------

function payoutDistribution(record) {
  const ratios = (outcome) => record.trades
    .filter((trade) => trade.outcome === outcome && trade.stake !== null)
    .map((trade) => trade.result / trade.stake);
  const describe = (values) => ({
    n: values.length,
    quantiles: values.length
      ? Object.fromEntries(ESTIMATE_CONSTANTS.payoutQuantiles.map((p) => [`p${Math.round(p * 100)}`, quantile(values, p)]))
      : null
  });
  return { resultPerStake: { wins: describe(ratios('win')), losses: describe(ratios('loss')) } };
}

function iso(ms) {
  return ms === null || ms === undefined ? null : new Date(ms).toISOString();
}

function trainingWindow(record) {
  if (!record.sessions.length) return { start: null, end: null };
  return { start: iso(record.sessions[0].start), end: iso(record.sessions.at(-1).end) };
}

function observedSessionsPerDay(record) {
  const { sessions } = record;
  if (sessions.length < 2) return null;
  const days = (sessions.at(-1).start - sessions[0].start) / 86400000;
  return days > 0 ? (sessions.length - 1) / days : null;
}

// --- Entry point -------------------------------------------------------------------------

/**
 * Fits twin-0.2.1 parameters for every trader in `events`.
 *
 * options:
 * - dataLabel (required): 'SYNTHETIC', 'OBSERVATIONAL', or 'CUSTOMER'. Carried into
 *   every output.
 * - behaviorOptions: options for buildBehaviorObservations (session gap, refuel
 *   window, bucket edges, low-balance multiple, losing-streak length, observation
 *   end). lowBalanceThreshold is ignored: the estimator's threshold is
 *   lowBalanceStakeMultiple x the estimated baseStake.
 *
 * Returns { modelVersion, behaviorVersion, dataLabel, behaviorOptions, constants,
 * trainingWindow, inputs, priors, twins }. Each twin has trainingWindow, inputs,
 * parameters (definitions in TWIN_PARAMETER_DEFINITIONS), stopHazardBasis,
 * stopSample, payoutDistribution, and descriptive values. Each parameter is
 * { status, estimate, interval, n, weight, raw, reason, posterior, ... }; stopHazard
 * holds one such record per drawdown bucket. Throws on invalid options.
 */
export function estimateTwins(events, options) {
  const settings = resolveOptions(options);
  const records = buildBehaviorObservations(events, settings.behaviorOptions);
  const behaviorOptions = records.length
    ? records[0].options
    : { ...DEFAULT_BEHAVIOR_OPTIONS, ...settings.behaviorOptions };

  const traders = records.map((record) => ({
    record,
    parameters: {},
    missing: {
      outcomes: record.inputs.tradesWithOutcome > 0 ? null : 'realized_result unavailable for every trade',
      stakes: record.inputs.tradesWithStake > 0 ? null : 'no trade has a positive stake_amount'
    }
  }));

  const priors = { dataLabel: settings.dataLabel, modelVersion: TWIN_MODEL_VERSION };
  Object.assign(priors, fitStakes(traders));
  priors.chaseCoefficient = fitChase(traders);
  priors.escalationPerLoss = fitEscalation(traders);
  priors.reentryLatencyAfterLoss = fitLatency(traders, 'loss', 'reentryLatencyAfterLoss');
  priors.reentryLatencyAfterWin = fitLatency(traders, 'win', 'reentryLatencyAfterWin');
  priors.latencySpread = fitLatencySpread(traders);
  priors.stopHazard = fitStops(traders, behaviorOptions);
  Object.assign(priors, fitRefuel(traders, behaviorOptions));
  Object.assign(priors, fitDeposits(traders));
  Object.assign(priors, fitOutcomeRates(traders));
  Object.assign(priors, fitPayout(traders));
  Object.assign(priors, fitSettlementLag(traders));
  priors.meanIdleMinutes = fitIdle(traders, behaviorOptions);

  const twins = traders.map((trader) => {
    const { record } = trader;
    const parameters = Object.fromEntries(TWIN_PARAMETER_NAMES.map((name) => [name, trader.parameters[name]]));
    return {
      traderToken: record.traderToken,
      modelVersion: TWIN_MODEL_VERSION,
      behaviorVersion: BEHAVIOR_VERSION,
      dataLabel: settings.dataLabel,
      trainingWindow: trainingWindow(record),
      inputs: {
        ...record.inputs,
        hasOutcomes: !trader.missing.outcomes,
        hasCompleteBalances: balancesComplete(record),
        hasSettlementTimes: record.inputs.tradesWithSettledAt > 0
      },
      parameters,
      stopHazardBasis: trader.stopHazardBasis,
      stopSample: trader.stopSample,
      payoutDistribution: payoutDistribution(record),
      descriptive: { observedSessionsPerDay: observedSessionsPerDay(record) }
    };
  });

  const starts = twins.map((twin) => twin.trainingWindow.start).filter(Boolean).sort();
  const ends = twins.map((twin) => twin.trainingWindow.end).filter(Boolean).sort();
  return {
    modelVersion: TWIN_MODEL_VERSION,
    behaviorVersion: BEHAVIOR_VERSION,
    dataLabel: settings.dataLabel,
    behaviorOptions,
    constants: ESTIMATE_CONSTANTS,
    trainingWindow: { start: starts[0] ?? null, end: ends.at(-1) ?? null },
    inputs: {
      traderCount: records.length,
      tradeCount: sum(records.map((record) => record.inputs.tradeCount)),
      tradesWithOutcome: sum(records.map((record) => record.inputs.tradesWithOutcome)),
      tradesWithBalances: sum(records.map((record) => record.inputs.tradesWithBalances)),
      tradersWithCompleteBalances: twins.filter((twin) => twin.inputs.hasCompleteBalances).length,
      depositCount: sum(records.map((record) => record.inputs.depositCount))
    },
    priors,
    twins
  };
}
