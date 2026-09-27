'use strict';
/* S3 persistence + review gate + immutable configuration + HTTP API, on a real ingested workbook and the real (isolated) database. */
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dq-s3-'));
process.env.DATA_DIR = path.join(tmpRoot, 'data'); process.env.DB_PATH = path.join(tmpRoot, 'data', 'test.db'); process.env.UPLOAD_DIR = path.join(tmpRoot, 'uploads'); process.env.EXPORT_DIR = path.join(tmpRoot, 'exports');
process.env.SEED_ADMIN_EMAIL = 's3-admin@example.com'; process.env.SEED_ADMIN_PASSWORD = 'TestPassword123!'; process.env.JWT_SECRET = 'test-secret';
const { test } = require('node:test'); const assert = require('node:assert/strict'); const request = require('supertest');
const app = require('../src/server'); const db = require('../src/db'); const { signToken } = require('../src/middleware/auth');
const { ingestFile } = require('../src/ingest'); const svc = require('../src/semantic/schemaService'); const cs = require('../src/semantic/configSnapshot'); const S = require('../src/semantic');
const { writeWorkbook } = require('./helpers/workbook');

const org = db.prepare('SELECT organization_id o, id u FROM users WHERE email = ?').get(process.env.SEED_ADMIN_EMAIL);
const uuid = () => crypto.randomUUID(); const dsId = uuid();
db.prepare('INSERT INTO datasets (id, organization_id, name, created_by) VALUES (?,?,?,?)').run(dsId, org.o, 'S3 dataset', org.u);
const pad = (n, w) => String(n).padStart(w, '0'); const N = 60;
const header = ['Record ID', 'Supplier Name', 'GST No', 'Supplier No.', 'E-mail', 'Mobile', 'Street Address', 'Town', 'Region', 'PIN Code', 'Created On', 'Changed On', 'Created By', 'Number', 'Material', 'Material'];
const rowsX = [header]; for (let i = 0; i < N; i++) rowsX.push(['R-' + pad(i + 1, 5), ['Orion Traders Pvt Ltd', 'Delta Works Ltd', 'Kalinga Steel Industries', 'Apex Supplies LLP'][i % 4] + ' ' + pad(i % 9, 2), `27ABCDE${pad(1000 + i, 4)}F1Z5`, 'V' + pad(100 + (i % 40), 4), `user${i}@vendor.example.com`, String(9800000000 + i * 13),
  `Plot ${10 + i}, Sector ${1 + i % 9}, Industrial Area`, ['Pune', 'Mumbai', 'Chennai'][i % 3], ['Maharashtra', 'Tamil Nadu'][i % 2], String(400001 + i), { v: 45292 + (i % 300), z: 'yyyy-mm-dd' }, { v: 45300 + (i % 300), z: 'yyyy-mm-dd' }, 'USR' + pad(i % 4, 5), String(1000000000 + i * 7), 'M-' + pad(1000 + i, 5), null]);
const xl = path.join(tmpRoot, 'vendors.xlsx'); writeWorkbook(xl, rowsX);
const ing = ingestFile(db, { datasetId: dsId, filePath: xl }); const SF = ing.sourceFileId;
const snap = (t, w) => crypto.createHash('sha256').update(JSON.stringify(db.prepare(`SELECT * FROM ${t} WHERE ${w[0]}`).all(...w.slice(1)))).digest('hex');
const col = (m, key) => m.columns.find(c => c.header_key === key);

