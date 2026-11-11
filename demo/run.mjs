import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateSyntheticDataset } from '../src/synthetic/generate.mjs';
import {
  aggregateSignals,
  buildReport,
  buildSignals,
  buildTwins,
  comparePolicy,
  renderHtmlReport,
  validateEvents
} from '../src/engine/index.mjs';

const outputArgumentIndex = process.argv.indexOf('--out');
const outputDirectory = outputArgumentIndex >= 0
  ? process.argv[outputArgumentIndex + 1]
  : 'demo/output';

const dataset = generateSyntheticDataset({ seed: 424242, traderCount: 12, days: 21 });
const quality = validateEvents(dataset.events);
if (!quality.valid) {
  throw new Error(`Synthetic dataset failed validation: ${quality.errors.join(' ')}`);
}

const signals = buildSignals(dataset.events, { sessionGapMinutes: 30 });
const twins = buildTwins(signals, dataset.seed);
const policy = { name: '30-minute cooldown after a realized loss', type: 'cooldown', durationMinutes: 30 };
const policyRun = comparePolicy(twins, policy, { horizonDays: 7, seed: 7000 });
const report = buildReport({
  dataset: { ...dataset, eventCount: dataset.events.length, traderCount: signals.length },
  quality,
  signals,
  twins,
  policyRun
});

await mkdir(outputDirectory, { recursive: true });
await writeFile(join(outputDirectory, 'synthetic-events.json'), `${JSON.stringify(dataset, null, 2)}\n`);
await writeFile(join(outputDirectory, 'synthetic-report.json'), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(join(outputDirectory, 'synthetic-report.html'), renderHtmlReport(report));

console.log(JSON.stringify({
  status: 'success',
  outputDirectory,
  eventCount: dataset.events.length,
  traderCount: signals.length,
  qualityWarnings: quality.warnings.length,
  policy: policyRun.policy,
  aggregate: aggregateSignals(signals),
  policyAggregate: policyRun.aggregate,
  label: report.label
}, null, 2));
