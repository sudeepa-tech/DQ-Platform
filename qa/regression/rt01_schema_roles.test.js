'use strict';
/* Locks audit findings A10 (substring header matching), A10b (silent header/content conflicts), duplicate-header corruption (new in S0),
   and vocabulary generalization (hold-out). Real-SAP tests skip (not pass) if the files are absent: set DQ_SAP_DIR. */
const { test } = require('node:test'); const assert = require('node:assert/strict'); const fs = require('fs'); const path = require('path');
const { profileFile, acceptsClass } = require('../harness/engine_facade'); const REPO = path.resolve(__dirname, '..', '..'); const UP = process.env.DQ_SAP_DIR || '/mnt/user-data/uploads';
const T = n => JSON.parse(fs.readFileSync(path.join(REPO, 'qa/oracle/truth', n)));
const SAP = { material_master: [`${UP}/Material_Master_23_09_2026.xlsx`, T('material_master.baseline.json')], service_entry: [`${UP}/Service_Entry_Sheet_23_09_2026.xlsx`, T('service_entry.baseline.json')] };
const first = P => { const m = {}; P.forEach(p => { if (!m[p.column]) m[p.column] = p; }); return m; };
for (const [name, [file, base]] of Object.entries(SAP)) {
  const skip = fs.existsSync(file) ? false : `SAP file not found (${file})`;
  test(`RT-01 [${name}] no column is assigned a role its header/content contradicts (must_not_map)`, { skip }, () => {
    const F = first(profileFile(file).profiles), bad = [];
    for (const [h, forb] of Object.entries(base.expected_roles.must_not_map)) { const p = F[h]; if (p && (forb.includes(p.semantic_class) || (forb.includes('date') && /date/.test(p.role)))) bad.push(`${h} -> ${p.role}(${p.semantic_class})`); }
    assert.deepEqual(bad, [], 'forbidden assignments');
  });
  test(`RT-02 [${name}] key business columns map to the expected semantic roles (must_map)`, { skip }, () => {
    const F = first(profileFile(file).profiles), bad = [];
    for (const [h, want] of Object.entries(base.expected_roles.must_map)) { const p = F[h]; if (!p) continue; if (!want.some(w => acceptsClass(w, p.semantic_class))) bad.push(`${h}: want ${want.join('|')} got ${p.role}`); }
    assert.deepEqual(bad, [], 'wrong or missing roles');
  });
  test(`RT-03 [${name}] duplicate header cells stay distinct columns (no silent collapse / phantom populated column)`, { skip }, () => {
    const r = profileFile(file); assert.equal(r.rowKeys, r.headerCells, `header cells=${r.headerCells} but only ${r.rowKeys} data keys survive parsing -> columns silently dropped/merged`);
  });
}
test('RT-04 [service_entry] header/content conflicts are flagged for review, never silently assigned', { skip: fs.existsSync(SAP.service_entry[0]) ? false : 'SAP file not found' }, () => {
  const F = first(profileFile(SAP.service_entry[0]).profiles), bad = [];
  for (const h of Object.keys(SAP.service_entry[1].expected_roles.must_require_review)) { const p = F[h]; if (p && !p.review_required && /_date$/.test(p.role)) bad.push(`${h} silently assigned ${p.role}`); }
  assert.deepEqual(bad, []);
});
test('RT-05 [hold-out] unseen-but-conventional headers map correctly (>= 85%, pre-registered bar)', () => {
  const exp = T('../holdout.expected_roles.json'); const F = first(profileFile(path.join(REPO, 'qa/fixtures/holdout_master_entity.xlsx'), 'Vendor_Master').profiles); const wrong = [];
  let ok = 0, n = 0; for (const [h, want] of Object.entries(exp)) { if (h.startsWith('_')) continue; n++; const p = F[h]; if (p && acceptsClass(want, p.semantic_class)) ok++; else wrong.push(`${h}: want ${want} got ${p && p.role}`); }
  assert.ok(ok / n >= 0.85, `only ${ok}/${n} headers correct (${(100 * ok / n).toFixed(0)}%). wrong: ${wrong.join('; ')}`);
});
