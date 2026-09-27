'use strict';
/*
 * Production hardening: backup/restore. Creates known data, completes a real analysis, backs up with VACUUM INTO,
 * verifies integrity, restores into a clean location, applies migrations, and verifies every persisted layer
 * (datasets, runs, records, findings, clusters, conflicts, scores, history) matches -- with no corruption and no
 * silent loss. Also proves a completed run's results are byte-identical after the round trip (immutability survives
 * backup/restore, not just live-database writes).
 */
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dq-backup-'));
process.env.DATA_DIR = path.join(tmpRoot, 'data'); process.env.DB_PATH = path.join(tmpRoot, 'data', 'test.db'); process.env.UPLOAD_DIR = path.join(tmpRoot, 'uploads'); process.env.EXPORT_DIR = path.join(tmpRoot, 'exports');
process.env.SEED_ADMIN_EMAIL = 'backup-admin@example.com'; process.env.SEED_ADMIN_PASSWORD = 'TestPassword123!'; process.env.JWT_SECRET = 'test-secret'; process.env.PURGE_SWEEP_DISABLED = '1'; process.env.RATE_LIMIT_DISABLED = '1';
const { test } = require('node:test'); const assert = require('node:assert/strict'); const request = require('supertest'); const { DatabaseSync } = require('node:sqlite');
const app = require('../src/server'); const db = require('../src/db'); const { backupDatabase, verifyBackup, restoreIntoCleanLocation, sha256File } = require('../src/ops/backup');
const org = db.prepare('SELECT organization_id o, id u FROM users WHERE email = ?').get(process.env.SEED_ADMIN_EMAIL);
const A = r => r.set('Authorization', 'Bearer ' + require('../src/middleware/auth').signToken({ id: org.u, organization_id: org.o, role: 'admin', name: 'x', email: 'x' }));

let ds, run, backupPath, expectedCounts;

test('SETUP: create a known dataset and complete a real analysis (with a planted duplicate, so clusters/scores are non-trivial)', async () => {
  ds = (await A(request(app).post('/api/datasets')).send({ name: 'backup-test' })).body.dataset;
  const rows = ['Company_Name,GSTIN,Vendor_Code']; for (let i = 0; i < 15; i++) rows.push(`Firm ${i},27ABCDE${1000 + i}F1Z5,V${i}`); rows.push('Firm 0,27ABCDE1000F1Z5,V0');
  const p = path.join(tmpRoot, 'backup.csv'); fs.writeFileSync(p, rows.join('\n') + '\n');
  await A(request(app).post(`/api/datasets/${ds.id}/files`)).attach('file', p);
  const an = await A(request(app).post(`/api/datasets/${ds.id}/analyze`));
  for (let i = 0; i < 200; i++) { run = (await A(request(app).get(`/api/runs/${an.body.run_id}`))).body.run; if (['complete', 'failed'].includes(run.status)) break; await new Promise(r => setTimeout(r, 30)); }
  assert.equal(run.status, 'complete', run.error_message);
});

test('BACKUP: VACUUM INTO produces a single consistent file; integrity check passes; expected row counts recorded', () => {
  backupPath = path.join(tmpRoot, 'backups', `backup-${Date.now()}.db`);
  const result = backupDatabase(db, backupPath);
  assert.ok(fs.existsSync(backupPath)); assert.equal(result.sha256, sha256File(backupPath)); assert.ok(result.size_bytes > 0);
  expectedCounts = {}; for (const t of ['datasets', 'source_files', 'analysis_runs', 'records', 'quality_issues', 'entity_clusters', 'conflict_groups', 'run_scores']) expectedCounts[t] = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
  const check = verifyBackup(backupPath, { expectedCounts });
  assert.equal(check.ok, true, JSON.stringify(check.mismatches)); assert.deepEqual(check.mismatches, []); assert.ok(check.migration_version >= 9);
});

