import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLedgerFixture, buildPiiFixture } from '../src/intake/fixture.mjs';
import { classifyColumn, classifyHeader, maskValue } from '../src/intake/pii.mjs';
import { profileSource, renderProfileText } from '../src/intake/profile.mjs';
import { parseSource } from '../src/intake/source.mjs';

// Intake profile (intake-profile-0.1.0): describes a raw export without ever showing a raw
// identifier or PII-looking value. Fixtures are SYNTHETIC (test/fixtures/intake/).

const repo = fileURLToPath(new URL('..', import.meta.url));
const fixtures = join(repo, 'test', 'fixtures', 'intake');
const ledgerText = await readFile(join(fixtures, 'ledger-export.csv'), 'utf8');
const piiText = await readFile(join(fixtures, 'ledger-export-pii.csv'), 'utf8');
const ledger = buildLedgerFixture();
const pii = buildPiiFixture();

function profileOf(text, fileName, showCategories = true) {
  const profile = profileSource(parseSource(text, { fileName }), { label: 'SYNTHETIC', sourceName: fileName, showCategories });
  return { profile, output: `${JSON.stringify(profile)}\n${renderProfileText(profile)}` };
}

function cellsOf(text, column) {
  const parsed = parseSource(text, { fileName: 'x.csv' });
  const index = parsed.headers.indexOf(column);
  return [...new Set(parsed.rows.map((row) => row.cells[index].trim()).filter(Boolean))];
}

function assertNoRawValue(output, values, what) {
  for (const value of values) {
    assert.ok(!output.includes(value), `${what}: a raw value appears in the output`);
    for (const digits of value.match(/\d{6,}/g) ?? []) assert.ok(!output.includes(digits), `${what}: a raw digit run appears in the output`);
  }
}

test('profile never prints a raw account ID, entry ID, or PII-looking value from the fixtures', () => {
  const { output } = profileOf(ledgerText, 'ledger-export.csv');
  const accounts = cellsOf(ledgerText, 'account_ref');
  const entries = cellsOf(ledgerText, 'entry_id');
  assert.equal(accounts.length, 24);
  assert.deepEqual(accounts.sort(), ledger.rawAccountIds);
  assert.ok(entries.length > 2000);
  assertNoRawValue(output, accounts, 'account_ref');
  assertNoRawValue(output, entries, 'entry_id');

  const bad = profileOf(piiText, 'ledger-export-pii.csv').output;
  const piiValues = [...cellsOf(piiText, 'account_ref'), ...cellsOf(piiText, 'contact'), ...cellsOf(piiText, 'Email Address')];
  assert.deepEqual([...new Set(piiValues)].sort(), pii.rawValues);
  assertNoRawValue(bad, piiValues, 'PII fixture');
  for (const value of cellsOf(piiText, 'contact')) {
    assert.ok(!bad.includes(value.split('@')[0]), 'no local part of an email');
  }
  assert.ok(!bad.includes('example.invalid'), 'no email domain');
});

