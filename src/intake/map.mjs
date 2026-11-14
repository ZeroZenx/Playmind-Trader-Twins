/**
 * Intake mapping, version intake-map-0.1.0.
 *
 * Applies a column-mapping config to a parsed raw export (source.mjs) and produces analytical
 * events (docs/DATA-DICTIONARY.md). The config states, per source: which column feeds which
 * schema field, how source type values map to event types, the units of every amount (cents or
 * dollars), the time zone of the source timestamps, sign conventions, and how trader IDs are
 * tokenized. The full config reference is in docs/SPORTTRADE_INTAKE.md.
 *
 * Rules:
 * - Raw trader IDs are replaced with HMAC-SHA256(salt, id), hex, truncated to a fixed prefix.
 *   The salt comes from the caller (the CLI reads PLAYMIND_TOKEN_SALT). Without a salt, map
 *   refuses to run: there is no default salt. The salt is never stored or printed.
 * - A source event ID column, when mapped, is tokenized the same way (with an "event_id:"
 *   domain prefix), so no raw source identifier reaches the output.
 * - Missing realized results stay null, never 0.
 * - A mapped column that looks like direct PII (pii.mjs) is rejected. A column whose header
 *   names an account or person may only be the trader ID column.
 * - Unmapped source columns are dropped and listed by name.
 * - Exact duplicate rows are dropped; blank rows, stray whitespace, null markers, and
 *   case differences in type values are cleaned. Every drop and fix is counted with a reason
 *   and at most a few row numbers, never row contents.
 *
 * Pure: no I/O.
 */

import { createHmac } from 'node:crypto';
import { EVENT_TYPES, REQUIRED_FIELDS } from '../engine/validate.mjs';
import { DATA_LABELS } from '../engine/estimate.mjs';
import { classifyColumn, maskValue, PII_RULES_VERSION } from './pii.mjs';
import { cleanCell, IntakeError, SOURCE_VERSION, Tally } from './source.mjs';
import { parseNumber, parseTimestamp, resolveTimeZone, TIMESTAMP_FORMATS, VALUES_VERSION } from './values.mjs';

export const MAP_VERSION = 'intake-map-0.1.0';
export const SALT_ENV_VAR = 'PLAYMIND_TOKEN_SALT';
export const MIN_SALT_LENGTH = 16;
export const TOKEN_DEFAULTS = Object.freeze({ prefix: 'tr_', hexLength: 16, eventPrefix: 'ev_', eventHexLength: 20 });

export const CURRENCY_FIELDS = Object.freeze(['stake_amount', 'payout_amount', 'deposit_amount', 'withdrawal_amount', 'balance_before', 'balance_after', 'realized_result']);
export const NUMERIC_FIELDS = Object.freeze([...CURRENCY_FIELDS, 'price', 'quantity', 'policy_event_value']);
export const TEXT_FIELDS = Object.freeze(['market_id', 'market_type', 'side', 'policy_event_type']);
export const MAPPABLE_FIELDS = Object.freeze([...NUMERIC_FIELDS, ...TEXT_FIELDS]);
export const UNITS = Object.freeze(['cents', 'dollars', 'none']);
export const SIGNS = Object.freeze(['as-is', 'negate', 'absolute']);
export const RESULT_MODES = Object.freeze(['signed', 'split', 'payout_minus_stake']);

/** The event types a mapped field is set on unless the config says otherwise. */
export const DEFAULT_APPLIES_TO = Object.freeze({
  stake_amount: ['trade'],
  payout_amount: ['trade'],
  realized_result: ['trade'],
  price: ['trade'],
  quantity: ['trade'],
  market_id: ['trade'],
  market_type: ['trade'],
  side: ['trade'],
  deposit_amount: ['deposit'],
  withdrawal_amount: ['withdrawal'],
  balance_before: ['trade', 'deposit', 'withdrawal', 'balance_snapshot'],
  balance_after: ['trade', 'deposit', 'withdrawal', 'balance_snapshot'],
  policy_event_type: ['policy_event'],
  policy_event_value: ['policy_event']
});

