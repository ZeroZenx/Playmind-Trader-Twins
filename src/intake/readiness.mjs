/**
 * Intake readiness, version intake-readiness-0.1.0.
 *
 * From the fields present after mapping, says which behavioral signals (behavior.mjs
 * BEHAVIOR_SIGNAL_DEFINITIONS) and twin parameters (estimate.mjs TWIN_PARAMETER_DEFINITIONS)
 * are estimable, which are not and why, and which fields would unlock each. Everything is
 * derived from those two definition tables: `requires`, `anyOf`, `voluntaryNeeds`, `proxyFor`,
 * and `fallback`. Nothing here restates which field feeds which parameter.
 *
 * Two facts come from the engine's rules rather than the tables, and are stated here:
 * - FIELD_SCOPE: the event types the engine reads each field on (the same scopes report-v2's
 *   field coverage uses).
 * - Balance fields count as available only for traders whose every trade has both of them,
 *   because the engine takes the balance path per trader only then (DATA-DICTIONARY.md).
 *
 * fieldAskList() turns the same tables into the required / strongly wanted / nice to have
 * list in docs/SPORTTRADE_INTAKE.md; a test checks the doc against it.
 *
 * Pure: no I/O.
 */

import { BEHAVIOR_SIGNAL_DEFINITIONS, BEHAVIOR_VERSION } from '../engine/behavior.mjs';
import { TWIN_MODEL_VERSION, TWIN_PARAMETER_DEFINITIONS } from '../engine/estimate.mjs';
import { HOLDOUT_DEFAULTS, splitHoldout } from '../engine/holdout.mjs';
import { REQUIRED_FIELDS } from '../engine/validate.mjs';

export const READINESS_VERSION = 'intake-readiness-0.1.0';

const ALL = null;
/** Event types the engine reads each field on. null: every event. */
export const FIELD_SCOPE = Object.freeze({
  trader_token: ALL,
  occurred_at: ALL,
  type: ALL,
  stake_amount: ['trade'],
  realized_result: ['trade'],
  balance_before: ['trade'],
  balance_after: ['trade'],
  deposit_amount: ['deposit'],
  withdrawal_amount: ['withdrawal'],
  payout_amount: ['trade'],
  price: ['trade'],
  quantity: ['trade'],
  side: ['trade'],
  market_id: ['trade'],
  market_type: ['trade'],
  policy_event_type: ['policy_event'],
  policy_event_value: ['policy_event']
});
const BALANCE_FIELDS = Object.freeze(['balance_before', 'balance_after']);

