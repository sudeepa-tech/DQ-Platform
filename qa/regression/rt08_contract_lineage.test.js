'use strict';
/* Approved-requirement contracts. Testable-now items are real tests; items whose API does not exist yet are recorded as TODO (not silently passing). */
const { describe, it, before, test } = require('node:test'); const assert = require('node:assert/strict'); const { DatabaseSync } = require('node:sqlite'); const { boot } = require('./_lib'); let cols;
describe('lineage & versioning contracts', () => {
  before(async () => { const h = await boot(); const db = new DatabaseSync(h.dbPath, { readOnly: true }); const c = t => db.prepare(`PRAGMA table_info(${t})`).all().map(r => r.name); cols = { runs: c('analysis_runs'), records: c('records') }; db.close(); });
  it('RT-25 every analysis run records the engine version that produced it (legacy runs must be identifiable)', () => assert.ok(cols.runs.some(c => /engine_version/.test(c)), 'analysis_runs has no engine_version: legacy and new results are indistinguishable'));
  it('RT-26 records retain source sheet, and normalized values alongside raw values', () => { const need = { 'source sheet': /sheet/, 'normalized values': /normali[sz]ed/ }; const miss = Object.entries(need).filter(([, re]) => !cols.records.some(c => re.test(c))).map(([k]) => k); assert.deepEqual(miss, [], 'records columns: ' + cols.records.join(',')); });
});
const todo = t => test(t, { todo: 'S3/S4: API not designed yet (contract approved)' });
todo('RT-27 dataset semantic interpretation (type, confidence, business key, important fields) is visible BEFORE analysis');
todo('RT-28 low-confidence interpretation yields "review required before analysis" instead of silently proceeding');
// RT-29 promoted in S4 -> rt14_rules_layer.test.js
todo('RT-30 GSTIN checksum/state/PIN packs are OFF by default and switchable per dataset, run and rule');
todo('RT-31 "why were these two records (not) duplicates?" is answerable from the application with per-field evidence');
todo('RT-32 requiredness is labelled Required/Expected/Optional/Unknown; a 95%-populated field is never labelled Required without confirmation');
todo('RT-33 legacy runs display "analyzed with legacy engine" and are never silently re-interpreted');