const TOP_LEVEL_KEYS = ['name', 'label', 'description', 'input', 'source', 'venueId', 'trader', 'eventId', 'timestamp', 'eventType', 'fields', 'excludeRows', 'dropExactDuplicates', 'behaviorOptions', 'observationEnd'];
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function configError(message) {
  return new IntakeError(`Mapping config: ${message}`);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function checkKeys(object, allowed, where) {
  if (!isPlainObject(object)) throw configError(`${where} must be an object.`);
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) throw configError(`${where} has an unknown key "${key}". Allowed: ${allowed.join(', ')}.`);
  }
}

function requireString(value, where) {
  if (typeof value !== 'string' || !value.trim()) throw configError(`${where} must be a non-empty string.`);
  return value.trim();
}

function oneOf(value, allowed, where, fallback) {
  if (value === undefined) {
    if (fallback === undefined) throw configError(`${where} is required: one of ${allowed.join(', ')}.`);
    return fallback;
  }
  if (!allowed.includes(value)) throw configError(`${where} must be one of ${allowed.join(', ')}.`);
  return value;
}

function appliesTo(value, field, where) {
  if (value === undefined) return [...DEFAULT_APPLIES_TO[field]];
  if (!Array.isArray(value) || !value.length || value.some((type) => !EVENT_TYPES.has(type))) {
    throw configError(`${where}.appliesTo must be a list of event types (${[...EVENT_TYPES].join(', ')}).`);
  }
  return [...new Set(value)];
}

function numericSpec(field, spec, where) {
  if (field === 'realized_result' && spec.mode !== undefined) return resultSpec(spec, where);
  checkKeys(spec, ['column', 'units', 'sign', 'appliesTo'], where);
  const currency = CURRENCY_FIELDS.includes(field);
  return {
    kind: 'number',
    column: requireString(spec.column, `${where}.column`),
    units: oneOf(spec.units, currency ? ['cents', 'dollars'] : UNITS, `${where}.units`, currency ? undefined : 'none'),
    sign: oneOf(spec.sign, SIGNS, `${where}.sign`, 'as-is'),
    appliesTo: appliesTo(spec.appliesTo, field, where)
  };
}

function resultSpec(spec, where) {
  const mode = oneOf(spec.mode, RESULT_MODES, `${where}.mode`);
  if (mode === 'signed') {
    checkKeys(spec, ['mode', 'column', 'units', 'perspective', 'appliesTo'], where);
    return {
      kind: 'result', mode,
      column: requireString(spec.column, `${where}.column`),
      units: oneOf(spec.units, ['cents', 'dollars'], `${where}.units`),
      perspective: oneOf(spec.perspective, ['trader', 'house'], `${where}.perspective`, 'trader'),
      appliesTo: appliesTo(spec.appliesTo, 'realized_result', where)
    };
  }
  if (mode === 'split') {
    checkKeys(spec, ['mode', 'gainColumn', 'lossColumn', 'units', 'lossSign', 'appliesTo'], where);
    return {
      kind: 'result', mode,
      gainColumn: requireString(spec.gainColumn, `${where}.gainColumn`),
      lossColumn: requireString(spec.lossColumn, `${where}.lossColumn`),
      units: oneOf(spec.units, ['cents', 'dollars'], `${where}.units`),
      lossSign: oneOf(spec.lossSign, ['positive', 'negative'], `${where}.lossSign`, 'positive'),
      appliesTo: appliesTo(spec.appliesTo, 'realized_result', where)
    };
  }
  checkKeys(spec, ['mode', 'payoutColumn', 'units', 'appliesTo'], where);
  return {
    kind: 'result', mode,
    payoutColumn: requireString(spec.payoutColumn, `${where}.payoutColumn`),
    units: oneOf(spec.units, ['cents', 'dollars'], `${where}.units`),
    appliesTo: appliesTo(spec.appliesTo, 'realized_result', where)
  };
}

/**
 * Checks a mapping config and returns it normalized. Throws an IntakeError naming the problem.
 * The config never holds the salt: tokens use the salt the caller passes to mapSource.
 */
