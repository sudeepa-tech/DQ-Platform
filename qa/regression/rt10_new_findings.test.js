'use strict';
/* Permanent regression tests for the issues discovered at the end of S0 and the semantic decisions approved with S0.
   Each test FAILS if its defect is present. Nothing here is "documentation": a fixed engine turns these green, a regression turns them red.
   Real-SAP tests skip (never pass vacuously) if the SAP files are absent: set DQ_SAP_DIR.                                              */
const { describe, it, before, test } = require('node:test'); const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path'); const { spawnSync } = require('child_process');
const { H, GST, HEAD, ent, fillers, boot } = require('./_lib');
const { profileFile, parseColumns } = require('../harness/engine_facade');
const REPO = path.resolve(__dirname, '..', '..'); const UP = process.env.DQ_SAP_DIR || '/mnt/user-data/uploads';
const XLSX = require(path.join(REPO, 'backend/node_modules/xlsx'));

/* ---------- independent ground truth straight from the workbook (no engine code involved) ---------- */
function physicalColumns(file) {
  const wb = XLSX.readFile(file, { cellDates: false }); const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: false });
  const header = rows[0].map(h => (h == null ? '' : String(h).trim())); const data = rows.slice(1);
  const cols = header.map((h, i) => { const vals = data.map(r => r[i]).filter(v => v != null && String(v).trim() !== ''); return { index: i, header: h, populated: vals.length, ratio: data.length ? vals.length / data.length : 0, distinct: new Set(vals.map(v => String(v).trim())).size }; });
  const byHeader = {}; cols.forEach(c => { (byHeader[c.header] = byHeader[c.header] || []).push(c); });
  return { cols, duplicateGroups: Object.entries(byHeader).filter(([h, g]) => h && g.length > 1), rowCount: data.length };
}
const nullRatio = p => (p.null_pct > 1 ? p.null_pct / 100 : p.null_pct);
const SAP = { material_master: `${UP}/Material_Master_23_09_2026.xlsx`, service_entry: `${UP}/Service_Entry_Sheet_23_09_2026.xlsx` };

/* RT-35 / RT-36: a duplicated header must never make one physical column inherit another's profile */
for (const [id, name] of [['RT-35', 'material_master'], ['RT-36', 'service_entry']]) {
  const file = SAP[name]; const skip = fs.existsSync(file) ? false : `SAP file not found (${file})`;
  test(`${id} [${name}] every duplicate-header column is profiled from ITS OWN cells and its CONTENT survives parsing (an empty twin stays empty; different columns stay different)`, { skip }, () => {
    const truth = physicalColumns(file); const bad = [];
    assert.ok(truth.duplicateGroups.length > 0, 'expected the SAP file to contain duplicate headers (fixture drift?)');
    // (a) content survives parsing: for each duplicate group, the engine's ingest must still carry one column per physical column, with each column's distinct-value count intact
    const parsed = parseColumns(file);
    for (const [header, group] of truth.duplicateGroups) {
      const got = parsed.filter(c => c.header === header).map(c => new Set(c.values.filter(v => v != null && String(v).trim() !== '').map(v => String(v).trim())).size).sort((a, b) => a - b);
      const want = group.map(c => c.distinct).sort((a, b) => a - b);
      if (JSON.stringify(got) !== JSON.stringify(want)) bad.push(`"${header}": file has ${group.length} columns with distinct-value counts [${want}], parsed rows carry [${got}]`);
    }
    // (b) each physical column is PROFILED from its own cells
    const P = profileFile(file).profiles;
    for (const [header, group] of truth.duplicateGroups) for (const c of group) {
      const p = P.find(x => x.index === c.index); if (!p) { bad.push(`${header}[#${c.index}]: no profile`); continue; }
      const gotRatio = 1 - nullRatio(p); if (Math.abs(gotRatio - c.ratio) > 0.02) bad.push(`${header}[#${c.index}]: file populated=${(c.ratio * 100).toFixed(1)}% engine populated=${(gotRatio * 100).toFixed(1)}%`);
    }
    assert.deepEqual(bad, [], 'duplicate-header columns collapsed / mis-profiled');
  });
}

