import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { POLICY_VERSION } from '../src/engine/policy-sim.mjs';
import { POLICY_SWEEP_RUN_DEFAULTS, formatPolicySweepSummary, runSyntheticPolicySweep } from '../src/synthetic/policy-sweep.mjs';

// The shared module behind `npm run policy:sweep`, at a small scale. The default run (500
// traders, 200 replicates, every policy) is for the script; its numbers go only to
// gitignored output.

test('the synthetic sweep is SYNTHETIC, labelled, and starts traders at their last observed balance', () => {
  assert.equal(POLICY_SWEEP_RUN_DEFAULTS.traderCount, 500);
  assert.equal(POLICY_SWEEP_RUN_DEFAULTS.replicates, 200);
  const results = runSyntheticPolicySweep({ traderCount: 8, replicates: 3, horizonDays: 7, policies: ['stake_limit', 'deposit_limit'] });
  assert.equal(results.label, 'SYNTHETIC');
  assert.equal(results.dataLabel, 'SYNTHETIC');
  assert.equal(results.policyVersion, POLICY_VERSION);
  assert.equal(results.scenario.traderCount, 8);
  assert.match(results.scenario.startingBalances, /last observed balance_after/);
  assert.ok(results.traders.every((trader) => trader.simulable && trader.stopBasis === 'voluntary'));
  assert.deepEqual(results.policies.map((policy) => policy.type), ['stake_limit', 'deposit_limit']);
  const summary = formatPolicySweepSummary(results);
  assert.match(summary, /policy-0\.2\.0 sweep on twin-0\.2\.1 twins, simulator-0\.2\.0 \(SYNTHETIC\)/);
  assert.match(summary, /assumed rather than estimated/);
  assert.match(summary, /Driver: stake_limit: /);
  assert.throws(() => runSyntheticPolicySweep({ traders: 8 }), /unknown option "traders"/);

  // Without balance fields every trader is all-cause and proxy-refuel, and the labels say so.
  const plain = runSyntheticPolicySweep({ traderCount: 6, replicates: 2, horizonDays: 5, policies: ['session_loss_limit'], includeBalances: false });
  assert.equal(plain.labels.allCauseStops.length, 6);
  assert.equal(plain.labels.proxyRefuel.length, 6);
  assert.match(formatPolicySweepSummary(plain), /6 all-cause stops, 6 proxy refuel/);
});

test('npm run policy:sweep writes SYNTHETIC results to the directory it is given', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'playmind-policy-sweep-'));
  try {
    const run = spawnSync(process.execPath, [
      'scripts/policy-sweep.mjs', '--traders', '5', '--replicates', '2', '--horizon-days', '5', '--seed', '3',
      '--policies', 'cooldown,session_loss_limit', '--out', directory
    ], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /policy-0\.2\.0 sweep on twin-0\.2\.1 twins, simulator-0\.2\.0 \(SYNTHETIC\)/);
    assert.match(run.stdout, /Runtime: /);
    const files = (await readdir(directory)).sort();
    assert.deepEqual(files, ['policy-sweep-seed3-traders5-replicates2-one-at-a-time.json', 'policy-sweep-seed3-traders5-replicates2-one-at-a-time.traders.jsonl']);
    const summary = JSON.parse(await readFile(join(directory, files[0]), 'utf8'));
    assert.equal(summary.label, 'SYNTHETIC');
    assert.match(summary.claim, /not a causal claim/i);
    assert.ok(summary.policies.every((policy) => policy.cells.every((cell) => cell.perTrader === undefined)), 'per-trader rows go to the JSON lines file');
    assert.ok(Number.isFinite(summary.runtimeSeconds));
    const lines = (await readFile(join(directory, files[1]), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(lines.length, summary.cellCount * 5);
    assert.ok(lines.every((line) => line.label === 'SYNTHETIC' && line.primary.harmMetric === 'totalNetLoss'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
