'use strict';
/* S3 mutation testing: inject deliberate bugs into the semantic layer and check the S3 tests (backend semantic.test.js, schemaReview.test.js, qa rt13) notice.
   Each mutant runs in an isolated COPY of the repo (nothing here can damage the real source); a control run with no mutation must pass first.
   Usage: node qa/harness/mutation_s3.js [--validate] [--only=M07,M09] [--jobs=4]      Output: qa/reports/s3_mutation.json */
const fs = require('fs'), os = require('os'), path = require('path'); const { spawn } = require('child_process');
const REPO = path.resolve(__dirname, '..', '..'); const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v === undefined ? true : v]; }));
const M = (id, file, find, replace, why) => ({ id, file, find, replace, why });
// M11 is an EQUIVALENT mutant (kept for the record, reported separately): with content fit < 0.2 the score is already <= 0.98 * (0.25 + 0.75 * 0.2) = 0.39 < min_assign 0.45, so the extra 0.5x penalty cannot change any role decision.
const EQUIVALENT = { M11: 'fit < 0.2 already caps the score at ~0.39, below the 0.45 assignment threshold; the 0.5x penalty changes no role decision' };
const HA = 'backend/src/semantic/headerAnalysis.js', RC = 'backend/src/semantic/roleClassifier.js', DC = 'backend/src/semantic/datasetClassifier.js', RQ = 'backend/src/semantic/requiredness.js', VP = 'backend/src/semantic/validationProfiles.js',
  SV = 'backend/src/semantic/schemaService.js', CS = 'backend/src/semantic/configSnapshot.js', RT = 'backend/src/routes/schemaReview.js', MG = 'backend/src/db/migrations/0006_s3_semantic_mapping.sql', CP = 'backend/src/semantic/contentProfile.js', CF = 'backend/src/semantic/config.js';
