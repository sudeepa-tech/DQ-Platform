'use strict';
const express = require('express');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { upload } = require('../middleware/upload');
const { listSheets, validateUploadedFile } = require('../ingest/reader');
const { ingestSourceFile } = require('../ingest');
const svc = require('../semantic/schemaService');
const cs = require('../semantic/configSnapshot');
const D = require('../rules/dates');
const { datasetStatus } = require('../pipeline/datasetStatus');
const { enqueueRun } = require('../pipeline/queue');
const { PIPELINE_ENGINE_VERSION } = require('../pipeline');
const { rateLimit } = require('../middleware/rateLimit');

const router = express.Router();
router.use(requireAuth);
// Abuse/DoS protection: uploading and analysing are the two expensive, disk/CPU-consuming operations on this path.
const uploadLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, keyFn: req => (req.user && req.user.org) || req.ip });
const analyzeLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, keyFn: req => (req.user && req.user.org) || req.ip });

router.get('/', (req, res) => {
  const datasets = db.prepare(`SELECT d.*,
      (SELECT COUNT(*) FROM source_files WHERE dataset_id = d.id) as file_count,
      (SELECT ar.status FROM analysis_runs ar WHERE ar.dataset_id = d.id ORDER BY started_at DESC LIMIT 1) as latest_run_status,
      (SELECT ar.id FROM analysis_runs ar WHERE ar.dataset_id = d.id ORDER BY started_at DESC LIMIT 1) as latest_run_id,
      (SELECT ar.health_score FROM analysis_runs ar WHERE ar.dataset_id = d.id ORDER BY started_at DESC LIMIT 1) as latest_health_score
    FROM datasets d WHERE organization_id = ? ORDER BY created_at DESC`).all(req.user.org);
  res.json({ datasets });
});

router.post('/', (req, res) => {
  const { name, description, entity_kind } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Dataset name is required.' });
  const id = uuid();
  db.prepare('INSERT INTO datasets (id, organization_id, name, description, entity_kind, created_by) VALUES (?,?,?,?,?,?)')
    .run(id, req.user.org, String(name).trim(), description || null, entity_kind || 'auto', req.user.sub);
  const dataset = db.prepare('SELECT * FROM datasets WHERE id = ?').get(id);
  res.status(201).json({ dataset });
});

function ownDataset(req) {
  const dataset = db.prepare('SELECT * FROM datasets WHERE id = ? AND organization_id = ?').get(req.params.id, req.user.org);
  if (!dataset) throw Object.assign(new Error('Dataset not found.'), { status: 404 });
  return dataset;
}

router.get('/:id', (req, res) => {
  const dataset = ownDataset(req);
  const files = db.prepare('SELECT * FROM source_files WHERE dataset_id = ? ORDER BY uploaded_at DESC').all(dataset.id);
  const runs = db.prepare('SELECT * FROM analysis_runs WHERE dataset_id = ? ORDER BY started_at DESC').all(dataset.id);
  res.json({ dataset, files, runs });
});

// Real, computed orchestration status: uploaded | ingesting | review_required | configured | queued | running | completed | failed.
// Never stored, so it can never drift from the tables that hold the truth (S1 ingest state, S3 mapping state, run state).
router.get('/:id/status', (req, res) => {
  const dataset = ownDataset(req);
  res.json(datasetStatus(dataset.id));
});

