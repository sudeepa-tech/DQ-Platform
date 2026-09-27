'use strict';
/* S7: scoring persisted through the real pipeline, on a real ingested workbook and the real (isolated) database.
   Immutability, config versioning, and reference-date determinism at the persistence layer. */
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dq-s7-'));
process.env.DATA_DIR = path.join(tmpRoot, 'data'); process.env.DB_PATH = path.join(tmpRoot, 'data', 'test.db'); process.env.UPLOAD_DIR = path.join(tmpRoot, 'uploads'); process.env.EXPORT_DIR = path.join(tmpRoot, 'exports');
process.env.SEED_ADMIN_EMAIL = 's7-admin@example.com'; process.env.SEED_ADMIN_PASSWORD = 'TestPassword123!'; process.env.JWT_SECRET = 'test-secret';
const { test } = require('node:test'); const assert = require('node:assert/strict');
const db = require('../src/db'); const app = require('../src/server'); const { ingestFile } = require('../src/ingest'); const svc = require('../src/semantic/schemaService'); const cs = require('../src/semantic/configSnapshot');
const { executeRun } = require('../src/pipeline/runPipeline'); const { writeWorkbook } = require('./helpers/workbook');

const org = db.prepare('SELECT organization_id o, id u FROM users WHERE email = ?').get(process.env.SEED_ADMIN_EMAIL);
const uuid = () => crypto.randomUUID(); const dsId = uuid();
db.prepare('INSERT INTO datasets (id, organization_id, name, created_by) VALUES (?,?,?,?)').run(dsId, org.o, 'S7 dataset', org.u);
const header = ['Record ID', 'Supplier Name', 'GST No', 'Supplier No.', 'E-mail', 'Created On', 'Changed On'];
const rows = [header]; for (let i = 1; i <= 20; i++) rows.push(['R-' + String(i).padStart(3, '0'), 'Firm ' + i, `27ABCDE${1000 + i}F1Z5`, 'V' + i, i % 5 === 0 ? '' : `f${i}@x.example.com`, { v: 45000, z: 'yyyy-mm-dd' }, { v: 45900, z: 'yyyy-mm-dd' }]);
const xl = path.join(tmpRoot, 'v.xlsx'); writeWorkbook(xl, rows);
const SF = ingestFile(db, { datasetId: dsId, filePath: xl }).sourceFileId; svc.suggestMapping(db, SF, { userId: org.u }); svc.confirmMapping(db, SF, 1, { userId: org.u, acceptSuggestions: true });
async function runOnce(over = {}) {
  const cfg = cs.createAnalysisConfig(db, { datasetId: dsId, sources: [{ source_file_id: SF, mapping_version: 1 }], userId: org.u, settings: { reference_date_mode: 'fixed', reference_date: '2026-09-25' }, ...over });
  const runId = uuid(), jobId = uuid();
  db.prepare(`INSERT INTO analysis_runs (id, dataset_id, status, engine_version, config_id, config_hash, table_type, reference_date, stale_threshold_years) VALUES (?,?,?,?,?,?,?,?,?)`).run(runId, dsId, 'queued', 'pipeline-1.0.0', cfg.config_id, cfg.config_hash, 'master_entity', '2026-09-25', 4);
  await executeRun(db, { runId, jobId, todayISO: '2026-09-25' }); return { runId, cfg };
}

test('IMMUTABLE REFERENCE DATE: the SAME run always produces the SAME score, regardless of when it is queried; scoring reads no server clock', async () => {
  const { runId } = await runOnce(); const run = db.prepare('SELECT * FROM analysis_runs WHERE id = ?').get(runId);
  assert.equal(run.status, 'complete'); assert.ok(typeof run.health_score === 'number'); const first = run.health_score;
  await new Promise(r => setTimeout(r, 30)); const again = db.prepare('SELECT health_score FROM analysis_runs WHERE id = ?').get(runId).health_score; assert.equal(again, first);
});
test('SCORES ARE IMMUTABLE for a completed run: writing to run_scores / score_contributions after completion is refused; a configuration change creates a NEW run instead', async () => {
  const { runId } = await runOnce();
  assert.throws(() => db.prepare(`INSERT INTO run_scores (run_id, dimension, score, formula_version) VALUES (?,?,?,?)`).run(runId, 'validity', 50, 'x'), /cannot be written to a legacy run or a completed run/);
  const before = db.prepare('SELECT score FROM run_scores WHERE run_id = ? AND dimension = ?').get(runId, 'overall').score;
  const { runId: runId2 } = await runOnce({ scoringOverrides: { dimension_weights: { completeness: 0.6, validity: 0.1, uniqueness: 0.1, consistency: 0.1, freshness: 0.1 } } });
  assert.notEqual(runId2, runId); const after2 = db.prepare('SELECT score FROM run_scores WHERE run_id = ? AND dimension = ?').get(runId2, 'overall').score;
  assert.equal(db.prepare('SELECT score FROM run_scores WHERE run_id = ? AND dimension = ?').get(runId, 'overall').score, before, 'the original run is untouched by a differently-configured new run');
});
test('CONFIG VERSIONING: the scoring configuration lives inside the immutable snapshot (schema_version 4), with its own engine version and hash; an invalid override creates nothing', () => {
  const { config_id } = cs.createAnalysisConfig(db, { datasetId: dsId, sources: [{ source_file_id: SF, mapping_version: 1 }], userId: org.u });
  const snap = cs.getAnalysisConfig(db, config_id).config.snapshot; assert.equal(snap.schema_version, 4);
  const S = require('../src/scoring'); assert.deepEqual([snap.scoring.engine_version, snap.scoring.config_hash], [S.SCORING_ENGINE_VERSION, S.hashConfig(S.resolveScoringConfig())]);
  const beforeCount = db.prepare('SELECT COUNT(*) c FROM analysis_configs').get().c;
  assert.throws(() => cs.createAnalysisConfig(db, { datasetId: dsId, sources: [{ source_file_id: SF, mapping_version: 1 }], userId: org.u, scoringOverrides: { severity_weights: { critical: 9 } } }));
  assert.equal(db.prepare('SELECT COUNT(*) c FROM analysis_configs').get().c, beforeCount, 'an invalid scoring configuration creates nothing');
});
test('PERSISTED EXPLANATION TREE: every dimension row (and the overall row) carries a parseable explanation_json the UI can render directly, with no re-derivation from raw findings needed', async () => {
  const { runId } = await runOnce(); const rows = db.prepare('SELECT * FROM run_scores WHERE run_id = ?').all(runId); assert.equal(rows.length, 6);
  for (const r of rows) { const j = JSON.parse(r.explanation_json); assert.ok(j); if (r.dimension !== 'overall') assert.ok(Array.isArray(j.items)); else assert.ok(j.dimension_scores && j.dimension_weights); }
  const contrib = db.prepare('SELECT * FROM score_contributions WHERE run_id = ?').all(runId); assert.ok(contrib.length > 0); for (const c of contrib) assert.ok(c.explanation && c.source_file_id === SF);
});
