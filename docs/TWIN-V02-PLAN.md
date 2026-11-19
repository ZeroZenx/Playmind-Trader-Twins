# PlayMind Trader Twins — Claude Code prompts to get Sporttrade-ready

Repo: `zerozenx/playmind-trader-twins`
Goal: by the time Sporttrade's historical data arrives, we can load it, check it, fit a behavioral twin for each trader, test responsible-trading policies on those twins, and produce an honest evidence report. Market and contract fields are not required.

## How to use this

- Run the prompts in order, one per Claude Code session (or `/clear` between them). Review the diff and run the tests before moving on.
- Work on a branch (`twin-v0.2`) and open a PR to Darren. Don't push to `main`.
- Before Prompt 0, save this file into the repo as `docs/TWIN-V02-PLAN.md` so every session can read it.
- If Claude Code proposes something outside a prompt's scope, say no and keep it for later.

---

## Prompt 0 — Housekeeping and guardrails

```
Read README.md, AGENTS.md, docs/PHASE-0.md, docs/DECISIONS.md, docs/IMPLEMENTATION_STATUS.md, docs/TWIN-V02-PLAN.md, and everything in src/engine/ before changing anything. Create a branch named twin-v0.2.

Tasks:
1. Create CLAUDE.md at the repo root with these standing rules for all future work:
   - Never write AUC, AUROC, or any other accuracy headline in README, docs, reports, UI copy, or commit messages. Model evaluation metrics go only in gitignored local output files.
   - Never commit customer data, raw or derived. All customer data lives under data/ (gitignored) or outside the repo. This includes Sporttrade data, samples, field lists with real values, and anything derived from them.
   - No direct PII in analytical data (keep the existing rejection rules).
   - Label every output as SYNTHETIC, OBSERVATIONAL (public data), or CUSTOMER.
   - PlayMind never contacts traders, places trades, or holds funds.
   - Policy results are simulations under stated assumptions, never causal claims.
   - Market/contract fields are optional everywhere. The core twin must work without them.
2. Remove the AUROC and average-precision figures from README.md, docs/IMPLEMENTATION_STATUS.md, and analysis/reports/polymarket-holdout-model.md. Replace them with one line saying the holdout evaluation exists and its results are kept in local output. Don't change the analysis code.
3. Update .gitignore so these are ignored: data/, analysis/output/, *.parquet, *.csv (except files under test/fixtures/ and demo/), and any .env except .env.example.
4. Fix the stake_limit bug in src/engine/twin.mjs. Right now policyBlocksTrade drops any trade above maxStake, so the Math.min cap below it never runs. A stake limit should cap the trade at maxStake, not delete it. Add a test that proves a capped trade is kept at maxStake.
5. Run npm run check, npm test, and npx tsc --noEmit. All must pass.

Show me the full diff summary at the end. Don't touch anything else.
```

---

## Prompt 1 — State-dependent behavioral signals in the engine

```
Read CLAUDE.md, docs/TWIN-V02-PLAN.md, src/engine/signals.mjs, docs/DATA-DICTIONARY.md, and analysis/polymarket_loss_chasing.py plus analysis/reports/polymarket-loss-vs-win-follow-up.md.

Context: signals.mjs only computes averages and counts. The behavioral definitions (loss chasing, post-loss vs post-win behavior) live only in the Python analysis. The twin needs signals that describe how a trader reacts to what just happened. Those signals must be computable from timestamps, stakes, deposits, withdrawals, and realized result or balance, with no market fields.

Task: add a new module src/engine/behavior.mjs with versioned signal definitions (version "behavior-0.2.0"). For each trader, compute:

1. Post-outcome stake response: stake on the next trade after a realized loss, and after a realized win, each relative to the trader's rolling median stake. Report both, plus the loss-minus-win difference. This can be negative. The Polymarket follow-up found the typical wallet bets less after losses, so don't assume chasing.
2. Re-entry latency: time to the next trade after a loss vs after a win.
3. Session drawdown: within each session, the running result relative to the session start (the reference point). Use balance_before/balance_after if present, otherwise cumulative realized_result.
4. Session stop behavior: probability a session ends after a trade, as a function of current session drawdown bucket (up, flat, down small, down large). Pick bucket edges relative to the trader's median stake and document them.
5. Refuel behavior: probability of a deposit within N minutes (configurable, default 60) after the balance drops below a threshold or after a losing streak, when balance isn't available.
6. Escalation within session: slope of stake over consecutive losses in the same session.

Rules:
- Missing realized outcomes stay unavailable. Never treat them as zero.
- Every signal reports its sample size (n). Signals with n below a configurable minimum return null plus a reason, not a number.
- Pure functions, deterministic, no external services.
- Keep the existing buildSignals working. Add the new signals alongside it, not as a replacement.

Tests in test/behavior.test.mjs, using small hand-built event sequences where you can compute the right answer by hand: a chaser, a shrinker, a quitter-when-down, a refueler, and a trader with missing outcomes.

Update docs/DATA-DICTIONARY.md with a "Behavioral signals" section saying which input fields each signal needs. All checks must pass.
```

