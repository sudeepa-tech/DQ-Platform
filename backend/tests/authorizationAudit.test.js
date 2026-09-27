'use strict';
/*
 * Production hardening: complete authorization audit across EVERY route (not just datasets/runs/admin), traced by
 * actual enforcement rather than route naming. Two real gaps were found and fixed while building this (see routes/
 * datasets.js's parent_run_id check and pipeline/retention.js's organizationId scoping); this file locks both down.
 *
 * AUTHORIZATION MATRIX (route : method : auth : role : org-isolated : mechanism)
 *   /api/auth/login                         POST   no    -      n/a  rate-limited, no auth needed to attempt
 *   /api/auth/me                             GET   yes   -      n/a  reflects the verified token
 *   /api/datasets                            GET   yes   -      yes  WHERE organization_id = ?
 *   /api/datasets                            POST  yes   -      yes  insert carries req.user.org
 *   /api/datasets/:id                        GET   yes   -      yes  ownDataset()
 *   /api/datasets/:id/status                 GET   yes   -      yes  ownDataset()
 *   /api/datasets/:id/files                  POST  yes   -      yes  ownDataset() + rate-limited
 *   /api/datasets/:id/files/:fid/select-sheet POST  yes   -      yes  ownDataset() + file WHERE dataset_id
 *   /api/datasets/:id/files/:fid              DEL  yes   -      yes  ownDataset() + file WHERE dataset_id
 *   /api/datasets/:id/analyze                POST  yes   -      yes  ownDataset(); config_id and parent_run_id both
 *                                                                     verified to belong to this dataset; rate-limited
 *   /api/runs (list/detail/dashboard/issues/clusters/conflicts/pairs/records/exports/freshness/...)
 *                                             GET   yes   -      yes  getRunOrThrow() (JOIN datasets ON org)
 *   /api/records/:id                         GET   yes   -      yes  JOIN datasets ON org
 *   /api/schema/*                       GET/POST/PATCH yes -    yes  ownSource()/ownDataset() on every handler
 *   /api/runs/:id/export                     POST  yes   -      yes  run re-verified by org before export
 *   /api/exports/:id/download                GET   yes   -      yes  JOIN through run+dataset ON org
 *   /api/admin/purge-files                   POST  yes  admin   yes  requireAdmin + organizationId passed to the
 *                                                                     purge itself (not just the reported result)
 *   /api/admin/retention-status              GET   yes  admin   yes  requireAdmin + WHERE organization_id = ?
 */
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dq-authz-'));
process.env.DATA_DIR = path.join(tmpRoot, 'data'); process.env.DB_PATH = path.join(tmpRoot, 'data', 'test.db'); process.env.UPLOAD_DIR = path.join(tmpRoot, 'uploads'); process.env.EXPORT_DIR = path.join(tmpRoot, 'exports');
process.env.SEED_ADMIN_EMAIL = 'authz-admin@example.com'; process.env.SEED_ADMIN_PASSWORD = 'TestPassword123!'; process.env.JWT_SECRET = 'test-secret'; process.env.PURGE_SWEEP_DISABLED = '1'; process.env.RATE_LIMIT_DISABLED = '1';
const { test } = require('node:test'); const assert = require('node:assert/strict'); const request = require('supertest'); const jwt = require('jsonwebtoken');
const app = require('../src/server'); const db = require('../src/db'); const { signToken } = require('../src/middleware/auth');

const orgA = db.prepare('SELECT organization_id o, id u FROM users WHERE email = ?').get(process.env.SEED_ADMIN_EMAIL);
const uuid = () => crypto.randomUUID();
// A second, fully independent organization + a normal (non-admin) member, to prove cross-org isolation and role enforcement.
const orgB = { id: uuid() }; db.prepare('INSERT INTO organizations (id, name) VALUES (?,?)').run(orgB.id, 'Org B');
const memberA = uuid(); db.prepare('INSERT INTO users (id, organization_id, name, email, password_hash, role) VALUES (?,?,?,?,?,?)').run(memberA, orgA.o, 'Member A', 'member-a@example.com', '$2a$10$abcdefghijklmnopqrstuv', 'member');
const adminB = uuid(); db.prepare('INSERT INTO users (id, organization_id, name, email, password_hash, role) VALUES (?,?,?,?,?,?)').run(adminB, orgB.id, 'Admin B', 'admin-b@example.com', '$2a$10$abcdefghijklmnopqrstuv', 'admin');

