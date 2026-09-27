'use strict';
/* S4 persistence-side tests: rules run from the IMMUTABLE configuration snapshot of a confirmed mapping, on a real ingested workbook and the real (isolated) database.
   Also: rule configuration is versioned inside the snapshot, rule-level settings are stored per configuration, the reference date is frozen by the caller, S4 writes nothing. */
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dq-s4-'));
process.env.DATA_DIR = path.join(tmpRoot, 'data'); process.env.DB_PATH = path.join(tmpRoot, 'data', 'test.db'); process.env.UPLOAD_DIR = path.join(tmpRoot, 'uploads'); process.env.EXPORT_DIR = path.join(tmpRoot, 'exports');
process.env.SEED_ADMIN_EMAIL = 's4-admin@example.com'; process.env.SEED_ADMIN_PASSWORD = 'TestPassword123!'; process.env.JWT_SECRET = 'test-secret';
const { test } = require('node:test'); const assert = require('node:assert/strict'); const request = require('supertest');
const app = require('../src/server'); const db = require('../src/db'); const { signToken } = require('../src/middleware/auth');
const { ingestFile } = require('../src/ingest'); const svc = require('../src/semantic/schemaService'); const cs = require('../src/semantic/configSnapshot'); const S = require('../src/semantic'); const R = require('../src/rules'); const RS = require('../src/rules/ruleService');
const { writeWorkbook } = require('./helpers/workbook');
const org = db.prepare('SELECT organization_id o, id u FROM users WHERE email = ?').get(process.env.SEED_ADMIN_EMAIL); const uuid = () => crypto.randomUUID(); const dsId = uuid();
db.prepare('INSERT INTO datasets (id, organization_id, name, created_by) VALUES (?,?,?,?)').run(dsId, org.o, 'S4 dataset', org.u);
const pad = (n, w) => String(n).padStart(w, '0'); const N = 40;
const header = ['Record ID', 'Supplier Name', 'GST No', 'E-mail', 'Mobile', 'Street Address', 'Town', 'PIN Code', 'Created On', 'Changed On', 'Quantity'];
const D = (serial) => ({ v: serial, z: 'yyyy-mm-dd' });   // 2015-01-01 = 42005, 2023-03-15 = 45000, 2025-01-01 = 45658, 2030-01-01 = 47484
const rows = [header]; for (let i = 0; i < N; i++) rows.push(['R-' + pad(i + 1, 5), ['Orion Traders', 'Delta Works', 'Kalinga Steel', 'Apex Supplies'][i % 4] + ' ' + pad(i, 2), `27ABCDE${pad(1000 + i, 4)}F1Z5`, i === 4 ? 'not-an-email' : `acc${i}@firm${i}.example.com`,
  '98' + pad(10000000 + i * 37, 8).slice(-8), `Plot ${10 + i}, Sector ${1 + i % 9}, Industrial Area`, ['Pune', 'Mumbai', 'Chennai'][i % 3], i === 6 ? 'ABC123' : String(400001 + i), D(i === 20 ? 47000 : 45000),
  i === 10 ? D(42005) : i === 11 ? D(44000) : i === 12 ? D(47484) : D(45658), i === 8 ? -5 : 10]);
