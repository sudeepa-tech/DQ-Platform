'use strict';
require('dotenv').config();
require('express-async-errors');
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const morgan = require('morgan');

const authRoutes = require('./routes/auth');
const datasetRoutes = require('./routes/datasets');
const runRoutes = require('./routes/runs');
const recordRoutes = require('./routes/records');
const exportRoutes = require('./routes/exports');
const schemaRoutes = require('./routes/schemaReview');   // S3: semantic mapping review-gate API (additive)

const app = express();

// Open CORS (reflecting any origin) is a real risk once real credentials are in play. In production, restrict to an
// explicit, operator-configured allow-list (CORS_ALLOWED_ORIGINS, comma-separated); local development keeps the
// permissive default so the Vite dev server (a different port) keeps working without extra setup.
const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const corsOptions = { exposedHeaders: ['Content-Disposition'] };
if (process.env.NODE_ENV === 'production') {
  // Fail-safe, not fail-open: production must never silently fall back to open (wildcard-equivalent) CORS just
  // because an operator forgot to set the allow-list -- same posture as JWT_SECRET / SEED_ADMIN_PASSWORD above.
  if (!allowedOrigins.length) throw new Error('CORS_ALLOWED_ORIGINS must be set in production (no wildcard/open CORS fallback is used).');
  corsOptions.origin = (origin, cb) => (!origin || allowedOrigins.includes(origin)) ? cb(null, true) : cb(new Error('Origin not allowed by CORS.'));
}
app.use(cors(corsOptions));
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

app.get('/health', (req, res) => {
  let migration_version = null, database_ok = true;
  try { migration_version = require('./db').prepare('SELECT MAX(version) v FROM schema_migrations').get().v; } catch (e) { database_ok = false; }
  res.json({ status: database_ok ? 'ok' : 'degraded', time: new Date().toISOString(), database_ok, migration_version, pipeline_engine_version: require('./pipeline').PIPELINE_ENGINE_VERSION });
});

app.use('/api/auth', authRoutes);
app.use('/api/datasets', datasetRoutes);
app.use('/api/runs', runRoutes);
app.use('/api/records', recordRoutes);
app.use('/api/schema', schemaRoutes);
app.use('/api', exportRoutes); // exposes /api/runs/:runId/export and /api/exports/:id/download
app.use('/api/admin', require('./routes/admin'));

// File retention (S8): the original uploaded bytes are never needed once a file is canonically ingested (see
// pipeline/retention.js). A periodic, safe, in-process sweep purges eligible files past FILE_RETENTION_DAYS (default 90);
// an admin can also trigger it on demand via POST /api/admin/purge-files. Disabled entirely when PURGE_SWEEP_DISABLED
// is set (e.g. in tests, where deterministic file state matters and cleanup happens per-test instead).
if (!process.env.PURGE_SWEEP_DISABLED) {
  const db = require('./db'); const { purgeEligibleFiles } = require('./pipeline/retention');
  const sweep = () => { try { purgeEligibleFiles(db); } catch (e) { console.error('[retention] purge sweep failed:', e.message); } };
  setInterval(sweep, Number(process.env.PURGE_SWEEP_INTERVAL_MS || 6 * 60 * 60 * 1000)).unref();
}

// ---- Centralized error handling (never leak stack traces / internals) ----
app.use((err, req, res, next) => {
  console.error(err);
  const status = err.status || 500;
  const message = status === 500 ? 'An unexpected error occurred. Please try again.' : err.message;
  res.status(status).json({ error: message });
});

app.use((req, res) => res.status(404).json({ error: 'Not found.' }));

const PORT = process.env.PORT || 4000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Data Quality Platform API listening on port ${PORT}`);
  });
}

module.exports = app;