test('the semantic stage refuses a file that is not canonically ingested', () => {
  const raw = uuid(); db.prepare("INSERT INTO source_files (id, dataset_id, original_filename, stored_path, file_size_bytes, file_type) VALUES (?,?,?,?,?,?)").run(raw, dsId, 'legacy.xlsx', '/x', 1, 'xlsx');
  assert.throws(() => svc.suggestMapping(db, raw), e => e.status === 409 && /not been canonically ingested/.test(e.message));
  assert.throws(() => svc.suggestMapping(db, uuid()), e => e.status === 404);
});
test('SUGGEST stores a versioned DRAFT mapping: every physical column is mapped exactly once, duplicate headers stay separately addressable, nothing physical is destroyed', () => {
  const s = svc.suggestMapping(db, SF, { userId: org.u }); assert.deepEqual(s, { version: 1, reused: false });
  const m = svc.getReviewModel(db, SF, 1); const phys = db.prepare('SELECT COUNT(*) c FROM file_columns WHERE source_file_id = ?').get(SF).c;
  assert.equal(m.columns.length, phys); assert.equal(phys, header.length); assert.equal(new Set(m.columns.map(c => c.file_column_id)).size, phys); assert.equal(new Set(m.columns.map(c => c.header_key)).size, phys);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM schema_mappings WHERE source_file_id = ? AND mapping_version = 1').get(SF).c, phys);
  const mats = m.columns.filter(c => c.header_raw === 'Material'); assert.equal(mats.length, 2); assert.notEqual(mats[0].header_key, mats[1].header_key); assert.ok(mats[0].is_duplicate_header && mats[1].is_duplicate_header);
  assert.equal(mats[0].role, 'material_id'); assert.equal(mats[1].role, 'unknown'); assert.equal(mats[1].is_empty, true); assert.equal(mats[1].requiredness.value, 'optional');
  assert.equal(m.mapping.status, 'draft'); assert.equal(m.mapping.locked, false); assert.equal(m.dataset_type.value, 'master_entity'); assert.equal(m.dataset_type.source, 'classifier');
  // the review model carries everything the charter lists for the Schema Review screen
  for (const c of m.columns) for (const k of ['header_raw', 'header_normalized', 'role', 'role_family', 'confidence', 'confidence_tier', 'status', 'review_reasons', 'alternatives', 'requiredness', 'validation_profile', 'include_in_analysis', 'user_overridden', 'suggested_role']) assert.ok(k in c, `${c.header_key} lacks ${k}`);
  assert.ok(m.dataset_type.reasons.length && Array.isArray(m.dataset_type.alternatives) && m.options.dataset_types.length === 4 && m.options.requiredness.length === 3);
  assert.equal(col(m, 'Created By').role, 'audit_user'); assert.equal(col(m, 'GST No').role, 'legal_id'); assert.equal(col(m, 'Mobile').role, 'phone'); assert.equal(col(m, 'Number').role, 'unknown'); assert.equal(col(m, 'Number').review_required, true);
  assert.equal(col(m, 'Supplier Name').requiredness.value, 'required'); assert.equal(col(m, 'Supplier Name').requiredness.source, 'rule'); assert.equal(col(m, 'Supplier Name').requiredness.if_missing.scope, 'none');
});
test('the stored profile equals a fresh in-memory profile (persistence does not change what the classifier sees)', () => {
  const { columns, profiles } = svc.profileSource(db, SF); const { openSource } = require('../src/ingest/reader'); const { readCanonical } = require('../src/ingest/canonicalize'); const c = readCanonical(openSource(xl), {});
  assert.deepEqual(profiles, S.profileColumns(c.columns, c.rows)); assert.equal(columns.length, c.columns.length);
  const mem = S.analyzeSemantics(c.columns, c.rows).mappings; const dbm = svc.getReviewModel(db, SF, 1).columns; assert.deepEqual(dbm.map(x => x.role), mem.map(x => x.role));
});
test('SUGGEST is idempotent for unchanged inputs; force creates a new version', () => {
  assert.deepEqual(svc.suggestMapping(db, SF, { userId: org.u }), { version: 1, reused: true });
});
test('OVERRIDE (draft): role / requiredness / include / note are validated, recorded with provenance, and derived state is recomputed', () => {
  const m0 = svc.getReviewModel(db, SF, 1); const num = col(m0, 'Number');
  assert.throws(() => svc.overrideColumn(db, SF, 1, num.file_column_id, { role: 'bogus_role' }, org.u), e => e.status === 400 && /Unknown role/.test(e.message));
  assert.throws(() => svc.overrideColumn(db, SF, 1, num.file_column_id, { requiredness: 'mandatory' }, org.u), e => e.status === 400);
  assert.throws(() => svc.overrideColumn(db, SF, 1, num.file_column_id, {}, org.u), e => e.status === 400);
  assert.throws(() => svc.overrideColumn(db, SF, 1, uuid(), { role: 'doc_ref' }, org.u), e => e.status === 404);
  const m1 = svc.overrideColumn(db, SF, 1, num.file_column_id, { role: 'doc_ref', note: 'PO reference per the buyer' }, org.u); const c = col(m1, 'Number');
  assert.equal(c.role, 'doc_ref'); assert.equal(c.status, 'overridden'); assert.equal(c.user_overridden, true); assert.equal(c.suggested_role, 'unknown', 'the classifier proposal is preserved'); assert.equal(c.confidence, 1); assert.equal(c.review_required, false); assert.equal(c.override_note, 'PO reference per the buyer');
  assert.equal(c.validation_profile.status, 'not_applicable', 'profiles are dataset-aware: a master-entity profile defines no validator for doc_ref'); assert.match(c.validation_profile.reason, /master_entity/);
  const idc = svc.overrideColumn(db, SF, 1, num.file_column_id, { role: 'entity_id' }, org.u); assert.equal(col(idc, 'Number').validation_profile.status, 'active'); assert.equal(col(idc, 'Number').validation_profile.validators[0].rule_id, 'validity.identifier_format', 'derived validation state follows the role');
  svc.overrideColumn(db, SF, 1, num.file_column_id, { role: 'doc_ref' }, org.u);
  const m2 = svc.overrideColumn(db, SF, 1, col(m1, 'Town').file_column_id, { requiredness: 'required', note: 'city mandatory for GST returns' }, org.u); const t = col(m2, 'Town'); assert.equal(t.requiredness.value, 'required'); assert.equal(t.requiredness.source, 'user');
  assert.equal(t.requiredness.if_missing.scope, 'none', 'fully populated: nothing missing'); assert.equal(t.role, 'city', 'a requiredness override does not disturb the role');
  const m3 = svc.overrideColumn(db, SF, 1, col(m2, 'Record ID').file_column_id, { include_in_analysis: false }, org.u); assert.equal(col(m3, 'Record ID').include_in_analysis, false); assert.equal(m3.summary.included, m2.summary.included - 1, 'excluding one column reduces the included count by exactly one'); assert.equal(m3.summary.columns, m2.summary.columns, 'excluding never removes a physical column');
  const m4 = svc.setDatasetType(db, SF, 1, 'transaction', 'this is a transaction extract', org.u); assert.equal(m4.dataset_type.value, 'transaction'); assert.equal(m4.dataset_type.source, 'user'); assert.equal(m4.dataset_type.suggested, 'master_entity');
  assert.equal(col(m4, 'Supplier Name').requiredness.source === 'user' || col(m4, 'Supplier Name').requiredness.value !== 'required', true, 'requiredness policy follows the dataset type');
  assert.throws(() => svc.setDatasetType(db, SF, 1, 'inventory', null, org.u), e => e.status === 400);
  svc.setDatasetType(db, SF, 1, 'master_entity', 'reverted', org.u);
});
test('CONFIRM is gated: flagged columns must be decided (or the suggestions explicitly accepted); then the version is LOCKED', () => {
  let m = svc.getReviewModel(db, SF, 1); const open = m.columns.filter(c => c.review_required && c.status === 'suggested');
  if (open.length) { assert.throws(() => svc.confirmMapping(db, SF, 1, { userId: org.u }), e => e.status === 409 && Array.isArray(e.unresolved) && e.unresolved.length === open.length); for (const c of open) svc.overrideColumn(db, SF, 1, c.file_column_id, { confirm: true }, org.u); }
  m = svc.getReviewModel(db, SF, 1); assert.equal(m.summary.unresolved_review, 0);
  const done = svc.confirmMapping(db, SF, 1, { userId: org.u, acceptSuggestions: true }); assert.equal(done.mapping.locked, true); assert.equal(done.mapping.status, 'confirmed'); assert.ok(done.mapping.confirmed_at);
  assert.ok(done.columns.every(c => ['confirmed', 'overridden', 'auto_accepted'].includes(c.status)), 'no column is left merely "suggested"');
  assert.ok(done.columns.filter(c => c.validation_profile.validators.length).every(c => c.validation_profile.status === 'active'));
});
test('LOCKED means locked: neither the service nor raw SQL can change a confirmed mapping version', () => {
  const m = svc.getReviewModel(db, SF, 1); const c = col(m, 'Mobile'); const before = snap('schema_mappings', ['source_file_id = ? AND mapping_version = 1', SF]);
  assert.throws(() => svc.overrideColumn(db, SF, 1, c.file_column_id, { role: 'name' }, org.u), e => e.status === 409 && /locked/.test(e.message));
  assert.throws(() => svc.setDatasetType(db, SF, 1, 'transaction', null, org.u), e => e.status === 409);
  assert.throws(() => svc.confirmMapping(db, SF, 1, { acceptSuggestions: true }), e => e.status === 409);
  for (const sql of ["UPDATE schema_mappings SET role='phone' WHERE source_file_id=? AND mapping_version=1", "UPDATE schema_mapping_sets SET dataset_type='transaction' WHERE source_file_id=? AND mapping_version=1", "UPDATE schema_mapping_sets SET locked_at=NULL WHERE source_file_id=? AND mapping_version=1"])
    assert.throws(() => db.prepare(sql).run(SF), /locked mapping set is immutable/, sql);
  assert.throws(() => db.prepare("INSERT INTO schema_mappings (id, source_file_id, file_column_id, mapping_version, role) VALUES (?,?,?,1,'name')").run(uuid(), SF, c.file_column_id), /locked mapping set is immutable/);
  assert.equal(snap('schema_mappings', ['source_file_id = ? AND mapping_version = 1', SF]), before, 'byte-identical after every attempt');
});
test('REVISE creates a new draft version (parent recorded); the locked parent is untouched', () => {
  const before = snap('schema_mappings', ['source_file_id = ? AND mapping_version = 1', SF]); const r = svc.reviseMapping(db, SF, 1, org.u, 'buyers want mobile as required');
  assert.deepEqual([r.version, r.parent_version], [2, 1]); const m2 = svc.getReviewModel(db, SF, 2); assert.equal(m2.mapping.locked, false); assert.equal(m2.mapping.parent_version, 1); assert.equal(m2.mapping.latest_version, 2);
  svc.overrideColumn(db, SF, 2, col(m2, 'Mobile').file_column_id, { requiredness: 'required' }, org.u);
  assert.equal(col(svc.getReviewModel(db, SF, 2), 'Mobile').requiredness.value, 'required'); assert.equal(col(svc.getReviewModel(db, SF, 1), 'Mobile').requiredness.value, 'expected');
  assert.equal(snap('schema_mappings', ['source_file_id = ? AND mapping_version = 1', SF]), before);
});

