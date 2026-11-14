import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PROHIBITED_FIELDS, REQUIRED_FIELDS } from '../src/engine/validate.mjs';
import { ACCOUNT_IDENTIFIER_FIELDS } from '../src/intake/pii.mjs';
import { prohibitedKeys, validateMappedEvents } from '../src/intake/validate.mjs';
import { generateBehavioralDataset } from '../src/synthetic/behavioral-generate.mjs';

// Intake validate (intake-validate-0.1.0): the CLI and the upload path (src/lib/ingestion.ts)
// must reject the same PII headers. Node strips the TypeScript types, so the test can call
// parseTokenizedCsv itself.

const ingestionSource = await readFile(new URL('../src/lib/ingestion.ts', import.meta.url), 'utf8');
const { parseTokenizedCsv } = await import('../src/lib/ingestion.ts');

function setLiteral(name) {
  const match = ingestionSource.match(new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]\\)`));
  assert.ok(match, `ingestion.ts defines ${name}`);
  return new Set([...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]));
}

function arrayLiteral(name) {
  const match = ingestionSource.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`));
  assert.ok(match, `ingestion.ts defines ${name}`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]);
}

test('the PII lists in validate.mjs and ingestion.ts agree', () => {
  const forbidden = setLiteral('forbidden');
  assert.deepEqual([...PROHIBITED_FIELDS].sort(), [...forbidden].sort());
  assert.deepEqual(arrayLiteral('requiredHeaders'), REQUIRED_FIELDS);
  for (const field of ACCOUNT_IDENTIFIER_FIELDS) assert.ok(PROHIBITED_FIELDS.has(field), `${field} is prohibited in analytical events`);
  // Nothing was loosened: every name either list had before stays.
  for (const field of ['name', 'email', 'phone', 'address', 'date_of_birth', 'dob', 'government_id', 'ip_address', 'device_fingerprint', 'unmasked_account_id', 'full_name', 'first_name', 'last_name', 'username', 'user_name', 'customer_name', 'email_address', 'ip', 'account_id', 'customer_id']) {
    assert.ok(PROHIBITED_FIELDS.has(field) && forbidden.has(field), field);
  }
});

test('intake validate is never looser than ingestion.ts', () => {
  // ingestion.ts only trims and lowercases; intake also maps spaces to "_" (as validate.mjs does)
  // and splits camelCase, so it rejects a superset: "Email Address" here, accepted there.
  assert.ok(prohibitedKeys([{ 'Email Address': 'x' }]).length === 1);
  assert.doesNotThrow(() => parseTokenizedCsv(`${[...REQUIRED_FIELDS, 'Email Address'].join(',')}\n`));
});

test('ingestion.ts and intake validate agree on the listed headers and plain variants', () => {
  const candidates = [...PROHIBITED_FIELDS, 'Email', ' Phone ', 'market_name', 'stake_amount', 'channel'];
  for (const header of candidates) {
    const csv = `${[...REQUIRED_FIELDS, header].join(',')}\n`;
    let rejected = false;
    try {
      parseTokenizedCsv(csv);
    } catch (error) {
      rejected = /Direct PII fields are prohibited/.test(error.message);
    }
    const intake = prohibitedKeys([{ [header]: 'x' }]).length > 0;
    assert.equal(intake, rejected, `"${header}": intake ${intake ? 'rejects' : 'accepts'}, ingestion.ts ${rejected ? 'rejects' : 'accepts'}`);
  }
});

test('validate rejects mapped events with a PII header, and passes clean ones', () => {
  const { events } = generateBehavioralDataset({ seed: 4, mode: 'population', traderCount: 3, sessionsPerTrader: 3, includeBalances: false });
  const clean = validateMappedEvents(events, { label: 'SYNTHETIC' });
  assert.equal(clean.valid, true);
  assert.equal(clean.label, 'SYNTHETIC');
  for (const header of ['email', 'Email Address', 'account_id', 'IP']) {
    const dirty = events.map((event, index) => (index === 3 ? { ...event, [header]: 'synthetic-value' } : event));
    const result = validateMappedEvents(dirty, { label: 'SYNTHETIC' });
    assert.equal(result.valid, false, header);
    assert.equal(result.piiHeaders.length, 1, header);
    assert.ok(result.errors.some((error) => /prohibited field/.test(error)));
    assert.ok(!JSON.stringify(result).includes('synthetic-value'), 'no value in the messages');
  }
  assert.throws(() => validateMappedEvents(events, {}), /label is required/);
});
