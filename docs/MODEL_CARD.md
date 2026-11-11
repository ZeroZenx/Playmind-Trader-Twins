# Model card: transparent behavioral baseline

## Intended use

The model represents selected aggregate behavior from tokenized trader activity for policy-test preparation.

## Prohibited use

- Individual trading advice.
- Trade execution.
- Credit, insurance, employment, or eligibility decisions.
- Identity matching.
- Claims of causal policy impact without valid evaluation.

## Inputs

- Event timestamps.
- Event types.
- Tokenized trader IDs.
- Trade and deposit amounts.
- Balance fields where available.
- Market categories where available.
- Realized results where available.

## Output

- Session activity.
- Trade frequency.
- Stake distribution.
- Deposit behavior.
- Market mix.
- Response to configured policy friction.

## Limitations

- Missing outcomes reduce coverage.
- Observational replay does not prove causation.
- Synthetic data does not prove customer performance.
- Small samples produce unstable estimates.
- Venue-specific behavior does not automatically transfer to another venue.

## Validation

Use held-out time windows. Compare aggregate observed metrics against simulated metrics. Store model version, feature version, training window, validation window, and random seed.
