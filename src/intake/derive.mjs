/**
 * Intake derive stage, version intake-derive-0.1.0 (ADR-017).
 *
 * Runs between map and validate: profile -> map (per table) -> derive -> validate -> readiness
 * -> fit -> holdout -> sweep. It fills the fields the twin needs from the fields a venue
 * already sends, because a raw export comes as is: nobody cleans it or adds fields for us.
 *
 * Each derivation is a named, versioned method (METHODS). The config's `derive` section picks,
 * per field, an ordered list of methods: the first one that gives a value wins, and the rest
 * are fallbacks. A value mapped directly from a column (fields in map.mjs) comes first and is
 * "observed".
 *
 * Provenance. Every event gets `provenance`: for each derivable field (DERIVABLE_FIELDS) that
 * applies to its type, where the value came from: "observed", "derived:<method>-<version>",
 * or "assumed" (placed_at and settled_at, when the engine's default applies: the execution
 * time is the decision time, and an outcome is known before the trader's next trade). A field
 * with no value and no assumption has no entry: it is unavailable. The engine never reads
 * provenance; validateEvents checks its shape. The report counts events per field per source.
 *
 * Rules: raw files are never modified (derive works on mapped events and in-memory
 * attributes). Nothing here prints or stores a raw value: the report has counts, field names,
 * and method names only. A result that can't be derived stays null (unavailable), never 0.
 * Derivation is deterministic: the same mapped tables and config give the same events.
 *
 * Pure: no I/O.
 */

import { IntakeError } from './source.mjs';

export const DERIVE_VERSION = 'intake-derive-0.1.0';
export const PROVENANCE_FIELD = 'provenance';
export const DERIVABLE_FIELDS = Object.freeze(['stake_amount', 'realized_result', 'placed_at', 'settled_at', 'balance_before', 'balance_after']);
export const PROVENANCE_SCOPE = Object.freeze({
  stake_amount: ['trade'],
  realized_result: ['trade'],
  placed_at: ['trade'],
  settled_at: ['trade'],
  balance_before: ['trade', 'deposit', 'withdrawal', 'balance_snapshot'],
  balance_after: ['trade', 'deposit', 'withdrawal', 'balance_snapshot']
});
export const OBSERVED = 'observed';
export const ASSUMED = 'assumed';
export const PROVENANCE_PATTERN = /^(?:observed|assumed|derived:[a-z][a-z0-9-]*-\d+\.\d+)$/;

/** What "assumed" means for each field that can be assumed. */
export const ASSUMPTIONS = Object.freeze({
  placed_at: 'no order-creation time: the execution time (occurred_at) is used as the decision time',
  settled_at: 'no settlement time: the outcome is assumed known before the trader\'s next trade (the behavior-0.2.0 rule)'
});

