'use strict';
// Tests for the P0 additive data model (migrations 0002/0003): constraints and database-level enforcement of the
// approved semantic decisions. Never imports src/db; uses throw-away databases in the OS temp directory.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { migrate } = require('../src/db/migrate');

let seq = 0;
const nid = p => `${p}${++seq}`;
function insert(db, table, obj) {
  const cols = Object.keys(obj);
  db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map(c => obj[c]));
  return obj.id;
}
const update = (db, table, id, obj) => db.prepare(`UPDATE ${table} SET ${Object.keys(obj).map(k => `${k}=?`).join(',')} WHERE id=?`).run(...Object.values(obj), id);
const rejects = (fn, re) => assert.throws(fn, err => re.test(err.message), `expected failure matching ${re}`);

function fresh() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dq-guard-')), 't.db');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  migrate(db, { dbFile: file });
  insert(db, 'organizations', { id: 'org', name: 'O' });
  insert(db, 'users', { id: 'u', organization_id: 'org', name: 'U', email: 'u@x.com', password_hash: 'h' });
  for (const d of ['ds1', 'ds2']) insert(db, 'datasets', { id: d, organization_id: 'org', name: d });
  insert(db, 'source_files', { id: 'f1', dataset_id: 'ds1', original_filename: 'a.xlsx', stored_path: '/a', file_size_bytes: 1, file_type: 'xlsx', sheet_name: 'S' });
  insert(db, 'source_files', { id: 'f2', dataset_id: 'ds2', original_filename: 'b.xlsx', stored_path: '/b', file_size_bytes: 1, file_type: 'xlsx', sheet_name: 'S' });
  return db;
}
const PROV = { reference_date: '2026-09-24', stale_threshold_years: 4, config_hash: 'abc', table_type: 'master_entity' };
const v1run = (db, over = {}) => insert(db, 'analysis_runs', { id: nid('run'), dataset_id: 'ds1', status: 'matching', engine_version: 'v1.0.0', ...PROV, ...over });
const legacyRun = (db, over = {}) => insert(db, 'analysis_runs', { id: nid('run'), dataset_id: 'ds1', status: 'matching', ...over });
function rec(db, run, over = {}) {
  return insert(db, 'records', { id: nid('rec'), run_id: run, source_file_id: 'f1', source_row_ref: seq, raw_json: '{}', ...over });
}

test('every run created without an engine_version is stamped legacy_v0 (the legacy write path is unchanged)', () => {
  const db = fresh();
  const id = legacyRun(db);
  const r = db.prepare('SELECT engine_version, reference_date, stale_threshold_years, config_hash FROM analysis_runs WHERE id=?').get(id);
  assert.deepEqual({ ...r }, { engine_version: 'legacy_v0', reference_date: null, stale_threshold_years: null, config_hash: null });
});

test('the legacy engine write path still works: in-progress runs accept UPDATEs of records and run status; completion succeeds', () => {
  const db = fresh();
  const run = legacyRun(db);
  const r = rec(db, run);
  update(db, 'records', r, { created_date: '2024-01-01', modified_date: '2025-01-01' });   // what analysisOrchestrator does mid-run
  update(db, 'analysis_runs', run, { status: 'complete', progress_pct: 100, records_analyzed: 1, health_score: 70, health_breakdown_json: '{}' });
  assert.equal(db.prepare('SELECT status FROM analysis_runs WHERE id=?').get(run).status, 'complete');
});

test('engine_version is immutable: a legacy run can never be re-labelled as another engine', () => {
  const db = fresh(); const run = legacyRun(db);
  rejects(() => update(db, 'analysis_runs', run, { engine_version: 'v1.0.0' }), /engine_version is immutable/);
});

test('a v1 run cannot complete without frozen reference date, threshold, config hash and table type; with them it can', () => {
  const db = fresh();
  for (const missing of ['reference_date', 'stale_threshold_years', 'config_hash', 'table_type']) {
    const run = v1run(db, { [missing]: null });
    rejects(() => update(db, 'analysis_runs', run, { status: 'complete' }), /cannot complete without a frozen reference date/);
  }
  rejects(() => v1run(db, { status: 'complete', reference_date: null }), /cannot complete without a frozen reference date/);
  const ok = v1run(db); update(db, 'analysis_runs', ok, { status: 'complete' });
  assert.equal(db.prepare('SELECT status FROM analysis_runs WHERE id=?').get(ok).status, 'complete');
});

