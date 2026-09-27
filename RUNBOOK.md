# Production Runbook — Enterprise Data Quality & Master Data Intelligence Platform

Scope note: this runbook documents what is SUPPORTED NOW (built, tested, verified in this environment) versus what
REQUIRES FUTURE INFRASTRUCTURE (explicitly not built, not claimed). The application is a single-node Node.js/Express
backend with a SQLite database and a static Vite/React frontend.

## 1. Prerequisites
- Node.js 22.5+ (uses the built-in `node:sqlite` module — no native build toolchain required).
- A filesystem location for the database and uploaded files (local disk; no object storage is used).
- A reverse proxy / TLS terminator in front of the Node process (not provided by this application).

## 2. Environment variables
| Variable | Required in production | Behavior if unset |
|---|---|---|
| `JWT_SECRET` | Yes | Server refuses to start. No fallback secret is ever used in production. |
| `SEED_ADMIN_PASSWORD` | Yes (only matters on first start, before any user exists) | Server refuses to start. |
| `SEED_ADMIN_EMAIL` | No | Defaults to `admin@example.com`. |
| `CORS_ALLOWED_ORIGINS` | Yes (comma-separated origins) | Server refuses to start. No open/wildcard CORS fallback in production. |
| `VITE_API_BASE_URL` | Yes, at frontend **build** time | Frontend build falls back to `http://localhost:4000/api` (development only). |
| `FILE_RETENTION_DAYS` | No | Defaults to 90. |
| `DATA_DIR`, `DB_PATH`, `UPLOAD_DIR`, `EXPORT_DIR` | No | Default to `backend/{data,uploads,exports}` and `data/platform.db`. |
| `PURGE_SWEEP_DISABLED`, `RATE_LIMIT_DISABLED` | No | Test-only escape hatches. **Never set these in production.** |
| `NODE_ENV=production` | Yes | Enables every fail-safe check above. Without it, none of them are enforced. |

Set `NODE_ENV=production` explicitly — this is what activates every one of the refuse-to-boot checks.

## 3. Database initialization / migration — SUPPORTED NOW
On every start, the application opens `DB_PATH` (creating it if absent) and applies any pending migrations
automatically, in order, transactionally, with checksums (`backend/src/db/migrate.js`). This is idempotent: starting
against an already-current database is a no-op. A pre-existing legacy (pre-framework) database is detected and
adopted, never rebuilt. No manual migration step is required.

## 4. Backup — SUPPORTED NOW (application-level)
```bash
node -e "
const db = require('./backend/src/db');
const { backupDatabase } = require('./backend/src/ops/backup');
console.log(backupDatabase(db, './backups/backup-' + Date.now() + '.db'));
"
```
This uses SQLite's `VACUUM INTO`, producing one consistent, self-contained file even with WAL active. No downtime
is required. Run this on a schedule (cron/systemd timer) appropriate to your recovery point objective.

**Deployment-level responsibility (not implemented here):** copying backup files offsite/to durable storage, retention
of backup files themselves, and any cloud disaster-recovery process are environment/operations concerns. This
application does not implement or claim offsite/cloud backup.

## 5. Restore — SUPPORTED NOW (procedure), tested in this environment
1. Stop the application process.
2. Verify the backup file first, without touching the live database:
   ```bash
   node -e "console.log(require('./backend/src/ops/backup').verifyBackup('./backups/backup-XXXX.db'))"
   ```
   Confirms `PRAGMA integrity_check`, reports the migration version and table row counts.
3. Replace the live database file with the verified backup (`cp backup-XXXX.db data/platform.db`), removing any
   `-wal`/`-shm` sidecar files from the old database first.
4. Start the application. It applies any pending migrations automatically (step 3 above) and runs its normal
   stale-run recovery (any run left non-terminal by the outage is marked `failed` with a clear message — the same
   behavior as any other interrupted run).
5. Verify: `GET /health`, then spot-check a known dataset/run/export through the API or UI.

This exact sequence (minus the live process stop/start, which cannot be safely automated from inside the process
being replaced) is what `tests/backupRestore.test.js` exercises end-to-end, including a full application restart
against the restored file and verification of every persisted layer (datasets, runs, records, findings, clusters,
conflicts, scores, history) and that a completed run's results remain immutable after the round trip.

