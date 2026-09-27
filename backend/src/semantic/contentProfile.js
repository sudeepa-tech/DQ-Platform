'use strict';
/*
 * PROFILE stage: full-column content features from the canonical rows (never a sample). Features describe what values LOOK like; the role
 * classifier decides what they mean. Output is small, JSON-serializable and stored per physical column (column_profiles).
 */
const G = require('./gazetteers');
const PROFILE_VERSION = 'content-profile-1.2.0';   // 1.1: above the distinct-tracking cap the exact distinct count from ingest is used; 1.2: numeric-looking TEXT (a CSV has no cell types) counts as numeric
const CAP = 20000;
const NUMERIC_TEXT = /^[+-]?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/;
const RX = {
  email: /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, gstin: /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, pan: /^[A-Z]{5}\d{4}[A-Z]$/, url: /^(https?:\/\/|www\.)/i,
  phoneChars: /^[\d\s()+\-.]+$/, dateLike: /^\d{1,4}[./-]\d{1,2}[./-]\d{1,4}$/, mobile10: /^(\+?91[\s-]?|0)?[6-9]\d{9}$/,
  pin6: /^[1-9]\d{5}$/, pin5: /^\d{5}(-\d{4})?$/, pinUk: /^[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}$/i, id: /^[A-Za-z0-9][A-Za-z0-9\-_/.:]{1,29}$/, digits: /^\d+$/, alpha: /^[A-Za-z][A-Za-z\s.'&-]*$/
};
function shapeOf(s) { let out = '', prev = '', n = 0; for (const ch of s.length > 40 ? s.slice(0, 40) : s) { const c = /[0-9]/.test(ch) ? '9' : /[A-Z]/.test(ch) ? 'A' : /[a-z]/.test(ch) ? 'a' : ch; if (c === prev) n++; else { if (n) out += prev + (n > 1 ? `{${n}}` : ''); prev = c; n = 1; } } if (n) out += prev + (n > 1 ? `{${n}}` : ''); return out; }
const bump = (m, k, cap) => { const v = m.get(k); if (v !== undefined) m.set(k, v + 1); else if (m.size < cap) m.set(k, 1); };

class Acc {
  constructor() {
    this.rows = 0; this.n = 0; this.k = { date: 0, date_unresolved: 0, date_invalid: 0, time: 0, number: 0, numeric_text: 0, boolean: 0, error: 0, text: 0 };
    this.vc = new Map(); this.capped = false; this.len = new Map(); this.pre = new Map(); this.shape = new Map();
    this.t = { sumLen: 0, maxLen: 0, sumWords: 0, hasDigit: 0, allDigits: 0, email: 0, gstin: 0, pan: 0, url: 0, phoneFmt: 0, phonePlain: 0, mobile10: 0, pin: 0, id: 0, alpha: 0, comma: 0, state: 0, country: 0, currency: 0, uom: 0, addr: 0, org: 0, title: 0, padded: 0 };
    this.num = { min: Infinity, max: -Infinity, int: true, nonneg: 0, r100: 0, count: 0, mobile: 0, pin: 0 };
    this.mono = { prev: null, pairs: 0, step1: 0, inc: 0 };
  }
  add(raw, meta) {
    this.rows++;
    if (raw === undefined || raw === null) return;
    const mk = meta && meta.k;
    if (mk === 'date_only' || mk === 'datetime' || (mk === 'text_date' && meta.st === 'parsed')) this.k.date++;
    else if (mk === 'text_date') this.k.date_unresolved++;
    else if (mk === 'invalid_date') this.k.date_invalid++;
    else if (mk === 'time_only') this.k.time++;
    else if (mk === 'error') { this.k.error++; this.n++; return; }
    else if (typeof raw === 'number') this.k.number++;
    else if (typeof raw === 'boolean') this.k.boolean++;
    else if (typeof raw === 'string') { if (raw.trim() === '') return; this.k.text++; }
    else return;
    this.n++;
    bump(this.vc, typeof raw === 'string' ? 's' + raw : typeof raw + raw, CAP); if (this.vc.size >= CAP) this.capped = true;
    if (typeof raw === 'number' && !mk) {
      const v = raw, u = this.num; this.numStats(v);
      if (Number.isInteger(v)) { const d = String(v); if (/^[6-9]\d{9}$/.test(d)) u.mobile++; if (/^[1-9]\d{5}$/.test(d) || /^\d{5}$/.test(d)) u.pin++; }   // phones / PINs stored as numbers
      this.step(v);
    } else if (typeof raw === 'string' && !mk) {
      const s = raw.trim(), t = this.t, L = s.length;
      if (NUMERIC_TEXT.test(s) && !/^0\d/.test(s)) { this.k.numeric_text++; this.numStats(Number(s.replace(/,/g, ''))); }   // "10", "-5", "1,250.50" count as numeric (not "007": leading zeros mark identifiers)
      t.sumLen += L; if (L > t.maxLen) t.maxLen = L; if (s !== raw) t.padded++;
      const words = s.split(/\s+/); t.sumWords += words.length; bump(this.len, L, 200); bump(this.pre, s.slice(0, 3), 500); bump(this.shape, shapeOf(s), 200);
      const up = s.toUpperCase();
      if (/\d/.test(s)) t.hasDigit++; if (RX.digits.test(s)) { t.allDigits++; if (s.length <= 15) this.step(Number(s)); }
      if (RX.email.test(s)) t.email++; if (RX.gstin.test(up)) t.gstin++; if (RX.pan.test(up)) t.pan++; if (RX.url.test(s)) t.url++;
      if (RX.phoneChars.test(s) && !RX.dateLike.test(s)) { const d = s.replace(/\D/g, '').length; if (d >= 7 && d <= 15) { if (/[+()\s.\-]/.test(s)) t.phoneFmt++; else t.phonePlain++; } }
      if (RX.mobile10.test(s.replace(/[\s-]/g, ''))) t.mobile10++;
      if (RX.pin6.test(s) || RX.pin5.test(s) || RX.pinUk.test(s)) t.pin++;
      if (RX.id.test(s) && /\d/.test(s)) t.id++; if (RX.alpha.test(s)) t.alpha++; if (s.includes(',')) t.comma++;
      const low = s.toLowerCase();
      if (G.STATE_NAMES.has(low)) t.state++; if (G.COUNTRIES.has(low)) t.country++; if (G.CURRENCY_CODES.has(up)) t.currency++; if (G.UOM_CODES.has(up)) t.uom++;
      const wl = low.split(/[^a-z0-9]+/).filter(Boolean); if (wl.some(w => G.ADDRESS_TOKENS.has(w))) t.addr++; if (wl.some(w => G.ORG_SUFFIX.has(w))) t.org++;
      const aw = words.filter(w => /[A-Za-z]/.test(w)); if (aw.length && aw.every(w => /^[A-Z]/.test(w))) t.title++;   // numeric words ("Works 05") do not break title case
    }
  }
  numStats(v) { const u = this.num; u.count++; if (v < u.min) u.min = v; if (v > u.max) u.max = v; if (!Number.isInteger(v)) u.int = false; if (v >= 0) u.nonneg++; if (v >= 0 && v <= 100) u.r100++; }
  step(v) { const m = this.mono; if (m.prev !== null) { m.pairs++; if (v - m.prev === 1) m.step1++; if (v > m.prev) m.inc++; } m.prev = v; }
  finish(populatedRows, exactDistinct) {
    const n = this.n, f = x => (n ? x / n : 0), nt = this.k.text, ft = x => (nt ? x / nt : 0), t = this.t;
    const top = (m, tot) => { let b = 0; for (const c of m.values()) if (c > b) b = c; return tot ? b / tot : 0; };
    const modeCount = (() => { let b = 0; for (const c of this.vc.values()) if (c > b) b = c; return b; })();
    const distinct = this.capped && Number.isFinite(exactDistinct) ? exactDistinct : this.vc.size;   // never let the tracking cap make a unique column look repetitive
    return { version: PROFILE_VERSION, rows: this.rows, populated: n, distinct, distinct_capped: this.capped, distinct_exact_from_ingest: this.capped && Number.isFinite(exactDistinct), unique_ratio: n ? Math.min(1, distinct / n) : 0, mode_share: f(modeCount),
      kinds: { date: f(this.k.date), date_unresolved: f(this.k.date_unresolved), date_invalid: f(this.k.date_invalid), time: f(this.k.time), number: f(this.k.number), numeric_text: f(this.k.numeric_text), boolean: f(this.k.boolean), text: f(this.k.text), error: f(this.k.error) },
      text: nt ? { count: nt, avg_len: t.sumLen / nt, max_len: t.maxLen, avg_words: t.sumWords / nt, has_digit: ft(t.hasDigit), all_digits: ft(t.allDigits), email: ft(t.email), gstin: ft(t.gstin), pan: ft(t.pan), url: ft(t.url),
        phone_formatted: ft(t.phoneFmt), phone_plain: ft(t.phonePlain), mobile10: ft(t.mobile10), pin: ft(t.pin), id_shape: ft(t.id), alpha_only: ft(t.alpha), comma: ft(t.comma), state_name: ft(t.state), country: ft(t.country),
        currency_code: ft(t.currency), uom_code: ft(t.uom), address_token: ft(t.addr), org_suffix: ft(t.org), title_case: ft(t.title), padded: ft(t.padded),
        len_uniform: top(this.len, nt), prefix3_share: top(this.pre, nt), top_shape_share: top(this.shape, nt) } : null,
      number: this.num.count ? { count: this.num.count, min: this.num.min, max: this.num.max, integers_only: this.num.int, non_negative: this.num.nonneg / this.num.count, within_0_100: this.num.r100 / this.num.count, mobile10: this.num.mobile / this.num.count, pin: this.num.pin / this.num.count } : null,
      sequence: this.mono.pairs ? { step1_share: this.mono.step1 / this.mono.pairs, increasing_share: this.mono.inc / this.mono.pairs } : null };
  }
}
/** columns: [{ header_key, ... }]; rows: iterable of { raw, meta }  ->  profiles aligned with columns */
function profileColumns(columns, rows) {
  const accs = columns.map(() => new Acc()); const keys = columns.map(c => c.header_key);
  for (const r of rows) { const raw = r.raw, meta = r.meta || {}; for (let i = 0; i < keys.length; i++) accs[i].add(raw[keys[i]], meta[keys[i]]); }
  return accs.map((a, i) => a.finish(undefined, columns[i].distinct_count));
}
module.exports = { PROFILE_VERSION, profileColumns };