test('reference date, threshold and config are frozen once set; a completed run is fully immutable', () => {
  const db = fresh(); const run = v1run(db);
  rejects(() => update(db, 'analysis_runs', run, { reference_date: '2026-10-01' }), /frozen once set/);
  rejects(() => update(db, 'analysis_runs', run, { stale_threshold_years: 3 }), /frozen once set/);
  rejects(() => update(db, 'analysis_runs', run, { config_hash: 'other' }), /frozen once set/);
  update(db, 'analysis_runs', run, { status: 'complete', health_score: 80 });
  rejects(() => update(db, 'analysis_runs', run, { health_score: 10 }), /completed run is immutable/);
  const late = v1run(db, { reference_date: null, stale_threshold_years: null, config_hash: null, table_type: null });
  update(db, 'analysis_runs', late, { reference_date: '2026-09-24', stale_threshold_years: 2.5, config_hash: 'x', table_type: 'transaction' });   // set-once is allowed
  assert.equal(db.prepare('SELECT stale_threshold_years s FROM analysis_runs WHERE id=?').get(late).s, 2.5);
});

test('reference date must be a valid ISO date shape and the threshold must be positive', () => {
  const db = fresh();
  rejects(() => v1run(db, { reference_date: '24/09/2026' }), /CHECK/i);
  rejects(() => v1run(db, { stale_threshold_years: 0 }), /CHECK/i);
  rejects(() => v1run(db, { stale_threshold_years: -1 }), /CHECK/i);
  v1run(db, { stale_threshold_years: 1 }); v1run(db, { stale_threshold_years: 5 }); v1run(db, { stale_threshold_years: 2.5 });   // 1..5 and custom
});

test('analysis_configs: default stale threshold is 4 years; immutable; date-mode rules; new version instead of edit', () => {
  const db = fresh();
  const base = { dataset_id: 'ds1', version: 1, table_type: 'master_entity', config_json: '{"packs":{"gstin_checksum":false}}', config_hash: 'h1' };
  const c1 = insert(db, 'analysis_configs', { id: 'c1', ...base });
  const row = db.prepare('SELECT stale_threshold_years s, reference_date_mode m, reference_date d FROM analysis_configs WHERE id=?').get(c1);
  assert.deepEqual({ ...row }, { s: 4, m: 'run_date', d: null });
  rejects(() => update(db, 'analysis_configs', c1, { stale_threshold_years: 3 }), /immutable/);
  rejects(() => update(db, 'analysis_configs', c1, { config_json: '{}' }), /immutable/);
  rejects(() => insert(db, 'analysis_configs', { id: 'c1b', ...base }), /UNIQUE/i);                       // same dataset+version
  insert(db, 'analysis_configs', { id: 'c2', ...base, version: 2, stale_threshold_years: 3, config_hash: 'h2' });   // a change = new version
  rejects(() => insert(db, 'analysis_configs', { id: 'c3', ...base, version: 3, reference_date_mode: 'fixed' }), /CHECK/i);            // fixed needs a date
  rejects(() => insert(db, 'analysis_configs', { id: 'c4', ...base, version: 4, reference_date: '2026-01-01' }), /CHECK/i);            // run_date forbids one
  insert(db, 'analysis_configs', { id: 'c5', ...base, version: 5, reference_date_mode: 'fixed', reference_date: '2026-06-30', stale_threshold_years: 5 });
  rejects(() => insert(db, 'analysis_configs', { id: 'c6', ...base, version: 6, config_json: 'not json' }), /CHECK/i);
});

test('rule-level settings (validation packs on/off) work and freeze once a run uses the config', () => {
  const db = fresh();
  insert(db, 'analysis_configs', { id: 'cfg', dataset_id: 'ds1', version: 1, table_type: 'master_entity', config_json: '{}', config_hash: 'h' });
  insert(db, 'config_rule_settings', { id: 'rs1', config_id: 'cfg', rule_id: 'validity.gstin.checksum', enabled: 0 });
  insert(db, 'config_rule_settings', { id: 'rs2', config_id: 'cfg', rule_id: 'validity.postal.state_consistency', enabled: 0, params_json: '{"strict":false}' });
  rejects(() => insert(db, 'config_rule_settings', { id: 'rs3', config_id: 'cfg', rule_id: 'validity.gstin.checksum' }), /UNIQUE/i);
  rejects(() => update(db, 'config_rule_settings', 'rs1', { enabled: 1 }), /immutable/);
  v1run(db, { config_id: 'cfg' });
  rejects(() => insert(db, 'config_rule_settings', { id: 'rs4', config_id: 'cfg', rule_id: 'x' }), /already used by a run/);
});

