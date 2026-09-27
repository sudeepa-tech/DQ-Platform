'use strict';
const dayjs = require('dayjs');
const customParseFormat = require('dayjs/plugin/customParseFormat');
dayjs.extend(customParseFormat);

// ---- Format validators used both for role detection & validity checks ----
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z]{1}[A-Z\d]{1}[Z]{1}[A-Z\d]{1}$/i;
const PAN_RE = /^[A-Z]{5}\d{4}[A-Z]{1}$/i;
const PHONE_RE = /^\+?\d{7,15}$/;

const HEADER_HINTS = {
  name: ['name', 'company', 'vendor', 'customer', 'supplier', 'party', 'account name', 'client'],
  address: ['address', 'addr', 'city', 'location', 'street'],
  phone: ['phone', 'mobile', 'contact no', 'telephone', 'tel'],
  email: ['email', 'e-mail', 'mail id'],
  gstin: ['gst', 'gstin', 'gst no', 'gst number'],
  pan: ['pan', 'pan no', 'pan number'],
  item_code: ['item code', 'material code', 'sku', 'part no', 'material no', 'item no', 'product code'],
  item_desc: ['item description', 'material description', 'description', 'item name', 'product name'],
  created_date: ['created', 'creation date', 'created on', 'created date', 'date created'],
  modified_date: ['modified', 'updated', 'last modified', 'modification date', 'updated on', 'last updated'],
  status: ['status', 'active']
  // "state" deliberately excluded from status hints: in real ERP/address
  // data a "State" column is overwhelmingly a geographic field (confirmed
  // against real SAP-style test data), not a workflow/lifecycle status --
  // a true status/lifecycle field is reliably caught by "status"/"active".
  // Note: deliberately no header-hint list for the generic "identifier" role.
  // A hint list broad enough to catch header names like "ID" or "Ref" would
  // also match ambiguous headers like "Tax ID" or "Item No" before content-
  // based detection (GSTIN/PAN pattern matching, etc.) ever gets a chance to
  // run. "identifier" is only ever assigned via the content-based fallback
  // below, based on high cardinality, once every more specific role has been
  // ruled out.
};