test('the CLI profile prints and writes no raw value', async () => {
  const out = await mkdtemp(join(tmpdir(), 'playmind-intake-profile-'));
  try {
    for (const [file, values] of [['ledger-export.csv', [...ledger.rawAccountIds, ...ledger.rawEntryIds]], ['ledger-export-pii.csv', pii.rawValues]]) {
      const result = spawnSync(process.execPath, ['scripts/intake.mjs', 'profile', join(fixtures, file), '--label', 'SYNTHETIC', '--categories', '--out', out], { cwd: repo, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      const written = await readFile(join(out, 'profile.json'), 'utf8');
      assertNoRawValue(`${result.stdout}\n${result.stderr}\n${written}`, values, file);
      assert.match(result.stdout, /\[SYNTHETIC\]/);
      assert.equal(JSON.parse(written).label, 'SYNTHETIC');
    }
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test('profile reports columns, types, null rates, row count, date range, and dump artifacts', () => {
  const { profile } = profileOf(ledgerText, 'ledger-export.csv');
  const byName = Object.fromEntries(profile.columns.map((column) => [column.column, column]));
  assert.equal(profile.label, 'SYNTHETIC');
  assert.equal(profile.preambleLines, 1, 'the SYNTHETIC comment line before the header');
  assert.equal(profile.blankRows, ledger.expected.blankRows);
  assert.equal(profile.exactDuplicateRows, ledger.expected.duplicateRows);
  assert.equal(profile.rowCount, ledger.expected.trades + ledger.expected.deposits + ledger.expected.fees + ledger.expected.duplicateRows);
  assert.equal(byName.posted_at_utc.inferredType, 'timestamp');
  assert.equal(byName.stake_cents.inferredType, 'integer');
  assert.match(byName.stake_cents.numeric.hint, /cents/);
  assert.ok(byName.amount_cents.nullRate > 0.9);
  assert.equal(byName.entry_type.valuesWithStrayWhitespace > 0, true);
  assert.deepEqual(byName.account_ref.shapes, [{ shape: 'AAAA-99999999', count: profile.rowCount }]);
  assert.ok(profile.dateRange.start.startsWith('2026-03-02'));
  assert.ok(profile.dateRange.end > profile.dateRange.start);
  // Categories are opt-in, and never shown for a flagged column or a rare value.
  assert.equal(byName.account_ref.categories.shown, false);
  assert.ok(byName.entry_type.categories.values.some((item) => item.value === 'BET'));
  assert.ok(!byName.entry_type.categories.values.some((item) => item.value === 'FEE'), 'FEE occurs fewer than 5 times');
  assert.equal(profileOf(ledgerText, 'ledger-export.csv', false).profile.columns[3].categories, undefined);
});

test('profile flags PII and raw identifiers by header and by value shape', () => {
  const { profile } = profileOf(piiText, 'ledger-export-pii.csv');
  const byName = Object.fromEntries(profile.columns.map((column) => [column.column, column]));
  assert.equal(byName['Email Address'].pii, true, 'email header');
  assert.equal(byName.contact.pii, true, 'email-shaped values under a generic header');
  assert.match(byName.contact.flags.join(' '), /email-shaped/);
  assert.deepEqual(byName.contact.shapes, { hidden: 'PII-flagged column: shapes are not shown' });
  assert.equal(byName.account_ref.rawIdentifier, true);
  assert.equal(byName.account_ref.pii, false, 'a raw account ID is tokenized, not rejected');
  assert.deepEqual(profile.flaggedColumns.map((item) => item.column).sort(), ['Email Address', 'account_ref', 'contact', 'entry_id'].sort());
});

test('header and value rules', () => {
  for (const header of ['email', 'E-mail', 'EmailAddress', 'phone_number', 'Mobile', 'date_of_birth', 'DOB', 'first_name', 'Full Name', 'username', 'ip', 'IPAddress', 'street_address', 'passport_no', 'device_fingerprint', 'name']) {
    assert.ok(classifyHeader(header).pii, `${header} is PII`);
  }
  for (const header of ['account_id', 'customer_id', 'unmasked_account_id', 'acctNo', 'player_ref', 'user_id']) {
    const result = classifyHeader(header);
    assert.equal(result.pii, null, `${header} is an identifier, not direct PII`);
    assert.equal(result.personIdentifier, true, `${header} names an account or person`);
  }
  for (const header of ['market_name', 'stake_cents', 'posted_at', 'entry_type', 'contract_name']) assert.equal(classifyHeader(header).pii, null, header);
  assert.equal(classifyColumn('ref2', ['+1 (555) 010-2030', '+1 555 010 4455', '555-010-9988 x']).pii, true, 'phone-shaped');
  assert.equal(classifyColumn('origin', ['10.0.0.1', '192.168.1.20']).pii, true, 'IP-shaped');
  const names = ['Avery Stone', 'Jordan Blake', 'Riley Quinn', 'Casey Moore', 'Morgan Hale', 'Taylor Reed', 'Jamie Cole', 'Drew Lane', 'Parker Ash', 'Rowan Gale', 'Sage Holt'];
  assert.equal(classifyColumn('holder', names).pii, true, 'person-name-shaped');
  assert.equal(classifyColumn('amount', ['12345678.90', '1250.00']).pii, false, 'large decimals are not phones');
  assert.equal(classifyColumn('ts', ['1767225600', '1767225700'], { timestampColumn: true }).identifierShape, false);
  assert.equal(maskValue('AC-4021-xy'), 'AA-9999-AA');
  assert.equal(maskValue('x'.repeat(40)), `${'A'.repeat(32)}…(40 chars)`);
});

test('profile handles a column larger than the call stack allows to spread (Prompt 9 scale run)', () => {
  // The 2,000-trader dry run (700k rows) overflowed the stack in Math.min(...lengths). 300k
  // values is past what one spread call takes on default Node settings.
  const rows = 300000;
  const lines = ['code,amount'];
  for (let index = 0; index < rows; index += 1) lines.push(`${index % 7 === 0 ? 'AB' : 'ABCD'},${index % 1000}`);
  const profile = profileSource(parseSource(lines.join('\n'), { fileName: 'large.csv' }), { label: 'SYNTHETIC', sourceName: 'large.csv' });
  assert.equal(profile.rowCount, rows);
  assert.deepEqual(profile.columns[0].length, { min: 2, max: 4 });
  assert.deepEqual(profile.columns[1].length, { min: 1, max: 3 });
});
