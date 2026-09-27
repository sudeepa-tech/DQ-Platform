'use strict';
/*
 * Forward-only, checksummed, transactional SQL migration runner (S1).
 *
 *  - migrations/NNNN_name.sql, contiguous from 0001. Each runs inside ONE transaction together with its bookkeeping row.
 *  - schema_migrations records version, name, sha256 (line-endings normalised, so a Windows CRLF checkout is not "tampering"), timing.
 *  - An already-applied migration whose file has changed => refuse to start (never silently diverge).
 *  - A database newer than this application => refuse to start (never run old code on a newer schema).
 *  - LEGACY ADOPTION: a database created before this framework (has analysis_runs, no schema_migrations) is backed up
 *    (VACUUM INTO: a consistent snapshot even in WAL mode), brought to the baseline idempotently, and stamped as v1 with a note.
 *  - Before applying any pending migration to a database that already holds a schema, a verified backup is taken. If the
 *    backup fails, migration does not proceed.
 *  - There are no "down" migrations: rollback = restore the backup. Documented deliberately: data-preserving forward fixes only.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_DIR = path.join(__dirname, 'migrations');
const FILE_RE = /^(\d{4})_([a-z0-9_]+)\.sql$/;

class MigrationError extends Error {
  constructor(message, details = {}) { super(message); this.name = 'MigrationError'; Object.assign(this, details); }
}

const canonical = sql => sql.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const hasTable = (raw, name) => !!raw.prepare(`SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=?`).get(name);

function discover(dir = DEFAULT_DIR) {
  const names = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  const bad = names.filter(f => !FILE_RE.test(f));
  if (bad.length) throw new MigrationError(`Migration file name(s) must look like 0001_description.sql: ${bad.join(', ')}`);
  const list = names.map(f => { const m = FILE_RE.exec(f); const sql = canonical(fs.readFileSync(path.join(dir, f), 'utf8'));
    return { version: Number(m[1]), name: m[2], file: f, sql, checksum: sha256(sql) }; });
  list.forEach((m, i) => { if (m.version !== i + 1) throw new MigrationError(`Migration versions must be contiguous starting at 0001; expected ${String(i + 1).padStart(4, '0')} but found ${m.file}`); });
  return list;
}

const readApplied = raw => (hasTable(raw, 'schema_migrations')
  ? raw.prepare('SELECT version, name, checksum, applied_at, duration_ms, notes FROM schema_migrations ORDER BY version').all() : []);

function ensureColumn(raw, table, column, ddl) {
  if (!raw.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column)) raw.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

function backupDb(raw, dbFile, fromLabel) {
  if (!dbFile || dbFile === ':memory:') return null;
  const dir = path.join(path.dirname(dbFile), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${path.basename(dbFile)}.pre-migration-${fromLabel}-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`);
  try {
    raw.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
    const { DatabaseSync } = require('node:sqlite');
    const chk = new DatabaseSync(dest, { readOnly: true });
    const ok = chk.prepare('PRAGMA quick_check').get();
    chk.close();
    if (!ok || Object.values(ok)[0] !== 'ok') throw new Error('backup failed its integrity check');
  } catch (e) {
    throw new MigrationError(`Could not create a verified pre-migration backup (${e.message}); the database was NOT modified.`, { cause: e });
  }
  return dest;
}

function applyOne(raw, m, notes) {
  const t0 = Date.now();
  raw.exec('BEGIN IMMEDIATE');
  try {
    raw.exec(m.sql);
    raw.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now')), duration_ms INTEGER, notes TEXT)`);
    raw.prepare('INSERT INTO schema_migrations (version, name, checksum, duration_ms, notes) VALUES (?,?,?,?,?)').run(m.version, m.name, m.checksum, Date.now() - t0, notes || null);
    raw.exec('COMMIT');
  } catch (e) {
    try { raw.exec('ROLLBACK'); } catch (_) { /* nothing open */ }
    throw new MigrationError(`Migration ${m.file} failed and was rolled back: ${e.message}`, { migration: m.file, cause: e });
  }
}

