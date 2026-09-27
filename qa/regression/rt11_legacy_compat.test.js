'use strict';
/* RT-49..RT-54  LEGACY COMPATIBILITY (S1).
   The fixture qa/fixtures/legacy/legacy_v0.db was written by the ORIGINAL, pre-migration server (built by build_legacy_fixture.js from the
   pristine tree): 2 completed analysis runs. Here the NEW server is started on a copy of it through the real startup path, and we prove:
   the database is backed up and adopted, every legacy row is byte-for-byte unchanged, every API response the old server gave is still
   given (new fields are additive only), runs are stamped legacy_v0 with nothing fabricated, and the legacy engine still works.      */
const { describe, it, before } = require('node:test'); const assert = require('node:assert/strict');
const fs = require('fs'); const path = require('path'); const crypto = require('crypto'); const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { withServer, runDataset, api, REPO } = require('../harness/http_run');
const FIX = path.join(REPO, 'qa/fixtures/legacy');
const manifest = JSON.parse(fs.readFileSync(path.join(FIX, 'legacy_v0.manifest.json'), 'utf8'));
const snapshot = JSON.parse(fs.readFileSync(path.join(FIX, 'legacy_v0.api_snapshot.json'), 'utf8'));
const RUN_IDS = manifest.runs.map(r => r.runId);

const hashTable = (db, t, cols, where = '') => crypto.createHash('sha256').update(JSON.stringify(db.prepare(`SELECT ${cols.join(',')} FROM ${t} ${where} ORDER BY ${cols[0]}`).all())).digest('hex');
/** every key/value the OLD response contained must still be there and equal; the new response may only ADD fields */
function subsetDiff(oldV, newV, p = '$') {
  if (oldV === null || typeof oldV !== 'object') return oldV === newV ? [] : [`${p}: ${JSON.stringify(oldV)} -> ${JSON.stringify(newV)}`];
  if (newV === null || typeof newV !== 'object') return [`${p}: object -> ${JSON.stringify(newV)}`];
  if (Array.isArray(oldV)) return !Array.isArray(newV) || oldV.length !== newV.length ? [`${p}: array length ${oldV.length} -> ${Array.isArray(newV) ? newV.length : typeof newV}`] : oldV.flatMap((v, i) => subsetDiff(v, newV[i], `${p}[${i}]`));
  return Object.keys(oldV).flatMap(k => (k in newV ? subsetDiff(oldV[k], newV[k], `${p}.${k}`) : [`${p}.${k}: missing in new response`]));
}

