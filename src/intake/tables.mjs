/**
 * Multi-table intake configs, version intake-tables-0.1.0 (ADR-017).
 *
 * A mapping config can declare several source tables, each with its own input file, source
 * format, and column mapping, plus the keys that join them:
 *
 *   { name, label, venueId, observationEnd, behaviorOptions,
 *     tables: {
 *       <table>: { role: 'events', input, source, trader, eventId, timestamp, eventType,
 *                  fields, attributes, excludeRows, dropExactDuplicates },
 *       <table>: { role: 'lookup', input, source, key, attributes, timezone } },
 *     joins: { <join>: { from: '<table>.<attribute>', to: '<table>.<attribute>' } },
 *     derive: { ... derive.mjs } }
 *
 * An events table is mapped exactly like a single-file config (map.mjs): its rows become
 * events. A lookup table (orders, markets, contracts) only gives keyed attributes to the
 * derive stage; it has no trader column and its rows are never events. A config without
 * `tables` is a single-file config and keeps working unchanged: it is one events table named
 * "main", read with normalizeMappingConfig.
 *
 * Join keys are compared as trimmed text (lowercased when the key attribute says
 * caseSensitive: false). A join whose `to` side is an events table matches only rows of the
 * same trader. Keys stay in memory: no key value is written or printed.
 *
 * Pure: no I/O.
 */

import { DATA_LABELS } from '../engine/estimate.mjs';
import { normalizeDerive } from './derive.mjs';
import { normalizeAttributes, normalizeMappingConfig, readAttributes } from './map.mjs';
import { classifyColumn } from './pii.mjs';
import { cleanCell, IntakeError, Tally } from './source.mjs';

export const TABLES_VERSION = 'intake-tables-0.1.0';
export const TABLE_ROLES = Object.freeze(['events', 'lookup']);
export const SINGLE_TABLE_NAME = 'main';

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TABLE_NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
const MULTI_TOP_LEVEL_KEYS = ['name', 'label', 'description', 'venueId', 'tables', 'joins', 'derive', 'behaviorOptions', 'observationEnd'];
const LOOKUP_KEYS = ['role', 'input', 'source', 'key', 'attributes', 'timezone', 'dropExactDuplicates'];
// Keys of an events table that are config-wide in a multi-table config.
const SHARED_KEYS = ['name', 'label', 'description', 'venueId', 'behaviorOptions', 'observationEnd'];

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

function attributeRef(text, where, tables) {
  if (typeof text !== 'string' || !/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(text)) throw configError(`${where} must be "<table>.<attribute>".`);
  const [table, attribute] = text.split('.');
  if (!tables[table]) throw configError(`${where} names an unknown table "${table}".`);
  if (!tables[table].attributes[attribute]) throw configError(`${where} names "${attribute}", which is not an attribute of table "${table}".`);
  if (tables[table].attributes[attribute].kind !== 'key') throw configError(`${where}: join attributes must have kind "key".`);
  return { table, attribute };
}

function normalizeLookup(name, spec) {
  checkKeys(spec, LOOKUP_KEYS, `tables.${name}`);
  const source = spec.source ?? {};
  checkKeys(source, ['format', 'delimiter', 'commentPrefix'], `tables.${name}.source`);
  const attributes = normalizeAttributes(spec.attributes, { where: `tables.${name}.attributes`, timezone: spec.timezone ?? null });
  if (!Object.keys(attributes).length) throw configError(`tables.${name} needs attributes: a lookup table only gives attributes.`);
  if (typeof spec.key !== 'string' || !attributes[spec.key]) throw configError(`tables.${name}.key must name one of its attributes.`);
  if (attributes[spec.key].kind !== 'key') throw configError(`tables.${name}.key must be an attribute of kind "key".`);
  return {
    name,
    role: 'lookup',
    input: spec.input ?? null,
    source: { format: source.format ?? null, delimiter: source.delimiter ?? null, commentPrefix: source.commentPrefix ?? '#' },
    key: spec.key,
    attributes,
    dropExactDuplicates: spec.dropExactDuplicates !== false
  };
}

/**
 * Checks an intake config, single-file or multi-table, and returns it normalized:
 * { intakeNormalized, multiTable, name, label, description, venueId, tables, joins, derive,
 * behaviorOptions, primary }. tables[name] is { name, role, input, source, mapping (events
 * tables: normalizeMappingConfig output), attributes, key (lookup tables) }. primary is the
 * first events table. Throws an IntakeError naming the problem.
 */