function isBlank(value) {
  return value === undefined || value === null || value === '';
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function signalEntries() {
  return Object.entries(BEHAVIOR_SIGNAL_DEFINITIONS).map(([name, definition]) => ({ name, kind: 'signal', definition }));
}

function parameterEntries() {
  return Object.entries(TWIN_PARAMETER_DEFINITIONS).map(([name, definition]) => ({ name, kind: 'parameter', definition }));
}

/** Fields every signal and every parameter requires: the intersection of all `requires`. */
export function baseFields() {
  const lists = [...signalEntries(), ...parameterEntries()].map(({ definition }) => definition.requires);
  return lists.reduce((common, list) => common.filter((field) => list.includes(field)));
}

/** Parameter name -> names of parameters that are a proxy for it (proxyFor). */
function proxiesByTarget() {
  const map = {};
  for (const { name, definition } of parameterEntries()) {
    if (definition.proxyFor) (map[definition.proxyFor] ??= []).push(name);
  }
  return map;
}

// --- Field coverage ------------------------------------------------------------------------------

/**
 * Share of relevant events with each field (FIELD_SCOPE), plus the traders whose every trade has
 * both balance fields. share is null when no event is relevant (for example, no deposits).
 */
export function fieldCoverage(events) {
  const list = Array.isArray(events) ? events : [];
  const rows = Object.entries(FIELD_SCOPE).map(([field, scope]) => {
    const relevant = scope === ALL ? list : list.filter((event) => scope.includes(event.type));
    const present = relevant.filter((event) => !isBlank(event[field])).length;
    const share = relevant.length ? present / relevant.length : null;
    return {
      field,
      appliesTo: scope === ALL ? 'every event' : scope.join(', '),
      relevant: relevant.length,
      present,
      share,
      status: share === null ? 'no relevant events' : share === 1 ? 'complete' : share > 0 ? 'partial' : 'absent'
    };
  });
  const tradesByTrader = new Map();
  for (const event of list) {
    if (event.type !== 'trade') continue;
    const entry = tradesByTrader.get(event.trader_token) ?? { trades: 0, withBalances: 0 };
    entry.trades += 1;
    if (isFiniteNumber(event.balance_before) && isFiniteNumber(event.balance_after)) entry.withBalances += 1;
    tradesByTrader.set(event.trader_token, entry);
  }
  const tradersWithCompleteBalances = [...tradesByTrader.values()].filter((entry) => entry.trades > 0 && entry.withBalances === entry.trades).length;
  return { fields: rows, tradersWithTrades: tradesByTrader.size, tradersWithCompleteBalances };
}

function availability(coverage) {
  const byField = Object.fromEntries(coverage.fields.map((row) => [row.field, row]));
  return (field) => {
    if (BALANCE_FIELDS.includes(field)) return coverage.tradersWithCompleteBalances > 0;
    const row = byField[field];
    return Boolean(row && row.present > 0);
  };
}

function missingReason(field, coverage) {
  if (BALANCE_FIELDS.includes(field)) {
    return coverage.fields.find((row) => row.field === field)?.present
      ? `${field} is not on every trade for any trader`
      : `${field} is absent`;
  }
  const row = coverage.fields.find((item) => item.field === field);
  if (!row) return `${field} is absent`;
  if (row.status === 'no relevant events') return `no ${row.appliesTo} events, so ${field} can't be observed`;
  return `${field} is absent`;
}

function partialNotes(fields, coverage) {
  return fields
    .map((field) => coverage.fields.find((row) => row.field === field))
    .filter((row) => row && row.status === 'partial')
    .map((row) => `${row.field} is on ${(100 * row.share).toFixed(1)}% of ${row.appliesTo} events: estimates use the events that have it`);
}

// --- Assessment ------------------------------------------------------------------------------------

function assessSignal(name, definition, has, coverage) {
  const missingRequired = definition.requires.filter((field) => !has(field));
  const groups = definition.anyOf.map((group) => ({ fields: [...group], missing: group.filter((field) => !has(field)) }));
  const satisfied = groups.filter((group) => !group.missing.length);
  const estimable = !missingRequired.length && (!groups.length || satisfied.length > 0);
  const result = {
    name,
    kind: 'signal',
    description: definition.description,
    requires: [...definition.requires],
    anyOf: groups.map((group) => group.fields),
    status: estimable ? 'estimable' : 'not estimable',
    path: estimable && satisfied.length ? satisfied[0].fields : null,
    reasons: [],
    unlockWith: [],
    upgradeWith: null,
    notes: partialNotes([...definition.requires, ...(satisfied[0]?.fields ?? [])], coverage)
  };
  if (!estimable) {
    result.reasons = missingRequired.map((field) => missingReason(field, coverage));
    const unlock = new Set(missingRequired);
    if (groups.length && !satisfied.length) {
      const easiest = [...groups].sort((a, b) => a.missing.length - b.missing.length)[0];
      result.reasons.push(`needs one of: ${groups.map((group) => group.fields.join(' + ')).join(', or ')}`);
      for (const field of easiest.missing) unlock.add(field);
    }
    result.unlockWith = [...unlock];
  } else if (groups.length && satisfied[0] !== groups[0]) {
    result.upgradeWith = {
      fields: groups[0].missing,
      effect: `would use ${groups[0].fields.join(' + ')} (the first-choice path) instead of ${satisfied[0].fields.join(' + ')}`
    };
  }
  return result;
}

function assessParameter(name, definition, has, coverage, proxies) {
  const missing = definition.requires.filter((field) => !has(field));
  const estimable = !missing.length;
  const voluntaryMissing = (definition.voluntaryNeeds ?? []).filter((field) => !has(field));
  const variant = definition.voluntaryNeeds ? (voluntaryMissing.length ? 'all-cause' : 'voluntary') : null;
  return {
    name,
    kind: 'parameter',
    description: definition.description,
    requires: [...definition.requires],
    status: !estimable ? 'not estimable' : variant === 'all-cause' ? 'estimable (all-cause)' : 'estimable',
    variant,
    reasons: missing.map((field) => missingReason(field, coverage)),
    unlockWith: missing,
    upgradeWith: estimable && voluntaryMissing.length
      ? { fields: voluntaryMissing, effect: 'would make the estimate voluntary (stops from running out of money left out) instead of all-cause' }
      : null,
    fallback: estimable ? null : definition.fallback ?? null,
    proxyFor: definition.proxyFor ?? null,
    proxies: (proxies[name] ?? []).map((proxy) => proxy),
    notes: partialNotes(definition.requires, coverage)
  };
}

function historySummary(events, behaviorOptions) {
  const byTrader = new Map();
  for (const event of events) {
    const entry = byTrader.get(event.trader_token) ?? { trades: 0, first: Infinity, last: -Infinity };
    if (event.type === 'trade') entry.trades += 1;
    const ms = Date.parse(event.occurred_at);
    if (!Number.isNaN(ms)) {
      entry.first = Math.min(entry.first, ms);
      entry.last = Math.max(entry.last, ms);
    }
    byTrader.set(event.trader_token, entry);
  }
  const entries = [...byTrader.values()];
  let holdout = null;
  if (events.length) {
    const split = splitHoldout(events, { behaviorOptions });
    const reasons = {};
    for (const trader of split.traders) {
      if (trader.eligible) continue;
      const key = String(trader.reason).replace(/[0-9.]+/g, 'N');
      reasons[key] = (reasons[key] ?? 0) + 1;
    }
    holdout = {
      eligible: split.traders.filter((trader) => trader.eligible).length,
      traders: split.traders.length,
      ineligibleReasons: reasons,
      rule: `Held-out validation needs at least ${HOLDOUT_DEFAULTS.minTrainSessions} training sessions, ${HOLDOUT_DEFAULTS.minTestSessions} test sessions, ${HOLDOUT_DEFAULTS.minTestTrades} test trades, and ${HOLDOUT_DEFAULTS.minTestDays} test day per trader.`
    };
  }
  return {
    traders: entries.length,
    medianTradesPerTrader: median(entries.map((entry) => entry.trades)),
    medianActiveDays: median(entries.filter((entry) => entry.last >= entry.first).map((entry) => (entry.last - entry.first) / 86400000)),
    holdout
  };
}

function askListFor(items) {
  const byField = new Map();
  const add = (field, name, how) => {
    const entry = byField.get(field) ?? { field, unlocks: [], upgrades: [] };
    entry[how].push(name);
    byField.set(field, entry);
  };
  for (const item of items) {
    for (const field of item.unlockWith) add(field, item.name, 'unlocks');
    for (const field of item.upgradeWith?.fields ?? []) add(field, item.name, 'upgrades');
  }
  return [...byField.values()].sort((a, b) => (b.unlocks.length + b.upgrades.length) - (a.unlocks.length + a.upgrades.length) || (a.field < b.field ? -1 : 1));
}

/**
 * Readiness of mapped events. options: label (required), behaviorOptions (for the history
 * check's session rule). Returns { label, readinessVersion, versions, fieldCoverage, signals,
 * parameters, askList, history, summary }.
 */
export function assessReadiness(events, options = {}) {
  const { label, behaviorOptions = {} } = options;
  if (!label) throw new RangeError('assessReadiness: a data label is required');
  const list = Array.isArray(events) ? events : [];
  const coverage = fieldCoverage(list);
  const has = availability(coverage);
  const proxies = proxiesByTarget();
  const signals = signalEntries().map(({ name, definition }) => assessSignal(name, definition, has, coverage));
  const parameters = parameterEntries().map(({ name, definition }) => assessParameter(name, definition, has, coverage, proxies));
  const byName = Object.fromEntries(parameters.map((item) => [item.name, item]));
  for (const parameter of parameters) {
    if (parameter.status === 'not estimable' && parameter.proxies.length) {
      const usable = parameter.proxies.filter((proxy) => byName[proxy]?.status !== 'not estimable');
      parameter.proxyNote = usable.length ? `proxy available: ${usable.join(', ')} (not the same trigger)` : 'its proxy is not estimable either';
    }
  }
  const count = (items, status) => items.filter((item) => item.status.startsWith(status)).length;
  return {
    label,
    readinessVersion: READINESS_VERSION,
    versions: { readiness: READINESS_VERSION, behavior: BEHAVIOR_VERSION, model: TWIN_MODEL_VERSION },
    derivedFrom: 'BEHAVIOR_SIGNAL_DEFINITIONS (src/engine/behavior.mjs) and TWIN_PARAMETER_DEFINITIONS (src/engine/estimate.mjs)',
    fieldCoverage: coverage,
    signals,
    parameters,
    askList: askListFor([...signals, ...parameters]),
    history: historySummary(list, behaviorOptions),
    summary: {
      signalsEstimable: count(signals, 'estimable'),
      signalsNotEstimable: count(signals, 'not estimable'),
      parametersEstimable: count(parameters, 'estimable'),
      parametersNotEstimable: count(parameters, 'not estimable'),
      balancePath: coverage.tradersWithCompleteBalances === 0
        ? 'no balance fields: all-cause stop hazards and proxy (losing-streak) refuel'
        : coverage.tradersWithCompleteBalances === coverage.tradersWithTrades ? 'balance fields on every trade' : 'balance fields on every trade for some traders only'
    }
  };
}

// --- Field ask list (static, from the definitions) ---------------------------------------------------

/**
 * The fields PlayMind asks a venue for, in tiers, each with what it unlocks. Derived from the
 * definition tables:
 * - required: fields every definition requires, plus validate.mjs REQUIRED_FIELDS that intake
 *   fills itself (event_id, venue_id, source_row_number);
 * - strongly wanted: fields required by at least one parameter that has no proxy;
 * - nice to have: fields that only unlock a proxied parameter, a voluntary variant, or an
 *   alternative signal path, and fields no definition reads.
 */
export function fieldAskList() {
  const base = baseFields();
  const proxies = proxiesByTarget();
  const definitions = [...signalEntries(), ...parameterEntries()];
  const fields = [...new Set([...base, ...REQUIRED_FIELDS, ...Object.keys(FIELD_SCOPE)])];
  return fields.map((field) => {
    const requiredBy = definitions.filter(({ definition }) => definition.requires.includes(field)).map(({ name, kind }) => ({ name, kind }));
    const alternativeIn = signalEntries().filter(({ definition }) => definition.anyOf.some((group) => group.includes(field))).map(({ name }) => name);
    const voluntaryFor = parameterEntries().filter(({ definition }) => (definition.voluntaryNeeds ?? []).includes(field)).map(({ name }) => name);
    const parametersWithoutProxy = requiredBy.filter((item) => item.kind === 'parameter' && !proxies[item.name]);
    let tier;
    let source;
    if (base.includes(field)) {
      tier = 'required';
      source = 'from the venue';
    } else if (REQUIRED_FIELDS.includes(field)) {
      tier = 'required';
      source = 'filled by intake';
    } else if (parametersWithoutProxy.length) {
      tier = 'strongly wanted';
      source = 'from the venue';
    } else {
      tier = 'nice to have';
      source = 'from the venue';
    }
    const readByDefinitions = requiredBy.length > 0 || alternativeIn.length > 0 || voluntaryFor.length > 0;
    return {
      field,
      tier,
      source,
      requiredByParameters: requiredBy.filter((item) => item.kind === 'parameter').map((item) => (proxies[item.name] ? `${item.name} (without it: proxy ${proxies[item.name].join(', ')})` : item.name)),
      requiredBySignals: requiredBy.filter((item) => item.kind === 'signal').map((item) => item.name),
      alternativePathIn: alternativeIn,
      voluntaryVariantOf: voluntaryFor,
      readByDefinitions
    };
  });
}

function describeAsk(row) {
  if (row.source === 'filled by intake') return 'Filled by intake (tokenized source ID or row number, the config venue, the file line).';
  if (row.tier === 'required' && row.field !== 'trader_token') return 'Every signal and parameter.';
  if (row.field === 'trader_token') return 'Every signal and parameter. Sent as a stable account ID; intake tokenizes it.';
  const parts = [];
  if (row.requiredByParameters.length) parts.push(`Parameters: ${row.requiredByParameters.join(', ')}.`);
  if (row.requiredBySignals.length) parts.push(`Signals: ${row.requiredBySignals.join(', ')}.`);
  if (row.alternativePathIn.length) parts.push(`Alternative path in signals: ${row.alternativePathIn.join(', ')}.`);
  if (row.voluntaryVariantOf.length) parts.push(`Makes ${row.voluntaryVariantOf.join(', ')} voluntary instead of all-cause.`);
  if (!row.readByDefinitions) parts.push('Not read by any signal or parameter definition. Optional.');
  return parts.join(' ');
}

const TIER_ORDER = ['required', 'strongly wanted', 'nice to have'];

/** The ask list as a Markdown table. docs/SPORTTRADE_INTAKE.md embeds this output. */
export function renderFieldAskListMarkdown() {
  const rows = fieldAskList().sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier));
  const lines = ['| Tier | Field | What it unlocks |', '| --- | --- | --- |'];
  for (const row of rows) lines.push(`| ${row.tier} | \`${row.field}\` | ${describeAsk(row)} |`);
  return lines.join('\n');
}

