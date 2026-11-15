import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { BEHAVIOR_SIGNAL_DEFINITIONS } from '../src/engine/behavior.mjs';
import { estimateTwins, TWIN_PARAMETER_DEFINITIONS, TWIN_PARAMETER_NAMES } from '../src/engine/estimate.mjs';
import { assessReadiness, baseFields, fieldAskList, renderFieldAskListMarkdown, renderReadinessMarkdown } from '../src/intake/readiness.mjs';
import { generateBehavioralDataset } from '../src/synthetic/behavioral-generate.mjs';

// Intake readiness (intake-readiness-0.1.0) is derived from BEHAVIOR_SIGNAL_DEFINITIONS and
// TWIN_PARAMETER_DEFINITIONS. All data here is SYNTHETIC.

// settled_at (at the trade time) is added so every definition, the settlement lag (ADR-018) included, has its fields.
const withBalances = generateBehavioralDataset({ seed: 31, mode: 'population', traderCount: 8, sessionsPerTrader: { min: 10, max: 14 } }).events
  .map((event) => (event.type === 'trade' && event.realized_result !== null ? { ...event, settled_at: event.occurred_at } : event));
const strip = (events, fields) => events.map((event) => Object.fromEntries(Object.entries(event).filter(([key]) => !fields.includes(key))));
const noBalances = strip(withBalances, ['balance_before', 'balance_after']);
const byName = (readiness) => Object.fromEntries([...readiness.signals, ...readiness.parameters].map((item) => [item.name, item]));

test('readiness covers every signal and parameter in the definitions, with their fields', () => {
  const readiness = assessReadiness(withBalances, { label: 'SYNTHETIC' });
  assert.deepEqual(readiness.signals.map((item) => item.name), Object.keys(BEHAVIOR_SIGNAL_DEFINITIONS));
  assert.deepEqual(readiness.parameters.map((item) => item.name), TWIN_PARAMETER_NAMES);
  for (const item of readiness.signals) {
    assert.deepEqual(item.requires, [...BEHAVIOR_SIGNAL_DEFINITIONS[item.name].requires]);
    assert.deepEqual(item.anyOf, BEHAVIOR_SIGNAL_DEFINITIONS[item.name].anyOf.map((group) => [...group]));
  }
  for (const item of readiness.parameters) assert.deepEqual(item.requires, [...TWIN_PARAMETER_DEFINITIONS[item.name].requires]);
  assert.equal(readiness.label, 'SYNTHETIC');
  assert.ok(readiness.parameters.every((item) => item.status === 'estimable'), 'balances present: everything is estimable');
  assert.equal(byName(readiness).stopHazard.variant, 'voluntary');
  assert.deepEqual(baseFields(), ['trader_token', 'occurred_at', 'type']);
});

test('removing a field marks exactly the definitions that require it not estimable, naming the field', () => {
  for (const field of ['realized_result', 'stake_amount', 'deposit_amount']) {
    const readiness = byName(assessReadiness(strip(withBalances, [field]), { label: 'SYNTHETIC' }));
    for (const [name, definition] of Object.entries(TWIN_PARAMETER_DEFINITIONS)) {
      const needs = definition.requires.includes(field);
      assert.equal(readiness[name].status === 'not estimable', needs, `${name} without ${field}`);
      if (needs) assert.ok(readiness[name].unlockWith.includes(field));
    }
    for (const [name, definition] of Object.entries(BEHAVIOR_SIGNAL_DEFINITIONS)) {
      // Every other field is present, so a group fails only if it contains the removed field.
      const expectNot = definition.requires.includes(field) || (definition.anyOf.length > 0 && definition.anyOf.every((group) => group.includes(field)));
      assert.equal(readiness[name].status === 'not estimable', expectNot, `${name} without ${field}`);
      assert.equal(readiness[name].unlockWith.includes(field), expectNot, `${name} names ${field} as the unlock`);
    }
  }
});

