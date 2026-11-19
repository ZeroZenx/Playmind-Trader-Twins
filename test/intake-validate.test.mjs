import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PROHIBITED_FIELDS, REQUIRED_FIELDS, validateEvents } from '../src/engine/validate.mjs';
import { ACCOUNT_IDENTIFIER_FIELDS } from '../src/intake/pii.mjs';
import { prohibitedKeys, validateMappedEvents } from '../src/intake/validate.mjs';
import { generateBehavioralDataset } from '../src/synthetic/behavioral-generate.mjs';

// Intake validate (intake-validate-0.1.0): the CLI and the upload path (src/lib/ingestion.ts)
// must reject the same PII headers. Node strips the TypeScript types, so the test can call
// parseTokenizedCsv itself.

const ingestionSource = await readFile(new URL('../src/lib/ingestion.ts', import.meta.url), 'utf8');
const { normalizeHeader, parseTokenizedCsv } = await import('../src/lib/ingestion.ts');

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

// Each path's verdict on one header: the upload path (parseTokenizedCsv), the engine
// (validateEvents), and intake (prohibitedKeys).
function uploadRejects(header) {
  try {
    parseTokenizedCsv(`${[...REQUIRED_FIELDS, header].join(',')}\n`);
    return false;
  } catch (error) {
    return /Direct PII fields are prohibited/.test(error.message);
  }
}

function engineRejects(header) {
  const event = { event_id: 'e1', trader_token: 't1', occurred_at: '2026-01-01T00:00:00Z', type: 'trade', venue_id: 'v1', source_row_number: 1, [header]: 'x' };
  return validateEvents([event]).errors.some((error) => /prohibited field/.test(error));
}

function intakeRejects(header) {
  return prohibitedKeys([{ [header]: 'x' }]).length > 0;
}

// Spaced, cased, and padded variants of a listed name, which validate.mjs's normalizeField
// (trim, lowercase, whitespace to "_") maps back to it.
function spacedVariants(field) {
  const words = field.split('_');
  const title = words.map((word) => word[0].toUpperCase() + word.slice(1));
  return [
    field.toUpperCase(),
    words.join(' '),
    title.join(' '),
    words.join(' ').toUpperCase(),
    words.join('  '),
    words.join('\t'),
    `  ${title.join(' ')}  `,
    `\t${field}`
  ];
}

test('ingestion.ts normalizes headers the way validate.mjs does', () => {
  assert.equal(normalizeHeader('  Email   Address '), 'email_address');
  assert.equal(normalizeHeader('Date\tOf Birth'), 'date_of_birth');
  for (const field of PROHIBITED_FIELDS) {
    for (const variant of [field, ...spacedVariants(field)]) assert.equal(normalizeHeader(variant), field, JSON.stringify(variant));
  }
  // Required columns still need their exact names: normalizing never loosens that check.
  const spacedRequired = REQUIRED_FIELDS.map((field) => (field === 'event_id' ? 'Event ID' : field));
  assert.throws(() => parseTokenizedCsv(`${spacedRequired.join(',')}\n`), /Required columns are missing: event_id/);
});

test('the upload path, the engine, and intake reject the same headers, spaced variants included', () => {
  const candidates = [
    ...PROHIBITED_FIELDS,
    ...[...PROHIBITED_FIELDS].flatMap(spacedVariants),
    'Email', ' Phone ', 'Email Address', 'IP Address', 'Customer Name', 'Full Name',
    // Not PII: every path accepts these.
    'market_name', 'stake_amount', 'channel', 'Stake Amount', 'Account Ref', 'trader token'
  ];
  for (const header of candidates) {
    const verdicts = { upload: uploadRejects(header), engine: engineRejects(header), intake: intakeRejects(header) };
    assert.ok(verdicts.upload === verdicts.engine && verdicts.engine === verdicts.intake, `${JSON.stringify(header)}: ${JSON.stringify(verdicts)}`);
  }
  for (const header of ['Email Address', 'EMAIL ADDRESS', 'Date of Birth', 'ip address', ' Full  Name ']) assert.ok(uploadRejects(header), header);
});

test('intake stays a superset: camelCase and punctuation variants only intake rejects', () => {
  // intake's prohibitedFieldFor also splits camelCase and maps punctuation to "_" (pii.mjs
  // snakeHeader); the upload path and the engine don't. Never the other way round.
  for (const header of ['EmailAddress', 'email-address', 'Email.Address', 'dateOfBirth', 'ipAddress']) {
    assert.equal(intakeRejects(header), true, header);
    assert.equal(uploadRejects(header), false, header);
    assert.equal(engineRejects(header), false, header);
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
