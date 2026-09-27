'use strict';
/*
 * S6 gate decision 2 (product owner, 2026-09-25): an UNCERTAIN dataset type (mixed_unknown, needs_review, or below the
 * configured decision threshold -- all three collapse to dataset_type_needs_review, computed once by S3's own classifier)
 * must NEVER be silently auto-confirmed, for ANY caller, through ANY entry point -- not the schema API's own confirm
 * endpoint, not the production analyze route's convenience auto-accept, and not a re-run plan. Only an explicit
 * setDatasetType() decision (source becomes 'user') clears it. Column-level suggestions may still auto-accept (decision 3).
 */
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dq-s6-uncertain-'));
process.env.DATA_DIR = path.join(tmpRoot, 'data'); process.env.DB_PATH = path.join(tmpRoot, 'data', 'test.db'); process.env.UPLOAD_DIR = path.join(tmpRoot, 'uploads'); process.env.EXPORT_DIR = path.join(tmpRoot, 'exports');
process.env.SEED_ADMIN_EMAIL = 'uncertain-admin@example.com'; process.env.SEED_ADMIN_PASSWORD = 'TestPassword123!'; process.env.JWT_SECRET = 'test-secret';
const { test } = require('node:test'); const assert = require('node:assert/strict'); const request = require('supertest');
const app = require('../src/server'); const db = require('../src/db'); const svc = require('../src/semantic/schemaService');
const { ingestFile } = require('../src/ingest'); const { writeWorkbook } = require('./helpers/workbook');

const org = db.prepare('SELECT organization_id o, id u FROM users WHERE email = ?').get(process.env.SEED_ADMIN_EMAIL);
const uuid = () => crypto.randomUUID(); const A = r => r.set('Authorization', 'Bearer ' + require('../src/middleware/auth').signToken({ id: org.u, organization_id: org.o, role: 'admin', name: 'x', email: 'x' }));

// A genuinely split-evidence fixture (thin: a doc reference, an entity reference, an item reference, none of them thick
// enough to dominate) -- the SAME shape RT-17 exposed: the real classifier honestly scores this ~45/30/26% and reports
// dataset_type mixed_unknown with needs_review = true. This is not manufactured to force a result; it reproduces the
// exact real ambiguity the gate decision is about.
function mkSplitEvidenceFile(dsId) {
  const T = ['Invoice_No', 'Vendor_Code', 'Vendor_Name', 'Item_Code', 'Item_Description', 'Quantity', 'Unit_Price', 'Posting_Date'];
  const rows = [T]; for (let i = 0; i < 24; i++) rows.push([`INV-${1000 + i}`, 'V1', 'Apex Traders', 'MAT-1', 'Bearing 6205', 10, 100, { v: 45383, z: 'yyyy-mm-dd' }]);
  const xl = path.join(tmpRoot, `split-${uuid()}.xlsx`); writeWorkbook(xl, rows);
  return ingestFile(db, { datasetId: dsId, filePath: xl }).sourceFileId;
}
function mkConfidentFile(dsId) {
  const T = ['Company_Name', 'GSTIN', 'Vendor_Code', 'Email']; const rows = [T]; for (let i = 0; i < 5; i++) rows.push([`Firm ${i}`, `27ABCDE${1000 + i}F1Z5`, 'V' + i, `f${i}@x.example.com`]);
  const xl = path.join(tmpRoot, `confident-${uuid()}.xlsx`); writeWorkbook(xl, rows);
  return ingestFile(db, { datasetId: dsId, filePath: xl }).sourceFileId;
}
function mkDataset(name) { const id = uuid(); db.prepare('INSERT INTO datasets (id, organization_id, name, created_by) VALUES (?,?,?,?)').run(id, org.o, name, org.u); return id; }

test('fixture sanity: the split-evidence file genuinely classifies as uncertain (not manufactured to force a result)', () => {
  const ds = mkDataset('sanity'); const sf = mkSplitEvidenceFile(ds);
  const s = svc.suggestMapping(db, sf, { userId: org.u }); const m = svc.getReviewModel(db, sf, s.version);
  assert.equal(m.dataset_type.needs_review, true); assert.ok(m.dataset_type.value === 'mixed_unknown' || m.dataset_type.confidence < 0.7);
  assert.ok(m.dataset_type.alternatives.some(a => a.dataset_type === 'transaction' && a.share > 0.3), 'transaction is a real, substantial alternative -- this is genuine ambiguity, not a fixture with no signal at all');
});

