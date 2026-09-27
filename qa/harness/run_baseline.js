'use strict';
/* Baseline runner: dataset -> real server -> RunView -> (a) truth scoring for master-entity oracles, (b) role-expectation checks
   for real SAP files, (c) dashboard/health snapshot. Output: qa/baseline/<engine>/<label>.json  (engine is read from the adapter). */
const fs = require('fs'); const path = require('path');
const { withServer, runDataset, api, REPO } = require('./http_run'); const { loadRun } = require('./adapter_legacy_v0'); const { scoreAll } = require('./score');
const a = Object.fromEntries(process.argv.slice(2).map(s => s.replace(/^--/, '').split('=')));
const LEGACY_CLASS = { name: 'entity_name', address: 'address', phone: 'phone', email: 'email', gstin: 'legal_id', pan: 'legal_id', item_code: 'material_key', item_desc: 'material_description', created_date: 'created_date', modified_date: 'modified_date', status: 'status', identifier: 'identifier', numeric: 'number', categorical: 'category', unknown: 'unmapped', unclassified_date: 'date' };
const FAMILY = { city: 'address', doc_key: 'identifier', doc_ref: 'identifier', entity_id: 'identifier', row_id: 'identifier' };   // generous: legacy has no typed ids
const cls = r => LEGACY_CLASS[r] || r;
function roleChecks(profiles, exp) {
  const first = {}; profiles.forEach(p => { if (!first[p.column_name]) first[p.column_name] = p; });
  const rows = []; let ok = 0, bad = 0;
  for (const [h, accepts] of Object.entries(exp.must_map || {})) { const p = first[h]; const c = p ? cls(p.inferred_role) : 'absent'; const good = accepts.includes(c) || accepts.some(x => FAMILY[x] === c); rows.push({ header: h, expect_one_of: accepts, legacy_role: p && p.inferred_role, verdict: good ? 'ok' : 'WRONG' }); good ? ok++ : bad++; }
  for (const [h, forb] of Object.entries(exp.must_not_map || {})) { const p = first[h]; if (!p) continue; const c = cls(p.inferred_role); const viol = forb.includes(c) || (forb.includes('date') && /date/.test(p.inferred_role)); rows.push({ header: h, must_not_be: forb, legacy_role: p.inferred_role, verdict: viol ? 'FORBIDDEN_ASSIGNMENT' : 'ok' }); viol ? bad++ : ok++; }
  for (const h of Object.keys(exp.must_require_review || {})) { const p = first[h]; if (!p) continue; const auto = ['created_date', 'modified_date'].includes(p.inferred_role); rows.push({ header: h, must_require_review: true, legacy_role: p.inferred_role, legacy_confidence: p.role_confidence, verdict: auto ? 'SILENTLY_ASSIGNED' : 'ok' }); auto ? bad++ : ok++; }
  return { ok, bad, rows };
}
withServer(async ctx => {
  const res = await runDataset(ctx, { file: a.data, sheet: a.sheet, name: a.label });
  const out = { label: a.label, data: path.basename(a.data), run: res, server_log_tail: res.status === 'failed' ? ctx.log().split('\n').filter(l => /Error|error|failed/i.test(l)).slice(-3) : undefined };
  if (res.status === 'complete') {
    const dash = (await api(ctx, 'GET', `/api/runs/${res.runId}/dashboard`)).body;
    out.dashboard = { summary: dash.summary, health: dash.health && { overall: dash.health.overall, dims: Object.fromEntries(Object.entries(dash.health.breakdown).map(([k, v]) => [k, v && v.score !== undefined ? v.score : v])) }, issues_by_category: dash.issues_by_category, top_issue_types: dash.top_issue_types.slice(0, 8), age_distribution: dash.age_distribution };
    out.roles = dash.field_profiles.map(p => ({ column: p.column_name, type: p.inferred_type, role: p.inferred_role, null_pct: Math.round(p.null_pct * 1000) / 1000 }));
    const roleCounts = {}; out.roles.forEach(r => roleCounts[r.role] = (roleCounts[r.role] || 0) + 1); out.role_counts = roleCounts;
    if (a.truth) { const truth = JSON.parse(fs.readFileSync(a.truth)); const view = loadRun(ctx.dbPath, { runId: res.runId, keyColumn: truth.meta.mapping.columns.row_id }); out.vs_truth = scoreAll(view, truth, { referenceDate: new Date().toISOString().slice(0, 10) }); }
    if (a.baseline) { const b = JSON.parse(fs.readFileSync(a.baseline)); out.role_checks = roleChecks(dash.field_profiles, b.expected_roles);
      const iss = dash.top_issue_types; out.issue_breakdown_by_field = null; }
    if (a.expected_roles) { const e = JSON.parse(fs.readFileSync(a.expected_roles)); const first = {}; dash.field_profiles.forEach(p => { if (!first[p.column_name]) first[p.column_name] = p; });
      const rows = Object.entries(e).filter(([k]) => !k.startsWith('_')).map(([h, want]) => { const p = first[h]; const c = p ? cls(p.inferred_role) : 'absent'; return { header: h, expected: want, legacy_role: p && p.inferred_role, verdict: (c === want || FAMILY[want] === c) ? 'ok' : 'WRONG' }; });
      out.holdout_role_generalization = { ok: rows.filter(r => r.verdict === 'ok').length, wrong: rows.filter(r => r.verdict !== 'ok').length, rows }; }
  }
  const dir = path.join(REPO, 'qa/baseline/legacy'); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, a.label + '.json'), JSON.stringify(out, null, 1));
  console.log(`[${a.label}] status=${res.status} ${res.seconds}s peakRSS=${res.peakRssMB}MB stall=${res.maxApiStallMs}ms ${res.error ? 'ERR=' + res.error : ''}`);
}, a.label).then(() => process.exit(0));
