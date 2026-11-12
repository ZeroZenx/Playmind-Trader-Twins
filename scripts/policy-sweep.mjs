/**
 * policy-0.2.0 sensitivity sweep on SYNTHETIC traders.
 *
 *   npm run policy:sweep -- [--seed N] [--traders N] [--replicates N] [--horizon-days N]
 *                           [--design one-at-a-time|grid] [--policies a,b] [--no-balances]
 *                           [--out DIR]
 *
 * Runs src/synthetic/policy-sweep.mjs (the same function the tests use), writes a
 * SYNTHETIC-labelled JSON summary and per-trader JSON lines, and prints a short summary.
 * The default output directory, analysis/output/policy-sweep/, is gitignored. Policy
 * result numbers stay in those files: don't copy them into docs or commit messages.
 *
 * The default (500 traders, 200 replicates, every policy one assumption at a time) is the
 * full run and takes a while; progress goes to stderr. For a quick look:
 *   npm run policy:sweep -- --traders 100 --replicates 50 --policies cooldown
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { POLICY_SWEEP_DESIGNS, POLICY_V2_TYPES } from '../src/engine/policy-sim.mjs';
import { POLICY_SWEEP_RUN_DEFAULTS, formatPolicySweepSummary, runSyntheticPolicySweep } from '../src/synthetic/policy-sweep.mjs';

function parseArguments(argv) {
  const options = {
    seed: POLICY_SWEEP_RUN_DEFAULTS.seed,
    traderCount: POLICY_SWEEP_RUN_DEFAULTS.traderCount,
    replicates: POLICY_SWEEP_RUN_DEFAULTS.replicates,
    horizonDays: POLICY_SWEEP_RUN_DEFAULTS.horizonDays,
    design: POLICY_SWEEP_RUN_DEFAULTS.design,
    policies: [...POLICY_SWEEP_RUN_DEFAULTS.policies],
    includeBalances: POLICY_SWEEP_RUN_DEFAULTS.includeBalances,
    out: join('analysis', 'output', 'policy-sweep')
  };
  const integers = { '--seed': ['seed', 0], '--traders': ['traderCount', 3], '--replicates': ['replicates', 1], '--horizon-days': ['horizonDays', 1] };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = argv[index + 1];
    if (Object.hasOwn(integers, flag)) {
      const [key, minimum] = integers[flag];
      const number = Number(next);
      if (!Number.isInteger(number) || number < minimum) throw new RangeError(`${flag} needs an integer of at least ${minimum}`);
      options[key] = number;
      index += 1;
    } else if (flag === '--design') {
      if (!POLICY_SWEEP_DESIGNS.includes(next)) throw new RangeError(`--design needs one of ${POLICY_SWEEP_DESIGNS.join(', ')}`);
      options.design = next;
      index += 1;
    } else if (flag === '--policies') {
      const types = String(next ?? '').split(',').filter(Boolean);
      if (!types.length || types.some((type) => !POLICY_V2_TYPES.includes(type))) throw new RangeError(`--policies needs a comma-separated list from ${POLICY_V2_TYPES.join(', ')}`);
      options.policies = types;
      index += 1;
    } else if (flag === '--no-balances') {
      options.includeBalances = false;
    } else if (flag === '--out') {
      if (!next) throw new RangeError('--out needs a directory');
      options.out = next;
      index += 1;
    } else {
      throw new RangeError(`unknown argument ${flag}`);
    }
  }
  return options;
}

// Output files round to 6 significant digits to keep the per-trader lines small.
const compact = (key, value) => (typeof value === 'number' && Number.isFinite(value) && !Number.isInteger(value) ? Number(value.toPrecision(6)) : value);
const medians = (group) => (group ? Object.fromEntries(Object.entries(group).map(([name, summary]) => [name, summary.median])) : null);

const { out, ...options } = parseArguments(process.argv.slice(2));
const started = Date.now();
let lastReport = 0;
const results = runSyntheticPolicySweep({
  ...options,
  onProgress: ({ traders, of }) => {
    const share = traders / of;
    if (share - lastReport >= 0.05 || traders === of) {
      lastReport = share;
      const elapsed = (Date.now() - started) / 1000;
      process.stderr.write(`  ${traders}/${of} traders, ${elapsed.toFixed(0)} s elapsed, about ${(elapsed / share - elapsed).toFixed(0)} s left\n`);
    }
  }
});
const runtimeSeconds = (Date.now() - started) / 1000;

const directory = resolve(out);
await mkdir(directory, { recursive: true });
const stem = join(directory, `policy-sweep-seed${options.seed}-traders${options.traderCount}-replicates${options.replicates}-${options.design}${options.includeBalances ? '' : '-no-balances'}`);
const summaryPath = `${stem}.json`;
const tradersPath = `${stem}.traders.jsonl`;

// Summary: everything except the per-trader rows. Per-trader rows: one JSON line per cell
// and trader, with the primary pair in full and every metric's median.
const rows = [];
const policies = results.policies.map((policy) => ({
  ...policy,
  cells: policy.cells.map(({ perTrader, ...cell }) => {
    for (const trader of perTrader) {
      rows.push(JSON.stringify({
        label: results.label,
        policyType: policy.type,
        cellId: cell.id,
        traderToken: trader.traderToken,
        applicable: trader.applicable,
        reason: trader.reason ?? null,
        primary: trader.primary,
        harmReductionMedian: medians(trader.harmReduction),
        activityRetainedMedian: medians(trader.activityRetained),
        differenceMedian: medians(trader.difference),
        accounting: trader.accounting
      }, compact));
    }
    return cell;
  })
}));
await writeFile(summaryPath, `${JSON.stringify({
  ...results,
  policies,
  tradersFile: tradersPath.split(/[\\/]/).at(-1),
  runtimeSeconds,
  generatedAt: new Date().toISOString()
}, compact, 2)}\n`);
await writeFile(tradersPath, `${rows.join('\n')}\n`);

console.log(formatPolicySweepSummary(results));
console.log(`\nRuntime: ${runtimeSeconds.toFixed(1)} s for ${results.cellCount} cells plus the baseline, ${results.traders.filter((trader) => trader.simulable).length} traders x ${results.replicates} replicates.`);
console.log(`Wrote ${summaryPath}\n  and ${tradersPath} (SYNTHETIC). Keep them out of the repo.`);