let cfg1, cfg2; const parentRun = uuid();
test('RUN CONFIGURATION: only confirmed mappings snapshot; the snapshot carries roles, requiredness, validation profiles, policy and versions; identical input reuses the same config', () => {
  assert.throws(() => cs.createAnalysisConfig(db, { datasetId: dsId, sources: [{ source_file_id: SF, mapping_version: 2 }], userId: org.u }), e => e.status === 409 && /not confirmed/.test(e.message));
  assert.throws(() => cs.createAnalysisConfig(db, { datasetId: dsId, sources: [], userId: org.u }), e => e.status === 400);
  assert.throws(() => cs.createAnalysisConfig(db, { datasetId: dsId, sources: [{ source_file_id: SF, mapping_version: 1 }], settings: { stale_threshold_years: 0 } }), e => e.status === 400);
  assert.throws(() => cs.createAnalysisConfig(db, { datasetId: dsId, sources: [{ source_file_id: SF, mapping_version: 1 }], settings: { reference_date_mode: 'fixed' } }), e => e.status === 400);
  cfg1 = cs.createAnalysisConfig(db, { datasetId: dsId, sources: [{ source_file_id: SF, mapping_version: 1 }], userId: org.u, note: 'first' }); assert.equal(cfg1.version, 1); assert.equal(cfg1.reused, false); assert.equal(cfg1.table_type, 'master_entity');
  const c = cs.getAnalysisConfig(db, cfg1.config_id); const s = c.config.snapshot; assert.equal(c.config_hash, S.hashConfig(s)); assert.equal(c.stale_threshold_years, 4); assert.equal(c.reference_date_mode, 'run_date');
  assert.equal(s.sources[0].mapping_version, 1); assert.equal(s.sources[0].columns.length, header.length); assert.equal(s.semantic.engine_version, S.SEMANTIC_ENGINE_VERSION); assert.equal(s.semantic.taxonomy_version, S.TAXONOMY_VERSION); assert.equal(s.semantic.config.version, S.DEFAULT_SEMANTIC_CONFIG.version);
  const mob = s.sources[0].columns.find(x => x.header_key === 'Mobile'); assert.deepEqual([mob.role, mob.requiredness, mob.requiredness_source], ['phone', 'expected', 'rule']); assert.equal(mob.validation_profile.validators[0].rule_id, 'validity.phone_format');
  const again = cs.createAnalysisConfig(db, { datasetId: dsId, sources: [{ source_file_id: SF, mapping_version: 1 }], userId: org.u }); assert.equal(again.reused, true); assert.equal(again.config_id, cfg1.config_id);
  assert.throws(() => db.prepare('UPDATE analysis_configs SET table_type = ? WHERE id = ?').run('transaction', cfg1.config_id), /./, 'analysis configs are append-only (S1 guard)');
});
test('CHANGING requiredness/mapping creates a NEW mapping version and a NEW configuration - the old configuration stays exactly as it was', () => {
  const before = snap('analysis_configs', ['id = ?', cfg1.config_id]); svc.confirmMapping(db, SF, 2, { userId: org.u, acceptSuggestions: true });
  cfg2 = cs.createAnalysisConfig(db, { datasetId: dsId, sources: [{ source_file_id: SF, mapping_version: 2 }], userId: org.u }); assert.equal(cfg2.version, 2); assert.notEqual(cfg2.config_hash, cfg1.config_hash); assert.notEqual(cfg2.config_id, cfg1.config_id);
  assert.equal(cs.getAnalysisConfig(db, cfg2.config_id).config.snapshot.sources[0].columns.find(x => x.header_key === 'Mobile').requiredness, 'required'); assert.equal(snap('analysis_configs', ['id = ?', cfg1.config_id]), before);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM analysis_configs WHERE dataset_id = ?').get(dsId).c, 2);
  const s3 = cs.createAnalysisConfig(db, { datasetId: dsId, sources: [{ source_file_id: SF, mapping_version: 1 }], settings: { stale_threshold_years: 2 }, userId: org.u }); assert.equal(s3.version, 3); assert.equal(cs.getAnalysisConfig(db, s3.config_id).stale_threshold_years, 2, 'settings are part of the snapshot');
});
test('RE-RUN PLANNING from a completed run: changes become new mapping/config versions with lineage; the parent run and its configuration are untouched; no run is created', () => {
  db.prepare("INSERT INTO analysis_runs (id, dataset_id, status, engine_version, config_id, config_hash, table_type, reference_date, stale_threshold_years) VALUES (?,?,?,?,?,?,?,?,?)").run(parentRun, dsId, 'complete', 'engine-under-test-1', cfg1.config_id, cfg1.config_hash, 'master_entity', '2026-09-24', 4);
  const runsBefore = db.prepare('SELECT COUNT(*) c FROM analysis_runs').get().c; const pr = snap('analysis_runs', ['id = ?', parentRun]), pc = snap('analysis_configs', ['id = ?', cfg1.config_id]), v1 = snap('schema_mappings', ['source_file_id = ? AND mapping_version = 1', SF]);
  const plan = cs.planReRun(db, { parentRunId: parentRun, changes: [{ source_file_id: SF, header_key: 'E-mail', requiredness: 'required', note: 'e-mail is mandatory now' }], reason: 'buyers tightened the e-mail rule', userId: org.u });
  assert.equal(plan.parent_run_id, parentRun); assert.equal(plan.parent_config_id, cfg1.config_id); assert.notEqual(plan.new_config_id, cfg1.config_id); assert.equal(plan.engine_version, 'engine-under-test-1'); assert.equal(plan.mapping_moves.length, 1); assert.equal(plan.mapping_moves[0].from_mapping_version, 1);
  const nc = cs.getAnalysisConfig(db, plan.new_config_id); assert.equal(nc.config.lineage.parent_run_id, parentRun); assert.equal(nc.config.lineage.parent_config_hash, cfg1.config_hash); assert.equal(nc.config.snapshot.sources[0].columns.find(x => x.header_key === 'E-mail').requiredness, 'required');
  assert.equal(snap('analysis_runs', ['id = ?', parentRun]), pr); assert.equal(snap('analysis_configs', ['id = ?', cfg1.config_id]), pc); assert.equal(snap('schema_mappings', ['source_file_id = ? AND mapping_version = 1', SF]), v1); assert.equal(db.prepare('SELECT COUNT(*) c FROM analysis_runs').get().c, runsBefore);
  assert.throws(() => db.prepare('UPDATE analysis_runs SET config_id = ? WHERE id = ?').run(plan.new_config_id, parentRun), /./, 'a completed run cannot be re-pointed at another configuration (S1 guard)');
  const legacy = uuid(); db.prepare("INSERT INTO analysis_runs (id, dataset_id, status) VALUES (?,?,?)").run(legacy, dsId, 'complete'); assert.throws(() => cs.planReRun(db, { parentRunId: legacy, changes: [] }), e => e.status === 409 && /predates/.test(e.message));
  assert.throws(() => cs.planReRun(db, { parentRunId: uuid(), changes: [] }), e => e.status === 404);
});

