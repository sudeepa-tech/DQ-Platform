'use strict';
/*
 * THE RULES ENGINE (S4): confirmed semantic mapping + canonical rows + rule config + run settings -> findings.
 * Pure and deterministic: no clock (the reference date is an explicit input), no database, no file names. The same inputs always give byte-identical findings.
 *   completeness  role-aware: only REQUIRED / EXPECTED columns; an entirely empty one is ONE dataset-level finding
 *   validity      validators come from each column's validation profile (by role) - never from header text; systematic failures collapse into one finding
 *   consistency   modified-before-created; future dates (against the frozen reference date)
 *   freshness     stale = anniversary (date + threshold) before the reference date; ages from creation only when the column that records changes is absent/empty
 *   uniqueness    only identifiers that must be unique for THIS dataset type (a repeated item code in an entity master is not a defect)
 */
const crypto = require('crypto');
const C = require('./catalog'); const { resolveRuleConfig, hashRuleConfig } = require('./config'); const { VALIDATORS, makeCell } = require('./validators'); const D = require('./dates');
const { canonical, hashConfig } = require('../semantic/config');

const SEV_ORDER = { critical: 0, high: 1, medium: 2, low: 3 }; const CAT_ORDER = Object.fromEntries(C.CATEGORIES.map((c, i) => [c, i]));
const FUTURE_TYPE = { creation_date: 'future_created_date', modification_date: 'future_modified_date', posting_date: 'future_posting_date', document_date: 'future_document_date' };
const short = (v, n = 120) => { const s = v === undefined || v === null ? '' : String(v); return s.length > n ? s.slice(0, n) + '…' : s; };
const fid = (...p) => crypto.createHash('sha256').update(p.join('|')).digest('hex').slice(0, 16);

