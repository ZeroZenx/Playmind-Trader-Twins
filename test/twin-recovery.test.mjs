import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OUTCOME_DEPENDENT_TARGETS,
  RECOVERY_DEFAULTS,
  RECOVERY_TARGET_NAMES,
  parameterRecord,
  runNoOutcomeCheck,
  runTwinRecovery
} from '../src/synthetic/twin-recovery.mjs';

// Parameter recovery for twin-0.2.0 on SYNTHETIC traders with known parameters. The
// recovery function is shared with scripts/twin-recovery.mjs (npm run twin:recovery),
// which writes the full results to gitignored local output. Recovery numbers live only
// here, as thresholds, and in that output: never in docs or commit messages.
//
// Population: RECOVERY_DEFAULTS, 500 traders with sessionsPerTrader log-uniform on
// 2..150, so there are many short histories as well as long ones.

// Thresholds.
// Chase: Pearson correlation of log estimate with log truth, among traders with at least
// RECOVERY_DEFAULTS.minLossEpisodes (20) signal-1 post-loss episodes.
const CHASE_MIN_LOG_PEARSON = 0.9;
// Among those traders, the share whose estimate is on the right side of 1, counting only
// traders whose true coefficient is at least RECOVERY_DEFAULTS.signMargin (10%) from 1.
// Closer to 1 than that can't be signed reliably.
const CHASE_MIN_SIGN_SHARE = 0.95;
// Share of true values inside the nominal 90% intervals, per parameter.
const COVERAGE_MIN = 0.8;
const COVERAGE_MAX = 0.95;
// Shrinkage must measurably help low-history traders wherever their mean weight on their
// own data is below this. Above it, shrinkage is too small to tell from noise, so only the
// between-raw-and-prior check applies.
const MATERIAL_SHRINKAGE_WEIGHT = 0.95;
// The voluntary stop sample may keep at most this share of the truth's forced stops.
const MAX_RESIDUAL_FORCED_STOP_SHARE = 0.05;

const COVERAGE_TARGETS = [
  'chaseCoefficient',
  'escalationPerLoss',
  'reentryLatencyAfterLoss',
  'reentryLatencyAfterWin',
  'baseStake',
  'winRate',
  'meanIdleMinutes'
];
const BALANCE_COVERAGE_TARGETS = [
  'refuelProbability',
  'stopHazard.up',
  'stopHazard.flat',
  'stopHazard.down_small',
  'stopHazard.down_large'
];

const withBalances = runTwinRecovery();
const withoutBalances = runTwinRecovery({ includeBalances: false });
const missingOutcomes = runTwinRecovery({ missingOutcomeShare: 0.3 });

function assertCoverage(results, targets, scenario) {
  for (const target of targets) {
    const { share, traders } = results.coverage[target];
    assert.ok(traders >= 400, `${scenario} ${target}: only ${traders} traders have an interval`);
    assert.ok(share >= COVERAGE_MIN && share <= COVERAGE_MAX,
      `${scenario} ${target}: 90% interval coverage ${share} is outside [${COVERAGE_MIN}, ${COVERAGE_MAX}]`);
  }
}

function assertChase(results, scenario) {
  const { chase } = results;
  assert.equal(chase.minLossEpisodes, 20);
  assert.ok(chase.traders >= 100, `${scenario}: ${chase.traders} traders with 20+ loss episodes`);
  assert.ok(chase.pearsonLog >= CHASE_MIN_LOG_PEARSON, `${scenario}: log-scale correlation ${chase.pearsonLog}`);
  assert.ok(chase.signShare >= CHASE_MIN_SIGN_SHARE, `${scenario}: sign recovered for ${chase.signRecovered} of ${chase.signTraders}`);
}

test('the recovery population has short and long histories, and every output is SYNTHETIC', () => {
  const { dataset, fit, results } = withBalances;
  assert.equal(results.label, 'SYNTHETIC');
  assert.equal(fit.dataLabel, 'SYNTHETIC');
  assert.ok(fit.twins.every((twin) => twin.dataLabel === 'SYNTHETIC'));
  assert.equal(dataset.truth.traderCount, RECOVERY_DEFAULTS.traderCount);
  assert.deepEqual(dataset.truth.options.sessionsPerTrader, { min: 2, max: 150, scale: 'log' });
  const sessions = dataset.truth.traders.map((trader) => trader.sessionCount);
  assert.ok(sessions.filter((count) => count <= 10).length >= 150, 'many short histories');
  assert.ok(sessions.filter((count) => count >= 60).length >= 75, 'many long histories');
});

