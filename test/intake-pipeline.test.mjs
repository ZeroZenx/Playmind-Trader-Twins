import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLedgerFixture, buildPiiFixture, FIXTURE_VERSION, ledgerFixtureFromDataset } from '../src/intake/fixture.mjs';
import { CUSTOMER_REMINDER, isInside, loadMappingConfig, resolveOutputDirectory, runIntakePipeline } from '../src/intake/pipeline.mjs';
import { generateBehavioralDataset } from '../src/synthetic/behavioral-generate.mjs';

// The intake pipeline end to end (intake-0.1.0) on the SYNTHETIC ledger fixture, at a small
// scale. The real run is npm run intake -- run (docs/SPORTTRADE_INTAKE.md).

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixtures = join(repo, 'test', 'fixtures', 'intake');
const configPath = join(fixtures, 'ledger-mapping.json');
const SALT = 'test-salt-not-a-secret-0001';
const SMALL = ['--holdout-replicates', '3', '--sweep-replicates', '2', '--policies', 'stake_limit', '--horizon-days', '7'];
const fixture = buildLedgerFixture();

function saltedEnv(salt = SALT) {
  return { ...process.env, PLAYMIND_TOKEN_SALT: salt };
}

function cli(args, env = saltedEnv()) {
  return spawnSync(process.execPath, ['scripts/intake.mjs', ...args], { cwd: repo, env, encoding: 'utf8' });
}

/** Repo state outside ignored folders, plus everything under data/ (ignored but watched). */
async function repoSnapshot() {
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repo, encoding: 'utf8' });
  const listing = [];
  const walk = async (directory) => {
    if (!existsSync(directory)) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else listing.push(`${path}:${(await stat(path)).mtimeMs}`);
    }
  };
  await walk(join(repo, 'data'));
  return { status, data: listing.sort() };
}

