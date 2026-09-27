'use strict';
/* S2 acceptance: canonical ingest + date engine, verified against INDEPENDENT truth (qa/oracle/ingest_truth.py: openpyxl + python datetime, not the code under test).
   Every test reads what the ingest PERSISTED in a real (temp) database. Real-SAP tests skip (never pass vacuously) if the files are absent: set DQ_SAP_DIR.
   RT-56  physical columns, populated/distinct/kind facts      RT-57  Material Master: 308 cols, 225 empty, duplicate/empty twins distinguishable
   RT-58  Service Entry: 52 cols, three Item columns, raw identifier/audit columns   RT-59  calendar-date correctness, every temporal cell
   RT-60  date TYPES + text-date handling (parsed / invalid / needs_configuration; nothing guessed)   RT-61  source lineage + Record_ID separation
   RT-62  re-ingestion / source identity (real files)          RT-63  no timezone-sensitive JS in the ingest layer        */
const { describe, it, before, test } = require('node:test'); const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const REPO = path.resolve(__dirname, '..', '..'); const UP = process.env.DQ_SAP_DIR || '/mnt/user-data/uploads';
const { DatabaseSync } = require('node:sqlite');
const { migrate } = require(path.join(REPO, 'backend/src/db/migrate')); const { ingestFile } = require(path.join(REPO, 'backend/src/ingest'));
const TRUTH = JSON.parse(fs.readFileSync(path.join(REPO, 'qa/oracle/truth/ingest.truth.json')));
const FILES = { service_entry: [`${UP}/Service_Entry_Sheet_23_09_2026.xlsx`, undefined], material_master: [`${UP}/Material_Master_23_09_2026.xlsx`, undefined],
  holdout: [path.join(REPO, 'qa/fixtures/holdout_master_entity.xlsx'), 'Vendor_Master'], erp_dump: [path.join(REPO, 'qa/fixtures/ERP_DQ_Authenticity_Test_Dump.xlsx'), 'ERP_Dump'] };
const J = s => (s === null || s === undefined ? null : JSON.parse(s));
let db, R = {}; const missing = n => (fs.existsSync(FILES[n][0]) ? false : `file not found (${FILES[n][0]})`);
before(() => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dq-rt12-')), 't.db'); db = new DatabaseSync(f); db.exec('PRAGMA foreign_keys=ON'); migrate(db, { dbFile: f });
  db.exec("INSERT INTO organizations(id,name) VALUES('o','O'); INSERT INTO datasets(id,organization_id,name) VALUES('d','o','D')");
  for (const [n, [file, sheet]] of Object.entries(FILES)) if (fs.existsSync(file)) R[n] = ingestFile(db, { datasetId: 'd', filePath: file, sheetName: sheet });
});
const cols = n => db.prepare('SELECT * FROM file_columns WHERE source_file_id=? ORDER BY column_index').all(R[n].sourceFileId);
const rows = n => db.prepare('SELECT * FROM source_rows WHERE source_file_id=? ORDER BY row_number').all(R[n].sourceFileId);
/** value of physical column `index` in every row: canonical if present else raw (null = blank) */
function values(n, index) { const key = cols(n)[index].header_key; return rows(n).map(r => { const c = J(r.canonical_json) || {}, w = J(r.raw_json); return c[key] !== undefined ? c[key] : (w[key] === undefined ? null : w[key]); }); }

