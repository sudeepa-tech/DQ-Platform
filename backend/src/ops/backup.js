'use strict';
/*
 * Backup / restore (production hardening): the smallest reliable procedure for this SQLite-based architecture.
 *
 * BACKUP: `VACUUM INTO` produces a single, fully self-contained, transactionally consistent snapshot file in one
 * statement -- safe even with WAL mode active (unlike a plain file copy of db.sqlite, which can miss data still only
 * in the -wal file). No application downtime is required: VACUUM INTO reads through a read transaction and does not
 * block concurrent readers/writers for the file-based engine used here.
 *
 * RESTORE: stop the application, replace the live database file with a verified backup, run migrations (idempotent --
 * a backup taken at the same schema version is a no-op; an older backup is upgraded in place, exactly like a fresh
 * install), then start the application. This module implements backup + integrity verification + a scripted
 * restore-into-a-clean-location for testing; the *live-file swap* step of a real restore is an operations action
 * (stop the process, copy a file, start the process) and is documented in the runbook rather than automated here,
 * since automating a swap of the file the running process itself has open is not something that can be done safely
 * from inside that same process.
 */
const path = require('path'); const fs = require('fs'); const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

function sha256File(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }

/** Snapshot the live database into `destPath` (must not already exist). Returns { path, sha256, size_bytes, created_at }. */
function backupDatabase(db, destPath) {
  if (fs.existsSync(destPath)) throw new Error(`Backup destination already exists: ${destPath}`);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  db.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`);
  return { path: destPath, sha256: sha256File(destPath), size_bytes: fs.statSync(destPath).size, created_at: new Date().toISOString() };
}

/** Open a backup file read-only and verify it is a well-formed, readable SQLite database at a known migration version,
 *  with the expected row counts for a set of tables -- WITHOUT touching the live database or process. */
function verifyBackup(backupPath, { expectedCounts } = {}) {
  const db = new DatabaseSync(backupPath, { readOnly: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').get();
    if (!integrity || integrity.integrity_check !== 'ok') throw new Error('Backup failed integrity_check: ' + JSON.stringify(integrity));
    const version = (db.prepare('SELECT MAX(version) v FROM schema_migrations').get() || {}).v || null;
    const counts = {};
    for (const t of ['datasets', 'source_files', 'analysis_runs', 'records', 'quality_issues', 'entity_clusters', 'conflict_groups', 'run_scores']) {
      try { counts[t] = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c; } catch (e) { counts[t] = null; }
    }
    const mismatches = [];
    if (expectedCounts) for (const [t, n] of Object.entries(expectedCounts)) if (counts[t] !== n) mismatches.push({ table: t, expected: n, actual: counts[t] });
    return { ok: mismatches.length === 0, migration_version: version, counts, mismatches };
  } finally { db.close(); }
}

/** Restore a verified backup into a NEW, isolated location and apply pending migrations there (used for the
 *  scripted restore test, and equally the safe way to rehearse a restore before touching a live deployment). Returns
 *  the path to the restored, migrated database file; does not touch the original live database or process env. */
function restoreIntoCleanLocation(backupPath, destDbPath) {
  if (fs.existsSync(destDbPath)) throw new Error(`Restore destination already exists: ${destDbPath}`);
  fs.mkdirSync(path.dirname(destDbPath), { recursive: true });
  fs.copyFileSync(backupPath, destDbPath);
  const { migrate } = require('../db/migrate');
  const restored = new DatabaseSync(destDbPath); restored.exec('PRAGMA journal_mode = WAL;'); restored.exec('PRAGMA foreign_keys = ON;');
  try { migrate(restored, { dbFile: destDbPath, log: () => {} }); }   // applies any pending migrations, exactly like a fresh install would; a no-op if the backup is already current
  finally { restored.close(); }
  return destDbPath;
}

module.exports = { backupDatabase, verifyBackup, restoreIntoCleanLocation, sha256File };
