'use strict';
/*
 * Canonicalization: physical sheet -> { columns, rows } without deciding any business semantics.
 *   raw_json        {header_key: value exactly as stored in the cell}   (Excel date cells: the serial number; text: the original text; blank: key omitted = NULL)
 *   canonical_json  {header_key: typed primitive} ONLY where it differs from raw and is safely determinable (dates -> "YYYY-MM-DD", times, datetimes)
 *   raw_meta_json   {header_key: {k: kind, ...}} ONLY for cells that need interpretation notes (dates, ambiguous/invalid dates, errors)
 * For every other cell (text, numbers, booleans) canonical == raw. Numeric-looking TEXT stays text. Business normalization is NOT done here (S3/S6).
 */
const crypto = require('crypto');
const { classifyCell, resolveDateProfile, DATE_MODEL_VERSION } = require('./dateModel');
const { detectHeaderRow, buildColumns } = require('./headers');
const { ColumnAcc } = require('./columnStats');

const INGEST_VERSION = 'canonical-ingest-2.0.0';
// INTERIM structural convention (superseded by S3's semantic role "row identifier"): a header that normalizes to one of these is kept separately as the
// dataset-supplied row id. Override per ingest with { rowIdentifier: {column: n} | {header: '...'} | false }.
const ROW_ID_CONVENTION = ['recordid', 'rowid'];
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const squash = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

function resolveRowIdentifier(columns, cfg, warnings) {
  if (cfg === false || cfg === null) return null;
  let matches;
  if (cfg && typeof cfg === 'object' && Number.isInteger(cfg.column)) matches = columns.filter(c => c.position === cfg.column);
  else if (cfg && typeof cfg === 'object' && cfg.header) matches = columns.filter(c => c.header_normalized === String(cfg.header).trim().toLowerCase());
  else matches = columns.filter(c => ROW_ID_CONVENTION.includes(squash(c.header_raw)));
  if (matches.length === 1) return { position: matches[0].position, header_key: matches[0].header_key, source: cfg === undefined ? 'convention' : 'explicit' };
  if (matches.length > 1) warnings.push(`row_identifier_ambiguous: ${matches.length} candidate columns; none used (pass { rowIdentifier: {column: n} })`);
  else if (cfg !== undefined) warnings.push('row_identifier_column_not_found');
  return null;
}

