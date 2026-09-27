# Veridata — Enterprise Data Quality & Master Data Intelligence Platform

Phase 1 (Data Intelligence & Data Quality) of the platform described in the
project brief. Real upload → parse → profile → analyze → detect → explain →
visualize → investigate → export pipeline against actual SAP/ERP-style
exports (.xlsx / .csv). No mock data, no fake progress, no simulated
analysis — sample data (`backend/sample-data/`) is clearly labeled and only
used for development/testing.

**Not technical? See `HOW-TO-RUN.txt` in this folder and double-click
`RUN-BACKEND.bat` then `RUN-FRONTEND.bat` — no command line needed.**

## Architecture

```
backend/    Node.js + Express API, SQLite (node's built-in node:sqlite), all analysis engines
frontend/   React + Vite single-page app (the dashboard UI)
```

- **Database**: SQLite via Node's **built-in** `node:sqlite` module (no
  separate package, no native compilation on install), WAL mode. Schema in
  `backend/src/db/migrations/` (versioned SQL migrations; 0001 is the original schema), including Phase-2 extension tables
  (`golden_records`, `governance_reviews`, `lineage_events`) that exist now
  so Phase 2 can be added without a schema rewrite. (This was originally
  `better-sqlite3`, which requires a C++ toolchain + Python to compile on
  install — switched to `node:sqlite` so `npm install` never fails on a
  machine without developer tools installed. Requires Node.js 22.5+.)
- **Engines** (`backend/src/engines/`):
  - `fileParser.js` — XLSX (multi-sheet) / CSV ingestion
  - `schemaProfiler.js` — column type/role inference, null/cardinality stats
  - `qualityEngine.js` — completeness, validity, freshness, exact-duplicate checks
  - `matchingEngine.js` — blocking + fuzzy multi-field entity/item resolution, clustering
  - `conflictEngine.js` — shared-identifier / different-entity conflict detection
  - `healthScore.js` — explainable, weighted Data Health Score
  - `analysisOrchestrator.js` — ties the above into one analysis run with real progress checkpoints
  - `exportEngine.js` — XLSX/CSV/JSON export generation with source traceability, formula-injection safe
- **Auth**: JWT-based, single seeded admin user on first run (see below).
- **Jobs**: in-process async queue (`jobQueue.js`) so HTTP requests never
  block on analysis; the `jobs` / `analysis_runs` tables model the state a
  real queue (BullMQ/Redis) would need if you outgrow a single node. A
  server restart mid-analysis is recovered on next startup (the run is
  marked failed with a clear message rather than left stuck forever).

## Running locally

Requires Node.js **22.5+** (for the built-in `node:sqlite` module).

```bash
# Backend

cd backend
npm install
npm run seed-sample        # generates backend/sample-data/SAMPLE_erp_export.xlsx (optional)
npm start                  # listens on :4000; prints seeded admin credentials on first run

# Frontend (separate terminal)
cd frontend
npm install
npm run dev                # http://localhost:5173, proxies API calls to :4000 via VITE_API_BASE_URL
```

On first start, the backend seeds a default administrator account, `admin@example.com`,
using a documented local-development-only password, `ChangeMe123!` (never printed to the
console -- it's only written here, in source control, so it's never treated as a secret).
Override it before first start with:

```bash
SEED_ADMIN_EMAIL=you@company.com SEED_ADMIN_PASSWORD='a-strong-password' npm start
```

In production (`NODE_ENV=production`), the server refuses to start at all unless
`SEED_ADMIN_PASSWORD` (and `JWT_SECRET`) are explicitly set -- there is no fallback.

## Running the automated test suite

```bash
cd backend
npm test
```

45 tests covering: normalization/similarity scoring, schema/role inference,
the duplicate/entity matching engine (including two explicit regression
tests for "must NOT merge genuinely different records" cases), the quality
engine (including a regression test for the multi-sheet field-scoping bug
found during development), the conflict engine, the health-score engine, and
a full HTTP-level integration suite (auth, upload, sheet selection, analysis,
dashboard, issue explorer, clusters, and a real generated-and-downloaded
XLSX export) run against an isolated temporary SQLite database.

## Production deployment notes

This was built and tested in a sandboxed environment; before production use:

1. **Environment variables** — set `JWT_SECRET` to a strong random value,
   `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` (or provision the `users` table
   directly), `DATA_DIR` / `UPLOAD_DIR` / `EXPORT_DIR` to persistent volumes,
   and `MAX_UPLOAD_SIZE_BYTES` if you need larger than the 200MB default.
2. **Reverse proxy / TLS** — run behind nginx or similar for HTTPS; the API
   itself does not terminate TLS.
3. **Database** — SQLite is genuinely production-viable for a single-node
   deployment at moderate scale (this is not "localStorage" — it is a real
   ACID-compliant embedded database with proper indexes and foreign keys).
   If you need multi-node horizontal scaling, the schema was designed to
   migrate to Postgres with minimal changes (no SQLite-specific features are
   used beyond `datetime('now')` defaults).
4. **Job processing** — the in-process queue is fine for one server. For
   multiple servers/high volume, swap `jobQueue.js` for a real queue
   (BullMQ + Redis) — the `jobs` and `analysis_runs` tables already carry
   the state fields (`status`, `progress_pct`, `current_stage`) a real queue
   needs.
5. **Large files** — very large XLSX/CSV files (millions of rows) will need
   streaming parsers instead of the current in-memory `xlsx`/`csv-parse`
   read; the blocking-based matching engine is already O(n) in the common
   case (not O(n²)) but very large single blocking-keys (>5000 records) are
   currently capped/skipped as a safety valve — see `matchingEngine.js`.
6. **File storage** — uploaded files and generated exports are stored on
   local disk (`backend/uploads/`, `backend/exports/`); point these at
   network/object storage if running more than one app instance.

## What's implemented vs. deferred

**Implemented and tested:** everything under "Phase 1" in the original brief
— ingestion, schema understanding, the 5-dimension quality engine, fuzzy
duplicate/entity resolution with explainable clusters, item/material
intelligence, cross-field conflict detection, freshness/age analysis, the
health score, the full dashboard UI (overview, issue explorer, cluster
explorer with drill-down, conflicts, record detail, export), Phase 2
locked-module navigation, and a 45-test automated suite.

**Deferred / not built in this pass:** PDF export (XLSX/CSV/JSON are
implemented; PDF requires a templating pass I did not have room for),
role-based multi-user administration UI (the `role` column and middleware
exist; there's no admin screen to manage other users yet), and load-testing
against genuinely large (100k+ row) datasets. See the code comments in
`exportEngine.js` and `matchingEngine.js` for exactly where to extend these.
