'use strict';
// isolation first: nothing in this file may touch real storage
process.env.DATA_DIR = fs_mkdtemp(); function fs_mkdtemp() { return require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'dq-ingest-data-')); }
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { migrate } = require('../src/db/migrate');
const { ingestFile, ingestSourceFile } = require('../src/ingest');
const { writeWorkbook } = require('./helpers/workbook');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dq-ingest-')); let seq = 0;
const file = (name) => path.join(tmp, `${++seq}_${name}`);
function freshDb() {
  const f = file('t.db'); const db = new DatabaseSync(f); db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON'); migrate(db, { dbFile: f });
  db.exec(`INSERT INTO organizations(id,name) VALUES('o','O'); INSERT INTO datasets(id,organization_id,name) VALUES('d','o','D'),('d2','o','D2')`); return db;
}
const rows = (db, sf) => db.prepare('SELECT * FROM source_rows WHERE source_file_id=? ORDER BY row_number').all(sf);
const cols = (db, sf) => db.prepare('SELECT * FROM file_columns WHERE source_file_id=? ORDER BY column_index').all(sf);
const J = s => (s === null ? null : JSON.parse(s));
const count = (db, t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
const rejects = (fn, re) => assert.throws(fn, err => re.test(String(err.message)));

test('duplicate headers stay DISTINCT physical columns with full provenance (Material x3 pattern, case-only twins, whitespace twins, blank and numeric headers)', () => {
  const db = freshDb(), f = file('dup.xlsx');
  writeWorkbook(f, [
    ['Material', 'Material', 'Item ', ' item', 'Valid From', 'valid from', '', 2024, 'Material'],
    ['M1', '', 'a1', 'b1', 'x', 'y', 'blank1', 'n1', 'M1-third'],
    ['M2', null, 'a2', 'b2', 'x2', 'y2', 'blank2', 'n2', 'M2-third'] ]);
  const r = ingestFile(db, { datasetId: 'd', filePath: f });
  const c = cols(db, r.sourceFileId);
  assert.equal(c.length, 9, 'physical column count is preserved');
  assert.deepEqual(c.map(x => x.header_raw), ['Material', 'Material', 'Item ', ' item', 'Valid From', 'valid from', '', '2024', 'Material']);   // originals byte-for-byte
  assert.deepEqual(c.map(x => x.column_index), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(c.map(x => x.column_letter), ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']);
  assert.equal(new Set(c.map(x => x.header_key)).size, 9, 'addressing keys are unique');
  assert.deepEqual(c.map(x => x.header_key), ['Material [A]', 'Material [B]', 'Item [C]', 'item [D]', 'Valid From [E]', 'valid from [F]', 'Column [G]', '2024', 'Material [I]']);
  assert.deepEqual(c.map(x => x.is_duplicate_header), [1, 1, 1, 1, 1, 1, 0, 0, 1]);
  assert.deepEqual(c.map(x => x.duplicate_ordinal), [1, 2, 1, 2, 1, 2, null, null, 3]);
  assert.deepEqual(c.map(x => x.header_normalized), ['material', 'material', 'item', 'item', 'valid from', 'valid from', '', '2024', 'material']);
  assert.ok(c.every(x => x.source_sheet === 'Data'));
  assert.equal(r.hasDuplicateHeaders, true);
  // each twin holds ITS OWN cells: the empty twin stays empty, the populated ones differ
  assert.deepEqual(c.map(x => x.populated_count), [2, 0, 2, 2, 2, 2, 2, 2, 2]); assert.equal(c[1].is_empty, 1); assert.equal(r.emptyColumns, 1);
  const [r1] = rows(db, r.sourceFileId); const raw = J(r1.raw_json);
  assert.equal(raw['Material [A]'], 'M1'); assert.equal(raw['Material [I]'], 'M1-third'); assert.equal('Material [B]' in raw, false);   // blank => key omitted (NULL)
  assert.equal(raw['Item [C]'], 'a1'); assert.equal(raw['item [D]'], 'b1');
  assert.equal(raw['Column [G]'], 'blank1'); assert.equal(J(c[6].profile_json).is_blank_header, true);
  assert.ok(r.warnings.some(w => /duplicate_headers/.test(w)) && r.warnings.some(w => /blank_headers/.test(w)));
});

test('a genuine header that looks like a generated key cannot collide with it', () => {
  const db = freshDb(), f = file('collide.xlsx');
  writeWorkbook(f, [['A', 'A', 'A [B]'], ['1', '2', '3']]);
  const c = cols(db, ingestFile(db, { datasetId: 'd', filePath: f }).sourceFileId);
  assert.equal(new Set(c.map(x => x.header_key)).size, 3); assert.deepEqual(c.map(x => x.header_raw), ['A', 'A', 'A [B]']);
});

test('full-column physical metadata: every row counted, empty columns represented as empty, mixed kinds and number formats recorded', () => {
  const db = freshDb(), f = file('stats.xlsx'); const data = [['Code', 'Empty', 'Amount', 'When', 'Mixed', 'Pad']];
  for (let i = 0; i < 300; i++) data.push([i % 2 ? 'AB' + (1000 + i) : 'X' + i, null, { v: i * 1.5, z: '#,##0.00' }, { v: 45000 + i, z: 'dd.mm.yyyy' }, i === 299 ? 'late text' : i, i === 5 ? '  spaced ' : '007']);
  writeWorkbook(f, data); const r = ingestFile(db, { datasetId: 'd', filePath: f }); const c = cols(db, r.sourceFileId), P = x => J(x.profile_json);
  assert.equal(r.dataRows, 300); assert.equal(c[1].is_empty, 1); assert.equal(c[1].populated_count, 0); assert.equal(c[1].populated_ratio, 0);
  assert.equal(c[0].populated_count, 300); assert.equal(c[0].populated_ratio, 1);
  assert.deepEqual(J(c[2].cell_kinds_json), { number: 300 }); assert.deepEqual(Object.keys(P(c[2]).number_formats), ['#,##0.00']); assert.equal(P(c[2]).number.max, 299 * 1.5);
  const utcDay = n => new Date((n - 25569) * 86400000).toISOString().slice(0, 10);   // independent UTC oracle (test only)
  assert.deepEqual(J(c[3].cell_kinds_json), { date_only: 300 }); assert.deepEqual(P(c[3]).date_range, { min: utcDay(45000), max: utcDay(45299) });
  assert.equal(P(c[4]).mixed_kinds, true);                                            // 299 numbers + 1 text (the LAST row: a first-N-rows sample would miss it)
  assert.equal(P(c[5]).text.leading_zero_digit_strings, 299); assert.equal(P(c[5]).text.with_leading_or_trailing_space, 1);
  assert.equal(J(c[0].value_shapes_json)['A{2}9{4}'], 150);
});

test('source lineage: file, sheet, physical row, data row, raw hash - and blank rows never renumber anything', () => {
  const db = freshDb(), f = file('lineage.xlsx');
  writeWorkbook(f, { Ignore: [['zzz']], Vendors: [['Title row'], [], ['Name', 'City'], ['A', 'Pune'], [null, null], ['   ', '  '], ['B', 'Delhi'], ['C', null]] });
  const r = ingestFile(db, { datasetId: 'd', filePath: f, sheetName: 'Vendors' });
  assert.deepEqual([r.headerRow, r.headerRowSource, r.dataRows, r.blankRowsSkipped], [3, 'auto', 3, 2]);
  const sf = db.prepare('SELECT * FROM source_files WHERE id=?').get(r.sourceFileId);
  assert.deepEqual([sf.sheet_name, sf.sheet_index, sf.header_row, sf.physical_row_count, sf.data_row_count, sf.blank_row_count, sf.file_type, sf.ingest_status], ['Vendors', 1, 3, 8, 3, 2, 'xlsx', 'ingested']);
  assert.deepEqual(J(sf.preamble_json), [{ sheet_row: 1, cells: [{ col: 'A', text: 'Title row' }] }]);
  const rs = rows(db, r.sourceFileId);
  assert.deepEqual(rs.map(x => [x.row_number, x.sheet_row]), [[1, 4], [4, 7], [5, 8]]);   // row_number = sheet_row - header_row: the two skipped blank rows leave a visible gap, nothing shifts
  assert.ok(rs.every(x => x.source_file_id === r.sourceFileId && x.source_sheet === 'Vendors' && /^[0-9a-f]{64}$/.test(x.raw_hash) && x.ingest_version));
  assert.equal(J(rs[2].raw_json).City, undefined); assert.equal(J(rs[2].raw_json).Name, 'C');
  assert.equal(new Set(rs.map(x => x.raw_hash)).size, 3);
  // explicit header row overrides detection
  const r2 = ingestFile(db, { datasetId: 'd', filePath: f, sheetName: 'Vendors', headerRow: 1 });
  assert.equal(r2.reused, false); assert.equal(r2.headerRowSource, 'explicit'); assert.equal(cols(db, r2.sourceFileId)[0].header_raw, 'Title row');
  assert.throws(() => ingestFile(db, { datasetId: 'd', filePath: f, sheetName: 'Vendors', headerRow: 99 }), /outside the sheet/);
  assert.throws(() => ingestFile(db, { datasetId: 'd', filePath: f, sheetName: 'Nope' }), /not found in workbook/);
});

test('Record_ID is retained SEPARATELY from the sheet row number and the internal database id (and can be switched off or set explicitly)', () => {
  const db = freshDb(), f = file('rid.xlsx');
  writeWorkbook(f, [['Record_ID', 'Name'], ['ERP-00290', 'A'], ['ERP-00010', 'B'], [{ s: '000123' }, 'C']]);
  const r = ingestFile(db, { datasetId: 'd', filePath: f }); const rs = rows(db, r.sourceFileId);
  assert.deepEqual(rs.map(x => x.row_identifier), ['ERP-00290', 'ERP-00010', '000123']);
  assert.deepEqual(rs.map(x => x.row_number), [1, 2, 3]); assert.deepEqual(rs.map(x => x.sheet_row), [2, 3, 4]);
  assert.ok(rs.every(x => x.id !== x.row_identifier && String(x.id) !== String(x.row_number) && /^[0-9a-f-]{36}$/.test(x.id)));
  assert.equal(J(rs[0].raw_json).Record_ID, 'ERP-00290', 'the raw value also stays in raw_json');
  assert.equal(ingestFile(db, { datasetId: 'd', filePath: f, rowIdentifier: false }).reused, false);
  assert.ok(rows(db, db.prepare(`SELECT id FROM source_files WHERE ingest_config_json LIKE '%"none"%'`).get().id).every(x => x.row_identifier === null));
  const r3 = ingestFile(db, { datasetId: 'd', filePath: f, rowIdentifier: { header: 'Name' } }); assert.deepEqual(rows(db, r3.sourceFileId).map(x => x.row_identifier), ['A', 'B', 'C']);
  const g = file('rid2.xlsx'); writeWorkbook(g, [['Record_ID', 'Row ID', 'x'], ['1', '9', 'a']]);       // two conventional candidates: never guess
  const r4 = ingestFile(db, { datasetId: 'd', filePath: g }); assert.equal(rows(db, r4.sourceFileId)[0].row_identifier, null); assert.ok(r4.warnings.some(w => /row_identifier_ambiguous/.test(w)));
});

test('canonical values: raw preserved, dates -> calendar strings, ids stay text, blanks are NULL, whitespace kept but not "populated"', () => {
  const db = freshDb(), f = file('canon.xlsx');
  writeWorkbook(f, [['Created On', 'When', 'Clock', 'Entry Sheet', 'Purchasing Document', 'Created By', 'Amount', 'Flag', 'Err', 'Blank', 'Space', 'HiddenTime'],
    [{ v: 41725, z: 'm/d/yy' }, { v: 45281.75, z: 'yyyy-mm-dd hh:mm:ss' }, { v: 0.5, z: '[$-F400]h:mm:ss AM/PM' }, '1000005791', '4300000346', 'SANKALP20299', { v: 320475, z: '#,##0.00' }, true, { e: 42 }, null, '   ', { v: 45281.5, z: 'dd.mm.yyyy' }]]);
  const r = ingestFile(db, { datasetId: 'd', filePath: f }); const [row] = rows(db, r.sourceFileId), raw = J(row.raw_json), can = J(row.canonical_json), meta = J(row.raw_meta_json);
  assert.equal(raw['Created On'], 41725); assert.equal(can['Created On'], '2014-03-27'); assert.equal(meta['Created On'].k, 'date_only');
  assert.equal(can.When, '2023-12-21T18:00:00'); assert.equal(meta.When.tz, 'floating'); assert.equal(can.Clock, '12:00:00'); assert.equal(meta.Clock.k, 'time_only');
  for (const k of ['Entry Sheet', 'Purchasing Document', 'Created By']) { assert.equal(typeof raw[k], 'string'); assert.equal(can[k], undefined); assert.equal(meta[k], undefined); }
  assert.equal(raw['Entry Sheet'], '1000005791'); assert.equal(raw.Amount, 320475); assert.equal(can.Amount, undefined); assert.equal(raw.Flag, true);
  assert.equal(raw.Err, '#N/A'); assert.equal(meta.Err.k, 'error'); assert.equal(can.Err, undefined);
  assert.equal('Blank' in raw, false); assert.equal(raw.Space, '   '); assert.equal(cols(db, r.sourceFileId).find(c => c.header_raw === 'Space').populated_count, 0);
  assert.equal(can.HiddenTime, '2023-12-21'); assert.equal(meta.HiddenTime.ht, '12:00:00');
});

test('text dates: parsed under the profile; ambiguous/unconfigured/invalid keep raw + candidates and get NO canonical value; the column is flagged for review', () => {
  const db = freshDb(), f = file('textdates.xlsx');
  writeWorkbook(f, [['D'], ['05.03.2024'], ['2024-03-05'], ['05/03/2024'], ['31.02.2024'], ['16.01.19'], ['not-a-date'], ['4300000346']]);
  const r = ingestFile(db, { datasetId: 'd', filePath: f }); const rs = rows(db, r.sourceFileId), c = cols(db, r.sourceFileId)[0];
  const can = rs.map(x => J(x.canonical_json)), meta = rs.map(x => J(x.raw_meta_json));
  assert.equal(can[0].D, '2024-03-05'); assert.equal(can[1].D, '2024-03-05');
  assert.deepEqual([meta[2].D.st, can[2]], ['needs_configuration', null]); assert.equal(meta[2].D.cand.length, 2);
  assert.deepEqual([meta[3].D.k, meta[3].D.why, can[3]], ['invalid_date', 'calendar_invalid', null]);
  assert.equal(meta[4].D.st, 'needs_configuration');
  assert.deepEqual([J(rs[3].raw_json).D, J(rs[5].raw_json).D, J(rs[6].raw_json).D], ['31.02.2024', 'not-a-date', '4300000346']);   // raw untouched
  assert.equal(J(c.profile_json).date_review_required, true); assert.equal(J(c.profile_json).text_dates.needs_configuration, 2);
  assert.ok(r.warnings.some(w => /date_review_required/.test(w)));
  // an explicit profile changes the interpretation and is a different source (rows are immutable)
  const r2 = ingestFile(db, { datasetId: 'd', filePath: f, dateProfile: { formats: ['DD.MM.YYYY', 'YYYY-MM-DD', 'DD/MM/YYYY', 'DD.MM.YY'], century_pivot: 70 } });
  assert.equal(r2.reused, false); assert.equal(J(rows(db, r2.sourceFileId)[2].canonical_json).D, '2024-03-05'); assert.equal(J(rows(db, r2.sourceFileId)[4].canonical_json).D, '2019-01-16');
  assert.equal(J(rows(db, r2.sourceFileId)[2].raw_meta_json).D.alt[0].value, '2024-05-03');
});

test('1904 workbooks are converted with the 1904 epoch and the flag is stored on the source', () => {
  const db = freshDb(), f = file('d1904.xlsx'); writeWorkbook(f, [['D'], [{ v: 0, z: 'yyyy-mm-dd' }], [{ v: 1462, z: 'yyyy-mm-dd' }]], { date1904: true });
  const r = ingestFile(db, { datasetId: 'd', filePath: f }); assert.deepEqual(rows(db, r.sourceFileId).map(x => J(x.canonical_json).D), ['1904-01-01', '1908-01-02']);
  assert.equal(db.prepare('SELECT date1904 d FROM source_files WHERE id=?').get(r.sourceFileId).d, 1);
});

test('RE-INGESTION: same content = same source (no new rows); changed content / sheet / dataset / profile = new source; old rows are untouched', () => {
  const db = freshDb(), f = file('re.xlsx'); writeWorkbook(f, { S1: [['A'], ['1'], ['2']], S2: [['B'], ['x']] });
  const a = ingestFile(db, { datasetId: 'd', filePath: f, sheetName: 'S1' }); assert.equal(a.reused, false);
  const rowsBefore = count(db, 'source_rows'), colsBefore = count(db, 'file_columns');
  const b = ingestFile(db, { datasetId: 'd', filePath: f, sheetName: 'S1' }); assert.deepEqual([b.reused, b.sourceFileId], [true, a.sourceFileId]);
  assert.equal(ingestFile(db, { datasetId: 'd', filePath: f }).sourceFileId, a.sourceFileId, 'default sheet resolves to the first sheet');
  const copy = file('renamed_copy.xlsx'); fs.copyFileSync(f, copy);
  assert.equal(ingestFile(db, { datasetId: 'd', filePath: copy, sheetName: 'S1', originalFilename: 'other name.xlsx' }).sourceFileId, a.sourceFileId, 'identity is CONTENT, not file name or path');
  assert.deepEqual([count(db, 'source_rows'), count(db, 'file_columns')], [rowsBefore, colsBefore]);
  assert.equal(count(db, 'source_files'), 1);
  const sheet2 = ingestFile(db, { datasetId: 'd', filePath: f, sheetName: 'S2' }); assert.equal(sheet2.reused, false);
  const otherDs = ingestFile(db, { datasetId: 'd2', filePath: f, sheetName: 'S1' }); assert.equal(otherDs.reused, false);
  const prof = ingestFile(db, { datasetId: 'd', filePath: f, sheetName: 'S1', dateProfile: { formats: ['DD/MM/YYYY'] } }); assert.equal(prof.reused, false);
  const hdr = ingestFile(db, { datasetId: 'd', filePath: f, sheetName: 'S1', headerRow: 1 }); assert.equal(hdr.reused, false);
  writeWorkbook(f, { S1: [['A'], ['1'], ['2'], ['3']], S2: [['B'], ['x']] });                          // the file changes in place
  const changed = ingestFile(db, { datasetId: 'd', filePath: f, sheetName: 'S1' }); assert.equal(changed.reused, false); assert.notEqual(changed.sourceFileId, a.sourceFileId);
  assert.equal(changed.dataRows, 3); assert.equal(rows(db, a.sourceFileId).length, 2, 'the earlier source keeps exactly the rows earlier runs analysed');
});

test('ONE SOURCE -> MANY ANALYSIS RUNS: new runs (even with different configurations) reference the same source without re-ingesting', () => {
  const db = freshDb(), f = file('runs.xlsx'); writeWorkbook(f, [['A'], ['1'], ['2'], ['3']]);
  const a = ingestFile(db, { datasetId: 'd', filePath: f }); const before = count(db, 'source_rows');
  const cfg = (id, years) => { db.prepare(`INSERT INTO analysis_configs (id, dataset_id, version, table_type, stale_threshold_years, config_json, config_hash) VALUES (?,?,?,?,?,?,?)`).run(id, 'd', years, 'master_entity', years, '{}', 'h' + id); return id; };
  const run = (id, cid) => { db.prepare(`INSERT INTO analysis_runs (id, dataset_id, status, engine_version, config_id, config_hash, reference_date, stale_threshold_years, table_type) VALUES (?,?,?,?,?,?,?,?,?)`).run(id, 'd', 'matching', 'v1.0.0', cid, 'h' + cid, '2026-09-24', 4, 'master_entity'); db.prepare(`INSERT INTO run_inputs (run_id, source_file_id, mapping_version, row_count, content_sha256) VALUES (?,?,?,?,?)`).run(id, a.sourceFileId, 1, 3, db.prepare('SELECT content_sha256 s FROM source_files WHERE id=?').get(a.sourceFileId).s); };
  run('run1', cfg('c1', 4)); run('run2', cfg('c2', 2));
  assert.equal(count(db, 'run_inputs'), 2); assert.equal(ingestFile(db, { datasetId: 'd', filePath: f }).reused, true); assert.equal(count(db, 'source_rows'), before);
  assert.equal(db.prepare('SELECT COUNT(DISTINCT source_file_id) c FROM run_inputs').get().c, 1);
});

test('atomic: a failure part-way leaves NO source file, columns or rows behind', () => {
  const db = freshDb(), f = file('atomic.xlsx'); writeWorkbook(f, [['A'], ['1'], ['2'], ['3'], ['4'], ['5'], ['6']]);
  db.exec(`CREATE TRIGGER boom BEFORE INSERT ON source_rows WHEN (SELECT COUNT(*) FROM source_rows) >= 3 BEGIN SELECT RAISE(ABORT, 'disk on fire'); END`);
  assert.throws(() => ingestFile(db, { datasetId: 'd', filePath: f }), /disk on fire/);
  assert.deepEqual([count(db, 'source_files'), count(db, 'file_columns'), count(db, 'source_rows')], [0, 0, 0]);
  db.exec('DROP TRIGGER boom'); assert.equal(ingestFile(db, { datasetId: 'd', filePath: f }).dataRows, 6, 'and the same file ingests cleanly afterwards');
});

test('ingestSourceFile: populates an existing upload row; identical existing source is returned, not duplicated; failures are recorded', () => {
  const db = freshDb(), f = file('exist.xlsx'); writeWorkbook(f, [['A', 'B'], ['1', '2']]);
  const mk = (id) => db.prepare(`INSERT INTO source_files (id, dataset_id, original_filename, stored_path, file_size_bytes, file_type) VALUES (?,?,?,?,?,?)`).run(id, 'd', 'x.xlsx', f, fs.statSync(f).size, 'xlsx');
  mk('up1'); const a = ingestSourceFile(db, 'up1'); assert.deepEqual([a.reused, a.sourceFileId, a.dataRows], [false, 'up1', 1]);
  assert.equal(ingestSourceFile(db, 'up1').reused, true);
  mk('up2'); const b = ingestSourceFile(db, 'up2'); assert.deepEqual([b.reused, b.duplicateOf, b.sourceFileId], [true, 'up1', 'up1']);
  assert.equal(db.prepare(`SELECT ingest_status s FROM source_files WHERE id='up2'`).get().s, 'not_ingested'); assert.equal(count(db, 'source_rows'), 1);
  const bad = file('bad.xlsx'); fs.writeFileSync(bad, crypto.randomBytes(400));
  db.prepare(`INSERT INTO source_files (id, dataset_id, original_filename, stored_path, file_size_bytes, file_type) VALUES ('up3','d','bad.xlsx',?,400,'xlsx')`).run(bad);
  assert.throws(() => ingestSourceFile(db, 'up3'), /not a valid Excel workbook/); const bad3 = db.prepare(`SELECT ingest_status s, ingest_error e FROM source_files WHERE id='up3'`).get();
  assert.equal(bad3.s, 'failed'); assert.match(bad3.e, /not a valid Excel workbook/); assert.equal(count(db, 'source_rows'), 1);
  assert.throws(() => ingestSourceFile(db, 'nope'), /not found/);
  assert.throws(() => ingestSourceFile(db, 'up1', { headerRow: 1 }), /already ingested with different/);
});

test('CSV: BOM, delimiter detection, quoted delimiters/newlines, CRLF, ragged rows, duplicate headers, empty lines', () => {
  const db = freshDb(), f = file('a.csv');
  fs.writeFileSync(f, '\uFEFFName;Name;Note\r\n"Smith; J";Jones;"line1\nline2"\r\n\r\nA;;\r\nB;C');
  const r = ingestFile(db, { datasetId: 'd', filePath: f }); const c = cols(db, r.sourceFileId), rs = rows(db, r.sourceFileId);
  assert.deepEqual(c.map(x => x.header_raw), ['Name', 'Name', 'Note']); assert.deepEqual(c.map(x => x.header_key), ['Name [A]', 'Name [B]', 'Note']);
  assert.equal(db.prepare('SELECT file_type t, sheet_name s FROM source_files WHERE id=?').get(r.sourceFileId).t, 'csv');
  assert.equal(J(rs[0].raw_json)['Name [A]'], 'Smith; J'); assert.equal(J(rs[0].raw_json).Note, 'line1\nline2');
  assert.deepEqual(rs.map(x => x.row_number), [1, 3, 4]);          // the empty line is a skipped blank row, never a shift
  assert.equal(rs[2].source_sheet, null); assert.equal(J(rs[2].raw_json)['Name [B]'], 'C');
  assert.equal(ingestFile(db, { datasetId: 'd', filePath: f }).reused, true);
  const g = file('b.csv'); fs.writeFileSync(g, 'D\n05.03.2024\n2024-03-05\n05/03/2024\n'); const r2 = ingestFile(db, { datasetId: 'd', filePath: g });   // CSV cells are text: the same strict text-date rules apply
  assert.deepEqual(rows(db, r2.sourceFileId).map(x => (J(x.canonical_json) || {}).D || null), ['2024-03-05', '2024-03-05', null]);
});

test('edge sources: header-only file, empty sheet, empty file, corrupt file', () => {
  const db = freshDb(); const h = file('ho.xlsx'); writeWorkbook(h, [['A', 'B']]);
  const r = ingestFile(db, { datasetId: 'd', filePath: h }); assert.deepEqual([r.dataRows, r.columns, r.emptyColumns], [0, 2, 2]);
  const e = file('e.xlsx'); writeWorkbook(e, { Empty: [] }); assert.throws(() => ingestFile(db, { datasetId: 'd', filePath: e }), /empty/i);
  const z = file('z.csv'); fs.writeFileSync(z, ''); assert.throws(() => ingestFile(db, { datasetId: 'd', filePath: z }), /empty/i);
  const x = file('x.xlsx'); fs.writeFileSync(x, crypto.randomBytes(300)); assert.throws(() => ingestFile(db, { datasetId: 'd', filePath: x }), /not a valid Excel workbook/);
  const t = file('text.xlsx'); fs.writeFileSync(t, 'a,b\n1,2\n'); assert.throws(() => ingestFile(db, { datasetId: 'd', filePath: t }), /not a valid Excel workbook/);   // a CSV renamed .xlsx is refused, not parsed as junk
  assert.deepEqual([count(db, 'source_files')], [1]);
});

test('structural invariants (0004): ingested sources, physical columns, canonical values and lineage cannot be rewritten', () => {
  const db = freshDb(), f = file('inv.xlsx'); writeWorkbook(f, [['A'], [{ v: 41725, z: 'm/d/yy' }]]);
  const r = ingestFile(db, { datasetId: 'd', filePath: f }); const sf = r.sourceFileId, col = cols(db, sf)[0], row = rows(db, sf)[0];
  rejects(() => db.prepare('UPDATE source_files SET content_sha256=? WHERE id=?').run('x', sf), /immutable/);
  rejects(() => db.prepare('UPDATE source_files SET header_row=5 WHERE id=?').run(sf), /immutable/);
  rejects(() => db.prepare(`UPDATE source_files SET ingest_status='not_ingested' WHERE id=?`).run(sf), /cannot be un-ingested/);
  rejects(() => db.prepare(`UPDATE file_columns SET header_raw='B' WHERE id=?`).run(col.id), /immutable/);
  rejects(() => db.prepare(`UPDATE file_columns SET populated_count=99 WHERE id=?`).run(col.id), /immutable/);
  rejects(() => db.prepare(`UPDATE source_rows SET canonical_json='{}' WHERE id=?`).run(row.id), /immutable/);
  rejects(() => db.prepare(`UPDATE source_rows SET raw_json='{}' WHERE id=?`).run(row.id), /immutable/);
  const ins = (rn, sr, sheet) => db.prepare(`INSERT INTO source_rows (id, source_file_id, row_number, sheet_row, source_sheet, raw_json, raw_hash, ingest_version) VALUES (?,?,?,?,?,'{}','h','x')`).run(crypto.randomUUID(), sf, rn, sr, sheet);
  rejects(() => ins(2, 9, 'Data'), /lineage mismatch/); rejects(() => ins(2, 3, 'Other'), /lineage mismatch/); ins(2, 3, 'Data');
  rejects(() => db.prepare(`INSERT INTO source_files (id, dataset_id, original_filename, stored_path, file_size_bytes, file_type, sheet_name, content_sha256, ingest_fingerprint, ingest_status)
    SELECT 'dupe', dataset_id, original_filename, stored_path, file_size_bytes, file_type, sheet_name, content_sha256, ingest_fingerprint, 'ingested' FROM source_files WHERE id=?`).run(sf), /UNIQUE/i);
  // legacy-style upload rows (never ingested) still behave as before
  db.prepare(`INSERT INTO source_files (id, dataset_id, original_filename, stored_path, file_size_bytes, file_type) VALUES ('leg','d','l.xlsx','/x',1,'xlsx')`).run();
  db.prepare(`UPDATE source_files SET sheet_name='S', status='parsed' WHERE id='leg'`).run();
});

test('larger sheet: 4,000 rows x 60 columns ingests correctly and stays fast enough to run inside an upload', () => {
  const db = freshDb(), f = file('big.xlsx'); const hdr = Array.from({ length: 60 }, (_, i) => 'C' + (i % 55)); const data = [hdr];
  for (let i = 0; i < 4000; i++) data.push(hdr.map((_, c) => c % 5 === 0 ? { v: 40000 + i, z: 'dd.mm.yyyy' } : c % 7 === 0 ? null : 'v' + ((i * 31 + c) % 900)));
  writeWorkbook(f, data); const t0 = Date.now(); const r = ingestFile(db, { datasetId: 'd', filePath: f }); const ms = Date.now() - t0;
  assert.deepEqual([r.dataRows, r.columns], [4000, 60]); assert.equal(count(db, 'source_rows'), 4000); assert.equal(new Set(cols(db, r.sourceFileId).map(c => c.header_key)).size, 60);
  assert.ok(ms < 20000, `took ${ms}ms`);
});
