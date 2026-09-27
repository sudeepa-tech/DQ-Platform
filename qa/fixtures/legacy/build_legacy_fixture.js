'use strict';
/* Builds a REAL legacy database by running the PRISTINE (pre-S1, original) server against real datasets, then snapshots what
   its API returns. The fixture proves later that a migrated database returns the same legacy data.
   Usage: DQ_PRISTINE_BACKEND=/path/to/original/backend node --experimental-sqlite qa/fixtures/legacy/build_legacy_fixture.js
   (The pristine tree needs node_modules; a symlink to the working backend/node_modules is enough.)  Run once; outputs are committed. */
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { withServer, runDataset, api, REPO } = require('../../harness/http_run');
const PRISTINE = process.env.DQ_PRISTINE_BACKEND || '/home/claude/work/pristine/dq-platform/backend';
const OUT = __dirname;
const DATASETS = [
  { name: 'ERP dump (legacy run)', file: path.join(REPO, 'qa/fixtures/ERP_DQ_Authenticity_Test_Dump.xlsx'), sheet: 'ERP_Dump' },
  { name: 'Hold-out master entity (legacy run)', file: path.join(REPO, 'qa/fixtures/holdout_master_entity.xlsx'), sheet: 'Vendor_Master' }
];

function tableManifest(db) {
  const out = {};
  for (const { name } of db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all()) {
    const cols = db.prepare(`PRAGMA table_info(${name})`).all().map(c => c.name);
    const rows = db.prepare(`SELECT ${cols.join(',')} FROM ${name} ORDER BY ${cols[0]}`).all();
    out[name] = { cols, count: rows.length, hash: crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex') };
  }
  return out;
}

(async () => {
  if (!fs.existsSync(path.join(PRISTINE, 'src/server.js'))) throw new Error('pristine backend not found: ' + PRISTINE);
  if (fs.existsSync(path.join(PRISTINE, 'src/db/migrate.js'))) throw new Error('this is NOT the pristine backend (it already has migrations)');
  await withServer(async ctx => {
    const runs = [];
    for (const d of DATASETS) runs.push({ ...(await runDataset(ctx, { ...d })), name: d.name });
    const snap = {}; const get = async u => { const r = await api(ctx, 'GET', u); if (r.status !== 200) throw new Error(u + ' -> ' + r.status); snap[u] = r.body; return r.body; };
    await get('/api/datasets');
    for (const r of runs) {
      if (r.status !== 'complete') throw new Error(`legacy run ${r.name} did not complete: ${r.status} ${r.error}`);
      await get(`/api/datasets/${r.datasetId}`);
      for (const s of ['', '/dashboard', '/field-profiles', '/issues', '/issues/fields', '/match-summary', '/clusters', '/conflicts', '/records', '/field-issue-summary', '/freshness', '/exports']) await get(`/api/runs/${r.runId}${s}`);
      const cl = snap[`/api/runs/${r.runId}/clusters`]; const list = cl.clusters || cl.items || cl;
      for (const c of (Array.isArray(list) ? list : []).slice(0, 5)) await get(`/api/runs/${r.runId}/clusters/${c.id}`);
    }
    // consolidated single-file copy (VACUUM INTO folds the WAL in) of the DB the ORIGINAL code wrote
    const dest = path.join(OUT, 'legacy_v0.db'); fs.rmSync(dest, { force: true });
    const src = new DatabaseSync(ctx.dbPath); src.exec(`VACUUM INTO '${dest}'`); src.close();
    const chk = new DatabaseSync(dest, { readOnly: true });
    const has = !!chk.prepare(`SELECT 1 FROM sqlite_master WHERE name='schema_migrations'`).get();
    if (has) throw new Error('fixture already has schema_migrations: not a legacy DB');
    const manifest = { built_from: 'pristine original backend (no migration framework)', built_at: new Date().toISOString(), runs: runs.map(r => ({ name: r.name, runId: r.runId, datasetId: r.datasetId })), tables: tableManifest(chk) };
    chk.close();
    fs.writeFileSync(path.join(OUT, 'legacy_v0.manifest.json'), JSON.stringify(manifest, null, 1));
    fs.writeFileSync(path.join(OUT, 'legacy_v0.api_snapshot.json'), JSON.stringify(snap));
    console.log(JSON.stringify({ runs: manifest.runs, endpoints: Object.keys(snap).length, tables: Object.fromEntries(Object.entries(manifest.tables).map(([k, v]) => [k, v.count])), db_bytes: fs.statSync(dest).size }, null, 1));
  }, 'legacy-build', [], { backendDir: PRISTINE });
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