// Upload one file, then IMMEDIATELY canonically ingest it (S2): the production path never runs the legacy row/column parser.
// If XLSX has multiple sheets, sheet selection (and therefore ingest) is deferred to /select-sheet.
router.post('/:id/files', uploadLimiter, (req, res) => {
  const dataset = ownDataset(req);
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file was uploaded.' });
    try {
      const { ext } = validateUploadedFile(req.file.path, req.file.originalname, require('../middleware/upload').MAX_SIZE_BYTES);
      const fileId = uuid();
      if (ext === 'xlsx') {
        const sheets = listSheets(req.file.path);
        if (sheets.length > 1) {
          db.prepare(`INSERT INTO source_files (id, dataset_id, original_filename, stored_path, file_size_bytes, file_type, status)
            VALUES (?,?,?,?,?,?,?)`).run(fileId, dataset.id, req.file.originalname, req.file.path, req.file.size, 'xlsx', 'awaiting_sheet_selection');
          return res.status(202).json({ file_id: fileId, requires_sheet_selection: true, sheets });
        }
        db.prepare(`INSERT INTO source_files (id, dataset_id, original_filename, stored_path, file_size_bytes, file_type, sheet_name, status)
          VALUES (?,?,?,?,?,?,?,?)`).run(fileId, dataset.id, req.file.originalname, req.file.path, req.file.size, 'xlsx', sheets[0], 'uploaded');
      } else {
        db.prepare(`INSERT INTO source_files (id, dataset_id, original_filename, stored_path, file_size_bytes, file_type, status)
          VALUES (?,?,?,?,?,?,?)`).run(fileId, dataset.id, req.file.originalname, req.file.path, req.file.size, 'csv', 'uploaded');
      }
      let ingest_error = null, duplicate_of = null;
      try { const r = ingestSourceFile(db, fileId); duplicate_of = r.duplicateOf || null; } catch (e) { ingest_error = e.message; }
      const file = db.prepare('SELECT * FROM source_files WHERE id = ?').get(fileId);
      res.status(201).json({ file, requires_sheet_selection: false, ingest_error, duplicate_of });
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  });
});

// Accepts { sheet_name } or { sheet_names: [...] } (import several sheets as separate logical sources). Each created
// source file is canonically ingested right away, same as the single-sheet upload path.
router.post('/:id/files/:fileId/select-sheet', (req, res) => {
  const dataset = ownDataset(req);
  const { sheet_name, sheet_names } = req.body || {};
  const names = sheet_names && Array.isArray(sheet_names) && sheet_names.length ? sheet_names : (sheet_name ? [sheet_name] : null);
  if (!names) return res.status(400).json({ error: 'sheet_name or sheet_names is required.' });
  const file = db.prepare('SELECT * FROM source_files WHERE id = ? AND dataset_id = ?').get(req.params.fileId, dataset.id);
  if (!file) return res.status(404).json({ error: 'File not found.' });

  const created = [];
  const firstName = names[0];
  db.prepare('UPDATE source_files SET sheet_name = ?, status = ? WHERE id = ?').run(firstName, 'uploaded', file.id);
  let firstIngestError = null; try { ingestSourceFile(db, file.id); } catch (e) { firstIngestError = e.message; }
  created.push({ ...db.prepare('SELECT * FROM source_files WHERE id = ?').get(file.id), ingest_error: firstIngestError });

  for (const extraName of names.slice(1)) {
    const newId = uuid();
    db.prepare(`INSERT INTO source_files (id, dataset_id, original_filename, stored_path, file_size_bytes, file_type, sheet_name, status)
      VALUES (?,?,?,?,?,?,?,?)`).run(newId, file.dataset_id, file.original_filename, file.stored_path, file.file_size_bytes, file.file_type, extraName, 'uploaded');
    let ingest_error = null; try { ingestSourceFile(db, newId); } catch (e) { ingest_error = e.message; }
    created.push({ ...db.prepare('SELECT * FROM source_files WHERE id = ?').get(newId), ingest_error });
  }
  res.json({ files: created });
});

router.delete('/:id/files/:fileId', (req, res) => {
  const dataset = ownDataset(req);
  const file = db.prepare('SELECT * FROM source_files WHERE id = ? AND dataset_id = ?').get(req.params.fileId, dataset.id);
  if (!file) return res.status(404).json({ error: 'File not found.' });
  db.prepare('DELETE FROM source_files WHERE id = ?').run(file.id);
  res.json({ success: true });
});

/**
 * Ensure every ingested file of `datasetId` has a CONFIRMED mapping (auto-suggest + auto-confirm with the classifier's own
 * suggestions when nothing has been reviewed yet, unless requireManualReview asks for a hard stop instead). Returns the
 * confirmed sources grouped by dataset_type, plus anything left out (a different dataset_type, or still unresolved).
 */
