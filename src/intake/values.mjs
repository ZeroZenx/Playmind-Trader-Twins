/**
 * Intake value parsing, version intake-values-0.1.0.
 *
 * Numbers (with thousands separators, accounting parentheses, or a leading currency symbol),
 * timestamps in several formats, and wall-clock times in a named time zone converted to UTC.
 * Profile and map share these, so the profile's inferred types are what map will parse.
 *
 * Pure: no I/O. Errors never include the value that failed.
 */

export const VALUES_VERSION = 'intake-values-0.1.0';
export const TIMESTAMP_FORMATS = Object.freeze(['iso', 'mdy', 'dmy', 'epoch_seconds', 'epoch_millis']);

const INTEGER = /^[+-]?\d+$/;
const DECIMAL = /^[+-]?(?:\d+\.\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const GROUPED = /^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;
const PARENTHESES = /^\((\d+(?:\.\d+)?)\)$/;
const CURRENCY = /^([+-]?)[$€£](.*)$/;
const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?)?\s*(Z|UTC|GMT|[+-]\d{2}:?\d{2})?$/i;
const SLASH = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i;
const BOOLEAN = /^(?:true|false|yes|no)$/i;

/**
 * Parses a number. Returns { value, fix } where fix names a cleanup that was needed (or null),
 * or { value: null, error } when the text is not a number. Blank text gives { value: null }.
 */
export function parseNumber(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { value: null, fix: null };
  let body = raw;
  let fix = null;
  let negative = false;
  const parentheses = body.match(PARENTHESES);
  if (parentheses) {
    body = parentheses[1];
    negative = true;
    fix = 'accounting parentheses read as a negative number';
  }
  const currency = body.match(CURRENCY);
  if (currency) {
    body = `${currency[1]}${currency[2].trim()}`;
    fix = fix ?? 'currency symbol removed';
  }
  if (GROUPED.test(body)) {
    body = body.replace(/,/g, '');
    fix = fix ?? 'thousands separators removed';
  }
  if (!INTEGER.test(body) && !DECIMAL.test(body)) return { value: null, error: 'not a number' };
  const value = Number(body) * (negative ? -1 : 1);
  if (!Number.isFinite(value)) return { value: null, error: 'not a finite number' };
  return { value, fix };
}

/** The kind of a non-blank text value: integer, decimal, timestamp, boolean, or text. */
export function valueKind(text) {
  const raw = String(text ?? '').trim();
  if (INTEGER.test(raw)) return 'integer';
  if (DECIMAL.test(raw) || GROUPED.test(raw)) return 'decimal';
  if (ISO.test(raw) || SLASH.test(raw)) return 'timestamp';
  if (BOOLEAN.test(raw)) return 'boolean';
  return 'text';
}

/** Which timestamp style a value uses: iso_with_offset, iso_naive, date_only, slash_date, or null. */
export function timestampStyle(text) {
  const raw = String(text ?? '').trim();
  const iso = raw.match(ISO);
  if (iso) {
    if (iso[8]) return 'iso_with_offset';
    return iso[4] === undefined ? 'date_only' : 'iso_naive';
  }
  if (SLASH.test(raw)) return 'slash_date';
  return null;
}

// --- Time zones ------------------------------------------------------------------------------

const formatters = new Map();

function formatterFor(timeZone) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

const FIXED_OFFSET = /^(?:UTC|GMT)?\s*([+-])(\d{2}):?(\d{2})$/i;

/**
 * Checks a time zone: 'UTC', a fixed offset like '+05:30' or 'UTC-04:00', or an IANA name like
 * 'America/New_York'. Returns { kind: 'fixed', offsetMs } or { kind: 'iana', name }, or throws.
 */
export function resolveTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone.trim()) throw new RangeError('time zone must be a non-empty string');
  const name = timeZone.trim();
  if (/^(?:UTC|GMT|Z)$/i.test(name)) return { kind: 'fixed', offsetMs: 0, name: 'UTC' };
  const fixed = name.match(FIXED_OFFSET);
  if (fixed) {
    const minutes = Number(fixed[2]) * 60 + Number(fixed[3]);
    if (Number(fixed[2]) > 14 || Number(fixed[3]) > 59) throw new RangeError(`time zone offset "${name}" is out of range`);
    return { kind: 'fixed', offsetMs: (fixed[1] === '-' ? -1 : 1) * minutes * 60000, name };
  }
  try {
    formatterFor(name);
  } catch {
    throw new RangeError(`unknown time zone "${name}": use UTC, an offset like +05:30, or an IANA name like America/New_York`);
  }
  return { kind: 'iana', name };
}