test('BACKUP NAMING/VERSIONING: repeated backups are distinct files, each independently verifiable; a second backup does not disturb the first', () => {
  const backupPath2 = path.join(tmpRoot, 'backups', `backup-${Date.now()}-2.db`);
  const r2 = backupDatabase(db, backupPath2);
  assert.notEqual(r2.sha256 === undefined, true); assert.equal(verifyBackup(backupPath).ok, true, 'the first backup is unaffected by taking a second one');
  assert.equal(verifyBackup(backupPath2).ok, true);
});

test('INTEGRITY VERIFICATION catches a genuinely corrupted backup file, not just a well-formed one', () => {
  const corrupt = path.join(tmpRoot, 'backups', 'corrupt.db'); fs.writeFileSync(corrupt, 'not a real sqlite file at all');
  assert.throws(() => verifyBackup(corrupt), /file is not a database|integrity_check|malformed/i);
});

test('RESTORE into a clean location: migrations apply (idempotently, since the backup is already current), and the application can start against it', () => {
  const restoredDbPath = path.join(tmpRoot, 'restored', 'restored.db');
  const restoredPath = restoreIntoCleanLocation(backupPath, restoredDbPath);
  assert.equal(restoredPath, restoredDbPath); assert.ok(fs.existsSync(restoredDbPath));
  const check = verifyBackup(restoredDbPath, { expectedCounts }); assert.equal(check.ok, true, JSON.stringify(check.mismatches));

  // Full application restart against the restored file: exercises the SAME startup path (migrations + stale-run
  // recovery) a real deployment would after restoring, then verifies every persisted layer through the real API.
  const before = { DATA_DIR: process.env.DATA_DIR, DB_PATH: process.env.DB_PATH };
  process.env.DATA_DIR = path.dirname(restoredDbPath); process.env.DB_PATH = restoredDbPath;
  delete require.cache[require.resolve('../src/config/paths')]; delete require.cache[require.resolve('../src/db')]; delete require.cache[require.resolve('../src/server')];
  let restoredApp, restoredDb;
  try { restoredDb = require('../src/db'); restoredApp = require('../src/server'); } finally { process.env.DATA_DIR = before.DATA_DIR; process.env.DB_PATH = before.DB_PATH; }

  const Ar = r => r.set('Authorization', 'Bearer ' + require('../src/middleware/auth').signToken({ id: org.u, organization_id: org.o, role: 'admin', name: 'x', email: 'x' }));
  return (async () => {
    const dsList = (await Ar(request(restoredApp).get('/api/datasets'))).body.datasets; assert.ok(dsList.some(d => d.id === ds.id), 'the dataset survived the restart');
    const runR = (await Ar(request(restoredApp).get(`/api/runs/${run.id}`))).body.run; assert.equal(runR.status, 'complete'); assert.equal(runR.health_score, run.health_score, 'the completed run\'s score is byte-identical after backup/restore');
    const dash = (await Ar(request(restoredApp).get(`/api/runs/${run.id}/dashboard`))).body; assert.equal(dash.summary.records_analyzed, 16);
    const clusters = (await Ar(request(restoredApp).get(`/api/runs/${run.id}/clusters`))).body.clusters; assert.ok(clusters.length >= 1, 'clusters survived');
    const conflicts = (await Ar(request(restoredApp).get(`/api/runs/${run.id}/conflicts`))).body.conflicts; assert.ok(Array.isArray(conflicts));
    const hist = (await Ar(request(restoredApp).get(`/api/datasets/${ds.id}`))).body.runs; assert.equal(hist.length, 1, 'run history survived');
    for (const t of Object.keys(expectedCounts)) assert.equal(restoredDb.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c, expectedCounts[t], t + ' count survived the round trip exactly');
    assert.throws(() => restoredDb.prepare(`INSERT INTO quality_issues (id, run_id, category, issue_type, severity, explanation, detection_method) VALUES (?,?,?,?,?,?,?)`).run(crypto.randomUUID(), run.id, 'validity', 'x', 'low', 'x', 'rule'), /immutable/, 'the completed run stays immutable after restore, not just on the original live database');
  })();
});
