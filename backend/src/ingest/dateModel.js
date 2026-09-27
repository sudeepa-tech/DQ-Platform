'use strict';
/*
 * S2 date model: classification and conversion of date-like cells. It decides NO business semantics (that a column is "Created On" is
 * S3's job); it only says what a single cell IS, from workbook metadata or from strict text patterns, and never converts one type into another.
 *
 *   DATE_ONLY    calendar date, canonical "YYYY-MM-DD" (no zone, no time)
 *   DATETIME     canonical "YYYY-MM-DDTHH:MM:SS" (floating wall-clock: a workbook carries NO zone) or with an explicit "+05:30"/"Z" when the SOURCE TEXT gave one
 *   TIME_ONLY    canonical "HH:MM:SS"
 *   TEXT_DATE    a text cell parsed under an EXPLICIT date-format profile (status: parsed | ambiguous | needs_configuration)
 *   INVALID_DATE date-shaped/date-typed but impossible (calendar-invalid text, Excel serial 0/60/out of range, ...)
 *   UNKNOWN      workbook says "date-ish" but the format cannot be classified with certainty: raw kept, nothing guessed
 * Excel serials: deterministic integer arithmetic (calendar.js), honouring the workbook's 1900/1904 date system and the 1900 leap-year bug.
 */
const C = require('./calendar');
const DATE_MODEL_VERSION = 'date-model-1.0.0';

/* ------------------------------------------------------------------ Excel serial numbers */
const SERIAL_1900_MAX = 2958465;       // 9999-12-31
function excelSerialToCalendar(serial, { date1904 = false } = {}) {
  if (typeof serial !== 'number' || !Number.isFinite(serial)) return { ok: false, reason: 'not_finite' };
  // round to the nearest whole second FIRST (what a spreadsheet displays), then split into day number and second-of-day
  const total = Math.round(serial * 86400);
  const dn = Math.floor(total / 86400), secs = total - dn * 86400;
  let unixDays;
  if (date1904) {
    if (dn < 0) return { ok: false, reason: 'excel_negative_serial' };
    unixDays = dn - 24107;                                    // serial 0 = 1904-01-01
  } else {
    if (dn < 1) return { ok: false, reason: dn === 0 ? 'excel_zero_date' : 'excel_negative_serial' };
    if (dn === 60) return { ok: false, reason: 'excel_1900_leap_bug' };   // Excel's fictitious 1900-02-29
    unixDays = dn < 60 ? dn - 25568 : dn - 25569;             // serial 1 = 1900-01-01; serial 61 = 1900-03-01; serial 25569 = 1970-01-01
    if (dn > SERIAL_1900_MAX) return { ok: false, reason: 'excel_serial_out_of_range' };
  }
  const { y, m, d } = C.civilFromDays(unixDays);
  if (y > 9999 || y < 1) return { ok: false, reason: 'excel_serial_out_of_range' };
  return { ok: true, date: C.formatYMD(y, m, d), secondsOfDay: secs, time: C.formatHMS(secs), fraction: secs !== 0 };
}
/** time-of-day part of a serial (used for TIME_ONLY cells, where the integer part is irrelevant) */
function serialTimeOfDay(serial) {
  if (typeof serial !== 'number' || !Number.isFinite(serial) || serial < 0) return null;
  const total = Math.round(serial * 86400); const secs = total - Math.floor(total / 86400) * 86400;
  return { secondsOfDay: secs, time: C.formatHMS(secs), wholeDays: Math.floor(total / 86400) };
}

