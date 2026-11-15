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

/** Fields whose method lists must follow a fixed order of preference (ADR-017, ADR-018). */
export const METHOD_ORDER = {};

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
  settled_at: {},
  orders: {},
  balances: {}
};

// --- Binary contracts --------------------------------------------------------------------------------
//
// A contract pays contractValue (default 1, in currency) if it wins and 0 if it loses; its
// price is price / priceScale of that (priceScale 100 for prices in cents of a 1-unit
// contract). A buy at price p for quantity q risks p q and wins (1 - p) q; a sell (writing the
// contract, or selling it short) risks (1 - p) q and wins p q. The result is the hold-to-resolution P&L:
// what the order made if held until the contract resolved. Summed over a trader's orders it is
// their P&L on those contracts, whatever closed them in between.

const CONTRACT_PARAMS = {
  price: { kind: 'number', required: true },
  quantity: { kind: 'number', required: true },
  side: { kind: 'key', required: true },
  buy: { kind: 'strings', default: ['buy'] },
  sell: { kind: 'strings', default: ['sell'] },
  priceScale: { kind: 'positive', default: 1 },
  contractValue: { kind: 'positive', default: 1 }
};

function contractTerms(attributes, params) {
  const price = attributes[params.price];
  const quantity = attributes[params.quantity];
  const side = attributes[params.side];
  if (!isFiniteNumber(price) || !isFiniteNumber(quantity) || side === null || side === undefined) return null;
  const p = price / params.priceScale;
  if (!(p >= 0 && p <= 1) || !(quantity > 0)) return null;
  const folded = String(side).toLowerCase();
  const buy = params.buy.some((value) => value.toLowerCase() === folded);
  const sell = params.sell.some((value) => value.toLowerCase() === folded);
  if (buy === sell) return null;
  return { buy, cost: p * quantity * params.contractValue, payoff: quantity * params.contractValue };
}

METHODS[STAKE]['contract-resolution'] = {
  version: '0.1',
  description: 'Binary contract: the amount at risk, price x quantity for a buy, (1 - price) x quantity for a sell.',
  params: CONTRACT_PARAMS,
  apply({ attributes }, params) {
    const terms = contractTerms(attributes, params);
    if (!terms) return null;
    return round8(terms.buy ? terms.cost : terms.payoff - terms.cost);
  }
};

METHODS[RESULT]['contract-resolution'] = {
  version: '0.1',
  description: 'Binary contract: the hold-to-resolution P&L from price, quantity, side, and whether the contract won. An unresolved contract (won blank) is unavailable.',
  params: { ...CONTRACT_PARAMS, won: { kind: 'boolean', required: true } },
  apply({ attributes }, params) {
    const terms = contractTerms(attributes, params);
    const won = attributes[params.won];
    if (!terms || typeof won !== 'boolean') return null;
    const buyResult = won ? terms.payoff - terms.cost : -terms.cost;
    return round8(terms.buy ? buyResult : -buyResult);
  }
};

// --- Joins ------------------------------------------------------------------------------------------

function joinKey(trader, key) {
  return `${trader}\u0000${key}`;
}

/** The rows a join finds for one record: [] when the key is blank or nothing matches. */
function joined(record, joinName, context) {
  const join = context.config.joins[joinName];
  const key = record.attributes[join.from.attribute];
  const stats = context.joinStats[joinName] ??= { looked: 0, found: 0 };
  if (key === null || key === undefined) return [];
  stats.looked += 1;
  let index = context.joinIndexes.get(joinName);
  if (!index) {
    index = new Map();
    const target = context.tables[join.to.table];
    for (const row of target.rows ?? []) {
      const value = row.attributes[join.to.attribute];
      if (value === null || value === undefined) continue;
      const id = join.sameTrader ? joinKey(row.traderToken, value) : value;
      if (!index.has(id)) index.set(id, []);
      index.get(id).push(row);
    }
    context.joinIndexes.set(joinName, index);
  }
  const rows = index.get(join.sameTrader ? joinKey(record.event.trader_token, key) : key) ?? [];
  if (rows.length) stats.found += 1;
  return rows;
}

