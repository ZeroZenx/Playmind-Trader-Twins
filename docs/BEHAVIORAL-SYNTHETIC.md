# Behavioral synthetic traders

Label: **SYNTHETIC**. Module: `src/synthetic/behavioral-generate.mjs`, generator version `behavioral-synthetic-0.1.0`.

The older generator in `src/synthetic/generate.mjs` draws stakes that don't depend on outcomes, so it can't test whether we recover behavioral parameters. This generator simulates each trader trade by trade from explicit parameters. Each parameter means the same thing as the matching `behavior-0.2.0` signal in `src/engine/behavior.mjs`. The twin estimator (twin-0.2.1) can then be checked against known true values, and the simulator can be run on those true values (`src/synthetic/truth-twins.mjs`). The demo keeps using `generate.mjs` until Prompt 7.

## Use

```js
import { generateBehavioralDataset } from '../src/synthetic/behavioral-generate.mjs';
import { writeBehavioralDataset } from '../src/synthetic/behavioral-write.mjs';

const dataset = generateBehavioralDataset({ seed: 1, mode: 'population', traderCount: 500, sessionsPerTrader: 80 });
// dataset = { events, truth }. Nothing is written until you ask.
await writeBehavioralDataset(dataset, 'analysis/output/synthetic');
// -> analysis/output/synthetic/behavioral-synthetic.events.json
// -> analysis/output/synthetic/behavioral-synthetic.truth.json
```

`generateBehavioralDataset` is pure and deterministic: the same options always give the same output. Each trader has its own random streams (parameters, simulation, missing outcomes), all derived from the seed. Adding traders doesn't change existing ones. Write generated files to a gitignored directory (`analysis/output/`, `data/output/`) or a temp directory. Don't commit them.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `seed` | 20260302 | Non-negative integer. |
| `name` | `behavioral-synthetic` | File name stem for the writer. |
| `mode` | `archetypes` | `archetypes`, `population`, or `custom`. |
| `archetypes` | all five | Archetype mode: which archetypes to include. |
| `tradersPerArchetype` | 1 | Archetype mode: copies of each archetype. Each copy has its own random stream. |
| `traderCount` | 100 | Population mode: number of traders. |
| `traders` | `[]` | Custom mode: `{ archetype?, parameters? }` per trader. Parameters override the archetype's, and `stopHazard` merges per bucket. With no archetype, the base is steady and the truth records `custom`. |
| `sessionsPerTrader` | 100 | A positive integer, or `{ min, max }` for a uniform integer draw per trader. Add `scale: 'log'` for a log-uniform draw, `floor(exp(U(log min, log(max + 1))))`, so short histories are common: with `{ min: 2, max: 150, scale: 'log' }` about 4 in 10 traders have 10 or fewer sessions. `scale: 'uniform'` is the default and gives exactly the same output as leaving it out. Raise the counts when a test needs more loss episodes per trader. |
| `includeBalances` | true | `false` leaves `balance_before` and `balance_after` out of every event. Balances are still simulated. |
| `missingOutcomeShare` | 0 | Share of trades whose `realized_result` is set to null. Balances are kept. |
| `settlementDelay` | null | `{ medianMinutes, spread }`: each trade settles after a lognormal lag and carries `settled_at`; the trader reacts only to settled outcomes (ADR-018). The stake is debited at placement and stake plus result credited at settlement; the stop decision uses what had settled when the trade was placed; each outcome that settles before the next trade moves it to the latency for that outcome after the settlement; a refuel deposit lands one second after its trigger. null keeps every rule above unchanged. |
| `startDate` | `2026-03-02T00:00:00.000Z` | Earliest possible first session. |
| `venueId` | `synthetic-venue-001` | |
| `maxTradesPerSession` | 200 | Safety cap. A session that reaches it ends and is counted in `realized.stops.sessionCap`. |
| `behaviorOptions` | `{}` | Overrides for `sessionGapMinutes`, `refuelWindowMinutes`, `lowBalanceStakeMultiple`, `flatBandStakes`, `largeDrawdownStakes`. Defaults come from `DEFAULT_BEHAVIOR_OPTIONS`. Pass the same values to `buildBehaviorSignals`. |

Unknown options, unknown parameters, and out-of-range values throw a `RangeError`.

## Trader parameters

Money is in currency units. Every noise term is lognormal with median 1, `exp(N(0, sigma))`, so each money and time parameter is a median.

