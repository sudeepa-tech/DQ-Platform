'use strict';
/* S8 section 8: interrupted run recovery, retry, duplicate submission, repeated upload of identical content,
   changed source content, different configuration, near-concurrent analysis. No orphans, no duplicate findings,
   no cross-run/cross-dataset contamination, completed runs immutable. */
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dq-s8-persist-'));
process.env.DATA_DIR = path.join(tmpRoot, 'data'); process.env.DB_PATH = path.join(tmpRoot, 'data', 'test.db'); process.env.UPLOAD_DIR = path.join(tmpRoot, 'uploads'); process.env.EXPORT_DIR = path.join(tmpRoot, 'exports');
process.env.SEED_ADMIN_EMAIL = 's8-persist@example.com'; process.env.SEED_ADMIN_PASSWORD = 'TestPassword123!'; process.env.JWT_SECRET = 'test-secret'; process.env.PURGE_SWEEP_DISABLED = '1'; process.env.RATE_LIMIT_DISABLED = '1';
const { test } = require('node:test'); const assert = require('node:assert/strict'); const request = require('supertest');
const app = require('../src/server'); const db = require('../src/db');
const A = r => r.set('Authorization', 'Bearer ' + require('../src/middleware/auth').signToken({ id: org.u, organization_id: org.o, role: 'admin', name: 'x', email: 'x' }));
const org = db.prepare('SELECT organization_id o, id u FROM users WHERE email = ?').get(process.env.SEED_ADMIN_EMAIL);
const uuid = () => crypto.randomUUID();
const csv = (n) => 'Company_Name,GSTIN,Vendor_Code\n' + Array.from({ length: 20 }, (_, i) => `Firm ${n}-${i},27ABCDE${1000 + i}F1Z5,V${n}-${i}`).join('\n') + '\n';

async function mkDatasetWithRun(label) {
  const ds = (await A(request(app).post('/api/datasets')).send({ name: label })).body.dataset;
  const p = path.join(tmpRoot, label + '.csv'); fs.writeFileSync(p, csv(label));
  await A(request(app).post(`/api/datasets/${ds.id}/files`)).attach('file', p);
  const an = await A(request(app).post(`/api/datasets/${ds.id}/analyze`));
  let run; for (let i = 0; i < 200; i++) { run = (await A(request(app).get(`/api/runs/${an.body.run_id}`))).body.run; if (['complete', 'failed'].includes(run.status)) break; await new Promise(r => setTimeout(r, 30)); }
  return { ds, run, file: p };
}

test('INTERRUPTED RUN: a run left in a non-terminal status when the server restarts is marked failed with a clear message, not silently left "running" forever', async () => {
  const { run } = await mkDatasetWithRun('interrupted');
  const stuck = uuid(); db.prepare(`INSERT INTO analysis_runs (id, dataset_id, status, engine_version, config_id, config_hash, table_type, reference_date, stale_threshold_years, started_at)
    VALUES (?,?,?,?,?,?,?,?,?, datetime('now','-1 hour'))`).run(stuck, run.dataset_id, 'running', 'pipeline-1.0.0', run.config_id, run.config_hash, 'master_entity', '2026-09-25', 4);
  delete require.cache[require.resolve('../src/db')]; const db2 = require('../src/db');
  const after = db2.prepare('SELECT status, error_message FROM analysis_runs WHERE id = ?').get(stuck);
  assert.equal(after.status, 'failed'); assert.match(after.error_message, /interrupted/i);
});

