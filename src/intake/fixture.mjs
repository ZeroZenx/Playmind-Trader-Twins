/**
 * SYNTHETIC intake fixtures, version intake-fixture-0.1.0.
 *
 * Builds the files in test/fixtures/intake/ from the behavioral generator, so they are
 * reproducible: scripts/build-intake-fixtures.mjs writes them, and test/intake-fixture.test.mjs
 * checks the committed files equal a fresh build. Every value is synthetic.
 *
 * ledger-export.csv is shaped like a plausible exchange ledger export: generic column names that
 * differ from the analytical schema, amounts in cents, UTC timestamps without an offset, no
 * market or contract fields, no balance fields, some missing realized results (both settlement
 * columns blank), a raw account ID column, and dump artifacts (a comment line before the
 * header, blank rows, an exact duplicate row, mixed-case and padded type values, FEE rows the
 * mapping ignores, and extra columns the mapping leaves out).
 *
 * ledger-export-pii.csv is deliberately bad: an email header, and email-shaped values under a
 * generic header. Profile must flag both without printing a value; map must reject them.
 *
 * Pure: no I/O.
 */

import { BEHAVIORAL_GENERATOR_VERSION, generateBehavioralDataset } from '../synthetic/behavioral-generate.mjs';

export const FIXTURE_VERSION = 'intake-fixture-0.1.0';
export const LEDGER_FIXTURE_OPTIONS = Object.freeze({
  seed: 20261113,
  traderCount: 24,
  sessionsPerTrader: Object.freeze({ min: 14, max: 22 }),
  missingOutcomeShare: 0.06
});
export const LEDGER_COLUMNS = Object.freeze(['entry_id', 'account_ref', 'posted_at_utc', 'entry_type', 'stake_cents', 'amount_cents', 'settle_credit_cents', 'settle_debit_cents', 'channel', 'currency']);
export const PII_COLUMNS = Object.freeze(['entry_id', 'account_ref', 'posted_at_utc', 'entry_type', 'stake_cents', 'amount_cents', 'contact', 'Email Address']);

const TRADE_SPELLINGS = Object.freeze(['BET', 'BET', 'bet', 'BET', ' Bet ', 'BET', 'Bet']);
const DEPOSIT_SPELLINGS = Object.freeze(['DEPOSIT', 'Deposit', 'deposit ']);
const CHANNELS = Object.freeze(['web', 'ios', 'android']);
const BLANK_AFTER = Object.freeze([37, 900]);
const DUPLICATE_ROW = 120;
const FEE_EVERY = 450;

function header(file, seed) {
  return `# SYNTHETIC test fixture (${FIXTURE_VERSION}, ${file}): a made-up exchange ledger export built by scripts/build-intake-fixtures.mjs from the behavioral generator (${BEHAVIORAL_GENERATOR_VERSION} seed ${seed}). Not customer data. No real account or venue.`;
}

/** A raw-looking account ID per generator trader: ACCT- plus 8 digits, all distinct. */
export function rawAccountId(index) {
  return `ACCT-${String(10000000 + (((index + 1) * 7368787) % 89999999)).padStart(8, '0')}`;
}

function entryId(position) {
  return `LDG-${String(position).padStart(9, '0')}`;
}

function cents(amount) {
  return Math.round(amount * 100);
}

function timestamp(iso) {
  return iso.slice(0, 19).replace('T', ' ');
}

function csvLine(cells) {
  return cells.map((cell) => {
    const text = String(cell);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }).join(',');
}

/**
 * The ledger CSV for any behavioral dataset (without balances), in the fixture's shape.
 * artifacts: false leaves out the blank rows, the duplicate row, and the FEE rows.
 * Returns { csv, rawAccountIds, rawEntryIds, expected }.
 */