test('the committed fixtures are SYNTHETIC, small, and rebuild exactly from the generator', async () => {
  const committed = (await readFile(join(fixtures, 'ledger-export.csv'), 'utf8')).replace(/\r\n/g, '\n');
  assert.equal(committed, fixture.csv, 'rebuild with: node scripts/build-intake-fixtures.mjs');
  assert.equal((await readFile(join(fixtures, 'ledger-export-pii.csv'), 'utf8')).replace(/\r\n/g, '\n'), buildPiiFixture().csv);
  assert.match(committed.split('\n')[0], /^# SYNTHETIC test fixture/);
  assert.ok(committed.includes(FIXTURE_VERSION));
  assert.ok(Buffer.byteLength(committed) < 1024 * 1024, 'well under 1 MB');
  const header = committed.split('\n')[1];
  assert.doesNotMatch(header, /market|contract|balance/i, 'no market or balance fields');
  const { config } = await loadMappingConfig(configPath);
  assert.equal(config.label, 'SYNTHETIC');
});

test('run: the full pipeline on the fixture into a temp dir', async () => {
  const out = await mkdtemp(join(tmpdir(), 'playmind-intake-run-'));
  const before = await repoSnapshot();
  try {
    const result = cli(['run', '--config', configPath, '--label', 'SYNTHETIC', '--out', out, ...SMALL]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\[SYNTHETIC\] run fixture-ledger: complete/);
    assert.match(result.stdout, /runtime \d+\.\d s/);
    assert.match(result.stdout, /all-cause/);

    const files = (await readdir(out)).sort();
    assert.deepEqual(files, ['events.json', 'map-report.json', 'profile.json', 'readiness.json', 'readiness.md', 'report-v2.html', 'report-v2.json', 'run-summary.json', 'validation.json']);
    const contents = Object.fromEntries(await Promise.all(files.map(async (file) => [file, await readFile(join(out, file), 'utf8')])));

    // Every output carries the label.
    for (const [file, text] of Object.entries(contents)) {
      if (file.endsWith('.json')) {
        const document = JSON.parse(text);
        assert.equal(document.label ?? document.dataLabel, 'SYNTHETIC', file);
      } else {
        assert.match(text, /SYNTHETIC/, file);
      }
    }
    const report = JSON.parse(contents['report-v2.json']);
    assert.equal(report.dataLabel, 'SYNTHETIC');
    assert.match(report.banner, /SYNTHETIC/);
    assert.match(contents['report-v2.html'], /SYNTHETIC DATA: NOT A REAL VENUE OR TRADER/);

    // No raw account ID (or source entry ID) in any output file.
    for (const [file, text] of Object.entries(contents)) {
      for (const id of [...fixture.rawAccountIds, ...fixture.rawEntryIds]) assert.ok(!text.includes(id), `${file} holds a raw ID`);
      assert.ok(!text.includes(SALT), `${file} holds the salt`);
    }
    assert.ok(!result.stdout.includes('ACCT-') && !result.stderr.includes('ACCT-'));

    // The no-balance path, labelled through to the report.
    const summary = JSON.parse(contents['run-summary.json']);
    assert.deepEqual(Object.keys(summary.stopHazardBasis), ['all-cause']);
    assert.match(summary.holdout.balancePath, /no balance fields/);
    assert.ok(summary.holdout.eligible > 0, 'the fixture gives holdout some eligible traders');
    assert.match(report.sections.data.statement, /all-cause/);
    assert.match(report.sections.data.statement, /losing-streak proxy/);
    assert.ok(report.sections.assumptions.plain.some((line) => /losing-streak proxy/.test(line)));
    const estimability = Object.fromEntries(report.sections.data.estimability.map((row) => [row.parameter, row.status]));
    const readiness = JSON.parse(contents['readiness.json']);
    for (const item of readiness.parameters.filter((entry) => entry.status === 'not estimable')) assert.equal(estimability[item.name], 'not estimable', item.name);
    const reportCoverage = Object.fromEntries(report.sections.data.fieldCoverage.map((row) => [row.field, row.appliesTo]));
    for (const row of readiness.fieldCoverage.fields) if (reportCoverage[row.field]) assert.equal(row.appliesTo, reportCoverage[row.field], row.field);
    const events = JSON.parse(contents['events.json']);
    assert.equal(events.eventCount, fixture.dataset.events.length);
    assert.ok(events.events.every((event) => /^tr_[0-9a-f]{16}$/.test(event.trader_token) && /^ev_[0-9a-f]{20}$/.test(event.event_id)));
    assert.ok(!/\bAUC\b|AUROC/i.test(Object.values(contents).join('\n')));
  } finally {
    await rm(out, { recursive: true, force: true });
  }
  assert.deepEqual(await repoSnapshot(), before, 'nothing was written under the repo');
});

test('the CLI refuses to write outside data/ without --out', async () => {
  const before = await repoSnapshot();
  for (const name of ['../escape', '..', '../../escape', 'a/b', 'C:\\escape']) {
    const result = cli(['run', '--config', configPath, '--label', 'SYNTHETIC', '--name', name, ...SMALL]);
    assert.equal(result.status, 1, name);
    assert.match(result.stderr, /Refusing to write outside data\//, name);
  }
  const profile = cli(['profile', join(fixtures, 'ledger-export.csv'), '--label', 'SYNTHETIC', '--name', '../escape']);
  assert.equal(profile.status, 1);
  assert.ok(!existsSync(join(repo, 'escape')) && !existsSync(join(repo, 'data', 'escape')));
  assert.deepEqual(await repoSnapshot(), before);

  // Default location: data/output/<name>/ under the repo. Explicit --out goes where it says.
  assert.equal(resolveOutputDirectory({ name: 'fixture-ledger', label: 'SYNTHETIC', repoRoot: repo }), join(repo, 'data', 'output', 'fixture-ledger'));
  assert.ok(isInside(resolveOutputDirectory({ name: 'x', label: 'CUSTOMER', repoRoot: repo }), join(repo, 'data')));
  const elsewhere = join(tmpdir(), 'anywhere');
  assert.equal(resolveOutputDirectory({ name: '../x', out: elsewhere, label: 'SYNTHETIC', repoRoot: repo }), resolve(elsewhere));
  assert.throws(() => resolveOutputDirectory({ out: join(repo, 'docs'), label: 'CUSTOMER', repoRoot: repo }), /CUSTOMER outputs inside the repo/);
});

test('labels: --label is required, must match the config, and CUSTOMER prints the reminder', async () => {
  const missing = cli(['run', '--config', configPath, ...SMALL]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /--label is required/);
  const mismatch = cli(['map', '--config', configPath, '--label', 'CUSTOMER', '--out', join(tmpdir(), 'never-used')]);
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stdout, /\[CUSTOMER\] CUSTOMER data: every output of this run is customer-derived/);
  // The fixture's config lives in the repo outside data/, so a CUSTOMER run is refused before
  // anything is read or written.
  assert.match(mismatch.stderr, /mapping config is inside the repo but outside data\//);
  assert.match(CUSTOMER_REMINDER, /Keep it under data\//);
});

test('small or short histories: holdout finds few eligible traders and the report still renders', () => {
  for (const [traderCount, sessionsPerTrader] of [[1, 2], [3, { min: 2, max: 4 }], [6, { min: 4, max: 8 }]]) {
    const dataset = generateBehavioralDataset({ seed: 900 + traderCount, mode: 'population', traderCount, sessionsPerTrader, includeBalances: false, missingOutcomeShare: 0.1 });
    const small = ledgerFixtureFromDataset(dataset, { artifacts: false });
    const raw = JSON.parse(JSON.stringify({ name: 'short', label: 'CUSTOMER', venueId: 'v', trader: { column: 'account_ref' }, eventId: { column: 'entry_id' }, timestamp: { column: 'posted_at_utc', timezone: 'UTC' }, eventType: { column: 'entry_type', values: { BET: 'trade', DEPOSIT: 'deposit' }, ignore: ['FEE'] }, fields: { stake_amount: { column: 'stake_cents', units: 'cents' }, deposit_amount: { column: 'amount_cents', units: 'cents', appliesTo: ['deposit'] }, realized_result: { mode: 'split', gainColumn: 'settle_credit_cents', lossColumn: 'settle_debit_cents', units: 'cents' } } }));
    const result = runIntakePipeline({ text: small.csv, fileName: 'short.csv', config: raw, salt: SALT, label: 'CUSTOMER', options: { holdoutReplicates: 2, sweepReplicates: 2, policies: ['cooldown'], horizonDays: 3 } });
    assert.equal(result.status, 'complete', `${traderCount} traders`);
    assert.ok(result.summary.holdout.eligible <= traderCount);
    assert.match(result.outputs['report-v2.html'], /^<!doctype html>/i);
    assert.match(result.outputs['report-v2.html'], /CUSTOMER DATA: CONFIDENTIAL, KEEP OUT OF THE REPO/);
    assert.equal(result.summary.customerReminder, CUSTOMER_REMINDER);
    for (const id of small.rawAccountIds) assert.ok(!JSON.stringify(result.outputs).includes(id));
  }
});

test('invalid mapped events stop the run after validation', () => {
  const csv = ['entry_id,account_ref,posted_at_utc,entry_type,stake_cents', 'E1,ACCT-00000001,2026-07-01 12:00:00,BET,-500', 'E2,ACCT-00000001,2026-07-01 12:01:00,BET,500'].join('\n');
  const config = { name: 'bad', venueId: 'v', trader: { column: 'account_ref' }, eventId: { column: 'entry_id' }, timestamp: { column: 'posted_at_utc', timezone: 'UTC' }, eventType: { column: 'entry_type', values: { BET: 'trade' } }, fields: { stake_amount: { column: 'stake_cents', units: 'cents' } } };
  const result = runIntakePipeline({ text: csv, fileName: 'bad.csv', config, salt: SALT, label: 'SYNTHETIC' });
  assert.equal(result.status, 'invalid');
  assert.deepEqual(Object.keys(result.outputs).sort(), ['events.json', 'map-report.json', 'profile.json', 'run-summary.json', 'validation.json']);
  assert.match(result.outputs['validation.json'].errors.join(' '), /stake_amount cannot be negative/);
});