// --- Decision time -------------------------------------------------------------------------------------

METHODS.placed_at['order-created'] = {
  version: '0.1',
  description: 'The order-creation time: a timestamp attribute on the trade row, or one on an orders table joined by order ID (the earliest when several rows match).',
  params: { attribute: { kind: 'timestamp' }, join: { kind: 'join' }, joinAttribute: { kind: 'joined:timestamp' } },
  check(params, where) {
    if ((params.attribute === null) === (params.join === null)) throw configError(`${where} needs attribute (on the trade row) or join and joinAttribute (on an orders table), not both.`);
    if (params.join !== null && params.joinAttribute === null) throw configError(`${where}.joinAttribute is required with join.`);
  },
  apply(record, params, context) {
    if (params.attribute !== null) return record.attributes[params.attribute] ?? null;
    const times = joined(record, params.join, context).map((row) => row.attributes[params.joinAttribute]).filter(isFiniteNumber);
    return times.length ? Math.min(...times) : null;
  }
};

// --- Outcome time ------------------------------------------------------------------------------------

METHODS.settled_at['ledger-settlement'] = {
  version: '0.1',
  description: 'The time of the settlement posting in a ledger table joined to the trade by order or position ID: the latest matching posting, so a trade settled in parts counts as settled when the last part posts.',
  params: { join: { kind: 'join', required: true }, kind: { kind: 'joined:key' }, kinds: { kind: 'strings' } },
  check(params, where, config) {
    if (config.tables[config.joins[params.join].to.table].role !== 'events') throw configError(`${where}.join must lead to a ledger table with role "events" (its rows carry posting times).`);
    if ((params.kind === null) !== (params.kinds === null)) throw configError(`${where}: kind and kinds go together (the attribute that says what a posting is, and the values that mean settlement).`);
  },
  apply(record, params, context) {
    const wanted = params.kinds ? new Set(params.kinds.map((value) => value.toLowerCase())) : null;
    const times = joined(record, params.join, context)
      .filter((row) => !wanted || wanted.has(String(row.attributes[params.kind] ?? '').toLowerCase()))
      .map((row) => row.ms);
    return times.length ? Math.max(...times) : null;
  }
};

METHODS.settled_at['trade-settlement-column'] = {
  version: '0.1',
  description: 'A settlement-time timestamp attribute on the trade row.',
  params: { attribute: { kind: 'timestamp', required: true } },
  apply({ attributes }, params) {
    return attributes[params.attribute] ?? null;
  }
};

METHODS.settled_at['market-settlement'] = {
  version: '0.1',
  description: 'The market\'s settlement or close time, from a market table joined by market ID.',
  params: { join: { kind: 'join', required: true }, attribute: { kind: 'joined:timestamp', required: true } },
  apply(record, params, context) {
    const [row] = joined(record, params.join, context);
    return row ? row.attributes[params.attribute] ?? null : null;
  }
};

METHODS.settled_at['closing-trade'] = {
  version: '0.1',
  description: 'The time of the opposite trade that closed the position: same trader and market (and contract, when given), first in first out by quantity (one unit per trade without a quantity). Runs after order merging.',
  params: {
    market: { kind: 'key', required: true },
    side: { kind: 'key', required: true },
    contract: { kind: 'key' },
    quantity: { kind: 'number' },
    buy: { kind: 'strings', default: ['buy'] },
    sell: { kind: 'strings', default: ['sell'] }
  },
  // Positions need every trade at once, so this method runs in its own pass (closingTrades).
  apply() {
    return null;
  }
};

METHOD_ORDER.settled_at = ['ledger-settlement', 'trade-settlement-column', 'market-settlement', 'closing-trade'];

// --- Orders --------------------------------------------------------------------------------------