export function normalizeIntakeConfig(raw) {
  if (raw?.intakeNormalized === true) return raw;
  if (!isPlainObject(raw)) throw configError('the config must be an object.');
  if (raw.normalized === true && raw.tables === undefined) return wrapSingle(raw, null);
  if (raw.tables === undefined) {
    const { derive, ...mappingPart } = raw;
    return wrapSingle(normalizeMappingConfig(mappingPart), derive);
  }

  checkKeys(raw, MULTI_TOP_LEVEL_KEYS, 'the config');
  if (typeof raw.name !== 'string' || !NAME_PATTERN.test(raw.name.trim())) throw configError('name must be a plain name: letters, digits, ".", "_", or "-", starting with a letter or digit.');
  if (raw.label !== undefined && !DATA_LABELS.includes(raw.label)) throw configError(`label must be one of ${DATA_LABELS.join(', ')}.`);
  if (typeof raw.venueId !== 'string' || !raw.venueId.trim()) throw configError('venueId must be a non-empty string.');
  if (!isPlainObject(raw.tables) || !Object.keys(raw.tables).length) throw configError('tables must map table names to table specs.');

  const tables = {};
  for (const [name, spec] of Object.entries(raw.tables)) {
    if (!TABLE_NAME_PATTERN.test(name)) throw configError(`table name "${name}": use lowercase letters, digits, or "_", starting with a letter.`);
    if (!isPlainObject(spec)) throw configError(`tables.${name} must be an object.`);
    const role = spec.role ?? 'events';
    if (!TABLE_ROLES.includes(role)) throw configError(`tables.${name}.role must be one of ${TABLE_ROLES.join(', ')}.`);
    if (role === 'lookup') {
      tables[name] = normalizeLookup(name, spec);
      continue;
    }
    const { role: _role, ...rest } = spec;
    for (const key of SHARED_KEYS) if (rest[key] !== undefined) throw configError(`tables.${name}.${key}: set ${key} once, at the top of the config.`);
    let mapping;
    try {
      mapping = normalizeMappingConfig({ ...rest, name: raw.name.trim(), label: raw.label, venueId: raw.venueId });
    } catch (error) {
      throw new IntakeError(error.message.replace('Mapping config: ', `Mapping config: tables.${name}: `));
    }
    tables[name] = { name, role: 'events', input: mapping.input, source: mapping.source, mapping, attributes: mapping.attributes };
  }
  const eventTables = Object.values(tables).filter((table) => table.role === 'events');
  if (!eventTables.length) throw configError('at least one table must have role "events".');
  const [first] = eventTables;
  for (const table of eventTables.slice(1)) {
    const a = first.mapping.trader;
    const b = table.mapping.trader;
    if (a.tokenPrefix !== b.tokenPrefix || a.tokenHexLength !== b.tokenHexLength || a.caseSensitive !== b.caseSensitive) {
      throw configError(`tables.${table.name}.trader: tokenPrefix, tokenHexLength, and caseSensitive must match tables.${first.name}, so one account gets one token in every table.`);
    }
  }

  const joins = {};
  for (const [name, spec] of Object.entries(raw.joins ?? {})) {
    if (!TABLE_NAME_PATTERN.test(name)) throw configError(`join name "${name}": use lowercase letters, digits, or "_", starting with a letter.`);
    checkKeys(spec, ['from', 'to'], `joins.${name}`);
    const from = attributeRef(spec.from, `joins.${name}.from`, tables);
    const to = attributeRef(spec.to, `joins.${name}.to`, tables);
    if (tables[from.table].role !== 'events') throw configError(`joins.${name}.from must be an events table: joins add attributes to events.`);
    if (from.table === to.table) throw configError(`joins.${name} joins a table to itself.`);
    joins[name] = { name, from, to, sameTrader: tables[to.table].role === 'events' };
  }

  if (raw.behaviorOptions !== undefined && !isPlainObject(raw.behaviorOptions)) throw configError('behaviorOptions must be an object.');
  if (raw.observationEnd !== undefined && raw.observationEnd !== null && Number.isNaN(Date.parse(raw.observationEnd))) throw configError('observationEnd must be an ISO timestamp or null.');
  const config = {
    intakeNormalized: true,
    tablesVersion: TABLES_VERSION,
    multiTable: true,
    name: raw.name.trim(),
    label: raw.label ?? null,
    description: raw.description ?? null,
    venueId: raw.venueId.trim(),
    tables,
    joins,
    behaviorOptions: { ...(raw.behaviorOptions ?? {}), ...(raw.observationEnd ? { observationEnd: raw.observationEnd } : {}) },
    primary: first.name
  };
  config.derive = normalizeDerive(raw.derive, config);
  return config;
}