| Parameter | Unit | Meaning | Steady |
| --- | --- | --- | --- |
| `baseStake` | currency | Stake with no chase or escalation term, before noise. | 20 |
| `stakeNoise` | log SD | Noise on every stake. | 0.2 |
| `chaseCoefficient` | multiplier | Stake multiplier on the trade after a realized loss, in any session. Below 1 means the trader bets less after a loss. | 1 |
| `escalationPerLoss` | multiplier | Extra multiplier per additional consecutive loss in the same session. | 1 |
| `reentryLatencyAfterLoss` | minutes | Median time from a loss to the next trade in the same session. | 5 |
| `reentryLatencyAfterWin` | minutes | Median time from a win or push to the next trade in the same session. | 5 |
| `latencyNoise` | log SD | Noise on both latencies. | 0.4 |
| `stopHazard` | probability | `{ up, flat, down_small, down_large }`. Chance that the session ends after a trade, by drawdown bucket. | 0.12 each |
| `refuelProbability` | probability | Chance of a deposit after a low-balance trigger. | 0 |
| `depositAmount` | currency | Median deposit. | 200 |
| `depositNoise` | log SD | Noise on deposits. | 0.2 |
| `winProbability` | probability | Chance a trade wins. | 0.48 |
| `pushProbability` | probability | Chance a trade pushes (result 0). | 0 |
| `payoutMultiple` | multiplier | Median win result per unit staked. | 0.85 |
| `payoutNoise` | log SD | Noise on win results. | 0.3 |
| `sessionsPerDay` | rate | Sets the mean idle time between sessions (see Timing). | 1.5 |

With the steady values, the expected result per trade is about −9% of the stake (0.48 × 0.85 × 1.046 − 0.52). The negative edge makes balances run low and deposits recur within a few hundred trades. It is a modelling convenience, not a claim about any venue's economics.

## Archetypes

Each archetype changes only the parameters listed. Everything else is steady.

| Archetype | Changes from steady | Direction in the behavior-0.2.0 signals |
| --- | --- | --- |
| `steady` | none | `postOutcomeStake.lossMinusWin` near 0, `escalation` near 1, latency the same after losses and wins |
| `chaser` | `chaseCoefficient` 1.8, `escalationPerLoss` 1.3, `reentryLatencyAfterLoss` 2 | `lossMinusWin` > 0, `escalation` > 1, faster re-entry after a loss |
| `shrinker` | `chaseCoefficient` 0.6, `escalationPerLoss` 0.85, `reentryLatencyAfterLoss` 12 | `lossMinusWin` < 0, `escalation` < 1, slower re-entry after a loss |
| `quits-when-down` | `stopHazard` up 0.05, flat 0.08, down_small 0.25, down_large 0.6 | `stopBehavior` down_large rate well above the up rate |
| `refueler` | `refuelProbability` 0.85, `depositAmount` 60 (3 base stakes) | `refuel.lowBalance` far above steady's. Without balances, `refuel.losingStreak` still is |

`test/behavioral-generate.test.mjs` checks these directions at 250 sessions per trader, where every tested signal clears the default minimum sample size.

## Simulation rules

### Timing

- Timestamps are whole seconds, UTC.
- A trader's first session starts at a uniform random time within 24 hours of `startDate`.
- Each later session starts `minIdle + Exponential(mean = 1440 / sessionsPerDay minutes)` after the previous session's last event. `minIdle` = max(`sessionGapMinutes`, `refuelWindowMinutes`) + 1 minute, which is 61 minutes by default. Sessions therefore never merge, and a session-start deposit never falls in the refuel window of an earlier trade. The observed session rate is a little below `sessionsPerDay`, because session length and `minIdle` add to each cycle. `realized.firstEventAt` and `realized.lastEventAt` give the span.
- Within a session, the next trade comes `median × exp(N(0, latencyNoise))` after the previous trade. The median is the after-loss latency if that trade lost, otherwise the after-win latency. The draw is clamped to between 2 seconds and `sessionGapMinutes`. That way, the signals split the events into exactly the sessions the generator created.

### Stakes

stake = `baseStake` × chase term × escalation term × `exp(N(0, stakeNoise))`, rounded to cents (at least 1 cent).

- Chase term: `chaseCoefficient` if the previous trade, in any session, was a realized loss. Otherwise 1.
- Escalation term: `escalationPerLoss`^(k − 1) if the previous trade was the k-th consecutive loss in the current session, with k ≥ 2. Otherwise 1.
- Losing runs reset at session boundaries (ADR-009). The first trade, and any trade after a win or push, gets neither term. The first trade of a session after a loss gets the chase term only.

