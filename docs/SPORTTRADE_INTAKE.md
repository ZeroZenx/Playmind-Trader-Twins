# Sporttrade intake

How to take Sporttrade's historical export from a raw file to a twin evidence report, which fields we need, and what we still have to ask them. The pipeline is `npm run intake` (`scripts/intake.mjs`, version `intake-0.2.0`). Its logic is in `src/intake/`, and the decisions behind it are in ADR-016 and ADR-017 (`docs/DECISIONS.md`).

The file is CUSTOMER data. It, the mapping config written for it, and every output stay under `data/` (gitignored) or outside the repo. Nothing in this repo holds a Sporttrade value, field list with real values, or result.

## When the file arrives

1. **Put the file under `data/`**, for example `data/sporttrade/raw/export.csv`. Never anywhere else in the repo. CUSTOMER runs refuse an input, config, or output directory that is inside the repo but outside `data/`.
2. **Set the salt.** Put a long random value in a local, uncommitted `.env`:
   ```
   PLAYMIND_TOKEN_SALT=<at least 16 random characters>
   ```
   or set it in the shell for the session (`npm run intake` then prints `.env not found. Continuing without it.`, which is expected):
   ```
   # bash
   export PLAYMIND_TOKEN_SALT='<the salt>'
   # PowerShell
   $env:PLAYMIND_TOKEN_SALT = '<the salt>'
   ```
   `npm run intake` loads `.env` if there is one; a value already set in the shell wins. Without the salt, `map` and `run` refuse to start. There is no default. Keep the same salt for every run on Sporttrade data, or the tokens won't line up across runs. Store it the way we store other secrets, never in the repo, a ticket, or a chat.
3. **Profile first.**
   ```
   npm run intake -- profile data/sporttrade/raw/export.csv --label CUSTOMER --categories --name sporttrade-v1
   ```
   This prints and writes (to `data/output/sporttrade-v1/profile.json`; without `--name`, to `data/output/profile-export/`) the columns, inferred types, null rates, row count, date range, masked value shapes (`AAAA-99999999`), lengths, character classes, blank and duplicate rows, and flags for columns that look like PII or raw identifiers. It never prints a raw value. `--categories` shows the distinct values of low-cardinality, unflagged columns (for example event-type codes) when each value occurs at least 5 times and has no digit run or `@`.
4. **Write the mapping config under `data/`**, for example `data/sporttrade/mapping.json`. Start from a copy of `test/fixtures/intake/ledger-mapping.json`, and change three keys before anything else: `"name": "sporttrade-v1"`, `"label": "CUSTOMER"`, and `"input": "raw/export.csv"` (`input` is read relative to the config file). A copy that still says `SYNTHETIC` or points at the fixture's file name stops with a message saying which. The reference is below. Use the profile to pick the columns, the units (whole numbers usually mean cents), and the type values.
5. **Map, then validate and check readiness.**
   ```
   npm run intake -- map --config data/sporttrade/mapping.json --label CUSTOMER --name sporttrade-v1
   npm run intake -- validate --label CUSTOMER --name sporttrade-v1
   npm run intake -- readiness --label CUSTOMER --name sporttrade-v1
   ```
   `map` writes `events.json` (tokenized) and `map-report.json`: every row dropped or fixed, by reason and count, never by content, plus the unmapped columns by name. `validate` runs the engine's `validateEvents` and the PII-header rule. `readiness` writes `readiness.json` and `readiness.md`: which signals and parameters are estimable, which are not and why, which fields would unlock each, field coverage, and how many traders have enough history for held-out validation. That file is the ask list for Sporttrade.