test('source_rows: one row per file+row number, valid JSON only, permanently immutable', () => {
  const db = fresh();
  const row = { id: 'sr1', source_file_id: 'f1', row_number: 1, sheet_row: 2, source_sheet: 'S', row_identifier: 'ERP-00001', raw_json: '{"Item":"A"}', raw_hash: 'h', ingest_version: 'i1' };
  insert(db, 'source_rows', row);
  rejects(() => insert(db, 'source_rows', { ...row, id: 'sr2' }), /UNIQUE/i);
  rejects(() => insert(db, 'source_rows', { ...row, id: 'sr3', row_number: 2, raw_json: '{broken' }), /CHECK/i);
  rejects(() => insert(db, 'source_rows', { ...row, id: 'sr4', row_number: 0 }), /CHECK/i);
  rejects(() => update(db, 'source_rows', 'sr1', { raw_json: '{"Item":"B"}' }), /immutable/);
  rejects(() => update(db, 'source_rows', 'sr1', { row_identifier: 'X' }), /immutable/);
});

test('file_columns keep DUPLICATE HEADERS as distinct columns (the S0 "Material" / "Item" collapse cannot recur at the data-model level)', () => {
  const db = fresh();
  const c = (i, raw, key, dup) => ({ id: `col${i}`, source_file_id: 'f1', column_index: i, header_raw: raw, header_key: key, is_duplicate_header: dup });
  insert(db, 'file_columns', c(19, 'Item', 'Item', 0));
  insert(db, 'file_columns', c(39, 'Item', 'Item (2)', 1));
  insert(db, 'file_columns', c(44, 'Item', 'Item (3)', 1));
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM file_columns WHERE header_raw='Item'`).get().c, 3);
  rejects(() => insert(db, 'file_columns', { ...c(50, 'Item', 'Item (3)', 1) }), /UNIQUE/i);      // header_key must be unique
  rejects(() => insert(db, 'file_columns', { ...c(44, 'Other', 'Other', 0), id: 'colX' }), /UNIQUE/i);   // one column per physical position
  insert(db, 'file_columns', { ...c(0, 'Material', 'Material', 0), is_empty: 0, populated_ratio: 1 });
  insert(db, 'file_columns', { ...c(167, 'Material', 'Material (2)', 1), is_empty: 1, populated_ratio: 0 });   // empty twin stays empty and distinct
  assert.equal(db.prepare(`SELECT populated_ratio p FROM file_columns WHERE header_key='Material (2)'`).get().p, 0);
  rejects(() => insert(db, 'file_columns', { ...c(60, 'Z', 'Z', 0), id: 'colZ', populated_ratio: 1.5 }), /CHECK/i);
});

test('schema_mappings: state vocabularies, one mapping per column per version, and a mapping must belong to the same file (structure only)', () => {
  const db = fresh();
  insert(db, 'file_columns', { id: 'colA', source_file_id: 'f1', column_index: 0, header_raw: 'A', header_key: 'A' });
  insert(db, 'file_columns', { id: 'colB', source_file_id: 'f2', column_index: 0, header_raw: 'B', header_key: 'B' });
  const m = (o) => ({ id: nid('map'), source_file_id: 'f1', file_column_id: 'colA', ...o });
  insert(db, 'schema_mappings', m({ mapping_version: 1, role: 'entity_name', confidence: 0.97, confidence_tier: 'high', status: 'auto_accepted' }));
  rejects(() => insert(db, 'schema_mappings', m({ mapping_version: 1 })), /UNIQUE/i);                                  // one mapping per column per version
  rejects(() => insert(db, 'schema_mappings', m({ mapping_version: 2, file_column_id: 'colB' })), /same file/);         // colB belongs to f2
  rejects(() => insert(db, 'schema_mappings', m({ mapping_version: 3, requiredness: 'sometimes' })), /CHECK/i);         // vocabulary of states
  rejects(() => insert(db, 'schema_mappings', m({ mapping_version: 3, status: 'maybe' })), /CHECK/i);
  rejects(() => insert(db, 'schema_mappings', m({ mapping_version: 3, confidence_tier: 'certain' })), /CHECK/i);
  rejects(() => insert(db, 'schema_mappings', m({ mapping_version: 3, confidence: 1.4 })), /CHECK/i);
});

test('records lineage: source_row_id must belong to the same file AND the same row number', () => {
  const db = fresh();
  insert(db, 'source_rows', { id: 'srA', source_file_id: 'f1', row_number: 7, raw_json: '{}', raw_hash: 'h', ingest_version: 'i' });
  const run = v1run(db);
  const base = { run_id: run, raw_json: '{}' };
  insert(db, 'records', { id: 'ok', ...base, source_file_id: 'f1', source_row_ref: 7, source_row_id: 'srA', source_sheet: 'S', row_identifier: 'ERP-00007', business_hash: 'x', business_hash_excl_audit: 'y', business_key_json: '{"gstin":"27AAAAA0000A1Z5"}' });
  rejects(() => insert(db, 'records', { id: 'bad1', ...base, source_file_id: 'f1', source_row_ref: 8, source_row_id: 'srA' }), /lineage mismatch/);
  rejects(() => insert(db, 'records', { id: 'bad2', ...base, source_file_id: 'f2', source_row_ref: 7, source_row_id: 'srA' }), /lineage mismatch/);
  rejects(() => insert(db, 'records', { id: 'bad3', ...base, source_file_id: 'f1', source_row_ref: 7, source_row_id: 'nope' }), /FOREIGN KEY|lineage/i);
  rejects(() => insert(db, 'records', { id: 'bad4', ...base, source_file_id: 'f1', source_row_ref: 9, business_key_json: '{oops' }), /CHECK/i);
});

test('explicit duplicate classes: entity_match + identity_match_vendor_code_variant is representable; unknown classes are rejected', () => {
  const db = fresh(); const run = v1run(db);
  insert(db, 'entity_clusters', { id: 'k1', run_id: run, record_count: 2, confidence: 0.99, match_class: 'entity_match', match_subtype: 'identity_match_vendor_code_variant',
    decision_reason: 'Same GSTIN, compatible name; vendor codes differ', composition_json: '{"entity_match":1}' });
  for (const cls of ['exact_business_duplicate', 'normalized_duplicate', 'attribute_variant', 'audit_date_variant']) insert(db, 'entity_clusters', { id: nid('k'), run_id: run, record_count: 2, confidence: 1, match_class: cls });
  rejects(() => insert(db, 'entity_clusters', { id: 'kbad', run_id: run, record_count: 2, confidence: 1, match_class: 'probably_same' }), /CHECK/i);
});

test('fuzzy candidates are stored as reviewable pairs; review is a decision record and a completed run\'s scored inputs stay frozen (structure only)', () => {
  const db = fresh(); const run = v1run(db); const a = rec(db, run), b = rec(db, run);
  insert(db, 'entity_clusters', { id: 'cl', run_id: run, record_count: 2, confidence: 0.9, match_class: 'entity_match' });
  const pair = (o) => ({ id: nid('pair'), run_id: run, record_a_id: a, record_b_id: b, match_type: 'fuzzy', similarity_score: 0.9, confidence: 0.8, ...o });
  const ok = insert(db, 'match_pairs', pair({ pair_class: 'fuzzy_candidate', decision: 'fuzzy_candidate', review_status: 'pending', is_scored: 0, reason_text: 'name similar, phone+email equal' }));
  rejects(() => insert(db, 'match_pairs', pair({ pair_class: 'made_up_class' })), /CHECK/i);                       // vocabulary of class names
  rejects(() => insert(db, 'match_pairs', pair({ review_status: 'maybe' })), /CHECK/i);
  update(db, 'analysis_runs', run, { status: 'complete' });                                                       // run completes ...
  update(db, 'match_pairs', ok, { review_status: 'confirmed', reviewed_by: 'u', reviewed_at: '2026-09-25', review_note: 'same firm' });   // decision record: allowed
  rejects(() => update(db, 'match_pairs', ok, { is_scored: 1 }), /completed run are immutable/);       // ... but it cannot silently change a finished run's scored inputs
  rejects(() => update(db, 'match_pairs', ok, { cluster_id: 'cl' }), /completed run are immutable/);   // (effect is applied by a re-run, not by editing results)
  rejects(() => update(db, 'match_pairs', ok, { similarity_score: 0.1 }), /completed run are immutable/);   // evidence itself is frozen
});

test('quality issues: dataset/field-scope issues carry no record; a dataset-level issue for an empty required column is ONE row (structure only)', () => {
  const db = fresh(); const run = v1run(db); const r = rec(db, run);
  const iss = (o) => ({ id: nid('iss'), run_id: run, category: 'completeness', issue_type: 'missing_field', severity: 'high', explanation: 'x', detection_method: 'rule', ...o });
  insert(db, 'quality_issues', iss({ scope: 'dataset', record_id: null, requiredness: 'required', rule_id: 'completeness.required_column_empty' }));
  insert(db, 'quality_issues', iss({ scope: 'field', record_id: null }));
  rejects(() => insert(db, 'quality_issues', iss({ scope: 'dataset', record_id: r })), /carry no record id/);
  rejects(() => insert(db, 'quality_issues', iss({ scope: 'field', record_id: r })), /carry no record id/);
  rejects(() => insert(db, 'quality_issues', iss({ scope: 'universe' })), /CHECK/i);
  rejects(() => insert(db, 'quality_issues', iss({ record_id: r, requiredness: 'sometimes' })), /CHECK/i);
  const q = insert(db, 'quality_issues', iss({ record_id: r, requiredness: null }));
  rejects(() => update(db, 'quality_issues', q, { scope: 'dataset' }), /carry no record id/);
});

test('business policies are NOT database constraints: they live in versioned analysis/rule configuration (architectural rule, S2)', () => {
  const db = fresh(); const run = v1run(db); const a = rec(db, run), b = rec(db, run);
  // requiredness -> severity mapping and "optional gaps are not defects" are rule configuration, not schema
  const iss = (o) => ({ id: nid('iss'), run_id: run, record_id: a, category: 'completeness', issue_type: 'missing_field', explanation: 'x', detection_method: 'rule', ...o });
  insert(db, 'quality_issues', iss({ requiredness: 'optional', severity: 'high' }));
  insert(db, 'quality_issues', iss({ requiredness: 'required', severity: 'low' }));
  insert(db, 'quality_issues', iss({ requiredness: 'expected', severity: 'critical' }));
  // "a heuristic can never make a field REQUIRED" / auto-accept confidence are policy of the schema-mapping engine
  insert(db, 'file_columns', { id: 'colP', source_file_id: 'f1', column_index: 0, header_raw: 'A', header_key: 'A' });
  insert(db, 'schema_mappings', { id: nid('map'), source_file_id: 'f1', file_column_id: 'colP', mapping_version: 1, requiredness: 'required', requiredness_source: 'inferred', status: 'auto_accepted', confidence_tier: 'low' });
  // fuzzy-candidate clustering/scoring policy is matching-engine behaviour (and an acceptance bar in the QA suite), not a DB rule
  insert(db, 'entity_clusters', { id: nid('cl'), run_id: run, record_count: 2, confidence: 0.7, match_class: 'fuzzy_candidate', review_status: 'pending' });
  insert(db, 'match_pairs', { id: nid('pair'), run_id: run, record_a_id: a, record_b_id: b, match_type: 'fuzzy', similarity_score: 0.9, confidence: 0.8, pair_class: 'fuzzy_candidate', review_status: 'pending', is_scored: 1 });
});

test('every database trigger is on the STRUCTURAL allow-list (provenance, immutability, lineage, legacy protection) - a new business trigger fails this test', () => {
  const db = fresh();
  const actual = db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name`).all().map(r => r.name);
  const STRUCTURAL = [
    // configuration immutability
    'trg_analysis_configs_immutable', 'trg_config_rule_settings_immutable', 'trg_config_rule_settings_frozen',
    // run provenance / completed-run immutability / re-run lineage
    'trg_runs_engine_version_immutable', 'trg_runs_provenance_frozen_once_set', 'trg_runs_complete_frozen', 'trg_runs_v1_complete_gate_update', 'trg_runs_v1_complete_gate_insert',
    'trg_runs_parent_valid_insert', 'trg_runs_parent_valid_update',
    'trg_records_complete_frozen', 'trg_issues_complete_frozen', 'trg_clusters_complete_frozen', 'trg_pairs_complete_frozen', 'trg_conflicts_complete_frozen',
    // v1 result tables are never written for legacy or completed runs
    'trg_run_inputs_writable', 'trg_match_evidence_writable', 'trg_conflict_groups_writable', 'trg_conflict_group_members_writable', 'trg_score_contributions_writable', 'trg_run_scores_writable',
    // lineage self-consistency
    'trg_source_rows_immutable', 'trg_records_lineage_consistent', 'trg_schema_mappings_column_consistent', 'trg_match_evidence_run_consistent', 'trg_cgm_run_consistent',
    'trg_issues_scope_no_record_insert', 'trg_issues_scope_no_record_update', 'trg_issues_writable',
    // S6: the persisted finding model (finding_members links a finding to the records it involves; run_rule_stats is S7's input contract) - same
    // writable-only-for-v1/non-complete-runs and same-run-consistency pattern as the S5 result-table guards above.
    'trg_finding_members_run_consistent', 'trg_finding_members_writable', 'trg_run_rule_stats_writable',
    // S2: physical ingest facts
    'trg_file_columns_physical_immutable', 'trg_source_rows_canonical_immutable', 'trg_source_files_ingest_frozen', 'trg_source_files_ingest_status_final', 'trg_source_rows_lineage_consistent',
    // S3: a LOCKED mapping version (and its column mappings) is immutable - a change is a new mapping version. Pure immutability, like the configuration guards above.
    'trg_mapping_sets_locked_immutable', 'trg_schema_mappings_locked_insert', 'trg_schema_mappings_locked_update'
  ].sort();
  assert.deepEqual(actual, STRUCTURAL, 'a trigger was added or removed: business decisions must not be database triggers');
  // S3 guard: the mapping-lock triggers may test ONLY lock state - no role names, thresholds, requiredness or any other semantic vocabulary
  const s3 = db.prepare(`SELECT name, sql FROM sqlite_master WHERE type='trigger' AND name IN ('trg_mapping_sets_locked_immutable','trg_schema_mappings_locked_insert','trg_schema_mappings_locked_update')`).all();
  assert.equal(s3.length, 3);
  for (const t of s3) { assert.match(t.sql, /locked_at IS NOT NULL/); assert.doesNotMatch(t.sql, /confidence|requiredness|severity|threshold|role\s*(=|IN|<>)|dataset_type|'(phone|email|name|legal_id|material_id)'/i, `${t.name} must stay structural`); }
});

