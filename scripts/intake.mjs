/**
 * npm run intake: local intake for a raw venue export (intake-0.2.0, docs/SPORTTRADE_INTAKE.md).
 *
 *   npm run intake -- profile <file> --label L [--categories] [--name RUN | --out DIR]
 *   npm run intake -- map --config PATH --label L [--input FILE] [--name RUN | --out DIR]
 *   npm run intake -- validate --label L (--name RUN | --events FILE) [--out DIR]
 *   npm run intake -- readiness --label L (--name RUN | --events FILE) [--out DIR]
 *   npm run intake -- run --config PATH --label L [--input FILE] [--name RUN | --out DIR]
 *                         [--traders N] [--holdout-replicates N] [--sweep-replicates N]
 *                         [--policies a,b] [--horizon-days N]
 *   npm run intake -- fields
 *
 * A multi-table config (ADR-017) reads every table's input relative to the config file; --input
 * replaces the first events table's input only.
 *
 * --label is SYNTHETIC, OBSERVATIONAL, or CUSTOMER; real Sporttrade data is CUSTOMER. Outputs go
 * to data/output/<RUN>/ (gitignored); the run name defaults to the config name or the file name.
 * Anything else needs an explicit --out. map and run need PLAYMIND_TOKEN_SALT in the
 * environment (npm run intake loads a local .env if there is one); there is no default salt.
 *
 * Nothing here prints a raw value: the console shows counts, field names, masked shapes, and
 * tokens only. All logic lives in src/intake/, which the tests run too.
 */

import { readFile } from 'node:fs/promises';
import { basename, dirname, extname, resolve } from 'node:path';
import { POLICY_V2_TYPES } from '../src/engine/policy-sim.mjs';
import { checkSalt, SALT_ENV_VAR } from '../src/intake/map.mjs';
import {
  checkCustomerLocation, checkLabel, CUSTOMER_REMINDER, eventsDocument, loadMappingConfig, mapAndDerive, profileStep,
  readSourceFile, resolveOutputDirectory, runIntakePipeline, RUN_NAME_PATTERN, writeOutputs
} from '../src/intake/pipeline.mjs';
import { renderProfileText } from '../src/intake/profile.mjs';
import { assessReadiness, renderFieldAskListMarkdown, renderReadinessMarkdown } from '../src/intake/readiness.mjs';
import { IntakeError } from '../src/intake/source.mjs';
import { validateMappedEvents } from '../src/intake/validate.mjs';

const COMMANDS = ['profile', 'map', 'validate', 'readiness', 'run', 'fields'];
const USAGE = 'Usage: npm run intake -- <profile|map|validate|readiness|run|fields> [options]. See the header of scripts/intake.mjs or docs/SPORTTRADE_INTAKE.md.';

class UsageError extends Error {}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (!COMMANDS.includes(command)) throw new UsageError(command ? `unknown command "${command}". ${USAGE}` : USAGE);
  const options = { command, positional: [] };
  const valueFlags = { '--label': 'label', '--config': 'config', '--input': 'input', '--name': 'name', '--out': 'out', '--events': 'events', '--policies': 'policies' };
  const integerFlags = { '--traders': 'traders', '--holdout-replicates': 'holdoutReplicates', '--sweep-replicates': 'sweepReplicates', '--horizon-days': 'horizonDays' };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const next = rest[index + 1];
    if (Object.hasOwn(valueFlags, flag)) {
      if (next === undefined || next.startsWith('--')) throw new UsageError(`${flag} needs a value`);
      options[valueFlags[flag]] = next;
      index += 1;
    } else if (Object.hasOwn(integerFlags, flag)) {
      const number = Number(next);
      if (!Number.isInteger(number) || number < 1) throw new UsageError(`${flag} needs a positive integer`);
      options[integerFlags[flag]] = number;
      index += 1;
    } else if (flag === '--categories') {
      options.categories = true;
    } else if (flag.startsWith('--')) {
      throw new UsageError(`unknown option ${flag}`);
    } else {
      options.positional.push(flag);
    }
  }
  if (options.policies !== undefined) {
    const types = options.policies.split(',').filter(Boolean);
    if (!types.length || types.some((type) => !POLICY_V2_TYPES.includes(type))) throw new UsageError(`--policies needs a comma-separated list from ${POLICY_V2_TYPES.join(', ')}`);
    options.policies = types;
  }
  return options;
}

