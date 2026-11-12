import test from 'node:test';
import assert from 'node:assert/strict';
import { createRng } from '../src/engine/rng.mjs';
import { betaCdf, betaSample, gammaCdf, gammaSample, mean, variance } from '../src/engine/stats.mjs';

// Seeded Gamma and Beta samplers (stats.mjs), used by the simulator to draw parameters
// from beta and inverse-gamma posteriors.

const DRAWS = 20000;

function draws(sampler, seed) {
  const rng = createRng(seed);
  return Array.from({ length: DRAWS }, () => sampler(rng));
}

// Two-sided Kolmogorov-Smirnov distance between a sample and a CDF.
function ksDistance(values, cdf) {
  const sorted = [...values].sort((a, b) => a - b);
  let distance = 0;
  sorted.forEach((value, index) => {
    const f = cdf(value);
    distance = Math.max(distance, Math.abs(f - index / sorted.length), Math.abs((index + 1) / sorted.length - f));
  });
  return distance;
}

// 1.63 / sqrt(n) is the 1% critical value of the KS distance.
const KS_LIMIT = 1.63 / Math.sqrt(DRAWS);

test('gammaSample is deterministic under a seed and matches Gamma(shape, 1)', () => {
  assert.deepEqual(draws((rng) => gammaSample(rng, 2.5), 11).slice(0, 50), draws((rng) => gammaSample(rng, 2.5), 11).slice(0, 50));
  assert.notDeepEqual(draws((rng) => gammaSample(rng, 2.5), 11).slice(0, 5), draws((rng) => gammaSample(rng, 2.5), 12).slice(0, 5));
  for (const [index, shape] of [0.3, 1, 2.5, 40].entries()) {
    const values = draws((rng) => gammaSample(rng, shape), 100 + index);
    assert.ok(values.every((value) => value > 0 && Number.isFinite(value)), `shape ${shape}`);
    assert.ok(Math.abs(mean(values) - shape) < 4 * Math.sqrt(shape / DRAWS), `shape ${shape}: mean ${mean(values)}`);
    assert.ok(Math.abs(variance(values) / shape - 1) < 0.08, `shape ${shape}: variance ${variance(values)}`);
    assert.ok(ksDistance(values, (x) => gammaCdf(x, shape)) < KS_LIMIT, `shape ${shape}: KS`);
  }
  assert.throws(() => gammaSample(createRng(1), 0), RangeError);
  assert.throws(() => gammaSample(createRng(1), Number.NaN), RangeError);
});

test('betaSample is deterministic under a seed and matches Beta(a, b)', () => {
  assert.deepEqual(draws((rng) => betaSample(rng, 2, 5), 21).slice(0, 50), draws((rng) => betaSample(rng, 2, 5), 21).slice(0, 50));
  for (const [index, [a, b]] of [[0.5, 0.5], [2, 5], [30, 70], [0.2, 3]].entries()) {
    const values = draws((rng) => betaSample(rng, a, b), 200 + index);
    assert.ok(values.every((value) => value >= 0 && value <= 1), `Beta(${a}, ${b})`);
    const expectedMean = a / (a + b);
    const expectedVariance = (a * b) / ((a + b) ** 2 * (a + b + 1));
    assert.ok(Math.abs(mean(values) - expectedMean) < 4 * Math.sqrt(expectedVariance / DRAWS), `Beta(${a}, ${b}): mean`);
    assert.ok(Math.abs(variance(values) / expectedVariance - 1) < 0.08, `Beta(${a}, ${b}): variance`);
    assert.ok(ksDistance(values, (x) => betaCdf(x, a, b)) < KS_LIMIT, `Beta(${a}, ${b}): KS`);
  }
  assert.throws(() => betaSample(createRng(1), 1, 0), RangeError);
});
