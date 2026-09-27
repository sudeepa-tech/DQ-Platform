'use strict';
/* Engine-neutral scoring of a RunView (see adapter_*.js) against oracle truth (qa/oracle/truth/*.truth.json).
   No expected number is hard-coded here: everything is computed from the truth file, which the independent oracle derives. */
const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/;
const S = a => new Set(a);
const inter = (a, b) => [...a].filter(x => b.has(x));
const pk = (a, b) => (a < b ? a + '|' + b : b + '|' + a);
const pairsOf = m => { const o = []; for (let i = 0; i < m.length; i++) for (let j = i + 1; j < m.length; j++) o.push(pk(m[i], m[j])); return o; };
const rnd = x => Math.round(x * 1000) / 1000;

function entityMetrics(view, truth) {
  const tC = truth.entity_clusters.map(c => c.members), tRec = S(tC.flat());
  const ambPairs = S(truth.ambiguous_pairs.map(p => pk(p.a, p.b))), ambRec = S(truth.ambiguous_pairs.flatMap(p => [p.a, p.b]));
  const fuzzyPairs = S(truth.fuzzy_candidates.map(p => pk(p.a, p.b)));
  const aC = view.entityClusters.map(c => c.members), aRec = S(aC.flat());
  const tP = S(tC.flatMap(pairsOf)), aP = S(aC.flatMap(pairsOf));
  for (const p of ambPairs) { tP.delete(p); aP.delete(p); }
  const ptp = inter(aP, tP).length, pfp = aP.size - ptp, pfn = tP.size - ptp;
  const rTP = inter(aRec, tRec).length, rFP = [...aRec].filter(r => !tRec.has(r) && !ambRec.has(r)), rFN = [...tRec].filter(r => !aRec.has(r));
  const tOf = new Map(); tC.forEach((m, i) => m.forEach(r => tOf.set(r, i)));
  let impure = 0, exact = 0; const tSets = S(tC.map(m => m.join(',')));
  for (const m of aC) { const owners = S(m.map(r => tOf.has(r) ? tOf.get(r) : 'none:' + r)); if (owners.size > 1) impure++; if (tSets.has(m.join(','))) exact++; }
  const gstCol = truth.meta.mapping.columns.gstin; let gstViolations = 0;
  for (const m of aC) { const g = S(m.map(r => (view.records.get(r) || {})[gstCol]).filter(v => v && GSTIN_RE.test(String(v).toUpperCase()))); if (g.size > 1) gstViolations++; }
  const fuzzyClustered = [...fuzzyPairs].filter(p => aP.has(p)).length;
  const sizes = {}; aC.forEach(m => sizes[m.length] = (sizes[m.length] || 0) + 1);
  return { truth: { clusters: tC.length, records: tRec.size }, app: { clusters: aC.length, records: aRec.size, sizes },
    record: { tp: rTP, fp: rFP.length, fn: rFN.length, precision: rnd(rTP / Math.max(1, rTP + rFP.length)), recall: rnd(rTP / Math.max(1, tRec.size)), fp_ids: rFP.slice(0, 12), fn_ids: rFN.slice(0, 12) },
    pair: { tp: ptp, fp: pfp, fn: pfn, precision: rnd(ptp / Math.max(1, aP.size)), recall: rnd(ptp / Math.max(1, tP.size)) },
    clusters_exactly_correct: exact, clusters_impure: impure, clusters_with_two_valid_gstins: gstViolations, fuzzy_candidates_auto_clustered: fuzzyClustered };
}

const LEG_GST = t => t === 'shared_gstin_multi_entity' || t === 'gstin_shared_identity';
function conflictMetrics(view, truth) {
  const tg = truth.conflict_groups; const byType = {}; tg.forEach(g => { (byType[g.type] = byType[g.type] || []).push(g.members.join(',')); });
  const app = view.conflicts.filter(c => !/item_code|material/.test(c.type)); const sets = S(app.map(c => c.members.join(',')));
  const gstApp = app.filter(c => LEG_GST(c.type)), gstSets = S(gstApp.map(c => c.members.join(',')));
  const out = { truth_groups_by_type: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, v.length])), app_conflict_rows_identity_or_contact: app.length,
    app_distinct_member_sets: sets.size, rows_per_distinct_group: rnd(app.length / Math.max(1, sets.size)) };
  for (const [t, list] of Object.entries(byType)) { const ts = S(list); const found = t === 'gstin_shared_identity' ? inter(ts, gstSets).length : inter(ts, S(app.filter(c => c.type === t).map(c => c.members.join(',')))).length; out['found_' + t] = `${found}/${ts.size}`; }
  out.gst_rows = gstApp.length; out.gst_distinct_sets = gstSets.size; out.extra_groups_not_in_truth = [...sets].filter(s => !S(tg.map(g => g.members.join(','))).has(s)).length;
  return out;
}

