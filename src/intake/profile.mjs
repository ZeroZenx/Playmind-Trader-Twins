/**
 * Intake profile, version intake-profile-0.1.0.
 *
 * Describes a raw export without showing its contents: columns, inferred types, null rates,
 * row count, date range, masked value shapes ("A9AA-9999"), lengths, and character classes.
 * Flags columns that look like PII or raw identifiers, by header and by value shape.
 *
 * The rule: no raw value is ever returned or printed. Exceptions, all of them non-identifying:
 * - the date range of timestamp columns that are not flagged;
 * - with showCategories, the distinct values of a low-cardinality column that is not flagged,
 *   when each value occurs at least CATEGORY_RULES.minCount times and has no digit run or "@"
 *   (for reading event-type codes such as BET or DEPOSIT). Off by default.
 * test/intake-profile.test.mjs checks the output for every raw identifier in the fixtures.
 *
 * Pure: no I/O.
 */

import { characterClasses, classifyColumn, maskValue, PII_RULES_VERSION } from './pii.mjs';
import { cleanCell, SOURCE_VERSION } from './source.mjs';
import { parseTimestamp, resolveTimeZone, timestampStyle, valueKind, VALUES_VERSION } from './values.mjs';

export const PROFILE_VERSION = 'intake-profile-0.1.0';
const UTC_ZONE = resolveTimeZone('UTC');
export const TOP_SHAPES = 5;
export const CATEGORY_RULES = Object.freeze({ maxDistinct: 25, minCount: 5, maxLength: 32 });

function tallyMap(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function topEntries(counts, limit) {
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, limit);
}

function inferType(kinds, total) {
  if (!total) return { type: 'empty', breakdown: {} };
  const breakdown = Object.fromEntries([...kinds.entries()].sort((a, b) => b[1] - a[1]));
  const numeric = (kinds.get('integer') ?? 0) + (kinds.get('decimal') ?? 0);
  if ((kinds.get('integer') ?? 0) === total) return { type: 'integer', breakdown };
  if (numeric === total) return { type: 'decimal', breakdown };
  for (const kind of ['timestamp', 'boolean', 'text']) {
    if ((kinds.get(kind) ?? 0) === total) return { type: kind, breakdown };
  }
  if (numeric / total >= 0.95) return { type: 'mostly numeric', breakdown };
  return { type: 'mixed', breakdown };
}

function numericSummary(values) {
  let negative = 0;
  let zero = 0;
  let decimalPlaces = 0;
  let minDigits = Infinity;
  let maxDigits = 0;
  for (const text of values) {
    const body = text.replace(/,/g, '');
    const number = Number(body);
    if (!Number.isFinite(number)) continue;
    if (number < 0) negative += 1;
    if (number === 0) zero += 1;
    const [whole, fraction = ''] = body.replace(/^[+-]/, '').split('.');
    decimalPlaces = Math.max(decimalPlaces, fraction.length);
    const digits = whole.replace(/^0+(?=\d)/, '').length;
    minDigits = Math.min(minDigits, digits);
    maxDigits = Math.max(maxDigits, digits);
  }
  return {
    negative,
    zero,
    maxDecimalPlaces: decimalPlaces,
    integerDigits: minDigits === Infinity ? null : { min: minDigits, max: maxDigits },
    hint: decimalPlaces === 0 && maxDigits >= 3 ? 'whole numbers: could be cents (minor units)' : decimalPlaces === 2 ? 'two decimal places: could be dollars (major units)' : null
  };
}

function timestampSummary(values, flagged) {
  const styles = new Map();
  let min = null;
  let max = null;
  for (const text of values) {
    const style = timestampStyle(text);
    if (!style) continue;
    styles.set(style, (styles.get(style) ?? 0) + 1);
    if (style === 'slash_date') continue; // day/month order unknown
    const parsed = parseTimestamp(text, { format: 'iso', zone: UTC_ZONE });
    if (!parsed.iso) continue;
    const ms = Date.parse(parsed.iso);
    if (min === null || ms < min) min = ms;
    if (max === null || ms > max) max = ms;
  }
  const naive = (styles.get('iso_naive') ?? 0) + (styles.get('date_only') ?? 0);
  return {
    styles: Object.fromEntries(styles),
    range: flagged || min === null ? null : {
      start: new Date(min).toISOString(),
      end: new Date(max).toISOString(),
      note: naive ? 'Timestamps without an offset were read as UTC for this range. Set the true time zone in the mapping config.' : null
    },
    slashDates: styles.has('slash_date') ? 'Slash dates: day/month order unknown. Set format mdy or dmy in the mapping config. No range shown for them.' : null
  };
}