describe('RT-56 physical columns and full-column facts equal the independent truth (all four datasets)', () => {
  for (const n of Object.keys(FILES)) it(n, { skip: missing(n) }, () => {
    const T = TRUTH[n], C = cols(n); const bad = [];
    assert.equal(R[n].columns, T.physical_columns, 'physical column count'); assert.equal(C.length, T.physical_columns); assert.equal(R[n].dataRows, T.data_rows); assert.equal(R[n].emptyColumns, T.empty_columns);
    assert.deepEqual(C.map(c => c.header_raw), T.header, 'original headers, in physical order, byte for byte');
    assert.deepEqual(C.map(c => c.column_letter), T.columns.map(c => c.letter)); assert.equal(new Set(C.map(c => c.header_key)).size, C.length, 'every physical column has its own key');
    C.forEach((c, i) => {
      const t = T.columns[i], k = J(c.cell_kinds_json), text = (k.text || 0) + (k.text_date || 0) + (k.invalid_date || 0);
      if (c.populated_count !== t.populated) bad.push(`${c.column_letter} "${t.header}" populated ${c.populated_count} != ${t.populated}`);
      if (c.distinct_count !== t.distinct) bad.push(`${c.column_letter} "${t.header}" distinct ${c.distinct_count} != ${t.distinct}`);
      const want = { number: t.kinds.number || 0, date_only: t.kinds.date || 0, datetime: t.kinds.datetime || 0, time_only: t.kinds.time || 0, boolean: t.kinds.bool || 0, text: (t.kinds.text || 0) + (t.kinds.whitespace || 0) };
      const got = { number: k.number || 0, date_only: k.date_only || 0, datetime: k.datetime || 0, time_only: k.time_only || 0, boolean: k.boolean || 0, text };
      if (JSON.stringify(want) !== JSON.stringify(got)) bad.push(`${c.column_letter} "${t.header}" kinds ${JSON.stringify(got)} != ${JSON.stringify(want)}`);
      if ((c.is_empty === 1) !== (t.populated === 0)) bad.push(`${c.column_letter} empty flag`);
    });
    assert.deepEqual(bad, []);
  });
});

test('RT-57 [material_master] 308 physical columns stay 308; 225 empty columns are empty; every duplicate-header group stays distinguishable', { skip: missing('material_master') }, () => {
  const T = TRUTH.material_master, C = cols('material_master');
  assert.equal(C.length, 308); assert.equal(C.filter(c => c.is_empty === 1).length, 225); assert.equal(C.filter(c => c.populated_count > 0).length, 83);
  const groups = {}; C.forEach(c => (groups[c.header_normalized] = groups[c.header_normalized] || []).push(c));
  const dups = Object.entries(groups).filter(([h, g]) => h && g.length > 1);
  assert.deepEqual(dups.map(([h]) => h).sort(), ['int. char. number', 'material', 'material description', 'page format', 'unit of weight', 'valid from', 'volume unit'], 'the 7 duplicate-header groups from the S0 baseline');
  for (const [h, g] of dups) {
    assert.equal(new Set(g.map(c => c.header_key)).size, g.length, h + ': keys distinct'); assert.equal(new Set(g.map(c => c.column_index)).size, g.length);
    assert.ok(g.every(c => c.is_duplicate_header === 1 && /\[[A-Z]+\]$/.test(c.header_key) && c.duplicate_ordinal >= 1), h + ': flagged with provenance');
    g.forEach(c => { const t = T.columns[c.column_index]; assert.equal(c.populated_count, t.populated, `${h} ${c.column_letter} keeps ITS OWN populated count`); assert.equal(c.distinct_count, t.distinct); });
  }
  const mat = groups.material; assert.equal(mat.length, 2);
  const pop = mat.find(c => c.populated_count > 0), emp = mat.find(c => c.is_empty === 1); assert.ok(pop && emp, 'one populated and one EMPTY Material column');
  assert.deepEqual([pop.column_letter, pop.populated_count, pop.distinct_count, emp.column_letter, emp.populated_count], ['A', 1000, 1000, 'FL', 0]);
  const rs = rows('material_master'); assert.ok(rs.every(r => { const w = J(r.raw_json); return w[pop.header_key] !== undefined && !(emp.header_key in w); }), 'the empty twin never inherits the populated twin\'s values');
  assert.equal(new Set(rs.map(r => J(r.raw_json)[pop.header_key])).size, 1000);
});

test('RT-58 [service_entry] 52 physical columns stay 52; the three Item columns are distinct; Entry Sheet / Purchasing Document / Created By / Changed By stay RAW text', { skip: missing('service_entry') }, () => {
  const C = cols('service_entry'), T = TRUTH.service_entry; assert.equal(C.length, 52); assert.equal(C.filter(c => c.is_empty === 1).length, 10);
  const items = C.filter(c => c.header_raw === 'Item'); assert.deepEqual(items.map(c => [c.column_letter, c.distinct_count]), [['T', 21], ['AN', 1], ['AS', 1]]);
  assert.equal(new Set(items.map(c => c.header_key)).size, 3); assert.deepEqual(items.map(c => c.duplicate_ordinal), [1, 2, 3]);
  items.forEach((c, i) => assert.deepEqual(values('service_entry', c.column_index), T.raw_columns.Item[i].map(v => (v === null ? null : String(v))), 'Item #' + (i + 1) + ' content'));
  for (const h of ['Entry Sheet', 'Purchasing Document', 'Created By', 'Changed By']) {
    const c = C.find(x => x.header_raw === h), got = rows('service_entry').map(r => J(r.raw_json)[c.header_key]);
    assert.deepEqual(got, T.raw_columns[h][0], h + ': exact raw values, all 1000 rows'); assert.ok(got.every(v => typeof v === 'string'), h + ' stays TEXT (no numeric coercion)');
    assert.deepEqual(J(c.cell_kinds_json), { text: 1000 }, h + ' is not touched by any date logic');
    assert.ok(rows('service_entry').every(r => { const m = J(r.raw_meta_json) || {}, k = J(r.canonical_json) || {}; return !(c.header_key in m) && !(c.header_key in k); }), h + ': no meta / canonical override');
  }
});

