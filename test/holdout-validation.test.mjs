import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOLDOUT_METRICS } from '../src/engine/holdout.mjs';
import { HOLDOUT_RUN_DEFAULTS, formatHoldoutSummary, runSyntheticHoldout } from '../src/synthetic/holdout-validation.mjs';

// End-to-end held-out validation on a SYNTHETIC behavioral population, both data paths.
// The computation is shared with scripts/twin-holdout.mjs (npm run twin:holdout), which
// writes the full results to gitignored local output. Validation numbers live only here,
// as thresholds, and in that output: never in docs, the README, or commit messages.
//
// What is asserted is what held across seeds at this scale: the twin beats baseline-0.1
// overall, and beats naive-0.1 on the stake metrics, where the last outcome matters. Whether
// it beats naive-0.1 on the other metrics (synthetic traders are stationary, so repeating
// the training values is a strong baseline) and so earns the claim varies with the seed at
// 40 traders, and is reported with t.diagnostic.

const results = runSyntheticHoldout({ traderCount: 40, replicates: 20 });
const STAKE_METRICS = ['stakeAfterLoss', 'stakeAfterWin', 'stakeLossMinusWin'];
// Per-trader calibration floor for every scored metric: the band is nominally 80%.
const CALIBRATION_FLOOR = 0.5;

test('the default run is a population with enough sessions for a usable test window', () => {
  assert.equal(HOLDOUT_RUN_DEFAULTS.sessionsPerTrader.min >= 20, true);
  assert.deepEqual(HOLDOUT_RUN_DEFAULTS.paths, ['balances', 'no-balances']);
  assert.equal(results.label, 'SYNTHETIC');
  assert.equal(results.scenario.mode, 'population');
  assert.deepEqual(Object.keys(results.runs), ['balances', 'no-balances']);
  assert.throws(() => runSyntheticHoldout({ traders: 3 }), /unknown option "traders"/);
  assert.throws(() => runSyntheticHoldout({ paths: ['market-fields'] }), /paths/);
});

for (const path of ['balances', 'no-balances']) {
  test(`SYNTHETIC end to end (${path}): the run reports whether the twin beats both baselines`, (t) => {
    const run = results.runs[path];
    const { overall, perMetric } = run.summary;
    assert.equal(run.dataLabel, 'SYNTHETIC');
    // Nearly every trader has a usable test window; the rest are listed with a reason.
    assert.ok(run.inputs.compared >= 36, `${run.inputs.compared} compared`);
    for (const trader of run.traders.filter((item) => !item.compared)) assert.equal(typeof (trader.reason ?? trader.exclusion), 'string');
    assert.ok(run.models.truth, 'the truth reference runs on SYNTHETIC data');
    if (path === 'no-balances') {
      assert.equal(run.labels.allCauseStops.length, run.inputs.compared);
      assert.equal(run.labels.proxyRefuel.length, run.inputs.compared);
    } else {
      assert.equal(run.labels.allCauseStops.length, 0);
    }

    // Robust: the twin beats baseline-0.1 overall, and naive-0.1 on the stake metrics.
    assert.equal(overall.beats.baseline.beats, true);
    for (const name of STAKE_METRICS) {
      assert.equal(perMetric[name].beats.baseline.beats, true, `${name} vs baseline-0.1`);
      assert.equal(perMetric[name].beats.naive.beats, true, `${name} vs naive-0.1`);
    }
    for (const [name, cell] of Object.entries(perMetric)) {
      if (!HOLDOUT_METRICS[name].scored) continue;
      assert.ok(cell.calibration.share >= CALIBRATION_FLOOR, `${name} calibration ${cell.calibration.share}`);
    }

    // The verdict is reported either way, with the same rule.
    assert.equal(typeof overall.claim.earned, 'boolean');
    assert.equal(overall.claim.earned, overall.beats.baseline.beats === true && overall.beats.naive.beats === true);
    assert.match(overall.claim.statement, overall.claim.earned ? /beats both baseline-0\.1 and naive-0\.1/ : /does not earn a claim/);
    t.diagnostic(`${path}: ${overall.claim.statement}`);
    t.diagnostic(`${path}: beats baseline-0.1 on ${overall.beats.baseline.metricsBeaten}/${overall.beats.baseline.metricsCompared}, naive-0.1 on ${overall.beats.naive.metricsBeaten}/${overall.beats.naive.metricsCompared}; calibration ${overall.calibration.metricsPassed}/${overall.calibration.metricsScored}, distribution ${overall.distribution.metricsPassed}/${overall.distribution.metricsScored}; pass ${overall.pass}`);
    for (const finding of overall.findings) t.diagnostic(`${path} finding: ${finding}`);
    for (const [name, cell] of Object.entries(perMetric)) {
      if (cell.diagnosis) t.diagnostic(`${path} ${name}: ${cell.diagnosis}`);
    }
  });
}

test('the console summary names the versions, the label, and the verdict', () => {
  const summary = formatHoldoutSummary(results);
  assert.match(summary, /holdout-0\.1\.0 held-out validation \(SYNTHETIC\)/);
  assert.match(summary, /twin-0\.2\.1 vs baseline-0\.1 and naive-0\.1/);
  assert.match(summary, /\[no-balances\] without balance fields: all-cause stop hazards, proxy \(losing-streak\) refuel/);
  const compared = results.runs['no-balances'].inputs.compared;
  assert.match(summary, new RegExp(`${compared} all-cause stops, ${compared} proxy refuel`));
  assert.match(summary, /idleMinutes \(diagnostic\)/);
  assert.doesNotMatch(summary, /AUC|AUROC|accuracy:/i);
});

test('npm run twin:holdout writes SYNTHETIC results to the directory it is given', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'playmind-twin-holdout-'));
  try {
    const run = spawnSync(process.execPath, ['scripts/twin-holdout.mjs', '--traders', '6', '--replicates', '3', '--seed', '3', '--out', directory], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /holdout-0\.1\.0 held-out validation \(SYNTHETIC\)/);
    assert.match(run.stdout, /Runtime: /);
    const files = (await readdir(directory)).sort();
    assert.deepEqual(files, [
      'twin-holdout-seed3-traders6-replicates3-balances.json',
      'twin-holdout-seed3-traders6-replicates3-balances.traders.jsonl',
      'twin-holdout-seed3-traders6-replicates3-no-balances.json',
      'twin-holdout-seed3-traders6-replicates3-no-balances.traders.jsonl'
    ]);
    const summary = JSON.parse(await readFile(join(directory, files[2]), 'utf8'));
    assert.equal(summary.label, 'SYNTHETIC');
    assert.equal(summary.dataLabel, 'SYNTHETIC');
    assert.equal(summary.path, 'no-balances');
    assert.equal(summary.perTrader, undefined, 'per-trader rows go to the JSON lines file');
    assert.ok(Number.isFinite(summary.runtimeSeconds));
    assert.ok(summary.assumptions.length > 0);
    const lines = (await readFile(join(directory, files[3]), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(lines.length, summary.inputs.compared);
    assert.ok(lines.every((line) => line.label === 'SYNTHETIC' && line.path === 'no-balances'));

    const hook = spawnSync(process.execPath, ['scripts/twin-holdout.mjs', '--observational', 'events.json'], { encoding: 'utf8' });
    assert.notEqual(hook.status, 0);
    assert.match(hook.stderr, /--observational is not wired/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
