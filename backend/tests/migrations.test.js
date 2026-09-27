'use strict';
// Migration framework tests. This file never imports src/db (which opens the application database): it drives
// migrate() directly against throw-away databases in the OS temp directory.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { migrate, status, discover, MigrationError, DEFAULT_DIR } = require('../src/db/migrate');

const BASELINE_FILE = path.join(DEFAULT_DIR, '0001_legacy_baseline.sql');
const BASELINE_SQL = fs.readFileSync(BASELINE_FILE, 'utf8');
// sha256 of the ORIGINAL schema.sql shipped before the migration framework existed (S0 pristine copy). 0001 must never change.
const ORIGINAL_SCHEMA_SHA256_PREFIX = 'd84b93457fc480fa';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dq-mig-'));
function openDb(file) { const d = new DatabaseSync(file); d.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;'); return d; }
function copyMigrations(dest, transform = s => s) {
  fs.mkdirSync(dest, { recursive: true });
  for (const f of fs.readdirSync(DEFAULT_DIR)) fs.writeFileSync(path.join(dest, f), transform(fs.readFileSync(path.join(DEFAULT_DIR, f), 'utf8'), f));
}
const tables = db => db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all().map(r => r.name);

// Seed realistic LEGACY rows in every legacy table (columns exactly as the original schema).
function seedLegacy(db, { withExactRepeat = true } = {}) {
  const ins = (sql, ...a) => db.prepare(sql).run(...a);
  ins(`INSERT INTO organizations (id, name) VALUES ('org1','Acme')`);
  ins(`INSERT INTO users (id, organization_id, name, email, password_hash) VALUES ('u1','org1','Admin','a@x.com','hash')`);
  ins(`INSERT INTO datasets (id, organization_id, name, entity_kind, created_by) VALUES ('ds1','org1','Vendors','auto','u1')`);
  ins(`INSERT INTO source_files (id, dataset_id, original_filename, stored_path, file_size_bytes, file_type, sheet_name, status, row_count, column_count) VALUES ('f1','ds1','v.xlsx','/x/v.xlsx',100,'xlsx','Sheet1','parsed',3,4)`);
  ins(`INSERT INTO analysis_runs (id, dataset_id, status, progress_pct, current_stage, config_json, records_analyzed, health_score, health_breakdown_json, finished_at)
       VALUES ('run1','ds1','complete',100,'Complete','{"t":0.82}',3,71.5,'{"overall":71.5}','2026-09-01 10:00:00')`);
  ins(`INSERT INTO field_profiles (id, run_id, source_file_id, column_name, column_index, inferred_type, inferred_role, role_confidence, null_count, null_pct) VALUES ('fp1','run1','f1','Name',0,'string','name',0.9,0,0)`);
  for (const [i, n] of [[1, 'Apex Ltd'], [2, 'Apex Limited'], [3, 'Zenith']]) {
    ins(`INSERT INTO records (id, run_id, source_file_id, source_row_ref, record_kind, raw_json, normalized_json, created_date, modified_date, primary_name, blocking_key)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`, `r${i}`, 'run1', 'f1', i, 'entity', JSON.stringify({ Name: n }), JSON.stringify({ name: n.toLowerCase() }), '2024-01-01', '2025-01-01', n, 'ap');
  }
  ins(`INSERT INTO quality_issues (id, run_id, record_id, category, issue_type, severity, field_name, explanation, detection_method, confidence, extra_json) VALUES ('q1','run1','r3','completeness','missing_field','medium','Phone','Phone is empty','rule',1,'{}')`);
  if (withExactRepeat) ins(`INSERT INTO entity_clusters (id, run_id, cluster_kind, representative_name, record_count, confidence, matching_factors_json, conflicts_json, is_exact_repeat) VALUES ('c1','run1','entity','Apex Ltd',2,0.93,'["Name similarity: 93%"]','[]',0)`);
  else ins(`INSERT INTO entity_clusters (id, run_id, cluster_kind, representative_name, record_count, confidence, matching_factors_json, conflicts_json) VALUES ('c1','run1','entity','Apex Ltd',2,0.93,'["Name similarity: 93%"]','[]')`);
  ins(`INSERT INTO entity_cluster_members (id, cluster_id, record_id) VALUES ('m1','c1','r1'), ('m2','c1','r2')`);
  ins(`INSERT INTO match_pairs (id, run_id, record_a_id, record_b_id, match_type, similarity_score, confidence, matching_factors_json, conflicting_factors_json) VALUES ('p1','run1','r1','r2','fuzzy',0.93,0.93,'[]','[]')`);
  ins(`INSERT INTO conflicts (id, run_id, conflict_type, severity, shared_value, field_name, explanation, record_ids_json) VALUES ('k1','run1','shared_gstin_multi_entity','high','27ABCDE0001F1Z5','GSTIN','shared','["r1","r3"]')`);
  ins(`INSERT INTO jobs (id, run_id, job_type, status, progress_pct, stage) VALUES ('j1','run1','analysis','complete',100,'Complete')`);
  ins(`INSERT INTO exports (id, run_id, export_type, format, file_path) VALUES ('e1','run1','issues','csv','/x/e.csv')`);
}
// canonical content hash of a table restricted to the given columns (the LEGACY columns), rows ordered by id
function contentHash(db, table, cols) {
  const rows = db.prepare(`SELECT ${cols.join(',')} FROM ${table} ORDER BY ${cols[0]}`).all();
  return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}
function legacySnapshot(db) {
  const snap = {};
  for (const t of tables(db).filter(t => t !== 'schema_migrations' && !/^sqlite_/.test(t))) {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
    snap[t] = { cols, count: db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c, hash: contentHash(db, t, cols) };
  }
  return snap;
}

test('0001 baseline is byte-identical to the original legacy schema.sql (it must never change)', () => {
  const canonical = BASELINE_SQL.replace(/\r\n/g, '\n');
  assert.equal(crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16), ORIGINAL_SCHEMA_SHA256_PREFIX);
});

