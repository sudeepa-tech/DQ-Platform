'use strict';
/* Text primitives for identity matching: normalization, numeric tokens, similarity. Pure. Similarity is normalized Damerau-Levenshtein (optimal string alignment), not a token-set score. */
const { PATTERNS } = require('../rules/validators');
const tokens = s => String(s).toLowerCase().replace(/&/g, ' and ').replace(/(?<=[a-z0-9])\.(?=[a-z])/g, '').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
function normalizeName(s, v) {
  if (s === undefined || s === null || String(s).trim() === '') return '';
  let t = tokens(String(s).replace(/^\s*m\s*\/\s*s\.?\s+/i, '')).map(x => v.abbreviations[x] || x); if (t[0] === 'ms') t = t.slice(1);
  const legal = new Set(v.legal_suffixes), drop = new Set(v.drop_words); return t.filter(x => !legal.has(x) && !drop.has(x)).join(' ');
}
const numericTokens = s => [...new Set((String(s).match(/\d+(?:\.\d+)?/g) || []).map(x => x.replace(/^0+(?=\d)/, '') || '0'))].sort();
const numSignature = s => numericTokens(s).join(',');
function osa(a, b) {
  if (a === b) return 0; const n = a.length, m = b.length; if (!n) return m; if (!m) return n; let p2 = null, p1 = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) { const cur = [i]; for (let j = 1; j <= m; j++) { const c = a[i - 1] === b[j - 1] ? 0 : 1; let d = Math.min(p1[j] + 1, cur[j - 1] + 1, p1[j - 1] + c); if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, p2[j - 2] + 1); cur[j] = d; } p2 = p1; p1 = cur; }
  return p1[m];
}
const similarity = (a, b) => { if (a === b) return 1; const A = a.slice(0, 300), B = b.slice(0, 300), L = Math.max(A.length, B.length); return L ? 1 - osa(A, B) / L : 1; };
const jaccard = (a, b) => { const x = new Set(a.split(' ').filter(Boolean)), y = new Set(b.split(' ').filter(Boolean)); let i = 0; for (const t of x) if (y.has(t)) i++; const u = x.size + y.size - i; return u ? i / u : 1; };
/** name relation: unknown | eq | sim (compatible) | different | ambiguous.  Numeric tokens are discriminators ("... 05" is not "... 06"). */
function nameRelation(a, b, cfg) {
  if (!a || !b) return { rel: 'unknown', sim: null }; if (a === b) return { rel: 'eq', sim: 1 };
  const sim = similarity(a, b); if (numSignature(a) !== numSignature(b)) return { rel: 'different', sim };
  const g = cfg.token_overlap_guard; if (sim < g.applies_below && jaccard(a, b) <= g.max_jaccard) return { rel: 'different', sim };
  if (sim >= cfg.compatible_at_or_above) return { rel: 'sim', sim }; if (sim < cfg.different_below) return { rel: 'different', sim }; return { rel: 'ambiguous', sim };
}
const UNITS = 'mm|cm|m|kg|g|ml|l|hp|sqmm|mtr|inch|ft';
function normalizeDescription(s, v) {
  if (s === undefined || s === null || String(s).trim() === '') return '';
  let t = String(s).toLowerCase().replace(/&/g, ' and ').replace(new RegExp(`(\\d)\\s*(${UNITS})\\b`, 'g'), '$1$2').replace(/(?<=[a-z0-9])\.(?=[a-z])/g, '').replace(/[^a-z0-9./ ]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.split(' ').map(x => v.abbreviations[x] || x).join(' ');
}
const descriptionCompatible = (a, b, minSim) => a === b || (similarity(a, b) >= minSim && numSignature(a) === numSignature(b));
/** Indian mobile normalization (same rule as the validity layer): 91 prefix / leading 0 stripped, must be 10 digits starting 6-9 */
function phoneKey(raw) { if (raw === undefined || raw === null) return null; let d = String(raw).replace(/\D/g, ''); if (d.length === 12 && d.startsWith('91')) d = d.slice(2); if (d.length === 11 && d.startsWith('0')) d = d.slice(1); return /^[6-9]\d{9}$/.test(d) ? d : null; }
const emailKey = raw => { if (raw === undefined || raw === null) return null; const t = String(raw).trim(); return PATTERNS.EMAIL.test(t) ? t.toLowerCase() : null; };
function legalKey(raw) { if (raw === undefined || raw === null) return null; const u = String(raw).trim().toUpperCase(); if (PATTERNS.GSTIN.test(u)) return { kind: 'gstin', value: u }; if (PATTERNS.PAN.test(u)) return { kind: 'pan', value: u }; return null; }
function vendorKey(raw, placeholders) { if (raw === undefined || raw === null) return null; const t = String(raw).trim(); if (!t || placeholders.includes(t.toLowerCase())) return null; return /^\d+$/.test(t) ? (t.replace(/^0+/, '') || '0') : t.toUpperCase(); }
function addressCore(addr, city, state) {
  if (addr === undefined || addr === null || String(addr).trim() === '') return ''; const drop = new Set([...(city ? tokens(city) : []), ...(state ? tokens(state) : [])]);
  return String(addr).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(x => x && !drop.has(x)).join(' ');
}
module.exports = { tokens, normalizeName, numericTokens, numSignature, osa, similarity, jaccard, nameRelation, normalizeDescription, descriptionCompatible, phoneKey, emailKey, legalKey, vendorKey, addressCore };
