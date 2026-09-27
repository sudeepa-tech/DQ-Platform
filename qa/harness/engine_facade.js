'use strict';
/* The ONLY place regression tests touch engine internals for schema profiling.
   S2: the INGEST layer (physical columns, column counts, populated ratios, parsed values) is wired to the new canonical ingest (harness/engine_under_test.js: QA_INGEST=legacy restores the old parser).
   S3: the SEMANTIC layer (semantic_class, review_required, confidence) is wired to backend/src/semantic (QA_SEMANTIC=legacy restores the old profiler); test files and expectations are unchanged.
   The v1 role names are translated to the S0 pre-registered class vocabulary by V1_TO_QA below (test tooling only; the truth files keep their own vocabulary).
   Contract for the new engine: each profile exposes { column, index, semantic_class, review_required, confidence, null_pct }. */
const path = require('path'); const REPO = path.resolve(__dirname, '..', '..'); const ENGINE = require('./engine_under_test');
const LEGACY_CLASS = { name: 'entity_name', address: 'address', phone: 'phone', email: 'email', gstin: 'legal_id', pan: 'legal_id', item_code: 'material_key', item_desc: 'material_description', created_date: 'created_date', modified_date: 'modified_date', status: 'status', identifier: 'identifier', numeric: 'number', categorical: 'category', unknown: 'unmapped', unclassified_date: 'date' };
const V1_TO_QA = { name: 'entity_name', description: 'material_description', material_id: 'material_key', creation_date: 'created_date', modification_date: 'modified_date', postal_code: 'postal', doc_id: 'doc_key', unit_price: 'price', unknown: 'unmapped' };
const FAMILY = { city: 'address', doc_key: 'identifier', doc_ref: 'identifier', entity_id: 'identifier', row_id: 'identifier' };   // generous to legacy: it has no typed identifiers
const _v1 = new Map();
function v1Read(file, sheet) {   // in-memory canonical ingest (same code path as the persisted ingest)
  const k = file + '|' + (sheet || ''); if (!_v1.has(k)) { const { openSource } = require(path.join(REPO, 'backend/src/ingest/reader')); const { readCanonical } = require(path.join(REPO, 'backend/src/ingest/canonicalize')); _v1.set(k, readCanonical(openSource(file, { sheetName: sheet }), {})); }
  return _v1.get(k);
}
/** physical columns as the engine's ingest layer sees them: [{ index, header, values }]  (values: canonical value where one exists, else raw; blank = null) */
function parseColumns(file, sheet) {
  if (ENGINE.ingest === 'v1') { const c = v1Read(file, sheet); return c.columns.map(col => ({ index: col.position, header: col.header_raw.trim(), key: col.header_key, values: c.rows.map(r => (r.canonical[col.header_key] !== undefined ? r.canonical[col.header_key] : (r.raw[col.header_key] === undefined ? null : r.raw[col.header_key]))) })); }
  const { parseXlsxSheet } = require(path.join(REPO, 'backend/legacy_v0/engines/fileParser')); const { headers, rows } = parseXlsxSheet(file, sheet);
  return Object.keys(rows[0] || {}).map((k, i) => ({ index: i, header: k, key: k, values: rows.map(r => r[k]) }));
}
function profileFile(file, sheet) {
  if (ENGINE.semantic === 'v1') {   // S3 semantic layer: canonical ingest -> profile -> role classification (pure, in memory)
    const c = v1Read(file, sheet); const S = require(path.join(REPO, 'backend/src/semantic')); const r = S.analyzeSemantics(c.columns, c.rows);
    return { headerCells: c.columns.length, rowKeys: new Set(c.columns.map(x => x.header_key)).size, dataset: r.dataset,
      profiles: r.mappings.map((m, i) => ({ index: i, column: c.columns[i].header_raw.trim(), key: c.columns[i].header_key, role: m.role, semantic_class: V1_TO_QA[m.role] || m.role, review_required: m.review_required, confidence: m.confidence, requiredness: m.requiredness, null_pct: 1 - c.columns[i].populated_ratio })) };
  }
  const { parseXlsxSheet } = require(path.join(REPO, 'backend/legacy_v0/engines/fileParser')); const { profileSheet } = require(path.join(REPO, 'backend/legacy_v0/engines/schemaProfiler'));
  const { headers, rows } = parseXlsxSheet(file, sheet); const profiles = profileSheet(rows, headers);   // legacy semantic layer (QA_SEMANTIC=legacy)
  let headerCells = headers.length, rowKeys = Object.keys(rows[0] || {}).length, physical = null;
  if (ENGINE.ingest === 'v1') { const c = v1Read(file, sheet); headerCells = c.columns.length; rowKeys = new Set(c.columns.map(x => x.header_key)).size; physical = c.columns; }
  return { headerCells, rowKeys,
    profiles: profiles.map((p, i) => ({ index: i, column: p.column_name, role: p.inferred_role, semantic_class: p.semantic_class || LEGACY_CLASS[p.inferred_role] || p.inferred_role, review_required: p.review_required === true, confidence: p.role_confidence,
      null_pct: physical && physical[i] ? 1 - physical[i].populated_ratio : p.null_pct })) };
}
const acceptsClass = (want, got) => got === want || FAMILY[want] === got;
module.exports = { profileFile, parseColumns, acceptsClass, LEGACY_CLASS, FAMILY, V1_TO_QA, REPO };