// Real ERP/SAP exports overwhelmingly use Snake_Case, PascalCase, or
// camelCase headers (Item_Code, CreationDate, itemCode) rather than
// space-separated phrases ("Item Code"). Hint lists above are written as
// space-separated phrases for readability, so both the header and the
// hint are normalized to space-separated words before comparing --
// otherwise every hint with more than one word silently never matches a
// real-world underscore/camelCase header, which is a much bigger miss
// than it first appears (it's the difference between "Item_Code" being
// recognized as an item code at all, or falling through to a content
// guess or the identifier catch-all).
function normalizeHeaderForMatching(header) {
  return String(header)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // camelCase -> camel Case
    .replace(/[_\-]+/g, ' ')                 // snake_case / kebab-case -> spaces
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

function headerMatchesHint(header, hints, roleName) {
  const h = normalizeHeaderForMatching(header);
  const tokens = h.split(' ');
  // Guard against a specific, confirmed real-world collision: generic
  // business-entity words used as "name" hints (vendor, customer, supplier,
  // company, party, client) are meant to catch a header like "Vendor Name",
  // but also legitimately appear inside "Vendor_Code", "Customer_ID",
  // "Supplier_Number" -- headers that are clearly an IDENTIFIER, not the
  // entity's name, and should fall through to identifier detection instead.
  // Only applies to the "name" role, and only when the header contains an
  // explicit code/id-type suffix token and does NOT also contain the word
  // "name" itself (which would unambiguously confirm it as a name field).
  if (roleName === 'name') {
    const looksLikeCodeField = tokens.some(t => ['code', 'id', 'no', 'number', 'ref'].includes(t));
    if (looksLikeCodeField && !tokens.includes('name')) return false;
  }
  return hints.some(hint => h === hint || h.includes(hint));
}

// Explicit whitelist of date formats actually seen in ERP/SAP exports and
// spreadsheet tools. Deliberately NOT a free-form dayjs(s) parse: that
// fallback uses JS's native loose date parsing, which treats almost any
// string containing digits as a parseable date -- confirmed to
// misinterpret plain identifiers like "DOC-00290" or a 10-digit phone number
// as valid (bizarre) dates by reading a trailing digit run
// as a bare year. Matching against a specific format list means a string
// is only ever treated as a date if it actually looks like one.
const DATE_FORMATS = [
  'YYYY-MM-DD', 'YYYY/MM/DD', 'YYYY.MM.DD',
  'DD-MM-YYYY', 'DD/MM/YYYY', 'DD.MM.YYYY',
  'MM-DD-YYYY', 'MM/DD/YYYY', 'MM.DD.YYYY',
  'D-MMM-YYYY', 'D MMM YYYY', 'DD-MMM-YYYY', 'DD MMM YYYY',
  'MMMM D, YYYY', 'MMM D, YYYY',
  'YYYY-MM-DDTHH:mm:ss'
];

function isLikelyDate(value) {
  if (value === null || value === undefined || value === '') return false;
  if (value instanceof Date) return !isNaN(value.getTime());
  const s = String(value).trim();
  if (s.length < 6) return false;
  return dayjs(s, DATE_FORMATS, true).isValid();
}

/**
 * The single source of truth for turning a raw cell value into an actual
 * dayjs date, used for every per-record temporal check (freshness, future-
 * date, created-vs-modified consistency). Deliberately the SAME strict,
 * whitelisted-format parse as isLikelyDate() above -- using dayjs's loose
 * free-parse here instead (as this function used to, and as a parallel
 * copy in qualityEngine.js independently did) silently turns a malformed
 * value like "2026-99-99" into a bogus-but-"valid" rolled-over date like
 * 2034-06-07 rather than rejecting it, which both hides a genuine
 * invalid-date finding and can fabricate a false temporal-consistency
 * anomaly downstream. Returns a dayjs object, or null if the value isn't
 * a real date in any of the supported formats.
 */
function parseStrictDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    const d = dayjs(value);
    return d.isValid() ? d : null;
  }
  const s = String(value).trim();
  if (!s) return null;
  const d = dayjs(s, DATE_FORMATS, true);
  return d.isValid() ? d : null;
}

function isLikelyNumeric(value) {
  if (value === null || value === undefined || value === '') return false;
  return !isNaN(Number(String(value).replace(/,/g, '')));
}

/**
 * Profile a single column: infer type, role, null stats, cardinality, samples.
 * `rows` is an array of plain row objects; `column` is the header name.
 */