// ---------------------------------------------------------------- HTTP API
let token; let rid;
test('API: authentication and organization scoping', async () => {
  const login = await request(app).post('/api/auth/login').send({ email: process.env.SEED_ADMIN_EMAIL, password: process.env.SEED_ADMIN_PASSWORD }); token = login.body.token; assert.ok(token);
  assert.equal((await request(app).get(`/api/schema/sources/${SF}`)).status, 401);
  const otherOrg = uuid(), otherUser = uuid(); db.prepare('INSERT INTO organizations (id, name) VALUES (?,?)').run(otherOrg, 'Other'); db.prepare("INSERT INTO users (id, organization_id, name, email, password_hash, role) VALUES (?,?,?,?,?,?)").run(otherUser, otherOrg, 'X', 'x@other.example', 'x', 'admin');
  const t2 = signToken({ id: otherUser, organization_id: otherOrg, role: 'admin', name: 'X', email: 'x@other.example' });
  for (const [m, u] of [['get', `/api/schema/sources/${SF}`], ['post', `/api/schema/sources/${SF}/suggest`], ['post', `/api/schema/sources/${SF}/versions/1/confirm`], ['patch', `/api/schema/sources/${SF}/versions/2/dataset-type`], ['post', `/api/schema/datasets/${dsId}/configs`], ['post', `/api/schema/runs/${parentRun}/plan-rerun`]])
    assert.equal((await request(app)[m](u).set('Authorization', 'Bearer ' + t2).send({})).status, 404, `${m} ${u} must not leak across organizations`);
});
test('API: taxonomy, read model, suggest, override, gated confirm, revise', async () => {
  const A = r => r.set('Authorization', 'Bearer ' + token);
  const tx = await A(request(app).get('/api/schema/taxonomy')); assert.equal(tx.status, 200); assert.ok(tx.body.families.length === 6 && tx.body.dataset_types.length === 4 && tx.body.versions.taxonomy === S.TAXONOMY_VERSION);
  const g = await A(request(app).get(`/api/schema/sources/${SF}`)); assert.equal(g.status, 200); const latest = g.body.mapping.latest_version; assert.equal(g.body.mapping.version, latest, 'default read = latest version'); assert.equal((await A(request(app).get(`/api/schema/sources/${SF}?version=1`))).body.mapping.locked, true);
  assert.equal((await A(request(app).get(`/api/schema/sources/${SF}?version=9`))).status, 404); assert.ok('evidence' in (await A(request(app).get(`/api/schema/sources/${SF}?evidence=1`))).body.columns[0]);
  const s = await A(request(app).post(`/api/schema/sources/${SF}/suggest`)); assert.equal(s.status, 200); assert.equal(s.body.reused, true);
  const rv = await A(request(app).post(`/api/schema/sources/${SF}/versions/${latest}/revise`).send({ note: 'api revise' })); assert.equal(rv.status, 201); const v = rv.body.version; assert.equal(v, latest + 1); assert.equal(rv.body.review.mapping.parent_version, latest);
  const numCol = col(rv.body.review, 'Number');
  assert.equal((await A(request(app).patch(`/api/schema/sources/${SF}/versions/${v}/columns/${numCol.file_column_id}`).send({ role: 'nope' }))).status, 400);
  const ok = await A(request(app).patch(`/api/schema/sources/${SF}/versions/${v}/columns/${numCol.file_column_id}`).send({ role: 'doc_ref', requiredness: 'expected' })); assert.equal(ok.status, 200); assert.equal(col(ok.body, 'Number').role, 'doc_ref'); assert.equal(col(ok.body, 'Number').requiredness.value, 'expected');
  assert.equal((await A(request(app).patch(`/api/schema/sources/${SF}/versions/${v}/dataset-type`).send({ dataset_type: 'nonsense' }))).status, 400);
  assert.equal((await A(request(app).patch(`/api/schema/sources/${SF}/versions/${v}/dataset-type`).send({ dataset_type: 'master_entity', note: 'confirmed by buyer' }))).body.dataset_type.source, 'user');
  const c1 = await A(request(app).post(`/api/schema/sources/${SF}/versions/${v}/confirm`).send({ accept_suggestions: true })); assert.equal(c1.status, 200); assert.equal(c1.body.mapping.locked, true);
  assert.equal((await A(request(app).patch(`/api/schema/sources/${SF}/versions/${v}/columns/${numCol.file_column_id}`).send({ role: 'name' }))).status, 409);
});
test('API: gated confirm reports what is unresolved; configs are created once and reused; plan-rerun is scoped and refuses legacy runs', async () => {
  const A = r => r.set('Authorization', 'Bearer ' + token);
  const r = await A(request(app).post(`/api/schema/sources/${SF}/versions/1/revise`).send({})); const v = r.body.version; 
  const cf = await A(request(app).post(`/api/schema/datasets/${dsId}/configs`).send({ sources: [{ source_file_id: SF, mapping_version: 1 }] })); assert.equal(cf.status, 200); assert.equal(cf.body.reused, true); assert.equal(cf.body.config_id, cfg1.config_id);
  const bad = await A(request(app).post(`/api/schema/datasets/${dsId}/configs`).send({ sources: [{ source_file_id: SF, mapping_version: v }] })); assert.equal(bad.status, 409);
  const gcf = await A(request(app).get(`/api/schema/datasets/${dsId}/configs/${cfg1.config_id}`)); assert.equal(gcf.status, 200); assert.equal(gcf.body.config_hash, cfg1.config_hash);
  const pr = await A(request(app).post(`/api/schema/runs/${parentRun}/plan-rerun`).send({ changes: [{ source_file_id: SF, header_key: 'GST No', requiredness: 'required' }], reason: 'api' })); assert.equal(pr.status, 201); assert.equal(pr.body.parent_run_id, parentRun); assert.ok(pr.body.new_config_id);
});