describe('minimal-fixture findings', () => {
  let h; before(async () => { h = await boot(); });
  const run = async (name, rows, header = HEAD, keyCol = 'ID') => { const r = await H.runFile(h, H.writeFile(h, `${name}.csv`, H.csv(header, rows))); assert.equal(r.status, 'complete', r.error); return { r, v: H.view(h, r.runId, keyCol), dash: null }; };
  const rowOf = (over, i) => ent(i, over);

  it('RT-37 a row identifier named Record_ID is never business evidence: it cannot appear in cluster factors, cluster conflicts or conflict groups', async () => {
    const H2 = HEAD.map(c => (c === 'ID' ? 'Record_ID' : c)); const a = ent(1, { Company_Name: 'Kalinga Steel Works', GSTIN: GST(99), Vendor_Code: 'V99' }); a[0] = 'REC-000001'; const b = a.slice(); b[0] = 'REC-000002';
    const fill = fillers(10).map((r, i) => { r[0] = `REC-9${i}`; return r; });
    const { v } = await run('rt37', [a, b, ...fill], H2, 'Record_ID');
    const blob = JSON.stringify([v.entityClusters.map(c => [c.factors, c.conflicts]), v.conflicts.map(c => [c.type, c.field, c.subject])]);
    assert.equal(/Record_ID|REC-0000/i.test(blob), false, 'row identifier leaked into evidence/conflicts: ' + blob.slice(0, 300));
    assert.equal(v.conflicts.filter(c => /record_id/i.test(c.field || '')).length, 0);
  });

  it('RT-38 (reverse GST) the SAME entity (same vendor code, name, phone and e-mail) carrying two DIFFERENT valid GSTINs is a strong identity conflict, listed as a conflict a user can review', async () => {
    const a = rowOf({ Company_Name: 'Kalinga Steel Works', GSTIN: GST(41), Vendor_Code: 'V41', Phone: '9811122233', Email: 'accounts@kalinga.example.com' }, 1);
    const b = rowOf({ Company_Name: 'Kalinga Steel Works', GSTIN: GST(42), Vendor_Code: 'V41', Phone: '9811122233', Email: 'accounts@kalinga.example.com' }, 2);
    const { v } = await run('rt38', [a, b, ...fillers(10)]);
    const listed = v.conflicts.filter(c => c.members.includes('ROW-001') && c.members.includes('ROW-002'));
    assert.ok(listed.length >= 1, 'identical vendor code/name/phone/e-mail with two different valid GSTINs produced no conflict record (a remark inside a cluster does not count)');
    assert.equal(listed.length, 1, `${listed.length} conflict records for one member set (must be exactly one)`);
  });

  it('RT-39 (vendor-code identity) one vendor code shared by two UNRELATED entities is an identity conflict, not silently ignored or merged', async () => {
    const a = rowOf({ Company_Name: 'Aster Marine Foods', GSTIN: GST(51), Vendor_Code: 'V-SHARED' }, 1), b = rowOf({ Company_Name: 'Bharat Cable Industries', GSTIN: GST(52), Vendor_Code: 'V-SHARED' }, 2);
    const { v } = await run('rt39', [a, b, ...fillers(10)]);
    const both = c => c.members.includes('ROW-001') && c.members.includes('ROW-002');
    assert.ok(v.conflicts.some(both), 'a vendor code shared by two unrelated companies raised no conflict');
    assert.equal(v.entityClusters.some(c => both(c)), false, 'two unrelated companies were merged only because they share a vendor code');
  });

  it('RT-40 range / format rules: PIN code, quantity, price and tax-rate values that are impossible are flagged', async () => {
    const H2 = [...HEAD, 'Quantity', 'Unit_Price', 'Tax_Rate']; const ok = (i) => [...ent(i), 10, 250, 18];
    const rows = [ok(1), ok(2), ok(3), ok(4), ok(5), ok(6), ok(7), ok(8)];
    rows[0][HEAD.indexOf('Postal_Code')] = '56A01Z';          // ROW-001 letters in a PIN
    rows[1][HEAD.length] = -5;                                 // ROW-002 negative quantity
    rows[2][HEAD.length + 1] = -100;                           // ROW-003 negative price
    rows[3][HEAD.length + 2] = 180;                            // ROW-004 tax rate above 100%
    const { v } = await run('rt40', rows, H2);
    const want = { 'ROW-001': /postal|pin/i, 'ROW-002': /quantity/i, 'ROW-003': /price/i, 'ROW-004': /tax/i };
    const missing = Object.entries(want).filter(([k, re]) => !v.issues.some(i => i.key === k && re.test(i.field || ''))).map(([k]) => `${k} (${want[k]})`);
    assert.deepEqual(missing, [], 'impossible values not flagged');
  });

  it('RT-42 exports carry the BUSINESS KEY (e.g. vendor code) and the source row id, not only internal UUIDs', async () => {
    const a = ent(1, { Company_Name: 'Kalinga Steel Works', GSTIN: GST(99), Vendor_Code: 'V99' }), b = a.slice(); b[0] = 'ROW-002';
    const r = await H.runFile(h, H.writeFile(h, 'rt42.csv', H.csv(HEAD, [a, b, ...fillers(10)])));
    const ex = await H.auth(h, h.request(h.app).post(`/api/runs/${r.runId}/export`)).send({ export_type: 'duplicates', format: 'csv' });
    assert.equal(ex.status, 201, JSON.stringify(ex.body));
    const dl = await H.auth(h, h.request(h.app).get(ex.body.download_url)); const text = dl.text || dl.body.toString();
    assert.match(text, /V99/, 'business key (vendor code V99) absent from the duplicates export');
    assert.match(text, /ROW-002/, 'source row business id absent from the export');
  });

  it('RT-44 (decision 1) same GSTIN + same name + DIFFERENT vendor codes = same business entity (entity match), reviewable, and NOT reported as a hard conflict', async () => {
    const a = rowOf({ Company_Name: 'Kalinga Steel Works', GSTIN: GST(61), Vendor_Code: 'V-OLD' }, 1), b = rowOf({ Company_Name: 'Kalinga Steel Works', GSTIN: GST(61), Vendor_Code: 'V-NEW' }, 2);
    const { v } = await run('rt44', [a, b, ...fillers(10)]);
    const c = v.entityClusters.find(c => c.members.includes('ROW-001') && c.members.includes('ROW-002'));
    assert.ok(c, 'same GSTIN + same name was not recognised as the same entity');
    const hard = v.conflicts.filter(x => x.members.includes('ROW-001') && x.members.includes('ROW-002'));
    assert.deepEqual(hard.map(x => `${x.type}:${x.field}`), [], 'a vendor-code difference under one GSTIN was reported as a hard identity conflict');
  });
});

