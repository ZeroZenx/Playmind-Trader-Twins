/**
 * Writes a SYNTHETIC behavioral dataset from generateBehavioralDataset to
 * disk as two files in a directory the caller chooses:
 *
 * - <name>.events.json: label, generator version, seed, options, and the events
 *   (one event per line)
 * - <name>.truth.json: the full truth record, including each trader's true
 *   parameters, archetype, and realized counts
 *
 * Generated files are outputs, not fixtures. Don't commit them.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SYNTHETIC_LABEL } from './behavioral-generate.mjs';

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function eventsDocument(meta, events) {
  // Pretty header, then one compact event per line, so large files stay readable and diffable.
  const head = JSON.stringify(meta, null, 2).slice(0, -2); // drop the closing "\n}"
  const rows = events.map((event) => `    ${JSON.stringify(event)}`).join(',\n');
  return `${head},\n  "events": [\n${rows}\n  ]\n}\n`;
}

/**
 * Writes <truth.name>.events.json and <truth.name>.truth.json into `directory`,
 * creating it if needed. Returns { eventsPath, truthPath }.
 */
export async function writeBehavioralDataset(dataset, directory) {
  const { events, truth } = dataset ?? {};
  if (!Array.isArray(events) || !truth || typeof truth !== 'object') {
    throw new TypeError('writeBehavioralDataset: expected { events, truth } from generateBehavioralDataset');
  }
  if (truth.label !== SYNTHETIC_LABEL) {
    throw new TypeError(`writeBehavioralDataset: truth.label must be ${SYNTHETIC_LABEL}`);
  }
  if (typeof truth.name !== 'string' || !NAME_PATTERN.test(truth.name)) {
    throw new TypeError('writeBehavioralDataset: truth.name must be a plain file name');
  }
  if (typeof directory !== 'string' || !directory) {
    throw new TypeError('writeBehavioralDataset: directory must be a non-empty path');
  }

  await mkdir(directory, { recursive: true });
  const eventsPath = join(directory, `${truth.name}.events.json`);
  const truthPath = join(directory, `${truth.name}.truth.json`);
  const meta = {
    label: truth.label,
    name: truth.name,
    generatorVersion: truth.generatorVersion,
    behaviorVersion: truth.behaviorVersion,
    seed: truth.seed,
    options: truth.options,
    truthFile: `${truth.name}.truth.json`,
    eventCount: events.length,
    traderCount: truth.traderCount
  };
  await writeFile(eventsPath, eventsDocument(meta, events));
  await writeFile(truthPath, `${JSON.stringify(truth, null, 2)}\n`);
  return { eventsPath, truthPath };
}