test('conflict groups: one row per (run, type, member set); members must belong to the same run', () => {
  const db = fresh(); const run = v1run(db), other = v1run(db); const a = rec(db, run), b = rec(db, run), z = rec(db, other);
  const g = { id: nid('cg'), run_id: run, conflict_type: 'gstin_shared_identity', severity: 'high', subject_role: 'legal_id', subject_value: '27AAAAA0000A1Z5', member_set_hash: 'H1', member_count: 2, explanation: 'x', fields_json: '{"gstin":"same","name":"different"}' };
  insert(db, 'conflict_groups', g);
  rejects(() => insert(db, 'conflict_groups', { ...g, id: nid('cg') }), /UNIQUE/i);                                   // the 3x inflation cannot be stored
  insert(db, 'conflict_groups', { ...g, id: nid('cg'), conflict_type: 'shared_contact' });                             // same members, different type: allowed
  rejects(() => insert(db, 'conflict_groups', { ...g, id: nid('cg'), member_set_hash: 'H2', member_count: 1 }), /CHECK/i);
  insert(db, 'conflict_group_members', { id: nid('m'), run_id: run, conflict_group_id: g.id, record_id: a, member_role: 'majority' });
  insert(db, 'conflict_group_members', { id: nid('m'), run_id: run, conflict_group_id: g.id, record_id: b, member_role: 'minority', values_json: '{"desc":"Bolt M10"}' });
  rejects(() => insert(db, 'conflict_group_members', { id: nid('m'), run_id: run, conflict_group_id: g.id, record_id: a }), /UNIQUE/i);
  rejects(() => insert(db, 'conflict_group_members', { id: nid('m'), run_id: run, conflict_group_id: g.id, record_id: z }), /same run/);
});

