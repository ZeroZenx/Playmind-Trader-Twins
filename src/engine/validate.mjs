// Direct PII and raw account identifiers. This list must match the forbidden headers in
// src/lib/ingestion.ts; test/intake-validate.test.mjs checks that they agree. Add to both,
// never remove from either.
const PROHIBITED_FIELDS = new Set([
  'name',
  'full_name',
  'first_name',
  'last_name',
  'username',
  'user_name',
  'customer_name',
  'email',
  'email_address',
  'phone',
  'address',
  'date_of_birth',
  'dob',
  'government_id',
  'ip',
  'ip_address',
  'device_fingerprint',
  'unmasked_account_id',
  'account_id',
  'customer_id'
]);

const EVENT_TYPES = new Set([
  'trade',
  'deposit',
  'withdrawal',
  'balance_snapshot',
  'policy_event',
  'restriction_event',
  'self_exclusion_event'
]);

const REQUIRED_FIELDS = ['event_id', 'trader_token', 'occurred_at', 'type', 'venue_id', 'source_row_number'];
const NUMERIC_FIELDS = [
  'price',
  'quantity',
  'stake_amount',
  'payout_amount',
  'deposit_amount',
  'withdrawal_amount',
  'balance_before',
  'balance_after',
  'policy_event_value',
  'realized_result'
];

// Optional timestamps (ADR-018): when the trader decided, and when the outcome became known.
const OPTIONAL_TIMESTAMP_FIELDS = ['placed_at', 'settled_at'];
// provenance (ADR-017): where each derived field came from. The engine never reads it.
const PROVENANCE_FIELDS = new Set(['stake_amount', 'realized_result', 'placed_at', 'settled_at', 'balance_before', 'balance_after']);
const PROVENANCE_VALUE = /^(?:observed|assumed|derived:[a-z][a-z0-9-]*-\d+\.\d+)$/;

function isBlank(value) {
  return value === undefined || value === null || value === '';
}

function normalizeField(field) {
  return String(field).trim().toLowerCase().replace(/\s+/g, '_');
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function validateEvents(events) {
  const errors = [];
  const warnings = [];
  const seenIds = new Set();
  const seenTraders = new Set();
  const dates = [];
  let realizedCount = 0;

  if (!Array.isArray(events) || events.length === 0) {
    return {
      valid: false,
      errors: ['Dataset must contain at least one event.'],
      warnings: [],
      stats: { rowCount: 0, traderCount: 0, realizedOutcomeCoverage: 0 }
    };
  }

  events.forEach((event, index) => {
    const row = index + 1;
    const normalizedKeys = Object.keys(event).map(normalizeField);
    for (const prohibited of PROHIBITED_FIELDS) {
      if (normalizedKeys.includes(prohibited)) {
        errors.push(`Row ${row} contains prohibited field: ${prohibited}.`);
      }
    }

    for (const field of REQUIRED_FIELDS) {
      if (isBlank(event[field])) {
        errors.push(`Row ${row} is missing required field: ${field}.`);
      }
    }

    if (!isBlank(event.event_id)) {
      if (seenIds.has(event.event_id)) errors.push(`Duplicate event_id: ${event.event_id}.`);
      seenIds.add(event.event_id);
    }

    if (!isBlank(event.trader_token)) seenTraders.add(event.trader_token);

    const date = new Date(event.occurred_at);
    if (Number.isNaN(date.getTime())) {
      errors.push(`Row ${row} has an invalid occurred_at value.`);
    } else {
      dates.push(date);
    }

    if (!EVENT_TYPES.has(event.type)) {
      errors.push(`Row ${row} has unsupported event type: ${event.type}.`);
    }

    for (const field of NUMERIC_FIELDS) {
      if (!isBlank(event[field]) && !isFiniteNumber(event[field])) {
        errors.push(`Row ${row} field ${field} must be a finite number.`);
      }
      if (isFiniteNumber(event[field]) && event[field] < 0 && ['price', 'quantity', 'stake_amount', 'deposit_amount', 'withdrawal_amount'].includes(field)) {
        errors.push(`Row ${row} field ${field} cannot be negative.`);
      }
    }

    for (const field of OPTIONAL_TIMESTAMP_FIELDS) {
      if (!isBlank(event[field]) && (typeof event[field] !== 'string' || Number.isNaN(Date.parse(event[field])))) {
        errors.push(`Row ${row} has an invalid ${field} value.`);
      }
    }
    const placed = isBlank(event.placed_at) ? NaN : Date.parse(event.placed_at);
    const settled = isBlank(event.settled_at) ? NaN : Date.parse(event.settled_at);
    if (!Number.isNaN(settled) && !Number.isNaN(date.getTime()) && settled < Math.min(date.getTime(), Number.isNaN(placed) ? Infinity : placed)) {
      errors.push(`Row ${row} has settled_at before the trade.`);
    }
    if (event.provenance !== undefined) {
      const provenance = event.provenance;
      if (provenance === null || typeof provenance !== 'object' || Array.isArray(provenance)) {
        errors.push(`Row ${row} field provenance must be an object of field to source.`);
      } else {
        for (const [field, source] of Object.entries(provenance)) {
          if (!PROVENANCE_FIELDS.has(field)) errors.push(`Row ${row} provenance names a field that is not derivable: ${field}.`);
          else if (typeof source !== 'string' || !PROVENANCE_VALUE.test(source)) errors.push(`Row ${row} provenance for ${field} must be observed, assumed, or derived:<method>.`);
        }
      }
    }

    if (event.realized_result !== undefined && event.realized_result !== null) realizedCount += 1;
  });

  const requiredCoverage = REQUIRED_FIELDS.map((field) => {
    const present = events.filter((event) => !isBlank(event[field])).length;
    return { field, present, total: events.length, coverage: present / events.length };
  });

  for (const item of requiredCoverage) {
    if (item.coverage < 1) warnings.push(`Required field ${item.field} has incomplete coverage.`);
  }

  const sortedDates = dates.sort((a, b) => a - b);
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    stats: {
      rowCount: events.length,
      traderCount: seenTraders.size,
      startsAt: sortedDates[0]?.toISOString() ?? null,
      endsAt: sortedDates.at(-1)?.toISOString() ?? null,
      realizedOutcomeCoverage: realizedCount / events.length,
      requiredCoverage
    }
  };
}

export function sanitizeCsvCell(value) {
  const text = String(value ?? '');
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

export { EVENT_TYPES, OPTIONAL_TIMESTAMP_FIELDS, PROHIBITED_FIELDS, PROVENANCE_FIELDS, REQUIRED_FIELDS };