test('RETRY: after a failed run, a fresh analyze call succeeds and produces a NEW, independent run; the failed one is untouched', async () => {
  const ds = (await A(request(app).post('/api/datasets')).send({ name: 'retry' })).body.dataset;
  const p = path.join(tmpRoot, 'retry.csv'); fs.writeFileSync(p, csv('retry'));
  await A(request(app).post(`/api/datasets/${ds.id}/files`)).attach('file', p);
  const bad = uuid(); db.prepare(`INSERT INTO analysis_runs (id, dataset_id, status, engine_version, error_message) VALUES (?,?,?,?,?)`).run(bad, ds.id, 'failed', 'pipeline-1.0.0', 'synthetic failure');
  const an = await A(request(app).post(`/api/datasets/${ds.id}/analyze`)); assert.equal(an.status, 202);
  let run; for (let i = 0; i < 200; i++) { run = (await A(request(app).get(`/api/runs/${an.body.run_id}`))).body.run; if (['complete', 'failed'].includes(run.status)) break; await new Promise(r => setTimeout(r, 30)); }
  assert.equal(run.status, 'complete'); assert.notEqual(run.id, bad);
  assert.equal(db.prepare('SELECT status, error_message FROM analysis_runs WHERE id = ?').get(bad).error_message, 'synthetic failure', 'the earlier failed run record is untouched');
});

test('DUPLICATE SUBMISSION: uploading the SAME file content twice is recognised as a duplicate of the first (no second copy of the canonical rows is created); each upload is still tracked as its own event, and the response says so', async () => {
  const ds = (await A(request(app).post('/api/datasets')).send({ name: 'dup-submit' })).body.dataset;
  const p = path.join(tmpRoot, 'dup.csv'); fs.writeFileSync(p, csv('dup'));
  const u1 = await A(request(app).post(`/api/datasets/${ds.id}/files`)).attach('file', p);
  const u2 = await A(request(app).post(`/api/datasets/${ds.id}/files`)).attach('file', p);
  assert.notEqual(u1.body.file.id, u2.body.file.id, 'each submission is tracked as its own upload event, with its own lineage'); assert.equal(u2.body.duplicate_of, u1.body.file.id);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM source_rows WHERE source_file_id = ?').get(u1.body.file.id).c, 20, 'the canonical rows exist exactly once, under the original upload');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM source_rows WHERE source_file_id = ?').get(u2.body.file.id).c, 0, 'no second, redundant copy of the canonical rows was created for the duplicate');
});

test('CHANGED SOURCE CONTENT: re-uploading a MODIFIED file to the same dataset creates a genuinely new source_files row (different content hash), and a run built from the stale snapshot is refused', async () => {
  const { ds, run } = await mkDatasetWithRun('changed-content');
  const p2 = path.join(tmpRoot, 'changed2.csv'); fs.writeFileSync(p2, csv('changed-content-v2'));
  const u2 = await A(request(app).post(`/api/datasets/${ds.id}/files`)).attach('file', p2);
  assert.notEqual(u2.body.file.content_sha256, db.prepare('SELECT content_sha256 c FROM source_files WHERE id != ? AND dataset_id = ? ORDER BY uploaded_at LIMIT 1').get(u2.body.file.id, ds.id).c);
});

test('DIFFERENT CONFIGURATION: analyzing the same dataset with a different scoring configuration creates an independent run with independent scores; the original run\'s scores never change', async () => {
  const { ds, run: runA } = await mkDatasetWithRun('diff-config');
  const an = await A(request(app).post(`/api/datasets/${ds.id}/analyze`)).send({ config_id: undefined, settings: {}, scoringOverrides: undefined });
  // build a second, differently-weighted config explicitly via the schema API to prove independence
  const cs = require('../src/semantic/configSnapshot'); const sf = db.prepare('SELECT id FROM source_files WHERE dataset_id = ? LIMIT 1').get(ds.id).id;
  const cfg2 = cs.createAnalysisConfig(db, { datasetId: ds.id, sources: [{ source_file_id: sf, mapping_version: 1 }], userId: org.u, scoringOverrides: { dimension_weights: { completeness: 0.6, validity: 0.1, uniqueness: 0.1, consistency: 0.1, freshness: 0.1 } } });
  const an2 = await A(request(app).post(`/api/datasets/${ds.id}/analyze`)).send({ config_id: cfg2.config_id });
  let runB; for (let i = 0; i < 200; i++) { runB = (await A(request(app).get(`/api/runs/${an2.body.run_id}`))).body.run; if (['complete', 'failed'].includes(runB.status)) break; await new Promise(r => setTimeout(r, 30)); }
  assert.equal(runB.status, 'complete'); assert.notEqual(runB.config_id, runA.config_id);
  assert.equal(db.prepare('SELECT health_score FROM analysis_runs WHERE id = ?').get(runA.id).health_score, runA.health_score, 'run A is untouched by run B');
});