test('match evidence: relation / evidence class enumerations and same-run pairing', () => {
  const db = fresh(); const run = v1run(db), other = v1run(db); const a = rec(db, run), b = rec(db, run);
  const p = insert(db, 'match_pairs', { id: nid('pair'), run_id: run, record_a_id: a, record_b_id: b, match_type: 'multi_field', similarity_score: 1, confidence: 1, pair_class: 'entity_match', decision: 'same_entity', review_status: 'not_required' });
  const ev = (o) => ({ id: nid('ev'), run_id: run, match_pair_id: p, field_role: 'legal_id', value_a_raw: '27AAAAA0000A1Z5', value_b_raw: '27AAAAA0000A1Z5', relation: 'equal', evidence_class: 'hard_agree', ...o });
  insert(db, 'match_evidence', ev({}));
  insert(db, 'match_evidence', ev({ field_role: 'vendor_code', value_a_raw: 'V1', value_b_raw: 'V2', relation: 'different', evidence_class: 'weak_support', explanation: 'vendor code is system-specific; not an identity conflict' }));
  rejects(() => insert(db, 'match_evidence', ev({ relation: 'kind_of_same' })), /CHECK/i);
  rejects(() => insert(db, 'match_evidence', ev({ evidence_class: 'vibes' })), /CHECK/i);
  rejects(() => insert(db, 'match_evidence', ev({ similarity: 1.2 })), /CHECK/i);
  rejects(() => insert(db, 'match_evidence', ev({ run_id: other })), /same run|legacy|completed/);
});