/* ------------------------------------------------------------------ number-format classification (workbook metadata) */
/** Classify an Excel number-format string: date_only | datetime | time_only | not_date | unknown */
function classifyNumberFormat(fmt) {
  if (fmt === undefined || fmt === null) return { kind: 'not_date' };
  let f = String(fmt);
  if (f === '' || f === 'General' || f === '@') return { kind: 'not_date' };
  const original = f;
  f = f.split(';')[0];                                                    // first section decides for a positive number
  f = f.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/[_*].?/g, '');   // quoted text, escaped chars, padding/fill
  f = f.replace(/[Ee][+-]/g, '');                                       // scientific notation (0.0E+00): the E is an exponent marker, not the era-year token
  const locale = /\[\$[^\]]*-([0-9A-Fa-f]+)\]/.exec(f);                   // [$-F800] system long date, [$-F400] system time, [$-409] locale only
  f = f.replace(/\[\$[^\]]*\]/g, '').replace(/\[(?:red|black|blue|cyan|green|magenta|white|yellow|color\s*\d+)\]/gi, '').replace(/\[[<>=][^\]]*\]/g, '');
  const elapsed = /\[(h+|m+|s+)\]/i.test(f); f = f.replace(/\[(h+|m+|s+)\]/gi, (_, x) => x[0].toLowerCase().repeat(x.length));
  const tokens = f.match(/AM\/PM|A\/P|y+|m+|d+|h+|s+|e+|g+|b+|[^ymdhsegbAP]+|./gi) || [];
  const sig = tokens.map((t, i) => ({ t, i, c: t[0].toLowerCase() })).filter(x => /^(y|m|d|h|s|e|g|b|a)$/.test(x.c) && !(x.c === 'a' && !/^A\/?P|^AM\/PM$/i.test(x.t)));
  let hasDate = false, hasTime = false;
  sig.forEach((x, k) => {
    if ('ydegb'.includes(x.c)) hasDate = true;
    else if (x.c === 'h' || x.c === 's' || x.c === 'a') hasTime = true;
    else if (x.c === 'm') {                                              // month or minute?
      const prev = sig[k - 1], next = sig[k + 1];
      if ((prev && prev.c === 'h') || (next && next.c === 's')) hasTime = true; else hasDate = true;
    }
  });
  if (!hasDate && !hasTime && locale) { const code = locale[1].toUpperCase(); if (code === 'F800') hasDate = true; else if (code === 'F400') hasTime = true; }
  if (!hasDate && !hasTime) return { kind: 'not_date' };
  if (elapsed && !hasDate) return { kind: 'time_only', elapsed: true, format: original };
  return { kind: hasDate && hasTime ? 'datetime' : hasDate ? 'date_only' : 'time_only', format: original };
}

/* ------------------------------------------------------------------ text dates under an explicit profile */
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const TIME_RE = '(?:[T ]\\s*(\\d{1,2}):(\\d{2})(?::(\\d{2})(?:\\.\\d{1,9})?)?\\s*([AaPp][Mm])?\\s*(Z|[+-]\\d{2}:?\\d{2})?)?';
const DATE_FORMATS = {   // catalogue of KNOWN formats; a profile chooses which are ENABLED
  'DD.MM.YYYY':  { re: '(\\d{1,2})\\.(\\d{1,2})\\.(\\d{4})', order: 'dmy' },
  'DD-MM-YYYY':  { re: '(\\d{1,2})-(\\d{1,2})-(\\d{4})', order: 'dmy' },
  'DD/MM/YYYY':  { re: '(\\d{1,2})/(\\d{1,2})/(\\d{4})', order: 'dmy' },
  'MM/DD/YYYY':  { re: '(\\d{1,2})/(\\d{1,2})/(\\d{4})', order: 'mdy' },
  'YYYY-MM-DD':  { re: '(\\d{4})-(\\d{2})-(\\d{2})', order: 'ymd' },
  'YYYY/MM/DD':  { re: '(\\d{4})/(\\d{2})/(\\d{2})', order: 'ymd' },
  'YYYY.MM.DD':  { re: '(\\d{4})\\.(\\d{2})\\.(\\d{2})', order: 'ymd' },
  'YYYYMMDD':    { re: '(\\d{4})(\\d{2})(\\d{2})', order: 'ymd', noTime: true },     // 8-digit run: only ever when explicitly enabled
  'DD-MMM-YYYY': { re: '(\\d{1,2})-([A-Za-z]{3})-(\\d{4})', order: 'dMy' },
  // two-digit years are ambiguous by century: usable only with an explicit profile.century_pivot (yy < pivot -> 20yy, else 19yy)
  'DD.MM.YY':    { re: '(\\d{1,2})\\.(\\d{1,2})\\.(\\d{2})', order: 'dmy', twoDigitYear: true, noTime: true },
  'DD/MM/YY':    { re: '(\\d{1,2})/(\\d{1,2})/(\\d{2})', order: 'dmy', twoDigitYear: true, noTime: true }
};
for (const f of Object.values(DATE_FORMATS)) f.rx = new RegExp('^' + f.re + (f.noTime ? '' : TIME_RE) + '$');
const DEFAULT_DATE_PROFILE = Object.freeze({ id: 'default-unambiguous', formats: Object.freeze(['DD.MM.YYYY', 'YYYY-MM-DD']), notes: 'slash and 8-digit formats must be enabled explicitly (DD/MM/YYYY vs MM/DD/YYYY cannot be told apart from the text)' });
function resolveDateProfile(p) {
  const profile = p || DEFAULT_DATE_PROFILE;
  const bad = (profile.formats || []).filter(f => !DATE_FORMATS[f]);
  if (bad.length) throw new Error(`Unknown date format(s) in profile: ${bad.join(', ')}. Known: ${Object.keys(DATE_FORMATS).join(', ')}`);
  const two = (profile.formats || []).filter(f => DATE_FORMATS[f].twoDigitYear);
  if (two.length && !Number.isInteger(profile.century_pivot)) throw new Error(`Two-digit-year format(s) ${two.join(', ')} need an explicit profile.century_pivot (0-99): yy < pivot -> 20yy, otherwise 19yy.`);
  return { id: profile.id || 'custom', formats: [...profile.formats], ...(two.length ? { century_pivot: profile.century_pivot } : {}) };
}