test('SERVICE LAYER (confirmMapping): refuses to confirm an uncertain dataset type even with acceptSuggestions=true; an explicit setDatasetType clears it', () => {
  const ds = mkDataset('svc'); const sf = mkSplitEvidenceFile(ds); const s = svc.suggestMapping(db, sf, { userId: org.u });
  assert.throws(() => svc.confirmMapping(db, sf, s.version, { userId: org.u, acceptSuggestions: true }), e => e.status === 409 && e.dataset_type_unresolved === true && e.dataset_type && e.dataset_type.value && typeof e.dataset_type.confidence === 'number' && Array.isArray(e.dataset_type.reasons) && Array.isArray(e.dataset_type.alternatives) && /required_action|dataset-type/.test(e.required_action || e.message));
  const before = db.prepare('SELECT locked_at FROM schema_mapping_sets WHERE source_file_id = ? AND mapping_version = ?').get(sf, s.version).locked_at; assert.equal(before, null, 'the mapping must NOT have been silently locked by the refused attempt');
  svc.setDatasetType(db, sf, s.version, 'transaction', 'reviewer decision', org.u);
  const ok = svc.confirmMapping(db, sf, s.version, { userId: org.u, acceptSuggestions: true }); assert.equal(ok.mapping.locked, true); assert.equal(ok.dataset_type.source, 'user'); assert.equal(ok.dataset_type.value, 'transaction');
});

test('SERVICE LAYER: a CONFIDENT dataset type still auto-confirms with acceptSuggestions=true (decision 3 is unaffected)', () => {
  const ds = mkDataset('confident'); const sf = mkConfidentFile(ds); const s = svc.suggestMapping(db, sf, { userId: org.u });
  const m = svc.getReviewModel(db, sf, s.version); assert.equal(m.dataset_type.needs_review, false);
  const ok = svc.confirmMapping(db, sf, s.version, { userId: org.u, acceptSuggestions: true }); assert.equal(ok.mapping.locked, true);
});

test('SCHEMA API (own /confirm endpoint): the same refusal, independent of the production analyze route -- closing the loophole at every entry point', async () => {
  const ds = mkDataset('api-confirm'); const sf = mkSplitEvidenceFile(ds); const s = svc.suggestMapping(db, sf, { userId: org.u });
  const r = await A(request(app).post(`/api/schema/sources/${sf}/versions/${s.version}/confirm`)).send({ accept_suggestions: true });
  assert.equal(r.status, 409); assert.equal(r.body.dataset_type_unresolved, true); assert.equal(typeof r.body.dataset_type.confidence, 'number'); assert.ok(Array.isArray(r.body.dataset_type.alternatives) && r.body.dataset_type.alternatives.length > 0); assert.match(r.body.required_action, /dataset-type/);
  const setType = await A(request(app).patch(`/api/schema/sources/${sf}/versions/${s.version}/dataset-type`)).send({ dataset_type: 'transaction' });
  assert.equal(setType.status, 200); assert.equal(setType.body.dataset_type.source, 'user');
  const r2 = await A(request(app).post(`/api/schema/sources/${sf}/versions/${s.version}/confirm`)).send({ accept_suggestions: true });
  assert.equal(r2.status, 200); assert.equal(r2.body.mapping.locked, true);
});

test('PRODUCTION ANALYZE ROUTE: refuses with 409 including dataset classification, confidence, reasons, alternatives and required action -- with NO require_manual_review flag needed (no convenience bypass exists)', async () => {
  const ds = mkDataset('analyze-default'); mkSplitEvidenceFile(ds);
  const r = await A(request(app).post(`/api/datasets/${ds}/analyze`));   // deliberately NOT passing require_manual_review: true
  assert.equal(r.status, 409); assert.equal(r.body.review_required, true); assert.equal(r.body.files.length, 1);
  const f = r.body.files[0]; assert.equal(f.reason, 'dataset_type_uncertain');
  assert.ok(f.dataset_type && typeof f.dataset_type.confidence === 'number' && Array.isArray(f.dataset_type.reasons) && f.dataset_type.reasons.length > 0 && Array.isArray(f.dataset_type.alternatives) && f.dataset_type.alternatives.length > 0);
  assert.match(f.required_action, /dataset-type/);
  const running = db.prepare(`SELECT COUNT(*) c FROM analysis_runs WHERE dataset_id = ?`).get(ds).c; assert.equal(running, 0, 'no run was created for the blocked dataset');
});

