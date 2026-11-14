# Sporttrade intake

How to take Sporttrade's historical export from a raw file to a twin evidence report, which fields we need, and what we still have to ask them. The pipeline is `npm run intake` (`scripts/intake.mjs`, version `intake-0.1.0`). Its logic is in `src/intake/`, and the decisions behind it are in ADR-016 (`docs/DECISIONS.md`).

The file is CUSTOMER data. It, the mapping config written for it, and every output stay under `data/` (gitignored) or outside the repo. Nothing in this repo holds a Sporttrade value, field list with real values, or result.

## When the file arrives

1. **Put the file under `data/`**, for example `data/sporttrade/raw/export.csv`. Never anywhere else in the repo. CUSTOMER runs refuse an input, config, or output directory that is inside the repo but outside `data/`.
2. **Set the salt.** Put a long random value in a local, uncommitted `.env`:
   ```
   PLAYMIND_TOKEN_SALT=<at least 16 random characters>
   ```
   `npm run intake` loads `.env` if there is one. Without the salt, `map` and `run` refuse to start. There is no default. Keep the same salt for every run on Sporttrade data, or the tokens won't line up across runs. Store it the way we store other secrets, never in the repo, a ticket, or a chat.
3. **Profile first.**
   ```
   npm run intake -- profile data/sporttrade/raw/export.csv --label CUSTOMER --categories
   ```
   This prints and writes (to `data/output/profile-export/profile.json`) the columns, inferred types, null rates, row count, date range, masked value shapes (`AAAA-99999999`), lengths, character classes, blank and duplicate rows, and flags for columns that look like PII or raw identifiers. It never prints a raw value. `--categories` shows the distinct values of low-cardinality, unflagged columns (for example event-type codes) when each value occurs at least 5 times and has no digit run or `@`.
4. **Write the mapping config under `data/`**, for example `data/sporttrade/mapping.json`. Start from `test/fixtures/intake/ledger-mapping.json`. The reference is below. Use the profile to pick the columns, the units (whole numbers usually mean cents), and the type values.
5. **Map, then validate and check readiness.**
   ```
   npm run intake -- map --config data/sporttrade/mapping.json --label CUSTOMER --name sporttrade-v1
   npm run intake -- validate --label CUSTOMER --name sporttrade-v1
   npm run intake -- readiness --label CUSTOMER --name sporttrade-v1
   ```
   `map` writes `events.json` (tokenized) and `map-report.json`: every row dropped or fixed, by reason and count, never by content, plus the unmapped columns by name. `validate` runs the engine's `validateEvents` and the PII-header rule. `readiness` writes `readiness.json` and `readiness.md`: which signals and parameters are estimable, which are not and why, which fields would unlock each, field coverage, and how many traders have enough history for held-out validation. That file is the ask list for Sporttrade.
6. **Run end to end.** A quick look first, then the full run:
   ```
   npm run intake -- run --config data/sporttrade/mapping.json --label CUSTOMER --name sporttrade-v1 --traders 200 --holdout-replicates 10 --sweep-replicates 8 --policies stake_limit,cooldown
   npm run intake -- run --config data/sporttrade/mapping.json --label CUSTOMER --name sporttrade-v1
   ```
   `run` goes profile, map, validate, readiness, fit (`estimateTwins`), held-out validation (`runHoldoutValidation`), policy sweep (`runPolicySweep`), and report v2. It writes everything to `data/output/<name>/` and prints a short summary and the runtime. It stops after validation if the mapped events are invalid.
7. **Before sharing anything**, read the report as a customer-derived document: it is confidential, it carries the CUSTOMER banner, and it shares only under the customer agreement. No number from it goes into the repo, a commit message, or the README.

On the synthetic fixture, the whole sequence is:
```
PLAYMIND_TOKEN_SALT=fixture-only-salt-000 npm run intake -- run --config test/fixtures/intake/ledger-mapping.json --label SYNTHETIC
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
| strongly wanted | `realized_result` | Parameters: baseStake, stakeDispersion, chaseCoefficient, escalationPerLoss, reentryLatencyAfterLoss, reentryLatencyAfterWin, latencySpread, stopHazard, refuelProbability (without it: proxy refuelAfterLosingStreak), refuelAfterLosingStreak, winRate, pushRate, payoutMultiple, payoutSpread. Signals: postOutcomeStake, reentryLatency, escalation. Alternative path in signals: sessionDrawdown, stopBehavior, refuel. |
| strongly wanted | `deposit_amount` | Parameters: depositSize, depositSpread. |
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