test(`chase: log-scale correlation >= ${CHASE_MIN_LOG_PEARSON} and sign recovered for >= ${CHASE_MIN_SIGN_SHARE} of traders with 20+ loss episodes`, () => {
  assertChase(withBalances.results, 'with balances');
});

test(`90% interval coverage is within [${COVERAGE_MIN}, ${COVERAGE_MAX}] for each recovered parameter`, () => {
  assertCoverage(withBalances.results, [...COVERAGE_TARGETS, ...BALANCE_COVERAGE_TARGETS], 'with balances');
  // The voluntary stop hazard is what the coverage targets: every trader has balances.
  assert.deepEqual(withBalances.results.stops.basis, ['voluntary']);
});

test('the voluntary stop sample leaves out nearly all forced stops', () => {
  const { stops } = withBalances.results;
  assert.ok(stops.truthForcedStops > 0);
  assert.ok(stops.leftOutUnaffordable > 0);
  assert.ok(stops.residualForcedStopsLowerBound <= MAX_RESIDUAL_FORCED_STOP_SHARE * stops.truthForcedStops,
    `${stops.residualForcedStopsLowerBound} of ${stops.truthForcedStops} forced stops stayed in the sample`);
});

test('shrinkage: low-history traders sit between their raw value and the prior, and are closer to the truth on average', () => {
  const { shrinkage, settings } = withBalances.results;
  assert.equal(settings.lowHistorySessions, 10);
  let material = 0;
  for (const target of RECOVERY_TARGET_NAMES) {
    const result = shrinkage[target];
    assert.ok(result.traders >= 50, `${target}: ${result.traders} low-history traders`);
    assert.equal(result.betweenRawAndPrior, result.traders, `${target}: estimate outside [raw, prior]`);
    if (result.meanWeight < MATERIAL_SHRINKAGE_WEIGHT) {
      material += 1;
      assert.ok(result.meanSquaredErrorEstimate < result.meanSquaredErrorRaw,
        `${target}: shrunk estimates are no closer to the truth than raw (${result.meanSquaredErrorEstimate} vs ${result.meanSquaredErrorRaw})`);
    }
  }
  assert.ok(material >= 10, `shrinkage is material for only ${material} parameters`);
});

test('shrinkage weights rise with n', () => {
  for (const target of RECOVERY_TARGET_NAMES) {
    const trend = withBalances.results.weightTrend[target];
    assert.ok(trend, target);
    assert.ok(trend[0].meanWeight < trend[1].meanWeight && trend[1].meanWeight < trend[2].meanWeight,
      `${target}: mean weight by n tercile ${trend.map((part) => part.meanWeight).join(', ')}`);
  }
  // Beta-binomial weights n / (a + b + n) are strictly increasing in n for one prior.
  const records = withBalances.fit.twins.map((twin) => twin.parameters.winRate).sort((a, b) => a.n - b.n);
  records.slice(1).forEach((record, index) => {
    if (record.n > records[index].n) assert.ok(record.weight > records[index].weight);
  });
});

test('a trader with no observations for a parameter gets exactly the prior, with weight 0', () => {
  const { priorOnly } = withBalances.results;
  let traders = 0;
  for (const target of RECOVERY_TARGET_NAMES) {
    assert.equal(priorOnly[target].weightZero, priorOnly[target].traders, target);
    assert.equal(priorOnly[target].atPrior, priorOnly[target].traders, target);
    traders += priorOnly[target].traders;
  }
  assert.ok(priorOnly.escalationPerLoss.traders > 0 && traders > 0);
  // For a population prior (every parameter but stopHazard), that is the prior itself.
  for (const twin of withBalances.fit.twins) {
    const record = twin.parameters.escalationPerLoss;
    if (record.status !== 'prior_only') continue;
    assert.equal(record.n, 0);
    assert.equal(record.estimate, withBalances.fit.priors.escalationPerLoss.estimate);
    assert.deepEqual(record.interval, withBalances.fit.priors.escalationPerLoss.interval);
  }
});

