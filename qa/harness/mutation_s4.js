'use strict';
/* S4 mutation testing: inject deliberate bugs into the rules layer (and the S3 lines S4 changed) and check the S4 tests (backend rules/rulesService/semantic/schemaReview, qa rt14 + RT-40 + rt13) notice.
   Each mutant runs in an isolated COPY of the repo (nothing here can damage the real source); a control run with no mutation must pass first.
   Usage: node qa/harness/mutation_s3.js [--validate] [--only=M07,M09] [--jobs=4]      Output: qa/reports/s4_mutation.json */
const fs = require('fs'), os = require('os'), path = require('path'); const { spawn } = require('child_process');
const REPO = path.resolve(__dirname, '..', '..'); const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v === undefined ? true : v]; }));
const M = (id, file, find, replace, why) => ({ id, file, find, replace, why });
const HA = "backend/src/rules/engine.js";
const MUTANTS = [
 {
  "id": "M01",
  "file": "backend/src/rules/engine.js",
  "find": "if (c.requiredness !== 'required' && c.requiredness !== 'expected') continue;",
  "replace": "if (false) continue;",
  "why": "optional / unidentified columns are treated like required ones (false defects from empty optional columns)"
 },
 {
  "id": "M02",
  "file": "backend/src/rules/engine.js",
  "find": "if (c.populated === 0) {",
  "replace": "if (false) {",
  "why": "an entirely empty required column is reported per row instead of once"
 },
 {
  "id": "M03",
  "file": "backend/src/rules/engine.js",
  "find": "&& checked >= sf.min_populated && fails.length / checked >= sf.min_fail_ratio",
  "replace": "&& checked >= sf.min_populated",
  "why": "any failing column collapses into a systematic failure"
 },
 {
  "id": "M04",
  "file": "backend/src/rules/engine.js",
  "find": "c.include_in_analysis !== false && c.include_in_analysis !== 0",
  "replace": "true",
  "why": "excluded columns take part in analysis"
 },
 {
  "id": "M05",
  "file": "backend/src/rules/engine.js",
  "find": "if (vp && vp.status === 'active')",
  "replace": "if (vp)",
  "why": "validators attach from a pending-review profile"
 },
 {
  "id": "M06",
  "file": "backend/src/rules/engine.js",
  "find": "cmp(md, cr) < 0",
  "replace": "cmp(md, cr) <= 0",
  "why": "same-day modification counted as modified-before-created"
 },
 {
  "id": "M07",
  "file": "backend/src/rules/engine.js",
  "find": "dayOf(v) > refDay",
  "replace": "dayOf(v) >= refDay",
  "why": "the reference date itself counted as a future date"
 },
 {
  "id": "M08",
  "file": "backend/src/rules/engine.js",
  "find": "(fb === 'always' || (fb === 'when_modification_column_empty' && modColumnEmpty))",
  "replace": "(fb !== 'never')",
  "why": "a blank in a populated modification column ages from creation"
 },
 {
  "id": "M09",
  "file": "backend/src/rules/engine.js",
  "find": "const modColumnEmpty = !modCol;",
  "replace": "const modColumnEmpty = false;",
  "why": "creation fallback never applies when the modification column is empty"
 },
 {
  "id": "M10",
  "file": "backend/src/rules/engine.js",
  "find": "if (list.length > 1)",
  "replace": "if (list.length > 2)",
  "why": "a pair of repeated identifiers is not reported"
 },
 {
  "id": "M11",
  "file": "backend/src/rules/engine.js",
  "find": "lineCol && c.role !== 'row_id'",
  "replace": "false",
  "why": "composite key ignores the line item (false duplicates on legitimate repeated documents)"
 },
 {
  "id": "M12",
  "file": "backend/src/rules/engine.js",
  "find": "cp.severity[c.requiredness]",
  "replace": "cp.severity.required",
  "why": "expected gaps get the required severity"
 },
 {
  "id": "M13",
  "file": "backend/src/rules/engine.js",
  "find": "cp.column_empty_severity[c.requiredness]",
  "replace": "cp.column_empty_severity.expected",
  "why": "an empty required column gets the expected severity"
 },
 {
  "id": "M14",
  "file": "backend/src/rules/engine.js",
  "find": "const instant = P.temporal.granularity === 'instant';",
  "replace": "const instant = true;",
  "why": "temporal comparison ignores the configured day granularity"
 },
 {
  "id": "M15",
  "file": "backend/src/rules/engine.js",
  "find": "D.isStale(d, ref, years)",
  "replace": "D.isStale(d, ref, years + 1)",
  "why": "the stale threshold is off by one year"
 },
 {
  "id": "M16",
  "file": "backend/src/rules/engine.js",
  "find": "dateRoles.has(c.role) && cell.kind === 'date_unresolved'",
  "replace": "false",
  "why": "ambiguous dates are silently ignored (no decision requested)"
 },
 {
  "id": "M17",
  "file": "backend/src/rules/engine.js",
  "find": "...cfg.rules[id].params }",
  "replace": "}",
  "why": "configured rule parameters are ignored by the engine"
 },
 {
  "id": "M18",
  "file": "backend/src/rules/catalog.js",
  "find": "'invalid_gstin_checksum', 'record', 'medium', {}, false,",
  "replace": "'invalid_gstin_checksum', 'record', 'medium', {}, true,",
  "why": "the GSTIN checksum pack is ON by default"
 },
 {
  "id": "M19",
  "file": "backend/src/rules/config.js",
  "find": "min_populated: 20",
  "replace": "min_populated: 1",
  "why": "systematic failure is called on tiny populations"
 },
 {
  "id": "M20",
  "file": "backend/src/rules/config.js",
  "find": "creation_fallback: 'when_modification_column_empty' }",
  "replace": "creation_fallback: 'always' }",
  "why": "default freshness policy ages every blank from creation"
 },
 {
  "id": "M21",
  "file": "backend/src/rules/config.js",
  "find": "always_unique_roles: ['row_id']",
  "replace": "always_unique_roles: []",
  "why": "row ids are no longer checked for uniqueness"
 },
 {
  "id": "M22",
  "file": "backend/src/rules/config.js",
  "find": "composite_with_line_item: true",
  "replace": "composite_with_line_item: false",
  "why": "composite keys off by default"
 },
 {
  "id": "M23",
  "file": "backend/src/rules/config.js",
  "find": "master_material: ['material_id']",
  "replace": "master_material: []",
  "why": "the material id is not required to be unique in a material master"
 },
 {
  "id": "M24",
  "file": "backend/src/rules/config.js",
  "find": "master_entity: []",
  "replace": "master_entity: ['material_id']",
  "why": "repeated item codes are a defect in an entity master"
 },
 {
  "id": "M25",
  "file": "backend/src/rules/config.js",
  "find": "severity: { required: 'high', expected: 'low' }",
  "replace": "severity: { required: 'medium', expected: 'low' }",
  "why": "required gaps are only medium"
 },
 {
  "id": "M26",
  "file": "backend/src/rules/config.js",
  "find": "min_fail_ratio: 0.9",
  "replace": "min_fail_ratio: 0.1",
  "why": "systematic failure fires at 10%"
 },
 {
  "id": "M27",
  "file": "backend/src/rules/dates.js",
  "find": "dayNumber(refISO) > dayNumber(a)",
  "replace": "dayNumber(refISO) >= dayNumber(a)",
  "why": "stale boundary: a record exactly on the anniversary is stale"
 },
 {
  "id": "M28",
  "file": "backend/src/rules/dates.js",
  "find": "Math.round(years * 12)",
  "replace": "Math.round(years * 13)",
  "why": "threshold months wrong"
 },
 {
  "id": "M29",
  "file": "backend/src/rules/dates.js",
  "find": "Math.min(p.d, cal.daysInMonth(y, m))",
  "replace": "p.d",
  "why": "month-end clamping removed (impossible dates like 31 Feb)"
 },
 {
  "id": "M30",
  "file": "backend/src/rules/dates.js",
  "find": "if (todayISO === undefined) throw err(",
  "replace": "if (false) throw err(",
  "why": "a run_date reference accepts a missing today"
 },
 {
  "id": "M31",
  "file": "backend/src/rules/validators.js",
  "find": "const EMAIL = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/,",
  "replace": "const EMAIL = /^[^\\s@]+@[^\\s@]+$/,",
  "why": "e-mail without a dotted domain accepted"
 },
 {
  "id": "M32",
  "file": "backend/src/rules/validators.js",
  "find": "if (/^[6-9]\\d{9}$/.test(n)) return null;",
  "replace": "if (/^\\d{10}$/.test(n)) return null;",
  "why": "any 10-digit number is a phone"
 },
 {
  "id": "M33",
  "file": "backend/src/rules/validators.js",
  "find": "if (n.length === 12 && n.startsWith('91')) n = n.slice(2);",
  "replace": "",
  "why": "the +91 country prefix is not stripped"
 },
 {
  "id": "M34",
  "file": "backend/src/rules/validators.js",
  "find": "GSTIN = /^\\d{2}[A-Z]{5}",
  "replace": "GSTIN = /^[A-Z0-9]{2}[A-Z]{5}",
  "why": "GSTIN state code may be letters"
 },
 {
  "id": "M35",
  "file": "backend/src/rules/validators.js",
  "find": "n < p.min ? { reason:",
  "replace": "n <= p.min ? { reason:",
  "why": "zero rejected as below the minimum"
 },
 {
  "id": "M36",
  "file": "backend/src/rules/validators.js",
  "find": "n < p.min || n > p.max",
  "replace": "n < p.min || n >= p.max",
  "why": "a percentage of exactly 100 rejected"
 },
 {
  "id": "M37",
  "file": "backend/src/rules/validators.js",
  "find": "const NUMERIC = /^[+-]?(\\d{1,3}(,\\d{3})+|\\d+)(\\.\\d+)?$/;",
  "replace": "const NUMERIC = /^[+-]?[\\d,]+(\\.\\d+)?$/;",
  "why": "malformed thousands separators accepted as numbers"
 },
 {
  "id": "M38",
  "file": "backend/src/rules/validators.js",
  "find": "if (meta.st === 'parsed')",
  "replace": "if (true)",
  "why": "ambiguous text dates treated as parsed"
 },
 {
  "id": "M39",
  "file": "backend/src/rules/validators.js",
  "find": "if (c.kind === 'date' || c.kind === 'date_unresolved') return null;",
  "replace": "if (c.kind === 'date') return null;",
  "why": "an ambiguous date is reported as an invalid date"
 },
 {
  "id": "M40",
  "file": "backend/src/rules/validators.js",
  "find": "* ((i % 2) + 1)",
  "replace": "* ((i % 2) + 2)",
  "why": "GSTIN check-character weights wrong"
 },
 {
  "id": "M41",
  "file": "backend/src/rules/validators.js",
  "find": "if (raw !== raw.trim())",
  "replace": "if (false)",
  "why": "padded identifiers accepted"
 },
 {
  "id": "M42",
  "file": "backend/src/rules/catalog.js",
  "find": "patterns: ['^[1-9][0-9]{5}$']",
  "replace": "patterns: ['^[0-9]{6}$']",
  "why": "a PIN may start with 0"
 },
 {
  "id": "M43",
  "file": "backend/src/rules/validators.js",
  "find": "(s >= 1 && s <= 38)",
  "replace": "(s >= 0 && s <= 38)",
  "why": "GSTIN state code 00 accepted"
 },
 {
  "id": "M44",
  "file": "backend/src/rules/ruleService.js",
  "find": "resolveRuleConfig(snap.rules.overrides)",
  "replace": "resolveRuleConfig()",
  "why": "stored rule overrides ignored at run time"
 },
 {
  "id": "M45",
  "file": "backend/src/rules/ruleService.js",
  "find": "stale_threshold_years: snap.settings.stale_threshold_years }",
  "replace": "stale_threshold_years: 4 }",
  "why": "the configured stale threshold is ignored at run time"
 },
 {
  "id": "M46",
  "file": "backend/src/rules/ruleService.js",
  "find": "if (sf.content_sha256 !== src.content_sha256) throw",
  "replace": "if (false) throw",
  "why": "a changed file is analysed under the old configuration"
 },
 {
  "id": "M47",
  "file": "backend/src/rules/ruleService.js",
  "find": "if (hashRuleConfig(ruleConfig) !== snap.rules.config_hash) throw",
  "replace": "if (false) throw",
  "why": "a tampered rule configuration is analysed"
 },
 {
  "id": "M48",
  "file": "backend/src/semantic/configSnapshot.js",
  "find": "for (const r of RC.ruleSettingRows(snapshot.rules.config)) ins.run(uuid(), id, r.rule_id, r.enabled, r.severity_override, r.params_json);",
  "replace": "",
  "why": "rule settings are not stored per configuration"
 },
 {
  "id": "M49",
  "file": "backend/src/semantic/configSnapshot.js",
  "find": "ruleOverrides: mergeOverrides(snap.rules ? snap.rules.overrides : {}, ruleOverrides)",
  "replace": "ruleOverrides: ruleOverrides",
  "why": "a re-run forgets the parent's rule settings"
 },
 {
  "id": "M50",
  "file": "backend/src/semantic/configSnapshot.js",
  "find": "1, snapshot.rules.catalog_version, hash",
  "replace": "1, null, hash",
  "why": "the rule catalog version is not recorded"
 },
 {
  "id": "M51",
  "file": "backend/src/semantic/validationProfiles.js",
  "find": "quantity: [V('validity.numeric_non_negative')], unit_price: [V('validity.numeric_non_negative')] };",
  "replace": "};",
  "why": "quantity / price checks are not role-intrinsic (missed on entity masters)"
 },
 {
  "id": "M52",
  "file": "backend/src/semantic/contentProfile.js",
  "find": "if (NUMERIC_TEXT.test(s) && !/^0\\d/.test(s))",
  "replace": "if (false)",
  "why": "numeric-looking text (CSV) is not numeric to the profiler"
 },
 {
  "id": "M53",
  "file": "backend/src/semantic/requiredness.js",
  "find": "share(j), mappings[j].confidence",
  "replace": "0, mappings[j].confidence",
  "why": "a sparse column can be the primary of a role (requiredness)"
 }
];
const EQUIVALENT = {};
const count = (s, sub) => s.split(sub).length - 1;
function copyRepo(dst) { fs.cpSync(REPO, dst, { recursive: true, filter: p => { const r = path.relative(REPO, p); return !/(^|\/)(node_modules|\.git|frontend)(\/|$)/.test(r) && !/^qa\/reports/.test(r); } }); fs.symlinkSync(path.join(REPO, 'backend/node_modules'), path.join(dst, 'backend/node_modules')); }
function run(cmd, cwd) { return new Promise(res => { const env = { ...process.env }; for (const k of ['DATA_DIR', 'DB_PATH', 'UPLOAD_DIR', 'EXPORT_DIR', 'NODE_TEST_CONTEXT']) delete env[k]; let out = ''; const p = spawn('sh', ['-c', cmd], { cwd, env }); p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { out += d; }); p.on('close', code => res({ code, out })); }); }
async function evalMutant(m, base) {
  const dst = path.join(base, m.id); copyRepo(dst); const f = path.join(dst, m.file);
  if (m.id !== 'CONTROL') { const src = fs.readFileSync(f, 'utf8'); const n = count(src, m.find); if (n !== 1) return { id: m.id, status: 'INVALID', detail: `find string occurs ${n}x` }; fs.writeFileSync(f, src.replace(m.find, () => m.replace)); }
  const a = await run('node --experimental-sqlite --test tests/rules.test.js tests/rulesService.test.js tests/semantic.test.js tests/schemaReview.test.js', path.join(dst, 'backend')); let killers = [];
  const names = o => [...o.matchAll(/^\s*not ok \d+ - (.{0,90})/gm)].map(x => x[1]);
  if (a.code !== 0) killers = killers.concat(names(a.out).map(n => 'backend: ' + n)); if (!killers.length) { const b = await run('node --experimental-sqlite --test qa/regression/rt14_rules_layer.test.js qa/regression/rt13_semantic_layer.test.js', dst); if (b.code !== 0) killers = killers.concat(names(b.out).map(n => 'qa: ' + n)); }
  if (!killers.length) { const c = await run('node --experimental-sqlite --test --test-name-pattern=RT-40 qa/regression/rt10_new_findings.test.js', dst); if (c.code !== 0) killers = killers.concat(names(c.out).map(n => 'qa: ' + n)); }
  fs.rmSync(dst, { recursive: true, force: true }); return { id: m.id, status: killers.length ? 'KILLED' : 'SURVIVED', killed_by: killers.slice(0, 3), n_failing: killers.length };
}
(async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dq-mut-')); const jobs = Number(args.jobs || 4);
  if (args.validate) { for (const m of MUTANTS) { const n = count(fs.readFileSync(path.join(REPO, m.file), 'utf8'), m.find); console.log(m.id, n === 1 ? 'ok' : `INVALID (${n}x)`); } return; }
  let list = [{ id: 'CONTROL', file: HA, find: '', replace: '', why: 'no mutation: the suite must pass' }, ...MUTANTS]; if (args.only) { const s = new Set(String(args.only).split(',')); list = list.filter(m => s.has(m.id)); }
  const results = []; let i = 0; await Promise.all(Array.from({ length: jobs }, async () => { while (i < list.length) { const m = list[i++]; const r = await evalMutant(m, base); r.why = m.why; results.push(r); process.stderr.write(`${r.id} ${r.status}\n`); } }));
  const out = path.join(REPO, 'qa/reports/s4_mutation.json'); let all = results;
  if (args.only && fs.existsSync(out)) { const prev = JSON.parse(fs.readFileSync(out, 'utf8')).results.filter(r => !results.some(x => x.id === r.id)); all = prev.concat(results); }   // batches merge into one report
  all.sort((a, b) => a.id.localeCompare(b.id)); const ctl = all.find(r => r.id === 'CONTROL'); const muts = all.filter(r => r.id !== 'CONTROL');
  const eq = muts.filter(r => EQUIVALENT[r.id]).map(r => r.id); const summary = { control: ctl.status === 'SURVIVED' ? 'PASS (suite green without mutation)' : 'FAIL - control run was not green', mutants: muts.length, killed: muts.filter(r => r.status === 'KILLED').length, equivalent: eq.map(id => `${id}: ${EQUIVALENT[id]}`), survived: muts.filter(r => r.status === 'SURVIVED' && !EQUIVALENT[r.id]).map(r => r.id), invalid: muts.filter(r => r.status === 'INVALID').map(r => r.id) };
  fs.mkdirSync(path.join(REPO, 'qa/reports'), { recursive: true }); fs.writeFileSync(out, JSON.stringify({ summary, results: all }, null, 1));
  for (const r of muts) console.log(`${r.id}  ${r.status.padEnd(8)} ${r.why}${r.status === 'KILLED' ? '  <- ' + r.killed_by[0] : ''}`); console.log('\n' + JSON.stringify(summary)); fs.rmSync(base, { recursive: true, force: true });
})();
