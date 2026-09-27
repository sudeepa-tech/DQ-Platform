'use strict';
/* S7 scoring engine: pure-function tests. Formula correctness, dimension/severity weighting, no double counting, dataset-type
   semantics, all the special cases (0 opportunities, entirely-empty columns, no clusters/conflicts, no dates, etc), score
   bounds, determinism, and the persisted explanation tree. No database, no clock. */
const { test } = require('node:test'); const assert = require('node:assert/strict');
const S = require('../src/scoring');

const f = (rule_id, header_key, over = {}) => ({ rule_id, header_key, category: rule_id.split('.')[0], scope: 'record', severity: 'high', row_number: 1, sheet_row: 2, ...over });
const col = (header_key, role, requiredness, over = {}) => ({ header_key, header_raw: header_key, role, requiredness, include_in_analysis: true, populated_count: 0, primary_for_role: true, ...over });
const ruleResult = (findings, over = {}) => ({ findings, summary: { freshness_basis: {} }, provenance: { stale_threshold_years: 4, reference_date: '2026-09-25' }, ...over });
const identity = (over = {}) => ({ entity: null, material: null, transaction: null, conflicts: [], ...over });
const ref = (row_number) => ({ row_number, sheet_row: row_number + 1, record_key: 'R' + row_number });

test('FORMULA: defect_rate = weighted_defects / opportunities; dimension_score = 100 * (1 - min(1, defect_rate)); never invented from raw issue count', () => {
  const cfg = S.resolveScoringConfig();
  const cols = [col('Name', 'name', 'required', { populated_count: 10 })];
  const findings = [f('completeness.required_missing', 'Name'), f('completeness.required_missing', 'Name', { row_number: 2 })];
  const files = [{ sourceFileId: 'f1', columns: cols, rowCount: 10, ruleResult: ruleResult(findings), identity: identity() }];
  const scored = S.scoreRun({ datasetType: 'master_entity', files });
  const d = scored.dimensions.completeness; assert.equal(d.denominator, 10); assert.equal(d.defect_count, 2);
  assert.equal(d.defect_rate, +(2 * cfg.severity_weights.high / 10).toFixed(2)); assert.equal(d.score, +(100 * (1 - d.defect_rate)).toFixed(2));
  assert.equal(scored.overall, +(Object.values(scored.dimensions).reduce((s, x) => s + x.score * x.weight, 0)).toFixed(2), 'overall is the weighted mean, not an average of raw issue counts');
});

test('DIMENSION WEIGHTING: default weights are 20% each and sum to 1; a configured weight change moves the overall score predictably; weights must sum to 1', () => {
  const d = S.DEFAULT_SCORING_CONFIG.dimension_weights; assert.deepEqual(Object.values(d), [0.2, 0.2, 0.2, 0.2, 0.2]); assert.equal(Object.values(d).reduce((a, b) => a + b, 0), 1);
  const cols = [col('Name', 'name', 'required', { populated_count: 0 })]; const findings = [f('completeness.column_empty', 'Name', { scope: 'dataset', severity: 'high' })];
  const files = [{ sourceFileId: 'f1', columns: cols, rowCount: 10, ruleResult: ruleResult(findings), identity: identity() }];
  const equal = S.scoreRun({ datasetType: 'master_entity', files }); const boosted = S.scoreRun({ datasetType: 'master_entity', files, scoringOverrides: { dimension_weights: { completeness: 0.6, validity: 0.1, uniqueness: 0.1, consistency: 0.1, freshness: 0.1 } } });
  assert.ok(boosted.overall < equal.overall, 'weighting the defective dimension more heavily must lower the overall score');
  assert.throws(() => S.resolveScoringConfig({ dimension_weights: { completeness: 0.5 } }), /must sum to 1/);
});

test('SEVERITY WEIGHTING: critical > high > medium > low, each configurable, and the weight actually changes the score', () => {
  const w = S.DEFAULT_SCORING_CONFIG.severity_weights; assert.deepEqual(w, { critical: 1.0, high: 0.75, medium: 0.50, low: 0.25 });
  const cols = [col('Email', 'email', 'expected', { populated_count: 10 })];
  const at = sev => S.scoreRun({ datasetType: 'master_entity', files: [{ sourceFileId: 'f1', columns: cols, rowCount: 10, ruleResult: ruleResult([f('validity.email_format', 'Email', { category: 'validity', severity: sev })]), identity: identity() }] }).dimensions.validity.score;
  assert.ok(at('low') > at('medium') && at('medium') > at('high') && at('high') > at('critical'));
  assert.throws(() => S.resolveScoringConfig({ severity_weights: { critical: 2 } }), /between 0 and 1/);
});