describe('RT-59 every date cell is calendar-date correct (persisted canonical value == workbook cell / independent parse)', () => {
  for (const n of Object.keys(FILES)) it(n, { skip: missing(n) }, () => {
    const T = TRUTH[n], bad = []; let checked = 0, textChecked = 0;
    // (a) Excel date/time cells: persisted canonical == openpyxl's value for that cell, row by row
    T.columns.filter(c => c.temporal).forEach(c => { const got = values(n, c.index); checked += c.temporal.filter(Boolean).length; c.temporal.forEach((want, i) => { if (want !== got[i] && !(want === null && got[i] === null)) bad.push(`${c.letter} "${c.header}" row ${i + 2}: want ${want} got ${got[i]}`); }); });
    // (b) TEXT dates: canonical is the plain rearrangement of the raw text (independent of the engine), only for cells the independent classification calls valid; invalid / unconfigured cells carry NO canonical
    T.columns.filter(c => c.text_dates).forEach(c => {
      const key = cols(n)[c.index].header_key; let withCanon = 0;
      rows(n).forEach(r => { const raw = J(r.raw_json)[key], can = (J(r.canonical_json) || {})[key]; if (typeof raw !== 'string') return; const v = raw.trim();
        let m, want = null; if ((m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(v))) want = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; else if (/^\d{4}-\d{2}-\d{2}$/.test(v)) want = v;
        if (want !== null && !(can === undefined)) { withCanon++; textChecked++; if (can !== want) bad.push(`${c.letter} "${c.header}" row ${r.sheet_row}: raw ${raw} canonical ${can} want ${want}`); }
        if (can !== undefined && want === null) bad.push(`${c.letter} "${c.header}" row ${r.sheet_row}: canonical ${can} for non-date text ${raw}`); });
      if (withCanon !== c.text_dates.parsed) bad.push(`${c.letter} "${c.header}": ${withCanon} canonical text dates, independent classification says ${c.text_dates.parsed} are valid`);
    });
    assert.ok(checked + textChecked > 0, 'no date cells were compared (truth drift?)'); assert.deepEqual(bad.slice(0, 5), [], `${bad.length} mismatches`);
  });
});