function configError(message) {
  return new IntakeError(`Mapping config: ${message}`);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function round8(value) {
  return Math.round(value * 1e8) / 1e8;
}

// --- Methods ------------------------------------------------------------------------------------
//
// A method has a version, the field it fills, a parameter schema, and an apply function.
// Parameter kinds: 'number', 'timestamp', 'boolean', 'key', 'text', 'any' (an attribute of
// that kind on the event's table), 'join' (a join from the event's table), 'joined:<kind>'
// (an attribute of the join's target table), 'enum:a|b', 'strings', 'positive'.

const RESULT = 'realized_result';
const STAKE = 'stake_amount';

export const METHODS = {
  [RESULT]: {
    'signed-pnl': {
      version: '0.1',
      description: 'A signed profit-and-loss column, from the trader\'s side (perspective "house" flips it).',
      params: { column: { kind: 'number', required: true }, perspective: { kind: 'enum:trader|house', default: 'trader' } },
      apply({ attributes }, params) {
        const value = attributes[params.column];
        if (!isFiniteNumber(value)) return null;
        return params.perspective === 'house' ? (value === 0 ? 0 : -value) : value;
      }
    },
    'credit-minus-debit': {
      version: '0.1',
      description: 'Settlement credit minus settlement debit. Both blank: unavailable.',
      params: { credit: { kind: 'number', required: true }, debit: { kind: 'number', required: true } },
      apply({ attributes }, params) {
        const credit = attributes[params.credit];
        const debit = attributes[params.debit];
        if (!isFiniteNumber(credit) && !isFiniteNumber(debit)) return null;
        return round8((credit ?? 0) - Math.abs(debit ?? 0));
      }
    },
    'payout-minus-stake': {
      version: '0.1',
      description: 'Payout minus stake. A blank payout or an unknown stake: unavailable.',
      params: { payout: { kind: 'number', required: true } },
      apply({ attributes, event }, params) {
        const payout = attributes[params.payout];
        if (!isFiniteNumber(payout) || !isFiniteNumber(event.stake_amount)) return null;
        return round8(payout - event.stake_amount);
      }
    }
  },
  [STAKE]: {},
  placed_at: {},
  settled_at: {}
};

/** The provenance label of a method: derived:<name>-<version>. */
export function methodLabel(field, name) {
  return `derived:${name}-${METHODS[field][name].version}`;
}

// The provenance a directly mapped field gets (map.mjs computes it). A legacy result mode is
// the same arithmetic as a derive method, so it is labelled with that method.
function mappedLabel(field, spec) {
  if (field !== RESULT || spec?.kind !== 'result') return OBSERVED;
  if (spec.mode === 'split') return methodLabel(RESULT, 'credit-minus-debit');
  if (spec.mode === 'payout_minus_stake') return methodLabel(RESULT, 'payout-minus-stake');
  return OBSERVED;
}

// --- Config ----------------------------------------------------------------------------------------

function parseMethodName(field, text, where) {
  if (typeof text !== 'string') throw configError(`${where}.method must be a method name.`);
  const match = text.match(/^([a-z][a-z0-9-]*?)(?:-(\d+\.\d+))?$/);
  const methods = METHODS[field];
  if (!match || !methods[match[1]]) {
    throw configError(`${where}.method "${text}" is not a ${field} method. Methods: ${Object.keys(methods).map((name) => `${name} (${methods[name].version})`).join(', ') || 'none yet'}.`);
  }
  if (match[2] && match[2] !== methods[match[1]].version) throw configError(`${where}.method asks for ${match[1]} ${match[2]}, but this intake has version ${methods[match[1]].version}.`);
  return match[1];
}

function attributeTables(config, name, kind) {
  return Object.values(config.tables).filter((table) => table.role === 'events' && table.attributes[name] && (kind === 'any' || table.attributes[name].kind === kind || (kind === 'text' && table.attributes[name].kind === 'key')));
}

function normalizeParams(field, name, entry, where, config) {
  const spec = METHODS[field][name];
  const allowed = ['method', 'table', ...Object.keys(spec.params)];
  for (const key of Object.keys(entry)) if (!allowed.includes(key)) throw configError(`${where} has an unknown key "${key}". Allowed: ${allowed.join(', ')}.`);
  const params = {};
  let tables = Object.values(config.tables).filter((table) => table.role === 'events').map((table) => table.name);
  if (entry.table !== undefined) {
    if (!config.tables[entry.table] || config.tables[entry.table].role !== 'events') throw configError(`${where}.table must name an events table.`);
    tables = [entry.table];
  }
  for (const [key, schema] of Object.entries(spec.params)) {
    const value = entry[key];
    if (value === undefined) {
      if (schema.required) throw configError(`${where}.${key} is required.`);
      params[key] = schema.default ?? null;
      continue;
    }
    const kind = schema.kind;
    if (kind.startsWith('enum:')) {
      const options = kind.slice(5).split('|');
      if (!options.includes(value)) throw configError(`${where}.${key} must be one of ${options.join(', ')}.`);
      params[key] = value;
    } else if (kind === 'strings') {
      if (!Array.isArray(value) || !value.length || value.some((item) => typeof item !== 'string' || !item.trim())) throw configError(`${where}.${key} must be a list of strings.`);
      params[key] = value.map((item) => item.trim());
    } else if (kind === 'positive') {
      if (!isFiniteNumber(value) || value <= 0) throw configError(`${where}.${key} must be a positive number.`);
      params[key] = value;
    } else if (kind === 'join') {
      const join = config.joins[value];
      if (!join) throw configError(`${where}.${key} names an unknown join "${value}".`);
      tables = tables.filter((table) => table === join.from.table);
      if (!tables.length) throw configError(`${where}.${key}: join "${value}" starts from table "${join.from.table}", which this method does not read.`);
      params[key] = value;
    } else if (kind.startsWith('joined:')) {
      params[key] = value; // checked below, once the join is known
    } else {
      const names = Array.isArray(value) && schema.list ? value : [value];
      if (!names.length || names.some((item) => typeof item !== 'string')) throw configError(`${where}.${key} must name an attribute${schema.list ? ' or a list of attributes' : ''}.`);
      for (const item of names) {
        const having = attributeTables(config, item, kind).map((table) => table.name);
        tables = tables.filter((table) => having.includes(table));
        if (!tables.length) throw configError(`${where}.${key}: no events table this method reads has a ${kind === 'any' ? '' : `${kind} `}attribute "${item}".`);
      }
      params[key] = Array.isArray(value) ? [...value] : value;
    }
  }
  for (const [key, schema] of Object.entries(spec.params)) {
    if (!schema.kind.startsWith('joined:') || params[key] === null) continue;
    const joinKey = Object.entries(spec.params).find(([, other]) => other.kind === 'join')?.[0];
    const join = config.joins[params[joinKey]];
    const target = config.tables[join.to.table];
    const wanted = schema.kind.slice(7);
    const attribute = target.attributes[params[key]];
    if (!attribute || (wanted !== 'any' && attribute.kind !== wanted)) throw configError(`${where}.${key}: table "${target.name}" has no ${wanted} attribute "${params[key]}".`);
  }
  if (spec.check) spec.check(params, where, config);
  return { field, name, version: spec.version, label: methodLabel(field, name), tables, params };
}

/** Fields whose method lists must follow a fixed order of preference (ADR-017). */
export const METHOD_ORDER = {};

/**
 * Checks the config's derive section and returns { [field]: [method entries] }. A field
 * without a list keeps only its mapped (observed) value. Throws an IntakeError naming the
 * problem.
 */
export function normalizeDerive(raw, config) {
  const derive = {};
  for (const field of Object.keys(METHODS)) derive[field] = [];
  if (raw === undefined || raw === null) return derive;
  if (!isPlainObject(raw)) throw configError('derive must be an object of field to a list of methods.');
  for (const [field, list] of Object.entries(raw)) {
    if (!METHODS[field]) throw configError(`derive.${field} is not a derivable field. Derivable: ${Object.keys(METHODS).join(', ')}.`);
    if (!Array.isArray(list)) throw configError(`derive.${field} must be an ordered list of methods (the first that gives a value wins).`);
    const seen = new Set();
    derive[field] = list.map((entry, position) => {
      const where = `derive.${field}[${position}]`;
      if (!isPlainObject(entry)) throw configError(`${where} must be an object with a method.`);
      const name = parseMethodName(field, entry.method, where);
      const key = `${name}:${entry.table ?? ''}`;
      if (seen.has(key)) throw configError(`${where} repeats method ${name}.`);
      seen.add(key);
      return normalizeParams(field, name, entry, where, config);
    });
    const order = METHOD_ORDER[field];
    if (order) {
      const ranks = derive[field].map((entry) => order.indexOf(entry.name));
      if (ranks.some((rank, index) => index > 0 && rank < ranks[index - 1])) {
        throw configError(`derive.${field} must list its methods in this order of preference: ${order.join(', ')}. Leave out the ones the export can't support.`);
      }
    }
  }
  return derive;
}

// --- Running ---------------------------------------------------------------------------------------

class Counter {
  constructor() {
    this.counts = {};
  }

  add(field, source, count = 1) {
    this.counts[field] ??= {};
    this.counts[field][source] = (this.counts[field][source] ?? 0) + count;
  }
}

function eventTime(event) {
  return Date.parse(event.occurred_at);
}

function compareEvents(a, b) {
  if (a.event.occurred_at !== b.event.occurred_at) return a.event.occurred_at < b.event.occurred_at ? -1 : 1;
  if (a.tableOrder !== b.tableOrder) return a.tableOrder - b.tableOrder;
  return a.event.source_row_number - b.event.source_row_number;
}

/** Runs the methods for one field on one working record; returns { value, label } or null. */
function firstValue(field, record, methods, context) {
  for (const method of methods) {
    if (!method.tables.includes(record.table)) continue;
    const value = METHODS[field][method.name].apply(record, method.params, context);
    if (value !== null && value !== undefined) return { value, label: method.label };
  }
  return null;
}

/**
 * Derives fields on mapped events. input: { config (normalizeIntakeConfig output), tables:
 * { [name]: { role: 'events', events, attributes (WeakMap event -> attributes), rows } |
 * { role: 'lookup', rows } } }. Returns { events, report }. The mapped events are not
 * modified: every output event is a new object.
 */
export function deriveEvents({ config, tables }) {
  const counter = new Counter();
  const notes = new Counter();
  const tableNames = Object.keys(config.tables);
  const records = [];
  for (const [name, table] of Object.entries(tables)) {
    if (table.role !== 'events') continue;
    const mapping = config.tables[name].mapping;
    for (const event of table.events) {
      records.push({
        table: name,
        tableOrder: tableNames.indexOf(name),
        event: { ...event },
        attributes: table.attributes?.get(event) ?? {},
        provenance: {},
        mapping
      });
    }
  }
  records.sort(compareEvents);
  const context = { config, tables };

  for (const record of records) {
    const { event } = record;
    if (event.type !== 'trade') continue;
    for (const field of [STAKE, RESULT]) {
      const mapped = record.mapping.fields[field];
      if (mapped && isFiniteNumber(event[field])) {
        record.provenance[field] = mappedLabel(field, mapped);
        continue;
      }
      const found = firstValue(field, record, config.derive[field], context);
      if (found) {
        event[field] = found.value;
        record.provenance[field] = found.label;
      } else if (mapped || config.derive[field].length) {
        event[field] = null; // unavailable, never 0
      }
    }
  }

  const events = [];
  for (const record of records) {
    const { event, provenance } = record;
    if (event.type === 'trade') {
      provenance.placed_at ??= ASSUMED;
      if (isFiniteNumber(event.realized_result) && !event.settled_at) provenance.settled_at ??= ASSUMED;
    }
    for (const field of ['balance_before', 'balance_after']) {
      if (isFiniteNumber(event[field]) && !provenance[field] && PROVENANCE_SCOPE[field].includes(event.type)) provenance[field] = OBSERVED;
    }
    for (const field of DERIVABLE_FIELDS) {
      if (!PROVENANCE_SCOPE[field].includes(event.type)) continue;
      counter.add(field, provenance[field] ?? 'unavailable');
    }
    const ordered = Object.fromEntries(DERIVABLE_FIELDS.filter((field) => provenance[field]).map((field) => [field, provenance[field]]));
    if (Object.keys(ordered).length) event[PROVENANCE_FIELD] = ordered;
    events.push(event);
  }

  return {
    events,
    report: {
      deriveVersion: DERIVE_VERSION,
      methods: Object.fromEntries(Object.entries(config.derive).filter(([, list]) => list.length).map(([field, list]) => [field, list.map((method) => method.label)])),
      byField: counter.counts,
      assumptions: ASSUMPTIONS,
      notes: notes.counts,
      note: 'Events per derivable field by source: observed (a mapped column), derived:<method> (the first configured method that gave a value), assumed (the engine default), or unavailable. Counts only, never values.'
    }
  };
}

export { eventTime };