function plainName(text) {
  const name = String(text).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 64);
  return RUN_NAME_PATTERN.test(name) ? name : 'intake';
}

function say(label, line) {
  console.log(`[${label}] ${line}`);
}

function remind(label) {
  if (label === 'CUSTOMER') console.log(`\n[CUSTOMER] ${CUSTOMER_REMINDER}\n`);
}

// Checked before any file is read, so a missing salt stops the command at once. Never printed.
function readSalt() {
  return checkSalt(process.env[SALT_ENV_VAR]);
}

// Loads the mapping config, then checks its location and label before any source file is read.
async function configFor(options, label) {
  const loaded = await loadMappingConfig(options.config);
  checkCustomerLocation(loaded.path, 'mapping config', { label });
  if (loaded.config.label && loaded.config.label !== label) {
    throw new IntakeError(`The mapping config says "label": "${loaded.config.label}" but --label is ${label}. Fix one of them (a config copied from the fixture still says SYNTHETIC).`);
  }
  return loaded;
}

// Reads every table's input. --input replaces the first events table's input.
async function sourcesFor(options, loaded, label) {
  const tables = {};
  for (const [name, configured] of Object.entries(loaded.inputPaths)) {
    const override = name === loaded.config.primary && options.input;
    const inputPath = override ? resolve(options.input) : configured;
    if (!inputPath) {
      throw new IntakeError(loaded.config.multiTable
        ? `No input file for table "${name}": set "input" on it in the mapping config.`
        : 'No input file: pass --input or set "input" in the mapping config.');
    }
    checkCustomerLocation(inputPath, `input file${loaded.config.multiTable ? ` for table "${name}"` : ''}`, { label });
    try {
      tables[name] = { text: await readSourceFile(inputPath), fileName: basename(inputPath), path: inputPath };
    } catch (error) {
      if (override || !(error instanceof IntakeError)) throw error;
      throw new IntakeError(`${error.message} The config's "input" is read relative to the config file; fix it${loaded.config.multiTable ? '' : ' or pass --input FILE'}.`);
    }
  }
  return tables;
}

async function loadEvents(options, label) {
  let path;
  if (options.events) path = resolve(options.events);
  else if (options.name) path = resolve(resolveOutputDirectory({ name: options.name, label }), 'events.json');
  else throw new UsageError('pass --name RUN (reads data/output/RUN/events.json) or --events FILE');
  let document;
  try {
    document = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new IntakeError(`Can't read mapped events at ${path}.`);
  }
  if (!Array.isArray(document.events)) throw new IntakeError('The events file has no events array. Produce it with npm run intake -- map.');
  if (document.label && document.label !== label) throw new IntakeError(`The events file is labelled ${document.label} but --label is ${label}.`);
  return { events: document.events, path, name: options.name ?? plainName(basename(dirname(path))) };
}

function printProvenance(label, report) {
  for (const [field, counts] of Object.entries(report.derive?.byField ?? {})) {
    say(label, `  ${field}: ${Object.entries(counts).map(([source, count]) => `${source} ${count}`).join(', ')}`);
  }
}

