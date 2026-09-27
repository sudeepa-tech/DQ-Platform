'use strict';
/* Real SAP exports as first-class validation data. Invariants derived from independent baselines (qa/oracle/truth/*.baseline.json), not from any engine run. */
const { describe, it, before } = require('node:test'); const assert = require('node:assert/strict'); const fs = require('fs'); const path = require('path');
const { H, boot } = require('./_lib'); const REPO = path.resolve(__dirname, '..', '..'); const UP = process.env.DQ_SAP_DIR || '/mnt/user-data/uploads';
const J = p => JSON.parse(fs.readFileSync(path.join(REPO, p)));
const DS = { material_master: { file: `${UP}/Material_Master_23_09_2026.xlsx`, key: 'Material' }, service_entry: { file: `${UP}/Service_Entry_Sheet_23_09_2026.xlsx`, key: 'Entry Sheet' } };
let h; const R = {};
describe('real SAP exports', () => {
  before(async () => { h = await boot(); for (const [n, d] of Object.entries(DS)) { if (!fs.existsSync(d.file)) continue; const r = await H.runFile(h, d.file, { name: n }); R[n] = { r, v: r.status === 'complete' ? H.view(h, r.runId, d.key) : null, dash: r.status === 'complete' ? await H.dashboard(h, r.runId) : null, cols: J(`qa/fixtures/headers/${n}.headers.json`).columns, base: J(`qa/oracle/truth/${n}.baseline.json`) }; } });
  for (const n of Object.keys(DS)) {
    const skip = fs.existsSync(DS[n].file) ? false : 'SAP file not found (set DQ_SAP_DIR)';
    it(`RT-20 [${n}] analysis completes`, { skip }, () => assert.equal(R[n].r.status, 'complete', R[n].r.error));
    it(`RT-21 [${n}] 100%-empty columns generate no record-level issues`, { skip }, () => {
      const empty = new Set(R[n].cols.filter(c => c.state === 'empty').map(c => c.header)); const by = {}; R[n].v.issues.filter(i => i.field && empty.has(i.field)).forEach(i => by[i.field] = (by[i.field] || 0) + 1);
      assert.deepEqual(Object.keys(by).length, 0, `${Object.values(by).reduce((a, b) => a + b, 0)} issues on ${Object.keys(by).length} completely empty columns, e.g. ${Object.entries(by).slice(0, 3).map(([k, v]) => k + ':' + v)}`); });
    it(`RT-22 [${n}] no (column, rule) pair fails on >=90% of populated values (that signals a mis-applied rule, not bad data)`, { skip }, () => {
      const pop = {}; R[n].cols.forEach(c => { if (!(c.header in pop)) pop[c.header] = Math.round(c.populated_ratio * R[n].v.records.size); }); const per = {};
      R[n].v.issues.filter(i => i.key && i.field && pop[i.field] > 0).forEach(i => { const k = i.field + ' :: ' + i.type; (per[k] = per[k] || new Set()).add(i.key); });
      const bad = Object.entries(per).filter(([k, s]) => s.size / pop[k.split(' :: ')[0]] >= 0.9 && !/duplicate|stale/.test(k)).map(([k, s]) => `${k} (${s.size})`); assert.deepEqual(bad, [], 'rules failing on essentially every value'); });
  }
  it('RT-23 [material_master] the exact-description duplicate groups (independent baseline) surface as duplicate/material-match candidates', { skip: !fs.existsSync(DS.material_master.file) && 'SAP file not found' }, () => {
    const groups = R.material_master.base.material_duplicates.exact_normalized_description_groups.map(g => g.materials); const cl = [...R.material_master.v.entityClusters, ...R.material_master.v.itemClusters].map(c => new Set(c.members));
    const missing = groups.filter(g => !cl.some(s => g.every(m => s.has(m)))); assert.deepEqual(missing, [], `${missing.length}/${groups.length} identical-description material groups never surfaced`); });
  it('RT-24 [service_entry] unique document keys (Entry Sheet) never reported as duplicates (guard)', { skip: !fs.existsSync(DS.service_entry.file) && 'SAP file not found' }, () => {
    assert.equal(R.service_entry.dash.summary.potential_duplicate_records, 0); assert.equal(R.service_entry.v.issues.filter(i => i.type === 'duplicate_identifier' && i.field === 'Entry Sheet').length, 0); });
});
