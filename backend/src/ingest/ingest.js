'use strict';
/*
 * Canonical ingest service: file -> source_files / file_columns / source_rows (S1 tables + S2 additions), atomically.
 *
 * IDENTITY / RE-INGESTION
 *   A source is identified by (dataset, content sha256, sheet, ingest fingerprint). The fingerprint covers everything that changes the canonical
 *   output: ingest version, date-model version, header-row setting, date-format profile, row-identifier setting, csv delimiter.
 *   Re-ingesting the same content under the same fingerprint returns the existing source (no new rows). Changed content, another sheet, another
 *   dataset or a different profile is a different source. Source rows are immutable, so old runs keep the exact rows they analysed.
 *   ONE SOURCE -> MANY ANALYSIS RUNS: runs point at a source through run_inputs; analysing again never re-ingests.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { openSource, listSheets, fileTypeOf } = require('./reader');
const { canonicalize, INGEST_VERSION, DATE_MODEL_VERSION, sha256 } = require('./canonicalize');
const { resolveDateProfile } = require('./dateModel');

function fileSha256(filePath) {
  const h = crypto.createHash('sha256'), fd = fs.openSync(filePath, 'r'), buf = Buffer.allocUnsafe(1 << 20);
  try { for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, n)); } finally { fs.closeSync(fd); }
  return h.digest('hex');
}
function ingestConfig(opts) {
  const ri = opts.rowIdentifier === undefined ? 'convention' : (opts.rowIdentifier === false || opts.rowIdentifier === null) ? 'none' : opts.rowIdentifier;
  return { ingest_version: INGEST_VERSION, date_model_version: DATE_MODEL_VERSION, header_row: opts.headerRow || 'auto', date_profile: resolveDateProfile(opts.dateProfile), row_identifier: ri, csv_delimiter: opts.delimiter || 'auto' };
}
const fingerprintOf = cfg => sha256(JSON.stringify(cfg));

function findIdentity(db, datasetId, contentSha, sheetName, fingerprint) {
  return db.prepare(`SELECT id FROM source_files WHERE dataset_id=? AND content_sha256=? AND COALESCE(sheet_name,'')=? AND ingest_fingerprint=? AND ingest_status='ingested'`).get(datasetId, contentSha, sheetName || '', fingerprint);
}
const summarize = (db, id, reused) => {
  const f = db.prepare('SELECT id, sheet_name, header_row, header_row_source, data_row_count, blank_row_count, physical_row_count, column_count, has_duplicate_headers, content_sha256, ingest_version FROM source_files WHERE id=?').get(id);
  const empty = db.prepare('SELECT COUNT(*) c FROM file_columns WHERE source_file_id=? AND is_empty=1').get(id).c;
  return { sourceFileId: id, reused, sheetName: f.sheet_name, headerRow: f.header_row, headerRowSource: f.header_row_source, dataRows: f.data_row_count, blankRowsSkipped: f.blank_row_count, columns: f.column_count,
    emptyColumns: empty, hasDuplicateHeaders: !!f.has_duplicate_headers, contentSha256: f.content_sha256, ingestVersion: f.ingest_version };
};

/** shared engine: canonicalize `filePath` into the (already existing) source_files row `sfId`, inside the caller's transaction */
function populate(db, sfId, filePath, sheetName, fileType, opts) {
  const src = openSource(filePath, { fileType, sheetName, delimiter: opts.delimiter });
  const insRow = db.prepare(`INSERT INTO source_rows (id, source_file_id, row_number, sheet_row, source_sheet, row_identifier, raw_json, raw_meta_json, canonical_json, raw_hash, ingest_version) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const res = canonicalize(src, opts, {
    header: h => db.prepare('UPDATE source_files SET header_row=? WHERE id=?').run(h.headerRow, sfId),
    row: r => insRow.run(crypto.randomUUID(), sfId, r.rowNumber, r.sheetRow, r.sheetName, r.rowIdentifier, r.rawJson, r.metaJson, r.canonicalJson, r.rawHash, INGEST_VERSION)
  });
  const insCol = db.prepare(`INSERT INTO file_columns (id, source_file_id, column_index, header_raw, header_key, is_duplicate_header, populated_count, populated_ratio, distinct_count, is_empty,
    cell_kinds_json, value_shapes_json, profile_json, header_normalized, column_letter, source_sheet, duplicate_ordinal) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const c of res.columns) insCol.run(crypto.randomUUID(), sfId, c.position, c.header_raw, c.header_key, c.is_duplicate_header ? 1 : 0, c.populated_count, c.populated_ratio, c.distinct_count, c.is_empty,
    c.cell_kinds_json, c.value_shapes_json, c.profile_json, c.header_normalized, c.letter, res.sheetName, c.duplicate_ordinal);
  db.prepare(`UPDATE source_files SET sheet_name=?, header_row=?, header_row_source=?, preamble_json=?, physical_row_count=?, data_row_count=?, blank_row_count=?, date1904=?, sheet_index=?,
    has_duplicate_headers=?, row_count=?, column_count=?, ingested_at=datetime('now'), ingest_status='ingested', ingest_error=NULL, status='parsed', ingest_warnings_json=? WHERE id=?`)
    .run(res.sheetName, res.headerRow, res.headerSource, res.preamble.length ? JSON.stringify(res.preamble) : null, res.physicalRows, res.dataRows, res.blankRows, res.date1904 ? 1 : 0, res.sheetIndex,
      res.columns.some(c => c.is_duplicate_header) ? 1 : 0, res.dataRows, res.columns.length, res.warnings.length ? JSON.stringify(res.warnings) : null, sfId);
  return res;
}
function inTxn(db, fn) { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { try { db.exec('ROLLBACK'); } catch (_) { /* nothing open */ } throw e; } }