function canonicalize(src, opts = {}, sink = {}) {
  const profile = resolveDateProfile(opts.dateProfile);
  const warnings = [];
  if (src.lastRow < src.firstRow || src.lastCol < src.firstCol) throw new Error('The sheet is empty: no cells found.');

  let headerRow, headerSource, headerReason = null;
  if (opts.headerRow !== undefined && opts.headerRow !== null) {
    if (!Number.isInteger(opts.headerRow) || opts.headerRow < src.firstRow || opts.headerRow > src.lastRow) throw new Error(`headerRow ${opts.headerRow} is outside the sheet (rows ${src.firstRow}-${src.lastRow}).`);
    headerRow = opts.headerRow; headerSource = 'explicit';
  } else { const d = detectHeaderRow(src); headerRow = d.row; headerSource = d.source; headerReason = d.reason || null; }
  if (headerRow > src.firstRow) warnings.push(`header_row_is_${headerRow}: ${headerRow - src.firstRow} row(s) above the header kept as preamble`);
  if (headerSource === 'default') warnings.push(`header_row_defaulted (${headerReason}): confirm the header row`);

  const columns = buildColumns(src, headerRow);
  const blankHeaders = columns.filter(c => c.is_blank_header).length; if (blankHeaders) warnings.push(`blank_headers: ${blankHeaders} column(s) have no header`);
  const dupGroups = new Set(columns.filter(c => c.is_duplicate_header).map(c => c.header_normalized)).size; if (dupGroups) warnings.push(`duplicate_headers: ${dupGroups} header(s) occur more than once; all physical columns kept`);

  const preamble = [];
  for (let r = src.firstRow; r < headerRow && preamble.length < 20; r++) {
    const cells = []; for (let c = src.firstCol; c <= src.lastCol && cells.length < 10; c++) { const x = src.cellAt(r, c); if (x && x.v !== undefined && x.v !== null && String(x.v).trim() !== '') cells.push({ col: columns[c - src.firstCol].letter, text: String(x.t === 's' ? x.v : (x.w !== undefined ? x.w : x.v)) }); }
    if (cells.length) preamble.push({ sheet_row: r, cells });
  }
  const rowId = resolveRowIdentifier(columns, opts.rowIdentifier, warnings);
  if (sink.header) sink.header({ headerRow, headerSource, headerReason, columns, preamble, rowIdentifier: rowId, dateProfile: profile, sheetName: src.sheetName, date1904: src.date1904 });

  const accs = columns.map(() => new ColumnAcc()), ctx = { date1904: src.date1904, profile, formatCache: new Map() };
  const n = columns.length; const cls = new Array(n), cells = new Array(n);
  let dataRows = 0, blankRows = 0;
  for (let r = headerRow + 1; r <= src.lastRow; r++) {
    let any = false;
    for (let i = 0; i < n; i++) { const cell = src.cellAt(r, columns[i].position); const c = classifyCell(cell, ctx); cls[i] = c; cells[i] = cell; if (c.type !== 'blank' && !c.whitespaceOnly) any = true; }
    if (!any) { blankRows++; continue; }
    dataRows++;
    const raw = {}, canonical = {}, meta = {}, hashParts = []; let nc = 0, nm = 0;
    for (let i = 0; i < n; i++) {
      const c = cls[i]; accs[i].add(c, cells[i]);
      if (c.type === 'blank') continue;
      const key = columns[i].header_key; raw[key] = c.raw; hashParts.push(columns[i].position, c.raw);
      if (c.canonical !== undefined) { canonical[key] = c.canonical; nc++; }
      if (c.meta) { meta[key] = c.meta; nm++; }
    }
    if (sink.row) sink.row({ sheetRow: r, rowNumber: r - headerRow, sheetName: src.sheetName, rowIdentifier: rowId && raw[rowId.header_key] !== undefined ? String(raw[rowId.header_key]) : null,
      rawJson: JSON.stringify(raw), canonicalJson: nc ? JSON.stringify(canonical) : null, metaJson: nm ? JSON.stringify(meta) : null, rawHash: sha256(JSON.stringify(hashParts)) });
  }
  columns.forEach((col, i) => {
    const f = accs[i].finalize(dataRows); const p = JSON.parse(f.profile_json);
    p.is_blank_header = col.is_blank_header; if (col.is_duplicate_header) p.duplicate_group_size = col.duplicate_group_size; f.profile_json = JSON.stringify(p);
    Object.assign(col, f);
  });
  const ambiguous = columns.filter(c => JSON.parse(c.profile_json).date_review_required).map(c => c.header_key);
  if (ambiguous.length) warnings.push(`date_review_required: ambiguous / unconfigured / invalid text dates in ${ambiguous.length} column(s): ${ambiguous.slice(0, 5).join(', ')}${ambiguous.length > 5 ? ', ...' : ''}`);
  return { columns, headerRow, headerSource, headerReason, preamble, rowIdentifier: rowId, dataRows, blankRows, physicalRows: src.lastRow - src.firstRow + 1, sheetName: src.sheetName, sheetIndex: src.sheetIndex,
    date1904: src.date1904, dateProfile: profile, fileType: src.fileType, warnings };
}

/** In-memory convenience for QA/analysis code that needs the canonical rows without a database. */
function readCanonical(src, opts = {}) {
  const rows = []; const res = canonicalize(src, opts, { row: r => rows.push({ ...r, raw: JSON.parse(r.rawJson), canonical: r.canonicalJson ? JSON.parse(r.canonicalJson) : {}, meta: r.metaJson ? JSON.parse(r.metaJson) : {} }) });
  return { ...res, rows };
}
/** The canonical value of one cell: the typed canonical primitive if there is one, otherwise the raw value (NULL/undefined = blank). */
const canonicalValue = (rawObj, canonicalObj, key) => (canonicalObj && canonicalObj[key] !== undefined ? canonicalObj[key] : (rawObj[key] === undefined ? null : rawObj[key]));

module.exports = { canonicalize, readCanonical, canonicalValue, INGEST_VERSION, DATE_MODEL_VERSION, ROW_ID_CONVENTION, sha256 };
