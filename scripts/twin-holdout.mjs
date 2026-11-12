/**
 * holdout-0.1.0 held-out validation on SYNTHETIC traders.
 *
 *   npm run twin:holdout -- [--seed N] [--traders N] [--replicates N] [--ks-replicates N]
 *                           [--min-sessions N] [--max-sessions N]
 *                           [--paths balances,no-balances] [--out DIR]
 *
 * Runs src/synthetic/holdout-validation.mjs (the same function the tests use) on both data
 * paths by default (with and without balance fields), writes a SYNTHETIC-labelled JSON
 * summary and per-trader JSON lines per path, and prints a short summary and the runtime.
 * The default output directory, analysis/output/twin-holdout/, is gitignored. Validation
 * numbers stay in those files: don't copy them into docs, the README, or commit messages.
 *
 * For a quick look: npm run twin:holdout -- --traders 40 --replicates 20
 *
 * OBSERVATIONAL (Polymarket public data): --observational is a marked hook and is NOT
 * WIRED. Loading and mapping that data is a later step; the engine entry point is
 * runObservationalHoldout in src/engine/holdout.mjs.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { OBSERVATIONAL_HOOK } from '../src/engine/holdout.mjs';
import { HOLDOUT_PATH_NAMES, HOLDOUT_RUN_DEFAULTS, formatHoldoutSummary, runSyntheticHoldout } from '../src/synthetic/holdout-validation.mjs';

function parseArguments(argv) {
  const options = {
    seed: HOLDOUT_RUN_DEFAULTS.seed,
    traderCount: HOLDOUT_RUN_DEFAULTS.traderCount,
    replicates: HOLDOUT_RUN_DEFAULTS.replicates,
    ksReplicates: HOLDOUT_RUN_DEFAULTS.ksReplicates,
    sessionsPerTrader: { ...HOLDOUT_RUN_DEFAULTS.sessionsPerTrader },
    paths: [...HOLDOUT_RUN_DEFAULTS.paths],
    out: join('analysis', 'output', 'twin-holdout')
  };
  const integers = {
    '--seed': [(value) => { options.seed = value; }, 0],
    '--traders': [(value) => { options.traderCount = value; }, 3],
    '--replicates': [(value) => { options.replicates = value; }, 1],
    '--ks-replicates': [(value) => { options.ksReplicates = value; }, 1],
    '--min-sessions': [(value) => { options.sessionsPerTrader.min = value; }, 2],
    '--max-sessions': [(value) => { options.sessionsPerTrader.max = value; }, 2]
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = argv[index + 1];
    if (Object.hasOwn(integers, flag)) {
      const [assign, minimum] = integers[flag];
      const number = Number(next);
      if (!Number.isInteger(number) || number < minimum) throw new RangeError(`${flag} needs an integer of at least ${minimum}`);
      assign(number);
      index += 1;
    } else if (flag === '--paths') {
      const paths = String(next ?? '').split(',').filter(Boolean);
      if (!paths.length || paths.some((path) => !HOLDOUT_PATH_NAMES.includes(path))) throw new RangeError(`--paths needs a comma-separated list from ${HOLDOUT_PATH_NAMES.join(', ')}`);
      options.paths = paths;
      index += 1;
    } else if (flag === '--observational') {
      throw new Error(`--observational is ${OBSERVATIONAL_HOOK.status}: ${OBSERVATIONAL_HOOK.note} Entry point: ${OBSERVATIONAL_HOOK.entryPoint}.`);
    } else if (flag === '--out') {
      if (!next) throw new RangeError('--out needs a directory');
      options.out = next;
      index += 1;
    } else {
      throw new RangeError(`unknown argument ${flag}`);
    }
  }
  if (options.sessionsPerTrader.min > options.sessionsPerTrader.max) throw new RangeError('--min-sessions must not exceed --max-sessions');
  return options;
}

// Output files round to 6 significant digits.
const compact = (key, value) => (typeof value === 'number' && Number.isFinite(value) && !Number.isInteger(value) ? Number(value.toPrecision(6)) : value);

const { out, ...options } = parseArguments(process.argv.slice(2));
const started = Date.now();
let lastReport = 0;
const results = runSyntheticHoldout({
  ...options,
  includeTraders: true,
  onProgress: ({ path, model, replicate, of }) => {
    const now = Date.now();
    if (now - lastReport >= 5000 || replicate === of) {
      lastReport = now;
      process.stderr.write(`  ${path}: ${model} replicate ${replicate}/${of}, ${((now - started) / 1000).toFixed(0)} s elapsed\n`);
    }
  }
});
const runtimeSeconds = (Date.now() - started) / 1000;

const directory = resolve(out);
await mkdir(directory, { recursive: true });
const written = [];
for (const [path, run] of Object.entries(results.runs)) {
  const stem = join(directory, `twin-holdout-seed${options.seed}-traders${options.traderCount}-replicates${options.replicates}-${path}`);
  const summaryPath = `${stem}.json`;
  const tradersPath = `${stem}.traders.jsonl`;
  const { perTrader, ...summary } = run;
  await writeFile(summaryPath, `${JSON.stringify({
    label: results.label,
    generatorVersion: results.generatorVersion,
    scenario: results.scenario,
    ...summary,
    tradersFile: tradersPath.split(/[\\/]/).at(-1),
    runtimeSeconds,
    generatedAt: new Date().toISOString()
  }, compact, 2)}\n`);
  await writeFile(tradersPath, `${perTrader.map((row) => JSON.stringify({ label: results.label, path, ...row }, compact)).join('\n')}\n`);
  written.push(summaryPath, tradersPath);
}

console.log(formatHoldoutSummary(results));
console.log(`\nRuntime: ${runtimeSeconds.toFixed(1)} s for ${results.scenario.paths.length} path(s), ${options.traderCount} traders x ${options.replicates} replicates.`);
console.log(`Wrote ${written.join('\n  and ')} (SYNTHETIC). Keep them out of the repo.`);