function wrapSingle(mapping, derive) {
  const table = { name: SINGLE_TABLE_NAME, role: 'events', input: mapping.input, source: mapping.source, mapping, attributes: mapping.attributes ?? {} };
  const config = {
    intakeNormalized: true,
    tablesVersion: TABLES_VERSION,
    multiTable: false,
    name: mapping.name,
    label: mapping.label,
    description: mapping.description,
    venueId: mapping.venueId,
    tables: { [SINGLE_TABLE_NAME]: table },
    joins: {},
    behaviorOptions: mapping.behaviorOptions,
    primary: SINGLE_TABLE_NAME,
    // The single-file mapping itself, for callers written against intake-0.1.0.
    mapping,
    source: mapping.source,
    input: mapping.input
  };
  config.derive = normalizeDerive(derive, config);
  return config;
}

/**
 * Reads a lookup table: { name, rows: [{ rowNumber, attributes }], report }. Rows with a blank
 * key are dropped and counted; duplicate rows are dropped when dropExactDuplicates is on. A
 * mapped column that looks like direct PII, or whose header names an account or person, is
 * refused: lookups never carry trader identity. Unmapped columns are listed by name only.
 */
export function readLookupTable(parsed, table) {
  const warnings = [];
  const index = new Map(parsed.headers.map((header, position) => [header, position]));
  const columns = [...new Set(Object.values(table.attributes).map((spec) => spec.column))];
  const missing = columns.filter((column) => !index.has(column));
  if (missing.length) throw new IntakeError(`Table "${table.name}": mapped columns not in the source: ${missing.map((column) => `"${column}"`).join(', ')}. Source columns: ${parsed.headers.map((header) => `"${header}"`).join(', ')}.`);
  for (const header of columns) {
    const position = index.get(header);
    const column = classifyColumn(header, parsed.rows.map((row) => cleanCell(row.cells[position])));
    if (column.pii) throw new IntakeError(`Table "${table.name}": column "${header}" looks like direct PII: ${column.piiReasons.join('; ')}. Direct PII can't be mapped.`);
    if (column.personIdentifier) throw new IntakeError(`Table "${table.name}": column "${header}" names an account or person. A lookup table can't carry trader identity; map it in an events table as trader.column.`);
    if (column.identifierShape) warnings.push(`Column "${header}" has values with long digit runs. Check that it is not a raw account identifier.`);
  }
  const tally = new Tally();
  const seen = new Set();
  const rows = [];
  for (const row of parsed.rows) {
    const cells = row.cells.map((cell) => cleanCell(cell));
    if (table.dropExactDuplicates) {
      const key = JSON.stringify(cells);
      if (seen.has(key)) {
        tally.add('dropped', 'exact duplicate row', row.rowNumber);
        continue;
      }
      seen.add(key);
    }
    const values = readAttributes(table.attributes, cells, index, row.rowNumber, tally);
    if (values[table.key] === null) {
      tally.add('dropped', `blank key (${table.key})`, row.rowNumber);
      continue;
    }
    rows.push({ rowNumber: row.rowNumber, attributes: values });
  }
  const mappedColumns = new Set(Object.values(table.attributes).map((spec) => spec.column));
  const sourceDropped = parsed.tally.list('dropped');
  return {
    name: table.name,
    rows,
    report: {
      table: table.name,
      role: 'lookup',
      input: { format: parsed.format, dataRows: parsed.rows.length },
      output: { rows: rows.length },
      dropped: [...sourceDropped, ...tally.list('dropped')],
      fixed: [...parsed.tally.list('fixed'), ...tally.list('fixed')],
      droppedTotal: sourceDropped.reduce((sum, entry) => sum + entry.count, 0) + tally.total('dropped'),
      columns: {
        mapped: Object.values(table.attributes).map((spec) => ({ column: spec.column, to: `attribute ${spec.name}` })),
        unmapped: parsed.headers.filter((header) => !mappedColumns.has(header)).map((header) => ({ column: header })),
        note: 'Unmapped source columns are dropped. They are listed by name only.'
      },
      warnings
    }
  };
}