test('score contributions: every rule\'s effect on a score is stored; defects can never exceed opportunities', () => {
  const db = fresh(); const run = v1run(db);
  const s = (o) => ({ id: nid('sc'), run_id: run, source_file_id: 'f1', dimension: 'validity', rule_id: 'validity.gstin.structure', scope: 'cell', opportunities: 310, defects: 3, defect_rate: 3 / 310, severity_weight: 1, penalty_points: 0.97, ...o });
  insert(db, 'score_contributions', s({}));
  rejects(() => insert(db, 'score_contributions', s({ id: nid('sc') })), /UNIQUE/i);
  rejects(() => insert(db, 'score_contributions', s({ id: nid('sc'), rule_id: 'r2', defects: 400 })), /CHECK/i);
  rejects(() => insert(db, 'score_contributions', s({ id: nid('sc'), rule_id: 'r3', dimension: 'vibes' })), /CHECK/i);
  insert(db, 'run_scores', { run_id: run, dimension: 'overall', score: 92.5, formula_version: 'p0.1' });
  rejects(() => insert(db, 'run_scores', { run_id: run, dimension: 'overall', score: 93, formula_version: 'p0.1' }), /UNIQUE|PRIMARY/i);
  rejects(() => insert(db, 'run_scores', { run_id: run, dimension: 'validity', score: 101, formula_version: 'p0.1' }), /CHECK/i);
});

