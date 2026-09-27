// Uses Node's BUILT-IN SQLite module (node:sqlite, available since Node
// 22.5+, no separate install) instead of the better-sqlite3 npm package.
// better-sqlite3 ships a native addon that must be COMPILED on install via
// node-gyp, which in turn requires Python and a C++ toolchain to be
// present on the machine -- these are frequently missing on a non-developer
// Windows PC (this is exactly the class of failure that motivated this
// switch: "gyp ERR! find Python ... could not find any Python installation").
// node:sqlite needs nothing beyond Node.js itself, so `npm install` can
// never fail this way.
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

// Storage locations come from ONE place (config/paths.js). In a test context that module never resolves to the real
// application storage, so importing this file from a test can no longer touch (or run stale-run recovery on) a real database.
const paths = require('../config/paths');
const { migrate } = require('./migrate');

const DATA_DIR = paths.DATA_DIR;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = paths.DB_PATH;
const raw = new DatabaseSync(DB_PATH);
raw.exec('PRAGMA journal_mode = WAL;');
raw.exec('PRAGMA foreign_keys = ON;');

// ---- Versioned schema migrations ----
// Replaces the old "run schema.sql on every start + ad-hoc ensureColumn" approach. Migrations are forward-only, checksummed
// and transactional; a pre-existing (legacy) database is backed up and adopted, never rebuilt. See db/migrate.js.
const migration = migrate(raw, { dbFile: DB_PATH, log: (m) => console.log(m) });

// ---- Thin compatibility wrapper ----
// The rest of the codebase (all routes/engines) was written against
// better-sqlite3's synchronous API: db.prepare(sql).run/get/all(...args),
// db.exec(sql), and db.transaction(fn) returning a callable that wraps fn
// in BEGIN/COMMIT/ROLLBACK. node:sqlite's DatabaseSync supports prepare/
// exec directly with the same call shape, but has no built-in
// .transaction() helper -- this wrapper adds one so no calling code
// elsewhere needed to change.
const db = {
  prepare: (sql) => raw.prepare(sql),
  exec: (sql) => raw.exec(sql),
  transaction(fn) {
    return (...args) => {
      raw.exec('BEGIN');
      try {
        const result = fn(...args);
        raw.exec('COMMIT');
        return result;
      } catch (err) {
        try { raw.exec('ROLLBACK'); } catch (_) { /* nothing to roll back */ }
        throw err;
      }
    };
  }
};

// ---- Stale-job recovery on startup ----
// The job queue (src/engines/jobQueue.js) is an in-process, in-memory
// queue: if the server process restarts (crash, redeploy, OOM-kill) while
// a run is 'queued' or mid-analysis, that in-memory queue is gone, but the
// analysis_runs/jobs rows are left behind at whatever non-terminal status
// they were last at -- with nothing left to ever pick them back up. Left
// alone, that run stays "queued"/"profiling"/etc. forever, and the
// frontend polls it indefinitely with no path to resolution.
//
// We do NOT attempt to resume a partially-completed run: it may already
// have partially inserted records/issues for that run_id, and re-running
// analysisOrchestrator against the same run_id would insert a second,
// duplicate copy on top rather than cleanly restarting (there is no
// idempotency key preventing double-insertion). The safe, honest recovery
// is to mark any run that didn't reach a terminal state as failed with a
// clear explanation, so the user sees an accurate status and can start a
// fresh run (a new run_id) via the existing "Start analysis" action.
function recoverStaleRuns() {
  const stale = db.prepare(`SELECT id FROM analysis_runs WHERE status NOT IN ('complete', 'failed')`).all();
  if (stale.length === 0) return;
  const markFailed = db.prepare(
    `UPDATE analysis_runs SET status = 'failed', error_message = ?, finished_at = datetime('now') WHERE id = ?`
  );
  const markJobFailed = db.prepare(
    `UPDATE jobs SET status = 'failed', error_message = ?, updated_at = datetime('now') WHERE run_id = ? AND status NOT IN ('complete', 'failed')`
  );
  const msg = 'This analysis was interrupted by a server restart and could not be resumed safely. Please start a new analysis for this dataset.';
  const txn = db.transaction(() => {
    for (const run of stale) {
      markFailed.run(msg, run.id);
      markJobFailed.run(msg, run.id);
    }
  });
  txn();
  console.warn(`[startup] Marked ${stale.length} interrupted analysis run(s) as failed (see analysis_runs.error_message).`);
}
recoverStaleRuns();

db.migration = migration;   // what happened at startup (applied files, backup path, adoption)
module.exports = db;