export function normalizeMappingConfig(config) {
  checkKeys(config, TOP_LEVEL_KEYS, 'the config');
  const name = requireString(config.name, 'name');
  if (!NAME_PATTERN.test(name)) throw configError('name must be a plain name: letters, digits, ".", "_", or "-", starting with a letter or digit.');
  if (config.label !== undefined && !DATA_LABELS.includes(config.label)) throw configError(`label must be one of ${DATA_LABELS.join(', ')}.`);

  const source = config.source ?? {};
  checkKeys(source, ['format', 'delimiter', 'commentPrefix'], 'source');

  checkKeys(config.trader, ['column', 'tokenPrefix', 'tokenHexLength', 'caseSensitive'], 'trader');
  const tokenPrefix = config.trader.tokenPrefix ?? TOKEN_DEFAULTS.prefix;
  if (typeof tokenPrefix !== 'string' || !/^[a-z][a-z0-9_]{0,15}$/.test(tokenPrefix)) throw configError('trader.tokenPrefix must be lowercase letters, digits, or "_", starting with a letter.');
  const tokenHexLength = config.trader.tokenHexLength ?? TOKEN_DEFAULTS.hexLength;
  if (!Number.isInteger(tokenHexLength) || tokenHexLength < 12 || tokenHexLength > 64) throw configError('trader.tokenHexLength must be an integer from 12 to 64.');

  let eventId = null;
  if (config.eventId !== undefined && config.eventId !== null) {
    checkKeys(config.eventId, ['column'], 'eventId');
    eventId = { column: requireString(config.eventId.column, 'eventId.column') };
  }

  checkKeys(config.timestamp, ['column', 'timezone', 'format'], 'timestamp');
  const timezone = requireString(config.timestamp.timezone, 'timestamp.timezone');
  try {
    resolveTimeZone(timezone);
  } catch (error) {
    throw configError(`timestamp.timezone: ${error.message}.`);
  }

  checkKeys(config.eventType, ['column', 'values', 'ignore', 'caseSensitive'], 'eventType');
  const caseSensitive = config.eventType.caseSensitive === true;
  const fold = (value) => (caseSensitive ? String(value).trim() : String(value).trim().toLowerCase());
  if (!isPlainObject(config.eventType.values) || !Object.keys(config.eventType.values).length) throw configError('eventType.values must map source values to event types.');
  const typeValues = new Map();
  for (const [sourceValue, type] of Object.entries(config.eventType.values)) {
    if (!EVENT_TYPES.has(type)) throw configError(`eventType.values maps to "${type}", which is not an event type (${[...EVENT_TYPES].join(', ')}).`);
    const key = fold(sourceValue);
    if (typeValues.has(key) && typeValues.get(key).type !== type) throw configError('eventType.values has two source values that differ only in case or spaces but map to different types.');
    typeValues.set(key, { type, written: sourceValue });
  }
  const ignore = config.eventType.ignore ?? [];
  if (!Array.isArray(ignore) || ignore.some((value) => typeof value !== 'string')) throw configError('eventType.ignore must be a list of source values.');
  const ignored = new Map(ignore.map((value) => [fold(value), value]));
  for (const key of ignored.keys()) if (typeValues.has(key)) throw configError('a source type value is both mapped and ignored.');

  const fields = {};
  for (const [field, spec] of Object.entries(config.fields ?? {})) {
    if (!MAPPABLE_FIELDS.includes(field)) {
      throw configError(`fields.${field} is not a mappable schema field. Mappable: ${MAPPABLE_FIELDS.join(', ')}. trader_token, event_id, occurred_at, type, venue_id, and source_row_number have their own keys.`);
    }
    if (!isPlainObject(spec)) throw configError(`fields.${field} must be an object.`);
    if (TEXT_FIELDS.includes(field)) {
      checkKeys(spec, ['column', 'appliesTo'], `fields.${field}`);
      fields[field] = { kind: 'text', column: requireString(spec.column, `fields.${field}.column`), appliesTo: appliesTo(spec.appliesTo, field, `fields.${field}`) };
    } else {
      fields[field] = numericSpec(field, spec, `fields.${field}`);
    }
  }
  if (fields.realized_result?.mode === 'payout_minus_stake' && !fields.stake_amount) throw configError('realized_result mode payout_minus_stake needs stake_amount mapped.');

  const excludeRows = (config.excludeRows ?? []).map((rule, index) => {
    checkKeys(rule, ['column', 'values', 'reason', 'caseSensitive'], `excludeRows[${index}]`);
    if (!Array.isArray(rule.values) || !rule.values.length || rule.values.some((value) => typeof value !== 'string')) throw configError(`excludeRows[${index}].values must be a list of strings.`);
    const sensitive = rule.caseSensitive === true;
    return {
      column: requireString(rule.column, `excludeRows[${index}].column`),
      values: new Set(rule.values.map((value) => (sensitive ? value.trim() : value.trim().toLowerCase()))),
      caseSensitive: sensitive,
      reason: requireString(rule.reason ?? `excluded by rule ${index + 1}`, `excludeRows[${index}].reason`)
    };
  });

  if (config.behaviorOptions !== undefined && !isPlainObject(config.behaviorOptions)) throw configError('behaviorOptions must be an object.');
  if (config.observationEnd !== undefined && config.observationEnd !== null && Number.isNaN(Date.parse(config.observationEnd))) throw configError('observationEnd must be an ISO timestamp or null.');

  return {
    normalized: true,
    name,
    label: config.label ?? null,
    description: config.description ?? null,
    input: config.input ?? null,
    source: { format: source.format ?? null, delimiter: source.delimiter ?? null, commentPrefix: source.commentPrefix ?? '#' },
    venueId: requireString(config.venueId, 'venueId'),
    trader: { column: requireString(config.trader.column, 'trader.column'), tokenPrefix, tokenHexLength, caseSensitive: config.trader.caseSensitive !== false },
    eventId,
    timestamp: { column: requireString(config.timestamp.column, 'timestamp.column'), timezone, format: oneOf(config.timestamp.format, TIMESTAMP_FORMATS, 'timestamp.format', 'iso') },
    eventType: { column: requireString(config.eventType.column, 'eventType.column'), caseSensitive, typeValues, ignored, fold },
    fields,
    excludeRows,
    dropExactDuplicates: config.dropExactDuplicates !== false,
    behaviorOptions: { ...(config.behaviorOptions ?? {}), ...(config.observationEnd ? { observationEnd: config.observationEnd } : {}) }
  };
}