METHODS.orders['order-id'] = {
  version: '0.1',
  description: 'Merge the legs or fills of one trader that share an order ID (one attribute, or several that together identify the order).',
  params: { key: { kind: 'key', required: true, list: true } },
  apply({ attributes }, params) {
    const keys = Array.isArray(params.key) ? params.key : [params.key];
    const values = keys.map((name) => attributes[name]);
    return values.some((value) => value === null || value === undefined) ? null : values.join('\u0000');
  }
};

METHODS.orders['account-market-side-time'] = {
  version: '0.1',
  description: 'Merge fills of one trader with the same market, side, and timestamp. A fallback for rows without an order ID.',
  params: { market: { kind: 'key', required: true }, side: { kind: 'key', required: true } },
  apply({ attributes, event }, params) {
    const market = attributes[params.market];
    const side = attributes[params.side];
    return market === null || market === undefined || side === null || side === undefined ? null : `${market}\u0000${side}\u0000${event.occurred_at}`;
  }
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
    } else if (kind === 'raw' || kind === 'table') {
      params[key] = value;
    } else if (kind === 'nonnegative') {
      if (!isFiniteNumber(value) || value < 0) throw configError(`${where}.${key} must be zero or a positive number.`);
      params[key] = value;
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
    if (field === 'balances' && derive[field].length > 1) throw configError('derive.balances takes one method: balances come from one ledger.');
    const order = METHOD_ORDER[field];
    if (order) {
      const ranks = derive[field].map((entry) => order.indexOf(entry.name));
      if (ranks.some((rank, index) => index > 0 && rank < ranks[index - 1])) {
        throw configError(`derive.${field} must list its methods in this order of preference: ${order.join(', ')}. Leave out the ones the export can't support.`);
      }
    }
  }
  derive.rowTables = [...new Set(derive.balances.map((method) => method.params.ledger))];
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

// A time method's value must not come before the trade: an order is created at or before its
// first fill, and an outcome is known at or after it. A value that breaks this is skipped, the
// next method is tried, and the skip is counted.
function firstTime(field, record, methods, context, notes) {
  const executed = eventTime(record.event);
  for (const method of methods) {
    if (!method.tables.includes(record.table) || method.name === 'closing-trade') continue;
    const value = METHODS[field][method.name].apply(record, method.params, context);
    if (!isFiniteNumber(value)) continue;
    if (field === 'placed_at' ? value > executed : value < executed) {
      notes.add(field, `${method.label}: ${field === 'placed_at' ? 'after the execution time' : 'before the trade'}, skipped`);
      continue;
    }
    return { value, label: method.label };
  }
  return null;
}

// One provenance for a merged order: assumed if any part was assumed; otherwise the first
// derived method among the parts; observed only if every part was observed.
function mergedSource(labels) {
  const present = labels.filter(Boolean);
  if (!present.length) return null;
  if (present.includes(ASSUMED)) return ASSUMED;
  return present.find((label) => label !== OBSERVED) ?? OBSERVED;
}

const SUMMED_FIELDS = [STAKE, RESULT, 'payout_amount', 'quantity'];
const SHARED_TEXT_FIELDS = ['market_id', 'market_type', 'side'];

