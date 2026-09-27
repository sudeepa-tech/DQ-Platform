'use strict';
/* S4: the configurable rules layer on all four real datasets, judged by the INDEPENDENT oracle (never by the engine's own output).
   Path under test: S2 canonical ingest -> S3 mapping (confirmed) -> immutable configuration snapshot -> S4 rules. Expectations come from the truth files / headers baselines.
   Stricter than the scorer: (record, field) PAIRS must match, not only record sets. */
const { describe, it, before } = require('node:test'); const assert = require('node:assert/strict'); const fs = require('fs'); const path = require('path');
const A = require('../harness/rules_v1'); const REPO = path.resolve(__dirname, '..', '..'); const UP = process.env.DQ_SAP_DIR || '/mnt/user-data/uploads'; const J = p => JSON.parse(fs.readFileSync(path.join(REPO, p)));
const GOLD = [{ n: 'ERP_Dump', file: 'qa/fixtures/ERP_DQ_Authenticity_Test_Dump.xlsx', sheet: 'ERP_Dump', truth: 'erp_dump.truth.json' }, { n: 'hold-out', file: 'qa/fixtures/holdout_master_entity.xlsx', sheet: 'Vendor_Master', truth: 'holdout.truth.json' }];
const SAP = [{ n: 'material_master', file: `${UP}/Material_Master_23_09_2026.xlsx` }, { n: 'service_entry', file: `${UP}/Service_Entry_Sheet_23_09_2026.xlsx` }];
const abs = f => (path.isAbsolute(f) ? f : path.join(REPO, f)); const pairs = (fs_, pick) => new Set(fs_.map(pick));
const setEq = (a, b) => ({ missing: [...b].filter(x => !a.has(x)), extra: [...a].filter(x => !b.has(x)) });
const dayNum = s => Date.parse(s + 'T00:00:00Z') / 86400000;

for (const g of GOLD) describe(`RT-80 [${g.n}] rules vs the independent oracle`, () => {
  let out, T, F; before(() => { T = J('qa/oracle/truth/' + g.truth); out = A.analyzeFile(abs(g.file), { sheet: g.sheet }); F = out.result.findings; });
  it('missing data: exactly the (record, field) pairs the oracle lists', () => { const got = pairs(F.filter(f => f.category === 'completeness' && f.scope === 'record'), f => f.record_key + '|' + f.header_raw.trim()); const want = new Set(Object.entries(T.missing.records).flatMap(([k, fl]) => fl.map(x => k + '|' + x))); assert.deepEqual(setEq(got, want), { missing: [], extra: [] }); assert.ok(want.size > 0); });
  it('invalid data: exactly the (record, field) pairs the oracle lists, every rule family (GSTIN, e-mail, phone, PIN, quantity, price, tax rate, dates)', () => { const got = pairs(F.filter(f => f.category === 'validity' && f.scope === 'record'), f => f.record_key + '|' + f.header_raw.trim()); const want = new Set(Object.entries(T.invalid.records).flatMap(([k, l]) => l.map(x => k + '|' + x.field))); assert.deepEqual(setEq(got, want), { missing: [], extra: [] }); assert.ok(new Set([...want].map(x => x.split('|')[1])).size >= 7, 'the oracle plants at least 7 different fields'); });
  it('temporal anomalies and future dates: exact record sets', () => { const t = new Set(F.filter(f => f.type === 'modified_before_created').map(f => f.record_key)); const fut = new Set(F.filter(f => /^future_/.test(f.type)).map(f => f.record_key)); assert.deepEqual(setEq(t, new Set(T.temporal.modified_before_created)), { missing: [], extra: [] }); assert.deepEqual(setEq(fut, new Set([...T.temporal.future_created, ...T.temporal.future_modified])), { missing: [], extra: [] }); });
  it('an entity master\'s repeated item / vendor codes are never a uniqueness defect; row ids are unique so nothing is reported', () => assert.equal(F.filter(f => f.category === 'uniqueness').length, 0));
  it('no systematic failure and no dataset-level noise on data that is genuinely mostly valid', () => assert.deepEqual(F.filter(f => f.scope !== 'record'), []));
});

describe('RT-83 stale semantics vs the oracle\'s own stale table (configurable reference date and threshold)', () => {
  for (const g of GOLD) it(`[${g.n}] threshold 4y (the default) equals the oracle exactly; other thresholds differ only on records within one day of the boundary`, () => {
    const T = J('qa/oracle/truth/' + g.truth);
    for (const row of T.stale_table) { const out = A.analyzeFile(abs(g.file), { sheet: g.sheet, today: row.reference_date, staleYears: row.threshold_years }); const got = new Set(out.result.findings.filter(f => f.type === 'stale_record').map(f => f.record_key)); const want = new Set(row.records);
      const d = setEq(got, want); const boundary = k => { const r = T.records[k]; return r && r.modified && Math.abs(dayNum(row.reference_date) - dayNum(r.modified) - row.threshold_days) < 1; };
      if (row.threshold_years === 4) assert.deepEqual(d, { missing: [], extra: [] }, `4y at ${row.reference_date}`); else assert.ok([...d.missing, ...d.extra].every(boundary), `${row.threshold_years}y at ${row.reference_date}: differences beyond the 365.25-day boundary tolerance: ${[...d.missing, ...d.extra].filter(k => !boundary(k))}`);
      assert.ok(got.size > 0 || row.count === 0); }
  });
});

