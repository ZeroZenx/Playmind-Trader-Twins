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
- [x] **Everything the twin needs is derived from the export as it is.** Multi-table intake and the derive stage (ADR-017) build orders, stakes, results, decision times, outcome times, and balances from the fields a venue already keeps. Readiness reports which methods worked and what had to be assumed, and the outcome-timing share (ADR-018). The clarification questions are below.
- [x] **The twin reads outcome timing.** behavior-0.3.0 reacts to outcomes when they settle, not at the next trade; without `settled_at` it equals behavior-0.2.0 exactly (`test/behavior-settlement.test.mjs`), and on SYNTHETIC delayed traders it recovers chase and stop behavior that the old assumption hides (`test/settlement-recovery.test.mjs`).
- [x] **It ran on public data at the intake scale.** OBSERVATIONAL Polymarket fills for 2,000 retail-screened wallets went through `npm run intake` with and without settled_at. Results stay in gitignored output.
- [x] **Nothing customer-derived or headline-shaped can be committed.** `data/`, `analysis/output/`, `demo/output/`, `.env`, and CSVs outside `test/fixtures/` are gitignored (checked with `git check-ignore`). The tracked tree has no AUC or accuracy headline (searched). The public-data model script no longer writes its metrics into a tracked report.
- [x] **Nothing depends on local files.** A fresh clone of the branch outside the repo passes `npm ci`, `npm run check`, `npm test`, and `npx tsc --noEmit`, with Windows line endings.

## The first 48 hours

1. **Receive and park** (hour 0). Save the file as `data/sporttrade/raw/export.csv`. Set the Sporttrade salt from the secret store in the shell. Use the same salt for every run.
2. **Profile** (hour 1). `npm run intake -- profile data/sporttrade/raw/export.csv --label CUSTOMER --categories --name sporttrade-v1` writes `data/output/sporttrade-v1/profile.json`. If a column is flagged as PII, don't map it: ask Sporttrade for a re-export without it.
3. **Map** (hours 1 to 4). Write `data/sporttrade/mapping.json` from the profile. Then run `map`, `validate`, and `readiness` with `--name sporttrade-v1`; they write `events.json`, `map-report.json`, `validation.json`, `readiness.json`, and `readiness.md` to `data/output/sporttrade-v1/`. Read the drop and fix counts, and iterate until nothing is dropped for a reason we don't understand.
4. **Quick look** (hour 4). `run` with `--name sporttrade-v1-quick` and the small settings from SPORTTRADE_INTAKE.md step 6 writes to `data/output/sporttrade-v1-quick/`. Check the runtime before the full run.
5. **Full run** (overnight). `run --name sporttrade-v1` writes the fit, validation, sweep, and `report-v2.html` to `data/output/sporttrade-v1/`. Raise Node's heap first if the file is larger than the dry run's.
6. **Read and review** (day 2). Read `report-v2.html` as a confidential, customer-derived document. Note whether the twin earned a claim and which findings it reports. Have a second person review before anything leaves the team.
7. **Reply to Sporttrade** (day 2). Send only the clarifications the file didn't answer, about what existing columns mean (SPORTTRADE_INTAKE.md, "Clarifications about existing fields"). `readiness.md` says which derivations worked and what had to be assumed; it is not a list of new fields to ask for. Results go out only under the customer agreement.

## What we can and can't claim after the first run

**Can:** how Sporttrade's traders behave as a group, described from their data (stake after wins and losses, session length and timing, deposits after losses, stopping). Held-out evidence about the model on their data: whether it predicts traders' later behavior better than the two simple comparators, metric by metric, with the misses reported. Simulated trade-offs between harm and activity for each policy, under response assumptions we state and vary.

**Can't:** that a policy would cause any effect; that the model is accurate, or any accuracy figure; anything about an individual trader, including who is at risk; anything about traders' intent or wellbeing.

## Note for Alex

> Hi Alex, we'll take the historical export exactly as you have it: no cleaning, extra rows, or new fields needed. We work out what we need from the columns that are already there. A few questions would help us read those columns correctly. "Not recorded" is a fine answer to any of them.
>
> 1. For each time column: which time zone, and does it record when an order was placed, matched, or settled?
> 2. For each amount column: cents or dollars, and from the trader's side or yours?
> 3. Which columns or rows hold a trade's settled profit or loss? Is it after fees? How do partial fills, cash-outs, and positions closed by an opposite trade appear?
> 4. Which column identifies an order, and can one order span several rows? Is the order-creation time anywhere in the export?
> 5. If there's a cash ledger: which entry types are deposits, withdrawals, stakes, payouts, fees, and settlements, and which column links a ledger entry to its trade? Are there balance snapshot rows, and does the ledger start at each account's opening?
> 6. If limits, cool-offs, restrictions, or self-exclusions appear in the export, where?
> 7. Is the account number stable for the life of an account, and is it ever reused? Can one person hold several accounts?
> 8. Which status values mark voided, cancelled, or unmatched orders?
> 9. Which period and accounts does the export cover, and what format is it (delimiter, encoding, one row per event, order, or fill)?
>
> One condition on our side: the file must not contain names, emails, phone numbers, postal addresses, dates of birth, government IDs, IP addresses, or device identifiers. If any of those are in the export as it stands, please tell us before sending so we can agree how to handle it.
>
> We only analyze the data. We never contact traders, place trades, or hold funds. Thanks!
