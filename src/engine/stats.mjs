/**
 * Small, dependency-free statistics helpers for the twin estimator
 * (estimate.mjs) and its recovery checks. Pure functions.
 *
 * Special functions follow standard published algorithms: the Lanczos
 * approximation for log-gamma, asymptotic series with recurrence for digamma
 * and trigamma, and the series / continued-fraction forms of the regularized
 * incomplete gamma and beta functions (Press et al., Numerical Recipes, 6.1-6.4).
 * Quantiles are found by bisection on the CDF, so they are accurate to about
 * 1e-10 relative error, far below anything the estimator reports.
 */

export function sum(values) {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

export function mean(values) {
  return values.length ? sum(values) / values.length : null;
}

export function median(values) {
  return quantile(values, 0.5);
}

// Linear interpolation between order statistics (type 7, the R and NumPy default).
export function quantile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

// Sample variance with an n - 1 denominator; null below 2 values.
export function variance(values) {
  if (values.length < 2) return null;
  const center = mean(values);
  return sum(values.map((value) => (value - center) ** 2)) / (values.length - 1);
}

// Median absolute deviation, scaled by 1.4826 to estimate a normal SD. null below 2 values.
export function madSd(values) {
  if (values.length < 2) return null;
  const center = median(values);
  return 1.4826 * median(values.map((value) => Math.abs(value - center)));
}

export function pearson(xs, ys) {
  if (xs.length !== ys.length || xs.length < 2) return null;
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let index = 0; index < xs.length; index += 1) {
    sxy += (xs[index] - mx) * (ys[index] - my);
    sxx += (xs[index] - mx) ** 2;
    syy += (ys[index] - my) ** 2;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

// --- Normal ------------------------------------------------------------------

// Abramowitz and Stegun 7.1.26 via erf, absolute error below 1.5e-7.
export function normalCdf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

// --- Gamma family --------------------------------------------------------------

const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7
];

export function logGamma(x) {
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - logGamma(1 - x);
  const z = x - 1;
  let series = LANCZOS[0];
  for (let index = 1; index < LANCZOS.length; index += 1) series += LANCZOS[index] / (z + index);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(series);
}

export function digamma(x) {
  let result = 0;
  let value = x;
  while (value < 6) {
    result -= 1 / value;
    value += 1;
  }
  const inverse = 1 / value;
  const inverse2 = inverse * inverse;
  return result + Math.log(value) - inverse / 2
    - inverse2 * (1 / 12 - inverse2 * (1 / 120 - inverse2 * (1 / 252 - inverse2 * (1 / 240 - inverse2 / 132))));
}

export function trigamma(x) {
  let result = 0;
  let value = x;
  while (value < 6) {
    result += 1 / (value * value);
    value += 1;
  }
  const inverse = 1 / value;
  const inverse2 = inverse * inverse;
  return result + inverse + inverse2 / 2
    + inverse * inverse2 * (1 / 6 - inverse2 * (1 / 30 - inverse2 * (1 / 42 - inverse2 / 30)));
}

const ITERATIONS = 300;
const EPSILON = 1e-14;
const TINY = 1e-300;

// Regularized lower incomplete gamma P(a, x).
export function gammaCdf(x, shape) {
  if (x <= 0) return 0;
  const logPrefix = shape * Math.log(x) - x - logGamma(shape);
  if (x < shape + 1) {
    let term = 1 / shape;
    let total = term;
    for (let n = 1; n < ITERATIONS; n += 1) {
      term *= x / (shape + n);
      total += term;
      if (Math.abs(term) < Math.abs(total) * EPSILON) break;
    }
    return Math.min(1, total * Math.exp(logPrefix));
  }
  let b = x + 1 - shape;
  let c = 1 / TINY;
  let d = 1 / b;
  let h = d;
  for (let n = 1; n < ITERATIONS; n += 1) {
    const an = -n * (n - shape);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < TINY) d = TINY;
    c = b + an / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < EPSILON) break;
  }
  return Math.max(0, 1 - Math.exp(logPrefix) * h);
}

function betaContinuedFraction(x, a, b) {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m < ITERATIONS; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < EPSILON) break;
  }
  return h;
}

// Regularized incomplete beta I_x(a, b).
export function betaCdf(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const logPrefix = logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x);
  if (x < (a + 1) / (a + b + 2)) return Math.exp(logPrefix) * betaContinuedFraction(x, a, b) / a;
  return 1 - Math.exp(logPrefix) * betaContinuedFraction(1 - x, b, a) / b;
}

function bisect(cdf, p, low, high) {
  let lo = low;
  let hi = high;
  for (let step = 0; step < 200; step += 1) {
    const mid = (lo + hi) / 2;
    if (cdf(mid) < p) lo = mid;
    else hi = mid;
    if (hi - lo <= 1e-12 * Math.max(1, Math.abs(mid))) break;
  }
  return (lo + hi) / 2;
}

export function betaQuantile(p, a, b) {
  return bisect((x) => betaCdf(x, a, b), p, 0, 1);
}

// Quantile of Gamma(shape, rate 1).
export function gammaQuantile(p, shape) {
  let high = Math.max(1, shape);
  while (gammaCdf(high, shape) < p) high *= 2;
  return bisect((x) => gammaCdf(x, shape), p, 0, high);
}