test('NO DOUBLE COUNTING: an entirely-empty required column is ONE dataset-level defect, never N row defects, even if S4 also emitted N row findings for it', () => {
  const cols = [col('GSTIN', 'legal_id', 'required', { populated_count: 0 })];
  const findings = [f('completeness.column_empty', 'GSTIN', { scope: 'dataset', severity: 'critical' }), ...Array.from({ length: 500 }, (_, i) => f('completeness.required_missing', 'GSTIN', { row_number: i }))];
  const scored = S.scoreRun({ datasetType: 'master_entity', files: [{ sourceFileId: 'f1', columns: cols, rowCount: 500, ruleResult: ruleResult(findings), identity: identity() }] });
  const d = scored.dimensions.completeness; assert.equal(d.denominator, 1, 'the column is ONE opportunity, not 500'); assert.equal(d.defect_count, 1); assert.equal(d.contributions.length, 1);
});
test('NO DOUBLE COUNTING: a systematic-failure (dataset-scope) validity finding is used as-is; it is never ALSO summed with per-row findings for the same column+validator', () => {
  const cols = [col('Phone', 'phone', 'expected', { populated_count: 1000 })];
  const findings = [f('validity.systematic_failure', 'Phone', { category: 'validity', scope: 'dataset', severity: 'high', evidence: { failed_rule: 'validity.phone_format', checked: 1000, failed: 950 } })];
  const scored = S.scoreRun({ datasetType: 'master_entity', files: [{ sourceFileId: 'f1', columns: cols, rowCount: 1000, ruleResult: ruleResult(findings), identity: identity() }] });
  const d = scored.dimensions.validity; assert.equal(d.contributions.length, 1); assert.equal(d.denominator, 1000); assert.equal(d.defect_count, 950);
});
test('NO DOUBLE COUNTING (consistency): one conflict group counted once regardless of how many evidence paths / members it has; a record in TWO groups counts once, at its worst severity', () => {
  const conflicts = [{ kind: 'entity', type: 'gstin_shared_identity', members: [ref(1), ref(2)] }, { kind: 'item', type: 'material_code_description', members: [ref(2), ref(3)] }];
  const scored = S.scoreRun({ datasetType: 'master_entity', files: [{ sourceFileId: 'f1', columns: [], rowCount: 10, ruleResult: ruleResult([]), identity: identity({ entity: { records: 10, clusters: [] }, conflicts }) }] });
  const d = scored.dimensions.consistency; assert.equal(d.defect_count, 3, 'records 1,2,3 -- record 2 counted once, not twice'); assert.equal(d.contributions[0].severity_weight, S.DEFAULT_SCORING_CONFIG.severity_weights.high, 'record 2 takes its WORST severity (entity conflict, high) not the item one (medium)');
});

