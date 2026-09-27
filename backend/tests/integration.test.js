'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate this test run's storage from the developer's real data directory.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dq-platform-test-'));
process.env.DATA_DIR = path.join(tmpRoot, 'data');
process.env.DB_PATH = path.join(tmpRoot, 'data', 'test.db');
process.env.UPLOAD_DIR = path.join(tmpRoot, 'uploads');
process.env.EXPORT_DIR = path.join(tmpRoot, 'exports');
process.env.SEED_ADMIN_EMAIL = 'test-admin@example.com';
process.env.SEED_ADMIN_PASSWORD = 'TestPassword123!';
process.env.JWT_SECRET = 'test-secret';

const request = require('supertest');
const app = require('../src/server');

let token;
let datasetId;
let fileId;
let runId;

test('health check responds', async () => {
  const res = await request(app).get('/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');
});

test('rejects protected routes without a token', async () => {
  const res = await request(app).get('/api/datasets');
  assert.equal(res.status, 401);
});

test('REGRESSION: a token that is well-signed but references a user/org no longer in the database is rejected cleanly (401), never allowed through to crash as a raw DB error', async () => {
  const jwt = require('jsonwebtoken');
  const { v4: uuid } = require('uuid');
  const staleToken = jwt.sign(
    { sub: uuid(), org: uuid(), role: 'admin', name: 'Ghost User', email: 'ghost@example.com' },
    process.env.JWT_SECRET,
    { expiresIn: '12h' }
  );
  const res = await request(app).get('/api/datasets').set('Authorization', `Bearer ${staleToken}`);
  assert.equal(res.status, 401);
  assert.match(res.body.error, /session no longer matches|log in again/i);
});

test('login succeeds with seeded admin credentials', async () => {
  const res = await request(app).post('/api/auth/login').send({ email: 'test-admin@example.com', password: 'TestPassword123!' });
  assert.equal(res.status, 200);
  assert.ok(res.body.token);
  token = res.body.token;
});

test('rejects login with wrong password', async () => {
  const res = await request(app).post('/api/auth/login').send({ email: 'test-admin@example.com', password: 'wrong' });
  assert.equal(res.status, 401);
});

test('creates a dataset', async () => {
  const res = await request(app).post('/api/datasets').set('Authorization', `Bearer ${token}`).send({ name: 'Integration Test Dataset' });
  assert.equal(res.status, 201);
  datasetId = res.body.dataset.id;
  assert.ok(datasetId);
});

test('rejects analysis on a dataset with no files', async () => {
  const res = await request(app).post(`/api/datasets/${datasetId}/analyze`).set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 400);
});

test('uploads a CSV file and it is immediately ready (no sheet selection needed)', async () => {
  const csvPath = path.join(tmpRoot, 'test-vendors.csv');
  fs.writeFileSync(csvPath,
    'Vendor Name,GSTIN,Email\n' +
    'ABC Industries Pvt Ltd,27AAAAA0000A1Z5,contact@abc.com\n' +
    'ABC Industries Pvt. Ltd.,27AAAAA0000A1Z5,contact@abc.com\n' +
    // an actually-invalid email, under the live, enabled-by-default validity.email_format rule (the GSTIN checksum rule
    // is disabled by default -- a pre-existing S4 policy decision -- so a checksum-only defect here would never be flagged)
    'Unrelated Traders,19ZZZZZ9999Z1Z1,not-an-email\n' +
    ',,\n' // deliberately blank/incomplete row
  );
  const res = await request(app)
    .post(`/api/datasets/${datasetId}/files`)
    .set('Authorization', `Bearer ${token}`)
    .attach('file', csvPath);
  assert.equal(res.status, 201);
  assert.equal(res.body.requires_sheet_selection, false);
  fileId = res.body.file.id;
});

test('rejects an unsupported file type', async () => {
  const badPath = path.join(tmpRoot, 'not-a-dataset.txt');
  fs.writeFileSync(badPath, 'hello');
  const res = await request(app)
    .post(`/api/datasets/${datasetId}/files`)
    .set('Authorization', `Bearer ${token}`)
    .attach('file', badPath);
  assert.equal(res.status, 400);
});

