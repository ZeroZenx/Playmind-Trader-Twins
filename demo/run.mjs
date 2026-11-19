/**
 * npm run demo: evidence report v2 (report-0.2.0) on a SYNTHETIC behavioral population.
 *
 *   npm run demo -- [--seed N] [--traders N] [--holdout-replicates N] [--sweep-replicates N]
 *                   [--horizon-days N] [--policies a,b] [--no-balances] [--out DIR]
 *
 * Runs src/synthetic/report-demo.mjs (generate -> validate -> fit -> held-out validation ->
 * policy sweep -> report) and writes report-v2.json, report-v2.html, and the synthetic
 * events to demo/output/. That directory is gitignored: the report contains held-out
 * validation results, which stay in local output (CLAUDE.md). For a quick look:
 *   npm run demo -- --traders 30 --holdout-replicates 10 --sweep-replicates 8
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { POLICY_V2_TYPES } from '../src/engine/policy-sim.mjs';
import { renderReportV2Html } from '../src/engine/report-v2.mjs';
import { runReportDemo } from '../src/synthetic/report-demo.mjs';

function parseArguments(argv) {
  const options = { out: join('demo', 'output') };
  const integers = {
    '--seed': ['seed', 0],
    '--traders': ['traderCount', 3],
    '--holdout-replicates': ['holdoutReplicates', 1],
    '--sweep-replicates': ['sweepReplicates', 1],
    '--horizon-days': ['horizonDays', 1]
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = argv[index + 1];
    if (Object.hasOwn(integers, flag)) {
      const [key, minimum] = integers[flag];
      const number = Number(next);
      if (!Number.isInteger(number) || number < minimum) throw new RangeError(`${flag} needs an integer of at least ${minimum}`);
      options[key] = number;
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

const { out, ...options } = parseArguments(process.argv.slice(2));
const started = Date.now();
let lastStep = null;
let lastReport = 0;
const { dataset, report, settings } = runReportDemo({
  ...options,
  generatedAt: new Date().toISOString(),
  onProgress: ({ step, traders, of, model, replicate }) => {
    const now = Date.now();
    if (step === lastStep && now - lastReport < 5000) return;
    lastStep = step;
    lastReport = now;
    const detail = traders !== undefined ? ` ${traders}/${of} traders` : replicate !== undefined ? ` ${model} replicate ${replicate}/${of}` : '';
    process.stderr.write(`  ${step}${detail}, ${((now - started) / 1000).toFixed(0)} s\n`);
  }
});
const runtimeSeconds = (Date.now() - started) / 1000;

const directory = resolve(out);
await mkdir(directory, { recursive: true });
const files = {
  events: join(directory, 'synthetic-events.json'),
  json: join(directory, 'report-v2.json'),
  html: join(directory, 'report-v2.html')
};
await writeFile(files.events, `${JSON.stringify({ label: dataset.truth.label, truth: dataset.truth, events: dataset.events })}\n`);
await writeFile(files.json, `${JSON.stringify({ ...report, runtimeSeconds }, null, 2)}\n`);
await writeFile(files.html, renderReportV2Html(report));

const validation = report.sections.validation.overall;
console.log(JSON.stringify({
  status: 'success',
  label: report.dataLabel,
  reportVersion: report.reportVersion,
  traders: settings.traderCount,
  balances: settings.includeBalances,
  sections: report.sectionOrder,
  validationClaimEarned: validation.claimEarned,
  runtimeSeconds,
  files,
  note: 'demo/output/ is gitignored: the report holds held-out validation results. Keep it out of the repo.'
}, null, 2));