6. **Run end to end.** A quick look first, then the full run:
   ```
   npm run intake -- run --config data/sporttrade/mapping.json --label CUSTOMER --name sporttrade-v1-quick --traders 200 --holdout-replicates 10 --sweep-replicates 8 --policies stake_limit,cooldown
   npm run intake -- run --config data/sporttrade/mapping.json --label CUSTOMER --name sporttrade-v1
   ```
   The quick look gets its own name, so its 200-trader `events.json` doesn't replace the one from step 5. `run` goes profile, map, validate, readiness, fit (`estimateTwins`), held-out validation (`runHoldoutValidation`), policy sweep (`runPolicySweep`), and report v2. It writes everything to `data/output/<name>/`, prints each step as it starts (to stderr, with the elapsed time), and ends with a short summary and the runtime. It stops after validation if the mapped events are invalid.

   **Scale.** In the Prompt 9 dry run, a SYNTHETIC ledger of about 700,000 rows and 2,000 traders with no balances took about half an hour for the full run on a 10-core laptop, and peaked at about 3 GB of memory. The policy sweep took most of that time and the held-out validation most of the rest; profile through fit took about a minute. On a larger file, check the quick look's runtime first, and raise Node's heap before the full run (`export NODE_OPTIONS=--max-old-space-size=8192` in bash, `$env:NODE_OPTIONS = '--max-old-space-size=8192'` in PowerShell). Without that, Node stops at its default heap limit, about 4 GB on that laptop. `events.json` is large (about 300 bytes per event).
7. **Before sharing anything**, read the report as a customer-derived document: it is confidential, it carries the CUSTOMER banner, and it shares only under the customer agreement. No number from it goes into the repo, a commit message, or the README.

On the synthetic fixture, set a throwaway salt in the shell (never in a file), then run the whole sequence. It writes to `data/output/fixture-ledger/`:
```
# bash
export PLAYMIND_TOKEN_SALT="$(node -e "process.stdout.write(require('crypto').randomBytes(24).toString('base64url'))")"
# PowerShell
$env:PLAYMIND_TOKEN_SALT = node -e "process.stdout.write(require('crypto').randomBytes(24).toString('base64url'))"

npm run intake -- run --config test/fixtures/intake/ledger-mapping.json --label SYNTHETIC
```

## Fields we need

Generated from `BEHAVIOR_SIGNAL_DEFINITIONS` and `TWIN_PARAMETER_DEFINITIONS` by `npm run intake -- fields`; `test/intake-readiness.test.mjs` fails if this table drifts from the definitions.

- **Required**: fields every signal and parameter needs, plus the schema fields intake fills itself.
- **Strongly wanted**: fields a parameter needs that has no proxy.
- **Nice to have**: fields that replace a proxy, make a parameter voluntary instead of all-cause, or give a signal its first-choice path, and fields no definition reads.

<!-- intake-fields:start -->
| Tier | Field | What it unlocks |
| --- | --- | --- |
| required | `trader_token` | Every signal and parameter. Sent as a stable account ID; intake tokenizes it. |
| required | `occurred_at` | Every signal and parameter. |
| required | `type` | Every signal and parameter. |
| required | `event_id` | Filled by intake (tokenized source ID or row number, the config venue, the file line). |
| required | `venue_id` | Filled by intake (tokenized source ID or row number, the config venue, the file line). |
| required | `source_row_number` | Filled by intake (tokenized source ID or row number, the config venue, the file line). |
| strongly wanted | `stake_amount` | Parameters: baseStake, stakeDispersion, chaseCoefficient, escalationPerLoss, stopHazard, refuelProbability (without it: proxy refuelAfterLosingStreak), payoutMultiple, payoutSpread. Signals: postOutcomeStake, stopBehavior, escalation. Alternative path in signals: refuel. |
| strongly wanted | `realized_result` | Parameters: baseStake, stakeDispersion, chaseCoefficient, escalationPerLoss, reentryLatencyAfterLoss, reentryLatencyAfterWin, latencySpread, stopHazard, refuelProbability (without it: proxy refuelAfterLosingStreak), refuelAfterLosingStreak, winRate, pushRate, payoutMultiple, payoutSpread, settlementLagMinutes, settlementLagSpread. Signals: postOutcomeStake, reentryLatency, escalation. Alternative path in signals: sessionDrawdown, stopBehavior, refuel. |
| strongly wanted | `deposit_amount` | Parameters: depositSize, depositSpread. |
| strongly wanted | `settled_at` | Parameters: settlementLagMinutes, settlementLagSpread. |
| nice to have | `balance_before` | Parameters: refuelProbability (without it: proxy refuelAfterLosingStreak). Alternative path in signals: sessionDrawdown, stopBehavior, refuel. Makes stopHazard voluntary instead of all-cause. |
| nice to have | `balance_after` | Parameters: refuelProbability (without it: proxy refuelAfterLosingStreak). Alternative path in signals: sessionDrawdown, stopBehavior, refuel. Makes stopHazard voluntary instead of all-cause. |
| nice to have | `withdrawal_amount` | Not read by any signal or parameter definition. Optional. |
| nice to have | `payout_amount` | Not read by any signal or parameter definition. Optional. |
| nice to have | `price` | Not read by any signal or parameter definition. Optional. |
| nice to have | `quantity` | Not read by any signal or parameter definition. Optional. |
| nice to have | `side` | Not read by any signal or parameter definition. Optional. |
| nice to have | `market_id` | Not read by any signal or parameter definition. Optional. |
| nice to have | `market_type` | Not read by any signal or parameter definition. Optional. |
| nice to have | `policy_event_type` | Not read by any signal or parameter definition. Optional. |
| nice to have | `policy_event_value` | Not read by any signal or parameter definition. Optional. |
| nice to have | `placed_at` | Not read by any signal or parameter definition. Optional. |
<!-- intake-fields:end -->