function ensureConfirmedMappings(datasetId, userId, requireManualReview) {
  const files = db.prepare(`SELECT * FROM source_files WHERE dataset_id = ? AND ingest_status = 'ingested'`).all(datasetId);
  const byType = new Map(); const blocked = [];
  for (const f of files) {
    let v = db.prepare('SELECT MAX(mapping_version) v FROM schema_mapping_sets WHERE source_file_id = ?').get(f.id).v;
    if (!v) { const s = svc.suggestMapping(db, f.id, { userId }); v = s.version; }
    let set = svc.getSet(db, f.id, v);
    if (!set.locked_at) {
      const model = svc.getReviewModel(db, f.id, v);
      const openCols = model.columns.filter(c => c.review_required && c.status === 'suggested').length;
      const openType = !!set.dataset_type_needs_review;
      // An UNCERTAIN dataset type (mixed_unknown, needs_review, or below the configured decision threshold -- all three are
      // exactly what dataset_type_needs_review already means) can NEVER be silently auto-confirmed, for ANY caller, with or
      // without require_manual_review. It decides which S5 matchers even run, so it is never treated as a low-risk suggestion.
      if (openType) {
        blocked.push({ source_file_id: f.id, original_filename: f.original_filename, mapping_version: v, reason: 'dataset_type_uncertain',
          dataset_type: model.dataset_type, unresolved_columns: openCols,
          required_action: `Confirm or override the dataset type via PATCH /api/schema/sources/${f.id}/versions/${v}/dataset-type, then retry.` });
        continue;
      }
      if (requireManualReview && openCols) {
        blocked.push({ source_file_id: f.id, original_filename: f.original_filename, mapping_version: v, reason: 'columns_uncertain',
          dataset_type: model.dataset_type, unresolved_columns: openCols,
          required_action: `Review the ${openCols} flagged column(s) via PATCH /api/schema/sources/${f.id}/versions/${v}/columns/:fileColumnId, or confirm with accept_suggestions, then retry.` });
        continue;
      }
      // Column-level suggestions may still auto-accept for convenience (decision 3): the dataset type is NOT in question here
      // (it is either already confident, or was already explicitly confirmed/overridden by a human), so accepting the
      // classifier's own column suggestions cannot silently choose a wrong dataset type or a dangerous role.
      // Defence in depth: confirmMapping (the true source of truth, see schemaService.js) independently refuses an
      // uncertain dataset type regardless of this route's own check above; a refusal here is converted to the same
      // blocked-with-detail shape rather than leaking as a raw 500/generic error.
      try { svc.confirmMapping(db, f.id, v, { userId, acceptSuggestions: true }); }
      catch (e) {
        if (e.dataset_type_unresolved) { blocked.push({ source_file_id: f.id, original_filename: f.original_filename, mapping_version: v, reason: 'dataset_type_uncertain', dataset_type: e.dataset_type, unresolved_columns: openCols, required_action: e.required_action }); continue; }
        throw e;
      }
      set = svc.getSet(db, f.id, v);
    }
    const key = set.dataset_type;
    if (!byType.has(key)) byType.set(key, []);
    byType.get(key).push({ source_file_id: f.id, mapping_version: v, original_filename: f.original_filename });
  }
  return { byType, blocked };
}

