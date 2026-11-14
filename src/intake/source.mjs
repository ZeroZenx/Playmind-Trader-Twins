/**
 * Intake source reading, version intake-source-0.1.0.
 *
 * Parses a raw CSV, JSON, or JSON Lines export into headers and string cells, and records
 * what it dropped or fixed as counts with reasons. It never records cell contents: a reason
 * names a rule, and at most a few row numbers, never a value.
 *
 * Raw-dump handling: a UTF-8 byte-order mark, comment lines before the header (lines starting
 * with "#", reported as a count only), blank rows, rows with more cells than headers, short
 * rows, quoted cells with embedded commas, quotes, or newlines, and CRLF line endings.
 *
 * Pure: no I/O. The caller reads the file.
 */

export const SOURCE_VERSION = 'intake-source-0.1.0';
export const SOURCE_FORMATS = Object.freeze(['csv', 'json', 'jsonl']);

// Literal tokens a database dump uses for a missing value. Compared case-insensitively after
// trimming. They are treated as blank, and the count is reported.
export const NULL_MARKERS = Object.freeze(['null', 'nan', 'n/a', '\\n', 'none']);
const NULL_MARKER_SET = new Set(NULL_MARKERS);
const EXAMPLE_ROWS = 5;

export class IntakeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IntakeError';
  }
}

/**
 * Counts of dropped and fixed things, by reason. `rows` keeps the first few source row
 * numbers per reason (row numbers, never contents).
 */
export class Tally {
  constructor() {
    this.entries = new Map();
  }

  add(kind, reason, row = null, count = 1) {
    const key = `${kind}\u0000${reason}`;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { kind, reason, count: 0, exampleRows: [] };
      this.entries.set(key, entry);
    }
    entry.count += count;
    if (row !== null && entry.exampleRows.length < EXAMPLE_ROWS) entry.exampleRows.push(row);
  }

  merge(other) {
    for (const entry of other.entries.values()) {
      for (let index = 0; index < entry.count; index += 1) {
        this.add(entry.kind, entry.reason, entry.exampleRows[index] ?? null);
      }
    }
  }

  list(kind) {
    return [...this.entries.values()]
      .filter((entry) => entry.kind === kind)
      .map(({ reason, count, exampleRows }) => ({ reason, count, exampleRows: [...exampleRows] }));
  }

  total(kind) {
    return this.list(kind).reduce((sum, entry) => sum + entry.count, 0);
  }
}

export function isNullMarker(text) {
  return NULL_MARKER_SET.has(String(text).trim().toLowerCase());
}

/** Trimmed text, '' for blanks and null markers. */
export function cleanCell(value) {
  const text = value === undefined || value === null ? '' : String(value).trim();
  return isNullMarker(text) ? '' : text;
}

export function detectFormat(fileName, text = '') {
  const lower = String(fileName ?? '').toLowerCase();
  if (lower.endsWith('.csv') || lower.endsWith('.tsv') || lower.endsWith('.txt')) return 'csv';
  if (lower.endsWith('.jsonl') || lower.endsWith('.ndjson')) return 'jsonl';
  if (lower.endsWith('.json')) return 'json';
  const start = String(text).replace(/^﻿/, '').trimStart();
  if (start.startsWith('[')) return 'json';
  if (start.startsWith('{')) return start.split(/\r?\n/, 2).length > 1 && /\}\s*\r?\n\s*\{/.test(start) ? 'jsonl' : 'json';
  return 'csv';
}

function detectDelimiter(line) {
  const counts = [',', ';', '\t', '|'].map((delimiter) => [delimiter, line.split(delimiter).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ',';
}

/**
 * RFC 4180 style CSV records: [{ line, cells }], where `line` is the 1-based physical line the
 * record starts on. Quotes may wrap cells with delimiters, doubled quotes, or newlines.
 */
export function parseCsvRecords(text, delimiter = ',') {
  const records = [];
  let cells = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let start = 1;
  let index = 0;
  const length = text.length;
  while (index < length) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      if (character === '\n') line += 1;
      cell += character;
      index += 1;
      continue;
    }
    if (character === '"') {
      quoted = true;
      index += 1;
    } else if (character === delimiter) {
      cells.push(cell);
      cell = '';
      index += 1;
    } else if (character === '\r' || character === '\n') {
      cells.push(cell);
      records.push({ line: start, cells });
      cells = [];
      cell = '';
      index += character === '\r' && text[index + 1] === '\n' ? 2 : 1;
      line += 1;
      start = line;
    } else {
      cell += character;
      index += 1;
    }
  }
  if (quoted) throw new IntakeError(`CSV has an unterminated quoted cell starting on line ${start}.`);
  if (cell !== '' || cells.length) {
    cells.push(cell);
    records.push({ line: start, cells });
  }
  return records;
}

function checkHeaders(headers) {
  const seen = new Set();
  headers.forEach((header, index) => {
    if (!header) throw new IntakeError(`Column ${index + 1} has an empty header.`);
    if (seen.has(header)) throw new IntakeError(`Duplicate column header: "${header}".`);
    seen.add(header);
  });
}