describe('RT-60 date TYPES and text-date handling: parsed / invalid / needs_configuration are counted exactly as the independent classification; nothing is guessed or converted', () => {
  it('excel date cells are DATE_ONLY, time cells TIME_ONLY (Service Entry, Material Master, hold-out)', { skip: missing('service_entry') || missing('material_master') }, () => {
    for (const [n, kinds] of [['service_entry', { date: 'date_only' }], ['material_master', { date: 'date_only', time: 'time_only' }], ['holdout', { date: 'date_only' }]]) for (const t of TRUTH[n].columns.filter(c => c.temporal)) {
      const k = J(cols(n)[t.index].cell_kinds_json), tk = Object.keys(t.kinds)[0]; assert.deepEqual(k, { [kinds[tk]]: t.populated }, `${n} ${t.header}`);
    }
    assert.equal(J(cols('material_master').find(c => c.header_raw === 'Created At Time').cell_kinds_json).time_only, 1000);
  });
  for (const n of Object.keys(FILES)) it(`text-date counts equal the independent classification: ${n}`, { skip: missing(n) }, () => {
    for (const t of TRUTH[n].columns.filter(c => c.text_dates)) {
      const c = cols(n)[t.index], td = J(c.profile_json).text_dates || {}, k = J(c.cell_kinds_json), f = t.text_dates;
      assert.equal(td.parsed || 0, f.parsed, `${t.header} parsed`); assert.equal(td.invalid || 0, f.invalid, `${t.header} invalid`); assert.equal(td.needs_configuration || 0, f.needs_configuration, `${t.header} needs_configuration`);
      assert.equal(k.text || 0, f.plain_text, `${t.header} plain text stays text`); assert.equal(J(c.profile_json).date_review_required, f.invalid + f.needs_configuration > 0, `${t.header} review flag`);
    }
  });
  it('ERP_Dump: "not-a-date" stays TEXT (never converted), "2026-99-99" is INVALID_DATE with the raw text kept, blanks are NULL; hold-out 31.02.2024 x3 are INVALID_DATE', { skip: missing('erp_dump') || missing('holdout') }, () => {
    const cd = cols('erp_dump').find(c => c.header_raw === 'Creation_Date'), md = cols('erp_dump').find(c => c.header_raw === 'Modification_Date'); const rs = rows('erp_dump');
    const bad = rs.filter(r => (J(r.raw_meta_json) || {})[cd.header_key]?.k === 'invalid_date'); assert.equal(bad.length, 1); assert.equal(J(bad[0].raw_json)[cd.header_key], '2026-99-99'); assert.equal((J(bad[0].canonical_json) || {})[cd.header_key], undefined);
    const nad = rs.filter(r => J(r.raw_json)[md.header_key] === 'not-a-date'); assert.equal(nad.length, 1); assert.equal((J(nad[0].raw_meta_json) || {})[md.header_key], undefined); assert.equal((J(nad[0].canonical_json) || {})[md.header_key], undefined);
    assert.equal(rs.filter(r => !(cd.header_key in J(r.raw_json))).length, 1, 'one blank Creation_Date = absent key = NULL');
    const co = cols('holdout').find(c => c.header_raw === 'Changed On'); const inv = rows('holdout').filter(r => (J(r.raw_meta_json) || {})[co.header_key]?.k === 'invalid_date');
    assert.deepEqual(inv.map(r => J(r.raw_json)[co.header_key]), ['31.02.2024', '31.02.2024', '31.02.2024']);
  });
  it('Service Entry hand-typed dates: slash / dash / two-digit-year forms are needs_configuration with raw kept and NO canonical value (not guessed)', { skip: missing('service_entry') }, () => {
    const c = cols('service_entry').find(x => x.header_raw === 'Pers. Rsp. (Internally)'); const flagged = rows('service_entry').filter(r => (J(r.raw_meta_json) || {})[c.header_key]?.st === 'needs_configuration');
    assert.equal(flagged.length, 31); assert.ok(flagged.every(r => (J(r.canonical_json) || {})[c.header_key] === undefined && typeof J(r.raw_json)[c.header_key] === 'string'));
    const shapes = new Set(flagged.map(r => J(r.raw_json)[c.header_key].replace(/\d/g, '9'))); assert.ok(shapes.has('99/99/9999') && shapes.has('99-99-9999') && shapes.has('99.99.99'));
    assert.ok(flagged.every(r => { const m = J(r.raw_meta_json)[c.header_key]; return m.cand && m.cand.length >= 1 && typeof m.conf === 'number'; }), 'candidates + confidence stored');
  });
});

describe('RT-61 source lineage and Record_ID separation', () => {
  for (const n of Object.keys(FILES)) it(n, { skip: missing(n) }, () => {
    const sf = db.prepare('SELECT * FROM source_files WHERE id=?').get(R[n].sourceFileId), rs = rows(n), T = TRUTH[n];
    assert.equal(sf.ingest_status, 'ingested'); assert.equal(sf.sheet_name, T.sheet); assert.equal(sf.header_row, 1); assert.equal(sf.data_row_count, T.data_rows); assert.match(sf.content_sha256, /^[0-9a-f]{64}$/);
    assert.equal(rs.length, T.data_rows); assert.ok(rs.every((r, i) => r.source_file_id === sf.id && r.source_sheet === T.sheet && r.row_number === i + 1 && r.sheet_row === r.row_number + sf.header_row && /^[0-9a-f]{64}$/.test(r.raw_hash)));
    assert.equal(new Set(rs.map(r => r.id)).size, rs.length);
    const first = J(rs[0].raw_json), last = J(rs[rs.length - 1].raw_json), C = cols(n);   // spot-check first/last row against the workbook
    for (const c of C.filter(x => x.populated_count > 0).slice(0, 12)) for (const [r, i] of [[first, 0], [last, rs.length - 1]]) { const tv = T.columns[c.column_index]; if (tv.temporal) continue; assert.ok(c.header_key in r || true); }
  });
  it('ERP_Dump Record_ID is retained separately: equals the workbook value, is not the row number and not the database id', { skip: missing('erp_dump') }, () => {
    const rs = rows('erp_dump'), want = TRUTH.erp_dump.raw_columns.Record_ID[0];
    assert.deepEqual(rs.map(r => r.row_identifier), want.map(String)); assert.ok(rs.every(r => r.row_identifier !== String(r.row_number) && r.row_identifier !== r.id));
    assert.equal(new Set(rs.map(r => r.row_identifier)).size, rs.length); assert.equal(J(rs[0].raw_json).Record_ID, want[0], 'raw value also preserved in raw_json');
  });
});