function mergeGroup(group, notes) {
  const [first] = group;
  if (group.length === 1) return first;
  const event = { ...first.event };
  const provenance = {};
  for (const field of SUMMED_FIELDS) {
    if (!group.some((record) => record.event[field] !== undefined)) continue;
    const values = group.map((record) => record.event[field]);
    if (values.every(isFiniteNumber)) {
      event[field] = round8(values.reduce((total, value) => total + value, 0));
      if (field === STAKE || field === RESULT) provenance[field] = mergedSource(group.map((record) => record.provenance[field]));
    } else {
      event[field] = null; // one unknown part makes the order's total unavailable, never 0
      if (field === RESULT) notes.add('orders', 'merged order with a part whose result is unavailable: result unavailable');
      if (field === STAKE) notes.add('orders', 'merged order with a part whose stake is unavailable: stake unavailable');
    }
  }
  if (group.every((record) => isFiniteNumber(record.event.price) && isFiniteNumber(record.event.quantity)) && event.quantity > 0) {
    event.price = round8(group.reduce((total, record) => total + record.event.price * record.event.quantity, 0) / event.quantity);
  }
  for (const field of SHARED_TEXT_FIELDS) {
    if (new Set(group.map((record) => record.event[field] ?? null)).size > 1) notes.add('orders', `merged rows disagree on ${field}: the first row's value is kept`);
  }
  const placed = group.map((record) => record.times.placed_at).filter(Boolean);
  const settled = group.map((record) => record.times.settled_at).filter(Boolean);
  const times = {};
  if (placed.length === group.length) times.placed_at = { value: Math.min(...placed.map((item) => item.value)), label: mergedSource(placed.map((item) => item.label)) };
  // The order's outcome is known when its last part settles; if any part's time is unknown, so is the order's.
  if (settled.length === group.length) times.settled_at = { value: Math.max(...settled.map((item) => item.value)), label: mergedSource(settled.map((item) => item.label)) };
  const sums = {};
  for (const [name, value] of Object.entries(first.attributes)) {
    if (isFiniteNumber(value) && group.every((record) => isFiniteNumber(record.attributes[name]))) sums[name] = group.reduce((total, record) => total + record.attributes[name], 0);
  }
  return { ...first, event, provenance, times, rows: group.length, sums };
}

/** Groups trades into orders with the configured methods, in order: the first that gives a key wins. */
function mergeOrders(records, methods, counts, notes) {
  if (!methods.length) return records;
  const groups = new Map();
  const output = [];
  for (const record of records) {
    let key = null;
    if (record.event.type === 'trade') {
      for (const method of methods) {
        if (!method.tables.includes(record.table)) continue;
        const value = METHODS.orders[method.name].apply(record, method.params);
        if (value !== null) {
          key = `${method.name}\u0000${record.table}\u0000${record.event.trader_token}\u0000${value}`;
          record.groupMethod = method.label;
          break;
        }
      }
    }
    if (key === null) {
      output.push([record]);
      continue;
    }
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
      output.push(group);
    }
    group.push(record);
  }
  const merged = [];
  for (const group of output) {
    const record = mergeGroup(group, notes);
    if (group.length > 1) {
      counts.add('orders', group[0].groupMethod, 1);
      counts.add('rowsMerged', group[0].groupMethod, group.length - 1);
    }
    merged.push(record);
  }
  return merged;
}

/** closing-trade: FIFO lots per trader, market, and contract; a fully closed lot settles at the closing trade. */
function closingTrades(records, method, notes) {
  const { params } = method;
  const buys = new Set(params.buy.map((value) => value.toLowerCase()));
  const sells = new Set(params.sell.map((value) => value.toLowerCase()));
  const positions = new Map();
  for (const record of records) {
    if (record.event.type !== 'trade' || !method.tables.includes(record.table)) continue;
    const market = record.attributes[params.market];
    const side = String(record.attributes[params.side] ?? '').toLowerCase();
    const isBuy = buys.has(side);
    if (market === null || market === undefined || isBuy === sells.has(side)) continue;
    const contract = params.contract ? record.attributes[params.contract] ?? '' : '';
    const key = `${record.event.trader_token}\u0000${market}\u0000${contract}`;
    let position = positions.get(key);
    if (!position) {
      position = { buy: [], sell: [] };
      positions.set(key, position);
    }
    const quantity = params.quantity ? record.sums?.[params.quantity] ?? record.attributes[params.quantity] : 1;
    if (!isFiniteNumber(quantity) || quantity <= 0) continue;
    let remaining = quantity;
    const opposite = position[isBuy ? 'sell' : 'buy'];
    const time = eventTime(record.event);
    while (remaining > 1e-12 && opposite.length) {
      const lot = opposite[0];
      const take = Math.min(lot.remaining, remaining);
      lot.remaining -= take;
      remaining -= take;
      if (lot.remaining <= 1e-12) {
        opposite.shift();
        if (!lot.record.times.settled_at && time >= eventTime(lot.record.event)) {
          lot.record.times.settled_at = { value: time, label: method.label };
          notes.add('settled_at', `${method.label}: lots closed by an opposite trade`);
        }
      }
    }
    if (remaining > 1e-12) position[isBuy ? 'buy' : 'sell'].push({ record, remaining });
  }
}