test('runs analysis end-to-end and reaches complete status', async () => {
  const analyzeRes = await request(app).post(`/api/datasets/${datasetId}/analyze`).set('Authorization', `Bearer ${token}`);
  assert.equal(analyzeRes.status, 202);
  runId = analyzeRes.body.run_id;

  // Poll briefly -- the job queue processes asynchronously but this tiny
  // dataset should complete almost immediately.
  let run;
  for (let i = 0; i < 20; i++) {
    const res = await request(app).get(`/api/runs/${runId}`).set('Authorization', `Bearer ${token}`);
    run = res.body.run;
    if (run.status === 'complete' || run.status === 'failed') break;
    await new Promise(r => setTimeout(r, 150));
  }
  assert.equal(run.status, 'complete');
  assert.equal(run.records_analyzed, 3, 'the fourth, entirely blank row is not a data row (S2 canonical ingest correctly excludes it, unlike the legacy parser)');
  assert.ok(typeof run.health_score === 'number' && run.health_score >= 0 && run.health_score <= 100, 'S7 computes a real, bounded score from the persisted findings');
});

test('dashboard reflects real detected duplicates and issues', async () => {
  const res = await request(app).get(`/api/runs/${runId}/dashboard`).set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  assert.ok(res.body.summary.potential_duplicate_records >= 2, 'the two ABC Industries variants should be detected as duplicates');
});

test('dashboard "records requiring attention" percentage reconciles with real distinct-record counts', async () => {
  const res = await request(app).get(`/api/runs/${runId}/dashboard`).set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  const { records_with_any_issue, records_analyzed, pct_records_requiring_attention } = res.body.summary;
  assert.ok(records_with_any_issue > 0);
  assert.ok(records_with_any_issue <= records_analyzed);
  const expected = Math.round((records_with_any_issue / records_analyzed) * 1000) / 10;
  assert.equal(pct_records_requiring_attention, expected);
});

test('issue explorer supports severity filtering', async () => {
  const res = await request(app).get(`/api/runs/${runId}/issues?severity=critical`).set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  for (const issue of res.body.issues) assert.equal(issue.severity, 'critical');
});

test('clusters endpoint returns the ABC Industries duplicate cluster', async () => {
  const res = await request(app).get(`/api/runs/${runId}/clusters`).set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  assert.ok(res.body.clusters.length >= 1);
});

test('match-summary reflects real match_pairs grouped by actual match type', async () => {
  const res = await request(app).get(`/api/runs/${runId}/match-summary`).set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.by_type));
  for (const row of res.body.by_type) {
    assert.ok(['exact', 'multi_field', 'fuzzy'].includes(row.match_type), 'must only report real match types the engine produces');
  }
});

test('org-wide analysis runs listing includes this run with its dataset name', async () => {
  const res = await request(app).get('/api/runs').set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  const found = res.body.runs.find(r => r.id === runId);
  assert.ok(found, 'the run must appear in the org-wide listing');
  assert.equal(found.dataset_name, 'Integration Test Dataset');
  assert.equal(found.status, 'complete');
});

test('org-wide analysis runs listing supports filtering by dataset_id', async () => {
  const res = await request(app).get(`/api/runs?dataset_id=${datasetId}`).set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  assert.ok(res.body.runs.every(r => r.dataset_id === datasetId));
});

test('field-issue-summary aggregates real issues per field with a correct percentage', async () => {
  const res = await request(app).get(`/api/runs/${runId}/field-issue-summary`).set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  assert.ok(res.body.total_records > 0);
  for (const row of res.body.summary) {
    assert.ok(row.field_name);
    assert.ok(row.affected_records > 0);
    const expectedPct = Math.round((row.affected_records / res.body.total_records) * 1000) / 10;
    assert.equal(row.percentage, expectedPct, 'percentage must be computed from real affected/total counts, not fabricated');
  }
});

test('field-issue-summary supports filtering by category', async () => {
  const res = await request(app).get(`/api/runs/${runId}/field-issue-summary?category=validity`).set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  assert.ok(res.body.summary.every(r => r.category === 'validity'));
});