export function ledgerFixtureFromDataset(dataset, { file = 'ledger-export.csv', seed = dataset.truth.seed, artifacts = true } = {}) {
  const indexByToken = new Map(dataset.truth.traders.map((trader, index) => [trader.traderToken, index]));
  const accountFor = (token) => rawAccountId(indexByToken.get(token));
  const accounts = new Set(dataset.truth.traders.map((trader) => accountFor(trader.traderToken)));
  if (accounts.size !== dataset.truth.traders.length) throw new Error('buildLedgerFixture: raw account IDs collide');

  const lines = [header(file, seed), csvLine(LEDGER_COLUMNS)];
  const rawEntryIds = [];
  let position = 0;
  let fees = 0;
  let missingResults = 0;
  let trades = 0;
  let deposits = 0;
  dataset.events.forEach((event, eventIndex) => {
    position += 1;
    const id = entryId(position);
    rawEntryIds.push(id);
    const channel = CHANNELS[(eventIndex * 7) % CHANNELS.length];
    let cells;
    if (event.type === 'trade') {
      trades += 1;
      const result = event.realized_result;
      let credit = '';
      let debit = '';
      if (result === null) missingResults += 1;
      else if (result > 0) credit = cents(result);
      else if (result < 0) debit = cents(-result);
      else {
        credit = 0;
        debit = 0;
      }
      cells = [id, accountFor(event.trader_token), timestamp(event.occurred_at), TRADE_SPELLINGS[eventIndex % TRADE_SPELLINGS.length], cents(event.stake_amount), '', credit, debit, channel, 'USD'];
    } else {
      deposits += 1;
      cells = [id, accountFor(event.trader_token), timestamp(event.occurred_at), DEPOSIT_SPELLINGS[eventIndex % DEPOSIT_SPELLINGS.length], '', cents(event.deposit_amount), '', '', channel, 'USD'];
    }
    lines.push(csvLine(cells));
    if (!artifacts) return;
    if (position === DUPLICATE_ROW) lines.push(csvLine(cells));
    if (BLANK_AFTER.includes(position)) lines.push(position === BLANK_AFTER[0] ? '' : csvLine(LEDGER_COLUMNS.map(() => '')));
    if (position % FEE_EVERY === 0) {
      position += 1;
      fees += 1;
      const feeId = entryId(position);
      rawEntryIds.push(feeId);
      lines.push(csvLine([feeId, accountFor(event.trader_token), timestamp(event.occurred_at), 'FEE', '', 25, '', '', channel, 'USD']));
    }
  });
  return {
    csv: `${lines.join('\n')}\n`,
    rawAccountIds: [...accounts].sort(),
    rawEntryIds,
    expected: {
      trades,
      deposits,
      fees,
      blankRows: artifacts ? BLANK_AFTER.filter((row) => row <= position).length : 0,
      duplicateRows: artifacts && position >= DUPLICATE_ROW ? 1 : 0,
      missingResults,
      traders: accounts.size
    }
  };
}

/**
 * Returns { csv, rawAccountIds, rawEntryIds, dataset, expected } for ledger-export.csv. expected
 * counts what map should produce: trades, deposits, ignored FEE rows, blank rows, duplicate rows,
 * and trades with no realized result.
 */
export function buildLedgerFixture() {
  const options = LEDGER_FIXTURE_OPTIONS;
  const dataset = generateBehavioralDataset({
    seed: options.seed,
    name: 'intake-ledger-fixture',
    mode: 'population',
    traderCount: options.traderCount,
    sessionsPerTrader: { ...options.sessionsPerTrader },
    includeBalances: false,
    missingOutcomeShare: options.missingOutcomeShare
  });
  return { ...ledgerFixtureFromDataset(dataset, { file: 'ledger-export.csv', seed: options.seed }), dataset };
}

/** A small, deliberately bad export: an email header and email-shaped values under "contact". */
export function buildPiiFixture() {
  const seed = 20261114;
  const dataset = generateBehavioralDataset({ seed, name: 'intake-pii-fixture', mode: 'population', traderCount: 3, sessionsPerTrader: 3, includeBalances: false });
  const indexByToken = new Map(dataset.truth.traders.map((trader, index) => [trader.traderToken, index]));
  const lines = [header('ledger-export-pii.csv', seed), csvLine(PII_COLUMNS)];
  const rawValues = new Set();
  dataset.events.slice(0, 40).forEach((event, index) => {
    const traderIndex = indexByToken.get(event.trader_token);
    const account = rawAccountId(traderIndex + 50);
    const contact = `synthetic.trader${traderIndex + 1}@example.invalid`;
    const email = `fixture${traderIndex + 1}.user@example.invalid`;
    rawValues.add(account).add(contact).add(email);
    const trade = event.type === 'trade';
    lines.push(csvLine([
      entryId(index + 1), account, timestamp(event.occurred_at), trade ? 'BET' : 'DEPOSIT',
      trade ? cents(event.stake_amount) : '', trade ? '' : cents(event.deposit_amount), contact, email
    ]));
  });
  return { csv: `${lines.join('\n')}\n`, rawValues: [...rawValues].sort() };
}
