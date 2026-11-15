/**
 * Intake pipeline, version intake-0.2.0 (ADR-016, ADR-017).
 *
 * profile -> map (per table) -> derive -> validate -> readiness -> estimateTwins ->
 * runHoldoutValidation -> runPolicySweep -> buildReportV2 + renderReportV2Html, on one raw
 * export (a single-file config) or several source tables (a multi-table config, tables.mjs)
 * and one mapping config. scripts/intake.mjs (npm run intake) and test/intake-pipeline.test.mjs
 * run this same code. intake-0.2.0 is intake-0.1.0 plus multi-table configs and the derive
 * stage (derive.mjs); a single-file config maps exactly as before, and derive then only adds
 * provenance.
 *
 * Output location (ADR-016): data/output/<run-name>/ under the repo, which is gitignored. A run
 * name must be a plain name, so a default run can't write outside data/. Writing anywhere else
 * needs an explicit out directory. CUSTOMER runs refuse an input, config, or out directory
 * inside the repo but outside data/.
 *
 * Every output carries the data label. No output holds a raw trader or event ID: map replaces
 * them with HMAC tokens before anything else sees the events.
 *
 * runIntakePipeline is pure apart from the clock it reads for the runtime; loadMappingConfig,
 * readSourceFile, and writeOutputs do the I/O.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_LABELS, estimateTwins } from '../engine/estimate.mjs';
import { runHoldoutValidation } from '../engine/holdout.mjs';
import { POLICY_V2_TYPES, runPolicySweep } from '../engine/policy-sim.mjs';
import { buildReportV2, renderReportV2Html } from '../engine/report-v2.mjs';
import { lastObservedBalances } from '../engine/simulate.mjs';
import { DERIVE_VERSION, deriveEvents } from './derive.mjs';
import { MAP_VERSION, mapSource } from './map.mjs';
import { profileSource, PROFILE_VERSION } from './profile.mjs';
import { assessReadiness, READINESS_VERSION, renderReadinessMarkdown } from './readiness.mjs';
import { IntakeError, parseSource } from './source.mjs';
import { normalizeIntakeConfig, readLookupTable, TABLES_VERSION } from './tables.mjs';
import { INTAKE_VALIDATE_VERSION, validateMappedEvents } from './validate.mjs';

export const INTAKE_VERSION = 'intake-0.2.0';
export const REPO_ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));
export const RUN_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const CUSTOMER_REMINDER = 'CUSTOMER data: every output of this run is customer-derived. Keep it under data/ (gitignored) or outside the repo. Never commit it, paste it into an issue or chat, or share it outside the customer agreement.';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Defaults for run. Scale down with traders, the replicate counts, policies, or horizonDays. */
export const INTAKE_RUN_DEFAULTS = deepFreeze({
  traders: null,
  holdoutSeed: 7100,
  holdoutReplicates: 40,
  sweepSeed: 7200,
  sweepReplicates: 30,
  horizonDays: 28,
  policies: POLICY_V2_TYPES
});

// --- Locations ---------------------------------------------------------------------------------------

