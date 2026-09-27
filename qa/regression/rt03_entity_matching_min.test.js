'use strict';
/* Minimal, self-explanatory fixtures for the identity-matching defects (audit A1-A4, A7, A9). Each asserts APPROVED behaviour. */
const { describe, it, before } = require('node:test'); const assert = require('node:assert/strict'); const path = require('path');
const { H, GST, HEAD, ent, fillers, boot, together } = require('./_lib');
let h; const run = async (name, rows, extra = HEAD) => { const f = H.writeFile(h, name + '.csv', H.csv(extra, rows)); const r = await H.runFile(h, f); assert.equal(r.status, 'complete', r.error); return { r, v: H.view(h, r.runId, 'ID'), dash: await H.dashboard(h, r.runId) }; };
describe('entity matching (minimal fixtures)', () => {
  before(async () => { h = await boot(); });
  it('RT-09 five different entities sharing city + street pattern (real ERP_Dump rows) are NOT clustered', async () => {
    const f = path.join(H.REPO, 'qa/fixtures/min/fp_cluster_5_distinct_entities.csv'); const r = await H.runFile(h, f); const v = H.view(h, r.runId, 'Record_ID');
    assert.deepEqual(v.entityClusters.filter(c => c.members.length > 1).map(c => c.members), [], 'distinct GSTIN + vendor code + name = different entities');
  });
  it('RT-10 numeric-suffix names with different hard IDs ("... 05" vs "... 06") are NOT auto-clustered', async () => {
    const { v } = await run('rt10', [ent(1, { Company_Name: 'Shree Logistics 05', City: 'Cuttack', Address: '29 Industrial Estate, Cuttack' }), ent(2, { Company_Name: 'Shree Logistics 06', City: 'Cuttack', Address: '49 Industrial Estate, Cuttack' }), ...fillers(10)]);
    assert.equal(together(v, 'ROW-001', 'ROW-002'), false);
  });
  it('RT-11 same vendor code + one-typo name, no other corroboration -> duplicate cluster (hard-ID agreement is evidence)', async () => {
    const { v } = await run('rt11', [ent(1, { Company_Name: 'Apex Industrial Supplies', GSTIN: '', Vendor_Code: 'V900', Email: 'a@one.example.com', Phone: '9811100001' }), ent(2, { Company_Name: 'Apex Industiral Supplies', GSTIN: '', Vendor_Code: 'V900', Email: 'b@two.example.com', Phone: '9822200002' }), ...fillers(10)]);
    assert.equal(together(v, 'ROW-001', 'ROW-002'), true);
  });
  it('RT-12 same GSTIN but unrelated names and vendor codes -> conflict raised, NOT merged (guard)', async () => {
    const { v } = await run('rt12', [ent(1, { Company_Name: 'Kalinga Steel Works', GSTIN: GST(77), Vendor_Code: 'V50' }), ent(2, { Company_Name: 'Utkal Paper Mills', GSTIN: GST(77), Vendor_Code: 'V51' }), ...fillers(10)]);
    assert.equal(together(v, 'ROW-001', 'ROW-002'), false, 'merged'); assert.ok(v.conflicts.some(c => c.members.includes('ROW-001') && c.members.includes('ROW-002')), 'no conflict raised');
  });
  it('RT-13 record with missing name but agreeing GSTIN + vendor code joins its entity cluster', async () => {
    const { v } = await run('rt13', [ent(1, { Company_Name: 'Kalinga Steel Works', GSTIN: GST(88), Vendor_Code: 'V88' }), ent(2, { Company_Name: '', GSTIN: GST(88), Vendor_Code: 'V88', Email: 'accounts1@firm1.example.com', Phone: ent(1)[6] }), ...fillers(10)]);
    assert.equal(together(v, 'ROW-001', 'ROW-002'), true);
  });
  it('RT-14 malformed GSTIN is a validity issue, not "conflicting hard evidence" (record still matches by vendor code + name)', async () => {
    const { v } = await run('rt14', [ent(1, { Company_Name: 'Kalinga Steel Works', GSTIN: GST(66), Vendor_Code: 'V66' }), ent(2, { Company_Name: 'Kalinga Steel Works', GSTIN: '21ABCDE12', Vendor_Code: 'V66' }), ...fillers(10)]);
    const c = v.entityClusters.find(c => c.members.includes('ROW-001') && c.members.includes('ROW-002')); assert.ok(c, 'not matched');
    assert.equal(JSON.stringify(c.conflicts).match(/gstin/i), null, 'malformed GSTIN reported as a conflicting identifier: ' + JSON.stringify(c.conflicts));
  });
  it('RT-15 exact master duplicates (differ only in row id) are surfaced in the duplicate KPI, and the row id is never evidence or conflict', async () => {
    const a = ent(1, { Company_Name: 'Kalinga Steel Works', GSTIN: GST(99), Vendor_Code: 'V99' }), b = a.slice(); b[0] = 'ROW-002';
    const { v, dash } = await run('rt15', [a, b, ...fillers(10)]); const c = v.entityClusters.find(c => c.members.includes('ROW-001') && c.members.includes('ROW-002')); assert.ok(c, 'not clustered');
    assert.ok(dash.summary.potential_duplicate_records >= 2, `duplicate KPI = ${dash.summary.potential_duplicate_records}; exact duplicate master rows are hidden from the headline`);
    assert.equal(JSON.stringify([c.factors, c.conflicts]).match(/\bID\b/), null, 'row identifier used as business evidence/conflict');
  });
});