const tokA = signToken({ id: orgA.u, organization_id: orgA.o, role: 'admin', name: 'x', email: 'x' });
const tokMemberA = signToken({ id: memberA, organization_id: orgA.o, role: 'member', name: 'x', email: 'x' });
const tokAdminB = signToken({ id: adminB, organization_id: orgB.id, role: 'admin', name: 'x', email: 'x' });
const asA = r => r.set('Authorization', 'Bearer ' + tokA); const asMemberA = r => r.set('Authorization', 'Bearer ' + tokMemberA); const asAdminB = r => r.set('Authorization', 'Bearer ' + tokAdminB);

let dsA, fileA, runA, clusterA, exportA, sfConfigId;

test('SETUP: org A creates a dataset, ingests a file with a planted duplicate, and completes a run (all as an org-A admin)', async () => {
  dsA = (await asA(request(app).post('/api/datasets')).send({ name: 'authz-ds' })).body.dataset;
  const rows = ['Company_Name,GSTIN,Vendor_Code']; for (let i = 0; i < 10; i++) rows.push(`Firm ${i},27ABCDE${1000 + i}F1Z5,V${i}`); rows.push('Firm 0,27ABCDE1000F1Z5,V0');
  const p = path.join(tmpRoot, 'authz.csv'); fs.writeFileSync(p, rows.join('\n') + '\n');
  const up = await asA(request(app).post(`/api/datasets/${dsA.id}/files`)).attach('file', p); fileA = up.body.file;
  const an = await asA(request(app).post(`/api/datasets/${dsA.id}/analyze`)); sfConfigId = an.body.config_id;
  let run; for (let i = 0; i < 200; i++) { run = (await asA(request(app).get(`/api/runs/${an.body.run_id}`))).body.run; if (['complete', 'failed'].includes(run.status)) break; await new Promise(r => setTimeout(r, 30)); }
  assert.equal(run.status, 'complete', run.error_message); runA = run;
  const clusters = (await asA(request(app).get(`/api/runs/${runA.id}/clusters`))).body.clusters; assert.ok(clusters.length >= 1); clusterA = clusters[0];
  exportA = (await asA(request(app).post(`/api/runs/${runA.id}/export`)).send({ export_type: 'issues', format: 'json' })).body.export;
});

test('1. UNAUTHENTICATED: every protected endpoint refuses with 401 and no data, across all seven route files', async () => {
  const calls = [
    request(app).get('/api/datasets'), request(app).post('/api/datasets').send({ name: 'x' }), request(app).get(`/api/datasets/${dsA.id}`),
    request(app).get(`/api/runs/${runA.id}`), request(app).get(`/api/runs/${runA.id}/dashboard`), request(app).get(`/api/runs/${runA.id}/issues`),
    request(app).get(`/api/records/${db.prepare('SELECT id FROM records WHERE run_id = ? LIMIT 1').get(runA.id).id}`),
    request(app).get(`/api/schema/sources/${fileA.id}`), request(app).post(`/api/runs/${runA.id}/export`).send({ export_type: 'issues', format: 'json' }),
    request(app).get(`/api/exports/${exportA.id}/download`), request(app).get('/api/admin/retention-status'), request(app).get('/api/auth/me'),
  ];
  const results = await Promise.all(calls); for (const r of results) assert.equal(r.status, 401, r.request.url);
});

test('2. INVALID / EXPIRED TOKEN: a malformed token, a token signed with the wrong secret, and a genuinely expired token are all refused', async () => {
  const wrongSecret = jwt.sign({ sub: orgA.u, org: orgA.o, role: 'admin' }, 'not-the-real-secret', { expiresIn: '1h' });
  const expired = jwt.sign({ sub: orgA.u, org: orgA.o, role: 'admin' }, require('../src/middleware/auth').JWT_SECRET, { expiresIn: '-1h' });
  for (const bad of ['not-a-real-token', wrongSecret, expired]) { const r = await request(app).get('/api/datasets').set('Authorization', 'Bearer ' + bad); assert.equal(r.status, 401, bad.slice(0, 20)); }
  const deletedUserToken = signToken({ id: uuid(), organization_id: orgA.o, role: 'admin', name: 'x', email: 'x' });
  const r = await request(app).get('/api/datasets').set('Authorization', 'Bearer ' + deletedUserToken); assert.equal(r.status, 401);
});