test('without balance fields: refuelProbability is not estimable, stops are all-cause, and the rest still recovers', () => {
  const { fit, results } = withoutBalances;
  assert.equal(results.scenario.includeBalances, false);
  for (const twin of fit.twins) {
    assert.equal(twin.parameters.refuelProbability.status, 'not_estimable');
    assert.match(twin.parameters.refuelProbability.reason, /balance_before and balance_after unavailable/);
    assert.equal(twin.parameters.refuelAfterLosingStreak.proxyFor, 'refuelProbability');
    assert.equal(twin.stopHazardBasis, 'all-cause');
    assert.equal(twin.stopSample.includesForcedStops, true);
  }
  assert.deepEqual(results.stops.basis, ['all-cause']);
  assertChase(results, 'without balances');
  assertCoverage(results, COVERAGE_TARGETS, 'without balances');
});

test('with 30% of outcomes missing, outcome-dependent parameters are still estimated, with smaller n', () => {
  const full = withBalances.fit.twins;
  const missing = missingOutcomes.fit.twins;
  assert.equal(missingOutcomes.results.scenario.missingOutcomeShare, 0.3);
  const total = (twins, target) => twins.reduce((sum, twin) => sum + parameterRecord(twin, target).n, 0);
  const estimated = (twins, target) => twins.filter((twin) => parameterRecord(twin, target).status === 'estimated').length;
  for (const target of ['baseStake', 'chaseCoefficient', 'escalationPerLoss', 'reentryLatencyAfterLoss', 'reentryLatencyAfterWin', 'winRate', 'pushRate', 'payoutMultiple', 'refuelAfterLosingStreak']) {
    assert.ok(total(missing, target) < total(full, target), `${target}: n did not fall`);
    assert.ok(estimated(missing, target) >= 0.8 * estimated(full, target), `${target}: ${estimated(missing, target)} estimated`);
  }
  // Fewer known outcomes per trader: never more than with full data.
  missing.forEach((twin, index) => {
    assert.ok(twin.parameters.winRate.n <= full[index].parameters.winRate.n);
    assert.ok(twin.parameters.baseStake.n <= full[index].parameters.baseStake.n);
  });
});

test('with no realized outcomes and no balances, every outcome-dependent parameter is not estimable', () => {
  const { statuses, traderCount } = runNoOutcomeCheck();
  assert.ok(traderCount > 0);
  for (const target of OUTCOME_DEPENDENT_TARGETS) {
    assert.equal(statuses[target].not_estimable, traderCount, target);
  }
  assert.equal(statuses.depositSize.not_estimable, 0);
  assert.equal(statuses.meanIdleMinutes.not_estimable, 0);
});

test('npm run twin:recovery writes SYNTHETIC results to the directory it is given', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'playmind-twin-recovery-'));
  try {
    const run = spawnSync(process.execPath, ['scripts/twin-recovery.mjs', '--traders', '30', '--seed', '5', '--out', directory], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /twin-0\.2\.0 parameter recovery \(SYNTHETIC\)/);
    const files = (await readdir(directory)).sort();
    assert.deepEqual(files, ['twin-recovery-seed5-traders30.json', 'twin-recovery-seed5-traders30.traders.jsonl']);
    const summary = JSON.parse(await readFile(join(directory, files[0]), 'utf8'));
    assert.equal(summary.label, 'SYNTHETIC');
    assert.deepEqual(Object.keys(summary.scenarios), ['withBalances', 'withoutBalances', 'missingOutcomes']);
    for (const scenario of Object.values(summary.scenarios)) {
      assert.equal(scenario.label, 'SYNTHETIC');
      assert.equal(scenario.traders, undefined, 'per-trader rows go to the JSON lines file');
    }
    const lines = (await readFile(join(directory, files[1]), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(lines.length, 3 * 30);
    assert.ok(lines.every((line) => line.label === 'SYNTHETIC'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