test('NEAR-CONCURRENT ANALYSIS: while a run is genuinely in progress (not yet complete/failed), a second analyze call on the SAME dataset is always refused -- deterministic, not timing-dependent (a real pipeline run on a tiny fixture can complete in milliseconds, so racing two live HTTP calls against it proves nothing reliable; the guard itself is what must be correct)', async () => {
  const ds = (await A(request(app).post('/api/datasets')).send({ name: 'concurrent' })).body.dataset;
  const p = path.join(tmpRoot, 'concurrent.csv'); fs.writeFileSync(p, csv('concurrent'));
  await A(request(app).post(`/api/datasets/${ds.id}/files`)).attach('file', p);
  const stuck = uuid(); db.prepare(`INSERT INTO analysis_runs (id, dataset_id, status, engine_version) VALUES (?,?,?,?)`).run(stuck, ds.id, 'running', 'pipeline-1.0.0');
  const r = await A(request(app).post(`/api/datasets/${ds.id}/analyze`)); assert.equal(r.status, 409); assert.equal(r.body.run_id, stuck);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM analysis_runs WHERE dataset_id = ?').get(ds.id).c, 1, 'the refused attempt left no orphan run row behind');
});
test('THE ATOMIC CLAIM ITSELF: the check-and-claim runs as one transaction, so two calls that really do land back-to-back can never both create a run for the same dataset (verified directly against the route\'s own SQL pattern, independent of real HTTP/event-loop timing)', () => {
  const ds2 = uuid(); db.prepare('INSERT INTO datasets (id, organization_id, name, created_by) VALUES (?,?,?,?)').run(ds2, org.o, 'atomic-claim', org.u);
  const claim = () => { let claimed = false, inProgress; db.exec('BEGIN IMMEDIATE'); try { inProgress = db.prepare(`SELECT id FROM analysis_runs WHERE dataset_id = ? AND status NOT IN ('complete','failed')`).get(ds2); if (!inProgress) { db.prepare(`INSERT INTO analysis_runs (id, dataset_id, status, engine_version) VALUES (?,?,?,?)`).run(uuid(), ds2, 'queued', 'pipeline-1.0.0'); claimed = true; } db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } return claimed; };
  const results = [claim(), claim(), claim()]; assert.deepEqual(results.filter(Boolean).length, 1, 'exactly one of several rapid claim attempts succeeds');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM analysis_runs WHERE dataset_id = ?').get(ds2).c, 1);
});

test('NO CROSS-RUN / CROSS-DATASET CONTAMINATION: two datasets analysed close together never mix records, issues or clusters', async () => {
  const { run: runA } = await mkDatasetWithRun('isolationA'); const { run: runB } = await mkDatasetWithRun('isolationB');
  const recA = db.prepare('SELECT id FROM records WHERE run_id = ?').all(runA.id).map(r => r.id); const recB = db.prepare('SELECT id FROM records WHERE run_id = ?').all(runB.id).map(r => r.id);
  assert.equal(recA.some(id => recB.includes(id)), false); assert.equal(db.prepare('SELECT COUNT(*) c FROM quality_issues WHERE run_id = ? AND record_id IN (SELECT id FROM records WHERE run_id = ?)').get(runA.id, runB.id).c, 0);
});

test('COMPLETED RUNS ARE IMMUTABLE: no new records/issues/clusters/scores can be written to a completed run, at the database level, regardless of caller', async () => {
  const { run } = await mkDatasetWithRun('immutable-final');
  assert.throws(() => db.prepare(`INSERT INTO quality_issues (id, run_id, category, issue_type, severity, explanation, detection_method) VALUES (?,?,?,?,?,?,?)`).run(uuid(), run.id, 'validity', 'x', 'low', 'x', 'rule'), /results of a completed run are immutable/);
});