/** The zone's offset from UTC, in ms, at a UTC instant (seconds precision). */
function zoneOffsetMs(utcMs, zone) {
  if (zone.kind === 'fixed') return zone.offsetMs;
  const parts = Object.fromEntries(formatterFor(zone.name).formatToParts(new Date(utcMs)).map((part) => [part.type, part.value]));
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return asUtc - (utcMs - (((utcMs % 1000) + 1000) % 1000));
}

/**
 * A wall-clock time in a zone, as UTC ms. Returns { ms, ambiguous } or { ms: null, nonexistent:
 * true } for a time skipped by a daylight-saving change. An ambiguous time (repeated by a
 * daylight-saving change) takes the earlier instant.
 */
export function wallTimeToUtc(fields, zone) {
  const wall = Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute, fields.second, fields.millisecond);
  if (zone.kind === 'fixed') return { ms: wall - zone.offsetMs, ambiguous: false };
  const offsets = new Set([zoneOffsetMs(wall - 86400000, zone), zoneOffsetMs(wall, zone), zoneOffsetMs(wall + 86400000, zone)]);
  const candidates = [...offsets].map((offset) => wall - offset).filter((ms) => zoneOffsetMs(ms, zone) === wall - ms);
  const unique = [...new Set(candidates)].sort((a, b) => a - b);
  if (!unique.length) return { ms: null, nonexistent: true };
  return { ms: unique[0], ambiguous: unique.length > 1 };
}

function validFields(fields) {
  const { year, month, day, hour, minute, second } = fields;
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

function offsetMsFrom(designator) {
  if (/^(?:Z|UTC|GMT)$/i.test(designator)) return 0;
  const match = designator.match(/^([+-])(\d{2}):?(\d{2})$/);
  return (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3])) * 60000;
}

/**
 * Parses a source timestamp to a UTC ISO string. format: 'iso' (default), 'mdy', 'dmy',
 * 'epoch_seconds', 'epoch_millis'. A timestamp without an offset is read in `zone`
 * (resolveTimeZone); one with an explicit offset or Z keeps it.
 *
 * Returns { iso, notes: [] } or { iso: null, error }. Notes: 'explicit offset honored',
 * 'ambiguous local time: earlier instant used', 'date only: midnight assumed'.
 */
export function parseTimestamp(text, { format = 'iso', zone }) {
  const raw = String(text ?? '').trim();
  if (!raw) return { iso: null, error: 'blank timestamp' };
  const notes = [];
  if (format === 'epoch_seconds' || format === 'epoch_millis') {
    const parsed = parseNumber(raw);
    if (parsed.value === null) return { iso: null, error: 'unparseable timestamp' };
    const ms = format === 'epoch_seconds' ? parsed.value * 1000 : parsed.value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? { iso: null, error: 'unparseable timestamp' } : { iso: date.toISOString(), notes };
  }
  let fields;
  let designator = null;
  if (format === 'iso') {
    const match = raw.match(ISO);
    if (!match) return { iso: null, error: 'unparseable timestamp' };
    const fraction = match[7] ? Number(`0.${match[7]}`) : 0;
    fields = {
      year: Number(match[1]), month: Number(match[2]), day: Number(match[3]),
      hour: Number(match[4] ?? 0), minute: Number(match[5] ?? 0), second: Number(match[6] ?? 0),
      millisecond: Math.round(fraction * 1000)
    };
    if (match[4] === undefined) notes.push('date only: midnight assumed');
    designator = match[8] ?? null;
  } else if (format === 'mdy' || format === 'dmy') {
    const match = raw.match(SLASH);
    if (!match) return { iso: null, error: 'unparseable timestamp' };
    let hour = Number(match[4] ?? 0);
    if (match[7]) {
      if (hour < 1 || hour > 12) return { iso: null, error: 'unparseable timestamp' };
      hour = (hour % 12) + (match[7].toUpperCase() === 'PM' ? 12 : 0);
    }
    fields = {
      year: Number(match[3]),
      month: Number(format === 'mdy' ? match[1] : match[2]),
      day: Number(format === 'mdy' ? match[2] : match[1]),
      hour, minute: Number(match[5] ?? 0), second: Number(match[6] ?? 0), millisecond: 0
    };
    if (match[4] === undefined) notes.push('date only: midnight assumed');
  } else {
    throw new RangeError(`unknown timestamp format "${format}"`);
  }
  if (!validFields(fields)) return { iso: null, error: 'timestamp out of range' };
  if (designator) {
    notes.push('explicit offset honored');
    const wall = Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute, fields.second, fields.millisecond);
    return { iso: new Date(wall - offsetMsFrom(designator)).toISOString(), notes };
  }
  const converted = wallTimeToUtc(fields, zone);
  if (converted.ms === null) return { iso: null, error: 'local time skipped by a daylight-saving change' };
  if (converted.ambiguous) notes.push('ambiguous local time: earlier instant used');
  return { iso: new Date(converted.ms).toISOString(), notes };
}
