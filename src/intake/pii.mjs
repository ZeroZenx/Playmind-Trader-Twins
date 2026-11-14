/**
 * Intake PII and identifier rules, version intake-pii-0.1.0.
 *
 * Classifies a source column by its header and by the shape of its values, and masks values
 * into shapes. Nothing here returns a raw value: classifications are flags with reasons and
 * counts, and maskValue turns every letter into "A" and every digit into "9".
 *
 * Kinds of flag:
 * - pii: direct PII. A header in the prohibited list (validate.mjs PROHIBITED_FIELDS, which
 *   agrees with src/lib/ingestion.ts) or a PII-like header (email, phone, address, birth date,
 *   government ID, IP address, device fingerprint, person name), or values shaped like emails,
 *   phone numbers, IPv4 addresses, or person names. A mapped column with this flag is rejected.
 * - personIdentifier: a header naming an account, customer, user, or similar, including the
 *   prohibited account_id, customer_id, and unmasked_account_id (prohibited in analytical
 *   events, but in a raw source they are the ID to tokenize). It may only be mapped to
 *   trader_token, which is tokenized.
 * - identifierShape: values with long digit runs (8 or more digits), like account numbers.
 * - recordIdentifier: a header naming an id or reference (for example entry_id). Informational.
 *
 * Pure: no I/O.
 */

import { PROHIBITED_FIELDS } from '../engine/validate.mjs';

export const PII_RULES_VERSION = 'intake-pii-0.1.0';

// Prohibited fields that are account identifiers rather than direct PII.
export const ACCOUNT_IDENTIFIER_FIELDS = new Set(['account_id', 'customer_id', 'unmasked_account_id']);
const PERSON_TOKENS = new Set(['account', 'acct', 'customer', 'cust', 'user', 'member', 'player', 'client', 'login', 'holder', 'wallet', 'punter', 'bettor', 'trader', 'uid', 'owner', 'patron', 'profile']);
const RECORD_ID_TOKENS = new Set(['id', 'ref', 'reference', 'uuid', 'guid', 'no', 'num', 'number', 'key']);
const NAME_QUALIFIERS = new Set(['first', 'last', 'full', 'given', 'family', 'middle', 'display', 'legal', 'screen', 'nick', 'real', 'sur']);
const NAME_COMPACT = new Set(['name', 'fullname', 'firstname', 'lastname', 'surname', 'givenname', 'familyname', 'middlename', 'username', 'nickname', 'displayname', 'screenname', 'legalname', 'forename']);
const ADDRESS_TOKENS = new Set(['address', 'addr', 'street', 'postcode', 'zip', 'zipcode', 'postal']);
const GOVERNMENT_TOKENS = new Set(['ssn', 'sin', 'passport', 'nin', 'license', 'licence', 'national', 'government', 'itin']);
const PHONE_TOKENS = new Set(['mobile', 'tel', 'telephone', 'msisdn', 'cellphone']);

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const PHONE_CHARS = /^\+?[\d\s().-]+$/;
const PLAIN_NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;
const PERSON_NAME = /^(?:[A-Z][a-z'’-]+(?:[ ][A-Z][a-z'’-]+)+|[A-Z][a-z'’-]+, [A-Z][a-z'’-]+)$/;
const LONG_DIGITS = /\d{8,}/;

// Value-shape thresholds: an email anywhere flags the column; the others need a share of the
// non-blank values, so a stray value doesn't flag a whole column.
export const VALUE_SHAPE_RULES = Object.freeze({
  emailMinCount: 1,
  phoneMinShare: 0.5,
  ipMinShare: 0.5,
  personNameMinShare: 0.5,
  personNameMinDistinct: 10,
  personNameMinDistinctShare: 0.2,
  longDigitMinShare: 0.5
});

/** The normalization validate.mjs applies to a field name. */
export function validateStyleKey(field) {
  return String(field).trim().toLowerCase().replace(/\s+/g, '_');
}

