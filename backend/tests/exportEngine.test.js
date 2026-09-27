'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate storage BEFORE the module under test is imported: it opens the database at import time. (S1: this file used to
// import it with no isolation, which opened the developer's real application database.)
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dq-platform-export-test-'));
process.env.DATA_DIR = path.join(tmpRoot, 'data');
process.env.DB_PATH = path.join(tmpRoot, 'data', 'test.db');
process.env.UPLOAD_DIR = path.join(tmpRoot, 'uploads');
process.env.EXPORT_DIR = path.join(tmpRoot, 'exports');

const { sanitizeFormulaValue, simpleCsv } = require('../src/engines/exportEngine');

test('sanitizeFormulaValue neutralizes values that would be interpreted as spreadsheet formulas', () => {
  assert.equal(sanitizeFormulaValue('=HYPERLINK("http://evil.example")'), "'=HYPERLINK(\"http://evil.example\")");
  assert.equal(sanitizeFormulaValue('+1234'), "'+1234");
  assert.equal(sanitizeFormulaValue('-1234'), "'-1234");
  assert.equal(sanitizeFormulaValue('@SUM(A1:A9)'), "'@SUM(A1:A9)");
  assert.equal(sanitizeFormulaValue('\t=cmd|"/c calc"'), "'\t=cmd|\"/c calc\"");
});

test('sanitizeFormulaValue leaves ordinary business data untouched', () => {
  assert.equal(sanitizeFormulaValue('ABC Industries Pvt Ltd'), 'ABC Industries Pvt Ltd');
  assert.equal(sanitizeFormulaValue('12 MG Road, Pune'), '12 MG Road, Pune');
  assert.equal(sanitizeFormulaValue('27AAAAA0000A1Z5'), '27AAAAA0000A1Z5');
  assert.equal(sanitizeFormulaValue(null), null);
  assert.equal(sanitizeFormulaValue(42), 42);
});

test('simpleCsv output is safe against formula injection end-to-end', () => {
  const csv = simpleCsv([{ vendor_name: '=1+1', notes: 'normal text' }]);
  const lines = csv.split('\n');
  assert.ok(lines[1].startsWith("'=1+1") || lines[1].startsWith("\"'=1+1"),
    'a formula-triggering cell must be neutralized in the CSV output');
});
