'use strict';
/* In-process app harness (supertest), isolated temp storage. One boot per test FILE (node:test isolates files in processes). */
const fs = require('fs'); const os = require('os'); const path = require('path'); const REPO = path.resolve(__dirname, '..', '..');
const { loadRun } = require('./adapter_legacy_v0'); const ENGINE = require('./engine_under_test');
function boot() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dq-qa-inproc-'));
  Object.assign(process.env, { DATA_DIR: path.join(tmp, 'data'), DB_PATH: path.join(tmp, 'data', 'qa.db'), UPLOAD_DIR: path.join(tmp, 'uploads'), EXPORT_DIR: path.join(tmp, 'exports'), SEED_ADMIN_EMAIL: 'qa@example.com', SEED_ADMIN_PASSWORD: 'QaPassw0rd!', JWT_SECRET: 'qa-secret' });
  const request = require(path.join(REPO, 'backend/node_modules/supertest')); const app = require(path.join(REPO, 'backend/src/server'));
  return { request, app, dbPath: process.env.DB_PATH, tmp, token: null };
}
const auth = (h, req) => req.set('Authorization', 'Bearer ' + h.token);
async function login(h) { const r = await h.request(h.app).post('/api/auth/login').send({ email: 'qa@example.com', password: 'QaPassw0rd!' }); h.token = r.body.token; return h; }
const writeFile = (h, name, text) => { const p = path.join(h.tmp, name); fs.writeFileSync(p, text); return p; };
async function upload(h, file, { sheet, name = 'qa' } = {}) {
  const ds = (await auth(h, h.request(h.app).post('/api/datasets')).send({ name })).body.dataset;
  const up = await auth(h, h.request(h.app).post(`/api/datasets/${ds.id}/files`)).attach('file', file);
  if (up.body.requires_sheet_selection) await auth(h, h.request(h.app).post(`/api/datasets/${ds.id}/files/${up.body.file_id}/select-sheet`)).send({ sheet_name: sheet });
  return { datasetId: ds.id, fileId: up.body.file_id || (up.body.file && up.body.file.id) };
}
async function analyze(h, datasetId) {
  const an = await auth(h, h.request(h.app).post(`/api/datasets/${datasetId}/analyze`)); if (an.status !== 202) return { analyzeStatus: an.status, status: 'rejected', error: JSON.stringify(an.body) };
  let run; for (let i = 0; i < 600; i++) { run = (await auth(h, h.request(h.app).get(`/api/runs/${an.body.run_id}`))).body.run; if (['complete', 'failed'].includes(run.status)) break; await new Promise(r => setTimeout(r, 100)); }
  return { analyzeStatus: 202, runId: an.body.run_id, status: run.status, error: run.error_message };
}
async function runFile(h, file, opts = {}) {
  const u = await upload(h, file, opts); const r = await analyze(h, u.datasetId);
  if (ENGINE.rules === 'v1' && r.runId) { h._v1 = h._v1 || {}; h._v1[r.runId] = { file, sheet: opts.sheet }; }   // remember what to run the v1 rules layer on (the live route is NOT wired to it)
  return { ...u, ...r };
}
const dashboard = async (h, runId) => (await auth(h, h.request(h.app).get(`/api/runs/${runId}/dashboard`))).body;
/* S4: with QA_RULES=v1 the view's ISSUES come from the v1 rules layer (in-process, from the real confirmed S3 mapping + an immutable configuration snapshot); every other layer of the view is still the legacy run. */
function view(h, runId, keyColumn) {
  const v = loadRun(h.dbPath, { runId, keyColumn }); const o = h._v1 && h._v1[runId];
  if (ENGINE.rules === 'v1' && o) { const R = require('./rules_v1'); const out = R.analyzeFile(o.file, { sheet: o.sheet }); const pr = out.result.provenance; v.issues = R.toLegacyIssues(out, keyColumn);
    v.config = { ...v.config, stale_after_years: pr.stale_threshold_years, reference: pr.reference_date, stale_definition: 'calendar anniversary (date + threshold) before the frozen reference date', rules_engine: pr.engine_version }; v.engine = v.engine + '+rules_' + pr.engine_version; }
  /* S5: with QA_IDENTITY=v1 the view's CLUSTERS and CONFLICTS come from the v1 identity layer (in-process, from the confirmed mapping + S4 findings); scoring / dashboard are still the legacy run. */
  if (ENGINE.identity === 'v1' && o) { const I = require('./identity_v1'); const idv = I.analyzeIdentity(o.file, { sheet: o.sheet }); Object.assign(v, I.toLegacyView(idv, keyColumn)); v.engine = v.engine + '+identity_' + idv.identity.provenance.engine_version; }
  return v;
}
/* small CSV builder: rows are arrays aligned to header */
const csv = (header, rows) => [header, ...rows].map(r => r.map(v => { v = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(',')).join('\n') + '\n';
module.exports = { boot, login, auth, writeFile, upload, analyze, runFile, dashboard, view, csv, REPO };