Notes on the table:

- Balances are the most valuable "nice to have". Without them the stop hazard is all-cause (it includes stops from running out of money, which the simulator then double-counts) and refuel uses the losing-streak proxy instead of the low-balance trigger. They count only for traders with both balance fields on every trade.
- `withdrawal_amount` is not in a definition's field list, but the session-drawdown balance path uses it to net out withdrawals when balances are present (DATA-DICTIONARY.md, signal 3).
- Market and contract fields are optional everywhere. We expect none from Sporttrade, and the twin never reads them.
- If realized results are missing for some trades, those trades stay unavailable (null), never zero. Coverage shows up in `readiness.md`.

## Mapping config reference

A JSON file. Unknown keys are errors, so a typo can't silently drop a field. It never holds the salt.

| Key | Meaning |
| --- | --- |
| `name` | Run name and default output folder (`data/output/<name>/`). A plain name. |
| `label` | Optional. If set, it must equal `--label`. |
| `input` | Optional source path, relative to the config file. `--input` overrides it. |
| `source` | `format` (`csv`, `json`, `jsonl`; default from the file name), `delimiter` (default detected), `commentPrefix` (default `#`: lines before the header that start with it are skipped and counted). |
| `venueId` | Constant `venue_id` for every event. |
| `trader` | `column` (the raw account ID), `tokenPrefix` (default `tr_`), `tokenHexLength` (default 16), `caseSensitive` (default true). The token is `prefix + HMAC-SHA256(salt, trimmed ID)` in hex, truncated. |
| `eventId` | Optional `column`: a source row ID, tokenized as `ev_ + HMAC-SHA256(salt, "event_id:" + ID)`. Without it, `event_id` is `row_<line>`. |
| `timestamp` | `column`, `timezone` (required: `UTC`, an offset like `-05:00`, or an IANA name like `America/New_York`), `format` (`iso` default, `mdy`, `dmy`, `epoch_seconds`, `epoch_millis`). Times without an offset are read in `timezone` and written as UTC ISO. A time with an explicit offset keeps it. A time skipped by a daylight-saving change is dropped; a repeated one takes the earlier instant. Both are counted. |
| `eventType` | `column`, `values` (source value to `trade`, `deposit`, `withdrawal`, `balance_snapshot`, `policy_event`, `restriction_event`, or `self_exclusion_event`), `ignore` (source values to drop, counted), `caseSensitive` (default false; values are trimmed). Values in neither list are dropped and reported by masked shape. |
| `fields` | Schema field to spec. Amounts: `{ column, units, sign, appliesTo }`. `units` is required for every currency field: `cents` or `dollars`. `sign`: `as-is` (default), `negate`, `absolute`. `appliesTo`: the event types the field is set on (defaults: trade fields on trades, `deposit_amount` on deposits, `withdrawal_amount` on withdrawals). Text fields (`market_id`, `market_type`, `side`, `policy_event_type`): `{ column, appliesTo }`. |
| `fields.realized_result` | One of: `{ mode: "signed", column, units, perspective }` (`perspective: "house"` flips the sign); `{ mode: "split", gainColumn, lossColumn, units, lossSign }` (result = gain - abs(loss); both blank means unavailable); `{ mode: "payout_minus_stake", payoutColumn, units }` (needs `stake_amount`; a blank payout is unavailable). A plain `{ column, units, sign }` also works. |
| `excludeRows` | Rules `{ column, values, reason, caseSensitive }`: rows whose cell matches are dropped and counted under `reason`. For voids and cancellations. |
| `dropExactDuplicates` | Default true: rows identical after trimming are dropped and counted. Set false if the source has no row ID and identical rows can be real. |
| `behaviorOptions` | Engine behavior options (for example `sessionGapMinutes`). |
| `observationEnd` | Optional ISO time the extract ends, for censoring stops and refuels near the end. |
| `attributes` | Optional. Named columns read into typed values for the derive stage, never written to events: `{ <name>: { column, kind } }`, with `kind` one of `key` (text used to join or group; `caseSensitive`, default true), `text`, `number` (`units` `cents`, `dollars`, or `none`; `sign`), `timestamp` (`timezone`, default the table's; `format`), or `boolean` (`trueValues`, `falseValues`). Attribute columns go through the PII checks. |
| `derive` | Optional. Per derivable field, an ordered list of methods; the first that gives a value wins (below). |

### Several tables (intake-0.2.0)

A raw export often comes as several files: trades or fills, a cash ledger, orders, markets. A config with `tables` reads each one and joins them (ADR-017). A config without `tables` is a single-file config, as above.

```json
{
  "name": "sporttrade-v1",
  "label": "CUSTOMER",
  "venueId": "sporttrade",
  "observationEnd": "2026-06-30T00:00:00Z",
  "tables": {
    "fills":   { "role": "events", "input": "raw/fills.csv",   "trader": {...}, "eventId": {...}, "timestamp": {...}, "eventType": {...}, "fields": {...}, "attributes": {...} },
    "ledger":  { "role": "events", "input": "raw/ledger.csv",  "trader": {...}, "timestamp": {...}, "eventType": {...}, "fields": {...}, "attributes": {...} },
    "markets": { "role": "lookup", "input": "raw/markets.csv", "key": "market_key", "timezone": "UTC", "attributes": {...} }
  },
  "joins": {
    "market": { "from": "fills.market_key", "to": "markets.market_key" }
  },
  "derive": {
    "realized_result": [{ "method": "signed-pnl", "column": "pnl" }, { "method": "credit-minus-debit", "credit": "credit", "debit": "debit" }]
  }
}
```

| Key | Meaning |
| --- | --- |
| `tables.<name>` | A table name is lowercase letters, digits, or `_`. `role` is `events` (default) or `lookup`. `input` is read relative to the config file; `--input` replaces the first events table's input only. |
| events table | The single-file keys `input`, `source`, `trader`, `eventId`, `timestamp`, `eventType`, `fields`, `attributes`, `excludeRows`, `dropExactDuplicates`. `name`, `label`, `venueId`, `behaviorOptions`, and `observationEnd` are set once, at the top. Every events table must use the same `trader.tokenPrefix`, `tokenHexLength`, and `caseSensitive`. Without `eventId`, event IDs are `row_<line>` per table. |
| lookup table | `input`, `source`, `attributes`, `key` (the attribute rows are found by, of kind `key`), `timezone` (default for timestamp attributes), `dropExactDuplicates`. No trader column: a lookup column whose header names an account or person is refused. Rows with a blank key are dropped and counted. |
| `joins.<name>` | `{ from: "<table>.<attribute>", to: "<table>.<attribute>" }`, both `key` attributes, `from` on an events table. A join into an events table matches only rows of the same trader. Key values stay in memory. |
| `derive.<field>` | An ordered list of `{ method, ...parameters }`. A method may carry its version (`signed-pnl-0.1`). The optional `table` key limits a method to one events table; otherwise it runs on every events table that has the attributes it names. A value mapped straight from a column (`fields`) always comes first. |

Derive methods (intake-derive-0.1.0). Parameters that name attributes refer to attributes of the event's table.

| Field | Method | Parameters | Gives |
| --- | --- | --- | --- |
| `realized_result` | `signed-pnl` 0.1 | `column` (number), `perspective` (`trader` default, or `house`) | the signed P&L column |
| `realized_result` | `credit-minus-debit` 0.1 | `credit`, `debit` (numbers) | credit minus abs(debit); both blank is unavailable |
| `realized_result` | `payout-minus-stake` 0.1 | `payout` (number) | payout minus the event's stake; either unknown is unavailable |
| `realized_result` | `contract-resolution` 0.1 | `price`, `quantity` (numbers), `side` (key), `buy`, `sell` (side values; default `buy`, `sell`), `won` (boolean), `priceScale` (default 1; 100 for prices in cents), `contractValue` (what a winning contract pays, default 1) | the hold-to-resolution P&L of a binary contract: a buy wins (1 - p) q or loses p q; a sell the reverse. `won` blank (unresolved) is unavailable |
| `stake_amount` | `contract-resolution` 0.1 | as above, without `won` | the amount at risk: p q for a buy, (1 - p) q for a sell |
| `orders` | `order-id` 0.1 | `key` (a key attribute, or a list that together identify the order) | merges one trader's rows that share an order ID |
| `balances` | `ledger-replay` 0.1 | see "Balances from a cash ledger" below | `balance_before` and `balance_after` from the replayed cash ledger |
| `orders` | `account-market-side-time` 0.1 | `market`, `side` (keys) | fallback: merges one trader's rows with the same market, side, and timestamp |
| `placed_at` | `order-created` 0.1 | `attribute` (a timestamp on the trade row), or `join` and `joinAttribute` (a timestamp on an orders table) | the order-creation time; a time after the execution time is skipped |
| `settled_at` | `ledger-settlement` 0.1 | `join` (into a ledger events table, by order or position ID), `kind` and `kinds` (which postings mean settlement) | the latest matching posting's time |
| `settled_at` | `trade-settlement-column` 0.1 | `attribute` (a timestamp on the trade row) | that time |
| `settled_at` | `market-settlement` 0.1 | `join` (into a market table), `attribute` (its settlement or close time) | that time |
| `settled_at` | `closing-trade` 0.1 | `market`, `side` (keys), `contract` (key, optional), `quantity` (number, optional), `buy`, `sell` | the time of the opposite trade that closed the position, first in first out by quantity |

How the methods combine:

- **Orders first.** `orders` methods run in order, and the first that gives a key groups the row. Within an order, stakes, results, payouts, and quantities sum, the price is quantity-weighted, the decision time is the earliest, and the outcome time the latest. If any part's result is unavailable, so is the order's. `map-report.json` reports rows in, orders out, and rows merged per method under `derive.orders`.
- **Outcome time in a fixed order of preference**: `ledger-settlement`, `trade-settlement-column`, `market-settlement`, `closing-trade`. List the ones the export supports, in that order; a list out of order is refused. A time before the trade is skipped and counted, and the next method is tried. An outcome time is kept only on a trade with a result. `closing-trade` runs after orders are merged, and only gives a time to the trade it closes, not to the closing trade. Pair it with a result method that realizes at close; with `contract-resolution` (hold to resolution) the outcome would be early.
- **Market tables are optional.** With only a trades table the core path works: the decision time and the outcome time are then assumed.
- Join hits are counted per join under `derive.joins` (`looked` is rows with a key, `found` is rows the join matched). Skips and merge problems are counted under `derive.notes`.

### Balances from a cash ledger

When trades carry no balances but the export has a cash ledger, `derive.balances` rebuilds them (ADR-019):

```json
"derive": {
  "balances": [{
    "method": "ledger-replay",
    "ledger": "ledger",
    "flows": [
      { "when": ["DEPOSIT", "PAYOUT"], "add": ["amount"] },
      { "when": ["WITHDRAWAL", "STAKE", "FEE"], "subtract": ["amount"] }
    ],
    "snapshot": { "when": ["BALANCE"], "balance": "amount" },
    "anchor": "snapshot",
    "toleranceAbsolute": 0.01,
    "linkAttribute": "order_key",
    "ledgerLinkAttribute": "order_key",
    "linkTypes": ["STAKE"]
  }]
}
```

| Parameter | Meaning |
| --- | --- |
| `ledger` | The events table holding the ledger. Every row with an account and a time is replayed, including rows whose type the mapping ignores. |
| `flows` | `{ when, add, subtract }`: the ledger type values a flow covers, and the number attributes it adds or subtracts (subtracted amounts count as absolute values). Within a flow a blank amount is 0 when another is set; a flow row with every amount blank refuses the account. |
| `snapshot` | `{ when, balance }`: type values that carry a balance snapshot, and the attribute holding it. |
| `anchor` | `snapshot` (default): the first snapshot anchors the replay. `opening`: start at zero; only when the extract covers every account from opening. |
| `toleranceAbsolute`, `toleranceRelative` | Largest allowed drift from any snapshot: max(absolute, relative x |snapshot|). Defaults 0.01 and 0. An account that drifts more gets no derived balances. |
| `linkAttribute`, `ledgerLinkAttribute`, `linkTypes` | How an event from another table finds its ledger rows: matching keys, at the earliest linked posting (optionally only these types). Events from the ledger table use their own row. |

Within one account's session, observed and derived balances never mix. `map-report.json` reports accounts replayed, refused by reason, snapshots checked, events derived, events with no linked row, and observed balances replaced, under `derive.balances`.

Every event carries `provenance`: for each derivable field (`stake_amount`, `realized_result`, `placed_at`, `settled_at`, `balance_before`, `balance_after`) that applies to its type, `observed`, `derived:<method>-<version>`, or `assumed`. `placed_at` is assumed when no method gives a decision time (the execution time is used), and `settled_at` when no method gives an outcome time for a trade with a result (the outcome is taken as known before the next trade). A field with no entry is unavailable. `map-report.json` counts events per field per source under `derive.byField`, `npm run intake -- map` prints the counts, and `readiness.md` shows them in "Where derived fields came from".

What map refuses: a mapped column that looks like direct PII (by header, or by email, phone, IP, or person-name shaped values), even as the trader ID; a column whose header names an account or person mapped to anything but `trader.column`; a target that is not a schema field; and a run without a salt. Unmapped columns, including flagged ones, are dropped and listed by name.

## Open questions for Sporttrade

1. **Time zone.** What time zone are the timestamps in? Do they carry an offset? Which event time is it: placement, matching, or settlement?
2. **Units.** Are amounts in cents or dollars, and the same unit in every column?
3. **Realized P&L.** How is it recorded: per trade on settlement, per settlement event (separate rows), or mark-to-market? Is it net of fees and commission? How are partial fills, early cash-outs, and trades closed by an opposite trade shown? Is the sign from the trader's side?
4. **Balances.** Is there an account balance before and after each trade, or a balance snapshot table? If balances exist only as snapshots, how often?
5. **Restrictions and self-exclusions.** How do deposit limits, cool-offs, restrictions, and self-exclusions appear: as rows, a separate table, or not at all? With start and end times?
6. **Account ID stability.** Is the account ID stable for the life of an account? Can one person have several accounts, and is there a link? Are any IDs reused after closure?
7. **Voids and cancellations.** How do voided, cancelled, or unmatched orders appear? As separate rows, a status column, or removed?
8. **Coverage.** What date range and roughly how many rows and accounts does the export cover? Is it every account, or a sample, and how was the sample drawn?
9. **Deposits and withdrawals.** Are they in the same file as trades? Are failed or reversed deposits included?
10. **Format.** CSV or JSON, delimiter, encoding, and is there one row per event or per order leg?