// --- Salt and tokens -----------------------------------------------------------------------------

/** Checks a salt without ever echoing it. Throws an IntakeError when it is missing or short. */
export function checkSalt(salt) {
  if (salt === undefined || salt === null || salt === '') {
    throw new IntakeError(`${SALT_ENV_VAR} is not set. Intake refuses to tokenize without a salt and never uses a default. Set it in your shell or in a local, uncommitted .env file.`);
  }
  if (typeof salt !== 'string' || salt.length < MIN_SALT_LENGTH) {
    throw new IntakeError(`${SALT_ENV_VAR} is too short: use at least ${MIN_SALT_LENGTH} random characters.`);
  }
  return salt;
}

/** HMAC-SHA256(salt, id) as hex, truncated: the trader token without its prefix. */
export function hmacToken(salt, id, hexLength) {
  return createHmac('sha256', salt).update(String(id), 'utf8').digest('hex').slice(0, hexLength);
}

export function traderToken(salt, rawId, options = {}) {
  const prefix = options.prefix ?? TOKEN_DEFAULTS.prefix;
  const hexLength = options.hexLength ?? TOKEN_DEFAULTS.hexLength;
  const id = options.caseSensitive === false ? String(rawId).trim().toLowerCase() : String(rawId).trim();
  return `${prefix}${hmacToken(salt, id, hexLength)}`;
}

export function eventIdToken(salt, rawId) {
  return `${TOKEN_DEFAULTS.eventPrefix}${hmacToken(salt, `event_id:${String(rawId).trim()}`, TOKEN_DEFAULTS.eventHexLength)}`;
}

// --- Column checks -------------------------------------------------------------------------------

function referencedColumns(config) {
  const list = [
    { column: config.trader.column, role: 'trader_token', tokenized: true },
    { column: config.timestamp.column, role: 'occurred_at' },
    { column: config.eventType.column, role: 'type' }
  ];
  if (config.eventId) list.push({ column: config.eventId.column, role: 'event_id', tokenized: true });
  for (const [field, spec] of Object.entries(config.fields)) {
    for (const key of ['column', 'gainColumn', 'lossColumn', 'payoutColumn']) {
      if (spec[key]) list.push({ column: spec[key], role: field, text: spec.kind === 'text' });
    }
  }
  for (const rule of config.excludeRows) list.push({ column: rule.column, role: 'excludeRows filter' });
  return list;
}

