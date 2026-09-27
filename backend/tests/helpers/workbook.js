'use strict';
/* Builds real .xlsx files with exact cell types and number formats, so tests exercise the same reader path as production. */
const XLSX = require('xlsx');
const { colLetter } = require('../../src/ingest/reader');

/** rows: array of arrays. cell forms: null (no cell) | string | number | boolean | { v, z } (number with format) | { e: code } (error cell) | { s: text } (forces a text cell) */
function writeWorkbook(file, sheets, { date1904 = false } = {}) {
  const wb = XLSX.utils.book_new();
  if (date1904) wb.Workbook = { WBProps: { date1904: true } };
  const list = Array.isArray(sheets) ? { Data: sheets } : sheets;
  for (const [name, rows] of Object.entries(list)) {
    const ws = {}; let maxC = 0;
    rows.forEach((row, r) => row.forEach((cell, c) => {
      if (cell === null || cell === undefined) return;
      const addr = colLetter(c) + (r + 1); maxC = Math.max(maxC, c);
      if (typeof cell === 'string') ws[addr] = { t: 's', v: cell };
      else if (typeof cell === 'number') ws[addr] = { t: 'n', v: cell };
      else if (typeof cell === 'boolean') ws[addr] = { t: 'b', v: cell };
      else if (cell.e !== undefined) ws[addr] = { t: 'e', v: cell.e, w: '#ERR' };
      else if (cell.s !== undefined) ws[addr] = { t: 's', v: cell.s };
      else ws[addr] = { t: 'n', v: cell.v, z: cell.z };
    }));
    ws['!ref'] = rows.length ? `A1:${colLetter(maxC)}${rows.length}` : undefined;
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  XLSX.writeFile(wb, file, { cellStyles: true, bookType: 'xlsx' });
  return file;
}
module.exports = { writeWorkbook };