// --- Balances from a cash ledger (ADR-019) ---------------------------------------------------------

export const BALANCE_DEFAULTS = Object.freeze({ toleranceAbsolute: 0.01, toleranceRelative: 0 });

METHODS.balances['ledger-replay'] = {
  version: '0.1',
  description: 'Replays the full cash ledger per account (deposits - withdrawals - stakes + payouts - fees, as the flows map them), anchored to a balance snapshot, or to zero when the extract covers the account from opening. Accounts that drift from a snapshot beyond the tolerance get no derived balances.',
  params: {
    ledger: { kind: 'table', required: true },
    flows: { kind: 'raw', required: true },
    snapshot: { kind: 'raw' },
    anchor: { kind: 'enum:snapshot|opening', default: 'snapshot' },
    toleranceAbsolute: { kind: 'nonnegative', default: BALANCE_DEFAULTS.toleranceAbsolute },
    toleranceRelative: { kind: 'nonnegative', default: BALANCE_DEFAULTS.toleranceRelative },
    linkAttribute: { kind: 'key' },
    ledgerLinkAttribute: { kind: 'raw' },
    linkTypes: { kind: 'strings' }
  },
  check(params, where, config) {
    const ledger = config.tables[params.ledger];
    if (!ledger || ledger.role !== 'events') throw configError(`${where}.ledger must name an events table: the ledger's rows carry the account and the posting time.`);
    const fold = ledger.mapping.eventType.fold;
    const numberAttribute = (name, at) => {
      if (typeof name !== 'string' || ledger.attributes[name]?.kind !== 'number') throw configError(`${at}: table "${ledger.name}" has no number attribute "${name}".`);
      return name;
    };
    if (!Array.isArray(params.flows) || !params.flows.length) throw configError(`${where}.flows must be a list of { when, add, subtract }.`);
    const seen = new Set();
    params.flows = params.flows.map((flow, index) => {
      const at = `${where}.flows[${index}]`;
      if (!isPlainObject(flow) || Object.keys(flow).some((key) => !['when', 'add', 'subtract'].includes(key))) throw configError(`${at} must be { when, add, subtract }.`);
      if (!Array.isArray(flow.when) || !flow.when.length || flow.when.some((value) => typeof value !== 'string')) throw configError(`${at}.when must list the ledger type values this flow covers.`);
      const add = (flow.add ?? []).map((name) => numberAttribute(name, `${at}.add`));
      const subtract = (flow.subtract ?? []).map((name) => numberAttribute(name, `${at}.subtract`));
      if (!add.length && !subtract.length) throw configError(`${at} adds and subtracts nothing.`);
      const when = flow.when.map((value) => fold(value));
      for (const value of when) {
        if (seen.has(value)) throw configError(`${at}: a type value is in two flows.`);
        seen.add(value);
      }
      return { when: new Set(when), add, subtract };
    });
    if (params.snapshot !== null) {
      const snapshot = params.snapshot;
      if (!isPlainObject(snapshot) || !Array.isArray(snapshot.when) || !snapshot.when.length) throw configError(`${where}.snapshot must be { when, balance }.`);
      const when = snapshot.when.map((value) => fold(String(value)));
      if (when.some((value) => seen.has(value))) throw configError(`${where}.snapshot: a snapshot type value is also a flow.`);
      params.snapshot = { when: new Set(when), balance: numberAttribute(snapshot.balance, `${where}.snapshot.balance`) };
    }
    if (params.anchor === 'snapshot' && params.snapshot === null) throw configError(`${where}: anchor "snapshot" needs snapshot rows; use anchor "opening" only when the extract covers every account from opening.`);
    if ((params.linkAttribute === null) !== (params.ledgerLinkAttribute === null)) throw configError(`${where}: linkAttribute and ledgerLinkAttribute go together.`);
    if (params.ledgerLinkAttribute !== null && ledger.attributes[params.ledgerLinkAttribute]?.kind !== 'key') throw configError(`${where}.ledgerLinkAttribute: table "${ledger.name}" has no key attribute "${params.ledgerLinkAttribute}".`);
    params.linkTypes = params.linkTypes ? new Set(params.linkTypes.map((value) => fold(value))) : null;
  },
  // Runs in its own pass (reconstructBalances).
  apply() {
    return null;
  }
};