const xl = path.join(tmpRoot, 'vendors.xlsx'); writeWorkbook(xl, rows);
const ing = ingestFile(db, { datasetId: dsId, filePath: xl }); const SF = ing.sourceFileId; svc.suggestMapping(db, SF, { userId: org.u }); svc.confirmMapping(db, SF, 1, { userId: org.u, acceptSuggestions: true });
const mk = (o = {}) => cs.createAnalysisConfig(db, { datasetId: dsId, sources: [{ source_file_id: SF, mapping_version: 1 }], userId: org.u, settings: { reference_date_mode: 'fixed', reference_date: '2026-09-24', ...(o.settings || {}) }, ruleOverrides: o.rules });
const cnt = (t, w = '1=1', ...a) => db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE ${w}`).get(...a).c; const snapOf = id => cs.getAnalysisConfig(db, id).config.snapshot;
let base;

test('RULES RUN FROM THE CONFIRMED SNAPSHOT: planted defects are found by mapped role; provenance ties the findings to the exact configuration, mapping, file content and reference date', () => {
  base = mk(); const r = RS.runRulesFromSnapshot(db, { configId: base.config_id }); const at = (rule) => r.findings.filter(f => f.rule_id === rule).map(f => f.record_key);
  assert.deepEqual(at('validity.email_format'), ['R-00005']); assert.deepEqual(at('validity.postal_code_format'), ['R-00007']); assert.deepEqual(at('validity.numeric_non_negative'), ['R-00009']);
  assert.ok(at('consistency.modified_before_created').includes('R-00012'), 'modified 2020 < created 2023'); assert.ok(at('consistency.future_date').includes('R-00013'), 'modified 2030 is after the reference date');
  assert.deepEqual(at('freshness.stale_record'), ['R-00011', 'R-00012'], 'last changed 2015 and 2020 are older than 4 years at 2026-09-24; the 2025 records are not'); assert.equal(r.findings.filter(f => f.category === 'completeness').length, 0);
  const p = r.provenance; assert.deepEqual([p.config_id, p.config_hash, p.mapping_version, p.source_file_id, p.reference_date, p.reference_date_source, p.stale_threshold_years, p.engine_version, p.catalog_version], [base.config_id, base.config_hash, 1, SF, '2026-09-24', 'fixed', 4, R.RULE_ENGINE_VERSION, R.RULE_CATALOG_VERSION]);
  assert.equal(p.content_sha256, db.prepare('SELECT content_sha256 c FROM source_files WHERE id = ?').get(SF).c); assert.equal(RS.runRulesFromSnapshot(db, { configId: base.config_id }).provenance.results_hash, p.results_hash, 'same snapshot, same file, same reference date: identical results');
});
test('CONFIG VERSIONING: the rule configuration (versions + effective settings + hash) lives INSIDE the immutable snapshot; defaults store no per-rule rows; deviations are stored per configuration; identical configs are reused', () => {
  const s = snapOf(base.config_id); assert.equal(s.schema_version, 4); assert.deepEqual([s.rules.engine_version, s.rules.catalog_version, s.rules.config_hash], [R.RULE_ENGINE_VERSION, R.RULE_CATALOG_VERSION, R.hashRuleConfig(R.resolveRuleConfig())]);
  assert.equal(db.prepare('SELECT rule_catalog_version v FROM analysis_configs WHERE id = ?').get(base.config_id).v, R.RULE_CATALOG_VERSION); assert.equal(cnt('config_rule_settings', 'config_id = ?', base.config_id), 0);
  const c2 = mk({ rules: { rules: { 'validity.email_format': { severity: 'low' }, 'validity.legal_id_gstin_checksum': { enabled: true }, 'validity.postal_code_format': { params: { patterns: ['^[A-Z0-9]{6}$'] } } } } });
  assert.notEqual(c2.config_hash, base.config_hash); assert.equal(c2.reused, false); const rows = db.prepare('SELECT rule_id, enabled, severity_override, params_json FROM config_rule_settings WHERE config_id = ? ORDER BY rule_id').all(c2.config_id);
  assert.deepEqual(rows.map(r => [r.rule_id, r.enabled, r.severity_override, r.params_json]), [['validity.email_format', 1, 'low', null], ['validity.legal_id_gstin_checksum', 1, null, null], ['validity.postal_code_format', 1, null, '{"patterns":["^[A-Z0-9]{6}$"]}']]);
  const again = mk({ rules: { rules: { 'validity.postal_code_format': { params: { patterns: ['^[A-Z0-9]{6}$'] } }, 'validity.legal_id_gstin_checksum': { enabled: true }, 'validity.email_format': { severity: 'low' } } } }); assert.equal(again.reused, true, 'the same rule configuration (in any key order) is the same configuration'); assert.equal(again.config_id, c2.config_id);
  const r2 = RS.runRulesFromSnapshot(db, { configId: c2.config_id }); assert.equal(r2.findings.find(f => f.rule_id === 'validity.email_format').severity, 'low'); assert.equal(r2.findings.filter(f => f.rule_id === 'validity.postal_code_format').length, 0, '"ABC123" is invalid under the default PIN pattern (first test) but valid under the overridden pattern: the stored parameter override is applied');
  assert.throws(() => db.prepare('UPDATE config_rule_settings SET enabled = 0 WHERE config_id = ?').run(c2.config_id), /./, 'rule settings are append-only once written (S1 guard)'); assert.throws(() => db.prepare('UPDATE analysis_configs SET rule_catalog_version = ? WHERE id = ?').run('x', c2.config_id), /./);
});
test('INVALID rule configuration is refused (400) and creates nothing', () => {
  const before = [cnt('analysis_configs'), cnt('config_rule_settings')];
  for (const rules of [{ rules: { 'validity.nope': {} } }, { rules: { 'validity.email_format': { severity: 'urgent' } } }, { policies: { systematic_failure: { min_fail_ratio: 7 } } }]) assert.throws(() => mk({ rules }), e => e.status === 400);
  assert.deepEqual([cnt('analysis_configs'), cnt('config_rule_settings')], before);
});
test('REFERENCE DATE + STALE THRESHOLD are run settings frozen in the configuration: a run_date reference needs the caller\'s date; changing either changes ONLY the stale findings', () => {
  const runDate = mk({ settings: { reference_date_mode: 'run_date' } }); assert.throws(() => RS.runRulesFromSnapshot(db, { configId: runDate.config_id }), /never reads the clock/);
  const a = RS.runRulesFromSnapshot(db, { configId: runDate.config_id, todayISO: '2026-09-24' }); assert.equal(a.provenance.reference_date_source, 'run_date'); assert.deepEqual(RS.referenceDateFor(cs.getAnalysisConfig(db, runDate.config_id), '2031-01-01'), { reference_date: '2031-01-01', source: 'run_date' });
  const later = RS.runRulesFromSnapshot(db, { configId: runDate.config_id, todayISO: '2031-01-01' }); const ids = r => r.findings.filter(f => f.category !== 'freshness' && f.rule_id !== 'consistency.future_date').map(f => f.id).join();
  assert.equal(ids(a), ids(later), 'only reference-dependent findings move'); assert.ok(later.findings.filter(f => f.rule_id === 'freshness.stale_record').length > a.findings.filter(f => f.rule_id === 'freshness.stale_record').length);
  const y2 = mk({ settings: { stale_threshold_years: 1 } }); const t2 = RS.runRulesFromSnapshot(db, { configId: y2.config_id }); const t4 = RS.runRulesFromSnapshot(db, { configId: base.config_id });
  assert.equal(t2.provenance.stale_threshold_years, 1); assert.equal(ids(t2), ids(t4)); assert.ok(t2.findings.filter(f => f.rule_id === 'freshness.stale_record').length > t4.findings.filter(f => f.rule_id === 'freshness.stale_record').length);
});
test('RE-RUN PLANNING carries the rule configuration forward and merges rule changes into a NEW configuration; the parent is untouched', () => {
  const c1 = mk({ rules: { rules: { 'validity.email_format': { severity: 'low' } } } }); const run = uuid();
  db.prepare("INSERT INTO analysis_runs (id, dataset_id, status, engine_version, config_id, config_hash, table_type, reference_date, stale_threshold_years) VALUES (?,?,?,?,?,?,?,?,?)").run(run, dsId, 'complete', 'engine-under-test-1', c1.config_id, c1.config_hash, 'master_entity', '2026-09-24', 4);
  const before = crypto.createHash('sha256').update(JSON.stringify(db.prepare('SELECT * FROM analysis_configs WHERE id = ?').get(c1.config_id))).digest('hex');
  const plan = cs.planReRun(db, { parentRunId: run, changes: [], ruleOverrides: { rules: { 'freshness.stale_record': { enabled: false } } }, settings: { stale_threshold_years: 3 }, userId: org.u, reason: 'tune' });
  const ov = snapOf(plan.new_config_id).rules.overrides; assert.equal(ov.rules['validity.email_format'].severity, 'low', 'the parent\'s rule settings are carried forward'); assert.equal(ov.rules['freshness.stale_record'].enabled, false, 'the requested rule change is applied');
  assert.notEqual(plan.new_config_id, c1.config_id); assert.equal(snapOf(plan.new_config_id).settings.stale_threshold_years, 3); assert.equal(RS.runRulesFromSnapshot(db, { configId: plan.new_config_id }).findings.filter(f => f.category === 'freshness').length, 0);
  assert.equal(crypto.createHash('sha256').update(JSON.stringify(db.prepare('SELECT * FROM analysis_configs WHERE id = ?').get(c1.config_id))).digest('hex'), before, 'the parent configuration is untouched');
});
test('GUARDS: unknown source, non-ingested source and content drift are refused; S4 writes nothing to the database', () => {
  assert.throws(() => RS.runRulesFromSnapshot(db, { configId: base.config_id, sourceFileId: uuid() }), e => e.status === 404); assert.throws(() => RS.runRulesFromSnapshot(db, { configId: uuid() }), e => e.status === 404);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map(t => t.name); const sig = () => crypto.createHash('sha256').update(tables.map(t => JSON.stringify(db.prepare(`SELECT COUNT(*) c FROM ${t}`).get())).join()).digest('hex');
  const before = sig(); RS.runRulesFromSnapshot(db, { configId: base.config_id }); assert.equal(sig(), before, 'running the rules writes no rows anywhere (no findings, no issues, no runs)');
  assert.equal(cnt('quality_issues'), 0);
});
test('NO BUSINESS SEMANTICS IN THE DATABASE: S4 itself added no migration and no trigger; no migration (including S6\'s 0007 persistence-model one) ever names a rule by id', () => {
  const mig = path.join(__dirname, '..', 'src', 'db', 'migrations'); const files = fs.readdirSync(mig).filter(f => f.endsWith('.sql'));
  for (const f of files) assert.doesNotMatch(fs.readFileSync(path.join(mig, f), 'utf8'), /validity\.(email|phone|legal|postal)|completeness\.(required|expected)|freshness\.stale|uniqueness\.identifier_repeated/, f + ': rule semantics must not live in SQL');
  const triggers = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'").all(); for (const t of triggers) assert.doesNotMatch(t.sql, /email|gstin|postal|phone|@/i, `${t.name}: structural triggers only`);
});
test('DEFENCE IN DEPTH (immutability triggers removed in this throwaway test database): a changed file or a tampered rule configuration is detected and refused, never silently analysed', () => {
  const fresh = mk({ rules: { rules: { 'validity.email_format': { severity: 'high' } } } }); assert.ok(RS.runRulesFromSnapshot(db, { configId: fresh.config_id }).findings.length > 0);
  for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN ('source_files', 'analysis_configs')").all()) db.exec(`DROP TRIGGER "${t.name}"`);
  const orig = db.prepare('SELECT content_sha256 c FROM source_files WHERE id = ?').get(SF).c; db.prepare('UPDATE source_files SET content_sha256 = ? WHERE id = ?').run('0'.repeat(64), SF);
  assert.throws(() => RS.runRulesFromSnapshot(db, { configId: fresh.config_id }), e => e.status === 409 && /no longer matches/.test(e.message)); db.prepare('UPDATE source_files SET content_sha256 = ? WHERE id = ?').run(orig, SF);
  const row = db.prepare('SELECT config_json j FROM analysis_configs WHERE id = ?').get(fresh.config_id); const j = JSON.parse(row.j); j.snapshot.rules.overrides.rules['validity.email_format'].severity = 'low';   // overrides changed, recorded hash left as it was
  db.prepare('UPDATE analysis_configs SET config_json = ? WHERE id = ?').run(JSON.stringify(j), fresh.config_id);
  assert.throws(() => RS.runRulesFromSnapshot(db, { configId: fresh.config_id }), e => e.status === 409 && /does not match its recorded hash/.test(e.message));
});
