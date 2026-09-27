'use strict';
/* Full-column PHYSICAL metadata, computed over EVERY data row (never a sample). Describes what the column contains; decides nothing about what it means. */
const CAP_DISTINCT = 100000;
function shapeOf(s) {   // run-length signature: "SANKALP20299" -> "A{7}9{5}"
  let out = '', prev = '', n = 0;
  for (const ch of s.length > 64 ? s.slice(0, 64) : s) {
    const c = /[0-9]/.test(ch) ? '9' : /[A-Z]/.test(ch) ? 'A' : /[a-z]/.test(ch) ? 'a' : /\s/.test(ch) ? '_' : ch;
    if (c === prev) n++; else { if (n) out += prev + (n > 1 ? `{${n}}` : ''); prev = c; n = 1; }
  }
  if (n) out += prev + (n > 1 ? `{${n}}` : '');
  return out;
}
class ColumnAcc {
  constructor() {
    this.blank = 0; this.populated = 0; this.wsOnly = 0; this.kinds = Object.create(null); this.distinct = new Set(); this.capped = false; this.shapes = new Map();
    this.minLen = Infinity; this.maxLen = 0; this.leadZero = 0; this.digitOnly = 0; this.padded = 0;
    this.nMin = Infinity; this.nMax = -Infinity; this.nInt = true; this.nCount = 0; this.nFormats = Object.create(null);
    this.dMin = null; this.dMax = null; this.td = { parsed: 0, ambiguous: 0, needs_configuration: 0, invalid: 0, alt: 0, byFormat: Object.create(null) };
  }
  add(cls, cell) {
    const t = cls.type;
    if (t === 'blank') { this.blank++; return; }
    this.kinds[t] = (this.kinds[t] || 0) + 1;
    if (cls.whitespaceOnly) { this.wsOnly++; return; }
    this.populated++;
    // distinct counts RAW values: a physical fact must not change with the date-format profile ("5.3.2014" and "05.03.2014" are two distinct raw values)
    if (!this.capped) { const v = cls.raw; this.distinct.add(typeof v === 'string' ? 's' + v : typeof v + String(v)); if (this.distinct.size >= CAP_DISTINCT) this.capped = true; }
    if (t === 'text') {
      const s = cls.raw; if (s.length < this.minLen) this.minLen = s.length; if (s.length > this.maxLen) this.maxLen = s.length;
      if (s !== s.trim()) this.padded++; if (/^0\d+$/.test(s)) this.leadZero++; if (/^\d+$/.test(s)) this.digitOnly++;
      const sh = shapeOf(s); if (this.shapes.has(sh) || this.shapes.size < 200) this.shapes.set(sh, (this.shapes.get(sh) || 0) + 1);
    } else if (t === 'number' || t === 'date_only' || t === 'datetime' || t === 'time_only' || t === 'unknown' || (t === 'invalid_date' && typeof cls.raw === 'number')) {
      if (cell && cell.z) this.nFormats[cell.z] = (this.nFormats[cell.z] || 0) + 1;
      if (t === 'number') { const v = cls.raw; this.nCount++; if (v < this.nMin) this.nMin = v; if (v > this.nMax) this.nMax = v; if (!Number.isInteger(v)) this.nInt = false; }
    }
    if (cls.canonical !== undefined && (t === 'date_only' || t === 'datetime' || t === 'text_date')) { const d = String(cls.canonical); if (this.dMin === null || d < this.dMin) this.dMin = d; if (this.dMax === null || d > this.dMax) this.dMax = d; }
    if (cls.meta && cls.meta.src === 'text' && (t === 'text_date' || t === 'datetime' || t === 'invalid_date')) {
      const st = t === 'invalid_date' ? 'invalid' : cls.meta.st; this.td[st] = (this.td[st] || 0) + 1;
      if (cls.meta.alt) this.td.alt++; if (cls.meta.f) this.td.byFormat[cls.meta.f] = (this.td.byFormat[cls.meta.f] || 0) + 1;
    }
  }
  finalize(dataRows) {
    const kinds = { ...this.kinds }; const populatedKinds = Object.keys(kinds).filter(k => k !== 'blank');
    const text = this.kinds.text ? { min_len: this.minLen, max_len: this.maxLen, with_leading_or_trailing_space: this.padded, leading_zero_digit_strings: this.leadZero, digit_only_strings: this.digitOnly } : undefined;
    const number = this.nCount ? { count: this.nCount, min: this.nMin, max: this.nMax, integers_only: this.nInt } : undefined;
    const td = this.td; const tdTotal = td.parsed + td.ambiguous + td.needs_configuration + td.invalid;
    const profile = { rows: dataRows, blank_count: this.blank, whitespace_only_count: this.wsOnly, populated_count: this.populated,
      distinct_capped: this.capped, mixed_kinds: populatedKinds.filter(k => k !== 'invalid_date').length > 1,
      ...(text ? { text } : {}), ...(number ? { number } : {}), ...(Object.keys(this.nFormats).length ? { number_formats: this.nFormats } : {}),
      ...(this.dMin !== null ? { date_range: { min: this.dMin, max: this.dMax } } : {}),
      ...(tdTotal ? { text_dates: { parsed: td.parsed, ambiguous: td.ambiguous, needs_configuration: td.needs_configuration, invalid: td.invalid, with_alternative_interpretation: td.alt, by_format: td.byFormat } } : {}) };
    profile.date_review_required = !!(td.ambiguous || td.needs_configuration || td.alt || td.invalid);
    const shapes = [...this.shapes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    return { populated_count: this.populated, populated_ratio: dataRows ? this.populated / dataRows : 0, distinct_count: this.distinct.size, is_empty: this.populated === 0 ? 1 : 0,
      cell_kinds_json: JSON.stringify(kinds), value_shapes_json: shapes.length ? JSON.stringify(Object.fromEntries(shapes)) : null, profile_json: JSON.stringify(profile) };
  }
}
module.exports = { ColumnAcc, shapeOf };