test('without balance fields, refuelProbability is not estimable and names the fields that unlock it', () => {
  const readiness = assessReadiness(noBalances, { label: 'SYNTHETIC' });
  const items = byName(readiness);
  assert.equal(items.refuelProbability.status, 'not estimable');
  assert.deepEqual(items.refuelProbability.unlockWith, ['balance_before', 'balance_after']);
  assert.match(items.refuelProbability.proxyNote, /refuelAfterLosingStreak/);
  assert.equal(items.refuelAfterLosingStreak.status, 'estimable');
  assert.equal(items.stopHazard.status, 'estimable (all-cause)');
  assert.deepEqual(items.stopHazard.upgradeWith.fields, ['balance_before', 'balance_after']);
  assert.deepEqual(items.refuel.path, ['realized_result']);
  assert.match(readiness.summary.balancePath, /no balance fields/);
  const ask = Object.fromEntries(readiness.askList.map((entry) => [entry.field, entry]));
  assert.ok(ask.balance_before.unlocks.includes('refuelProbability'));
  assert.ok(ask.balance_after.upgrades.includes('stopHazard'));
  // The fit agrees with readiness.
  const fit = estimateTwins(noBalances, { dataLabel: 'SYNTHETIC' });
  assert.ok(fit.twins.every((twin) => twin.parameters.refuelProbability.status === 'not_estimable'));
  assert.ok(fit.twins.every((twin) => twin.stopHazardBasis === null || twin.stopHazardBasis === 'all-cause'));
  const markdown = renderReadinessMarkdown(readiness);
  assert.match(markdown, /# Intake readiness \(SYNTHETIC\)/);
  assert.match(markdown, /refuelProbability \| not estimable/);
});

test('partial balances count only for traders with them on every trade', () => {
  const firstTrader = withBalances[0].trader_token;
  const partial = withBalances.map((event) => (event.trader_token === firstTrader || event.type !== 'trade' ? event : { ...event, balance_after: null }));
  const readiness = assessReadiness(partial, { label: 'SYNTHETIC' });
  assert.equal(readiness.fieldCoverage.tradersWithCompleteBalances, 1);
  assert.equal(byName(readiness).refuelProbability.status, 'estimable');
  assert.match(readiness.summary.balancePath, /some traders only/);
  const none = assessReadiness(withBalances.map((event) => (event.type === 'trade' && event.source_row_number % 2 ? { ...event, balance_after: null } : event)), { label: 'SYNTHETIC' });
  assert.equal(byName(none).refuelProbability.status, 'not estimable');
  assert.match(byName(none).refuelProbability.reasons.join(' '), /not on every trade/);
});

test('the field ask list follows the definitions, and docs/SPORTTRADE_INTAKE.md embeds it', async () => {
  const rows = Object.fromEntries(fieldAskList().map((row) => [row.field, row]));
  for (const field of baseFields()) assert.equal(rows[field].tier, 'required');
  for (const field of ['event_id', 'venue_id', 'source_row_number']) assert.equal(rows[field].source, 'filled by intake');
  for (const field of ['stake_amount', 'realized_result', 'deposit_amount']) assert.equal(rows[field].tier, 'strongly wanted', field);
  for (const field of ['balance_before', 'balance_after']) {
    assert.equal(rows[field].tier, 'nice to have');
    assert.deepEqual(rows[field].voluntaryVariantOf, ['stopHazard']);
  }
  for (const field of ['market_id', 'market_type', 'price', 'quantity']) assert.equal(rows[field].readByDefinitions, false, `${field} is optional`);
  const doc = await readFile(new URL('../docs/SPORTTRADE_INTAKE.md', import.meta.url), 'utf8');
  const embedded = doc.replace(/\r\n/g, '\n').match(/<!-- intake-fields:start -->\n([\s\S]*?)\n<!-- intake-fields:end -->/);
  assert.ok(embedded, 'the doc has the generated field table');
  assert.equal(embedded[1], renderFieldAskListMarkdown(), 'regenerate with: npm run intake -- fields');
});