/* RT-41: the S0 finding "the test suite could open and corrupt the real platform.db" -> the backend regression guard must pass */
test('RT-41 test-isolation guard: no backend test can touch the real application database or storage (runs backend/tests/testIsolation.test.js)', () => {
  const env = { ...process.env }; for (const k of ['DATA_DIR', 'DB_PATH', 'UPLOAD_DIR', 'EXPORT_DIR', 'NODE_ENV', 'NODE_TEST_CONTEXT']) delete env[k];
  const p = spawnSync(process.execPath, ['--experimental-sqlite', '--test', 'tests/testIsolation.test.js'], { cwd: path.join(REPO, 'backend'), env, encoding: 'utf8', timeout: 120000 });
  assert.match(p.stdout, /^# fail 0$/m, p.stdout.slice(-1500)); assert.match(p.stdout, /^# pass [1-9]/m); assert.equal(p.status, 0);
});

/* RT-43: production code (COMMENTS INCLUDED) must not reference test fixtures / dataset-specific identifiers. RT-08 ignores comments;
   this one does not, because a comment that names a test row ("ERP-00290") couples production code to a test file.            */
test('RT-43 production source (including comments) contains no references to test fixtures or dataset-specific identifiers', () => {
  const root = process.env.DQ_SRC_ROOT || path.join(REPO, 'backend/src'); const bad = [];
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).forEach(e => { const p = path.join(d, e.name); if (e.isDirectory()) return walk(p); if (!/\.(js|sql)$/.test(e.name)) return;
    fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => { const m = /\bERP-\d{3,}\b|ERP_DQ_Authenticity|Material_Master_\d|Service_Entry_Sheet_\d|hold-?out_master|Authenticity_Test/i.exec(line); if (m) bad.push(`${path.relative(root, p)}:${i + 1} "${m[0]}"`); }); });
  walk(root); assert.deepEqual(bad, [], 'production code references test-fixture identifiers');
});

/* ---- approved contracts whose application surface does not exist yet (S3-S7): recorded as TODO, never silently passing ---- */
const todo = t => test(t, { todo: 'contract approved with S0; implemented in a later phase' });
todo('RT-45 (decision 2) a 100%-empty REQUIRED column yields ONE dataset-level "required field missing" issue; UI distinguishes Required missing / Expected sparse / Optional not populated');
todo('RT-46 (decision 3) default stale threshold is 4 years; threshold (1/2/3/4/5/custom) and reference date are shown with every result and frozen per run');
todo('RT-47 (decision 3) record detail / any read path derives age and staleness from the run\'s frozen reference date, never from the server clock at request time (legacy GET /api/records/:id violates this)');
todo('RT-48 (decision 1) entity-match evidence view shows GSTIN same / name same-or-compatible / vendor code different, subtype identity_match_vendor_code_variant, decision same entity, no silent merge');