function printDrops(label, report) {
  for (const entry of report.dropped) say(label, `  dropped ${entry.count}: ${entry.reason}`);
  for (const entry of report.fixed) say(label, `  fixed ${entry.count}: ${entry.reason}`);
  for (const entry of report.notes ?? []) say(label, `  note ${entry.count}: ${entry.reason}`);
  for (const warning of report.warnings ?? []) say(label, `  warning: ${warning}`);
  if (report.columns?.unmapped?.length) say(label, `  unmapped columns (dropped): ${report.columns.unmapped.map((item) => `${item.column}${item.flags.length ? ` [${item.flags.join('; ')}]` : ''}`).join(', ')}`);
  if (report.unknownTypeValues?.length) say(label, `  type values not in the mapping, by shape: ${report.unknownTypeValues.map((item) => `${item.shape} x${item.count}`).join(', ')}`);
}

async function commandProfile(options, label) {
  const file = options.positional[0];
  if (!file) throw new UsageError('profile needs a file: npm run intake -- profile <file> --label L');
  const path = resolve(file);
  checkCustomerLocation(path, 'input file', { label });
  const text = await readSourceFile(path);
  const { profile } = profileStep(text, { fileName: basename(path), label, showCategories: options.categories === true });
  const directory = resolveOutputDirectory({ name: options.name ?? plainName(`profile-${basename(path, extname(path))}`), out: options.out, label });
  const [written] = await writeOutputs(directory, { 'profile.json': profile });
  console.log(renderProfileText(profile));
  say(label, `wrote ${written}`);
}

async function commandMap(options, label) {
  if (!options.config) throw new UsageError('map needs --config PATH');
  const salt = readSalt();
  const loaded = await configFor(options, label);
  const { config } = loaded;
  const tables = await sourcesFor(options, loaded, label);
  const mapped = mapAndDerive({ tables }, { config, salt, label });
  const directory = resolveOutputDirectory({ name: options.name ?? config.name, out: options.out, label });
  await writeOutputs(directory, { 'events.json': eventsDocument(mapped.events, { label, configName: config.name }), 'map-report.json': mapped.report });
  say(label, `mapped ${mapped.report.input.dataRows} data rows to ${mapped.events.length} events for ${mapped.report.output.traders} traders (${Object.entries(mapped.report.output.byType).map(([type, count]) => `${type} ${count}`).join(', ')})`);
  printDrops(label, mapped.report);
  say(label, 'sources of derived fields (events per field):');
  printProvenance(label, mapped.report);
  say(label, `wrote ${directory}`);
}

async function commandValidate(options, label) {
  const { events, name } = await loadEvents(options, label);
  const validation = validateMappedEvents(events, { label });
  const directory = resolveOutputDirectory({ name: options.name ?? name, out: options.out, label });
  await writeOutputs(directory, { 'validation.json': validation });
  say(label, `validation: ${validation.valid ? 'valid' : 'INVALID'}, ${validation.errorCount} errors, ${validation.warnings.length} warnings`);
  for (const error of validation.errors.slice(0, 10)) say(label, `  ${error}`);
  say(label, `wrote ${directory}`);
  return validation.valid ? 0 : 1;
}

async function commandReadiness(options, label) {
  const { events, name } = await loadEvents(options, label);
  const readiness = assessReadiness(events, { label });
  const directory = resolveOutputDirectory({ name: options.name ?? name, out: options.out, label });
  await writeOutputs(directory, { 'readiness.json': readiness, 'readiness.md': renderReadinessMarkdown(readiness) });
  for (const item of [...readiness.signals, ...readiness.parameters]) {
    const extra = item.unlockWith.length ? `; unlock with ${item.unlockWith.join(', ')}` : item.upgradeWith ? `; upgrade with ${item.upgradeWith.fields.join(', ')}` : '';
    say(label, `${item.kind} ${item.name}: ${item.status}${item.proxyNote ? ` (${item.proxyNote})` : ''}${extra}`);
  }
  say(label, `balance path: ${readiness.summary.balancePath}`);
  if (readiness.history.holdout) say(label, `held-out validation: ${readiness.history.holdout.eligible} of ${readiness.history.holdout.traders} traders eligible`);
  say(label, `wrote ${directory}`);
}