test('fresh database: applies every migration once, records checksums, takes no backup', () => {
  const dir = tmpDir(), file = path.join(dir, 't.db'), db = openDb(file);
  const r = migrate(db, { dbFile: file });
  const all = discover();
  assert.deepEqual(r.applied, all.map(m => m.file));
  assert.equal(r.backup, null);
  assert.equal(r.adopted, false);
  const rows = db.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all();
  assert.deepEqual(rows.map(x => x.checksum), all.map(m => m.checksum));
  assert.equal(fs.existsSync(path.join(dir, 'backups')), false);
  assert.equal(status(db).state, 'up_to_date');
});

test('running migrate() again is a no-op', () => {
  const dir = tmpDir(), file = path.join(dir, 't.db'), db = openDb(file);
  migrate(db, { dbFile: file });
  const r2 = migrate(db, { dbFile: file });
  assert.deepEqual(r2.applied, []);
  assert.equal(r2.backup, null);
});

test('legacy database: backed up, adopted, migrated - and EVERY legacy row is byte-for-byte unchanged', () => {
  const dir = tmpDir(), file = path.join(dir, 'app.db'), db = openDb(file);
  db.exec(BASELINE_SQL);                                  // exactly what the old code did
  seedLegacy(db);
  const before = legacySnapshot(db);
  const r = migrate(db, { dbFile: file });
  assert.equal(r.adopted, true);
  assert.ok(r.backup && fs.existsSync(r.backup), 'a backup must exist');
  // every legacy table: same columns' content, same row count
  for (const [t, b] of Object.entries(before)) {
    const after = contentHash(db, t, b.cols);
    assert.equal(after, b.hash, `legacy table ${t} changed`);
    assert.equal(db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c, b.count, `${t} row count changed`);
  }
  // legacy run is stamped legacy, with nothing fabricated about its configuration
  const run = db.prepare(`SELECT engine_version, reference_date, stale_threshold_years, config_hash, parent_run_id, table_type, config_json FROM analysis_runs WHERE id='run1'`).get();
  assert.deepEqual({ ...run }, { engine_version: 'legacy_v0', reference_date: null, stale_threshold_years: null, config_hash: null, parent_run_id: null, table_type: null, config_json: '{"t":0.82}' });
  // the backup is a valid, complete, PRE-migration copy
  const bk = new DatabaseSync(r.backup, { readOnly: true });
  assert.ok(!tables(bk).includes('source_rows'), 'backup must not contain v1 tables');
  for (const [t, b] of Object.entries(before)) assert.equal(contentHash(bk, t, b.cols), b.hash, `backup table ${t} differs from original`);
  bk.close();
  const rec = db.prepare('SELECT version, notes FROM schema_migrations ORDER BY version').all();
  assert.equal(rec.length, discover().length);
  assert.match(rec[0].notes, /adopted/);
});

test('very old legacy database (no entity_clusters.is_exact_repeat) is upgraded without data loss', () => {
  const file = path.join(tmpDir(), 'old.db'), db = openDb(file);
  db.exec(BASELINE_SQL);
  db.exec('ALTER TABLE entity_clusters DROP COLUMN is_exact_repeat');
  seedLegacy(db, { withExactRepeat: false });
  migrate(db, { dbFile: file });
  const c = db.prepare(`SELECT id, representative_name, record_count, is_exact_repeat FROM entity_clusters`).all();
  assert.deepEqual(c.map(x => ({ ...x })), [{ id: 'c1', representative_name: 'Apex Ltd', record_count: 2, is_exact_repeat: 0 }]);
});

test('a legacy database that has run migrations is never re-adopted or re-backed-up on the next start', () => {
  const file = path.join(tmpDir(), 'app.db'), db = openDb(file);
  db.exec(BASELINE_SQL); seedLegacy(db);
  migrate(db, { dbFile: file });
  const again = migrate(db, { dbFile: file });
  assert.equal(again.adopted, false); assert.equal(again.backup, null); assert.deepEqual(again.applied, []);
  assert.equal(fs.readdirSync(path.join(path.dirname(file), 'backups')).length, 1);
});

