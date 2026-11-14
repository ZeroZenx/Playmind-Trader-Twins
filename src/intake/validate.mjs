/**
 * Intake validation, version intake-validate-0.1.0.
 *
 * Runs the engine's validateEvents on mapped events, plus the PII-header rejection: no key of
 * any event may be a prohibited field. The prohibited list is validate.mjs's
 * PROHIBITED_FIELDS, which test/intake-validate.test.mjs checks against the forbidden headers
 * in src/lib/ingestion.ts, so the CLI and the upload path reject the same headers. Keys are
 * normalized both ways those files do it (validate.mjs: trim, lowercase, whitespace to "_";
 * ingestion.ts: trim, lowercase).
 *
 * Messages carry row numbers and field names, never values. Pure: no I/O.
 */

import { PROHIBITED_FIELDS, validateEvents } from '../engine/validate.mjs';
import { prohibitedFieldFor } from './pii.mjs';

export const INTAKE_VALIDATE_VERSION = 'intake-validate-0.1.0';
export const MAX_LISTED_ERRORS = 50;

/** The prohibited field names that appear among the keys of the events, normalized. */
export function prohibitedKeys(events) {
  const keys = new Set();
  for (const event of events ?? []) for (const key of Object.keys(event ?? {})) keys.add(key);
  return [...new Set([...keys].map(prohibitedFieldFor).filter(Boolean))].sort();
}

/**
 * Returns { label, validateVersion, valid, piiHeaders, errorCount, errors (first
 * MAX_LISTED_ERRORS), warnings, stats }. valid needs no PII header and no engine error.
 */
export function validateMappedEvents(events, { label } = {}) {
  if (!label) throw new RangeError('validateMappedEvents: a data label is required');
  const piiHeaders = prohibitedKeys(events);
  const engine = validateEvents(events);
  const errors = [
    ...piiHeaders.map((field) => `Mapped events contain the prohibited field "${field}". Remove it from the mapping.`),
    ...engine.errors
  ];
  return {
    label,
    validateVersion: INTAKE_VALIDATE_VERSION,
    valid: errors.length === 0,
    piiHeaders,
    prohibitedFields: [...PROHIBITED_FIELDS].sort(),
    errorCount: errors.length,
    errors: errors.slice(0, MAX_LISTED_ERRORS),
    warnings: engine.warnings,
    stats: engine.stats
  };
}
