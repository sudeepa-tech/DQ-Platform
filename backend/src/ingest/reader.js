'use strict';
/*
 * Source readers. Both return the same abstraction so everything downstream is format-agnostic:
 *   { fileType, sheetName, sheetNames, sheetIndex, date1904, firstRow, lastRow, firstCol, lastCol, cellAt(row1, col0) -> {t,v,z?,w?} | null }
 * Rows are PHYSICAL 1-based sheet rows; columns are PHYSICAL 0-based positions (A = 0). xlsx is read with cellDates:false so no JS Date
 * is ever created: Excel dates arrive as numbers plus their number-format string (cell.z) and are converted by dateModel.js.
 */
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { parse: parseCsv } = require('csv-parse/sync');

function colLetter(i) { let s = ''; let n = i + 1; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; }
const fileTypeOf = (filePath, hint) => hint || (/\.csv$/i.test(filePath) ? 'csv' : 'xlsx');

/* SheetJS will happily parse ANY bytes as text and return junk "rows". Refuse anything that is not recognizably a workbook. */
function assertLooksLikeWorkbook(filePath) {
  const fd = fs.openSync(filePath, 'r'); const b = Buffer.alloc(512); let n; try { n = fs.readSync(fd, b, 0, 512, 0); } finally { fs.closeSync(fd); }
  const zip = n >= 4 && b[0] === 0x50 && b[1] === 0x4B && (b[2] === 0x03 || b[2] === 0x05) && (b[3] === 0x04 || b[3] === 0x06);               // .xlsx / .xlsm / .xlsb (zip container)
  const ole = n >= 8 && b.subarray(0, 8).equals(Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]));                              // legacy .xls (OLE2)
  const markup = /^\s*(?:\xEF\xBB\xBF)?<(?:\?xml|html|!doctype|table|workbook|ss:)/i.test(b.toString('latin1', 0, n));                              // SpreadsheetML / HTML tables some ERP exports save as .xls
  if (!zip && !ole && !markup) throw new Error('The file is not a valid Excel workbook (unrecognized file signature). It may be corrupt or have the wrong extension.');
}
function listSheets(filePath) { assertLooksLikeWorkbook(filePath); return XLSX.readFile(filePath, { bookSheets: true }).SheetNames; }

function openXlsx(filePath, sheetName) {
  assertLooksLikeWorkbook(filePath);
  const names = XLSX.readFile(filePath, { bookSheets: true }).SheetNames;
  const name = sheetName || names[0];
  if (!names.includes(name)) throw new Error(`Sheet "${name}" not found in workbook. Available: ${names.join(', ')}`);
  const wb = XLSX.readFile(filePath, { cellNF: true, cellDates: false, cellStyles: false, cellFormula: false, sheets: [name] });
  const ws = wb.Sheets[name];
  const date1904 = !!(wb.Workbook && wb.Workbook.WBProps && (wb.Workbook.WBProps.date1904 === true || wb.Workbook.WBProps.date1904 === '1' || wb.Workbook.WBProps.date1904 === 1));
  if (!ws || !ws['!ref']) return { fileType: 'xlsx', sheetName: name, sheetNames: names, sheetIndex: names.indexOf(name), date1904, firstRow: 1, lastRow: 0, firstCol: 0, lastCol: -1, cellAt: () => null, merges: 0 };
  const R = XLSX.utils.decode_range(ws['!ref']);
  const letters = []; for (let c = 0; c <= R.e.c; c++) letters.push(colLetter(c));
  return { fileType: 'xlsx', sheetName: name, sheetNames: names, sheetIndex: names.indexOf(name), date1904, merges: (ws['!merges'] || []).length,
    firstRow: R.s.r + 1, lastRow: R.e.r + 1, firstCol: R.s.c, lastCol: R.e.c,
    cellAt(row1, col0) { const x = ws[letters[col0] + row1]; return x === undefined ? null : { t: x.t, v: x.v, z: x.z, w: x.w }; } };
}

function detectDelimiter(text) {
  const firstLine = text.split(/\r\n|\n|\r/, 1)[0] || '';
  let best = ',', bestN = -1;
  for (const d of [',', ';', '\t', '|']) { let n = 0, q = false; for (const ch of firstLine) { if (ch === '"') q = !q; else if (ch === d && !q) n++; } if (n > bestN) { best = d; bestN = n; } }
  return best;
}
function openCsv(filePath, { delimiter } = {}) {
  const text = fs.readFileSync(filePath, 'utf8');
  const delim = delimiter || detectDelimiter(text);
  const rows = parseCsv(text, { columns: false, delimiter: delim, bom: true, relax_column_count: true, skip_empty_lines: false, trim: false });
  let width = 0; for (const r of rows) if (r.length > width) width = r.length;
  return { fileType: 'csv', sheetName: null, sheetNames: [], sheetIndex: 0, date1904: false, delimiter: delim, merges: 0,
    firstRow: 1, lastRow: rows.length, firstCol: 0, lastCol: width - 1,
    cellAt(row1, col0) { const r = rows[row1 - 1]; if (!r || col0 >= r.length) return null; return { t: 's', v: r[col0] }; } };
}
function openSource(filePath, { fileType, sheetName, delimiter } = {}) {
  const ft = fileTypeOf(filePath, fileType);
  return ft === 'csv' ? openCsv(filePath, { delimiter }) : openXlsx(filePath, sheetName);
}
function validateUploadedFile(filePath, originalName, maxSizeBytes) {
  const stat = fs.statSync(filePath);
  if (stat.size === 0) throw new Error('File is empty.');
  if (stat.size > maxSizeBytes) throw new Error(`File exceeds maximum allowed size of ${(maxSizeBytes / (1024 * 1024)).toFixed(0)}MB.`);
  const ext = originalName.split('.').pop().toLowerCase();
  if (!['xlsx', 'xls', 'csv'].includes(ext)) throw new Error(`Unsupported file type ".${ext}". Supported: .xlsx, .csv`);
  return { size: stat.size, ext: ext === 'xls' ? 'xlsx' : ext };
}
module.exports = { openSource, listSheets, colLetter, fileTypeOf, validateUploadedFile };
