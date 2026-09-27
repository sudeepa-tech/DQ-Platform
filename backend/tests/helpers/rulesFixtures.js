'use strict';
/* Snapshot-format fixtures for the rules engine: columns exactly as the confirmed S3 mapping snapshot carries them, rows as the canonical ingest yields them. */
const V = (rule_id, params) => (params ? { rule_id, params } : { rule_id });
/** col(header, role, { req, validators:[ruleId|{rule_id,params}], status, include, primary }) */
function col(header, role, o = {}) {
  return { header_key: o.key || header, header_raw: header, position: o.pos, role, requiredness: o.req || 'optional', include_in_analysis: o.include !== false, primary_for_role: o.primary,
    validation_profile: { status: o.status || 'active', validators: (o.validators || []).map(v => (typeof v === 'string' ? V(v) : v)) } };
}
/* cell forms: primitive -> raw value | null/undefined -> blank | { d: '2024-01-05' } real date | { dt: '2024-01-05T10:30:00' } datetime | { bad: '31.02.2024' } calendar-invalid text date | { amb: '03/04/2024' } ambiguous text date */
function cell(v) {
  if (v === null || v === undefined) return {};
  if (typeof v === 'object' && v.d) return { raw: v.d, canonical: v.d, meta: { k: 'date_only' } };
  if (typeof v === 'object' && v.dt) return { raw: v.dt, canonical: v.dt, meta: { k: 'datetime' } };
  if (typeof v === 'object' && v.bad) return { raw: v.bad, meta: { k: 'invalid_date', why: 'calendar_invalid' } };
  if (typeof v === 'object' && v.amb) return { raw: v.amb, meta: { k: 'text_date', st: 'needs_configuration' } };
  return { raw: v };
}
/** table(columns, rowFn | rows[]) -> { columns, rows }   rowFn(i) returns { header: cellSpec } */
function table(columns, rowsOrFn, n) {
  columns.forEach((c, i) => { if (c.position === undefined) c.position = i; });
  const list = typeof rowsOrFn === 'function' ? Array.from({ length: n }, (_, i) => rowsOrFn(i)) : rowsOrFn;
  const rows = list.map((spec, i) => { const raw = {}, meta = {}, canonical = {}; for (const [k, v] of Object.entries(spec)) { const c = cell(v); if (c.raw !== undefined) raw[k] = c.raw; if (c.meta) meta[k] = c.meta; if (c.canonical !== undefined) canonical[k] = c.canonical; } return { rowNumber: i + 1, sheetRow: i + 2, raw, meta, canonical }; });
  return { columns, rows };
}
const pad = (n, w = 2) => String(n).padStart(w, '0');
module.exports = { col, table, V, pad };
