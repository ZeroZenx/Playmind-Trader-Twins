import test from 'node:test';
import assert from 'node:assert/strict';
import { runTwinPipeline } from '../src/engine/pipeline.mjs';
import { generateBehavioralDataset } from '../src/synthetic/behavioral-generate.mjs';

test('the shared analysis pipeline produces a labeled report without trader tokens', () => {
  const dataset = generateBehavioralDataset({
    seed: 818,
    mode: 'population',
    traderCount: 5,
    sessionsPerTrader: { min: 12, max: 16 },
    includeBalances: true
  });
  const result = runTwinPipeline(dataset.events, {
    dataLabel: 'SYNTHETIC',
    dataset: { name: 'pipeline-test', venueId: 'synthetic' },
    holdoutReplicates: 1,
    sweepReplicates: 1,
    horizonDays: 3,
    policies: ['cooldown']
  });
  assert.equal(result.report.dataLabel, 'SYNTHETIC');
  assert.deepEqual(result.report.sectionOrder, ['data', 'population', 'validation', 'policy', 'affected', 'assumptions']);
  const reportJson = JSON.stringify(result.report);
  assert.equal(dataset.truth.traders.some((trader) => reportJson.includes(trader.traderToken)), false);
  assert.equal(result.fit.inputs.traderCount, 5);
});

test('the shared analysis pipeline rejects an invalid data label', () => {
  assert.throws(
    () => runTwinPipeline([], { dataLabel: 'synthetic', dataset: { name: 'invalid' } }),
    /dataLabel must be SYNTHETIC, OBSERVATIONAL, or CUSTOMER/
  );
});
