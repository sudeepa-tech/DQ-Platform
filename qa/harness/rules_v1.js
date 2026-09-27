'use strict';
/* QA adapter for the S4 rules layer. Runs the REAL path end to end in a temp database: S2 canonical ingest -> S3 semantic mapping (suggestions accepted = "confirmed") ->
   immutable configuration snapshot (with rule configuration + run settings) -> rules from that snapshot. Memoized per (file, settings). Test tooling only. */
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const REPO = path.resolve(__dirname, '..', '..'); const B = p => require(path.join(REPO, 'backend/src', p));
const { DatabaseSync } = require('node:sqlite'); const cache = new Map();
const todayISO = () => new Date().toISOString().slice(0, 10);   // the QA harness owns the clock; the rules layer never reads it
function analyzeFile(file, { sheet, today = todayISO(), staleYears = 4, ruleOverrides, mappingEdits } = {}) {
  const key = [file, sheet || '', fs.statSync(file).mtimeMs, today, staleYears, JSON.stringify(ruleOverrides || {}), JSON.stringify(mappingEdits || [])].join('|'); if (cache.has(key)) return cache.get(key);
  const { migrate } = B('db/migrate'); const { ingestFile } = B('ingest'); const svc = B('semantic/schemaService'); const cs = B('semantic/configSnapshot'); const { runRulesFromSnapshot } = B('rules/ruleService');
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dq-rules-qa-')), 't.db'); const db = new DatabaseSync(f); db.exec('PRAGMA foreign_keys=ON'); migrate(db, { dbFile: f });
  db.exec("INSERT INTO organizations(id,name) VALUES('o','O'); INSERT INTO users(id,organization_id,name,email,password_hash,role) VALUES('u','o','U','u@x','x','admin'); INSERT INTO datasets(id,organization_id,name) VALUES('d','o','D')");
  const ing = ingestFile(db, { datasetId: 'd', filePath: file, sheetName: sheet }); const sf = ing.sourceFileId; svc.suggestMapping(db, sf, { userId: 'u' });
  for (const e of mappingEdits || []) { const col = db.prepare('SELECT id FROM file_columns WHERE source_file_id = ? AND header_key = ?').get(sf, e.header_key); svc.overrideColumn(db, sf, 1, col.id, e.change, 'u'); }
  svc.confirmMapping(db, sf, 1, { userId: 'u', acceptSuggestions: true });
  const cfg = cs.createAnalysisConfig(db, { datasetId: 'd', sources: [{ source_file_id: sf, mapping_version: 1 }], settings: { stale_threshold_years: staleYears, reference_date_mode: 'fixed', reference_date: today }, ruleOverrides, userId: 'u' });
  const result = runRulesFromSnapshot(db, { configId: cfg.config_id, sourceFileId: sf }); const out = { db, result, sourceFileId: sf, configId: cfg.config_id, model: svc.getReviewModel(db, sf, 1), today }; cache.set(key, out); return out;
}
/** findings -> the legacy issue vocabulary the scorer already understands ({ key, category, type, field, severity }); group findings expand to one issue per member record (as the legacy view counted them) */
function toLegacyIssues(out, keyColumn) {
  const { db, sourceFileId, result } = out; const col = out.model.columns.find(c => c.header_raw.trim() === keyColumn); const kk = col ? col.header_key : null; const keys = new Map();
  if (kk) for (const r of db.prepare('SELECT row_number, raw_json FROM source_rows WHERE source_file_id = ?').all(sourceFileId)) { const v = JSON.parse(r.raw_json)[kk]; keys.set(r.row_number, v === undefined || v === null ? null : String(v).trim()); }
  const issues = [];
  for (const f of result.findings) {
    const base = { category: f.category, type: f.type, field: f.header_raw ? f.header_raw.trim() : null, severity: f.severity, scope: f.scope, rule: f.rule_id };
    if (f.scope === 'dataset') issues.push({ ...base, key: null });
    else if (f.scope === 'group') for (const m of f.rows) issues.push({ ...base, key: keys.get(m.row_number) || null });
    else issues.push({ ...base, key: keys.get(f.row_number) || null });
  }
  return issues;
}
/** row_number -> value of the header the view is keyed by (the test's business key) */
function rowKeys(out, keyColumn) {
  const col = out.model.columns.find(c => c.header_raw.trim() === keyColumn); const keys = new Map(); if (!col) return keys;
  for (const r of out.db.prepare('SELECT row_number, raw_json FROM source_rows WHERE source_file_id = ?').all(out.sourceFileId)) { const v = JSON.parse(r.raw_json)[col.header_key]; keys.set(r.row_number, v === undefined || v === null ? null : String(v).trim()); } return keys;
}
module.exports = { analyzeFile, toLegacyIssues, rowKeys, todayISO };