function sessionsOf(records, gapMs) {
  const sessions = [];
  let current = null;
  let last = -Infinity;
  for (const record of records) {
    const t = eventTime(record.event);
    if (!current || t - last > gapMs) {
      current = [];
      sessions.push(current);
    }
    current.push(record);
    last = t;
  }
  return sessions;
}

/**
 * ledger-replay: per account, replay every ledger row in time order (then row order). Flow
 * rows move the balance; snapshot rows are checked against it. The anchor is the first
 * snapshot (the replay is shifted to match it) or, with anchor "opening", zero. An account is
 * left without derived balances, counted by reason, when a flow row has no amount, when it has
 * no anchor, or when the replay drifts from any snapshot by more than max(toleranceAbsolute,
 * toleranceRelative x |snapshot|). Each event's balance_before and balance_after are the
 * replayed balance just before and just after its own ledger rows: the same row for an event
 * from the ledger table, or the rows linked by linkAttribute at the event's earliest linked
 * posting time. Within one account's session, observed and derived balances never mix: a
 * session where every event has observed balances keeps them; otherwise, if the account was
 * replayed, every event in the session gets derived balances.
 */
function reconstructBalances(records, method, context, behaviorOptions) {
  const { params } = method;
  const report = { method: method.label, anchor: params.anchor, tolerance: { absolute: params.toleranceAbsolute, relative: params.toleranceRelative }, accounts: 0, replayed: 0, rejected: {}, snapshotsChecked: 0, eventsDerived: 0, eventsUnlinked: 0, observedReplaced: 0, sessionsKeptObserved: 0 };
  const reject = (reason) => { report.rejected[reason] = (report.rejected[reason] ?? 0) + 1; };
  const rows = context.tables[params.ledger].rows ?? [];
  const byTrader = new Map();
  for (const row of rows) {
    if (!byTrader.has(row.traderToken)) byTrader.set(row.traderToken, []);
    byTrader.get(row.traderToken).push(row);
  }
  // Replay: row -> { before, after } in currency, per account that passes.
  const positions = new Map();
  for (const [trader, list] of byTrader) {
    report.accounts += 1;
    list.sort((a, b) => a.ms - b.ms || a.rowNumber - b.rowNumber);
    let raw = 0;
    let broken = false;
    const steps = [];
    const snapshots = [];
    for (const row of list) {
      const flow = params.flows.find((item) => item.when.has(row.typeKey));
      if (flow) {
        // As credit-minus-debit: a blank side of a flow is 0 when another side has an amount;
        // a flow row with every amount blank is missing, and the replay can't go past it.
        const values = [...flow.add, ...flow.subtract].map((name) => row.attributes[name]);
        if (!values.some(isFiniteNumber)) {
          broken = true;
          break;
        }
        const amount = (name) => (isFiniteNumber(row.attributes[name]) ? row.attributes[name] : 0);
        const change = flow.add.reduce((total, name) => total + amount(name), 0) - flow.subtract.reduce((total, name) => total + Math.abs(amount(name)), 0);
        steps.push({ row, before: raw, after: raw + change });
        raw += change;
      } else if (params.snapshot && params.snapshot.when.has(row.typeKey)) {
        const value = row.attributes[params.snapshot.balance];
        if (isFiniteNumber(value)) snapshots.push({ raw, value });
        steps.push({ row, before: raw, after: raw });
      } else {
        steps.push({ row, before: raw, after: raw });
      }
    }
    if (broken) { reject('a flow row has no amount, so the replay would be wrong after it'); continue; }
    let offset = 0;
    if (params.anchor === 'snapshot') {
      if (!snapshots.length) { reject('no balance snapshot to anchor the replay'); continue; }
      offset = snapshots[0].value - snapshots[0].raw;
    }
    const drift = snapshots.some((snapshot) => {
      report.snapshotsChecked += 1;
      return Math.abs(snapshot.raw + offset - snapshot.value) > Math.max(params.toleranceAbsolute, params.toleranceRelative * Math.abs(snapshot.value)) + 1e-9;
    });
    if (drift) { reject('replayed balance drifts from a snapshot beyond the tolerance'); continue; }
    report.replayed += 1;
    const byRow = new Map();
    const byEvent = new Map();
    for (const step of steps) {
      const position = { before: round8(step.before + offset) + 0, after: round8(step.after + offset) + 0, row: step.row }; // + 0: never -0
      byRow.set(step.row.rowNumber, position);
      if (step.row.event) byEvent.set(step.row.event, position);
    }
    positions.set(trader, { byRow, byEvent });
  }

  // Links from events to their ledger rows.
  const linkIndex = new Map();
  if (params.linkAttribute) {
    for (const row of rows) {
      const key = row.attributes[params.ledgerLinkAttribute];
      if (key === null || key === undefined) continue;
      if (params.linkTypes && !params.linkTypes.has(row.typeKey)) continue;
      const id = `${row.traderToken}\u0000${key}`;
      if (!linkIndex.has(id)) linkIndex.set(id, []);
      linkIndex.get(id).push(row);
    }
  }
  const balanceFor = (record) => {
    const position = positions.get(record.event.trader_token);
    if (!position) return null;
    let linked = [];
    if (record.table === params.ledger && record.source) {
      const own = position.byEvent.get(record.source);
      if (own) linked = [own.row];
    } else if (params.linkAttribute && record.table !== params.ledger) {
      const key = record.attributes[params.linkAttribute];
      const found = key === null || key === undefined ? [] : linkIndex.get(`${record.event.trader_token}\u0000${key}`) ?? [];
      if (found.length) {
        const earliest = Math.min(...found.map((row) => row.ms));
        linked = found.filter((row) => row.ms === earliest);
      }
    }
    if (!linked.length) return null;
    const ordered = linked.map((row) => position.byRow.get(row.rowNumber)).filter(Boolean).sort((a, b) => a.row.ms - b.row.ms || a.row.rowNumber - b.row.rowNumber);
    if (!ordered.length) return null;
    return { before: ordered[0].before, after: ordered.at(-1).after };
  };

  const gapMs = (behaviorOptions?.sessionGapMinutes ?? 30) * 60000;
  const relevant = new Map();
  for (const record of records) {
    if (!PROVENANCE_SCOPE.balance_before.includes(record.event.type) || record.event.type === 'balance_snapshot') continue;
    if (!relevant.has(record.event.trader_token)) relevant.set(record.event.trader_token, []);
    relevant.get(record.event.trader_token).push(record);
  }
  for (const [trader, list] of relevant) {
    list.sort(compareEvents);
    for (const session of sessionsOf(list, gapMs)) {
      const observed = session.every((record) => isFiniteNumber(record.event.balance_before) && isFiniteNumber(record.event.balance_after));
      if (observed) {
        report.sessionsKeptObserved += 1;
        continue;
      }
      if (!positions.has(trader)) continue;
      const derived = session.map((record) => balanceFor(record));
      if (derived.some((value) => value === null)) {
        // One event without its ledger rows: the session can't be all derived, so none of it is.
        report.eventsUnlinked += derived.filter((value) => value === null).length;
        continue;
      }
      session.forEach((record, index) => {
        if (isFiniteNumber(record.event.balance_before) || isFiniteNumber(record.event.balance_after)) report.observedReplaced += 1;
        record.event.balance_before = derived[index].before;
        record.event.balance_after = derived[index].after;
        record.provenance.balance_before = method.label;
        record.provenance.balance_after = method.label;
        report.eventsDerived += 1;
      });
    }
  }
  return report;
}

