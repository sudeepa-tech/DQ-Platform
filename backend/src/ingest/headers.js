'use strict';
/*
 * Header-row detection and PHYSICAL column identity. Never collapses columns because their headers look alike.
 * Provenance kept per physical column: original header (exactly as in the file), normalized header (whitespace/case only),
 * physical position, Excel column letter, sheet. `header_key` is only a unique addressing key derived from those - it is NOT the header:
 * columns whose normalized header repeats all get "<header> [<column letter>]", so every key traces back to its physical column.
 */
const { colLetter } = require('./reader');

const normalizeHeader = s => String(s).normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
const cellText = c => (c === null || c.v === undefined || c.v === null ? '' : (c.t === 's' ? String(c.v) : String(c.w !== undefined ? c.w : c.v)));
const isBlankCell = c => c === null || c.v === undefined || c.v === null || (c.t === 's' && String(c.v).trim() === '');

/** Detect the header row among the first rows: the first row that is "as wide as the sheet's real width" and made of text. Structural only. */
function detectHeaderRow(src, scanRows = 40) {
  const rows = []; let maxFilled = 0;
  for (let r = src.firstRow; r <= Math.min(src.lastRow, src.firstRow + scanRows - 1); r++) {
    let filled = 0, text = 0;
    for (let c = src.firstCol; c <= src.lastCol; c++) { const x = src.cellAt(r, c); if (isBlankCell(x)) continue; filled++; if (x.t === 's' && !/^[\d.,\s%-]+$/.test(String(x.v))) text++; }
    rows.push({ r, filled, text }); if (filled > maxFilled) maxFilled = filled;
  }
  const firstNonBlank = rows.find(x => x.filled > 0);
  if (!firstNonBlank) return { row: src.firstRow, source: 'default', reason: 'no_non_blank_rows_in_first_' + scanRows };
  const need = Math.max(2, Math.ceil(0.5 * maxFilled));
  const cand = rows.find(x => x.filled >= need && x.text / x.filled >= 0.8);
  if (cand) return { row: cand.r, source: 'auto' };
  return { row: firstNonBlank.r, source: 'default', reason: 'no_row_looked_like_a_header' };
}

function buildColumns(src, headerRow) {
  const cols = []; const used = new Set();
  for (let c = src.firstCol; c <= src.lastCol; c++) {
    const x = src.cellAt(headerRow, c); const raw = x === null ? '' : cellText(x);
    cols.push({ position: c, letter: colLetter(c), header_raw: raw, header_normalized: normalizeHeader(raw), is_blank_header: raw.trim() === '' });
  }
  const groups = new Map();
  for (const col of cols) if (!col.is_blank_header) { if (!groups.has(col.header_normalized)) groups.set(col.header_normalized, []); groups.get(col.header_normalized).push(col); }
  for (const g of groups.values()) g.forEach((col, i) => { col.is_duplicate_header = g.length > 1; col.duplicate_ordinal = g.length > 1 ? i + 1 : null; col.duplicate_group_size = g.length; });
  for (const col of cols) {
    if (col.is_duplicate_header === undefined) { col.is_duplicate_header = false; col.duplicate_ordinal = null; col.duplicate_group_size = 1; }
    const base = col.header_raw.replace(/\s+/g, ' ').trim();
    let key = col.is_blank_header ? `Column [${col.letter}]` : (col.is_duplicate_header ? `${base} [${col.letter}]` : base);
    for (let n = 2; used.has(key); n++) key = `${base || 'Column'} [${col.letter}] #${n}`;   // a genuine header that already looks like a generated key
    used.add(key); col.header_key = key;
  }
  return cols;
}
module.exports = { detectHeaderRow, buildColumns, normalizeHeader, isBlankCell, cellText };