async function commandRun(options, label) {
  if (!options.config) throw new UsageError('run needs --config PATH');
  const salt = readSalt();
  const loaded = await configFor(options, label);
  const { config } = loaded;
  const directory = resolveOutputDirectory({ name: options.name ?? config.name, out: options.out, label });
  const tables = await sourcesFor(options, loaded, label);
  const scale = Object.fromEntries(['traders', 'holdoutReplicates', 'sweepReplicates', 'horizonDays', 'policies'].filter((key) => options[key] !== undefined).map((key) => [key, options[key]]));
  const started = Date.now();
  let lastStep = null;
  let lastReport = 0;
  const result = runIntakePipeline({
    tables,
    config,
    salt,
    label,
    options: scale,
    generatedAt: new Date().toISOString(),
    onProgress: ({ step }) => {
      const now = Date.now();
      if (step === lastStep && now - lastReport < 5000) return;
      lastStep = step;
      lastReport = now;
      process.stderr.write(`  ${step}, ${((now - started) / 1000).toFixed(0)} s\n`);
    }
  });
  const written = await writeOutputs(directory, result.outputs);
  const { summary } = result;
  // The run name is the output folder's name; say which config it came from when they differ.
  const runName = options.name ?? config.name;
  say(label, `run ${runName}${runName === config.name ? '' : ` (mapping config "${config.name}")`}: ${summary.status}`);
  say(label, `rows ${summary.counts.dataRows}, dropped ${summary.counts.droppedRows}, events ${summary.counts.events}, traders ${summary.counts.traders}${summary.counts.tradersUsed !== summary.counts.traders ? ` (${summary.counts.tradersUsed} used)` : ''}`);
  printDrops(label, result.outputs['map-report.json']);
  say(label, 'sources of derived fields (events per field):');
  printProvenance(label, result.outputs['map-report.json']);
  say(label, `validation: ${summary.validation.valid ? 'valid' : 'INVALID'} (${summary.validation.errorCount} errors)`);
  if (summary.status === 'complete') {
    say(label, `readiness: ${summary.readiness.parametersEstimable} parameters estimable, ${summary.readiness.parametersNotEstimable} not; ${summary.readiness.balancePath}`);
    say(label, `stop hazard basis: ${Object.entries(summary.stopHazardBasis).map(([basis, count]) => `${basis} ${count}`).join(', ')}`);
    say(label, `held-out validation: ${summary.holdout.eligible} of ${summary.holdout.traders} traders eligible, ${summary.holdout.compared} compared`);
  } else {
    for (const error of result.outputs['validation.json'].errors.slice(0, 10)) say(label, `  ${error}`);
  }
  say(label, `runtime ${summary.runtimeSeconds.toFixed(1)} s`);
  say(label, `wrote ${written.length} files to ${directory}`);
  return summary.status === 'complete' ? 0 : 1;
}

async function main(argv) {
  const options = parseArguments(argv);
  if (options.command === 'fields') {
    console.log(renderFieldAskListMarkdown());
    return 0;
  }
  const label = checkLabel(options.label);
  remind(label);
  const handlers = { profile: commandProfile, map: commandMap, validate: commandValidate, readiness: commandReadiness, run: commandRun };
  const code = await handlers[options.command](options, label);
  remind(label);
  return code ?? 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof UsageError) {
    console.error(`intake: ${error.message}`);
    process.exitCode = 2;
  } else if (/Maximum call stack size exceeded|Invalid (array|string) length/.test(error?.message ?? '')) {
    // An engine limit, not a user error: keep the stack so the failing step can be found.
    console.error('intake: internal error (a size limit in the code, not a problem with the input). Stack follows.');
    throw error;
  } else if (error instanceof IntakeError || error instanceof RangeError || error instanceof TypeError) {
    console.error(`intake: ${error.message}`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