/** snake_case with camelCase split: "EmailAddress" -> "email_address", "acctNo" -> "acct_no". */
export function snakeHeader(header) {
  return String(header).trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** The prohibited field name a header matches, under any of the normalizations, or null. */
export function prohibitedFieldFor(header) {
  const forms = [validateStyleKey(header), String(header).trim().toLowerCase(), snakeHeader(header)];
  return forms.find((form) => PROHIBITED_FIELDS.has(form)) ?? null;
}

/** Header-only classification. Returns { pii: reason | null, personIdentifier, recordIdentifier }. */
export function classifyHeader(header) {
  const snake = snakeHeader(header);
  const tokens = snake.split('_').filter(Boolean);
  const compact = tokens.join('');
  const has = (set) => tokens.some((token) => set.has(token));
  let pii = null;
  const prohibited = prohibitedFieldFor(header);
  // A raw account identifier is prohibited in analytical events, but in a raw source it is
  // the trader ID column to tokenize: it is flagged as a person identifier, not as direct PII.
  const accountIdentifier = (prohibited && ACCOUNT_IDENTIFIER_FIELDS.has(prohibited)) || compact.includes('unmasked');
  if (accountIdentifier) pii = null;
  else if (prohibited) pii = `header matches the prohibited field "${prohibited}"`;
  else if (compact.includes('email') || tokens.includes('mail')) pii = 'header names an email address';
  else if (compact.includes('phone') || has(PHONE_TOKENS)) pii = 'header names a phone number';
  else if (has(ADDRESS_TOKENS)) pii = 'header names a postal address';
  else if (compact.includes('birth') || tokens.includes('dob')) pii = 'header names a date of birth';
  else if (has(GOVERNMENT_TOKENS) || compact.includes('taxid') || compact.includes('socialsecurity')) pii = 'header names a government ID';
  else if (tokens.includes('ip') || tokens.includes('ipv4') || tokens.includes('ipv6') || compact.includes('ipaddress')) pii = 'header names an IP address';
  else if (compact.includes('fingerprint')) pii = 'header names a device fingerprint';
  else if (NAME_COMPACT.has(compact) || (tokens.includes('name') && (has(PERSON_TOKENS) || has(NAME_QUALIFIERS)))) pii = 'header names a person';
  return {
    pii,
    personIdentifier: !pii && (accountIdentifier || has(PERSON_TOKENS)),
    recordIdentifier: !pii && has(RECORD_ID_TOKENS)
  };
}

function digitCount(text) {
  return (text.match(/\d/g) ?? []).length;
}

function looksLikePhone(text) {
  if (!PHONE_CHARS.test(text) || PLAIN_NUMBER.test(text)) return false;
  const digits = digitCount(text);
  return digits >= 10 && digits <= 15 && (/[\s().-]/.test(text) || text.startsWith('+'));
}

/**
 * Value-shape counts over the non-blank values of one column. Returns counts and the PII and
 * identifier conclusions, never a value. options.timestampColumn skips the digit-run rule
 * (epoch times are long digit runs).
 */
export function classifyValues(values, options = {}) {
  const rules = { ...VALUE_SHAPE_RULES, ...(options.rules ?? {}) };
  let total = 0;
  const counts = { email: 0, phone: 0, ipv4: 0, personName: 0, longDigits: 0 };
  const names = new Set();
  for (const raw of values) {
    const text = String(raw ?? '').trim();
    if (!text) continue;
    total += 1;
    if (EMAIL.test(text)) counts.email += 1;
    if (IPV4.test(text)) counts.ipv4 += 1;
    if (looksLikePhone(text)) counts.phone += 1;
    if (PERSON_NAME.test(text)) {
      counts.personName += 1;
      if (names.size <= rules.personNameMinDistinct) names.add(text);
    }
    if (LONG_DIGITS.test(text)) counts.longDigits += 1;
  }
  const share = (count) => (total ? count / total : 0);
  const pii = [];
  if (counts.email >= rules.emailMinCount) pii.push(`${counts.email} email-shaped value${counts.email === 1 ? '' : 's'}`);
  if (share(counts.phone) >= rules.phoneMinShare && counts.phone > 0) pii.push('phone-number-shaped values');
  if (share(counts.ipv4) >= rules.ipMinShare && counts.ipv4 > 0) pii.push('IP-address-shaped values');
  if (share(counts.personName) >= rules.personNameMinShare && names.size >= Math.min(rules.personNameMinDistinct, Math.ceil(total * rules.personNameMinDistinctShare))) {
    pii.push('person-name-shaped values');
  }
  const identifierShape = !options.timestampColumn && counts.longDigits > 0 && share(counts.longDigits) >= rules.longDigitMinShare;
  return { total, counts, pii, identifierShape };
}

/**
 * Header plus values. Returns { header, pii, piiReasons, personIdentifier, identifierShape,
 * recordIdentifier, flags }: flags are short labels for display.
 */
export function classifyColumn(header, values, options = {}) {
  const byHeader = classifyHeader(header);
  const byValues = classifyValues(values, options);
  const piiReasons = [...(byHeader.pii ? [byHeader.pii] : []), ...byValues.pii];
  const pii = piiReasons.length > 0;
  const flags = [];
  if (pii) flags.push(...piiReasons.map((reason) => `PII: ${reason}`));
  if (!pii && byHeader.personIdentifier) flags.push('raw identifier: header names an account or person');
  if (!pii && byValues.identifierShape) flags.push('raw identifier: long digit runs in values');
  if (!pii && byHeader.recordIdentifier && !byHeader.personIdentifier) flags.push('record identifier: header names an id or reference');
  return {
    header,
    pii,
    piiReasons,
    personIdentifier: !pii && byHeader.personIdentifier,
    identifierShape: !pii && byValues.identifierShape,
    recordIdentifier: !pii && byHeader.recordIdentifier,
    valueShapeCounts: byValues.counts,
    flags
  };
}

const KEPT_PUNCTUATION = new Set([' ', '-', '_', '.', ':', '/', '@', '+', '(', ')', '#', ',', "'"]);
export const MASK_MAX_LENGTH = 32;

/**
 * The shape of a value: letters become "A", digits "9", common separators are kept, and
 * anything else becomes "*". Longer shapes are cut at MASK_MAX_LENGTH and end with the length.
 * Example: "AC-4021-xy" -> "AA-9999-AA".
 */
export function maskValue(value) {
  const text = String(value ?? '');
  let shape = '';
  for (const character of text) {
    if (/\p{L}/u.test(character)) shape += 'A';
    else if (/\p{N}/u.test(character)) shape += '9';
    else if (KEPT_PUNCTUATION.has(character)) shape += character;
    else shape += '*';
  }
  const length = [...text].length;
  return length > MASK_MAX_LENGTH ? `${[...shape].slice(0, MASK_MAX_LENGTH).join('')}…(${length} chars)` : shape;
}

/** Character classes present in a value, as names. */
export function characterClasses(value) {
  const text = String(value ?? '');
  const classes = [];
  if (/\p{Lu}/u.test(text)) classes.push('uppercase');
  if (/\p{Ll}/u.test(text)) classes.push('lowercase');
  if (/\p{N}/u.test(text)) classes.push('digits');
  if (/\s/.test(text)) classes.push('spaces');
  if (/[^\p{L}\p{N}\s]/u.test(text)) classes.push('punctuation');
  return classes;
}