/** Ingest a file into a dataset. Creates the source_files row, or returns the existing identical source. */
function ingestFile(db, { datasetId, filePath, originalFilename, fileType, sheetName, ...opts }) {
  if (!datasetId) throw new Error('datasetId is required');
  const stat = fs.statSync(filePath); if (stat.size === 0) throw new Error('File is empty.');
  const ft = fileTypeOf(filePath, fileType), cfg = ingestConfig(opts), fp = fingerprintOf(cfg), sha = fileSha256(filePath);
  let sheet = null;
  if (ft !== 'csv') { const names = listSheets(filePath); sheet = sheetName || names[0]; if (!names.includes(sheet)) throw new Error(`Sheet "${sheet}" not found in workbook. Available: ${names.join(', ')}`); }
  const existing = findIdentity(db, datasetId, sha, sheet, fp);
  if (existing) return { ...summarize(db, existing.id, true), warnings: [] };
  const id = crypto.randomUUID();
  const res = inTxn(db, () => {
    db.prepare(`INSERT INTO source_files (id, dataset_id, original_filename, stored_path, file_size_bytes, file_type, sheet_name, status, content_sha256, ingest_version, ingest_fingerprint, ingest_config_json, ingest_status)
      VALUES (?,?,?,?,?,?,?,'uploaded',?,?,?,?,'not_ingested')`).run(id, datasetId, originalFilename || path.basename(filePath), path.resolve(filePath), stat.size, ft, sheet, sha, INGEST_VERSION, fp, JSON.stringify(cfg));
    return populate(db, id, filePath, sheet, ft, opts);
  });
  return { ...summarize(db, id, false), warnings: res.warnings };
}

/** Ingest an EXISTING source_files row (e.g. one the upload route created). If an identical source is already ingested, nothing is written and that source is returned. */
function ingestSourceFile(db, sourceFileId, opts = {}) {
  const f = db.prepare('SELECT * FROM source_files WHERE id=?').get(sourceFileId); if (!f) throw new Error(`source file ${sourceFileId} not found`);
  const markFailed = e => { if (f.ingest_status !== 'ingested') db.prepare(`UPDATE source_files SET ingest_status='failed', ingest_error=? WHERE id=?`).run(String(e.message).slice(0, 500), f.id); };
  try {
    const cfg = ingestConfig(opts), fp = fingerprintOf(cfg), sha = fileSha256(f.stored_path), ft = fileTypeOf(f.stored_path, f.file_type);
    let sheet = null; if (ft !== 'csv') { const names = listSheets(f.stored_path); sheet = opts.sheetName || f.sheet_name || names[0]; if (!names.includes(sheet)) throw new Error(`Sheet "${sheet}" not found in workbook. Available: ${names.join(', ')}`); }
    if (f.ingest_status === 'ingested') {
      if (f.content_sha256 === sha && f.ingest_fingerprint === fp && (f.sheet_name || null) === sheet) return { ...summarize(db, f.id, true), warnings: [] };
      throw new Error('This source file is already ingested with different content or settings; ingest the file as a new source instead (source rows are immutable).');
    }
    const dup = findIdentity(db, f.dataset_id, sha, sheet, fp);
    if (dup) return { ...summarize(db, dup.id, true), duplicateOf: dup.id, requestedSourceFileId: f.id, warnings: [] };
    const res = inTxn(db, () => {
      db.prepare('UPDATE source_files SET content_sha256=?, ingest_version=?, ingest_fingerprint=?, ingest_config_json=?, sheet_name=? WHERE id=?').run(sha, INGEST_VERSION, fp, JSON.stringify(cfg), sheet, f.id);
      return populate(db, f.id, f.stored_path, sheet, ft, opts);
    });
    return { ...summarize(db, f.id, false), warnings: res.warnings };
  } catch (e) { markFailed(e); throw e; }
}
module.exports = { ingestFile, ingestSourceFile, fileSha256, ingestConfig, fingerprintOf, INGEST_VERSION };