function itemMetrics(view, truth) {
  const norm = c => String(c).replace(/[\s\-_.\/]/g, '').toUpperCase();
  const t = S(truth.item_conflicts.map(g => norm(g.code))), minority = S(truth.item_conflicts.flatMap(g => g.minority_records));
  const app = view.conflicts.filter(c => /item_code|material/.test(c.type)); const a = S(app.map(c => norm(c.subject)));
  const flagged = S(app.flatMap(c => c.members));
  return { truth_codes: t.size, app_codes: a.size, codes_found: inter(t, a).length, codes_missing: [...t].filter(x => !a.has(x)), codes_extra: [...a].filter(x => !t.has(x)),
    records_flagged_by_conflicts: flagged.size, minority_truth_records: minority.size, minority_recall: rnd(inter(minority, flagged).length / Math.max(1, minority.size)), flagged_precision_vs_minority: rnd(inter(minority, flagged).length / Math.max(1, flagged.size)) };
}

function setCmp(exp, act) { exp = S(exp); act = S(act); const tp = inter(exp, act).length; return { expected: exp.size, detected: act.size, tp, fp: act.size - tp, fn: exp.size - tp, fn_ids: [...exp].filter(x => !act.has(x)).slice(0, 15), fp_ids: [...act].filter(x => !exp.has(x)).slice(0, 15) }; }
function staleTruth(truth, refISO, years) { const rd = Date.parse(refISO + 'T00:00:00Z'); return Object.entries(truth.records).filter(([, r]) => r.modified && (rd - Date.parse(r.modified + 'T00:00:00Z')) / 86400000 / 365.25 > years).map(([k]) => k); }
function issueMetrics(view, truth, opts = {}) {
  const keys = i => i.filter(x => x.key).map(x => x.key);
  const cat = c => keys(view.issues.filter(i => i.category === c)), typ = t => keys(view.issues.filter(i => t.includes(i.type)));
  const ref = opts.referenceDate || new Date().toISOString().slice(0, 10), yrs = opts.staleYears || view.config.stale_after_years || 3;
  const missField = {}; Object.entries(truth.missing.records).forEach(([k, f]) => f.forEach(x => (missField[x] = missField[x] || []).push(k)));
  const invFields = {}; Object.entries(truth.invalid.records).forEach(([k, l]) => l.forEach(x => (invFields[x.field] = invFields[x.field] || []).push(k)));
  const flaggedFields = (category) => { const m = {}; view.issues.filter(i => i.category === category && i.key && i.field).forEach(i => (m[i.field] = m[i.field] || new Set()).add(i.key)); return m; };
  const mf = flaggedFields('completeness'), vf = flaggedFields('validity');
  const perField = (truthF, appF) => Object.fromEntries(Object.entries(truthF).map(([f, ks]) => [f, `${ks.filter(k => (appF[f] || new Set()).has(k)).length}/${ks.length}`]));
  return { missing: { ...setCmp(Object.keys(truth.missing.records), cat('completeness')), by_field_detected: perField(missField, mf) },
    invalid: { ...setCmp(Object.keys(truth.invalid.records), cat('validity')), by_field_detected: perField(invFields, vf) },
    temporal: setCmp(truth.temporal.modified_before_created, typ(['modified_before_created', 'temporal'])),
    future: setCmp([...truth.temporal.future_created, ...truth.temporal.future_modified], typ(['future_created_date', 'future_modified_date'])),
    stale: { reference_date: ref, threshold_years: yrs, ...setCmp(staleTruth(truth, ref, yrs), typ(['stale_record'])) },
    stale_sensitivity_truth: truth.stale_table.map(s => `${s.reference_date}@${s.threshold_years}y=${s.count}`),
    uniqueness_noise: { duplicate_identifier_issue_rows: view.issues.filter(i => i.type === 'duplicate_identifier').length, on_item_or_material_fields: view.issues.filter(i => i.type === 'duplicate_identifier' && /item|material/i.test(i.field || '')).length },
    total_issues: view.issues.length, records_with_any_issue: S(keys(view.issues)).size };
}

function scoreAll(view, truth, opts) {
  return { engine: view.engine, records: view.records.size, entity: entityMetrics(view, truth), conflicts: conflictMetrics(view, truth), item: itemMetrics(view, truth), issues: issueMetrics(view, truth, opts),
    scores: view.scores, persisted_pairs: view.persistedPairs, item_clusters: view.itemClusters ? { count: view.itemClusters.length, records: view.itemClusters.reduce((a, c) => a + c.members.length, 0) } : null,
    exact_repeat_entity_clusters_hidden_from_headline: view.entityClusters.filter(c => c.exactRepeat).length };
}
module.exports = { scoreAll, entityMetrics, conflictMetrics, itemMetrics, issueMetrics, staleTruth, GSTIN_RE };