function categories(values, column, total) {
  if (column.pii || column.personIdentifier || column.identifierShape) return { shown: false, reason: 'column is flagged' };
  const counts = tallyMap(values);
  if (counts.size > CATEGORY_RULES.maxDistinct) return { shown: false, reason: `more than ${CATEGORY_RULES.maxDistinct} distinct values` };
  const shown = [];
  let hidden = 0;
  let hiddenRows = 0;
  for (const [value, count] of topEntries(counts, counts.size)) {
    const safe = count >= CATEGORY_RULES.minCount && value.length <= CATEGORY_RULES.maxLength && !/\d{3,}/.test(value) && !value.includes('@');
    if (safe) shown.push({ value, count });
    else {
      hidden += 1;
      hiddenRows += count;
    }
  }
  return { shown: true, values: shown, hiddenValues: hidden, hiddenRows, rule: `values seen at least ${CATEGORY_RULES.minCount} times, without digit runs or "@"`, total };
}

/**
 * Profiles a parsed source (parseSource). options: label (required: SYNTHETIC, OBSERVATIONAL, or
 * CUSTOMER), sourceName (a file name for display), showCategories (default false).
 */
export function profileSource(parsed, options = {}) {
  const { label, sourceName = null, showCategories = false } = options;
  if (!label) throw new RangeError('profileSource: a data label is required');
  const { headers, rows } = parsed;
  const seen = new Set();
  let duplicateRows = 0;
  for (const row of rows) {
    const key = JSON.stringify(row.cells.map(cleanCell));
    if (seen.has(key)) duplicateRows += 1;
    else seen.add(key);
  }

  const columns = headers.map((header, index) => {
    const rawValues = rows.map((row) => row.cells[index] ?? '');
    const values = [];
    let whitespace = 0;
    let nullMarkers = 0;
    for (const raw of rawValues) {
      const text = String(raw);
      const cleaned = cleanCell(text);
      if (text.trim() && !cleaned) nullMarkers += 1;
      if (cleaned && text !== text.trim()) whitespace += 1;
      if (cleaned) values.push(cleaned);
    }
    const kinds = tallyMap(values.map(valueKind));
    const inferred = inferType(kinds, values.length);
    const isTimestamp = inferred.type === 'timestamp';
    const column = classifyColumn(header, values, { timestampColumn: isTimestamp });
    const flagged = column.pii || column.personIdentifier || column.identifierShape;
    const lengths = values.map((value) => [...value].length);
    const entry = {
      column: header,
      position: index + 1,
      inferredType: inferred.type,
      typeBreakdown: inferred.breakdown,
      nonBlank: values.length,
      blank: rawValues.length - values.length,
      nullRate: rawValues.length ? (rawValues.length - values.length) / rawValues.length : null,
      nullMarkers,
      valuesWithStrayWhitespace: whitespace,
      distinct: new Set(values).size,
      length: lengths.length ? { min: Math.min(...lengths), max: Math.max(...lengths) } : null,
      characterClasses: [...new Set(values.slice(0, 5000).flatMap(characterClasses))].sort(),
      flags: column.flags,
      pii: column.pii,
      rawIdentifier: column.personIdentifier || column.identifierShape
    };
    // PII columns show no shapes at all: an email's shape still hints at its length structure.
    entry.shapes = column.pii
      ? { hidden: 'PII-flagged column: shapes are not shown' }
      : topEntries(tallyMap(values.map(maskValue)), TOP_SHAPES).map(([shape, count]) => ({ shape, count }));
    if (inferred.type === 'integer' || inferred.type === 'decimal' || inferred.type === 'mostly numeric') {
      entry.numeric = flagged ? { hidden: 'flagged column: numeric summary not shown' } : numericSummary(values);
    }
    if (isTimestamp || (kinds.get('timestamp') ?? 0) > 0) entry.timestamps = timestampSummary(values, flagged);
    if (showCategories) entry.categories = categories(values, column, values.length);
    return entry;
  });

  const timestampColumns = columns.filter((column) => column.timestamps?.range);
  const primary = [...timestampColumns].sort((a, b) => a.nullRate - b.nullRate)[0] ?? null;
  return {
    label,
    profileVersion: PROFILE_VERSION,
    versions: { profile: PROFILE_VERSION, source: SOURCE_VERSION, pii: PII_RULES_VERSION, values: VALUES_VERSION },
    source: { name: sourceName, format: parsed.format, delimiter: parsed.delimiter ?? null },
    rowCount: rows.length,
    columnCount: headers.length,
    preambleLines: parsed.preambleLines ?? 0,
    blankRows: parsed.tally.list('dropped').find((entry) => entry.reason === 'blank row')?.count ?? 0,
    exactDuplicateRows: duplicateRows,
    dropped: parsed.tally.list('dropped'),
    fixed: parsed.tally.list('fixed'),
    dateRange: primary ? { column: primary.column, ...primary.timestamps.range } : null,
    flaggedColumns: columns.filter((column) => column.flags.length && (column.pii || column.rawIdentifier)).map((column) => ({ column: column.column, flags: column.flags })),
    columns,
    rule: 'No raw value is shown. Shapes replace letters with A and digits with 9. PII-flagged columns show no shapes.'
  };
}