function validate(applied, migrations) {
  const latest = migrations.length;
  applied.forEach((a, i) => { if (a.version !== i + 1) throw new MigrationError(`schema_migrations has a gap or duplicate at version ${a.version}`); });
  const newest = applied.length ? applied[applied.length - 1].version : 0;
  if (newest > latest) throw new MigrationError(`This database is at schema version ${newest} but this application only knows versions up to ${latest}. Upgrade the application; do not run older code against a newer database.`, { newest, latest });
  for (const a of applied) {
    const m = migrations[a.version - 1];
    if (a.checksum !== m.checksum) throw new MigrationError(`Migration ${m.file} was changed after it was applied (checksum mismatch). Applied migrations are immutable: add a new migration instead.`, { migration: m.file });
  }
  return newest;
}

/** Read-only report; never modifies the database. */
function status(raw, { dir = DEFAULT_DIR } = {}) {
  const migrations = discover(dir), applied = readApplied(raw), legacyUnversioned = !hasTable(raw, 'schema_migrations') && hasTable(raw, 'analysis_runs');
  let state = 'up_to_date', problem = null, newest = 0;
  try { newest = validate(applied, migrations); } catch (e) { state = /newer/.test(e.message) ? 'newer_than_application' : 'inconsistent'; problem = e.message; }
  if (state === 'up_to_date') state = legacyUnversioned ? 'legacy_unversioned' : (newest < migrations.length ? 'pending' : 'up_to_date');
  return { state, problem, latest: migrations.length, current: newest, applied, pending: migrations.filter(m => m.version > newest).map(m => m.file), legacyUnversioned };
}

function migrate(raw, { dir = DEFAULT_DIR, dbFile = null, backup = true, log = () => {} } = {}) {
  const migrations = discover(dir);
  const legacyUnversioned = !hasTable(raw, 'schema_migrations') && hasTable(raw, 'analysis_runs');
  const result = { from: 0, to: 0, applied: [], adopted: false, backup: null };
  let backedUp = false;

  if (legacyUnversioned) {                                   // ---- adopt a pre-framework legacy database
    log(`[migrate] existing unversioned (legacy) database detected: adopting as baseline v1`);
    if (backup) { result.backup = backupDb(raw, dbFile, 'legacy'); backedUp = true; log(`[migrate] backup: ${result.backup}`); }
    ensureColumn(raw, 'entity_clusters', 'is_exact_repeat', 'is_exact_repeat INTEGER NOT NULL DEFAULT 0');   // the one ad-hoc column the old code backfilled
    applyOne(raw, migrations[0], 'adopted existing unversioned legacy database (baseline is idempotent: no data touched)');
    result.adopted = true; result.applied.push(migrations[0].file);
  }

  const applied = readApplied(raw);
  const newest = validate(applied, migrations);
  result.from = legacyUnversioned ? 0 : newest;
  const pending = migrations.filter(m => m.version > (legacyUnversioned ? 1 : newest));

  if (pending.length && !legacyUnversioned && !backedUp && backup && applied.length > 0) {   // existing versioned DB: back up before changing it
    result.backup = backupDb(raw, dbFile, `v${newest}`); backedUp = true; log(`[migrate] backup: ${result.backup}`);
  }
  for (const m of pending) { log(`[migrate] applying ${m.file}`); applyOne(raw, m); result.applied.push(m.file); }

  if (result.applied.length) {
    const ok = raw.prepare('PRAGMA quick_check').get();
    if (!ok || Object.values(ok)[0] !== 'ok') throw new MigrationError(`Database failed its integrity check after migration${result.backup ? `; restore from ${result.backup}` : ''}.`, { backup: result.backup });
    const fk = raw.prepare('PRAGMA foreign_key_check').all();
    if (fk.length) log(`[migrate] WARNING: ${fk.length} pre-existing foreign-key inconsistency(ies) found (not caused by migration)`);
  }
  result.to = readApplied(raw).length;
  return result;
}

module.exports = { migrate, status, discover, MigrationError, canonical, sha256, DEFAULT_DIR };
