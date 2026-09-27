'use strict';
const XLSX = require('xlsx');
const { parse } = require('csv-parse/sync');
const fs = require('fs');

/** List sheet names in an XLSX file without fully parsing (for sheet-selection UI). */
function listXlsxSheets(filePath) {
  const wb = XLSX.readFile(filePath, { bookSheets: true });
  return wb.SheetNames;
}

/** Parse one sheet of an XLSX file into { headers, rows }. */
function parseXlsxSheet(filePath, sheetName) {
  const wb = XLSX.readFile(filePath, { cellDates: true });
  const name = sheetName || wb.SheetNames[0];
  if (!wb.SheetNames.includes(name)) {
    throw new Error(`Sheet "${name}" not found in workbook. Available: ${wb.SheetNames.join(', ')}`);
  }
  const ws = wb.Sheets[name];
  const json = XLSX.utils.sheet_to_json(ws, { defval: null, raw: true, dateNF: 'yyyy-mm-dd' });
  if (json.length === 0) return { headers: [], rows: [] };
  // Preserve header order using sheet_to_json with header:1 for header row
  const headerRow = XLSX.utils.sheet_to_json(ws, { header: 1, range: 0 })[0] || [];
  const headers = headerRow.map((h, i) => (h === null || h === undefined || String(h).trim() === '') ? `Column_${i + 1}` : String(h).trim());
  const rows = json.map(row => {
    const normalized = {};
    headers.forEach(h => {
      let v = row[h];
      if (v instanceof Date) v = v.toISOString().slice(0, 10);
      normalized[h] = v === undefined ? null : v;
    });
    return normalized;
  });
  return { headers, rows };
}

/** Parse a CSV file into { headers, rows }. */
function parseCsv(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const records = parse(content, {
    columns: header => header.map((h, i) => (h === undefined || h === null || String(h).trim() === '') ? `Column_${i + 1}` : String(h).trim()),
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
    bom: true
  });
  if (records.length === 0) return { headers: [], rows: [] };
  const headers = Object.keys(records[0]);
  return { headers, rows: records };
}

function validateFile(filePath, originalName, maxSizeBytes) {
  const stat = fs.statSync(filePath);
  if (stat.size === 0) throw new Error('File is empty.');
  if (stat.size > maxSizeBytes) throw new Error(`File exceeds maximum allowed size of ${(maxSizeBytes / (1024 * 1024)).toFixed(0)}MB.`);
  const ext = originalName.split('.').pop().toLowerCase();
  if (!['xlsx', 'xls', 'csv'].includes(ext)) throw new Error(`Unsupported file type ".${ext}". Supported: .xlsx, .csv`);
  return { size: stat.size, ext: ext === 'xls' ? 'xlsx' : ext };
}

module.exports = { listXlsxSheets, parseXlsxSheet, parseCsv, validateFile };