function parseCsvSource(text, options, tally) {
  const headerLine = text.split(/\r?\n/).find((line) => line.trim() && !(options.commentPrefix && line.trimStart().startsWith(options.commentPrefix))) ?? '';
  const delimiter = options.delimiter ?? detectDelimiter(headerLine);
  const records = parseCsvRecords(text, delimiter);
  let position = 0;
  let preambleLines = 0;
  while (position < records.length) {
    const first = records[position].cells;
    const blank = first.every((cell) => cell.trim() === '');
    const comment = options.commentPrefix && first[0]?.trimStart().startsWith(options.commentPrefix);
    if (!blank && !comment) break;
    if (comment) preambleLines += 1;
    position += 1;
  }
  if (position >= records.length) throw new IntakeError('The file has no header row.');
  const headers = records[position].cells.map((header) => header.replace(/^﻿/, '').trim());
  checkHeaders(headers);
  const rows = [];
  for (const record of records.slice(position + 1)) {
    let { cells } = record;
    if (cells.every((cell) => cell.trim() === '')) {
      tally.add('dropped', 'blank row', record.line);
      continue;
    }
    if (cells.length > headers.length) {
      if (cells.slice(headers.length).some((cell) => cell.trim() !== '')) {
        tally.add('dropped', 'row has more cells than the header', record.line);
        continue;
      }
      cells = cells.slice(0, headers.length);
      tally.add('fixed', 'empty trailing cells beyond the header removed', record.line);
    }
    if (cells.length < headers.length) {
      cells = [...cells, ...Array(headers.length - cells.length).fill('')];
      tally.add('fixed', 'short row padded with blank cells', record.line);
    }
    rows.push({ rowNumber: record.line, cells });
  }
  return { delimiter, headers, rows, preambleLines };
}

function jsonCell(value, tally, rowNumber) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  tally.add('fixed', 'nested JSON value serialized to text', rowNumber);
  return JSON.stringify(value);
}

function objectsToRows(objects, tally) {
  const headers = [];
  const seen = new Set();
  for (const { object } of objects) {
    for (const key of Object.keys(object)) {
      const header = key.trim();
      if (!seen.has(header)) {
        seen.add(header);
        headers.push(header);
      }
    }
  }
  checkHeaders(headers);
  const rows = [];
  for (const { object, rowNumber } of objects) {
    const trimmed = Object.fromEntries(Object.entries(object).map(([key, value]) => [key.trim(), value]));
    const cells = headers.map((header) => jsonCell(trimmed[header], tally, rowNumber));
    if (cells.every((cell) => cell.trim() === '')) {
      tally.add('dropped', 'blank row', rowNumber);
      continue;
    }
    rows.push({ rowNumber, cells });
  }
  return { headers, rows };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonSource(text, tally) {
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    throw new IntakeError('The file is not valid JSON.');
  }
  let list = document;
  if (isPlainObject(document)) {
    const key = ['rows', 'records', 'data', 'events', 'items'].find((name) => Array.isArray(document[name]));
    if (!key) throw new IntakeError('JSON must be an array of objects, or an object with a rows, records, data, events, or items array.');
    list = document[key];
  }
  if (!Array.isArray(list)) throw new IntakeError('JSON must be an array of objects.');
  const objects = [];
  list.forEach((item, index) => {
    if (!isPlainObject(item)) {
      tally.add('dropped', 'JSON item is not an object', index + 1);
      return;
    }
    objects.push({ object: item, rowNumber: index + 1 });
  });
  return objectsToRows(objects, tally);
}

function parseJsonLinesSource(text, tally) {
  const objects = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) {
      tally.add('dropped', 'blank row', index + 1);
      return;
    }
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      tally.add('dropped', 'JSON line does not parse', index + 1);
      return;
    }
    if (!isPlainObject(item)) {
      tally.add('dropped', 'JSON item is not an object', index + 1);
      return;
    }
    objects.push({ object: item, rowNumber: index + 1 });
  });
  return objectsToRows(objects, tally);
}

/**
 * Parses a raw export. options: format ('csv', 'json', 'jsonl'; default from the file name and
 * contents), fileName, delimiter (CSV; default detected), commentPrefix (CSV; default '#').
 * Returns { sourceVersion, format, delimiter, headers, rows: [{ rowNumber, cells }],
 * preambleLines, tally }.
 */
export function parseSource(text, options = {}) {
  if (typeof text !== 'string') throw new IntakeError('parseSource needs the file contents as text.');
  const body = text.replace(/^﻿/, '');
  const format = options.format ?? detectFormat(options.fileName, body);
  if (!SOURCE_FORMATS.includes(format)) throw new IntakeError(`Unknown source format "${format}". Use one of ${SOURCE_FORMATS.join(', ')}.`);
  const tally = options.tally ?? new Tally();
  if (format === 'csv') {
    const parsed = parseCsvSource(body, { delimiter: options.delimiter ?? null, commentPrefix: options.commentPrefix ?? '#' }, tally);
    return { sourceVersion: SOURCE_VERSION, format, ...parsed, tally };
  }
  const parsed = format === 'json' ? parseJsonSource(body, tally) : parseJsonLinesSource(body, tally);
  return { sourceVersion: SOURCE_VERSION, format, delimiter: null, ...parsed, preambleLines: 0, tally };
}
