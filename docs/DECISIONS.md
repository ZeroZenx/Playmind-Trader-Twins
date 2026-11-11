# Architecture decisions

## ADR-001: Venue-scoped first release

Decision: Start with one venue.

Reason: A venue-specific policy test needs less identity, governance, and integration complexity than a cross-venue hub.

## ADR-002: Batch data first

Decision: Start with file or controlled batch intake.

Reason: Batch intake supports data-quality review, reproducible runs, and a faster design-partner pilot.

## ADR-003: Transparent baseline first

Decision: Start with transparent behavioral summaries and seeded simulation.

Reason: Customer review needs traceable calculations before advanced modeling.

## ADR-004: No direct PII in analytics

Decision: Reject direct PII fields.

Reason: The first product needs a clear privacy boundary and tokenized records.

## ADR-005: Synthetic demo before customer data

Decision: Build a full local demo with synthetic events.

Reason: Engineering progress must continue while data access and legal review remain open.

## ADR-006: Next.js and Neon for the first hosted slice

Decision: Use Next.js route handlers on Vercel with Neon PostgreSQL and Neon Managed Auth.

Reason: One application boundary keeps the first pilot small. Neon supplies hosted relational storage and the authentication boundary. Long-running validation and report jobs remain a separate follow-up service.

## ADR-007: Read-only venue adapter

Decision: Add public Polymarket market metadata reads without private credentials, order placement, or custody.

Reason: The pilot tests evidence workflows. Execution adds financial, legal, and operational risk before customer value is proven.

Source: [Polymarket Gamma API documentation](https://gamma-api.polymarket.com/docs).

## ADR-008: Holdout model remains separate from product scoring

Decision: Keep the Jan-Mar 2026 model evaluation in the analysis package and outside production customer scoring until independent review.

Reason: The public-data result is observational and uses a mark-to-market proxy. Production use needs customer validation, model governance, and documented intervention rules.
