'use strict';
/*
 * Computed (never stored, so it can never drift) dataset-level orchestration status, from the existing S1-S3 tables:
 *   uploaded -> ingesting -> review_required -> configured -> queued -> running -> completed -> failed
 * "review_required" covers BOTH an unconfirmed mapping and unresolved suggestions within a confirmed-looking draft;
 * a dataset with no files at all is 'uploaded' (waiting for its first file).
 */
const db = require('../db');

function fileStatus(sf) {
  if (sf.status === 'awaiting_sheet_selection') return { status: 'uploaded', reason: 'Select a sheet to ingest.' };
  if (sf.ingest_status === 'failed') return { status: 'failed', reason: sf.ingest_error || 'Ingest failed.' };
  if (sf.ingest_status !== 'ingested') return { status: 'ingesting', reason: null };
  const latestV = db.prepare('SELECT MAX(mapping_version) v FROM schema_mapping_sets WHERE source_file_id = ?').get(sf.id).v;
  if (!latestV) return { status: 'review_required', reason: 'No schema mapping has been suggested yet.' };
  const set = db.prepare('SELECT * FROM schema_mapping_sets WHERE source_file_id = ? AND mapping_version = ?').get(sf.id, latestV);
  if (!set.locked_at) {
    const open = db.prepare(`SELECT COUNT(*) c FROM schema_mappings WHERE source_file_id = ? AND mapping_version = ? AND review_required = 1 AND status = 'suggested'`).get(sf.id, latestV).c;
    return { status: 'review_required', reason: `${open} column(s)${set.dataset_type_needs_review ? ' and the dataset type' : ''} need review before this file can be confirmed.`, mapping_version: latestV, unresolved_columns: open, dataset_type_needs_review: !!set.dataset_type_needs_review };
  }
  return { status: 'configured', reason: null, mapping_version: latestV };
}

/** The dataset's overall status is the LEAST-ready of its files' statuses, or a run's own status once one has started. */
function datasetStatus(datasetId) {
  const files = db.prepare('SELECT * FROM source_files WHERE dataset_id = ? ORDER BY uploaded_at').all(datasetId);
  const latestRun = db.prepare(`SELECT * FROM analysis_runs WHERE dataset_id = ? ORDER BY started_at DESC LIMIT 1`).get(datasetId);
  if (latestRun && !['complete', 'failed'].includes(latestRun.status)) return { status: latestRun.status === 'queued' ? 'queued' : 'running', run_id: latestRun.id, files: files.map(f => ({ id: f.id, ...fileStatus(f) })) };
  if (!files.length) return { status: 'uploaded', files: [] };
  const perFile = files.map(f => ({ id: f.id, original_filename: f.original_filename, ...fileStatus(f) }));
  // "worst" = least-ready = LOWEST index in `order` (failed is worst, configured is best). Start from the best
  // possible status and only move down when a file's status is less ready than what we've seen so far.
  const order = ['failed', 'uploaded', 'ingesting', 'review_required', 'configured'];
  const worst = perFile.reduce((w, f) => (order.indexOf(f.status) < order.indexOf(w) ? f.status : w), 'configured');
  if (worst === 'configured' && latestRun) return { status: latestRun.status === 'complete' ? 'completed' : 'failed', run_id: latestRun.id, files: perFile };
  return { status: worst, files: perFile, can_run: worst === 'configured' };
}
module.exports = { datasetStatus };