### Outcomes and balances

- Win, with probability `winProbability`: result = stake × `payoutMultiple` × `exp(N(0, payoutNoise))`, at least 1 cent. Push, with probability `pushProbability`: 0. Otherwise a loss: −stake.
- The outcome settles before the next trade: `balance_after` − `balance_before` = `realized_result` on every trade. A deposit raises the balance by `deposit_amount`. Money is tracked in integer cents.
- A trader starts with a balance of 0 and never withdraws.

### Stopping

After each trade, the bucket is `drawdownBucket(running session result, baseStake, behaviorOptions)`. The running result is the sum of this session's realized results, which equals the balance change since the session started, net of deposits. The session ends with probability `stopHazard[bucket]`. Two other rules can end a session:

- Broke rule (forced stop). A trader never stakes more than the balance. If the next intended stake is larger than the balance, after any refuel, the session ends. Forced stops are recorded in `realized.stops.forced` by bucket, separately from hazard stops in `realized.stops.hazard`. We picked this over capping the stake at the balance so that stakes are never distorted. The cost is that forced stops add to observed stop rates, mostly in the down buckets.
- Session cap. A session that reaches `maxTradesPerSession` trades ends (`realized.stops.sessionCap`).

### Deposits and refuels

The low-balance threshold is L = `lowBalanceStakeMultiple` × `baseStake` (1 base stake by default). It is the same threshold signal 5 uses, with `baseStake` in place of the observed median stake.

- Session-start deposit. If a session would start with a balance below L, or below its first intended stake, it starts with a deposit. The first trade follows 1 to 5 minutes later. The amount is raised to cover the first stake if the draw falls short (`realized.deposits.sessionStartRaised`).
- Refuel trigger. A trade that takes the balance from at or above L to below it, exactly as in signal 5. With probability `refuelProbability`, the trader deposits. If the session continues, the deposit lands between this trade and the next, so trade timing doesn't change. If the session stops after the trigger, the deposit lands 1 minute to min(`sessionGapMinutes`, `refuelWindowMinutes`) later, still in the same session. Either way it is inside the refuel window.
- Every deposit is `depositAmount` × `exp(N(0, depositNoise))`, rounded to cents.

### Balance-free mode and missing outcomes

Both are applied after the simulation and never change what the trader did.

- `includeBalances: false` drops `balance_before` and `balance_after`. The trader still can't stake more than the balance, and the refuel triggers still fire on the internal balance.
- `missingOutcomeShare` sets `realized_result` to null on each trade with that probability. It uses one draw per trade from a per-trader stream, so a larger share blanks a superset of the trades a smaller share blanks. The trader still reacted to the true outcome: a blanked loss still gives the next trade its chase term. Balances keep the true result.

## Events

Events follow the analytical event schema in `docs/DATA-DICTIONARY.md` and pass `validateEvents`.

- Fields: `event_id` (`bsyn_0000001`, in time order), `trader_token` (`syn_0001`), `occurred_at`, `type` (`trade` or `deposit`), `venue_id`, `stake_amount` and `realized_result` on trades, `deposit_amount` on deposits, `balance_before` and `balance_after` unless balance-free, and `source_row_number` (1 to N, in time order).
- No market or contract fields, and no PII.

## Truth

`truth` (and `<name>.truth.json`) holds:

- `label` (`SYNTHETIC`), `name`, `generatorVersion`, `behaviorVersion` (the signal definitions the parameters match), `seed`, and the resolved `options`
- `modelConstants`, and `populationDistributions` in population mode
- per trader: `traderToken`, `archetype` (`population` in population mode), `overrides` (custom mode), `sessionCount`, `parameters`, and `realized` counts: sessions, trades, wins, losses, pushes, `chaseEpisodes` (trades with the chase term only), `escalationEpisodes` (trades with an escalation term), `tradesByBucket`, `stops` (hazard and forced by bucket, plus sessionCap), `refuelTriggers`, `deposits` (sessionStart, sessionStartRaised, refuel), `blankedOutcomes`, `finalBalance`, `firstEventAt`, `lastEventAt`

`<name>.events.json` holds the label, name, versions, seed, options, counts, the truth file name, and the events.

## Population mode

