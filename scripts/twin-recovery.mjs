/**
 * twin-0.2.0 parameter recovery on SYNTHETIC traders.
 *
 *   npm run twin:recovery -- [--seed N] [--traders N] [--out DIR]
 *
 * Runs the scenarios in src/synthetic/twin-recovery.mjs (the same function the tests
 * use), writes a SYNTHETIC-labelled JSON results file, and prints a short summary.
 * The default output directory, analysis/output/twin-recovery/, is gitignored.
 * Recovery numbers stay in that file: don't copy them into docs or commit messages.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { RECOVERY_DEFAULTS, formatRecoverySummary, runRecoveryScenarios } from '../src/synthetic/twin-recovery.mjs';

function parseArguments(argv) {
  const options = { seed: RECOVERY_DEFAULTS.seed, traderCount: RECOVERY_DEFAULTS.traderCount, out: join('analysis', 'output', 'twin-recovery') };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = argv[index + 1];
    if (flag === '--seed' || flag === '--traders') {
      const number = Number(next);
      if (!Number.isInteger(number) || number < (flag === '--seed' ? 0 : 3)) {
        throw new RangeError(`${flag} needs an integer${flag === '--traders' ? ' of at least 3' : ''}`);
      }
      if (flag === '--seed') options.seed = number;
      else options.traderCount = number;
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
const report = runRecoveryScenarios({ seed: options.seed, traderCount: options.traderCount, includeTraders: true });
const directory = resolve(options.out);
await mkdir(directory, { recursive: true });
const stem = join(directory, `twin-recovery-seed${options.seed}-traders${options.traderCount}`);

// Summary as one JSON document; per-trader rows as JSON lines, each labelled.
const rows = [];
const scenarios = {};
for (const [name, { traders, ...summary }] of Object.entries(report.scenarios)) {
  scenarios[name] = summary;
  for (const trader of traders ?? []) rows.push(JSON.stringify({ label: report.label, scenario: name, ...trader }));
}
const summaryPath = `${stem}.json`;
const tradersPath = `${stem}.traders.jsonl`;
await writeFile(summaryPath, `${JSON.stringify({ ...report, scenarios, tradersFile: tradersPath.split(/[\\/]/).at(-1), generatedAt: new Date().toISOString() }, null, 2)}\n`);
await writeFile(tradersPath, `${rows.join('\n')}\n`);

console.log(formatRecoverySummary(report));
console.log(`\nWrote ${summaryPath}\n  and ${tradersPath} (SYNTHETIC). Keep them out of the repo.`);