function pct(share) {
  return share === null ? 'n/a' : `${(100 * share).toFixed(1)}%`;
}

/** The readiness report as Markdown, for the ask list to Sporttrade. It carries the label. */
export function renderReadinessMarkdown(readiness) {
  const lines = [];
  lines.push(`# Intake readiness (${readiness.label})`);
  lines.push('');
  lines.push(`Data label: **${readiness.label}**. ${readiness.label === 'CUSTOMER' ? 'Customer-derived: keep this file out of the repo.' : ''}`.trim());
  lines.push(`Versions: ${readiness.readinessVersion}, ${readiness.versions.behavior}, ${readiness.versions.model}. Derived from ${readiness.derivedFrom}.`);
  lines.push('');
  lines.push(`Balance path: ${readiness.summary.balancePath}.`);
  lines.push('');
  lines.push('## Field coverage');
  lines.push('');
  lines.push('| Field | Read on | Present | Share |');
  lines.push('| --- | --- | --- | --- |');
  for (const row of readiness.fieldCoverage.fields) lines.push(`| \`${row.field}\` | ${row.appliesTo} | ${row.present} of ${row.relevant} | ${pct(row.share)} |`);
  lines.push('');
  lines.push(`Traders with balance fields on every trade: ${readiness.fieldCoverage.tradersWithCompleteBalances} of ${readiness.fieldCoverage.tradersWithTrades}.`);
  lines.push('');
  for (const [title, items] of [['Behavioral signals', readiness.signals], ['Twin parameters', readiness.parameters]]) {
    lines.push(`## ${title}`);
    lines.push('');
    lines.push('| Name | Status | Why | Fields that would unlock or upgrade it |');
    lines.push('| --- | --- | --- | --- |');
    for (const item of items) {
      const why = [...item.reasons, ...(item.path ? [`path: ${item.path.join(' + ')}`] : []), ...(item.proxyNote ? [item.proxyNote] : []), ...item.notes].join('; ') || '';
      const unlock = item.unlockWith.length ? `unlock: ${item.unlockWith.join(', ')}` : item.upgradeWith ? `upgrade: ${item.upgradeWith.fields.join(', ')} (${item.upgradeWith.effect})` : '';
      lines.push(`| ${item.name} | ${item.status} | ${why} | ${unlock} |`);
    }
    lines.push('');
  }
  lines.push('## Ask list for this dataset');
  lines.push('');
  if (!readiness.askList.length) lines.push('Every signal and parameter is estimable from the fields present.');
  for (const entry of readiness.askList) {
    lines.push(`- \`${entry.field}\`: ${entry.unlocks.length ? `unlocks ${entry.unlocks.join(', ')}` : ''}${entry.unlocks.length && entry.upgrades.length ? '; ' : ''}${entry.upgrades.length ? `upgrades ${entry.upgrades.join(', ')}` : ''}.`);
  }
  lines.push('');
  lines.push('## History depth');
  lines.push('');
  const { history } = readiness;
  lines.push(`Traders: ${history.traders}. Median trades per trader: ${history.medianTradesPerTrader ?? 'n/a'}. Median active days: ${history.medianActiveDays === null ? 'n/a' : history.medianActiveDays.toFixed(1)}.`);
  if (history.holdout) {
    lines.push(`Held-out validation: ${history.holdout.eligible} of ${history.holdout.traders} traders eligible. ${history.holdout.rule}`);
    for (const [reason, count] of Object.entries(history.holdout.ineligibleReasons)) lines.push(`- ${count} not eligible: ${reason}`);
  }
  lines.push('');
  return lines.join('\n');
}
