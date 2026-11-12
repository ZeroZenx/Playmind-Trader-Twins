import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CALIBRATION_DEFAULTS,
  CALIBRATION_METRICS,
  CALIBRATION_METRIC_NAMES,
  runSimulationCalibration
} from '../src/synthetic/simulation-calibration.mjs';

// Does simulateTwinV2 reproduce each trader's own training behavior? SYNTHETIC only.
// Each trader is simulated for its training session count, and we count the traders whose
// observed training value falls inside their simulated 10th-90th percentile band. The
// computation is shared with scripts/twin-simulation.mjs (npm run twin:simulation), which
// writes the full results to gitignored local output. Calibration numbers live only here,
// as thresholds, and in that output: never in docs or commit messages.
//
// Population: CALIBRATION_DEFAULTS, 60 traders with 10 to 40 sessions, 50 replicates.

// Calibration bands.
// Truth parameters, uncertainty off: only process noise, so a continuous metric should put
// about 80% of observed values inside [p10, p90]. Per metric, allow sampling noise from 60
// traders and from estimating p10 and p90 with 50 replicates:
const TRUTH_CONTINUOUS = [0.6, 0.95];
// and require the average over the continuous metrics to be near 80%:
const TRUTH_CONTINUOUS_AVERAGE = [0.7, 0.9];
// Per-session counts have many ties, which put more values inside the band.
const TRUTH_COUNTS = [0.65, 1];
// Fitted parameters, uncertainty on: in-sample, so over-coverage is expected. Only a lower
// bound means anything here. Held-out validation is Prompt 6.
const FITTED = [0.7, 1];

const results = runSimulationCalibration();

function within(share, [low, high]) {
  return share !== null && share >= low && share <= high;
}

test('the calibration population is SYNTHETIC and every trader is simulable', () => {
  assert.equal(results.label, 'SYNTHETIC');
  assert.equal(results.modelVersion, 'twin-0.2.1');
  assert.equal(results.scenario.traderCount, CALIBRATION_DEFAULTS.traderCount);
  assert.equal(results.truth.notSimulable, 0);
  assert.equal(results.fitted.notSimulable, 0);
  for (const metric of CALIBRATION_METRIC_NAMES) {
    assert.equal(results.truth.coverage[metric].traders, CALIBRATION_DEFAULTS.traderCount, metric);
  }
});

test(`truth parameters, uncertainty off: observed training values fall inside the simulated band at about the nominal rate`, (t) => {
  const continuous = [];
  for (const metric of CALIBRATION_METRIC_NAMES) {
    const { share, below, above } = results.truth.coverage[metric];
    const band = CALIBRATION_METRICS[metric].count ? TRUTH_COUNTS : TRUTH_CONTINUOUS;
    t.diagnostic(`truth ${metric}: ${share.toFixed(3)} inside, ${below} below, ${above} above (band ${band.join('-')})`);
    assert.ok(within(share, band), `${metric}: ${share} outside [${band}]`);
    if (!CALIBRATION_METRICS[metric].count) continuous.push(share);
  }
  const average = continuous.reduce((total, share) => total + share, 0) / continuous.length;
  t.diagnostic(`truth continuous average: ${average.toFixed(3)} (band ${TRUTH_CONTINUOUS_AVERAGE.join('-')})`);
  assert.ok(within(average, TRUTH_CONTINUOUS_AVERAGE), `average ${average}`);
});

test('fitted parameters, uncertainty on (in-sample): observed training values fall inside the simulated band', (t) => {
  for (const metric of CALIBRATION_METRIC_NAMES) {
    const { share, below, above } = results.fitted.coverage[metric];
    t.diagnostic(`fitted ${metric}: ${share.toFixed(3)} inside, ${below} below, ${above} above (band ${FITTED.join('-')})`);
    assert.ok(within(share, FITTED), `${metric}: ${share} outside [${FITTED}]`);
  }
});

test('npm run twin:simulation writes SYNTHETIC results to the directory it is given', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'playmind-twin-simulation-'));
  try {
    const run = spawnSync(process.execPath, ['scripts/twin-simulation.mjs', '--traders', '8', '--replicates', '5', '--seed', '3', '--out', directory], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /simulator-0\.2\.0 calibration on twin-0\.2\.1 twins \(SYNTHETIC\)/);
    const files = (await readdir(directory)).sort();
    assert.deepEqual(files, ['twin-simulation-seed3-traders8-replicates5.json', 'twin-simulation-seed3-traders8-replicates5.traders.jsonl']);
    const summary = JSON.parse(await readFile(join(directory, files[0]), 'utf8'));
    assert.equal(summary.label, 'SYNTHETIC');
    assert.equal(summary.traders, undefined, 'per-trader rows go to the JSON lines file');
    const lines = (await readFile(join(directory, files[1]), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(lines.length, 2 * 8);
    assert.ok(lines.every((line) => line.label === 'SYNTHETIC'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