Each trader's parameters are drawn from `POPULATION_DISTRIBUTIONS`. **These distributions are modelling assumptions.** They are loosely informed by the OBSERVATIONAL Polymarket follow-up (`analysis/reports/polymarket-loss-vs-win-follow-up.md`), where roughly as many wallets bet less after losses as bet more, and the median normalized stake after losses was about 0.95 of the one after wins. They are not a calibration to that data or to any venue.

| Parameter | Distribution | Clamp |
| --- | --- | --- |
| `baseStake` | lognormal, median 20, sigma 0.8 | 2 to 500 |
| `stakeNoise` | uniform | 0.1 to 0.4 |
| `chaseCoefficient` | lognormal, median 0.95, sigma 0.35 | 0.3 to 3 |
| `escalationPerLoss` | lognormal, median 1, sigma 0.12 | 0.7 to 1.6 |
| `reentryLatencyAfterWin` | lognormal, median 4 minutes, sigma 0.5 | 0.5 to 20 |
| `reentryLatencyAfterLoss` | after-win latency × lognormal(median 1.1, sigma 0.4) | ratio 0.25 to 4 |
| `latencyNoise` | uniform | 0.3 to 0.7 |
| `stopHazard` | logit scale: flat ~ uniform(0.06, 0.2); up = flat + N(0, 0.3); down_small = flat + d; down_large = flat + 2d, with d ~ N(0.4, 0.5) | each 0.01 to 0.95 |
| `refuelProbability` | logit-normal, mean −1, sigma 1.2 (median about 0.27) | 0 to 0.98 |
| `depositAmount` | `baseStake` × lognormal(median 6, sigma 0.4) | 3 to 30 base stakes |
| `depositNoise` | uniform | 0.1 to 0.4 |
| `winProbability` | normal, mean 0.47, sigma 0.04 | 0.3 to 0.65 |
| `pushProbability` | uniform | 0 to 0.02 |
| `payoutMultiple` | lognormal, median 0.85, sigma 0.1 | 0.5 to 1.5 |
| `payoutNoise` | uniform | 0.2 to 0.6 |
| `sessionsPerDay` | lognormal, median 1.5, sigma 0.5 | 0.2 to 8 |

About 40% of drawn chase coefficients are above 1 and 60% below, so the population has both chasers and shrinkers. Drawn values are rounded (money to cents, everything else to 4 decimals) before use, so the truth file holds exactly what the simulation used.

## Reading the signals against the truth

The signals don't equal the parameters. The generator tests check direction only. Recovery belongs to the twin estimator (twin-0.2.1, `src/engine/estimate.mjs`, ADR-011 and ADR-012): `test/twin-recovery.test.mjs` and `npm run twin:recovery` fit a 500-trader population with `sessionsPerTrader: { min: 2, max: 150, scale: 'log' }` and compare estimates and intervals with the truth. ADR-010 lists the generator choices the estimator has to account for.

- `chaseCoefficient` vs signal 1. Signal 1 divides each stake by the median of the previous 20 stakes, and that median includes chase-inflated stakes. `afterLoss.value` and `lossMinusWin.value` are therefore not the coefficient. `lossMinusWin.logRatioDifference` is the closer match, because the rolling median roughly cancels in the difference.
- `escalationPerLoss` vs signal 6. Signal 6 compares each stake with the stake after the first loss of the run, which cancels the base stake and the chase term. Forced stops cut long, expensive losing runs short.
- Latencies vs signal 2. Compare with `reentryLatency.withinSession`. `anySession` includes the idle time between sessions. Signal 2 skips pushes, while the generator uses the after-win latency after a push.
- `stopHazard` vs signal 4. The generator's bucket edges use `baseStake`, but the signal's use the observed median stake: higher than `baseStake` for chasers, lower for shrinkers. Observed stop rates also include forced stops. `realized.tradesByBucket` and `realized.stops` give the generator-side counts. Hazard plus forced stops per trade comes from the same trades the estimator sees, so it is a descriptive check, not a parameter to measure coverage against. The twin estimates the voluntary hazard and is compared with `stopHazard`.
- `refuelProbability` vs signal 5. Refuel deposits always land inside the window, and session-start deposits never do. A trader with `refuelProbability` 0 therefore has an observed refuel rate of exactly 0. The generator's trigger uses `baseStake`, and the signal's uses the observed median stake.
- `depositAmount`. Session-start and refuel deposits are drawn the same way, except for raised session-start deposits.