function checkColumns(parsed, config, warnings) {
  const index = new Map(parsed.headers.map((header, position) => [header, position]));
  const references = referencedColumns(config);
  const missing = [...new Set(references.map((reference) => reference.column).filter((column) => !index.has(column)))];
  if (missing.length) throw new IntakeError(`Mapped columns not in the source: ${missing.map((column) => `"${column}"`).join(', ')}. Source columns: ${parsed.headers.map((header) => `"${header}"`).join(', ')}.`);
  const classified = new Map();
  for (const reference of references) {
    if (!classified.has(reference.column)) {
      const position = index.get(reference.column);
      const values = parsed.rows.map((row) => cleanCell(row.cells[position]));
      classified.set(reference.column, classifyColumn(reference.column, values, { timestampColumn: reference.role === 'occurred_at' }));
    }
    const column = classified.get(reference.column);
    if (column.pii) {
      throw new IntakeError(`Column "${reference.column}" (mapped to ${reference.role}) looks like direct PII: ${column.piiReasons.join('; ')}. Direct PII can't be mapped, even tokenized. Remove it from the mapping, and ask for a non-PII account ID if it is the trader ID.`);
    }
    if (column.personIdentifier && !reference.tokenized) {
      throw new IntakeError(`Column "${reference.column}" names an account or person, so it may only be the trader ID column (trader.column), which is tokenized. It is mapped to ${reference.role}.`);
    }
    if (column.identifierShape && reference.text) {
      warnings.push(`Column "${reference.column}" (mapped to ${reference.role}) has values with long digit runs. Check that it is not a raw account identifier.`);
    }
  }
  return { index, classified };
}

// --- Mapping ---------------------------------------------------------------------------------------

function scaleUnits(value, units) {
  if (value === null) return null;
  return units === 'cents' ? Math.round(value * 1e6) / 1e8 : value;
}

function applySign(value, sign) {
  if (value === null) return null;
  if (sign === 'negate') return value === 0 ? 0 : -value;
  if (sign === 'absolute') return Math.abs(value);
  return value;
}

function readNumber(cells, position, field, row, tally) {
  const parsed = parseNumber(cells[position]);
  if (parsed.error) {
    tally.add('fixed', `unparseable number in ${field} set to null (unavailable)`, row);
    return null;
  }
  if (parsed.fix) tally.add('fixed', `${parsed.fix} (${field})`, row);
  return parsed.value;
}

function readResult(spec, cells, index, event, row, tally) {
  if (spec.mode === 'signed') {
    const value = scaleUnits(readNumber(cells, index.get(spec.column), 'realized_result', row, tally), spec.units);
    if (value === null) return null;
    return spec.perspective === 'house' ? (value === 0 ? 0 : -value) : value;
  }
  if (spec.mode === 'split') {
    const gainText = cells[index.get(spec.gainColumn)];
    const lossText = cells[index.get(spec.lossColumn)];
    if (!gainText && !lossText) return null; // both sides blank: unavailable, never 0
    const gain = scaleUnits(readNumber(cells, index.get(spec.gainColumn), 'realized_result gain', row, tally), spec.units);
    const loss = scaleUnits(readNumber(cells, index.get(spec.lossColumn), 'realized_result loss', row, tally), spec.units);
    if ((gainText && gain === null) || (lossText && loss === null)) return null;
    if (loss !== null && loss !== 0 && (loss < 0) !== (spec.lossSign === 'negative')) tally.add('fixed', 'loss amount had the other sign than lossSign: its absolute value was used', row);
    return (gain ?? 0) - Math.abs(loss ?? 0);
  }
  const payout = scaleUnits(readNumber(cells, index.get(spec.payoutColumn), 'realized_result payout', row, tally), spec.units);
  if (payout === null || event.stake_amount === null || event.stake_amount === undefined) return null;
  return Math.round((payout - event.stake_amount) * 1e8) / 1e8;
}