function percent(value) {
  return value === null || value === undefined ? 'n/a' : `${(100 * value).toFixed(1)}%`;
}

/** A plain-text console view of a profile. It shows only what the profile object holds. */
export function renderProfileText(profile) {
  const lines = [];
  lines.push(`[${profile.label}] profile of ${profile.source.name ?? 'source'} (${profile.source.format}${profile.source.delimiter ? `, delimiter ${JSON.stringify(profile.source.delimiter)}` : ''})`);
  lines.push(`rows: ${profile.rowCount}, columns: ${profile.columnCount}, comment lines before the header: ${profile.preambleLines}, blank rows: ${profile.blankRows}, exact duplicate rows: ${profile.exactDuplicateRows}`);
  if (profile.dateRange) lines.push(`date range (${profile.dateRange.column}): ${profile.dateRange.start} to ${profile.dateRange.end}${profile.dateRange.note ? ` (${profile.dateRange.note})` : ''}`);
  for (const entry of [...profile.dropped, ...profile.fixed]) lines.push(`  ${entry.reason}: ${entry.count}`);
  lines.push('');
  for (const column of profile.columns) {
    const shapes = Array.isArray(column.shapes) ? column.shapes.map((item) => `${item.shape} x${item.count}`).join(', ') : column.shapes.hidden;
    lines.push(`${column.position}. ${column.column}: ${column.inferredType}, null ${percent(column.nullRate)}, distinct ${column.distinct}, length ${column.length ? `${column.length.min}-${column.length.max}` : 'n/a'}`);
    lines.push(`   shapes: ${shapes || 'n/a'}`);
    if (column.numeric && !column.numeric.hidden) {
      lines.push(`   numeric: ${column.numeric.negative} negative, ${column.numeric.zero} zero, up to ${column.numeric.maxDecimalPlaces} decimal places${column.numeric.hint ? `; ${column.numeric.hint}` : ''}`);
    }
    if (column.timestamps) lines.push(`   timestamp styles: ${Object.entries(column.timestamps.styles).map(([style, count]) => `${style} x${count}`).join(', ')}`);
    if (column.valuesWithStrayWhitespace) lines.push(`   values with stray whitespace: ${column.valuesWithStrayWhitespace}`);
    if (column.nullMarkers) lines.push(`   null markers read as blank: ${column.nullMarkers}`);
    for (const flag of column.flags) lines.push(`   FLAG ${flag}`);
    if (column.categories?.shown) {
      lines.push(`   categories: ${column.categories.values.map((item) => `${JSON.stringify(item.value)} x${item.count}`).join(', ')}${column.categories.hiddenValues ? `; ${column.categories.hiddenValues} rare or unsafe values hidden` : ''}`);
    }
  }
  lines.push('');
  lines.push(profile.rule);
  return lines.join('\n');
}