---

## Prompt 2 — Synthetic traders with known behavior (so we can test the estimator)

```
Read CLAUDE.md, docs/TWIN-V02-PLAN.md, src/synthetic/generate.mjs, and src/engine/behavior.mjs.

Context: the current synthetic generator produces traders whose stakes don't depend on outcomes, so it can't test whether we recover behavioral parameters. Before fitting twins to real data, we need synthetic traders whose true parameters we know.

Task: add src/synthetic/behavioral-generate.mjs that generates event streams from explicit per-trader parameters:
- baseStake, stake noise
- chaseCoefficient (stake multiplier after a loss vs after a win; may be below 1)
- escalationPerLoss (within-session stake growth per consecutive loss)
- reentryLatencyAfterLoss and AfterWin (minutes, with noise)
- stopHazard by drawdown bucket
- refuelProbability when balance is low, deposit size
- winProbability and payout distribution (no market detail needed)
- sessions per day, sessions per trader

Include five archetypes with documented parameters (steady, chaser, shrinker, quits-when-down, refueler) and a random population mode that draws parameters from distributions. Seeded and deterministic. Output matches the analytical event schema in docs/DATA-DICTIONARY.md, including balance_before/balance_after, and has a mode that leaves balance fields out so we can test both paths.

Write the true parameters to a sidecar JSON next to the events so later tests can compare estimated against true.

Tests: same seed gives identical output; archetypes show the expected direction in the behavior.mjs signals (the chaser's post-loss stake ratio is above 1, the shrinker's is below 1, and so on). All checks must pass.
```

---

## Prompt 3 — Twin v0.2: per-trader parameter estimation with shrinkage

```
Read CLAUDE.md, docs/TWIN-V02-PLAN.md, src/engine/twin.mjs, src/engine/behavior.mjs, src/synthetic/behavioral-generate.mjs, and db/schema.sql (trader_twins table).

Context: the twin is meant to be an econometric model of each trader. It's a small set of interpretable behavioral parameters with uncertainty, not a black box and not an LLM persona. Many traders will have short histories, so estimates must shrink toward the population.

Task: add src/engine/estimate.mjs (model version "twin-0.2.0") that fits, per trader:
- baseStake and stake dispersion
- chaseCoefficient (post-loss vs post-win stake ratio, log scale)
- escalationPerLoss
- reentry latency after loss / after win
- stopHazard by drawdown bucket
- refuelProbability and deposit size
- winRate and payout distribution (empirical)
- session rate

Method:
- Fit a population prior for each parameter from all traders in the dataset.
- Use empirical-Bayes shrinkage for each trader. Traders with little data stay close to the prior, and those with more data move toward their own estimate. Use simple, documented conjugate or partial-pooling formulas. Every step must be explainable in one paragraph.
- Store a point estimate, an uncertainty interval, the sample size, and the shrinkage weight for each parameter.
- If a required input is missing (no balance fields, no realized outcomes), mark the dependent parameters as "not estimable" with a reason, and fall back to the prior only where documented.

Parameter recovery test (the important one): generate 500 synthetic traders with known parameters from Prompt 2, fit them, and assert that:
- the estimated chaseCoefficient correlates strongly with the true value, with sign recovered for traders with at least 20 loss episodes
- interval coverage is roughly right (about 80–95% of true values fall inside 90% intervals)
- low-history traders are pulled toward the prior
Write the recovery results to a gitignored local file, and print a short summary.

Add a migration (don't edit the applied schema in place) so trader_twins can store parameters, intervals, n, shrinkage weights, model version, and training window. Update docs/MODEL_CARD.md to describe twin-0.2.0, its inputs, method, and limits. All checks must pass.
```