function ymdOf(order, g) {
  let y, m, d;
  if (order === 'dmy') [d, m, y] = [+g[0], +g[1], +g[2]];
  else if (order === 'mdy') [m, d, y] = [+g[0], +g[1], +g[2]];
  else if (order === 'ymd') [y, m, d] = [+g[0], +g[1], +g[2]];
  else { d = +g[0]; m = MONTHS[g[1].toLowerCase()] || 0; y = +g[2]; }
  return { y, m, d };
}
function timePart(g) {   // g = [h, mi, s, ampm, tz]
  if (g[0] === undefined) return null;
  let h = +g[0]; const mi = +g[1], s = g[2] === undefined ? 0 : +g[2]; const ap = g[3] ? g[3].toUpperCase() : null;
  if (ap) { if (h < 1 || h > 12) return { invalid: true }; h = (h % 12) + (ap === 'PM' ? 12 : 0); }
  if (h > 23 || mi > 59 || s > 59) return { invalid: true };
  let tz = null; if (g[4]) tz = g[4] === 'Z' ? 'Z' : g[4].length === 5 ? g[4].slice(0, 3) + ':' + g[4].slice(3) : g[4];
  return { secondsOfDay: h * 3600 + mi * 60 + s, time: C.formatHMS(h * 3600 + mi * 60 + s), tz };
}
/** every known format that structurally matches: [{format, y,m,d, valid, time}] */
function structuralMatches(str, formats, pivot, enabled) {
  const out = [];
  for (const name of formats) {
    const f = DATE_FORMATS[name]; const m = f.rx.exec(str); if (!m) continue;
    let { y, m: mo, d } = ymdOf(f.order, m.slice(1, 4));
    const t = f.noTime ? null : timePart(m.slice(4, 9));
    if (f.twoDigitYear) {
      if (enabled) { y = y < pivot ? 2000 + y : 1900 + y; }            // explicit pivot from the profile
      else { const ok = mo >= 1 && mo <= 12 && d >= 1 && d <= C.daysInMonth(2000, mo); out.push({ format: name, valid: ok, value: null, twoDigit: true }); continue; }   // evidence only: the century is unknowable
    }
    const valid = C.isValidYMD(y, mo, d) && !(t && t.invalid);
    out.push({ format: name, y, m: mo, d, valid, time: t && !t.invalid ? t : null, value: valid ? C.formatYMD(y, mo, d) : null });
  }
  return out;
}
/**
 * Strictly parse a TEXT cell as a date/datetime under `profile`. Never uses Date.parse.
 * status: parsed | ambiguous | needs_configuration | invalid | not_date
 * confidence (deterministic, not a heuristic): 1 = exactly one interpretation among ALL known formats;
 *   0.5 = one interpretation under the enabled profile but another valid one exists under a known, NOT-enabled format (alt);
 *   1/n = each of n valid interpretations when ambiguous; 0 = no usable interpretation.
 */
