/**
 * Rebuilds the SYNTHETIC intake fixtures in test/fixtures/intake/ from the behavioral
 * generator (src/intake/fixture.mjs):
 *
 *   node scripts/build-intake-fixtures.mjs
 *
 * Every value is synthetic: generated accounts, times, and amounts. No customer data.
 * test/intake-fixture.test.mjs checks the committed files equal a fresh build.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLedgerFixture, buildPiiFixture, FIXTURE_VERSION } from '../src/intake/fixture.mjs';

const directory = fileURLToPath(new URL('../test/fixtures/intake/', import.meta.url));
await mkdir(directory, { recursive: true });
const ledger = buildLedgerFixture();
const pii = buildPiiFixture();
await writeFile(join(directory, 'ledger-export.csv'), ledger.csv);
await writeFile(join(directory, 'ledger-export-pii.csv'), pii.csv);
console.log(JSON.stringify({
  label: 'SYNTHETIC',
  fixtureVersion: FIXTURE_VERSION,
  files: ['ledger-export.csv', 'ledger-export-pii.csv'],
  ledgerBytes: Buffer.byteLength(ledger.csv),
  expected: ledger.expected
}, null, 2));
