'use strict';
/* Minimal fixtures for scoring/uniqueness noise (A5), transaction semantics, re-run lifecycle (A13) and export lineage (A13). */
const { describe, it, before } = require('node:test'); const assert = require('node:assert/strict');
const { H, GST, HEAD, ent, fillers, boot } = require('./_lib'); let h;
describe('rules, scoring, lifecycle (minimal fixtures)', () => {
  before(async () => { h = await boot(); });
  it('RT-16 repeated Item_Code across otherwise-unique master rows is NOT a uniqueness defect', async () => {
    const H2 = [...HEAD, 'Item_Code', 'Item_Description']; const rows = Array.from({ length: 30 }, (_, i) => [...ent(i + 1), `MAT-${1000 + (i % 3)}`, ['Bearing 6205', 'Bolt M10', 'Cable 2.5 SQMM'][i % 3]]);
    const r = await H.runFile(h, H.writeFile(h, 'rt16.csv', H.csv(H2, rows))); assert.equal(r.status, 'complete', r.error); const v = H.view(h, r.runId, 'ID'); const d = await H.dashboard(h, r.runId);
    const n = v.issues.filter(i => i.type === 'duplicate_identifier').length; assert.equal(n, 0, `${n} duplicate_identifier issues raised on repeated item codes`); assert.equal(d.health.breakdown.uniqueness.score, 100);
  });
  it('RT-17 [S8] an honestly UNCERTAIN dataset type (this fixture\'s own evidence is genuinely split ~41/30/29% across transaction/master_entity/master_material) is NEVER silently auto-confirmed -- explicit human confirmation is mandatory, enforced at the service boundary, not just the route; once confirmed as \'transaction\', identical lines on DIFFERENT invoice numbers are correctly NOT duplicates', async () => {
    // Through S7 this test uploaded-and-analyzed with no review step at all, expecting a silent 'complete'. The S6 gate
    // (decision 2) and the S8 charter both make that the wrong behavior for THIS fixture: it doesn't have enough
    // decisive evidence for any one dataset type, so the classifier itself marks it needs_review, and the confirmed
    // policy is that an uncertain dataset type may NEVER auto-confirm for any caller. This test now proves both halves:
    // the block, with full detail, and -- once a human explicitly decides -- the original guard the test was written for.
    const T = ['Invoice_No', 'Vendor_Code', 'Vendor_Name', 'Item_Code', 'Item_Description', 'Quantity', 'Unit_Price', 'Posting_Date']; const rows = Array.from({ length: 24 }, (_, i) => [`INV-${1000 + i}`, 'V1', 'Apex Traders', 'MAT-1', 'Bearing 6205', 10, 100, '2025-04-01']);
    const u = await H.upload(h, H.writeFile(h, 'rt17.csv', H.csv(T, rows)));
    const blocked = await H.analyze(h, u.datasetId); assert.equal(blocked.analyzeStatus, 409); const body = JSON.parse(blocked.error);
    assert.equal(body.review_required, true); const bf = body.files[0]; assert.equal(bf.reason, 'dataset_type_uncertain');
    assert.ok(bf.dataset_type && typeof bf.dataset_type.confidence === 'number' && Array.isArray(bf.dataset_type.reasons) && bf.dataset_type.reasons.length > 0 && Array.isArray(bf.dataset_type.alternatives) && bf.dataset_type.alternatives.length > 0, 'the refusal carries classification, confidence, reasons and alternatives');
    assert.match(bf.required_action, /dataset-type/);
    await H.auth(h, h.request(h.app).post(`/api/schema/sources/${u.fileId}/suggest`));
    const setType = await H.auth(h, h.request(h.app).patch(`/api/schema/sources/${u.fileId}/versions/1/dataset-type`)).send({ dataset_type: 'transaction' });
    assert.equal(setType.status, 200); assert.equal(setType.body.dataset_type.source, 'user');
    const a = await H.analyze(h, u.datasetId); assert.equal(a.status, 'complete', a.error);
    const d = await H.dashboard(h, a.runId);
    assert.equal(d.summary.potential_duplicate_records, 0, 'unique document numbers, yet reported as duplicates'); assert.equal(H.view(h, a.runId, 'Invoice_No').issues.filter(i => i.type === 'duplicate_identifier').length, 0);
  });
  it('RT-18 an analysis can be re-run on the same dataset without re-uploading', async () => {
    const u = await H.upload(h, H.writeFile(h, 'rt18.csv', H.csv(HEAD, fillers(12)))); const a = await H.analyze(h, u.datasetId); assert.equal(a.status, 'complete', a.error);
    const b = await H.analyze(h, u.datasetId); assert.equal(b.analyzeStatus, 202, `second analyze -> HTTP ${b.analyzeStatus}: ${b.error}`);
  });
  it('RT-19 exports preserve lineage: source file, sheet, row number and business keys (not raw UUIDs only)', async () => {
    const a = ent(1, { Company_Name: 'Kalinga Steel Works', GSTIN: GST(99), Vendor_Code: 'V99' }), b = a.slice(); b[0] = 'ROW-002';
    const r = await H.runFile(h, H.writeFile(h, 'rt19.csv', H.csv(HEAD, [a, b, ...fillers(10)]))); const ex = await H.auth(h, h.request(h.app).post(`/api/runs/${r.runId}/export`)).send({ export_type: 'duplicates', format: 'csv' });
    assert.equal(ex.status, 201, JSON.stringify(ex.body)); const dl = await H.auth(h, h.request(h.app).get(ex.body.download_url)); const text = dl.text || dl.body.toString(); const header = text.split('\n')[0];
    const need = { 'source file': /file/i, 'source sheet': /sheet/i, 'source row': /row/i }; const missing = Object.entries(need).filter(([, re]) => !re.test(header)).map(([k]) => k);
    assert.deepEqual(missing, [], 'lineage columns missing from export header [' + header + ']'); assert.match(text, /V99/, 'business key (vendor code V99) absent from the duplicates export'); assert.match(text, /ROW-002/, 'source row business id absent from the export');
  });
});