function parseTextDate(text, profile = DEFAULT_DATE_PROFILE) {
  if (typeof text !== 'string') return { status: 'not_date' };
  const s = text.trim();
  if (s.length < 6 || s.length > 40 || !/^\d|^[A-Za-z]{0}\d/.test(s)) return { status: 'not_date' };
  const enabled = profile.formats, disabled = Object.keys(DATE_FORMATS).filter(f => !enabled.includes(f));
  const flags = s !== text ? ['trimmed'] : [];
  const en = structuralMatches(s, enabled, profile.century_pivot, true), dis = structuralMatches(s, disabled, undefined, false);
  const valid = en.filter(x => x.valid), validDis = dis.filter(x => x.valid);
  const distinct = [...new Map(valid.map(x => [x.value + '|' + (x.time ? x.time.time + (x.time.tz || '') : ''), x])).values()];
  const cand = list => list.map(x => (x.twoDigit ? { format: x.format, value: null, note: 'two_digit_year_requires_century_pivot' } : { format: x.format, value: x.value + (x.time ? 'T' + x.time.time + (x.time.tz || '') : '') }));
  const build = x => x.time ? { kind: 'datetime', value: `${x.value}T${x.time.time}${x.time.tz || ''}`, tz: x.time.tz || null } : { kind: 'date', value: x.value, tz: null };
  if (en.length && !valid.length) {
    // impossible under the enabled profile; if a known-but-not-enabled format WOULD make it valid, keep that as evidence the profile may be wrong for this column
    const alt = [...new Map(validDis.map(x => [x.format + '|' + x.value, x])).values()];
    return { status: 'invalid', reason: alt.length ? 'calendar_invalid_under_profile' : 'calendar_invalid', format: en[0].format, candidates: [], alt: alt.length ? cand(alt) : undefined, confidence: 0, flags };
  }
  if (distinct.length === 1) {
    const x = distinct[0], alt = validDis.filter(a => a.value !== x.value);
    return { status: 'parsed', format: x.format, ...build(x), candidates: [], alt: alt.length ? cand(alt) : undefined, confidence: alt.length ? 0.5 : 1, flags };
  }
  if (distinct.length > 1) return { status: 'ambiguous', kind: 'date', value: null, candidates: cand(distinct), confidence: +(1 / distinct.length).toFixed(3), flags };
  if (validDis.length) {
    const uniq = [...new Map(validDis.map(x => [x.format + '|' + x.value, x])).values()];
    return { status: 'needs_configuration', kind: 'date', value: null, candidates: cand(uniq), confidence: +(1 / uniq.length).toFixed(3), reason: 'format_not_enabled_in_profile', flags };
  }
  return { status: 'not_date' };
}
/** strict text time-of-day: H:MM[:SS] [AM|PM] */
function parseTextTime(text) {
  if (typeof text !== 'string') return null;
  const m = /^\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?\s*$/.exec(text); if (!m) return null;
  const t = timePart([m[1], m[2], m[3], m[4], undefined]); return t && !t.invalid ? { time: t.time, secondsOfDay: t.secondsOfDay } : null;
}

/* ------------------------------------------------------------------ cell classification */
/**
 * cell: { t: 's'|'n'|'b'|'e', v, z?, code? }   ctx: { date1904, profile, formatCache }
 * returns { type, raw, canonical?, meta? }  type in: blank | text | number | boolean | error | date_only | datetime | time_only | text_date | invalid_date | unknown
 * raw = the cell value exactly as stored (Excel dates: the serial number); canonical = typed primitive where safely determinable;
 * meta = only what is needed to interpret/audit the cell (kind, format, status, candidates ...).
 */
