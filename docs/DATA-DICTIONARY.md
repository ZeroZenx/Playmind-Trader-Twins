# Data dictionary

## Analytical event

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| event_id | string | yes | Unique source event identifier |
| trader_token | string | yes | Pseudonymous trader identifier |
| occurred_at | ISO timestamp | yes | Event time with timezone |
| event_type | enum | yes | trade, deposit, withdrawal, balance_snapshot, policy_event, restriction_event, or self_exclusion_event |
| venue_id | string | yes | Source venue identifier |
| market_id | string | no | Market identifier |
| market_type | string | no | Market category |
| side | string | no | Trade side when supplied |
| price | number | no | Trade price when supplied |
| quantity | number | no | Trade quantity when supplied |
| stake_amount | number | no | Trade stake |
| payout_amount | number | no | Realized payout when supplied |
| deposit_amount | number | no | Deposit amount |
| withdrawal_amount | number | no | Withdrawal amount |
| balance_before | number | no | Balance before the event |
| balance_after | number | no | Balance after the event |
| policy_event_type | string | no | Policy action type |
| policy_event_value | number or string | no | Policy action value |
| realized_result | number | no | Realized result when supplied |
| source_row_number | integer | yes | Source traceability |

## Missingness rules

- Missing realized_result means unavailable.
- Missing payout_amount means unavailable.
- Missing balance fields reduce signal coverage.
- Zero means an observed zero, not a missing value.

## Behavioral signals

Definition version `behavior-0.2.0`. `buildBehaviorSignals(events, options)` in `src/engine/behavior.mjs` returns one record per trader. These signals describe how a trader reacts to what just happened. None of them reads a market or contract field.

Every value has a sample size `n` and a `reason`. If `n` is below the minimum sample size, the value is `null` and `reason` says why. The default minimum is 5. Set `minSampleSize` to change it for all signals, or `minSampleSizes` to change it for one signal. Each record includes the options it was computed with.

### Fields each signal needs

Every signal also needs `trader_token`, `occurred_at`, and the event type. The engine and database name the event-type field `type`; the table above lists it as `event_type`. Only `trade`, `deposit`, and `withdrawal` events are read.

| Signal | Output key | Needs | Notes |
| --- | --- | --- | --- |
| 1. Post-outcome stake response | `postOutcomeStake` | `stake_amount`, `realized_result` | |
| 2. Re-entry latency | `reentryLatency` | `realized_result` | |
| 3. Session drawdown | `sessionDrawdown` | `balance_before` and `balance_after`, or `realized_result` | Balances are used for a session when available. On that path, a deposit or withdrawal without balance fields needs `deposit_amount` or `withdrawal_amount`. |
| 4. Session stop behavior | `stopBehavior` | Same as signal 3, plus `stake_amount` | `stake_amount` sets the bucket edges. |
| 5. Refuel behavior | `refuel` | Deposit events, plus either `balance_before` and `balance_after` on every trade, or `realized_result` | Balances give the low-balance trigger. Without them, the losing-streak trigger is used. The low-balance threshold uses `stake_amount` unless `lowBalanceThreshold` is set. |
| 6. Escalation within session | `escalation` | `stake_amount`, `realized_result` | |

`BEHAVIOR_SIGNAL_DEFINITIONS` in the module lists the same requirements in machine-readable form.

### Shared rules

- Sessions use the same rule as `buildSignals`: a gap of more than 30 minutes (`sessionGapMinutes`) starts a new session. Only trades, deposits, and withdrawals start or extend a session. Balance snapshots and policy events don't.
- An outcome is a loss if `realized_result` < 0, a win if > 0, and a push if = 0. A missing `realized_result` is unavailable. It is never counted as a loss, a win, or a push.
- A missing outcome is never inferred from a balance change. A trade's balance change may show only the stake debit, not the settled result.
- A stake is usable only if `stake_amount` > 0.
- Outcomes are assumed to be known before the next trade. The data has no settlement time, so a trade placed while an earlier one is still open is treated as a reaction to that earlier outcome.
- The observation end defaults to the latest event time in the input, across all traders. Set `observationEnd` when the extract has a known end date. Signals 4 and 5 skip any trigger whose follow-up window runs past the observation end and report it as censored.

### Definitions

