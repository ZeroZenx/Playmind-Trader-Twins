# Sporttrade readiness

Where we stand before Sporttrade's historical export arrives, what we do in the first 48 hours after it does, and what we can say afterwards. The steps and commands are in [SPORTTRADE_INTAKE.md](SPORTTRADE_INTAKE.md); status is in [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md). Checked in the Prompt 9 dry run (2026-11-14). No result numbers here: they stay in gitignored output.

## Ready when the file arrives

- [x] **The documented sequence works as written** on a ledger-shaped SYNTHETIC export with no market or balance fields: profile, map, validate, readiness, run, to the default `data/output/<name>/`. Verified by running each command from SPORTTRADE_INTAKE.md on `test/fixtures/intake/ledger-export.csv`, in bash and in PowerShell; profile and map also ran on a copy laid out like the real file under `data/`. `test/intake-pipeline.test.mjs` covers it too.
- [x] **It works at Sporttrade-like scale.** A SYNTHETIC 2,000-trader, no-balance ledger of about 700,000 rows ran through `npm run intake -- run` to a complete report. The first attempt found a crash in profile at that size; it is fixed, with a regression test in `test/intake-profile.test.mjs`.
- [x] **No salt, no run.** `map` without `PLAYMIND_TOKEN_SALT`, or with a short one, refuses before reading anything. Verified by hand and in `test/intake-map.test.mjs`.
- [x] **PII can't be mapped.** Mapping the fixture's `contact` or `Email Address` column, as a field or as the trader ID, is refused. Verified by hand on `ledger-export-pii.csv` and in `test/intake-map.test.mjs`.
- [x] **Outputs can't escape `data/`.** `run --name ../x` is refused and writes nothing; a CUSTOMER run whose config sits in the repo outside `data/` is refused. Verified by hand and in `test/intake-pipeline.test.mjs`.
- [x] **The upload path and intake reject the same PII headers**, spaced variants included. `test/intake-validate.test.mjs`.
- [x] **The estimator recovers known behavior**, including traders who scale back after losses. `npm run twin:recovery -- --traders 2000` and `test/twin-recovery.test.mjs`.
- [ ] **The twin beats both comparators on synthetic data.** True with balance fields; not without them, the path we expect for Sporttrade. There, it beats baseline-0.1 on every metric but not the naive model on session shape. `npm run twin:holdout -- --traders 2000`. Open: if Sporttrade can't send balances, the first report will most likely say the twin earns no claim on session shape. That is reported as is.
- [x] **The report shows harm against activity, with assumptions and uncertainty.** Built by every `run` above; `test/report-v2.test.mjs`.
- [x] **The field ask list and open questions are ready.** `npm run intake -- fields`, kept in sync by `test/intake-readiness.test.mjs`; the note to Alex is below.
- [x] **Nothing customer-derived or headline-shaped can be committed.** `data/`, `analysis/output/`, `demo/output/`, `.env`, and CSVs outside `test/fixtures/` are gitignored (checked with `git check-ignore`). The tracked tree has no AUC or accuracy headline (searched). The public-data model script no longer writes its metrics into a tracked report.
- [x] **Nothing depends on local files.** A fresh clone of the branch outside the repo passes `npm ci`, `npm run check`, `npm test`, and `npx tsc --noEmit`, with Windows line endings.

## The first 48 hours

1. **Receive and park** (hour 0). Save the file as `data/sporttrade/raw/export.csv`. Set the Sporttrade salt from the secret store in the shell. Use the same salt for every run.
2. **Profile** (hour 1). `npm run intake -- profile data/sporttrade/raw/export.csv --label CUSTOMER --categories --name sporttrade-v1` writes `data/output/sporttrade-v1/profile.json`. If a column is flagged as PII, don't map it: ask Sporttrade for a re-export without it.
3. **Map** (hours 1 to 4). Write `data/sporttrade/mapping.json` from the profile. Then run `map`, `validate`, and `readiness` with `--name sporttrade-v1`; they write `events.json`, `map-report.json`, `validation.json`, `readiness.json`, and `readiness.md` to `data/output/sporttrade-v1/`. Read the drop and fix counts, and iterate until nothing is dropped for a reason we don't understand.
4. **Quick look** (hour 4). `run` with `--name sporttrade-v1-quick` and the small settings from SPORTTRADE_INTAKE.md step 6 writes to `data/output/sporttrade-v1-quick/`. Check the runtime before the full run.
5. **Full run** (overnight). `run --name sporttrade-v1` writes the fit, validation, sweep, and `report-v2.html` to `data/output/sporttrade-v1/`. Raise Node's heap first if the file is larger than the dry run's.
6. **Read and review** (day 2). Read `report-v2.html` as a confidential, customer-derived document. Note whether the twin earned a claim and which findings it reports. Have a second person review before anything leaves the team.
7. **Reply to Sporttrade** (day 2). Send the follow-up ask, built from `readiness.md` (which fields would unlock what), and any open question the file didn't answer. Results go out only under the customer agreement.

## What we can and can't claim after the first run

**Can:** how Sporttrade's traders behave as a group, described from their data (stake after wins and losses, session length and timing, deposits after losses, stopping). Held-out evidence about the model on their data: whether it predicts traders' later behavior better than the two simple comparators, metric by metric, with the misses reported. Simulated trade-offs between harm and activity for each policy, under response assumptions we state and vary.

**Can't:** that a policy would cause any effect; that the model is accurate, or any accuracy figure; anything about an individual trader, including who is at risk; anything about traders' intent or wellbeing.

## Note for Alex

> Hi Alex, here's what would help us most in the historical export, and a few questions about it.
>
> **Must have.** For every event: an internal account number that stays the same for the life of the account (not a name or email; we replace it with a code before any analysis), the date and time, and what kind of event it was (a trade, a deposit, or a withdrawal).
>
> **Strongly wanted.** For trades: the amount staked, and the profit or loss once it settles. For deposits: the amount.
>
> **Nice to have.** The account balance just before and just after each trade (the most useful of these), withdrawal and payout amounts, and records of deposit limits, cool-offs, restrictions, and self-exclusions with their start and end times. Market details like prices, contracts, and sides aren't needed.
>
> **Please leave out** names, emails, phone numbers, postal addresses, dates of birth, government IDs, IP addresses, and device identifiers.
>
> **Questions**
> 1. Which time zone are the times in, and is it the time an order was placed, matched, or settled?
> 2. Are amounts in cents or dollars, and the same in every column?
> 3. How is profit or loss recorded: per trade at settlement, as separate settlement rows, or marked to market? Is it after fees? How do partial fills, early cash-outs, and trades closed by an opposite trade show up?
> 4. Are balances available on each trade, or only as periodic snapshots? How often?
> 5. How do limits, cool-offs, restrictions, and self-exclusions appear, if at all?
> 6. Does an account number ever change or get reused, and can one person hold several accounts?
> 7. How do voided, cancelled, or unmatched orders appear?
> 8. What period does the export cover, roughly how many accounts and rows, and is it every account or a sample (and if a sample, how was it drawn)?
> 9. Are deposits and withdrawals in the same file as trades, and are failed or reversed deposits included?
> 10. What format: CSV or JSON, which delimiter and encoding, and one row per event or per order leg?
>
> We only analyze the data. We never contact traders, place trades, or hold funds. Thanks!