---

## Prompt 4 — State-dependent simulator

```
Read CLAUDE.md, docs/TWIN-V02-PLAN.md, src/engine/twin.mjs, src/engine/estimate.mjs, and src/engine/policy.mjs.

Context: simulateTwin currently draws each stake independently of prior outcomes, so the twin can't react to losses or to a policy. Replace it with a simulator driven by the twin-0.2.0 parameters.

Task: add simulateTwinV2 in src/engine/simulate.mjs. Each simulated trader moves through sessions trade by trade:
- next stake = baseStake × chase multiplier (if last trade lost) × escalation (consecutive losses this session) × noise
- time to next trade drawn from the latency for the last outcome
- after each trade, the session ends with probability stopHazard[current drawdown bucket]
- when the balance is low, the trader refuels with refuelProbability
- outcomes drawn from the trader's winRate and payout distribution
- parameter uncertainty: each simulation run draws parameters from the trader's intervals, so results carry uncertainty

Run many seeded replicates per trader (configurable, default 200) and return distributions (median, 10th and 90th percentiles), not single numbers.

Harm and activity metrics per run:
- harm: max session drawdown, number of chase episodes (stake ≥ 1.25× base after a loss), deposits made within 60 min after a loss, total net loss
- activity: trades, total stake, active days, sessions

Keep the old simulateTwin as "baseline-0.1" so reports can compare. Tests: deterministic under a seed; a high-chase twin produces more chase episodes and deeper drawdowns than a shrinker twin; a twin simulated with its true parameters reproduces its own training metrics within tolerance. All checks must pass.
```

---

## Prompt 5 — Policies with explicit behavioral-response assumptions

```
Read CLAUDE.md, docs/TWIN-V02-PLAN.md, src/engine/policy.mjs, and src/engine/simulate.mjs.

Context: right now a policy only deletes or caps trades. The value we sell is how traders respond to a policy. We have no intervention data yet, so responses must be explicit, named assumptions, tested across a range, and shown in the report.

Task: rework the policy layer to use simulateTwinV2.

Policies (each with validated config):
- cooldown after N consecutive losses or after a session drawdown threshold, duration in minutes
- daily deposit limit
- per-trade stake cap
- session loss limit (session ends when drawdown reaches X)

Response assumptions (each configurable, each with a default range for sensitivity):
- cooldown: post-cooldown rebound multiplier on stake (e.g. 0.5–1.5), probability the trader leaves for the day instead of returning
- stake cap: probability of resubmitting at the cap vs skipping the trade
- deposit limit: share of the blocked deposit that shows up the next day
- session loss limit: probability of starting a new session within an hour

Sensitivity sweep: for each policy, sweep the policy setting (e.g. cooldown 5, 15, 30, 60 min) × the response assumption range. For each cell, compute the harm reduction and activity retained against the no-policy baseline, with uncertainty bands.

Output must say plainly which assumption drives each result. Tests: when the cooldown rebound assumption is 0, the cooldown can't increase harm; at a high rebound it can. Reporting both is the point. All checks must pass.
```

---

## Prompt 6 — Held-out validation

```
Read CLAUDE.md, docs/TWIN-V02-PLAN.md, src/engine/validate.mjs, src/engine/estimate.mjs, and src/engine/simulate.mjs.

Context: validateTwin currently compares simulated totals with the same window the twin was trained on. That doesn't validate anything.

Task: add src/engine/holdout.mjs:
- Time-based split per dataset (default: first 75% of each trader's active period trains, last 25% tests; configurable; never random).
- Fit on train, simulate the test period length, compare to observed test behavior.
- Compare distributions, not just totals: stake after loss vs after win, session length, trades per session, inter-trade time, deposits after losses. Use quantile comparisons and a two-sample KS statistic. Also report per-trader calibration (share of traders whose observed test metric falls inside the simulated 80% band).
- Compare twin-0.2.0 against baseline-0.1 and against a naive "repeat the training averages" model. The twin only earns a claim if it beats both.
- Output a validation summary object with pass/fail against configurable tolerances. Pass/fail counts and calibration coverage are fine in the report. Don't produce any AUC-style headline metric.

Run it on the synthetic population from Prompt 2 and include that as a test. Leave a clearly marked hook for running it on the Polymarket public data (observational label), but don't wire the download in this prompt. All checks must pass.
```