/**
 * Derives fields on mapped events. input: { config (normalizeIntakeConfig output), tables:
 * { [name]: { role: 'events', events, attributes (WeakMap event -> attributes), rows } |
 * { role: 'lookup', rows } } }. Returns { events, report }. The mapped events are not
 * modified: every output event is a new object.
 *
 * Order: stake and result per row; decision and outcome times per row; order merging (stakes
 * and results sum, the earliest decision time and the latest outcome time); closing-trade
 * outcome times; balances from the cash ledger (ADR-019); then provenance. An outcome time is
 * kept only on a trade with a result.
 */
export function deriveEvents({ config, tables }) {
  const counter = new Counter();
  const notes = new Counter();
  const merges = new Counter();
  const tableNames = Object.keys(config.tables);
  let records = [];
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
        times: {},
        rows: 1,
        source: event,
        mapping
      });
    }
  }
  records.sort(compareEvents);
  const context = { config, tables, joinIndexes: new Map(), joinStats: {} };

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
    for (const field of ['placed_at', 'settled_at']) {
      const found = firstTime(field, record, config.derive[field], context, notes);
      if (found) record.times[field] = found;
    }
  }

  const rowsIn = records.length;
  records = mergeOrders(records, config.derive.orders, merges, notes);
  const closing = config.derive.settled_at.find((method) => method.name === 'closing-trade');
  if (closing) closingTrades(records, closing, notes);
  const balances = config.derive.balances.length ? reconstructBalances(records, config.derive.balances[0], context, config.behaviorOptions) : null;

  const events = [];
  for (const record of records) {
    const { event, provenance, times } = record;
    if (event.type === 'trade') {
      if (times.placed_at && times.placed_at.label !== ASSUMED) {
        event.placed_at = new Date(times.placed_at.value).toISOString();
        provenance.placed_at = times.placed_at.label;
      } else {
        provenance.placed_at = ASSUMED;
      }
      if (isFiniteNumber(event.realized_result)) {
        if (times.settled_at && times.settled_at.label !== ASSUMED) {
          event.settled_at = new Date(times.settled_at.value).toISOString();
          provenance.settled_at = times.settled_at.label;
        } else {
          provenance.settled_at = ASSUMED;
        }
      } else if (times.settled_at) {
        notes.add('settled_at', 'outcome time found for a trade with no result: not kept');
      }
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
  events.sort((a, b) => (a.occurred_at < b.occurred_at ? -1 : a.occurred_at > b.occurred_at ? 1 : a.source_row_number - b.source_row_number));

  return {
    events,
    report: {
      deriveVersion: DERIVE_VERSION,
      methods: Object.fromEntries(Object.entries(config.derive).filter(([, list]) => Array.isArray(list) && list.length).map(([field, list]) => [field, list.map((method) => method.label)])),
      byField: counter.counts,
      orders: config.derive.orders.length
        ? { rowsIn, eventsOut: records.length, ordersMerged: merges.counts.orders ?? {}, rowsMergedAway: merges.counts.rowsMerged ?? {} }
        : null,
      joins: context.joinStats,
      balances,
      assumptions: ASSUMPTIONS,
      notes: notes.counts,
      note: 'Events per derivable field by source: observed (a mapped column), derived:<method> (the first configured method that gave a value), assumed (the engine default), or unavailable. Counts only, never values.'
    }
  };
}

export { eventTime };