## 6. Startup
```bash
NODE_ENV=production JWT_SECRET=... SEED_ADMIN_PASSWORD=... CORS_ALLOWED_ORIGINS=https://your-app.example.com \
  node backend/src/server.js
```
The frontend is a static build (`npm run build` in `frontend/`, with `VITE_API_BASE_URL` set) served by any static
file host or the same reverse proxy.

## 7. Health check
`GET /health` → `{ status: 'ok'|'degraded', database_ok, migration_version, pipeline_engine_version, time }`.
No sensitive data (paths, secrets, connection strings) is included.

## 8. Log locations
Structured request logs go to stdout via `morgan` (`combined` format in production). Application errors are logged
to stderr with `console.error`. No credentials are ever logged (verified: the admin bootstrap logs only that a
password was set, never its value). Route this to your platform's log aggregation as appropriate — no file-based
logging is implemented.

## 9. Retention configuration
`FILE_RETENTION_DAYS` (default 90) controls when an originally-uploaded file's bytes are purged. This is safe by
design: canonical data is extracted at ingest time, and no downstream stage (rules, identity, scoring, exports,
re-run) ever re-reads the original file. Only the physical bytes are deleted; the `source_files` row (lineage
metadata: original filename, content hash, timestamps) is retained permanently. An automatic sweep runs every 6 hours
in-process; an admin can also trigger `POST /api/admin/purge-files` on demand (organization-scoped).

## 10. Creating the first admin
On first start with no users in the database, one admin user is created automatically from `SEED_ADMIN_EMAIL` /
`SEED_ADMIN_PASSWORD`. Change the password immediately after first login if you did not set a strong
`SEED_ADMIN_PASSWORD` yourself.

## 11. Deployment behind reverse proxy / TLS — REQUIRES YOUR INFRASTRUCTURE
This application does not terminate TLS itself. Put it behind nginx, Caddy, a cloud load balancer, etc. Ensure the
proxy forwards `Authorization` headers unmodified and does not strip CORS headers.

## 12. Rollback
Application code: redeploy the previous release (the migration system never runs migrations backward, and no
migration in this codebase is destructive — verified by the byte-for-byte legacy-data preservation tests that run
against every migration). Database: restore the most recent backup taken before the change (§5).

## 13. Database migration procedure
Automatic on startup (§3). To rehearse a migration before a real deployment, restore a copy of the production backup
into a scratch location (§5, steps 2–4 using a different destination path) and confirm it completes cleanly.

## 14. Troubleshooting
- **Server refuses to start, error naming `JWT_SECRET`/`SEED_ADMIN_PASSWORD`/`CORS_ALLOWED_ORIGINS`:** the
  corresponding environment variable is missing in production. This is intentional fail-safe behavior, not a bug.
- **A user's session is suddenly invalid after a restore:** expected if the restored database is older than the
  session's issuing point (the user id may no longer exist, or exist differently) — ask them to log in again.
- **A run is stuck at `running` after a crash/restart:** the next startup's stale-run recovery marks it `failed`
  automatically with an explanatory message; the user can simply start a new analysis.
- **`/health` reports `degraded`:** the database is unreachable; check `DB_PATH` and disk/filesystem health.

## 15. Recovery procedure
See §5 (Restore). For a corrupted live database with no clean backup available, `PRAGMA integrity_check` against
the live file (read-only) will reveal the extent of damage; partial recovery beyond a good backup is not supported
by this application and would require manual SQLite-level intervention (a deployment-level/DBA responsibility).

---

## What is explicitly NOT solved (do not assume otherwise)
- **Multi-node deployment is not supported.** The job queue (`pipeline/queue.js`) and the rate limiter
  (`middleware/rateLimit.js`) are both single-process, in-memory. Running more than one instance of this backend
  behind a load balancer will result in independent, uncoordinated queues and rate limits per instance. Multi-node
  support requires a shared queue (e.g. Redis-backed) and a shared rate-limit store — neither exists here.
- **No cloud/offsite backup infrastructure is implemented or assumed.** §4/§5 are application-level capabilities only.
- **No PostgreSQL migration, no Redis, no cloud object storage.** The application is SQLite + local disk by design
  for this phase; a database/storage migration is a future infrastructure decision, not something this pass performs.