test('editing an already-applied migration is detected and blocks startup; the database is untouched', () => {
  const dir = tmpDir(), mig = path.join(dir, 'm'), file = path.join(dir, 't.db'), db = openDb(file);
  copyMigrations(mig);
  migrate(db, { dir: mig, dbFile: file });
  const before = db.prepare('SELECT COUNT(*) c FROM schema_migrations').get().c;
  fs.appendFileSync(path.join(mig, '0002_p0_additive_model.sql'), '\n-- sneaky edit\n');
  assert.throws(() => migrate(db, { dir: mig, dbFile: file }), err => err instanceof MigrationError && /0002_p0_additive_model\.sql/.test(err.message) && /checksum/i.test(err.message));
  assert.equal(db.prepare('SELECT COUNT(*) c FROM schema_migrations').get().c, before);
  assert.equal(status(db, { dir: mig }).state, 'inconsistent');
});

test('CRLF line endings (a Windows checkout) do not change checksums or trigger the tamper check', () => {
  const dir = tmpDir(), crlf = path.join(dir, 'crlf'), file = path.join(dir, 't.db'), db = openDb(file);
  copyMigrations(crlf, s => s.replace(/\r?\n/g, '\r\n'));
  assert.deepEqual(discover(crlf).map(m => m.checksum), discover().map(m => m.checksum));
  migrate(db, { dbFile: file });                          // applied from LF files ...
  assert.deepEqual(migrate(db, { dir: crlf, dbFile: file }).applied, []);   // ... and validated against CRLF copies
});

test('a database newer than the application is refused', () => {
  const file = path.join(tmpDir(), 't.db'), db = openDb(file);
  migrate(db, { dbFile: file });
  const next = discover().length + 1;
  db.prepare(`INSERT INTO schema_migrations (version, name, checksum) VALUES (?, 'from_the_future', 'x')`).run(next);
  assert.throws(() => migrate(db, { dbFile: file }), err => err instanceof MigrationError && /newer|only knows/i.test(err.message));
  assert.equal(status(db).state, 'newer_than_application');
});

test('a failing migration rolls back atomically and leaves the database at the previous version', () => {
  const dir = tmpDir(), mig = path.join(dir, 'm'), file = path.join(dir, 't.db'), db = openDb(file);
  fs.mkdirSync(mig);
  fs.writeFileSync(path.join(mig, '0001_legacy_baseline.sql'), BASELINE_SQL);
  fs.writeFileSync(path.join(mig, '0002_bad.sql'), 'CREATE TABLE half_done (x INTEGER);\nINSERT INTO table_that_does_not_exist VALUES (1);\n');
  assert.throws(() => migrate(db, { dir: mig, dbFile: file }), err => err instanceof MigrationError && /0002_bad\.sql/.test(err.message));
  assert.ok(!tables(db).includes('half_done'), 'partial DDL must be rolled back');
  assert.deepEqual(db.prepare('SELECT version FROM schema_migrations').all().map(r => r.version), [1]);
});

test('gaps in migration numbering are rejected before anything runs', () => {
  const dir = tmpDir(), mig = path.join(dir, 'm'), db = openDb(path.join(dir, 't.db'));
  fs.mkdirSync(mig);
  fs.writeFileSync(path.join(mig, '0001_a.sql'), 'CREATE TABLE a (x);');
  fs.writeFileSync(path.join(mig, '0003_c.sql'), 'CREATE TABLE c (x);');
  assert.throws(() => migrate(db, { dir: mig }), /contiguous/);
  assert.deepEqual(tables(db), []);
});

test('an existing versioned database gets a verified backup BEFORE a newly added migration runs', () => {
  const dir = tmpDir(), mig = path.join(dir, 'm'), file = path.join(dir, 'app.db'), db = openDb(file);
  fs.mkdirSync(mig);
  fs.writeFileSync(path.join(mig, '0001_legacy_baseline.sql'), BASELINE_SQL);
  migrate(db, { dir: mig, dbFile: file });                // fresh: no backup
  seedLegacy(db);
  fs.writeFileSync(path.join(mig, '0002_later.sql'), 'CREATE TABLE later_table (x INTEGER);');
  const r = migrate(db, { dir: mig, dbFile: file });
  assert.ok(r.backup && fs.existsSync(r.backup));
  const bk = new DatabaseSync(r.backup, { readOnly: true });
  assert.ok(!tables(bk).includes('later_table') && tables(bk).includes('records'));
  assert.equal(bk.prepare('SELECT COUNT(*) c FROM records').get().c, 3);
  bk.close();
  assert.ok(tables(db).includes('later_table'));
});

test('status() is strictly read-only and reports legacy_unversioned / pending states', () => {
  const file = path.join(tmpDir(), 'app.db'), db = openDb(file);
  db.exec(BASELINE_SQL); seedLegacy(db);
  const before = legacySnapshot(db);
  const s = status(db);
  assert.equal(s.state, 'legacy_unversioned');
  assert.equal(s.legacyUnversioned, true);
  assert.ok(!tables(db).includes('schema_migrations'), 'status() must not create bookkeeping tables');
  assert.deepEqual(legacySnapshot(db), before);
});
