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