const MUTANTS = [
  M('M01', HA, "const score = c.weight * (0.35 + 0.65 * coverage);", "const score = c.weight;", 'header coverage discount removed (unexplained words no longer weaken a role)'),
  M('M02', HA, "if (!by) {", "if (true) {", 'date roles allowed even when the header says "by"'),
  M('M03', HA, "if (x.t === 'on' && !verbs)", "if (false)", '"on" always a date marker'),
  M('M04', HA, "if (countPhrase) return out.filter(c => familyOf(c.role) !== 'identifier');", "", '"number of X" may become an identifier'),
  M('M05', HA, "no: 'number', ", "", 'abbreviation "No." not expanded'),
  M('M06', HA, "replace(/([a-z])([A-Z])(?=[a-z])/g, '$1 $2')", "replace(/([a-z])([A-Z])/g, '$1 $2')", 'camelCase splitter tears UoM apart'),
  M('M07', HA, "if (toks.some(x => x.t === 'date')) return out.filter(c => familyOf(c.role) === 'date');", "", 'a header that says "date" may be a non-date role'),
  M('M08', RC, "const fromText = t ? ts(P) * clamp(t.phone_formatted + t.mobile10) : 0;", "const fromText = t ? ts(P) * clamp(t.phone_formatted + t.mobile10 + t.phone_plain) : 0;", 'plain 10-digit numbers count as phone content'),
  M('M09', RC, "if (empty && !(h && h.coverage >= 0.99 && h.weight >= cfg.empty_column.high_risk_min_header)) s = Math.min(s, cfg.min_assign - 0.01);", "", 'empty-column high-risk gate removed'),
  M('M10', RC, "const nearConstant = P => P.populated >= 20 && P.distinct <= 2;", "const nearConstant = P => P.populated >= 20 && P.unique_ratio < 0.05;", 'near-constant heuristic reverted to the ratio bug'),
  M('M11', RC, "s *= 0.5; flags.conflicts.push", "s *= 1; flags.conflicts.push", 'header/content veto penalty removed'),
  M('M12', RC, "Math.min(cfg.content_only_cap, SELF_ID[role](P))", "SELF_ID[role](P)", 'content-only cap removed'),
  M('M13', RC, "if (hs >= cfg.corroboration.min_header && fit >= cfg.corroboration.min_fit) s = Math.min(cfg.corroboration.max, s + cfg.corroboration.bonus);", "", 'header+content corroboration bonus removed'),
  M('M14', RC, "if (!profiles[i] || profiles[i].populated === 0) {", "if (false) {", 'empty duplicate twin keeps the identity role'),
  M('M15', RC, "if (assigned.ambiguous_header) reasons.push(", "if (false) reasons.push(", 'ambiguous header wording no longer forces review'),
  M('M16', RC, "if (tierOf(confidence, cfg) !== 'high' && (info.critical || info.risk === 'high')) reasons.push(", "if (false) reasons.push(", 'medium confidence on high-impact roles no longer needs review'),
  M('M17', RC, "if (second && margin < cfg.ambiguity_margin && second.score >= cfg.ambiguity_alt_min) reasons.push(", "if (false) reasons.push(", 'close competing roles no longer force review'),
  M('M18', RC, "const rank = i => [profiles[i] && profiles[i].populated > 0 ? 1 : 0, share(i), out[i].confidence,", "const rank = i => [0, 0, out[i].confidence,", 'primary identity column chosen without regard to being populated'),
  M('M19', RC, "audit_user: P => (dateShare(P) > 0.05 ? 0 :", "audit_user: P => (false ? 0 :", 'audit user content may be dates'),
  M('M20', DC, "if (total < dc.min_evidence) {", "if (false) {", 'thin evidence still yields a confident type'),
  M('M21', DC, "else if (scores[w].share < dc.min_share || margin < dc.min_margin) {", "else if (false) {", 'split evidence still picks a winner'),
  M('M22', DC, "source: 'user', needs_review: false,", "source: 'classifier', needs_review: false,", 'user override not recorded as user'),
  M('M23', RQ, "return { requiredness: 'expected', source: 'inferred'", "return { requiredness: 'required', source: 'inferred'", 'the 95% heuristic proves REQUIRED'),
  M('M24', RQ, "if (d) return { requiredness: 'optional', source: 'rule', reason: `secondary column for", "if (false) return { requiredness: 'optional', source: 'rule', reason: `secondary column for", 'secondary columns of a role become required too'),
  M('M25', RQ, "if (populated === 0) return { scope: 'dataset'", "if (populated === 0) return { scope: 'record'", 'empty required column reported per row'),
  M('M26', RQ, "if (requiredness === 'optional' || !REQUIREDNESS.includes(requiredness)) return { scope: 'none'", "if (!REQUIREDNESS.includes(requiredness)) return { scope: 'none'", 'optional gaps become defects'),
  M('M27', RQ, "const ov = overrides[key];", "const ov = null;", 'user requiredness decisions ignored'),
  M('M28', VP, "const trusted = userConfirmed || (mapping.confidence_tier !== 'low' && !mapping.review_required);", "const trusted = true;", 'validators attached to unreviewed low-confidence mappings'),
  M('M29', SV, "if ((open.length || dsOpen) && !acceptSuggestions) throw", "if (false) throw", 'confirm not gated on unresolved review items'),
  M('M30', MG, "CREATE TRIGGER IF NOT EXISTS trg_schema_mappings_locked_update\nBEFORE UPDATE ON schema_mappings", "CREATE TRIGGER IF NOT EXISTS trg_schema_mappings_locked_update\nBEFORE UPDATE OF status ON schema_mappings", 'database lets locked column mappings be edited'),
  M('M31', CS, "if (!set.locked_at) throw", "if (false) throw", 'configuration built from an unconfirmed mapping'),
  M('M32', SV, "from.semantic_config_json, from.semantic_config_hash, from.input_fingerprint, userId || null", "from.semantic_config_json, from.semantic_config_hash, from.input_fingerprint + 'x', userId || null", 'revised version breaks suggest idempotency'),
  M('M33', SV, "run(uuid(), sourceFileId, version, fromVersion, from.dataset_type,", "run(uuid(), sourceFileId, version, null, from.dataset_type,", 'revision lineage (parent version) not recorded'),
  M('M34', SV, "if (cur.input_fingerprint === fp) return { version: latest, reused: true };", "if (false) return { version: latest, reused: true };", 'suggest not idempotent'),
  M('M35', CS, "if (dup) return { config_id: dup.id", "if (false) return { config_id: dup.id", 'identical configuration not reused'),
  M('M36', RT, "JOIN datasets d ON d.id = sf.dataset_id WHERE sf.id = ? AND d.organization_id = ?", "JOIN datasets d ON d.id = sf.dataset_id WHERE sf.id = ? AND ? IS NOT NULL", 'source ownership not checked against the organization'),
  M('M37', CS, "lineage: { parent_run_id: run.id,", "lineage: { parent_run_id: null,", 're-run lineage not recorded in the new configuration'),
  M('M38', CP, "if (RX.mobile10.test(s.replace(/[\\s-]/g, ''))) t.mobile10++;", "if (RX.mobile10.test(s.replace(/[\\s-]/g, '')) || RX.digits.test(s)) t.mobile10++;", 'every all-digit string counts as a mobile number'),
  M('M39', CF, "heuristic_expected_min_populated: 0.95,", "heuristic_expected_min_populated: 0.5,", 'expectedness threshold loosened to 50%'),
  M('M41', RC, "if (fit < cfg.header_content_veto_fit) { s *= 0.5; flags.conflicts.push", "if (false) { s *= 0.5; flags.conflicts.push", 'header/content conflicts no longer detected or explained'),
  M('M42', RC, "else if (!empty && fit !== null && fit < cfg.high_risk_min_fit && so < 0.6) s = Math.min(s, cfg.min_assign - 0.01);", "", 'high-risk role assigned on weak (<50%) content fit'),
  M('M43', CP, "const distinct = this.capped && Number.isFinite(exactDistinct) ? exactDistinct : this.vc.size;", "const distinct = this.vc.size;", 'above the tracking cap a unique column looks repetitive (exact ingest count ignored)'),
  M('M40', SV, "sets.push('role = ?', 'role_family = ?', 'is_critical_identity = ?', 'confidence = ?', \"confidence_tier = 'high'\", \"status = 'overridden'\", 'user_overridden = 1',", "sets.push('role = ?', 'role_family = ?', 'is_critical_identity = ?', 'confidence = ?', \"confidence_tier = 'high'\", \"status = 'overridden'\", 'user_overridden = 0', 'suggested_role = role',", 'user override loses the classifier proposal and the overridden flag')
];
const count = (s, f) => (f === '' ? 0 : s.split(f).length - 1);
function copyRepo(dst) { fs.cpSync(REPO, dst, { recursive: true, filter: p => { const r = path.relative(REPO, p); return !/(^|\/)(node_modules|\.git|frontend)(\/|$)/.test(r) && !/^qa\/reports/.test(r); } }); fs.symlinkSync(path.join(REPO, 'backend/node_modules'), path.join(dst, 'backend/node_modules')); }
function run(cmd, cwd) { return new Promise(res => { const env = { ...process.env }; for (const k of ['DATA_DIR', 'DB_PATH', 'UPLOAD_DIR', 'EXPORT_DIR', 'NODE_TEST_CONTEXT']) delete env[k]; let out = ''; const p = spawn('sh', ['-c', cmd], { cwd, env }); p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { out += d; }); p.on('close', code => res({ code, out })); }); }
async function evalMutant(m, base) {
  const dst = path.join(base, m.id); copyRepo(dst); const f = path.join(dst, m.file);
  if (m.id !== 'CONTROL') { const src = fs.readFileSync(f, 'utf8'); const n = count(src, m.find); if (n !== 1) return { id: m.id, status: 'INVALID', detail: `find string occurs ${n}x` }; fs.writeFileSync(f, src.replace(m.find, () => m.replace)); }
  const a = await run('node --experimental-sqlite --test tests/semantic.test.js tests/schemaReview.test.js', path.join(dst, 'backend')); let killers = [];
  const names = o => [...o.matchAll(/^\s*not ok \d+ - (.{0,90})/gm)].map(x => x[1]);
  if (a.code !== 0) killers = killers.concat(names(a.out).map(n => 'backend: ' + n)); const b = await run('node --experimental-sqlite --test qa/regression/rt13_semantic_layer.test.js', dst); if (b.code !== 0) killers = killers.concat(names(b.out).map(n => 'qa: ' + n));
  fs.rmSync(dst, { recursive: true, force: true }); return { id: m.id, status: killers.length ? 'KILLED' : 'SURVIVED', killed_by: killers.slice(0, 3), n_failing: killers.length };
}
(async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dq-mut-')); const jobs = Number(args.jobs || 4);
  if (args.validate) { for (const m of MUTANTS) { const n = count(fs.readFileSync(path.join(REPO, m.file), 'utf8'), m.find); console.log(m.id, n === 1 ? 'ok' : `INVALID (${n}x)`); } return; }
  let list = [{ id: 'CONTROL', file: HA, find: '', replace: '', why: 'no mutation: the suite must pass' }, ...MUTANTS]; if (args.only) { const s = new Set(String(args.only).split(',')); list = list.filter(m => s.has(m.id)); }
  const results = []; let i = 0; await Promise.all(Array.from({ length: jobs }, async () => { while (i < list.length) { const m = list[i++]; const r = await evalMutant(m, base); r.why = m.why; results.push(r); process.stderr.write(`${r.id} ${r.status}\n`); } }));
  const out = path.join(REPO, 'qa/reports/s3_mutation.json'); let all = results;
  if (args.only && fs.existsSync(out)) { const prev = JSON.parse(fs.readFileSync(out, 'utf8')).results.filter(r => !results.some(x => x.id === r.id)); all = prev.concat(results); }   // batches merge into one report
  all.sort((a, b) => a.id.localeCompare(b.id)); const ctl = all.find(r => r.id === 'CONTROL'); const muts = all.filter(r => r.id !== 'CONTROL');
  const eq = muts.filter(r => EQUIVALENT[r.id]).map(r => r.id); const summary = { control: ctl.status === 'SURVIVED' ? 'PASS (suite green without mutation)' : 'FAIL - control run was not green', mutants: muts.length, killed: muts.filter(r => r.status === 'KILLED').length, equivalent: eq.map(id => `${id}: ${EQUIVALENT[id]}`), survived: muts.filter(r => r.status === 'SURVIVED' && !EQUIVALENT[r.id]).map(r => r.id), invalid: muts.filter(r => r.status === 'INVALID').map(r => r.id) };
  fs.mkdirSync(path.join(REPO, 'qa/reports'), { recursive: true }); fs.writeFileSync(out, JSON.stringify({ summary, results: all }, null, 1));
  for (const r of muts) console.log(`${r.id}  ${r.status.padEnd(8)} ${r.why}${r.status === 'KILLED' ? '  <- ' + r.killed_by[0] : ''}`); console.log('\n' + JSON.stringify(summary)); fs.rmSync(base, { recursive: true, force: true });
})();