/**
 * Maps a parsed source (parseSource) with a config (normalizeMappingConfig output, or a raw
 * config object). options: salt (required), label (required). Returns { label, mapVersion,
 * events, report }. Throws an IntakeError when the config, the salt, or a mapped column is
 * unacceptable; the error never contains a cell value or the salt.
 */
export function mapSource(parsed, configInput, options = {}) {
  const config = configInput?.normalized === true ? configInput : normalizeMappingConfig(configInput);
  const { label } = options;
  if (!DATA_LABELS.includes(label)) throw new IntakeError(`A data label is required: one of ${DATA_LABELS.join(', ')}.`);
  if (config.label && config.label !== label) throw new IntakeError(`The config says ${config.label} but the run is labelled ${label}. Fix one of them.`);
  const salt = checkSalt(options.salt);
  const warnings = [];
  const { index, classified } = checkColumns(parsed, config, warnings);

  const tally = new Tally();
  const unknownTypeShapes = new Map();
  const zone = resolveTimeZone(config.timestamp.timezone);
  const seenRows = new Set();
  const tokenByRawId = new Map();
  const rawIdByToken = new Map();
  const events = [];
  let rowsRead = 0;

  for (const row of parsed.rows) {
    rowsRead += 1;
    const line = row.rowNumber;
    const cells = row.cells.map((raw) => {
      const text = raw ?? '';
      const cleaned = cleanCell(text);
      if (cleaned && text !== text.trim()) tally.add('fixed', 'stray whitespace trimmed from a cell', line);
      if (text.trim() && !cleaned) tally.add('fixed', 'null marker read as blank', line);
      return cleaned;
    });

    if (config.dropExactDuplicates) {
      const key = JSON.stringify(cells);
      if (seenRows.has(key)) {
        tally.add('dropped', 'exact duplicate row', line);
        continue;
      }
      seenRows.add(key);
    }

    const excluded = config.excludeRows.find((rule) => {
      const value = cells[index.get(rule.column)];
      return value && rule.values.has(rule.caseSensitive ? value : value.toLowerCase());
    });
    if (excluded) {
      tally.add('dropped', `excluded: ${excluded.reason}`, line);
      continue;
    }

    const typeText = cells[index.get(config.eventType.column)];
    if (!typeText) {
      tally.add('dropped', 'missing event type', line);
      continue;
    }
    const typeKey = config.eventType.fold(typeText);
    if (config.eventType.ignored.has(typeKey)) {
      tally.add('dropped', `event type value ignored by the mapping ("${config.eventType.ignored.get(typeKey)}")`, line);
      continue;
    }
    const mappedType = config.eventType.typeValues.get(typeKey);
    if (!mappedType) {
      const shape = maskValue(typeText);
      unknownTypeShapes.set(shape, (unknownTypeShapes.get(shape) ?? 0) + 1);
      tally.add('dropped', 'event type value not in the mapping', line);
      continue;
    }
    if (typeText !== mappedType.written.trim()) tally.add('fixed', 'event type value matched ignoring case', line);

    const rawId = cells[index.get(config.trader.column)];
    if (!rawId) {
      tally.add('dropped', 'missing trader ID', line);
      continue;
    }

    const time = parseTimestamp(cells[index.get(config.timestamp.column)], { format: config.timestamp.format, zone });
    if (!time.iso) {
      tally.add('dropped', `timestamp: ${time.error}`, line);
      continue;
    }
    for (const note of time.notes) tally.add('fixed', `timestamp: ${note}`, line);

    let eventId;
    if (config.eventId) {
      const rawEventId = cells[index.get(config.eventId.column)];
      if (!rawEventId) {
        tally.add('dropped', 'missing event ID', line);
        continue;
      }
      eventId = eventIdToken(salt, rawEventId);
    } else {
      eventId = `row_${line}`;
    }

    const idKey = config.trader.caseSensitive ? rawId : rawId.toLowerCase();
    let token = tokenByRawId.get(idKey);
    if (!token) {
      token = traderToken(salt, rawId, { prefix: config.trader.tokenPrefix, hexLength: config.trader.tokenHexLength, caseSensitive: config.trader.caseSensitive });
      if (rawIdByToken.has(token)) throw new IntakeError('Two different trader IDs produced the same token. Increase trader.tokenHexLength.');
      rawIdByToken.set(token, true);
      tokenByRawId.set(idKey, token);
    }

    const type = mappedType.type;
    const event = { event_id: eventId, trader_token: token, occurred_at: time.iso, type, venue_id: config.venueId };
    for (const [field, spec] of Object.entries(config.fields)) {
      if (!spec.appliesTo.includes(type) || spec.kind === 'result') continue;
      if (spec.kind === 'text') {
        event[field] = cells[index.get(spec.column)] || null;
        continue;
      }
      event[field] = applySign(scaleUnits(readNumber(cells, index.get(spec.column), field, line, tally), spec.units), spec.sign);
    }
    const result = config.fields.realized_result;
    if (result?.kind === 'result' && result.appliesTo.includes(type)) {
      event.realized_result = readResult(result, cells, index, event, line, tally);
    }
    if (event.realized_result === null && type === 'trade') tally.add('note', 'trade with no realized result: kept as null (unavailable), never 0', line);
    event.source_row_number = line;
    events.push(event);
  }

  events.sort((a, b) => (a.occurred_at < b.occurred_at ? -1 : a.occurred_at > b.occurred_at ? 1 : a.source_row_number - b.source_row_number));

  const mappedColumns = referencedColumns(config).map(({ column, role }) => ({ column, to: role }));
  const mappedSet = new Set(mappedColumns.map((item) => item.column));
  const unmapped = parsed.headers.filter((header) => !mappedSet.has(header)).map((header) => {
    const position = parsed.headers.indexOf(header);
    const column = classifyColumn(header, parsed.rows.map((row) => cleanCell(row.cells[position])));
    return { column: header, flags: column.flags };
  });
  const byType = {};
  for (const event of events) byType[event.type] = (byType[event.type] ?? 0) + 1;
  const sourceDropped = parsed.tally.list('dropped');
  const sourceFixed = parsed.tally.list('fixed');

  return {
    label,
    mapVersion: MAP_VERSION,
    events,
    report: {
      label,
      mapVersion: MAP_VERSION,
      versions: { map: MAP_VERSION, source: SOURCE_VERSION, pii: PII_RULES_VERSION, values: VALUES_VERSION },
      configName: config.name,
      input: { format: parsed.format, dataRows: rowsRead, preambleLines: parsed.preambleLines ?? 0 },
      output: { events: events.length, traders: tokenByRawId.size, byType },
      dropped: [...sourceDropped, ...tally.list('dropped')],
      fixed: [...sourceFixed, ...tally.list('fixed')],
      notes: tally.list('note'),
      droppedTotal: sourceDropped.reduce((sum, entry) => sum + entry.count, 0) + tally.total('dropped'),
      columns: {
        mapped: mappedColumns,
        unmapped,
        note: 'Unmapped source columns are dropped. They are listed by name only.'
      },
      unknownTypeValues: [...unknownTypeShapes.entries()].map(([shape, count]) => ({ shape, count })),
      tokenization: {
        method: 'HMAC-SHA256 of the trimmed raw ID, hex, truncated',
        saltEnvVar: SALT_ENV_VAR,
        traderTokenPrefix: config.trader.tokenPrefix,
        traderTokenHexLength: config.trader.tokenHexLength,
        traderIdCaseSensitive: config.trader.caseSensitive,
        eventIds: config.eventId ? `source event IDs tokenized (${TOKEN_DEFAULTS.eventPrefix} + ${TOKEN_DEFAULTS.eventHexLength} hex)` : 'generated from the source row number',
        distinctTraders: tokenByRawId.size
      },
      timestamps: { column: config.timestamp.column, timezone: config.timestamp.timezone, format: config.timestamp.format, output: 'UTC ISO 8601' },
      fields: Object.fromEntries(Object.entries(config.fields).map(([field, spec]) => [field, { ...spec }])),
      requiredFieldsFilled: REQUIRED_FIELDS,
      warnings,
      classifiedColumns: [...classified.values()].map((column) => ({ column: column.header, flags: column.flags }))
    }
  };
}