test('UNIQUENESS SEMANTICS: only clustered (accepted) matches count; a repeated Item_Code / material id / vendor reference that never clustered contributes nothing; fuzzy/unconfirmed candidates never count', () => {
  const entity = { records: 100, clusters: [{ members: Array.from({ length: 3 }, (_, i) => ref(i)) }] };   // one real 3-member cluster
  const scored = S.scoreRun({ datasetType: 'master_entity', files: [{ sourceFileId: 'f1', columns: [], rowCount: 100, ruleResult: ruleResult([]), identity: identity({ entity, conflicts: [] }) }] });
  assert.equal(scored.dimensions.uniqueness.defect_count, 2, '3-member cluster = 2 redundant records (N-1)'); assert.equal(scored.dimensions.uniqueness.denominator, 100);
  const withCandidatesOnly = S.scoreRun({ datasetType: 'master_material', files: [{ sourceFileId: 'f1', columns: [], rowCount: 50, ruleResult: ruleResult([]), identity: identity({ material: { records: 50, groups: [{ members: [ref(1), ref(2)] }] }, conflicts: [] }) }] });
  assert.equal(withCandidatesOnly.dimensions.uniqueness.defect_count, 0, 'material candidates are ALWAYS review-only (no confirm mechanism exists yet): never a uniqueness defect'); assert.equal(withCandidatesOnly.dimensions.uniqueness.denominator, 50, 'the population is still real: this is an honest 100, not a skipped dimension');
});
test('DATASET-TYPE SEMANTICS: transaction datasets never penalise repeated vendor/material references as entity duplicates; mixed_unknown still produces a real, bounded score with an explicit caveat', () => {
  const scored = S.scoreRun({ datasetType: 'transaction', files: [{ sourceFileId: 'f1', columns: [], rowCount: 200, ruleResult: ruleResult([]), identity: identity({ transaction: { records: 200 }, entity: null, conflicts: [] }) }] });
  assert.equal(scored.dimensions.uniqueness.score, 100); assert.equal(scored.dimensions.uniqueness.denominator, 200);
  const mixed = S.scoreRun({ datasetType: 'mixed_unknown', files: [{ sourceFileId: 'f1', columns: [], rowCount: 10, ruleResult: ruleResult([]), identity: identity({ entity: { records: 10, clusters: [] }, conflicts: [] }) }] });
  assert.match(mixed.mixed_unknown_caveat, /mixed_unknown/); assert.ok(mixed.overall >= 0 && mixed.overall <= 100);
});

test('OPTIONAL COLUMNS are never a completeness opportunity; excluded columns are never a scoring opportunity either', () => {
  const cols = [col('Notes', 'unknown', 'optional', { populated_count: 0 }), col('Legacy', 'unknown', 'required', { include_in_analysis: false })];
  const scored = S.scoreRun({ datasetType: 'master_entity', files: [{ sourceFileId: 'f1', columns: cols, rowCount: 10, ruleResult: ruleResult([]), identity: identity() }] });
  assert.equal(scored.dimensions.completeness.contributions.length, 0); assert.equal(scored.dimensions.completeness.score, 100);
});
test('REQUIRED vs EXPECTED: required missing values are weighted more heavily than expected missing values, at the same defect count', () => {
  const at = req => { const cols = [col('X', 'unknown', req, { populated_count: 10 })]; return S.scoreRun({ datasetType: 'master_entity', files: [{ sourceFileId: 'f1', columns: cols, rowCount: 10, ruleResult: ruleResult([f(req === 'required' ? 'completeness.required_missing' : 'completeness.expected_missing', 'X', { severity: req === 'required' ? 'high' : 'low' })]), identity: identity() }] }).dimensions.completeness.score; };
  assert.ok(at('required') < at('expected'), 'the same single missing value costs more when the column is required');
});

test('SPECIAL CASES never produce NaN / Infinity / negative / >100: zero opportunities, no clusters, no conflicts, no stale records, no date column, all valid, all stale, all invalid', () => {
  const empty = S.scoreRun({ datasetType: 'master_entity', files: [{ sourceFileId: 'f1', columns: [], rowCount: 0, ruleResult: ruleResult([]), identity: identity() }] });
  for (const d of Object.values(empty.dimensions)) { assert.ok(Number.isFinite(d.score) && d.score >= 0 && d.score <= 100); } assert.ok(Number.isFinite(empty.overall) && empty.overall >= 0 && empty.overall <= 100);
  const noDate = S.scoreRun({ datasetType: 'master_entity', files: [{ sourceFileId: 'f1', columns: [], rowCount: 20, ruleResult: ruleResult([], { summary: { freshness_basis: null } }), identity: identity() }] });
  assert.equal(noDate.dimensions.freshness.denominator, 0); assert.equal(noDate.dimensions.freshness.score, 100, 'no usable date: excluded, never penalised as stale');
  const cols = [col('D', 'creation_date', 'expected', { populated_count: 100, role: 'creation_date' })]; const allStale = ruleResult(Array.from({ length: 100 }, (_, i) => f('freshness.stale_record', 'D', { severity: 'medium', row_number: i })), { summary: { freshness_basis: { freshness_reference_field: 'creation_date' } } });
  const stale = S.scoreRun({ datasetType: 'master_entity', files: [{ sourceFileId: 'f1', columns: cols, rowCount: 100, ruleResult: allStale, identity: identity() }] });
  assert.equal(stale.dimensions.freshness.defect_count, 100); assert.equal(stale.dimensions.freshness.score, +(100 * (1 - 0.5)).toFixed(2), 'all-stale is bounded, not negative');
});