1. **Post-outcome stake response.** For each realized loss or win, take the stake on the trader's next trade, in any session. Divide it by the median of the trader's previous 20 usable stakes (`rollingWindow`). Episodes with fewer than 3 previous stakes (`minStakeHistory`) are skipped. `afterLoss.value` and `afterWin.value` are the median ratios. `lossMinusWin.value` is afterLoss minus afterWin. It is negative for a trader who bets less after losses. `meanLogRatio` and `logRatioDifference` give the same comparison on a log scale. A trade that follows the second or later loss of a losing run in the same session is excluded here and goes to signal 6 instead (ADR-009).
2. **Re-entry latency.** Minutes from a realized loss or win to the next trade, reported as medians. `anySession` uses the next trade wherever it falls. `withinSession` counts only next trades in the same session. A trade with no later trade in the data has no latency, so latency is conditional on the trader trading again. Signal 4 covers stopping.
3. **Session drawdown.** The running result after each trade, relative to the session start. The session start is the reference point, not the running peak.
   - Balance path. It is used when the session's first event has `balance_before`, every trade has `balance_after`, and every deposit or withdrawal amount is known. Running result = `balance_after` − session-start balance − net deposits and withdrawals so far in the session.
   - Realized path, used otherwise: the cumulative `realized_result`. A missing outcome makes the running result unknown from that trade to the end of the session.
   - A session's max drawdown is the depth of its lowest running result below zero, or 0 if it never went below. `value` is the median max drawdown across sessions whose running result is known for every trade. `valueInStakes` divides that by the trader's median stake, and `worst` is the largest max drawdown. `sources` counts sessions by path.
4. **Session stop behavior.** For each trade with a known running result r, the session either ends after it (no later trade in the same session) or continues. `value` is the share of trades in a bucket after which the session ended. M is the trader's median stake.

   | Bucket | Range | With defaults |
   | --- | --- | --- |
   | up | r > `flatBandStakes` × M | r > 0.5M |
   | flat | −`flatBandStakes` × M ≤ r ≤ `flatBandStakes` × M | −0.5M ≤ r ≤ 0.5M |
   | down_small | −`largeDrawdownStakes` × M ≤ r < −`flatBandStakes` × M | −2M ≤ r < −0.5M |
   | down_large | r < −`largeDrawdownStakes` × M | r < −2M |

   Why these edges: within half a typical stake of the start is break-even noise. More than two typical stakes down means the trader has lost about two full bets net in the session. The edges in currency are reported in `stopBehavior.edges`. If the last trade of a session falls within `sessionGapMinutes` of the observation end, it is censored and skipped, because the session might have continued.
5. **Refuel behavior.** The probability of a deposit within `refuelWindowMinutes` (default 60) after a trigger. A deposit with an observed `deposit_amount` of 0 doesn't count.
   - Low-balance trigger (`lowBalance`). It needs balance fields on every trade. It fires on a trade that takes the balance from at or above the threshold to below it. The threshold is `lowBalanceThreshold` if set. Otherwise it is `lowBalanceStakeMultiple` (default 1) × the median stake, the point where the trader can no longer cover a typical bet.
   - Losing-streak trigger (`losingStreak`). It fires on the trade that completes `losingStreakLength` (default 3) consecutive realized losses. A deposit, a win, a push, or a missing outcome resets the count.
   - Both triggers are computed when the fields allow. `primary` names the one to use: `lowBalance` when every trade has balance fields, otherwise `losingStreak`.
6. **Escalation within session.** Each same-session run of two or more consecutive realized losses is measured against the stake on the trade after the first loss. For each later loss m (m ≥ 2), it compares the stake on the trade after loss m with that reference stake. `logSlope` is the least-squares slope, through the origin, of log(stake after loss m ÷ stake after loss 1) on m − 1. `value` = exp(`logSlope`), the stake multiplier per additional consecutive loss. A value of 1 means no escalation, and below 1 means the trader scales down as losses pile up. `n` counts the (run, m) points. A losing run ends at a session boundary.

### Options

| Option | Default | Used by |
| --- | --- | --- |
| `sessionGapMinutes` | 30 | All |
| `minSampleSize` | 5 | All |
| `minSampleSizes` | `{}` | Per-signal minimums, e.g. `{ escalation: 10 }` |
| `rollingWindow` | 20 | 1 |
| `minStakeHistory` | 3 | 1 |
| `flatBandStakes` | 0.5 | 4 |
| `largeDrawdownStakes` | 2 | 4 |
| `refuelWindowMinutes` | 60 | 5 |
| `lowBalanceStakeMultiple` | 1 | 5 |
| `lowBalanceThreshold` | null | 5 (absolute threshold, overrides the multiple) |
| `losingStreakLength` | 3 | 5 |
| `observationEnd` | latest event time | 4, 5 |

### Observations

`buildBehaviorObservations(events, options)` takes the same options and returns, per trader, the observations every signal summarizes: per trade (stake, outcome, previous outcome, same-session losing run, running session result, whether the session ended after it, censoring, balances), deposits with times, signal-1 episodes by side, latencies by outcome, signal-6 points with a run id, and losing-streak refuel episodes. `buildBehaviorSignals` is a summary of these same observations. `lowBalanceRefuelEpisodes(record, threshold)` gives signal 5's low-balance episodes for any threshold. The twin-0.2.0 estimator reads the observations, so it never re-implements a signal definition (`docs/MODEL_CARD.md`).

## Prohibited analytical fields

- Name
- Email
- Phone
- Address
- Date of birth
- Government ID
- IP address
- Device fingerprint
- Unmasked account ID
