'use strict';
/* Timezone matrix: same file parsed in child processes under each TZ; compared with openpyxl calendar-date truth.
   node qa/harness/tz_matrix.js [--adapter=legacy] [--out=file.json]   exit code 1 if any mismatch. */
const { spawnSync } = require('child_process'); const fs = require('fs'); const path = require('path');
const REPO = path.resolve(__dirname, '..', '..'); const T = JSON.parse(fs.readFileSync(path.join(REPO, 'qa/oracle/truth/dates.truth.json')));
const a = Object.fromEntries(process.argv.slice(2).map(s => s.replace(/^--/, '').split('='))); const adapter = a.adapter || 'legacy';
const UP = process.env.DQ_SAP_DIR || '/mnt/user-data/uploads';
const FILES = { service_entry: [`${UP}/Service_Entry_Sheet_23_09_2026.xlsx`, '-'], material_master: [`${UP}/Material_Master_23_09_2026.xlsx`, '-'], holdout: [path.join(REPO, 'qa/fixtures/holdout_master_entity.xlsx'), 'Vendor_Master'], erp_dump: [path.join(REPO, 'qa/fixtures/ERP_DQ_Authenticity_Test_Dump.xlsx'), 'ERP_Dump'] };
const ROLE_COL = { service_entry: 'Created On', material_master: 'Created On', holdout: 'Created On', erp_dump: 'Creation_Date' };
const validYMD = t => { const d = new Date(t + 'T00:00:00Z'); return !isNaN(d) && d.toISOString().slice(0, 10) === t; };
const results = []; let bad = 0;
for (const tz of ['Asia/Kolkata', 'UTC', 'America/New_York']) for (const [ds, [file, sheet]] of Object.entries(FILES)) {
  if (!fs.existsSync(file)) { results.push({ tz, dataset: ds, skipped: 'file not found' }); continue; }
  const cols = Object.keys(T[ds].columns);
  const p = spawnSync(process.execPath, ['--experimental-sqlite', path.join(__dirname, 'tz_child.js'), adapter, file, sheet, ...cols], { env: { ...process.env, TZ: tz, QA_ROLE_COL: ROLE_COL[ds] }, encoding: 'utf8', maxBuffer: 1 << 28 });
  const line = (p.stdout || '').split('@@')[1]; if (!line) { results.push({ tz, dataset: ds, error: (p.stderr || '').slice(-200) }); bad++; continue; }
  const o = JSON.parse(line); if (o.error) { results.push({ tz, dataset: ds, error: o.error }); bad++; continue; }
  const r = { tz, dataset: ds, columns: {}, recordLayer: {} };
  for (const c of cols) { const exp = T[ds].columns[c], got = o.columns[c]; let mism = 0, ex = null; const nz = x => (x === '' || x === undefined ? null : x); exp.forEach((v, i) => { if (nz(v) !== nz(got[i])) { mism++; if (!ex) ex = { row: i + 2, expected: v, got: got[i] }; } }); r.columns[c] = { rows: exp.length, mismatches: mism, example: ex }; if (mism) bad++; }
  // record-date layer (dates the engine persists on records) vs truth for the created-date role column
  const rc = ROLE_COL[ds], exp = T[ds].columns[rc]; let mism = 0, ex = null;
  o.recordLayer.created.forEach((v, i) => { const t = exp[i]; if (t && /^\d{4}-\d{2}-\d{2}$/.test(t) && validYMD(t) && v !== t) { mism++; if (!ex) ex = { row: i + 2, expected: t, got: v }; } });
  r.recordLayer = { engineCreatedDateColumns: o.recordLayer.createdRoleColumns, comparedAgainst: rc, mismatches: mism, example: ex, note: 'engine may map a different column to created_date (see SAP role bugs); mismatches then reflect that too' };
  if (mism) bad++; results.push(r);
}
const summary = results.map(r => r.skipped || r.error ? `${r.tz} ${r.dataset}: ${r.skipped || r.error}` : `${r.tz.padEnd(17)} ${r.dataset.padEnd(16)} parse-layer mismatches: ${Object.values(r.columns).reduce((s, c) => s + c.mismatches, 0)} | record-layer mismatches: ${r.recordLayer.mismatches}`);
console.log(summary.join('\n')); if (a.out) fs.writeFileSync(a.out, JSON.stringify({ adapter, results }, null, 1)); process.exit(bad ? 1 : 0);