---

## Prompt 7 — Evidence report v2

```
Read CLAUDE.md, docs/TWIN-V02-PLAN.md, src/engine/report.mjs, demo/output/synthetic-report.html, and the outputs of simulate.mjs, policy.mjs, and holdout.mjs.

Task: produce report v2 (JSON + self-contained HTML) for one dataset and one policy sweep. Sections, in this order:
1. Data label (SYNTHETIC / OBSERVATIONAL / CUSTOMER), dataset summary, field coverage, and which twin parameters were estimable from the fields present.
2. Population behavior: distribution of chase coefficients (show that most traders scale back and a minority chase, if that's what the data shows), stop behavior by drawdown, refuel rates.
3. Twin validation: held-out results vs the baselines, calibration coverage, pass/fail.
4. Policy trade-off chart: harm reduction (y) vs activity retained (x) for each policy setting, with uncertainty bands, one series per response assumption.
5. Which traders are most affected: by archetype or parameter range, never by individual token in the summary view.
6. Assumptions and limits, stated plainly. Simulation, not causal evidence.

No AUC or accuracy headline anywhere. Charts inline as SVG, with no external scripts. Update the demo command so npm run demo produces report v2 from the behavioral synthetic population. All checks must pass. Open the HTML and check it renders before you finish.
```

---

## Prompt 8 — Sporttrade intake readiness

```
Read CLAUDE.md, docs/TWIN-V02-PLAN.md, src/lib/ingestion.ts, src/engine/validate.mjs, and docs/DATA-DICTIONARY.md.

Context: Sporttrade is our design partner. They're sending historical exchange data they no longer use. We haven't seen the field list yet. We know it won't include what each trader traded on (no market or contract detail), and it may arrive as a raw dump that needs cleaning. Data must never enter the repo.

Task: build a local intake pipeline, run as a CLI (scripts/intake.mjs), that works on files under data/ (gitignored):
1. profile: read a raw CSV or JSON file, list its columns, types, null rates, example value shapes (masked), row count, and date range. Never print raw identifiers or PII-looking values.
2. map: a column-mapping config (JSON, under data/ or passed by path) mapping source columns to our event schema, including event type mapping, units (cents vs dollars), timezone, and how trader IDs are tokenized. If a raw ID is present, hash it with a salt read from an env var. The salt is never committed.
3. validate: run existing validation plus the PII-header rejection on the mapped output.
4. readiness: a report listing which behavioral signals and twin parameters are estimable from the fields present, which are not and why, and what fields would unlock them. This report becomes our ask list for Sporttrade.
5. run: profile → map → validate → readiness → fit twins → holdout → report v2, end to end, outputting to data/output/ (gitignored).

Create a test fixture shaped like a plausible exchange ledger export (synthetic values, generic column names that differ from ours, amounts in cents, UTC timestamps, no market fields, some missing realized results, a raw account ID column) and an example mapping config for it, both under test/fixtures/. Add an end-to-end test that runs the full pipeline on that fixture.

Write docs/SPORTTRADE_INTAKE.md: the steps to run when the real file arrives, the fields we need (required / strongly wanted / nice to have, each tied to the signal it unlocks), and open questions for Sporttrade (timezone, units, how realized P&L is recorded, whether balances exist, how restrictions/self-exclusions appear, account ID stability). All checks must pass.
```

---

## Prompt 9 — Dry run and readiness check

```
Read CLAUDE.md, docs/TWIN-V02-PLAN.md, docs/SPORTTRADE_INTAKE.md, and docs/IMPLEMENTATION_STATUS.md.

Task:
1. Run npm run verify:release and the full intake pipeline on the test fixture. Fix anything that fails.
2. Run a parameter-recovery and holdout pass on a 2,000-trader synthetic population with balance fields removed (closest to what we expect from Sporttrade) and summarize what still works and what degrades.
3. Update docs/IMPLEMENTATION_STATUS.md: what's built, what's validated on synthetic data only, what's waiting on customer data. No accuracy headline metrics.
4. Write docs/SPORTTRADE_READINESS.md as a one-page checklist: "ready when the file arrives" items (checked), the first 48 hours of work after the file arrives, and what we can and can't claim to Sporttrade after the first run.
5. Show me git status and confirm no file under data/, analysis/output/, or any CSV outside test/fixtures and demo is staged.

Then summarize the whole branch for a PR description to Darren.
```

