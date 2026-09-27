'use strict';
/* S8: file retention/purge. The original bytes are safe to delete once a file is ingested (canonical rows already hold
   everything downstream needs); source lineage metadata (the source_files row itself) is never deleted. */
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dq-s8-retention-'));
process.env.DATA_DIR = path.join(tmpRoot, 'data'); process.env.DB_PATH = path.join(tmpRoot, 'data', 'test.db'); process.env.UPLOAD_DIR = path.join(tmpRoot, 'uploads'); process.env.EXPORT_DIR = path.join(tmpRoot, 'exports');
process.env.SEED_ADMIN_EMAIL = 's8-admin@example.com'; process.env.SEED_ADMIN_PASSWORD = 'TestPassword123!'; process.env.JWT_SECRET = 'test-secret'; process.env.PURGE_SWEEP_DISABLED = '1';
const { test } = require('node:test'); const assert = require('node:assert/strict'); const request = require('supertest');
const app = require('../src/server'); const db = require('../src/db'); const { ingestFile } = require('../src/ingest'); const { purgeEligibleFiles, fileRetentionStatus } = require('../src/pipeline/retention');
const { writeWorkbook } = require('./helpers/workbook');

const org = db.prepare('SELECT organization_id o, id u FROM users WHERE email = ?').get(process.env.SEED_ADMIN_EMAIL);
const uuid = () => crypto.randomUUID(); const dsId = uuid();
db.prepare('INSERT INTO datasets (id, organization_id, name, created_by) VALUES (?,?,?,?)').run(dsId, org.o, 'retention', org.u);
const mkFile = () => { const xl = path.join(tmpRoot, 'v-' + uuid() + '.xlsx'); writeWorkbook(xl, [['A', 'B'], [uuid(), '2']]); return ingestFile(db, { datasetId: dsId, filePath: xl }).sourceFileId; };