export function isInside(child, parent) {
  const path = relative(resolve(parent), resolve(child));
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

/**
 * Where a command writes. Without `out`, data/output/<name>/ under repoRoot, and `name` must be
 * a plain name: anything else is refused, so nothing is written outside data/. With `out`, that
 * directory, except that CUSTOMER outputs inside the repo must be under data/.
 */
export function resolveOutputDirectory({ name, out = null, label, repoRoot = REPO_ROOT }) {
  const dataRoot = resolve(repoRoot, 'data');
  if (out !== null && out !== undefined) {
    if (typeof out !== 'string' || !out.trim()) throw new IntakeError('--out needs a directory.');
    const directory = resolve(out);
    if (label === 'CUSTOMER' && isInside(directory, repoRoot) && !isInside(directory, dataRoot)) {
      throw new IntakeError('Refusing to write CUSTOMER outputs inside the repo outside data/. Use a directory under data/ or outside the repo.');
    }
    return directory;
  }
  if (typeof name !== 'string' || !RUN_NAME_PATTERN.test(name) || name.includes('..')) {
    throw new IntakeError('Refusing to write outside data/: the run name must be a plain name (letters, digits, ".", "_", "-"). Pass --out to choose another directory explicitly.');
  }
  const directory = resolve(dataRoot, 'output', name);
  if (!isInside(directory, dataRoot)) throw new IntakeError('Refusing to write outside data/.');
  return directory;
}

/** CUSTOMER files must not sit in the repo outside data/ (CLAUDE.md data boundary). */
export function checkCustomerLocation(path, what, { label, repoRoot = REPO_ROOT }) {
  if (label !== 'CUSTOMER' || !path) return;
  if (isInside(path, repoRoot) && !isInside(path, resolve(repoRoot, 'data'))) {
    throw new IntakeError(`The ${what} is inside the repo but outside data/. CUSTOMER files must live under data/ (gitignored) or outside the repo. Move it first.`);
  }
}

export function checkLabel(label) {
  if (!DATA_LABELS.includes(label)) throw new IntakeError(`--label is required: one of ${DATA_LABELS.join(', ')}. Real Sporttrade data is CUSTOMER.`);
  return label;
}

// --- I/O helpers -----------------------------------------------------------------------------------------

/**
 * Reads a mapping config. Returns { raw, config (normalizeIntakeConfig output), path,
 * inputPath (the single or first events table's input), inputPaths (table -> path or null) }.
 * Inputs are read relative to the config file.
 */
export async function loadMappingConfig(path) {
  const configPath = resolve(path);
  let text;
  try {
    text = await readFile(configPath, 'utf8');
  } catch {
    throw new IntakeError(`Can't read the mapping config at ${configPath}.`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new IntakeError('The mapping config is not valid JSON.');
  }
  const config = normalizeIntakeConfig(raw);
  const inputPaths = Object.fromEntries(Object.values(config.tables).map((table) => [table.name, table.input ? resolve(dirname(configPath), table.input) : null]));
  return { raw, config, path: configPath, inputPath: inputPaths[config.primary], inputPaths };
}

export async function readSourceFile(path) {
  try {
    return await readFile(resolve(path), 'utf8');
  } catch {
    throw new IntakeError(`Can't read the source file at ${resolve(path)}.`);
  }
}

/** Writes { file: content } into directory. JSON values are serialized; strings are written as is. */
export async function writeOutputs(directory, outputs) {
  await mkdir(directory, { recursive: true });
  const written = [];
  for (const [file, content] of Object.entries(outputs)) {
    const path = join(directory, file);
    await writeFile(path, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
    written.push(path);
  }
  return written;
}

// --- Steps ------------------------------------------------------------------------------------------------

export function profileStep(text, { fileName = null, label, source = {}, showCategories = false }) {
  const parsed = parseSource(text, { fileName, format: source.format ?? undefined, delimiter: source.delimiter ?? undefined, commentPrefix: source.commentPrefix ?? '#' });
  return { parsed, profile: profileSource(parsed, { label, sourceName: fileName, showCategories }) };
}

export function eventsDocument(events, { label, configName }) {
  return { label, intakeVersion: INTAKE_VERSION, mapVersion: MAP_VERSION, deriveVersion: DERIVE_VERSION, configName, eventCount: events.length, events };
}

/** Tables whose captured rows a join or a derivation reads (map.mjs captureRows). */
function tablesNeedingRows(config) {
  const names = new Set();
  for (const join of Object.values(config.joins)) if (config.tables[join.to.table].role === 'events') names.add(join.to.table);
  for (const name of config.derive.rowTables ?? []) names.add(name);
  return names;
}

/**
 * Normalizes the source inputs: { [table]: { text, fileName } }. A single-file config also
 * takes { text, fileName } directly, as in intake-0.1.0.
 */
function sourceInputs(input, config) {
  const given = input.tables ?? (input.text !== undefined ? { [config.primary]: { text: input.text, fileName: input.fileName ?? null } } : {});
  for (const name of Object.keys(config.tables)) {
    if (typeof given[name]?.text !== 'string') throw new IntakeError(`No source text for table "${name}".`);
  }
  for (const name of Object.keys(given)) if (!config.tables[name]) throw new IntakeError(`Source given for unknown table "${name}".`);
  return given;
}

/**
 * Profiles, maps, and derives every table. input: { text, fileName } (single-file) or
 * { tables: { [name]: { text, fileName } } }, plus config, salt, label. Returns { profiles,
 * events, report, tableReports }. report is the map report: for a single-file config the
 * intake-0.1.0 map report plus `derive`; for a multi-table config the same keys summed over
 * tables, with each table's report under `tables`.
 */
export function mapAndDerive(input, { config: configInput, salt, label, showCategories = false }) {
  const config = normalizeIntakeConfig(configInput);
  const sources = sourceInputs(input, config);
  const needRows = tablesNeedingRows(config);
  const profiles = {};
  const mappedTables = {};
  const tableReports = {};
  for (const table of Object.values(config.tables)) {
    const { text, fileName } = sources[table.name];
    const { parsed, profile } = profileStep(text, { fileName, label, source: table.source, showCategories });
    profiles[table.name] = profile;
    if (table.role === 'events') {
      const mapped = mapSource(parsed, table.mapping, { salt, label, captureRows: needRows.has(table.name) });
      mappedTables[table.name] = { role: 'events', events: mapped.events, attributes: mapped.attributes, rows: mapped.rows };
      tableReports[table.name] = mapped.report;
    } else {
      const lookup = readLookupTable(parsed, table);
      mappedTables[table.name] = { role: 'lookup', rows: lookup.rows };
      tableReports[table.name] = lookup.report;
    }
  }
  const derived = deriveEvents({ config, tables: mappedTables, behaviorOptions: config.behaviorOptions });
  const traders = new Set(derived.events.map((event) => event.trader_token)).size;
  let report;
  if (!config.multiTable) {
    report = { ...tableReports[config.primary], derive: derived.report };
    report.output = { ...report.output, events: derived.events.length, traders };
  } else {
    const reports = Object.values(tableReports);
    const byType = {};
    for (const event of derived.events) byType[event.type] = (byType[event.type] ?? 0) + 1;
    const tagged = (key) => Object.entries(tableReports).flatMap(([name, item]) => (item[key] ?? []).map((entry) => ({ ...entry, reason: `${name}: ${entry.reason}` })));
    report = {
      label,
      mapVersion: MAP_VERSION,
      versions: { map: MAP_VERSION, tables: TABLES_VERSION, derive: DERIVE_VERSION },
      configName: config.name,
      input: { tables: Object.keys(tableReports).length, dataRows: reports.reduce((sum, item) => sum + item.input.dataRows, 0) },
      output: { events: derived.events.length, traders, byType },
      dropped: tagged('dropped'),
      fixed: tagged('fixed'),
      notes: tagged('notes'),
      droppedTotal: reports.reduce((sum, item) => sum + item.droppedTotal, 0),
      warnings: Object.entries(tableReports).flatMap(([name, item]) => (item.warnings ?? []).map((warning) => `${name}: ${warning}`)),
      columns: { unmapped: Object.entries(tableReports).flatMap(([name, item]) => item.columns.unmapped.map((column) => ({ ...column, column: `${name}.${column.column}`, flags: column.flags ?? [] }))) },
      unknownTypeValues: Object.entries(tableReports).flatMap(([name, item]) => (item.unknownTypeValues ?? []).map((entry) => ({ ...entry, shape: `${name}: ${entry.shape}` }))),
      joins: Object.values(config.joins).map((join) => ({ name: join.name, from: `${join.from.table}.${join.from.attribute}`, to: `${join.to.table}.${join.to.attribute}` })),
      tables: tableReports,
      derive: derived.report
    };
  }
  return { config, profiles, events: derived.events, report, tableReports };
}

/** The first `count` trader tokens in sorted order (tokens are HMACs, so this is an arbitrary subset). */
export function selectTraders(events, count) {
  if (count === null || count === undefined) return events;
  const tokens = [...new Set(events.map((event) => event.trader_token))].sort().slice(0, count);
  const keep = new Set(tokens);
  return events.filter((event) => keep.has(event.trader_token));
}

function checkRunOptions(options) {
  for (const key of Object.keys(options)) {
    if (!Object.hasOwn(INTAKE_RUN_DEFAULTS, key)) throw new IntakeError(`Unknown run option "${key}".`);
  }
  const settings = { ...INTAKE_RUN_DEFAULTS, ...options };
  const positive = (value, name, minimum = 1) => {
    if (!Number.isInteger(value) || value < minimum) throw new IntakeError(`${name} must be an integer of at least ${minimum}.`);
  };
  if (settings.traders !== null) positive(settings.traders, 'traders');
  positive(settings.holdoutReplicates, 'holdoutReplicates');
  positive(settings.sweepReplicates, 'sweepReplicates');
  positive(settings.horizonDays, 'horizonDays');
  if (!Array.isArray(settings.policies) || !settings.policies.length || settings.policies.some((type) => !POLICY_V2_TYPES.includes(type))) {
    throw new IntakeError(`policies must be a list from ${POLICY_V2_TYPES.join(', ')}.`);
  }
  return settings;
}

function tally(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

/**
 * Runs the whole pipeline in memory. input: { text, fileName } for a single-file config, or
 * { tables: { [name]: { text, fileName } } } for a multi-table one; plus config (raw or
 * normalized), salt, label, options (INTAKE_RUN_DEFAULTS), generatedAt, onProgress. Returns
 * { status ('complete' or 'invalid'), outputs ({ file: content }), summary }. Stops after
 * validation when the derived events are invalid, and still returns what it has.
 */
export function runIntakePipeline(input) {
  const started = Date.now();
  const label = checkLabel(input.label);
  const config = normalizeIntakeConfig(input.config);
  const settings = checkRunOptions(input.options ?? {});
  const progress = (step, detail = {}) => { if (input.onProgress) input.onProgress({ step, ...detail }); };
  const outputs = {};

  progress('profile');
  progress('map');
  const mapped = mapAndDerive(input, { config, salt: input.salt, label });
  outputs['profile.json'] = config.multiTable ? { label, tables: mapped.profiles } : mapped.profiles[config.primary];
  progress('derive');
  outputs['map-report.json'] = mapped.report;
  const events = selectTraders(mapped.events, settings.traders);
  outputs['events.json'] = eventsDocument(events, { label, configName: config.name });

  progress('validate');
  const validation = validateMappedEvents(events, { label });
  outputs['validation.json'] = validation;

  const summary = {
    label,
    intakeVersion: INTAKE_VERSION,
    versions: { intake: INTAKE_VERSION, profile: PROFILE_VERSION, map: MAP_VERSION, tables: TABLES_VERSION, derive: DERIVE_VERSION, validate: INTAKE_VALIDATE_VERSION, readiness: READINESS_VERSION },
    name: config.name,
    status: null,
    settings: { ...settings, policies: [...settings.policies] },
    counts: {
      dataRows: mapped.report.input.dataRows,
      droppedRows: mapped.report.droppedTotal,
      events: mapped.events.length,
      traders: mapped.report.output.traders,
      tradersUsed: new Set(events.map((event) => event.trader_token)).size,
      eventsUsed: events.length
    },
    dropped: mapped.report.dropped.map(({ reason, count }) => ({ reason, count })),
    tables: Object.keys(config.tables),
    provenance: mapped.report.derive.byField,
    validation: { valid: validation.valid, errorCount: validation.errorCount, warnings: validation.warnings.length },
    customerReminder: label === 'CUSTOMER' ? CUSTOMER_REMINDER : null
  };

  if (!validation.valid) {
    summary.status = 'invalid';
    summary.runtimeSeconds = (Date.now() - started) / 1000;
    outputs['run-summary.json'] = summary;
    return { status: 'invalid', outputs, summary };
  }

  progress('readiness');
  const behaviorOptions = config.behaviorOptions;
  const readiness = assessReadiness(events, { label, behaviorOptions });
  outputs['readiness.json'] = readiness;
  outputs['readiness.md'] = renderReadinessMarkdown(readiness);

  progress('fit');
  const fit = estimateTwins(events, { dataLabel: label, behaviorOptions });

  progress('holdout');
  const holdout = runHoldoutValidation(events, {
    dataLabel: label,
    behaviorOptions,
    seed: settings.holdoutSeed,
    replicates: settings.holdoutReplicates,
    onProgress: input.onProgress ? (detail) => progress('holdout', detail) : null
  });

  progress('sweep');
  const sweep = runPolicySweep(fit, { policies: [...settings.policies] }, {
    seed: settings.sweepSeed,
    replicates: settings.sweepReplicates,
    horizonDays: settings.horizonDays,
    startingBalances: lastObservedBalances(events),
    onProgress: input.onProgress ? (detail) => progress('sweep', detail) : undefined
  });

  progress('report');
  const report = buildReportV2({
    dataset: { events, name: config.name, venueId: config.venueId, generator: `${INTAKE_VERSION} (mapping config "${config.name}")` },
    quality: validation,
    fit,
    holdout,
    sweep,
    generatedAt: input.generatedAt ?? null
  });
  const runtimeSeconds = (Date.now() - started) / 1000;
  outputs['report-v2.json'] = { ...report, label, runtimeSeconds };
  outputs['report-v2.html'] = renderReportV2Html(report);

  summary.status = 'complete';
  summary.readiness = readiness.summary;
  summary.holdout = { traders: holdout.inputs.traders, eligible: holdout.inputs.eligible, compared: holdout.inputs.compared, balancePath: holdout.inputs.balancePath };
  summary.stopHazardBasis = tally(fit.twins.map((twin) => twin.stopHazardBasis ?? 'not estimable'));
  summary.validationClaimEarned = report.sections.validation.overall?.claimEarned ?? null;
  summary.reportVersion = report.reportVersion;
  summary.runtimeSeconds = runtimeSeconds;
  outputs['run-summary.json'] = summary;
  return { status: 'complete', outputs, summary };
}