function runRules(input) {
  const { datasetType = 'mixed_unknown', rows, settings } = input; const cfg = input.ruleConfig || resolveRuleConfig(); const P = cfg.policies;
  const ref = D.validateReferenceDate(settings && settings.reference_date); const years = D.validateThreshold(settings && settings.stale_threshold_years);
  const refDay = D.dayNumber(ref); const dayOf = iso => D.dayNumber(iso); const instant = P.temporal.granularity === 'instant';
  const cols = input.columns.filter(c => c.include_in_analysis !== false && c.include_in_analysis !== 0).map((c, i) => ({ ...c, _i: i, populated: 0, rows: 0 }));
  const skipped = { excluded_columns: input.columns.length - cols.length, unsupported_validators: [], pending_review_columns: [] };
  const enabled = id => cfg.rules[id] && cfg.rules[id].enabled;
  const sevOf = (id, fallback) => (cfg.rules[id].severity || fallback || C.RULES[id].default_severity);
  const paramsOf = (id, profileParams) => ({ ...C.RULES[id].default_params, ...(profileParams || {}), ...cfg.rules[id].params });

  // ---- per-column plans, decided from the confirmed mapping (never from headers)
  const byRole = {}; for (const c of cols) (byRole[c.role] = byRole[c.role] || []).push(c);
  for (const c of cols) {
    c.validators = [];
    const vp = c.validation_profile;
    if (vp && vp.status === 'active') for (const v of vp.validators || []) { if (!C.isRule(v.rule_id) || !VALIDATORS[v.rule_id]) { skipped.unsupported_validators.push(`${c.header_key}: ${v.rule_id}`); continue; } if (enabled(v.rule_id)) c.validators.push({ id: v.rule_id, params: paramsOf(v.rule_id, v.params) }); }
    else if (vp && vp.status === 'pending_review') skipped.pending_review_columns.push(c.header_key);
    // opt-in packs ride along with the legal-id format validator
    if (c.role === 'legal_id' && c.validators.some(v => v.id === 'validity.legal_id_format')) for (const id of ['validity.legal_id_gstin_checksum', 'validity.legal_id_gstin_state_code']) if (enabled(id)) c.validators.push({ id, params: paramsOf(id) });
    c.failures = {}; c.checked = {}; c.blanks = []; c.unresolved = [];
  }
  const dateRoles = new Set(P.date_roles);
  const wanted = new Set([...P.freshness.roles, ...P.temporal.future_roles, 'creation_date', 'modification_date']);
  const uniqueRoles = new Set([...(P.uniqueness.unique_roles_by_dataset_type[datasetType] || []), ...P.uniqueness.always_unique_roles]);
  const uniqueCols = cols.filter(c => uniqueRoles.has(c.role) && c.primary_for_role !== false);
  const lineCol = P.uniqueness.composite_with_line_item ? (byRole.line_item || [])[0] : null;
  const rowKeyCol = (byRole.row_id || [])[0] || null;
  const dateVals = new Map(); for (const c of cols) if (wanted.has(c.role)) dateVals.set(c, []);
  const uniqMaps = new Map(uniqueCols.map(c => [c, new Map()]));
  const rowInfo = []; let nRows = 0;

  // ---- single streaming pass over EVERY row
  for (const r of rows) {
    const raw = r.raw, meta = r.meta || {}, can = r.canonical || {}; const ri = nRows++; const key = rowKeyCol ? raw[rowKeyCol.header_key] : undefined;
    rowInfo.push({ row_number: r.rowNumber, sheet_row: r.sheetRow === undefined ? null : r.sheetRow, record_key: key === undefined || key === null ? null : String(key).trim() });
    let lineVal = null; if (lineCol) { const lv = raw[lineCol.header_key]; lineVal = lv === undefined || lv === null ? '' : String(lv).trim(); }
    for (const c of cols) {
      const k = c.header_key; const cell = makeCell(raw[k], can[k], meta[k]); c.rows++;
      if (cell.blank) { if (c.requiredness === 'required' || c.requiredness === 'expected') c.blanks.push(ri); if (dateVals.has(c)) dateVals.get(c).push(null); continue; }
      c.populated++;
      for (const v of c.validators) { c.checked[v.id] = (c.checked[v.id] || 0) + 1; const res = VALIDATORS[v.id](cell, v.params); if (res) (c.failures[v.id] = c.failures[v.id] || []).push({ ri, value: cell.text, reason: res.reason, type: res.type }); }
      if (dateRoles.has(c.role) && cell.kind === 'date_unresolved') c.unresolved.push({ ri, value: cell.text });
      if (dateVals.has(c)) dateVals.get(c).push(cell.kind === 'date' && cell.iso ? cell.iso : null);
      if (uniqMaps.has(c)) { const kv = cell.text; const kk = lineCol && c.role !== 'row_id' ? kv + '\u0001' + lineVal : kv; const m = uniqMaps.get(c); (m.get(kk) || m.set(kk, []).get(kk)).push(ri); }
    }
  }
  const meta_ = c => ({ file_column_id: c.file_column_id || null, header_key: c.header_key, header_raw: c.header_raw, role: c.role, requiredness: c.requiredness });
  const F = []; const push = f => { F.push(f); return f; };
  const rec = (rule, c, ri, o) => push({ rule_id: rule, category: C.RULES[rule].category, type: (o && o.type) || C.RULES[rule].type, scope: 'record', severity: (o && o.severity) || sevOf(rule), ...meta_(c), row_number: rowInfo[ri].row_number, sheet_row: rowInfo[ri].sheet_row, record_key: rowInfo[ri].record_key, value: o && o.value !== undefined ? short(o.value) : null, message: o && o.message, evidence: (o && o.evidence) || {}, cause_key: `${rule}|${c.header_key}|${rowInfo[ri].row_number}` });
  const ds = (rule, c, o) => push({ rule_id: rule, category: C.RULES[rule].category, type: C.RULES[rule].type, scope: 'dataset', severity: (o && o.severity) || sevOf(rule), ...(c ? meta_(c) : { header_key: null, header_raw: null, role: null, requiredness: null }), row_number: null, sheet_row: null, record_key: null, value: null, message: o.message, evidence: o.evidence || {}, cause_key: `${rule}|${c ? c.header_key : '*'}${o.cause ? '|' + o.cause : ''}` });

  // ---- completeness
  const cp = P.completeness;
  if (nRows > 0) for (const c of cols) {
    if (c.requiredness !== 'required' && c.requiredness !== 'expected') continue;                                          // optional (and unidentified) gaps are never defects
    if (c.populated === 0) { if (enabled('completeness.column_empty')) ds('completeness.column_empty', c, { severity: cfg.rules['completeness.column_empty'].severity || cp.column_empty_severity[c.requiredness], message: `The ${c.requiredness} column "${c.header_raw}" is empty on all ${nRows} records.`, evidence: { rows: nRows, populated: 0, requiredness: c.requiredness } }); continue; }
    const rule = c.requiredness === 'required' ? 'completeness.required_missing' : 'completeness.expected_missing'; if (!enabled(rule)) continue;
    for (const ri of c.blanks) rec(rule, c, ri, { severity: cfg.rules[rule].severity || cp.severity[c.requiredness], message: `${c.requiredness === 'required' ? 'Required' : 'Expected'} value missing in "${c.header_raw}".`, evidence: { requiredness: c.requiredness } });
  }
  // ---- validity (with systematic-failure collapse: one cause = one finding)
  const sf = P.systematic_failure;
  for (const c of cols) for (const v of c.validators) {
    const fails = c.failures[v.id]; if (!fails || !fails.length) continue; const checked = c.checked[v.id] || 0;
    if (enabled('validity.systematic_failure') && checked >= sf.min_populated && fails.length / checked >= sf.min_fail_ratio) {
      ds('validity.systematic_failure', c, { cause: v.id, message: `${v.id} fails on ${fails.length} of ${checked} values in "${c.header_raw}": the column is probably mapped to the wrong role or holds a different format. Review the mapping instead of fixing ${fails.length} records.`,
        evidence: { failed_rule: v.id, failed: fails.length, checked, fail_ratio: +(fails.length / checked).toFixed(4), examples: fails.slice(0, 5).map(f => f.value) } }); continue;
    }
    for (const f of fails) rec(v.id, c, f.ri, { type: f.type, value: f.value, message: `"${c.header_raw}": ${f.reason}.`, evidence: { reason: f.reason } });
  }
  if (enabled('validity.date_format_unresolved')) for (const c of cols) if (c.unresolved.length) ds('validity.date_format_unresolved', c, { message: `${c.unresolved.length} text date(s) in "${c.header_raw}" have an ambiguous format and were not guessed (e.g. "${short(c.unresolved[0].value, 30)}"). Choose the date format for this column.`, evidence: { count: c.unresolved.length, examples: c.unresolved.slice(0, 5).map(u => u.value) } });
  // ---- dates: creation / modification / future / stale
  const firstPopulated = role => (byRole[role] || []).find(c => c.populated > 0) || null;
  const created = firstPopulated('creation_date'), modified = firstPopulated('modification_date'); const skippedRules = {};
  const at = (c, ri) => (c && dateVals.has(c) ? dateVals.get(c)[ri] : null);
  const cmp = (a, b) => (instant ? (a < b ? -1 : a > b ? 1 : 0) : Math.sign(dayOf(a) - dayOf(b)));
  if (enabled('consistency.modified_before_created')) { if (created && modified) for (let ri = 0; ri < nRows; ri++) { const cr = at(created, ri), md = at(modified, ri); if (cr && md && cmp(md, cr) < 0) rec('consistency.modified_before_created', modified, ri, { value: md, message: `Modified (${md}) is earlier than created (${cr}).`, evidence: { created: cr, modified: md, created_column: created.header_raw } }); } else skippedRules['consistency.modified_before_created'] = 'needs a populated creation-date and modification-date column'; }
  if (enabled('consistency.future_date')) for (const role of P.temporal.future_roles) { const c = firstPopulated(role); if (!c) continue; for (let ri = 0; ri < nRows; ri++) { const v = at(c, ri); if (v && dayOf(v) > refDay) rec('consistency.future_date', c, ri, { type: FUTURE_TYPE[role] || 'future_date', value: v, message: `${short(v, 10)} is after the reference date ${ref}.`, evidence: { date: v, reference_date: ref } }); } }
  if (enabled('freshness.stale_record')) {
    const modCol = (byRole.modification_date || []).length ? modified : null; const crCol = created; const modColumnEmpty = !modCol; const fb = P.freshness.creation_fallback; let evaluated = false;
    for (let ri = 0; ri < nRows; ri++) {
      let d = P.freshness.roles.includes('modification_date') ? at(modCol, ri) : null, src = modCol;
      if (!d && P.freshness.roles.includes('creation_date') && crCol && (fb === 'always' || (fb === 'when_modification_column_empty' && modColumnEmpty))) { d = at(crCol, ri); src = crCol; }
      if (!src) continue; evaluated = true;
      const basis = src === crCol && src !== modCol ? 'creation_date' : 'modification_date';   // persisted and exposed: which date the age was measured from
      if (d && D.isStale(d, ref, years)) { const f = rec('freshness.stale_record', src, ri, { value: d, message: basis === 'creation_date' ? `Created ${short(d, 10)} (Creation Date used because Modification Date was unavailable): older than ${years} year(s) at the reference date ${ref}.` : `Last changed ${short(d, 10)}: older than ${years} year(s) at the reference date ${ref}.`, evidence: { date: d, threshold_years: years, reference_date: ref, date_column: src.header_raw, freshness_reference_field: basis, anniversary: D.addMonths(d, D.monthsForYears(years)) } }); f.freshness_reference_field = basis; }
    }
    if (!evaluated) skippedRules['freshness.stale_record'] = 'needs a modification-date (or, when that column is absent/empty, a creation-date) column';
  }
  // ---- uniqueness
  if (enabled('uniqueness.identifier_repeated')) for (const [c, m] of uniqMaps) for (const [kk, list] of m) if (list.length > 1) {
    const value = kk.split('\u0001')[0];
    push({ rule_id: 'uniqueness.identifier_repeated', category: 'uniqueness', type: 'duplicate_identifier', scope: 'group', severity: sevOf('uniqueness.identifier_repeated'), ...meta_(c), row_number: rowInfo[list[0]].row_number, sheet_row: rowInfo[list[0]].sheet_row, record_key: rowInfo[list[0]].record_key,
      rows: list.map(ri => ({ row_number: rowInfo[ri].row_number, sheet_row: rowInfo[ri].sheet_row, record_key: rowInfo[ri].record_key })), value: short(value), message: `${c.role} "${short(value, 40)}" appears on ${list.length} records but must be unique.`, evidence: { count: list.length }, cause_key: `uniqueness.identifier_repeated|${c.header_key}|${kk}` });
  }
  // ---- deterministic order + stable ids
  const pos = Object.fromEntries(cols.map(c => [c.header_key, c.position === undefined ? c._i : c.position]));
  F.sort((a, b) => CAT_ORDER[a.category] - CAT_ORDER[b.category] || a.rule_id.localeCompare(b.rule_id) || (a.row_number === null ? -1 : b.row_number === null ? 1 : a.row_number - b.row_number) || (pos[a.header_key] || 0) - (pos[b.header_key] || 0) || a.cause_key.localeCompare(b.cause_key));
  for (const f of F) f.id = fid(f.cause_key, f.type);
  const count = (fn) => F.reduce((a, f) => { const k = fn(f); a[k] = (a[k] || 0) + 1; return a; }, {});
  const summary = { rows: nRows, columns_analyzed: cols.length, findings: F.length, by_scope: count(f => f.scope), by_severity: count(f => f.severity), by_category: count(f => f.category), by_rule: count(f => f.rule_id),
    record_level_rows_with_findings: new Set(F.filter(f => f.scope === 'record').map(f => f.row_number)).size, skipped, skipped_rules: skippedRules,
    freshness_basis: null };
  { const modPresent = (byRole.modification_date || []).length > 0, fb = P.freshness.creation_fallback; const fromCreation = !modified && created && fb !== 'never' && P.freshness.roles.includes('creation_date');
    summary.freshness_basis = { policy: fb, modification_column: modified ? modified.header_raw : null, creation_column: created ? created.header_raw : null,
      freshness_reference_field: enabled('freshness.stale_record') ? (modified ? (fb === 'always' && created ? 'mixed' : 'modification_date') : fromCreation ? 'creation_date' : null) : null,
      reason: fromCreation ? `Freshness was assessed using Creation Date because Modification Date was ${modPresent ? 'entirely empty' : 'not present'} in this dataset.` : null }; }
  const provenance = { engine_version: C.RULE_ENGINE_VERSION, catalog_version: C.RULE_CATALOG_VERSION, rule_config_version: cfg.version, rule_config_hash: hashRuleConfig(cfg), dataset_type: datasetType, reference_date: ref, stale_threshold_years: years };
  provenance.results_hash = hashConfig({ p: provenance, f: F.map(f => f.id) });
  return { findings: F, summary, provenance, rows: rowInfo };
}
module.exports = { runRules, SEV_ORDER };