// Kick off a v1 pipeline analysis run: confirmed mapping -> immutable configuration -> S4 rules -> S5 identity -> persisted findings.
// Blocks (409) if unresolved high-risk mappings remain and require_manual_review was requested; otherwise auto-confirms
// classifier suggestions, same as calling PATCH/confirm with accept_suggestions through the Schema Review API first.
router.post('/:id/analyze', analyzeLimiter, (req, res) => {
  const dataset = ownDataset(req);
  // Atomic check-and-claim: two near-concurrent analyze calls on the same dataset must never both proceed. The check
  // (is one already in progress?) and the claim (a real, minimal 'queued' run row) happen inside ONE IMMEDIATE
  // transaction, which SQLite serializes against any other writer -- the loser sees the row the winner just committed
  // and gets a real 409, never a second live run. Everything after this (building/reusing the configuration) fills in
  // the rest of this SAME run row; nothing here inserts a second one.
  const runId = uuid(); let inProgress;
  db.exec('BEGIN IMMEDIATE');
  try {
    inProgress = db.prepare(`SELECT * FROM analysis_runs WHERE dataset_id = ? AND status NOT IN ('complete', 'failed') ORDER BY started_at DESC LIMIT 1`).get(dataset.id);
    if (!inProgress) db.prepare(`INSERT INTO analysis_runs (id, dataset_id, status, progress_pct, current_stage, engine_version) VALUES (?,?,?,?,?,?)`).run(runId, dataset.id, 'queued', 0, 'Queued', PIPELINE_ENGINE_VERSION);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  if (inProgress) return res.status(409).json({ error: 'An analysis for this dataset is already in progress.', run_id: inProgress.id, status: inProgress.status });

  const { config_id, settings, require_manual_review, parent_run_id, rerun_reason } = req.body || {};
  // parent_run_id is a client-supplied reference to another run: verify it belongs to THIS dataset (and therefore the
  // caller's organization) before ever storing it, exactly like every other id accepted from the request body. Left
  // unvalidated, a caller could stamp a run with a fabricated lineage pointer to a run they cannot otherwise access.
  if (parent_run_id) {
    const parent = db.prepare(`SELECT id FROM analysis_runs WHERE id = ? AND dataset_id = ?`).get(parent_run_id, dataset.id);
    if (!parent) return res.status(400).json({ error: 'parent_run_id does not refer to a run of this dataset.' });
  }
  let tableType, configId, configHash, reused, excludedFiles = [];

  try {
    if (config_id) {
      const cfg = cs.getAnalysisConfig(db, config_id);
      if (cfg.dataset_id !== dataset.id) throw Object.assign(new Error('That configuration does not belong to this dataset.'), { status: 400 });
      configId = config_id; configHash = cfg.config_hash; tableType = cfg.table_type;
    } else {
      const { byType, blocked } = ensureConfirmedMappings(dataset.id, req.user.sub, !!require_manual_review);
      if (blocked.length) throw Object.assign(new Error('One or more files still need schema review before analysis can start.'), { status: 409, review_required: true, files: blocked });
      if (!byType.size) throw Object.assign(new Error('No files are ready for analysis. Upload a file (and select a sheet if prompted) first.'), { status: 400 });
      const [firstType, firstSources] = [...byType.entries()].sort((a, b) => b[1].length - a[1].length)[0];
      excludedFiles = [...byType.entries()].filter(([t]) => t !== firstType).flatMap(([, l]) => l.map(s => s.original_filename));
      const built = cs.createAnalysisConfig(db, { datasetId: dataset.id, sources: firstSources.map(s => ({ source_file_id: s.source_file_id, mapping_version: s.mapping_version })), settings, userId: req.user.sub,
        lineage: parent_run_id ? { parent_run_id, rerun_reason } : null });
      configId = built.config_id; configHash = built.config_hash; reused = built.reused; tableType = firstType;
    }
  } catch (e) {
    db.prepare(`DELETE FROM analysis_runs WHERE id = ?`).run(runId);   // release the claim: this attempt never became a real run
    return res.status(e.status || 500).json({ error: e.message, review_required: e.review_required, files: e.files });
  }

  const cfg = cs.getAnalysisConfig(db, configId); const snap = cfg.config.snapshot;
  const todayISO = new Date().toISOString().slice(0, 10);
  const ref = D.resolveReferenceDate(snap.settings, todayISO);

  const jobId = uuid();
  db.prepare(`UPDATE analysis_runs SET config_id = ?, config_hash = ?, table_type = ?, reference_date = ?, stale_threshold_years = ?, parent_run_id = ?, rerun_reason = ? WHERE id = ?`)
    .run(configId, configHash, tableType, ref.reference_date, snap.settings.stale_threshold_years, parent_run_id || null, rerun_reason || null, runId);
  db.prepare(`INSERT INTO jobs (id, run_id, job_type, status) VALUES (?,?,?,?)`).run(jobId, runId, 'analysis', 'queued');
  enqueueRun(runId, jobId);
  res.status(202).json({ run_id: runId, job_id: jobId, status: 'queued', config_id: configId, config_reused: reused, table_type: tableType, excluded_files: excludedFiles });
});

module.exports = router;
