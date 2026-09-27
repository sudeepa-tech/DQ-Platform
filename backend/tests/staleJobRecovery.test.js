'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolated DB for this test, separate from other test files' isolated DBs.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dq-platform-recovery-test-'));
process.env.DATA_DIR = path.join(tmpRoot, 'data');
process.env.DB_PATH = path.join(tmpRoot, 'data', 'test.db');

test('a run left in a non-terminal state is marked failed on next process startup', () => {
  // Simulate: a previous process created a run and crashed mid-analysis
  // (status stuck at 'matching', never reaching complete/failed).
  const db1 = require('../src/db');
  const { v4: uuid } = require('uuid');
  const orgId = uuid();
  const datasetId = uuid();
  const runId = uuid();
  const jobId = uuid();
  db1.prepare('INSERT INTO organizations (id, name) VALUES (?,?)').run(orgId, 'Test Org');
  db1.prepare('INSERT INTO datasets (id, organization_id, name) VALUES (?,?,?)').run(datasetId, orgId, 'Test Dataset');
  db1.prepare(`INSERT INTO analysis_runs (id, dataset_id, status, progress_pct, current_stage) VALUES (?,?,?,?,?)`)
    .run(runId, datasetId, 'matching', 65, 'Matching');
  db1.prepare(`INSERT INTO jobs (id, run_id, job_type, status) VALUES (?,?,?,?)`).run(jobId, runId, 'analysis', 'running');

  // Force a fresh require of the db module (simulating a new process
  // starting up and running the startup recovery pass against the same
  // on-disk database).
  delete require.cache[require.resolve('../src/db')];
  const db2 = require('../src/db');

  const run = db2.prepare('SELECT * FROM analysis_runs WHERE id = ?').get(runId);
  assert.equal(run.status, 'failed', 'a run stuck in a non-terminal state must be marked failed on restart, not left stuck forever');
  assert.match(run.error_message, /interrupted by a server restart/i);

  const job = db2.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  assert.equal(job.status, 'failed');
});

test('a run that already completed is left untouched by startup recovery', () => {
  const db = require('../src/db');
  const { v4: uuid } = require('uuid');
  const orgId = uuid();
  const datasetId = uuid();
  const runId = uuid();
  db.prepare('INSERT INTO organizations (id, name) VALUES (?,?)').run(orgId, 'Test Org 2');
  db.prepare('INSERT INTO datasets (id, organization_id, name) VALUES (?,?,?)').run(datasetId, orgId, 'Test Dataset 2');
  db.prepare(`INSERT INTO analysis_runs (id, dataset_id, status, progress_pct, current_stage, health_score) VALUES (?,?,?,?,?,?)`)
    .run(runId, datasetId, 'complete', 100, 'Complete', 92);

  delete require.cache[require.resolve('../src/db')];
  const db2 = require('../src/db');
  const run = db2.prepare('SELECT * FROM analysis_runs WHERE id = ?').get(runId);
  assert.equal(run.status, 'complete', 'a genuinely completed run must never be touched by recovery');
  assert.equal(run.health_score, 92);
});