function profileColumn(rows, column, columnIndex) {
  const values = rows.map(r => r[column]);
  const total = values.length;
  const nonNull = values.filter(v => v !== null && v !== undefined && String(v).trim() !== '');
  const nullCount = total - nonNull.length;
  const distinctSet = new Set(nonNull.map(v => String(v).trim().toLowerCase()));
  const distinctCount = distinctSet.size;

  // ---- inferred data type ----
  let dateVotes = 0, numVotes = 0, sample = nonNull.slice(0, 200);
  for (const v of sample) {
    if (isLikelyDate(v)) dateVotes++;
    else if (isLikelyNumeric(v)) numVotes++;
  }
  let inferredType = 'string';
  if (sample.length > 0) {
    if (dateVotes / sample.length > 0.7) inferredType = 'date';
    else if (numVotes / sample.length > 0.7) inferredType = 'number';
  }

  // ---- inferred role (header hint first, then content-based fallback) ----
  let role = 'unknown';
  let roleConfidence = 0;
  for (const [roleName, hints] of Object.entries(HEADER_HINTS)) {
    if (headerMatchesHint(column, hints, roleName)) {
      role = roleName === 'gstin' ? 'gstin' : roleName === 'pan' ? 'pan' : roleName;
      roleConfidence = 0.85;
      break;
    }
  }
  if (role === 'unknown' && sample.length > 0) {
    const emailHits = sample.filter(v => EMAIL_RE.test(String(v).trim())).length;
    const gstinHits = sample.filter(v => GSTIN_RE.test(String(v).trim())).length;
    const panHits = sample.filter(v => PAN_RE.test(String(v).trim())).length;
    const phoneHits = sample.filter(v => PHONE_RE.test(String(v).replace(/[\s\-()]/g, ''))).length;
    // Order matters: check unambiguous formats (email/GSTIN/PAN) and dates
    // BEFORE the loose phone-digit pattern. A date like "2019-01-01" strips
    // to "20190101", which also happens to satisfy a 7-15-digit phone regex
    // -- date detection must win that ambiguity, not lose to it.
    if (emailHits / sample.length > 0.5) { role = 'email'; roleConfidence = 0.9; }
    else if (gstinHits / sample.length > 0.5) { role = 'gstin'; roleConfidence = 0.9; }
    else if (panHits / sample.length > 0.5) { role = 'pan'; roleConfidence = 0.85; }
    else if (inferredType === 'date') { role = 'unclassified_date'; roleConfidence = 0.5; }
    else if (phoneHits / sample.length > 0.5) { role = 'phone'; roleConfidence = 0.75; }
    else if (inferredType === 'number') { role = 'numeric'; roleConfidence = 0.5; }
    else if (distinctCount / Math.max(1, nonNull.length) > 0.9 && nonNull.length > 5) { role = 'identifier'; roleConfidence = 0.4; }
    else { role = 'categorical'; roleConfidence = 0.3; }
  }
  // refine created/modified when header hint absent but two date columns exist -- handled at dataset level.

  // ---- numeric stats ----
  let statsJson = {};
  if (inferredType === 'number' && sample.length > 0) {
    const nums = sample.map(v => Number(String(v).replace(/,/g, ''))).filter(n => !isNaN(n));
    if (nums.length) {
      const sum = nums.reduce((a, b) => a + b, 0);
      const mean = sum / nums.length;
      const variance = nums.reduce((a, b) => a + (b - mean) ** 2, 0) / nums.length;
      statsJson = { min: Math.min(...nums), max: Math.max(...nums), mean, stddev: Math.sqrt(variance) };
    }
  } else if (inferredType === 'date' && sample.length > 0) {
    const dates = sample.map(v => dayjs(v)).filter(d => d.isValid());
    if (dates.length) {
      const sorted = dates.sort((a, b) => a.valueOf() - b.valueOf());
      statsJson = { min: sorted[0].format('YYYY-MM-DD'), max: sorted[sorted.length - 1].format('YYYY-MM-DD') };
    }
  }

  return {
    column_name: column,
    column_index: columnIndex,
    inferred_type: inferredType,
    inferred_role: role,
    role_confidence: roleConfidence,
    null_count: nullCount,
    null_pct: total ? nullCount / total : 0,
    distinct_count: distinctCount,
    cardinality_ratio: nonNull.length ? distinctCount / nonNull.length : 0,
    sample_values_json: JSON.stringify(nonNull.slice(0, 5)),
    stats_json: JSON.stringify(statsJson)
  };
}

/** Profile every column of a parsed sheet (array of row objects + header list). */
function profileSheet(rows, headers) {
  const profiles = headers.map((h, idx) => profileColumn(rows, h, idx));

  // If two "unclassified_date"/date-typed columns exist without explicit created/modified
  // header hints, assign earliest-appearing as created_date, later as modified_date.
  // Only columns that are GENUINELY unclaimed (role still 'unknown' or
  // 'unclassified_date') are eligible to consume one of the two slots --
  // a date-typed column that already has a confident, different role
  // (e.g. a "name" column that a looser type-detector once mistyped as a
  // date) must never steal the created/modified slot meant for the real
  // date columns.
  const dateLike = profiles.filter(p =>
    p.inferred_type === 'date' && ['unknown', 'unclassified_date'].includes(p.inferred_role)
  );
  if (dateLike.length >= 2) {
    dateLike[0].inferred_role = 'created_date';
    dateLike[1].inferred_role = 'modified_date';
  } else if (dateLike.length === 1) {
    dateLike[0].inferred_role = 'created_date';
  }
  return profiles;
}

module.exports = {
  profileColumn,
  profileSheet,
  isLikelyDate,
  parseStrictDate,
  isLikelyNumeric,
  EMAIL_RE,
  GSTIN_RE,
  PAN_RE,
  PHONE_RE
};