const R = {};   // collected while the migrated server was up
describe('legacy database survives the S1 migration (real server startup path)', () => {
  before(async () => {
    await withServer(async ctx => {
      R.log = ctx.log(); R.dbPath = ctx.dbPath; R.dataDir = path.dirname(ctx.dbPath);
      // --- 1. snapshot the DB the moment the server is up (migration has run, nothing else has happened)
      const db = new DatabaseSync(ctx.dbPath, { readOnly: true });
      R.tables = {}; for (const [t, m] of Object.entries(manifest.tables)) R.tables[t] = { count: db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c, hash: hashTable(db, t, m.cols) };
      R.migrations = db.prepare('SELECT version, name, notes FROM schema_migrations ORDER BY version').all();
      R.runs = db.prepare('SELECT id, engine_version, reference_date, stale_threshold_years, config_hash, effective_config_json, parent_run_id, table_type, input_hash, config_json, status FROM analysis_runs ORDER BY id').all().map(r => ({ ...r }));
      R.newTables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name);
      db.close();
      // --- 2. replay every API call the ORIGINAL server answered, before anything new is created
      ctx.token = (await api(ctx, 'POST', '/api/auth/login', { email: 'qa@example.com', password: 'QaPassw0rd!' })).body.token;
      R.api = {}; for (const url of Object.keys(snapshot)) { const r = await api(ctx, 'GET', url); R.api[url] = { status: r.status, body: r.body }; }
      // --- 3. the legacy engine must still analyse NEW data on the migrated database
      R.fresh = await runDataset(ctx, { file: path.join(REPO, 'qa/fixtures/ERP_DQ_Authenticity_Test_Dump.xlsx'), sheet: 'ERP_Dump', name: 'post-migration run' });
      R.freshRun = (await api(ctx, 'GET', `/api/runs/${R.fresh.runId}`)).body.run;
      const db2 = new DatabaseSync(ctx.dbPath, { readOnly: true });
      R.after = {}; for (const [t, m] of Object.entries({ analysis_runs: 'id', records: 'id', quality_issues: 'id', entity_clusters: 'id', match_pairs: 'id', conflicts: 'id' })) {
        const cols = manifest.tables[t].cols; R.after[t] = hashTable(db2, t, cols, `WHERE ${t === 'analysis_runs' ? 'id' : 'run_id'} IN (${RUN_IDS.map(i => `'${i}'`).join(',')})`);
      }
      db2.close();
    }, 'legacy-compat', [], { seedDb: path.join(FIX, 'legacy_v0.db') });
  });

  it('RT-49 startup detects the legacy database, takes a verified backup FIRST, and the backup equals the original', () => {
    assert.match(R.log, /legacy\) database detected/);
    const bdir = path.join(R.dataDir, 'backups'); const files = fs.existsSync(bdir) ? fs.readdirSync(bdir) : []; assert.equal(files.length, 1, 'exactly one backup expected');
    const bk = new DatabaseSync(path.join(bdir, files[0]), { readOnly: true });
    assert.equal(bk.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    assert.equal(bk.prepare(`SELECT COUNT(*) c FROM sqlite_master WHERE name IN ('schema_migrations','source_rows','file_columns')`).get().c, 0, 'backup must be the PRE-migration database');
    for (const [t, m] of Object.entries(manifest.tables)) assert.equal(hashTable(bk, t, m.cols), m.hash, `backup differs from the original legacy database in ${t}`);
    bk.close();
  });

  it('RT-50 every legacy table is byte-for-byte unchanged after migration (row counts and content hashes)', () => {
    const changed = Object.entries(manifest.tables).filter(([t, m]) => R.tables[t].count !== m.count || R.tables[t].hash !== m.hash).map(([t]) => t);
    assert.deepEqual(changed, [], 'legacy tables changed by migration');
    assert.ok(Object.values(manifest.tables).reduce((n, m) => n + m.count, 0) > 8000, 'fixture unexpectedly small');
  });

  it('RT-51 every shipped migration is recorded (baseline adopted first) and the new schema exists', () => {
    const { discover } = require(path.join(REPO, 'backend/src/db/migrate')); assert.deepEqual(R.migrations.map(m => m.name), discover().map(m => m.name));   // every shipped migration, in order
    assert.match(R.migrations[0].notes, /adopted/);
    for (const t of ['source_rows', 'file_columns', 'schema_mappings', 'analysis_configs', 'config_rule_settings', 'run_inputs', 'match_evidence', 'conflict_groups', 'conflict_group_members', 'score_contributions', 'run_scores']) assert.ok(R.newTables.includes(t), `missing new table ${t}`);
  });

  it('RT-52 legacy runs are stamped legacy_v0 with their original config kept and NOTHING fabricated (no reference date, threshold, config hash)', () => {
    assert.equal(R.runs.length, 2);
    for (const r of R.runs) assert.deepEqual({ ...r, config_json: undefined }, { id: r.id, engine_version: 'legacy_v0', reference_date: null, stale_threshold_years: null, config_hash: null, effective_config_json: null, parent_run_id: null, table_type: null, input_hash: null, config_json: undefined, status: 'complete' });
  });

  it('RT-53 every API response the ORIGINAL server produced is still produced, value for value (new fields are additive only)', () => {
    const problems = [];
    for (const [url, old] of Object.entries(snapshot)) { const now = R.api[url]; if (now.status !== 200) { problems.push(`${url}: HTTP ${now.status}`); continue; } problems.push(...subsetDiff(old, now.body).map(d => `${url} ${d}`)); }
    assert.deepEqual(problems.slice(0, 10), [], `${problems.length} differences`);
    assert.ok(Object.keys(snapshot).length >= 30, 'snapshot unexpectedly small');
    // and the run is now self-describing as legacy through the existing API
    assert.equal(R.api[`/api/runs/${RUN_IDS[0]}`].body.run.engine_version, 'legacy_v0');
  });

  it('RT-54 [S6] the REAL pipeline (not the legacy engine) analyses new data even on a database migrated from the pre-framework server, and leaves the old legacy_v0 runs byte-for-byte untouched', () => {
    // Through S5 this asserted engine_version === 'legacy_v0' for a NEW run: the S1 migration-adoption guarantee was only "old data survives
    // migration; the old engine still happens to work as a continuity net". S6's charter explicitly retires the legacy engine as any run's
    // production path -- including on a migrated-legacy database, which is exactly what this test exercises -- so a new run now gets the v1
    // pipeline's engine_version. The invariant this test actually protects (the ORIGINAL legacy_v0 runs' rows never change) is unaffected and
    // is still checked below.
    assert.equal(R.fresh.status, 'complete', R.fresh.error);
    assert.equal(R.freshRun.engine_version, require(path.join(REPO, 'backend/src/pipeline')).PIPELINE_ENGINE_VERSION);
    for (const t of ['analysis_runs', 'records', 'quality_issues', 'entity_clusters', 'match_pairs', 'conflicts']) {
      const where = t === 'analysis_runs' ? 'id' : 'run_id'; const cols = manifest.tables[t].cols;
      const db = new DatabaseSync(path.join(FIX, 'legacy_v0.db'), { readOnly: true }); const orig = hashTable(db, t, cols, `WHERE ${where} IN (${RUN_IDS.map(i => `'${i}'`).join(',')})`); db.close();
      assert.equal(R.after[t], orig, `${t}: original runs' rows changed after a new run was analysed`);
    }
  });

  it('RT-55 a restart is a no-op: nothing re-adopted, nothing re-applied, no second backup; db:status reports up to date', () => {
    const { migrate, status } = require(path.join(REPO, 'backend/src/db/migrate'));
    const db = new DatabaseSync(R.dbPath); db.exec('PRAGMA foreign_keys = ON;');
    const r = migrate(db, { dbFile: R.dbPath }); assert.deepEqual(r.applied, []); assert.equal(r.backup, null); assert.equal(r.adopted, false);
    assert.equal(status(db).state, 'up_to_date'); db.close();
    assert.equal(fs.readdirSync(path.join(R.dataDir, 'backups')).length, 1);
    const env = { ...process.env, DB_PATH: R.dbPath, DATA_DIR: R.dataDir, UPLOAD_DIR: path.join(R.dataDir, 'u'), EXPORT_DIR: path.join(R.dataDir, 'e') }; delete env.NODE_TEST_CONTEXT; delete env.NODE_ENV;
    const p = spawnSync(process.execPath, ['--experimental-sqlite', path.join(REPO, 'backend/scripts/db-status.js')], { env, encoding: 'utf8' });
    assert.equal(p.status, 0, p.stdout + p.stderr); assert.match(p.stdout, /State:\s+up_to_date/); const total = require(path.join(REPO, 'backend/src/db/migrate')).discover().length; assert.match(p.stdout, new RegExp(`Version:\\s+${total} of ${total}`));
  });
});