describe('RT-81 requiredness discipline on all four real datasets', () => {
  const ALL = [...GOLD.map(g => ({ ...g, file: abs(g.file) })), ...SAP.map(s => ({ ...s, skip: !fs.existsSync(s.file) && 'SAP file not found (set DQ_SAP_DIR)' }))];
  for (const d of ALL) it(`[${d.n}] optional and unidentified columns raise no completeness finding; a dataset-level finding exists only for an empty REQUIRED / EXPECTED column`, { skip: d.skip }, () => {
    const out = A.analyzeFile(d.file, { sheet: d.sheet }); const req = Object.fromEntries(out.model.columns.map(c => [c.header_key, c.requiredness.value])); const F = out.result.findings;
    assert.deepEqual(F.filter(f => f.category === 'completeness' && !['required', 'expected'].includes(req[f.header_key])).map(f => f.header_raw), []);
    for (const f of F.filter(f => f.scope === 'dataset' && f.rule_id === 'completeness.column_empty')) { assert.ok(['required', 'expected'].includes(req[f.header_key])); assert.equal(f.evidence.populated, 0); }
    const excluded = new Set(out.model.columns.filter(c => !c.include_in_analysis).map(c => c.header_key)); assert.deepEqual(F.filter(f => excluded.has(f.header_key)).length, 0, 'excluded columns are out of every rule'); assert.ok(out.result.summary.rows >= 300);
  });
  for (const d of SAP) it(`RT-82 [${d.n}] no rule is mis-applied: no systematic-failure finding, no (column, rule) failing on >=90% of populated values, nothing on the fully empty columns`, { skip: !fs.existsSync(d.file) && 'SAP file not found' }, () => {
    const out = A.analyzeFile(d.file); const F = out.result.findings; const cols = J(`qa/fixtures/headers/${d.n}.headers.json`).columns; const empty = new Set(cols.filter(c => c.state === 'empty').map(c => c.header.trim())); const pop = {}; cols.forEach(c => { if (!(c.header.trim() in pop)) pop[c.header.trim()] = Math.round(c.populated_ratio * out.result.summary.rows); });
    assert.equal(F.filter(f => f.rule_id === 'validity.systematic_failure').length, 0); assert.deepEqual(F.filter(f => f.header_raw && empty.has(f.header_raw.trim())).length, 0, `${empty.size} completely empty columns`);
    const per = {}; F.filter(f => f.scope === 'record' && f.category !== 'freshness').forEach(f => { const k = f.header_raw.trim() + ' :: ' + f.type; (per[k] = per[k] || new Set()).add(f.row_number); });
    assert.deepEqual(Object.entries(per).filter(([k, s]) => pop[k.split(' :: ')[0]] > 0 && s.size / pop[k.split(' :: ')[0]] >= 0.9).map(([k]) => k), []);
  });
});

describe('RT-29 [S4] reference date and stale threshold are run-configurable; a changed setting changes ONLY the affected results', () => {
  it('[hold-out] threshold and reference date move only freshness / future-date findings; every other finding is byte-identical', () => {
    const g = GOLD[1]; const run = o => A.analyzeFile(abs(g.file), { sheet: g.sheet, ...o }).result; const base = run({}); const ids = (r, drop) => r.findings.filter(f => !drop.includes(f.category + '.' + f.type)).map(f => f.id).join();
    const stale = r => new Set(r.findings.filter(f => f.type === 'stale_record').map(f => f.id)); const drop = ['freshness.stale_record'];
    for (const y of [1, 2, 3, 5, 1.5]) { const r = run({ staleYears: y }); assert.equal(ids(r, drop), ids(base, drop), `threshold ${y}y`); assert.notEqual(r.provenance.results_hash, base.provenance.results_hash); assert.equal(r.provenance.stale_threshold_years, y); }
    const tighter = stale(run({ staleYears: 2 })), looser = stale(run({ staleYears: 5 })); assert.ok(tighter.size > stale(base).size && stale(base).size > looser.size); assert.ok([...stale(base)].every(x => tighter.has(x)) && [...looser].every(x => stale(base).has(x)));
    const later = run({ today: '2029-01-01' }); assert.equal(ids(later, [...drop, 'consistency.future_created_date', 'consistency.future_modified_date']), ids(base, [...drop, 'consistency.future_created_date', 'consistency.future_modified_date'])); assert.ok(stale(later).size > stale(base).size); assert.equal(later.provenance.reference_date, '2029-01-01');
  });
});
describe('RT-66 [S4] requiredness -> severity is versioned rule configuration', () => {
  it('[hold-out] optional gaps are not defects; required = high/critical; expected = low/medium; the mapping is configuration with a version and a hash', () => {
    const g = GOLD[1]; const out = A.analyzeFile(abs(g.file), { sheet: g.sheet }); const F = out.result.findings; const sev = r => new Set(F.filter(f => f.rule_id === r).map(f => f.severity));
    assert.ok(F.some(f => f.rule_id === 'completeness.expected_missing')); for (const s of sev('completeness.required_missing')) assert.ok(['high', 'critical'].includes(s)); for (const s of sev('completeness.expected_missing')) assert.ok(['low', 'medium'].includes(s));
    const pr = out.result.provenance; assert.ok(/^rule-config-/.test(pr.rule_config_version) && /^[0-9a-f]{64}$/.test(pr.rule_config_hash));
    const alt = A.analyzeFile(abs(g.file), { sheet: g.sheet, ruleOverrides: { policies: { completeness: { severity: { required: 'critical', expected: 'medium' } } } } }).result; assert.notEqual(alt.provenance.rule_config_hash, pr.rule_config_hash); assert.ok(alt.findings.filter(f => f.rule_id === 'completeness.expected_missing').every(f => f.severity === 'medium'), 'the severity mapping is configuration, not code');
    assert.equal(alt.findings.length, out.result.findings.length, 'severity configuration changes severities, never which records are flagged');
  });
});