---

## Prompt 10 — Derive what the twin needs from raw data

```
Read CLAUDE.md, docs/TWIN-V02-PLAN.md, docs/DATA-DICTIONARY.md, docs/SPORTTRADE_INTAKE.md, docs/DECISIONS.md (ADR-009, ADR-012, ADR-014, ADR-016), docs/MODEL_CARD.md, src/intake/ (all files), src/engine/behavior.mjs, src/engine/estimate.mjs, src/engine/simulate.mjs, src/engine/holdout.mjs, analysis/polymarket_twin_extract.py, and analysis/README.md ("Twin test on Polymarket orders").

Context: Sporttrade will send its raw export as-is. They won't clean it, add rows, or add fields for us. Everything the twin needs has to be derived internally from the fields they already have. The questions in docs/SPORTTRADE_INTAKE.md are clarifications of what their fields mean, not requests for new work.

A first run of the twin on Polymarket public data (OBSERVATIONAL, Jan-Mar 2026, through npm run intake) found four gaps that will also apply to Sporttrade:
- Outcome timing. behavior-0.2.0 assumes each trade's outcome is known before the trader's next trade. On Polymarket only about 18% of resolved orders had settled before the wallet's next order (Sports about 8%). Sporttrade is a sports exchange with in-play trading, so expect the same.
- Fills vs orders. One order can appear as many fill rows. Treated as separate trades, they create fake rapid re-entries.
- Decision time. A resting (maker) order's execution time is not when the trader decided.
- No balances or deposits in the trade table, so refuel can't be estimated and stop hazards are all-cause.
Intake today reads one file and maps each row to one event. It has no joins and no derived fields. analysis/polymarket_twin_extract.py did the derivation in Python outside intake, and its full 2,000-wallet run crashed when polars tried to allocate 1.6 TB on the join that pulls the sampled wallets' orders out of all 88 days of orders.

Do the four parts in order. After each part, run npm run check, npm test, and npx tsc --noEmit, then commit that part on twin-v0.2. Never push.

Part 1 — Multi-table intake and a derive stage (intake-0.2.0)
1. Let the mapping config declare several source tables (for example trades, ledger, orders, markets), each with its own input file, source format, and column mapping, plus the keys that join them. Single-file configs must keep working unchanged: the existing fixture config and its tests pass without edits.
2. Add a derive stage between map and validate: profile -> map (per table) -> derive -> validate -> readiness -> fit -> holdout -> sweep. Each derivation is a named, versioned method that the config selects per field, with an ordered list of fallbacks.
3. Provenance: every derived field on every event records its source as observed, derived:<method>, or assumed. Keep it in a field the engine ignores, and make validateEvents accept it. The map report counts events per field per method. Readiness reports coverage per field by provenance.
4. Raw files are never modified. Derive never prints a raw value: counts, field names, masked shapes, and tokens only, as now. Derivation is deterministic.
5. ADR-017 in docs/DECISIONS.md, and update the config reference in docs/SPORTTRADE_INTAKE.md.

Part 2 — Orders, outcome time, and results from raw tables, tested on Polymarket
1. Order merging: merge legs or fills that share an order ID; otherwise, as a configured fallback, those with the same account, market, side, and timestamp. Stakes and results sum. Record how many rows merged.
2. Decision time (placed_at): from an order-created column, joined to fills by order ID when an orders table exists. Otherwise use execution time, marked assumed.
3. Outcome time (settled_at), methods in this order of preference, with whichever ones the config enables: the timestamp of the settlement posting in a ledger table joined to the trade by order or position ID; a settlement-time column on the trade row; the market's settlement or close time joined by market ID; the time of an opposite trade that closed the position. Otherwise leave it missing and marked assumed. Market tables stay optional (CLAUDE.md): the core path must work with none.
4. Realized result methods: a signed P&L column; settlement credit minus debit; payout minus stake; and a contract-resolution method for binary contracts (price, quantity, side, and a winning flag; stake = amount at risk, result = hold-to-resolution P&L). The last one covers Polymarket and contract exchanges like Sporttrade. A result that can't be derived stays unavailable, never zero.
5. Cut analysis/polymarket_twin_extract.py down to a converter. It screens and samples wallets as now (same retail screen, seed, and caps). It then filters each day's trades to the sampled wallets one file at a time, with no join across all days. It writes two raw tables under data/polymarket/: fills (one row per wallet side) and markets. Fill merging, stakes, results, and settled_at from close_time move into the intake mapping config and the derive stage. Keep the outcome-timing diagnostic, but compute it in readiness (Part 3) instead of in Python.

Part 3 — Outcome timing in the engine (behavior-0.3.0, twin-0.3.0, simulator-0.3.0)
1. Add optional settled_at (and placed_at) to the analytical event schema and docs/DATA-DICTIONARY.md.
2. behavior-0.3.0: when settled_at is present, an outcome affects the first trade placed at or after it, not simply the next trade. Re-entry latency runs from settled_at. Session running result, losing streaks, and escalation runs update in settlement order at settlement time. A trade placed while earlier outcomes were still open reacts to what had settled by then. When settled_at is absent, results must equal behavior-0.2.0 exactly; add a test that proves it.
3. Estimator: estimate a per-trader settlement-lag distribution when settled_at is present.
4. Simulator: simulated trades settle after a lag drawn from that distribution, and simulated traders react only to settled outcomes. Without settled_at, behavior is unchanged.
5. Readiness: report the share of resolved trades whose outcome was known before the trader's next trade, overall and by market type when present. Flag it when it is low. Never invent a threshold for "low" without documenting it.
6. Synthetic: add a settlement-delay option to the behavioral generator and a recovery test showing the twin recovers chase and stop behavior with delays, using settled_at, and that it degrades without it.
7. ADR-018, plus updates to docs/MODEL_CARD.md and the signal definitions in docs/DATA-DICTIONARY.md.

Part 4 — Balance reconstruction from a cash ledger
1. Derive balance_before and balance_after by replaying the full cash ledger per account (deposits − withdrawals − stakes + payouts − fees, as the config maps them), anchored to a balance snapshot when one exists, or to zero only when the config states the extract covers the account from opening.
2. Where snapshots exist, check the replayed balance against them. Accounts whose drift exceeds a documented, configurable tolerance get no derived balances and are counted by reason. Never mix observed and derived balances within one account's session.
3. Test it on the synthetic ledger fixture: remove its balances, reconstruct them, and compare to the generator's truth.
4. Document it in ADR-019 and docs/SPORTTRADE_INTAKE.md.

Then:
1. Run the converter and npm run intake on Polymarket, 2,000 wallets, twice: settled_at derived from close_time, and settled_at disabled (the behavior-0.2.0 assumption). Write a short comparison (eligibility, which holdout checks pass, calibration coverage, outcome-timing share, and provenance coverage) to analysis/output/polymarket-twin/ (gitignored). Label it OBSERVATIONAL. No AUC-style headline. Keep it within the intake scale from Prompt 9 (about 700k rows); if the heap runs short, say so and lower the cap rather than raising the heap silently.
2. Re-run the intake fixture end to end and npm run verify:release.
3. Reword the open questions in docs/SPORTTRADE_INTAKE.md and docs/SPORTTRADE_READINESS.md as clarifications of existing fields. Readiness is no longer "the ask list": it reports which derivation methods worked and what had to be assumed. Update docs/IMPLEMENTATION_STATUS.md.
4. Add every new .mjs module to npm run check. Show me git status and confirm nothing under data/, .data/, or analysis/output/ is staged.
```

---

## Definition of "ready for Sporttrade's data"

- The pipeline runs end to end on a fixture shaped like an exchange ledger, with no market fields.
- Synthetic tests show the twin estimator recovers known behavior, including traders who scale back after losses.
- Held-out validation exists and the twin beats both baselines on synthetic data.
- The policy report shows harm against activity, with assumptions and uncertainty stated.
- There's a field ask list and open questions ready to send to Alex.
- No customer data or accuracy headline can end up in the public repo.
