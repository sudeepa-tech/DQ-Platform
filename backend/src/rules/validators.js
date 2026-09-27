'use strict';
/*
 * Value validators: pure functions (cell, params) -> null when the value is fine, or { reason, type? } when it is not.
 * A `cell` is the engine's uniform view of one spreadsheet cell (see makeCell). Validators never see headers: they run because the mapped ROLE says so.
 */
const G = require('../semantic/gazetteers');
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/, GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/, PAN = /^[A-Z]{5}\d{4}[A-Z]$/;
const NUMERIC = /^[+-]?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/;
const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

const parseNumeric = t => (NUMERIC.test(t) ? Number(t.replace(/,/g, '')) : null);
/** the engine's uniform cell: { blank, kind, raw, text, number, iso } */
function makeCell(raw, canonical, meta) {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) return { blank: true };
  const k = meta && meta.k; const cell = { blank: false, raw, text: typeof raw === 'string' ? raw.trim() : String(raw), number: null, iso: null, kind: 'text' };
  if (k === 'date_only' || k === 'datetime') { cell.kind = 'date'; cell.iso = canonical || null; }
  else if (k === 'text_date') { if (meta.st === 'parsed') { cell.kind = 'date'; cell.iso = canonical || null; } else cell.kind = 'date_unresolved'; }
  else if (k === 'invalid_date') cell.kind = 'invalid_date';
  else if (k === 'time_only') { cell.kind = 'time'; cell.iso = canonical || null; }
  else if (k === 'error') cell.kind = 'error';
  else if (typeof raw === 'number') { cell.kind = 'number'; cell.number = Number.isFinite(raw) ? raw : null; }
  else if (typeof raw === 'boolean') cell.kind = 'boolean';
  else cell.number = parseNumeric(cell.text);
  return cell;
}
const isTextual = c => c.kind === 'text' || c.kind === 'number';                         // numbers are checked as their digits (a PIN or phone stored as a number)
const digitsOf = c => (c.kind === 'number' && Number.isInteger(c.number) ? String(c.number) : c.text);

const V = {};
V['validity.email_format'] = c => (c.kind === 'text' && EMAIL.test(c.text) ? null : { reason: 'not shaped like an e-mail address' });
V['validity.phone_format'] = (c, p) => {
  if (!isTextual(c)) return { reason: 'not a phone number' };
  let d = digitsOf(c).replace(/\D/g, '');
  if (p.regions.includes('IN')) { let n = d; if (n.length === 12 && n.startsWith('91')) n = n.slice(2); if (n.length === 11 && n.startsWith('0')) n = n.slice(1); if (/^[6-9]\d{9}$/.test(n)) return null; }
  if (p.allow_international && /^\s*\+/.test(c.text) && !/^\s*\+\s*91/.test(c.text) && d.length >= 8 && d.length <= 15) return null;
  return { reason: `not a valid phone number for region(s) ${p.regions.join(', ')}` };
};
V['validity.legal_id_format'] = (c, p) => {
  if (c.kind !== 'text') return { reason: 'not a legal identifier' }; const u = c.text.toUpperCase();
  if (p.schemes.includes('gstin') && GSTIN.test(u)) return null; if (p.schemes.includes('pan') && PAN.test(u)) return null;
  return { reason: `does not match the ${p.schemes.map(s => s.toUpperCase()).join(' / ')} structure` };
};
function gstinCheckChar(g) { let sum = 0; for (let i = 0; i < 14; i++) { const p = CHARS.indexOf(g[i]) * ((i % 2) + 1); sum += Math.floor(p / 36) + (p % 36); } return CHARS[(36 - (sum % 36)) % 36]; }
V['validity.legal_id_gstin_checksum'] = c => { if (c.kind !== 'text') return null; const u = c.text.toUpperCase(); if (!GSTIN.test(u)) return null; return gstinCheckChar(u) === u[14] ? null : { reason: `check character should be ${gstinCheckChar(u)}` }; };   // structure is judged by legal_id_format
V['validity.legal_id_gstin_state_code'] = c => { if (c.kind !== 'text') return null; const u = c.text.toUpperCase(); if (!GSTIN.test(u)) return null; const s = +u.slice(0, 2); return (s >= 1 && s <= 38) || s === 97 || s === 99 ? null : { reason: `state code ${u.slice(0, 2)} is not a valid GST state / UT code` }; };
V['validity.postal_code_format'] = (c, p) => { if (!isTextual(c)) return { reason: 'not a postal code' }; const t = digitsOf(c); return p.patterns.some(x => new RegExp(x).test(t)) ? null : { reason: 'does not match the configured postal-code pattern(s)' }; };
const num = c => (c.kind === 'number' || c.kind === 'text' ? c.number : null);
V['validity.numeric'] = c => (num(c) === null ? { reason: 'not a number', type: 'invalid_number' } : null);
V['validity.numeric_non_negative'] = (c, p) => { const n = num(c); if (n === null) return { reason: 'not a number', type: 'invalid_number' }; return n < p.min ? { reason: `${n} is below the minimum ${p.min}`, type: 'out_of_range' } : null; };
V['validity.percentage_range'] = (c, p) => { const n = num(c); if (n === null) return { reason: 'not a number', type: 'invalid_number' }; return n < p.min || n > p.max ? { reason: `${n} is outside ${p.min}-${p.max}`, type: 'out_of_range' } : null; };
V['validity.currency_code'] = (c, p) => { if (c.kind !== 'text' || !/^[A-Z]{3}$/.test(c.text)) return { reason: 'not a three-letter upper-case currency code' }; return p.mode === 'iso_common' && !G.CURRENCY_CODES.has(c.text) ? { reason: 'not in the common ISO 4217 list' } : null; };
V['validity.uom_known'] = (c, p) => { if (!isTextual(c) || !/^[A-Za-z0-9][A-Za-z0-9.\-/%]{0,9}$/.test(c.text)) return { reason: 'not a plausible unit-of-measure code' }; return p.mode === 'known' && !G.UOM_CODES.has(c.text.toUpperCase()) ? { reason: 'not in the unit-of-measure code list' } : null; };
V['validity.identifier_format'] = (c, p) => {
  if (!isTextual(c)) return { reason: 'not an identifier' }; const raw = typeof c.raw === 'string' ? c.raw : c.text;
  if (raw !== raw.trim()) return { reason: 'padded with leading/trailing spaces' }; if (/[\u0000-\u001f]/.test(raw)) return { reason: 'contains control characters' };
  if (p.placeholders.includes(c.text.toLowerCase())) return { reason: 'placeholder, not an identifier' }; if (c.text.length > p.max_length) return { reason: `longer than ${p.max_length} characters` }; return null;
};
V['validity.text_not_placeholder'] = (c, p) => (isTextual(c) && p.placeholders.includes(c.text.toLowerCase()) ? { reason: 'the whole value is a placeholder' } : null);
V['validity.date_calendar'] = c => {
  if (c.kind === 'date' || c.kind === 'date_unresolved') return null;
  if (c.kind === 'invalid_date') return { reason: 'not a real calendar date (impossible day or month)' };
  if (c.kind === 'time') return { reason: 'a time of day where a date is expected' };
  return { reason: c.kind === 'number' ? 'a plain number, not a date' : 'not a date' };
};
V['validity.time_of_day'] = c => (c.kind === 'time' || (c.kind === 'text' && /^([01]?\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(c.text)) ? null : { reason: 'not a time of day' });
module.exports = { VALIDATORS: V, makeCell, parseNumeric, gstinCheckChar, PATTERNS: { EMAIL, GSTIN, PAN } };
