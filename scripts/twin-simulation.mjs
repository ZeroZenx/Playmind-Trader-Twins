/**
 * simulator-0.2.0 calibration on SYNTHETIC traders.
 *
 *   npm run twin:simulation -- [--seed N] [--traders N] [--replicates N] [--out DIR]
 *
 * Runs src/synthetic/simulation-calibration.mjs (the same function the tests use),
 * writes a SYNTHETIC-labelled JSON results file, and prints a short summary. The default
 * output directory, analysis/output/twin-simulation/, is gitignored. Calibration numbers
 * stay in that file: don't copy them into docs or commit messages.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { CALIBRATION_DEFAULTS, formatCalibrationSummary, runSimulationCalibration } from '../src/synthetic/simulation-calibration.mjs';

function parseArguments(argv) {
  const options = {
    seed: CALIBRATION_DEFAULTS.seed,
    traderCount: CALIBRATION_DEFAULTS.traderCount,
    replicates: CALIBRATION_DEFAULTS.replicates,
    out: join('analysis', 'output', 'twin-simulation')
  };
  const minimums = { '--seed': 0, '--traders': 3, '--replicates': 1 };
  const keys = { '--seed': 'seed', '--traders': 'traderCount', '--replicates': 'replicates' };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = argv[index + 1];
    if (Object.hasOwn(keys, flag)) {
      const number = Number(next);
      if (!Number.isInteger(number) || number < minimums[flag]) throw new RangeError(`${flag} needs an integer of at least ${minimums[flag]}`);
      options[keys[flag]] = number;
      index += 1;
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

const options = parseArguments(process.argv.slice(2));
const results = runSimulationCalibration({
  seed: options.seed,
  traderCount: options.traderCount,
  replicates: options.replicates,
  includeTraders: true
});
const directory = resolve(options.out);
await mkdir(directory, { recursive: true });
const stem = join(directory, `twin-simulation-seed${options.seed}-traders${options.traderCount}-replicates${options.replicates}`);

// Summary as one JSON document; per-trader rows as JSON lines, each labelled.
const { traders, ...summary } = results;
const summaryPath = `${stem}.json`;
const tradersPath = `${stem}.traders.jsonl`;
await writeFile(summaryPath, `${JSON.stringify({ ...summary, tradersFile: tradersPath.split(/[\\/]/).at(-1), generatedAt: new Date().toISOString() }, null, 2)}\n`);
await writeFile(tradersPath, `${traders.map((row) => JSON.stringify({ label: results.label, ...row })).join('\n')}\n`);

console.log(formatCalibrationSummary(results));
console.log(`\nWrote ${summaryPath}\n  and ${tradersPath} (SYNTHETIC). Keep them out of the repo.`);
