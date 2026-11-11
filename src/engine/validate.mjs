const PROHIBITED_FIELDS = new Set([
  'name',
  'email',
  'phone',
  'address',
  'date_of_birth',
  'dob',
  'government_id',
  'ip_address',
  'device_fingerprint',
  'unmasked_account_id'
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

export { EVENT_TYPES, PROHIBITED_FIELDS, REQUIRED_FIELDS };