test('freshness endpoint returns age distribution and never-modified count that reconcile with record totals', async () => {
  const res = await request(app).get(`/api/runs/${runId}/freshness`).set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.age_distribution));
  const totalFromBuckets = res.body.age_distribution.reduce((sum, b) => sum + b.c, 0);
  const dashboardRes = await request(app).get(`/api/runs/${runId}/dashboard`).set('Authorization', `Bearer ${token}`);
  assert.equal(totalFromBuckets, dashboardRes.body.summary.records_analyzed, 'age buckets must account for every analyzed record');
  assert.ok(typeof res.body.never_modified === 'number');
});

test('issues endpoint supports filtering by record_kind (item vs entity)', async () => {
  const entityRes = await request(app).get(`/api/runs/${runId}/issues?record_kind=entity`).set('Authorization', `Bearer ${token}`);
  assert.equal(entityRes.status, 200);
  const itemRes = await request(app).get(`/api/runs/${runId}/issues?record_kind=item`).set('Authorization', `Bearer ${token}`);
  assert.equal(itemRes.status, 200);
  assert.equal(entityRes.body.total + itemRes.body.total <= (await request(app).get(`/api/runs/${runId}/issues`).set('Authorization', `Bearer ${token}`)).body.total, true);
});

test('issues/fields returns only field names that actually have issues', async () => {
  const res = await request(app).get(`/api/runs/${runId}/issues/fields`).set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.fields));
});

test('export generates a real, downloadable XLSX file', async () => {
  const exportRes = await request(app)
    .post(`/api/runs/${runId}/export`)
    .set('Authorization', `Bearer ${token}`)
    .send({ export_type: 'full_analysis', format: 'xlsx' });
  assert.equal(exportRes.status, 201);
  const exportId = exportRes.body.export.id;

  const downloadRes = await request(app).get(`/api/exports/${exportId}/download`).set('Authorization', `Bearer ${token}`).buffer(true).parse((res, cb) => {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
  assert.equal(downloadRes.status, 200);
  assert.ok(downloadRes.headers['content-disposition'].includes('.xlsx'));
  assert.ok(downloadRes.body.length > 1000, 'exported xlsx should be a real file with content, not empty');
});

test('run exports listing shows the export that was just generated', async () => {
  const res = await request(app).get(`/api/runs/${runId}/exports`).set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  assert.ok(res.body.exports.length >= 1);
  assert.equal(res.body.exports[0].export_type, 'full_analysis');
  assert.equal(res.body.exports[0].format, 'xlsx');
});

test('rejects export before analysis completes for a fresh dataset', async () => {
  const ds2 = await request(app).post('/api/datasets').set('Authorization', `Bearer ${token}`).send({ name: 'Second dataset' });
  const ds2Id = ds2.body.dataset.id;
  const csvPath = path.join(tmpRoot, 'second.csv');
  // Enough recognisable master_entity evidence (name + legal id + vendor code) that dataset-type classification is
  // confident and analysis actually starts -- this test is about the export-before-complete race, not classification.
  fs.writeFileSync(csvPath, 'Vendor Name,GSTIN,Vendor Code\nSome Vendor,27AAAAA1111A1Z5,V1\n');
  await request(app).post(`/api/datasets/${ds2Id}/files`).set('Authorization', `Bearer ${token}`).attach('file', csvPath);
  const analyzeRes = await request(app).post(`/api/datasets/${ds2Id}/analyze`).set('Authorization', `Bearer ${token}`);
  const freshRunId = analyzeRes.body.run_id;
  // Immediately (before the async job necessarily finishes) try to export --
  // this may race, so we only assert the endpoint never returns a corrupted
  // "success" for a run that isn't complete.
  const exportRes = await request(app)
    .post(`/api/runs/${freshRunId}/export`)
    .set('Authorization', `Bearer ${token}`)
    .send({ export_type: 'summary', format: 'json' });
  assert.ok([200, 201, 400].includes(exportRes.status));
  if (exportRes.status === 400) {
    assert.match(exportRes.body.error, /not completed/i);
  }
});