test('PRODUCTION ANALYZE ROUTE: still refuses even when the caller explicitly sets require_manual_review to FALSE, and even when passing it as true (no flag value unlocks the bypass)', async () => {
  for (const flag of [false, true, undefined]) {
    const ds = mkDataset('analyze-flag-' + flag); mkSplitEvidenceFile(ds);
    const r = await A(request(app).post(`/api/datasets/${ds}/analyze`)).send(flag === undefined ? {} : { require_manual_review: flag });
    assert.equal(r.status, 409, `flag=${flag}`); assert.equal(r.body.files[0].reason, 'dataset_type_uncertain');
  }
});

test('PRODUCTION ANALYZE ROUTE: succeeds once the dataset type is explicitly confirmed/overridden via the schema API', async () => {
  const ds = mkDataset('analyze-after-confirm'); const sf = mkSplitEvidenceFile(ds); const s = svc.suggestMapping(db, sf, { userId: org.u });
  await A(request(app).patch(`/api/schema/sources/${sf}/versions/${s.version}/dataset-type`)).send({ dataset_type: 'transaction' });
  await A(request(app).post(`/api/schema/sources/${sf}/versions/${s.version}/confirm`)).send({ accept_suggestions: true });
  const r = await A(request(app).post(`/api/datasets/${ds}/analyze`)); assert.equal(r.status, 202, JSON.stringify(r.body)); assert.equal(r.body.table_type, 'transaction');
});

test('A MIXED dataset (one file uncertain, one confident) blocks the WHOLE analyze call -- a caller cannot slip an uncertain file through by pairing it with a confident one', async () => {
  const ds = mkDataset('mixed'); mkSplitEvidenceFile(ds); mkConfidentFile(ds);
  const r = await A(request(app).post(`/api/datasets/${ds}/analyze`)); assert.equal(r.status, 409); assert.equal(r.body.files.length, 1); assert.equal(r.body.files[0].reason, 'dataset_type_uncertain');
});

test('RE-RUN PLANNING: applying an unrelated change to a run whose dataset type was already uncertain still cannot silently re-confirm it; providing an explicit dataset_type change in the plan does', async () => {
  const cs = require('../src/semantic/configSnapshot');
  const ds = mkDataset('rerun'); const sf = mkSplitEvidenceFile(ds); const s = svc.suggestMapping(db, sf, { userId: org.u });
  svc.setDatasetType(db, sf, s.version, 'transaction', 'initial decision', org.u); svc.confirmMapping(db, sf, s.version, { userId: org.u, acceptSuggestions: true });
  const cfg = cs.createAnalysisConfig(db, { datasetId: ds, sources: [{ source_file_id: sf, mapping_version: s.version }], userId: org.u });
  const runId = uuid(); db.prepare(`INSERT INTO analysis_runs (id, dataset_id, status, engine_version, config_id, config_hash, table_type, reference_date, stale_threshold_years) VALUES (?,?,?,?,?,?,?,?,?)`).run(runId, ds, 'complete', 'pipeline-1.0.0', cfg.config_id, cfg.config_hash, 'transaction', '2026-09-25', 3);
  const plan = cs.planReRun(db, { parentRunId: runId, changes: [{ source_file_id: sf, header_key: 'Quantity', requiredness: 'required' }], userId: org.u, reason: 'unrelated tweak' });
  assert.equal(plan.new_config_id !== cfg.config_id, true); const snap = cs.getAnalysisConfig(db, plan.new_config_id).config.snapshot; assert.equal(snap.dataset_type, 'transaction', 'the prior explicit decision carries forward; it is not re-opened by an unrelated change');
});