test('LEGACY RUNS are protected: v1 result rows can never be written into a legacy run (no silent re-interpretation)', () => {
  const db = fresh(); const run = legacyRun(db); const a = rec(db, run), b = rec(db, run);
  const guard = /cannot be written to a legacy run or a completed run/;
  rejects(() => insert(db, 'score_contributions', { id: nid('sc'), run_id: run, dimension: 'validity', rule_id: 'r', scope: 'cell', opportunities: 1, defects: 0, defect_rate: 0, severity_weight: 1, penalty_points: 0 }), guard);
  rejects(() => insert(db, 'run_scores', { run_id: run, dimension: 'overall', score: 50, formula_version: 'x' }), guard);
  rejects(() => insert(db, 'conflict_groups', { id: nid('cg'), run_id: run, conflict_type: 't', severity: 'low', member_set_hash: 'h', member_count: 2, explanation: 'e' }), guard);
  rejects(() => insert(db, 'run_inputs', { run_id: run, source_file_id: 'f1', mapping_version: 1, row_count: 1 }), guard);
  const p = insert(db, 'match_pairs', { id: nid('pair'), run_id: run, record_a_id: a, record_b_id: b, match_type: 'fuzzy', similarity_score: 0.9, confidence: 0.9 });
  rejects(() => insert(db, 'match_evidence', { id: nid('ev'), run_id: run, match_pair_id: p, field_role: 'x', relation: 'equal', evidence_class: 'neutral' }), guard);
  // and a v1 run accepts them while in progress, but not once completed
  const v = v1run(db);
  insert(db, 'run_inputs', { run_id: v, source_file_id: 'f1', mapping_version: 1, row_count: 1 });
  insert(db, 'run_scores', { run_id: v, dimension: 'overall', score: 90, formula_version: 'x' });
  update(db, 'analysis_runs', v, { status: 'complete' });
  rejects(() => insert(db, 'run_scores', { run_id: v, dimension: 'validity', score: 90, formula_version: 'x' }), guard);
});

test('results of a COMPLETED run are immutable on every legacy result table; in-progress runs stay writable', () => {
  const db = fresh(); const run = legacyRun(db); const a = rec(db, run), b = rec(db, run);
  const q = insert(db, 'quality_issues', { id: nid('iss'), run_id: run, record_id: a, category: 'validity', issue_type: 'x', severity: 'low', explanation: 'e', detection_method: 'rule' });
  const c = insert(db, 'entity_clusters', { id: nid('cl'), run_id: run, record_count: 2, confidence: 0.9 });
  const p = insert(db, 'match_pairs', { id: nid('pair'), run_id: run, record_a_id: a, record_b_id: b, match_type: 'fuzzy', similarity_score: 0.9, confidence: 0.9 });
  const k = insert(db, 'conflicts', { id: nid('k'), run_id: run, conflict_type: 't', severity: 'low', shared_value: 'v', field_name: 'f', explanation: 'e', record_ids_json: '[]' });
  update(db, 'quality_issues', q, { severity: 'medium' });                              // in progress: fine
  update(db, 'analysis_runs', run, { status: 'complete' });
  const frozen = /completed run are immutable/;
  rejects(() => update(db, 'records', a, { primary_name: 'tampered' }), frozen);
  rejects(() => update(db, 'quality_issues', q, { severity: 'critical' }), frozen);
  rejects(() => update(db, 'entity_clusters', c, { confidence: 0.1 }), frozen);
  rejects(() => update(db, 'match_pairs', p, { confidence: 0.1 }), frozen);
  rejects(() => update(db, 'conflicts', k, { severity: 'critical' }), frozen);
});

test('re-run lineage: parent must be a different run of the SAME dataset', () => {
  const db = fresh(); const parent = v1run(db), otherDs = v1run(db, { dataset_id: 'ds2' });
  const child = v1run(db, { parent_run_id: parent, rerun_reason: 'stale threshold changed 4y -> 3y' });
  assert.equal(db.prepare('SELECT parent_run_id p FROM analysis_runs WHERE id=?').get(child).p, parent);
  rejects(() => v1run(db, { parent_run_id: otherDs }), /same dataset/);
  const solo = v1run(db);
  rejects(() => update(db, 'analysis_runs', solo, { parent_run_id: solo }), /different run of the same dataset/);
});