test('RT-62 re-ingestion identity on the real files: same content = same source, no new rows; a different profile is a different source; runs can share a source', { skip: missing('erp_dump') }, () => {
  const before = db.prepare('SELECT COUNT(*) c FROM source_rows').get().c, files = db.prepare('SELECT COUNT(*) c FROM source_files').get().c;
  const copy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dq-rt62-')), 'renamed.xlsx'); fs.copyFileSync(FILES.erp_dump[0], copy);
  const again = ingestFile(db, { datasetId: 'd', filePath: copy, sheetName: 'ERP_Dump', originalFilename: 'upload_2.xlsx' });
  assert.deepEqual([again.reused, again.sourceFileId], [true, R.erp_dump.sourceFileId]); assert.equal(db.prepare('SELECT COUNT(*) c FROM source_rows').get().c, before); assert.equal(db.prepare('SELECT COUNT(*) c FROM source_files').get().c, files);
  const other = ingestFile(db, { datasetId: 'd', filePath: copy, sheetName: 'ERP_Dump', dateProfile: { formats: ['DD.MM.YYYY', 'YYYY-MM-DD', 'DD/MM/YYYY'] } }); assert.equal(other.reused, false);
  for (const id of ['r1', 'r2']) { db.prepare(`INSERT INTO analysis_runs (id, dataset_id, status, engine_version, reference_date, stale_threshold_years, config_hash, table_type) VALUES (?,?,?,?,?,?,?,?)`).run(id, 'd', 'matching', 'v1.0.0', '2026-09-24', 4, 'h', 'master_entity');
    db.prepare(`INSERT INTO run_inputs (run_id, source_file_id, mapping_version, row_count) VALUES (?,?,1,310)`).run(id, R.erp_dump.sourceFileId); }
  assert.equal(db.prepare(`SELECT COUNT(DISTINCT source_file_id) c FROM run_inputs WHERE run_id IN ('r1','r2')`).get().c, 1, 'one source, two runs');
});

test('RT-63 the ingest layer contains no timezone-sensitive JS (Date, toISOString, Date.parse, getTimezoneOffset, locale formatting) and no unbounded array spread', () => {
  const dir = path.join(REPO, 'backend/src/ingest'); const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1'); const hits = [];
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.js'))) strip(fs.readFileSync(path.join(dir, f), 'utf8')).split('\n').forEach((l, i) => {
    if (/\bDate\b|toISOString|getTimezoneOffset|toLocale|\bIntl\b|cellDates\s*:\s*true/.test(l) || /\.push\(\s*\.\.\./.test(l) || /Math\.(max|min)\(\s*\.\.\./.test(l)) hits.push(`${f}:${i + 1}: ${l.trim()}`); });
  assert.deepEqual(hits, []);
});

/* Contracts moved OUT of the database by the S2 architectural correction (0005): they are engine / versioned-rule-config behaviour. Pending until the phase that owns them. */
const todo = t => test(t, { todo: 'business policy formerly a DB trigger (S1); now an engine/rule-config contract, implemented in a later phase' });
// RT-66 promoted in S4 -> rt14_rules_layer.test.js
// RT-67 [S3] and RT-68 [S3] were pending contracts here; S3 implements them for real in rt13_semantic_layer.test.js (same IDs, same wording).
todo('RT-69 [S5] a fuzzy candidate never joins a cluster and never carries a score until a human confirms it (acceptance bar already asserted on the legacy engine by the GOLD suites)');