function classifyCell(cell, ctx) {
  if (!cell || cell.v === undefined || cell.v === null) return { type: 'blank', raw: null };
  const { t, v } = cell;
  if (t === 's') {
    if (v === '') return { type: 'blank', raw: null };
    if (v.trim() === '') return { type: 'text', raw: v, whitespaceOnly: true };
    const d = parseTextDate(v, ctx.profile);
    if (d.status === 'parsed') {
      const kind = d.kind === 'datetime' ? 'datetime' : 'text_date';
      const meta = { k: kind, src: 'text', st: 'parsed', f: d.format, conf: d.confidence };
      if (d.tz) meta.tz = d.tz; else if (kind === 'datetime') meta.tz = 'floating';
      if (d.alt) meta.alt = d.alt; if (d.flags.length) meta.fl = d.flags;
      return { type: kind, raw: v, canonical: d.value, meta };
    }
    if (d.status === 'ambiguous' || d.status === 'needs_configuration') return { type: 'text_date', raw: v, meta: { k: 'text_date', src: 'text', st: d.status, cand: d.candidates, conf: d.confidence, ...(d.reason ? { why: d.reason } : {}) } };
    if (d.status === 'invalid') return { type: 'invalid_date', raw: v, meta: { k: 'invalid_date', src: 'text', why: d.reason, f: d.format, ...(d.alt ? { alt: d.alt } : {}) } };
    const tm = parseTextTime(v);
    if (tm) return { type: 'time_only', raw: v, canonical: tm.time, meta: { k: 'time_only', src: 'text' } };
    return { type: 'text', raw: v };
  }
  if (t === 'n') {
    let cf = ctx.formatCache && ctx.formatCache.get(cell.z);
    if (!cf) { cf = classifyNumberFormat(cell.z); ctx.formatCache && ctx.formatCache.set(cell.z, cf); }
    if (cf.kind === 'not_date') return { type: 'number', raw: v };
    const m0 = { z: cell.z };
    if (cf.kind === 'unknown') return { type: 'unknown', raw: v, meta: { k: 'unknown', why: 'unclassifiable_date_format', ...m0 } };
    if (cf.kind === 'time_only') {
      const tod = serialTimeOfDay(v);
      if (!tod) return { type: 'invalid_date', raw: v, meta: { k: 'invalid_date', src: 'excel', why: 'negative_time', ...m0 } };
      if (cf.elapsed && tod.wholeDays >= 1) return { type: 'unknown', raw: v, meta: { k: 'unknown', why: 'elapsed_time_over_24h', ...m0 } };
      const meta = { k: 'time_only', ...m0 }; if (tod.wholeDays >= 1) { const hd = excelSerialToCalendar(Math.floor(v), { date1904: ctx.date1904 }); if (hd.ok) meta.hd = hd.date; }
      return { type: 'time_only', raw: v, canonical: tod.time, meta };
    }
    const cal = excelSerialToCalendar(v, { date1904: ctx.date1904 });
    if (!cal.ok) return { type: 'invalid_date', raw: v, meta: { k: 'invalid_date', src: 'excel', why: cal.reason, ...m0 } };
    if (cf.kind === 'date_only') {
      const meta = { k: 'date_only', ...m0 }; if (cal.fraction) meta.ht = cal.time;       // a hidden time-of-day is recorded, never silently dropped or promoted
      return { type: 'date_only', raw: v, canonical: cal.date, meta };
    }
    return { type: 'datetime', raw: v, canonical: `${cal.date}T${cal.time}`, meta: { k: 'datetime', tz: 'floating', ...m0 } };
  }
  if (t === 'b') return { type: 'boolean', raw: !!v };
  if (t === 'e') return { type: 'error', raw: String(cell.w !== undefined ? cell.w : v), meta: { k: 'error', code: v } };
  return { type: 'unknown', raw: v === undefined ? null : v, meta: { k: 'unknown', why: 'unexpected_cell_type:' + t } };
}

module.exports = { DATE_MODEL_VERSION, DEFAULT_DATE_PROFILE, DATE_FORMATS, resolveDateProfile, excelSerialToCalendar, serialTimeOfDay, classifyNumberFormat, parseTextDate, parseTextTime, classifyCell };