test('deleting a dataset with a COMPLETED v1 run and all v1 data cascades cleanly (FK actions cannot trip the immutability guards)', () => {
  const db = fresh();
  insert(db, 'source_rows', { id: 'sr', source_file_id: 'f1', row_number: 1, raw_json: '{}', raw_hash: 'h', ingest_version: 'i' });
  insert(db, 'file_columns', { id: 'col', source_file_id: 'f1', column_index: 0, header_raw: 'A', header_key: 'A' });
  insert(db, 'schema_mappings', { id: 'sm', source_file_id: 'f1', file_column_id: 'col', role: 'entity_name' });
  insert(db, 'analysis_configs', { id: 'cfg', dataset_id: 'ds1', version: 1, table_type: 'master_entity', config_json: '{}', config_hash: 'h' });
  const parent = v1run(db, { config_id: 'cfg' });
  const run = v1run(db, { config_id: 'cfg', parent_run_id: parent });
  const a = rec(db, run, { source_file_id: 'f1', source_row_ref: 1, source_row_id: 'sr' }), b = rec(db, run, { source_file_id: 'f1', source_row_ref: 2 });
  insert(db, 'run_inputs', { run_id: run, source_file_id: 'f1', mapping_version: 1, row_count: 2 });
  insert(db, 'quality_issues', { id: nid('iss'), run_id: run, category: 'completeness', issue_type: 'required_column_empty', severity: 'high', explanation: 'e', detection_method: 'rule', scope: 'dataset', file_column_id: 'col', requiredness: 'required' });
  const cl = insert(db, 'entity_clusters', { id: nid('cl'), run_id: run, record_count: 2, confidence: 1, match_class: 'entity_match' });
  const p = insert(db, 'match_pairs', { id: nid('pair'), run_id: run, record_a_id: a, record_b_id: b, match_type: 'multi_field', similarity_score: 1, confidence: 1, pair_class: 'entity_match', cluster_id: cl, decision: 'same_entity' });
  insert(db, 'match_evidence', { id: nid('ev'), run_id: run, match_pair_id: p, field_role: 'legal_id', relation: 'equal', evidence_class: 'hard_agree' });
  const g = insert(db, 'conflict_groups', { id: nid('cg'), run_id: run, conflict_type: 't', severity: 'low', member_set_hash: 'h', member_count: 2, explanation: 'e' });
  insert(db, 'conflict_group_members', { id: nid('m'), run_id: run, conflict_group_id: g, record_id: a });
  insert(db, 'score_contributions', { id: nid('sc'), run_id: run, dimension: 'validity', rule_id: 'r', scope: 'cell', opportunities: 2, defects: 1, defect_rate: 0.5, severity_weight: 1, penalty_points: 1 });
  insert(db, 'run_scores', { run_id: run, dimension: 'overall', score: 90, formula_version: 'x' });
  update(db, 'analysis_runs', parent, { status: 'complete' });
  update(db, 'analysis_runs', run, { status: 'complete' });
  db.prepare('DELETE FROM datasets WHERE id = ?').run('ds1');
  for (const t of ['analysis_runs', 'analysis_configs', 'source_files', 'source_rows', 'file_columns', 'schema_mappings', 'run_inputs', 'records', 'quality_issues', 'entity_clusters', 'match_pairs', 'match_evidence', 'conflict_groups', 'conflict_group_members', 'score_contributions', 'run_scores']) {
    const n = db.prepare(`SELECT COUNT(*) c FROM ${t} ${t === 'source_files' || t === 'analysis_runs' || t === 'analysis_configs' ? `WHERE ${t === 'source_files' ? "dataset_id='ds1'" : "dataset_id='ds1'"}` : ''}`).get().c;
    assert.equal(n, 0, `${t} still has rows after the dataset was deleted`);
  }
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('datasets carry table type as configuration and a visible interpretation state (default: not_interpreted)', () => {
  const db = fresh();
  const d = db.prepare(`SELECT table_type, table_type_source, interpretation_status FROM datasets WHERE id='ds1'`).get();
  assert.deepEqual({ ...d }, { table_type: null, table_type_source: null, interpretation_status: 'not_interpreted' });
  for (const t of ['master_entity', 'master_material', 'transaction', 'mixed_unknown']) update(db, 'datasets', 'ds1', { table_type: t, table_type_source: 'user' });
  rejects(() => update(db, 'datasets', 'ds1', { table_type: 'spreadsheet' }), /CHECK/i);
  rejects(() => update(db, 'datasets', 'ds1', { interpretation_status: 'looks_fine' }), /CHECK/i);
  update(db, 'datasets', 'ds1', { interpretation_status: 'review_required', interpretation_json: '{"primary_key":"Entry Sheet","confidence":0.62}' });
});