test('a file past the retention window, cleanly ingested, is purged: the physical bytes are gone but the source_files row (lineage metadata) remains', () => {
  const sf = mkFile(); const before = db.prepare('SELECT * FROM source_files WHERE id = ?').get(sf); assert.ok(fs.existsSync(before.stored_path));
  db.prepare("UPDATE source_files SET uploaded_at = datetime('now', '-200 days') WHERE id = ?").run(sf);
  const result = purgeEligibleFiles(db, { retentionDays: 90 });
  assert.ok(result.purged >= 1); assert.equal(fs.existsSync(before.stored_path), false, 'the physical bytes are gone');
  const after = db.prepare('SELECT * FROM source_files WHERE id = ?').get(sf);
  assert.ok(after, 'the row itself still exists'); assert.equal(after.original_filename, before.original_filename); assert.equal(after.content_sha256, before.content_sha256); assert.ok(after.purged_at);
});
test('a file within the retention window is NOT purged', () => {
  const sf = mkFile(); const row = db.prepare('SELECT * FROM source_files WHERE id = ?').get(sf);
  purgeEligibleFiles(db, { retentionDays: 90 }); assert.equal(fs.existsSync(row.stored_path), true); assert.equal(db.prepare('SELECT purged_at FROM source_files WHERE id = ?').get(sf).purged_at, null);
});
test('a sheet still AWAITING SELECTION never has its shared physical file purged, even past the retention window', () => {
  const xl = path.join(tmpRoot, 'multi-' + uuid() + '.xlsx'); writeWorkbook(xl, [['A'], ['1']]);
  const id = uuid(); db.prepare(`INSERT INTO source_files (id, dataset_id, original_filename, stored_path, file_size_bytes, file_type, status, uploaded_at) VALUES (?,?,?,?,?,?,?, datetime('now','-200 days'))`).run(id, dsId, 'multi.xlsx', xl, 10, 'xlsx', 'awaiting_sheet_selection');
  purgeEligibleFiles(db, { retentionDays: 90 }); assert.equal(fs.existsSync(xl), true, 'still needed to ingest the remaining sheet(s)');
});
test('purging is idempotent and never errors on an already-purged or missing file', () => {
  const sf = mkFile(); db.prepare("UPDATE source_files SET uploaded_at = datetime('now', '-200 days') WHERE id = ?").run(sf);
  const r1 = purgeEligibleFiles(db, { retentionDays: 90 }); const r2 = purgeEligibleFiles(db, { retentionDays: 90 });
  assert.equal(r2.checked, 0, 'nothing left eligible on the second pass'); assert.equal(r2.errors, 0);
});
test('fileRetentionStatus reports active / retained / eligible_for_purge / purged correctly', () => {
  const sf = mkFile(); const row = () => db.prepare('SELECT * FROM source_files WHERE id = ?').get(sf);
  assert.equal(fileRetentionStatus(row(), { retentionDays: 90 }).status, 'retained');
  db.prepare("UPDATE source_files SET uploaded_at = datetime('now', '-200 days') WHERE id = ?").run(sf); assert.equal(fileRetentionStatus(row(), { retentionDays: 90 }).status, 'eligible_for_purge');
  purgeEligibleFiles(db, { retentionDays: 90 }); assert.equal(fileRetentionStatus(row(), { retentionDays: 90 }).status, 'purged');
});
test('API: an admin can trigger a scoped purge and read retention status; a non-admin is refused', async () => {
  const A = r => r.set('Authorization', 'Bearer ' + require('../src/middleware/auth').signToken({ id: org.u, organization_id: org.o, role: 'admin', name: 'x', email: 'x' }));
  const sf = mkFile(); db.prepare("UPDATE source_files SET uploaded_at = datetime('now', '-200 days') WHERE id = ?").run(sf);
  const r = await A(request(app).post('/api/admin/purge-files')); assert.equal(r.status, 200); assert.ok(r.body.purged >= 1);
  const status = await A(request(app).get('/api/admin/retention-status')); assert.equal(status.status, 200); assert.ok(status.body.files.some(f => f.status === 'purged'));
  const nonAdminToken = require('../src/middleware/auth').signToken({ id: org.u, organization_id: org.o, role: 'member', name: 'x', email: 'x' });
  const refused = await request(app).post('/api/admin/purge-files').set('Authorization', 'Bearer ' + nonAdminToken); assert.equal(refused.status, 403);
});
test('CANONICAL DATA SURVIVES PURGE: a run created from a purged file still works end-to-end (ingest happens before purge; nothing downstream re-reads the physical file)', async () => {
  const sf = mkFile(); const svc = require('../src/semantic/schemaService'); svc.suggestMapping(db, sf, { userId: org.u }); svc.setDatasetType(db, sf, 1, 'mixed_unknown', 'explicit test choice', org.u); svc.confirmMapping(db, sf, 1, { userId: org.u, acceptSuggestions: true });
  db.prepare("UPDATE source_files SET uploaded_at = datetime('now', '-200 days') WHERE id = ?").run(sf); purgeEligibleFiles(db, { retentionDays: 90 });
  const cs = require('../src/semantic/configSnapshot'); const { executeRun } = require('../src/pipeline/runPipeline');
  const cfg = cs.createAnalysisConfig(db, { datasetId: dsId, sources: [{ source_file_id: sf, mapping_version: 1 }], userId: org.u });
  const runId = uuid(); db.prepare(`INSERT INTO analysis_runs (id, dataset_id, status, engine_version, config_id, config_hash, table_type, reference_date, stale_threshold_years) VALUES (?,?,?,?,?,?,?,?,?)`).run(runId, dsId, 'queued', 'pipeline-1.0.0', cfg.config_id, cfg.config_hash, 'mixed_unknown', '2026-09-25', 4);
  await executeRun(db, { runId, todayISO: '2026-09-25' }); const run = db.prepare('SELECT * FROM analysis_runs WHERE id = ?').get(runId);
  assert.equal(run.status, 'complete', run.error_message); assert.ok(typeof run.health_score === 'number');
});