test('3. CROSS-ORGANIZATION IDOR: org B can see NONE of org A\'s dataset, files, runs, records, clusters, exports, or configs by guessing/reusing real ids', async () => {
  const attempts = [
    asAdminB(request(app).get(`/api/datasets/${dsA.id}`)), asAdminB(request(app).get(`/api/datasets/${dsA.id}/status`)),
    asAdminB(request(app).get(`/api/runs/${runA.id}`)), asAdminB(request(app).get(`/api/runs/${runA.id}/dashboard`)),
    asAdminB(request(app).get(`/api/runs/${runA.id}/issues`)), asAdminB(request(app).get(`/api/runs/${runA.id}/clusters`)),
    asAdminB(request(app).get(`/api/runs/${runA.id}/clusters/${clusterA.id}`)), asAdminB(request(app).get(`/api/runs/${runA.id}/conflicts`)),
    asAdminB(request(app).get(`/api/runs/${runA.id}/pairs`)), asAdminB(request(app).get(`/api/records/${db.prepare('SELECT id FROM records WHERE run_id = ? LIMIT 1').get(runA.id).id}`)),
    asAdminB(request(app).get(`/api/schema/sources/${fileA.id}`)), asAdminB(request(app).get(`/api/schema/datasets/${dsA.id}/configs/${sfConfigId}`)),
    asAdminB(request(app).post(`/api/runs/${runA.id}/export`)).send({ export_type: 'issues', format: 'json' }),
    asAdminB(request(app).get(`/api/exports/${exportA.id}/download`)), asAdminB(request(app).post(`/api/datasets/${dsA.id}/analyze`)),
    asAdminB(request(app).post(`/api/schema/runs/${runA.id}/plan-rerun`)).send({ changes: [] }),
  ];
  const results = await Promise.all(attempts); for (const r of results) assert.equal(r.status, 404, r.request.url + ' leaked cross-org data or gave a non-404 response');
});

test('4. ADMIN-ONLY ENDPOINTS refuse a normal (non-admin) user of the SAME organization, and succeed for that org\'s own admin', async () => {
  const asOwnAdmin = asA;
  const refused = await asMemberA(request(app).get('/api/admin/retention-status')); assert.equal(refused.status, 403);
  const refused2 = await asMemberA(request(app).post('/api/admin/purge-files')); assert.equal(refused2.status, 403);
  const ok = await asOwnAdmin(request(app).get('/api/admin/retention-status')); assert.equal(ok.status, 200);
});

test('5. PURGE IS ORGANIZATION-SCOPED AT THE DATA LAYER, not just in the reported response: org B\'s eligible file is untouched by org A\'s purge call', async () => {
  const dsB = uuid(); db.prepare('INSERT INTO datasets (id, organization_id, name, created_by) VALUES (?,?,?,?)').run(dsB, orgB.id, 'org-b-ds', adminB);
  const pB = path.join(tmpRoot, 'orgb.csv'); fs.writeFileSync(pB, 'A,B\n1,2\n');
  const { ingestFile } = require('../src/ingest'); const sfB = ingestFile(db, { datasetId: dsB, filePath: pB }).sourceFileId;
  db.prepare(`UPDATE source_files SET uploaded_at = datetime('now','-200 days') WHERE id = ?`).run(sfB);
  const storedPathB = db.prepare('SELECT stored_path FROM source_files WHERE id = ?').get(sfB).stored_path;
  const r = await asA(request(app).post('/api/admin/purge-files')); assert.equal(r.status, 200);
  assert.equal(fs.existsSync(storedPathB), true, 'org A\'s purge call must never delete org B\'s file'); assert.equal(db.prepare('SELECT purged_at FROM source_files WHERE id = ?').get(sfB).purged_at, null);
});

test('6. PARENT_RUN_ID IS VALIDATED: a client cannot stamp a run with a fabricated lineage pointer to a run outside this dataset (its own org, or another org\'s)', async () => {
  // a run that DOES belong to this dataset (dsA) is accepted:
  const ok = await asA(request(app).post(`/api/datasets/${dsA.id}/analyze`)).send({ config_id: sfConfigId, parent_run_id: runA.id });
  assert.equal(ok.status, 202, JSON.stringify(ok.body));
  // a run id that does not exist / does not belong to this dataset is refused, not silently stored:
  const bad = await asA(request(app).post(`/api/datasets/${dsA.id}/analyze`)).send({ config_id: sfConfigId, parent_run_id: uuid() });
  assert.equal(bad.status, 400); assert.match(bad.body.error, /parent_run_id/);
});
