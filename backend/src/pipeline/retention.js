'use strict';
/*
 * File retention / purge (S8): the ORIGINAL uploaded bytes are needed only for canonical ingest (S2); once a file is
 * ingested, every downstream stage (rules, identity, scoring, exports, re-run) reads exclusively from the canonical,
 * persisted tables (source_rows / records / ...), never the physical file again. This makes it SAFE to purge the
 * original bytes independently of run history: no active run, no historical run, and no re-run ever re-reads the
 * physical file. What is never deleted: the source_files ROW itself (original filename, content hash, sheet name,
 * timestamps) -- source lineage metadata is permanent; only the bytes on disk are removed.
 *
 * A physical path can be shared by several source_files rows (one workbook, several sheets each imported separately),
 * so a path is purged only once EVERY row that shares it has finished ingestion (or failed) -- never while a sibling
 * sheet is still awaiting selection, which would need to re-read the same bytes.
 */
const fs = require('fs');

function purgeEligibleFiles(db, { retentionDays, now, organizationId } = {}) {
  const days = retentionDays == null ? Number(process.env.FILE_RETENTION_DAYS || 90) : retentionDays;
  const cutoff = new Date((now ? new Date(now) : new Date()).getTime() - days * 86400000).toISOString();
  // organizationId scopes the actual deletion, not just the reported result: a per-organization admin trigger (the
  // manual endpoint) must never delete another organization's files as a side effect of its own request, even if the
  // response were filtered afterward -- the automatic system-wide sweep (server.js) calls this with no scope, which is
  // the one place a global pass is appropriate.
  const orgFilter = organizationId ? `AND dataset_id IN (SELECT id FROM datasets WHERE organization_id = ?)` : '';
  const candidates = db.prepare(`
    SELECT DISTINCT stored_path FROM source_files
    WHERE purged_at IS NULL AND stored_path IS NOT NULL AND uploaded_at < ? ${orgFilter}
      AND stored_path NOT IN (SELECT stored_path FROM source_files WHERE ingest_status NOT IN ('ingested', 'failed') OR ingest_status IS NULL)
  `).all(...(organizationId ? [cutoff, organizationId] : [cutoff]));
  let purged = 0, errors = 0; const details = [];
  const markPurged = db.prepare(`UPDATE source_files SET purged_at = datetime('now') WHERE stored_path = ? AND purged_at IS NULL`);
  for (const { stored_path } of candidates) {
    try { if (fs.existsSync(stored_path)) fs.unlinkSync(stored_path); markPurged.run(stored_path); purged++; details.push({ stored_path, status: 'purged' }); }
    catch (e) { errors++; details.push({ stored_path, status: 'error', error: e.message }); }
  }
  return { checked: candidates.length, purged, errors, retention_days: days, cutoff, details };
}

/** A file's retention status, for display: purged | eligible_now | retained_until (an ISO date). Never affects whether
 *  the file's data is usable -- canonical rows and every run remain fully functional regardless of purge status. */
function fileRetentionStatus(row, { retentionDays } = {}) {
  const days = retentionDays == null ? Number(process.env.FILE_RETENTION_DAYS || 90) : retentionDays;
  if (row.purged_at) return { status: 'purged', purged_at: row.purged_at };
  if (!['ingested', 'failed'].includes(row.ingest_status)) return { status: 'active', reason: 'not yet ingested' };
  const retainUntil = new Date(new Date(row.uploaded_at).getTime() + days * 86400000);
  return retainUntil <= new Date() ? { status: 'eligible_for_purge' } : { status: 'retained', retained_until: retainUntil.toISOString() };
}
module.exports = { purgeEligibleFiles, fileRetentionStatus };