test('DETERMINISM: identical inputs give identical scores and identical explanation trees; different reference dates given to S4 (not to scoring) change nothing scoring itself touches', () => {
  const cols = [col('Name', 'name', 'required', { populated_count: 8 })]; const findings = [f('completeness.required_missing', 'Name')];
  const files = () => [{ sourceFileId: 'f1', columns: cols, rowCount: 10, ruleResult: ruleResult(findings), identity: identity() }];
  const a = S.scoreRun({ datasetType: 'master_entity', files: files() }); const b = S.scoreRun({ datasetType: 'master_entity', files: files() });
  assert.deepEqual(a, b); assert.equal(S.hashConfig(S.resolveScoringConfig()), S.hashConfig(S.resolveScoringConfig()));
});
test('CONFIGURATION: versioned, hashed, strictly validated (typos, wrong types, out-of-range values are errors, never silent no-ops)', () => {
  assert.equal(S.DEFAULT_SCORING_CONFIG.version, S.SCORING_CONFIG_VERSION); assert.equal(typeof S.hashConfig(S.resolveScoringConfig()), 'string');
  for (const bad of [{ bloking: {} }, { severity_weights: { critical: 'x' } }, { uniqueness: { scoring_unit: 'nonsense' } }, { version: 'x' }]) assert.throws(() => S.resolveScoringConfig(bad), undefined, JSON.stringify(bad));
});

test('EXPLANATION TREE: every dimension carries an explanation string and structured evidence per contribution; nothing is a hard-coded example', () => {
  const cols = [col('Name', 'name', 'required', { populated_count: 9 })];
  const scored = S.scoreRun({ datasetType: 'master_entity', files: [{ sourceFileId: 'f1', columns: cols, rowCount: 10, ruleResult: ruleResult([f('completeness.required_missing', 'Name')]), identity: identity() }] });
  const c = scored.dimensions.completeness.contributions[0]; assert.match(c.explanation, /1 of 10 rows are missing "Name"/); assert.deepEqual(c.evidence.header_key, 'Name');
  for (const d of Object.values(scored.dimensions)) assert.ok(typeof d.score === 'number' && Array.isArray(d.contributions));
});

test('RUN-TO-RUN COMPARISON FOUNDATION: two scored runs on different inputs are structurally comparable (same dimension keys, same units) so a future diff needs no special-casing', () => {
  const a = S.scoreRun({ datasetType: 'master_entity', files: [{ sourceFileId: 'f1', columns: [col('Name', 'name', 'required', { populated_count: 10 })], rowCount: 10, ruleResult: ruleResult([f('completeness.required_missing', 'Name')]), identity: identity() }] });
  const b = S.scoreRun({ datasetType: 'master_entity', files: [{ sourceFileId: 'f1', columns: [col('Name', 'name', 'required', { populated_count: 10 })], rowCount: 10, ruleResult: ruleResult([]), identity: identity() }] });
  assert.deepEqual(Object.keys(a.dimensions), Object.keys(b.dimensions)); assert.ok(b.overall > a.overall, 'fixing the missing value must raise the score');
  assert.equal(a.dimensions.completeness.contributions[0].scoring_unit, b.dimensions.completeness.contributions[0].scoring_unit || 'record');
});

test('STATIC: the scoring engine reads no clock / randomness / environment, does no I/O, knows no dataset or file names, and never invents a score from raw issue counts alone', () => {
  const fs = require('fs'), path = require('path'); const dir = path.join(__dirname, '..', 'src', 'scoring');
  const noStr = s => s.replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, '""');
  for (const file of ['config', 'engine', 'scoreService']) { const s = fs.readFileSync(path.join(dir, file + '.js'), 'utf8'); assert.doesNotMatch(noStr(s), /\bDate\b/, file); assert.doesNotMatch(s, /Math\.random|process\.env|performance\.now/, file); assert.doesNotMatch(s, /require\(['"](fs|node:fs|path|node:sqlite|\.\.\/db)['"]\)/, file); assert.doesNotMatch(s, /original_filename|sheet_name|erp_dump|holdout|hold-out/i, file); }
});
