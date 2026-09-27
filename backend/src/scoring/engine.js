'use strict';
/*
 * THE SCORING ENGINE (S7): a PURE function over already-computed S4 findings, S5 identity results, S2 column facts (populated
 * counts) and the confirmed run configuration. No clock, no I/O, no dataset/file-name awareness -- exactly like S4's and S5's
 * own engines. It never re-derives findings; it only aggregates and weights what S4/S5 already decided, per the formula:
 *
 *   defect_rate      = weighted_defects / scoring_opportunities        (weighted_defects = sum of defects * severity_weight)
 *   dimension_score  = 100 * (1 - min(1, defect_rate))
 *   overall_score    = weighted mean of the five dimension scores (dimension_weights, must sum to 1)
 *
 * "No double counting" (S7 charter #9) is enforced structurally: exactly ONE score_contributions row exists per
 * (dimension, rule concept, physical column OR identity concept); a systematically-failing column's per-row findings are
 * NEVER also counted (S4 itself never emits both); an entirely-empty required/expected column is ONE contribution
 * (opportunities=1, defects=1), never N; a conflict group is ONE unit regardless of how many evidence paths reveal it
 * (S5 already guarantees this -- see conflicts.js); a record touched by several conflict groups is counted ONCE.
 */
const SEV_ORDER = ['low', 'medium', 'high', 'critical'];
const worstSeverity = list => list.reduce((w, s) => (SEV_ORDER.indexOf(s) > SEV_ORDER.indexOf(w) ? s : w), 'low');
const round2 = n => Math.round(n * 100) / 100;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

function contribution({ dimension, rule_id, scope, scoring_unit = 'record', opportunities, defects, severity, cfg, explanation, evidence, source_file_id }) {
  const w = cfg.severity_weights[severity] ?? cfg.severity_weights.medium;
  const defect_rate = opportunities > 0 ? clamp(defects / opportunities, 0, 1) : 0;
  const penalty_points = round2(defect_rate * w * 100);
  return { dimension, rule_id, scope, scoring_unit, opportunities, defects, defect_rate: round2(defect_rate), severity_weight: w, penalty_points, explanation, evidence: evidence || null, source_file_id: source_file_id || null };
}

/** COMPLETENESS: required/expected columns only; optional and excluded columns are never a scoring opportunity. An
 *  entirely-empty column is ONE dataset-level defect (never N row defects); a partially-empty column contributes one
 *  record-level defect per missing value it actually has (already exactly what S4's completeness.required_missing /
 *  completeness.expected_missing findings are, one per blank cell -- summing them here does not re-derive anything new). */
function scoreCompleteness({ columns, rowCount, findingsByRuleColumn, cfg, sourceFileId }) {
  const contributions = [];
  for (const c of columns) {
    if (c.include_in_analysis === false) continue;
    if (c.requiredness !== 'required' && c.requiredness !== 'expected') continue;   // optional: never a completeness opportunity
    const emptyFindings = findingsByRuleColumn.get('completeness.column_empty|' + c.header_key);
    if (emptyFindings && emptyFindings.length) {
      const f = emptyFindings[0];
      contributions.push(contribution({ dimension: 'completeness', rule_id: `completeness.column_empty|${c.header_key}`, scope: 'dataset', scoring_unit: 'column',
        opportunities: 1, defects: 1, severity: f.severity, cfg, source_file_id: sourceFileId,
        explanation: `"${c.header_raw}" (${c.requiredness}) is entirely empty -- one dataset-level defect, not ${rowCount} row defects.`,
        evidence: { header_key: c.header_key, header_raw: c.header_raw, requiredness: c.requiredness, rows: rowCount } }));
      continue;   // an entirely-empty column contributes ONLY the dataset-level defect; its (nonexistent) per-row findings are never separately counted
    }
    const rule = c.requiredness === 'required' ? 'completeness.required_missing' : 'completeness.expected_missing';
    const missing = findingsByRuleColumn.get(rule + '|' + c.header_key) || [];
    if (rowCount > 0) contributions.push(contribution({ dimension: 'completeness', rule_id: `${rule}|${c.header_key}`, scope: 'record', scoring_unit: 'record',
      opportunities: rowCount, defects: missing.length, severity: missing[0] ? missing[0].severity : (c.requiredness === 'required' ? 'high' : 'low'), cfg, source_file_id: sourceFileId,
      explanation: `${missing.length} of ${rowCount} rows are missing "${c.header_raw}" (${c.requiredness}).`,
      evidence: { header_key: c.header_key, header_raw: c.header_raw, requiredness: c.requiredness } }));
  }
  return contributions;
}

/** VALIDITY: one contribution per (validator, physical column). A systematic-failure collapse (S4's own dataset-scope
 *  finding, replacing what would otherwise be one record-level finding per bad value) is used AS-IS -- its own
 *  opportunities/defects counts are exactly the "checked"/"failed" figures S4 computed; the per-row findings for that
 *  same (column, validator) never separately exist (S4 skips emitting them once systematic failure fires), so there is
 *  nothing to double-count. Otherwise, opportunities = the column's populated cell count (a validator only ever checks
 *  populated cells; blanks are completeness's concern, not validity's). */
function scoreValidity({ columns, findingsByRuleColumn, populatedCounts, cfg, sourceFileId }) {
  const contributions = [];
  const byColumnValidator = new Map();
  for (const [key, list] of findingsByRuleColumn) {
    const at = key.lastIndexOf('|'); const ruleId = key.slice(0, at), headerKey = key.slice(at + 1);
    if (!list.length || list[0].category !== 'validity') continue;
    const k = headerKey + '::' + ruleId; if (!byColumnValidator.has(k)) byColumnValidator.set(k, { headerKey, ruleId, list });
  }
  for (const { headerKey, ruleId, list } of byColumnValidator.values()) {
    const col = columns.find(c => c.header_key === headerKey); if (!col || col.include_in_analysis === false) continue;
    if (ruleId === 'validity.systematic_failure') {
      const f = list[0]; const ev = f.evidence || {};
      contributions.push(contribution({ dimension: 'validity', rule_id: `validity.systematic_failure|${headerKey}|${ev.failed_rule || ''}`, scope: 'dataset', scoring_unit: 'column',
        opportunities: ev.checked || 0, defects: ev.failed || 0, severity: f.severity, cfg, source_file_id: sourceFileId,
        explanation: `"${col.header_raw}": ${ev.failed_rule} fails on ${ev.failed} of ${ev.checked} values (systematic -- probably a mapping issue, not ${ev.checked} separate defects).`,
        evidence: { header_key: headerKey, header_raw: col.header_raw, ...ev } }));
      continue;
    }
    const populated = populatedCounts.get(headerKey) || 0;
    contributions.push(contribution({ dimension: 'validity', rule_id: `${ruleId}|${headerKey}`, scope: 'record', scoring_unit: 'record',
      opportunities: populated, defects: list.length, severity: list[0].severity, cfg, source_file_id: sourceFileId,
      explanation: `${list.length} of ${populated} populated values in "${col.header_raw}" fail ${ruleId}.`,
      evidence: { header_key: headerKey, header_raw: col.header_raw, rule_id: ruleId } }));
  }
  return contributions;
}

/** UNIQUENESS: only clustered matches S5 already accepted (auto_accepted / needs_review / confirmed -- i.e. any real
 *  entity_clusters / material groups row). Candidates that never became a cluster (fuzzy, hard-id-name-unknown,
 *  ambiguous, material and transaction candidates -- ALL of which S5 keeps confidence-null and never auto-clusters)
 *  contribute NOTHING until a human confirms them; there is currently no confirmation path for material/transaction
 *  candidates at all, so those dimensions' uniqueness defects are always 0 (an honest reflection of S5's scope, not a
 *  bug). "Redundant records" = cluster members beyond the first per cluster (the standard redundancy convention). */
function scoreUniqueness({ datasetType, entityClusters, materialGroups, population, cfg, sourceFileId }) {
  const clusters = (entityClusters || []).map(c => ({ record_count: c.members.length })).concat(materialGroups || []);
  const redundant = clusters.reduce((s, c) => s + Math.max(0, c.record_count - 1), 0);
  const worst = worstSeverity(clusters.map(() => 'medium')); // duplicate records are a medium-severity data-quality concern by default (no per-cluster severity is computed by S5)
  const denom = population || 0;
  const explanation = clusters.length ? `${redundant} redundant record(s) across ${clusters.length} cluster(s) out of ${denom} ${datasetType === 'master_material' ? 'material' : 'entity'} record(s).` : `No confirmed duplicate clusters out of ${denom} record(s).`;
  return [contribution({ dimension: 'uniqueness', rule_id: 'identity.duplicate_records', scope: 'cluster', scoring_unit: cfg.uniqueness.scoring_unit,
    opportunities: denom, defects: redundant, severity: worst, cfg, source_file_id: sourceFileId, explanation,
    evidence: { clusters: clusters.length, redundant_records: redundant, population: denom } })];
}

/** CONSISTENCY: one conflict GROUP = one underlying cause (S5 already guarantees this: a GSTIN shared across many
 *  evidence paths and many pairs is still one conflict_groups row). Scoring counts DISTINCT RECORDS touched by at least
 *  one conflict group (a record in two different conflict groups is counted once, at its worst severity), not once per
 *  group-membership and never once per evidence path. */
function scoreConsistency({ conflicts, population, cfg, sourceFileId }) {
  const bySeverity = new Map(); // row_number -> worst severity (S5 conflict members are {row_number, sheet_row, record_key} refs, never a bare scalar)
  const bySeverityDefault = { entity: 'high', item: 'medium' };
  for (const c of conflicts || []) { const sev = bySeverityDefault[c.kind] || 'medium'; for (const m of c.members) { const key = m.row_number; const cur = bySeverity.get(key); if (!cur || SEV_ORDER.indexOf(sev) > SEV_ORDER.indexOf(cur)) bySeverity.set(key, sev); } }
  const affected = bySeverity.size; const worst = worstSeverity([...bySeverity.values()]); const denom = population || 0;
  const byType = {}; for (const c of conflicts || []) byType[c.type] = (byType[c.type] || 0) + 1;
  const explanation = affected ? `${affected} record(s) involved in ${(conflicts || []).length} conflict group(s) (${Object.entries(byType).map(([t, n]) => `${n} ${t}`).join(', ')}) out of ${denom} record(s).` : `No conflicts out of ${denom} record(s).`;
  return [contribution({ dimension: 'consistency', rule_id: 'identity.conflict_groups', scope: 'conflict_group', scoring_unit: cfg.consistency.scoring_unit,
    opportunities: denom, defects: affected, severity: affected ? worst : 'low', cfg, source_file_id: sourceFileId, explanation,
    evidence: { conflict_groups: (conflicts || []).length, affected_records: affected, by_type: byType, population: denom } })];
}

/** FRESHNESS: records with NEITHER a creation nor a modification date are excluded from both the denominator and the
 *  defect count (never silently "fresh", never penalised as "stale" -- there is simply no evidence either way). The
 *  reference date, threshold and basis (Modification_Date, or the approved Creation_Date fallback) all come from S4's
 *  own already-resolved run summary; scoring reads them, it never re-resolves a date or touches the clock. */
function scoreFreshness({ freshnessBasis, staleCount, datedRowCount, staleSeverity, cfg, sourceFileId, staleThresholdYears, referenceDate }) {
  const denom = datedRowCount || 0;
  const basis = freshnessBasis && freshnessBasis.freshness_reference_field;
  const explanation = basis ? `${staleCount} of ${denom} dated record(s) are stale (older than ${staleThresholdYears} year(s) as of ${referenceDate}; basis: ${basis}).` : `No usable date column: freshness is not scored for this file (0 dated records).`;
  return [contribution({ dimension: 'freshness', rule_id: 'freshness.stale_record', scope: 'record', scoring_unit: 'record',
    opportunities: denom, defects: staleCount || 0, severity: staleSeverity || 'medium', cfg, source_file_id: sourceFileId, explanation,
    evidence: { basis: basis || null, stale_threshold_years: staleThresholdYears, reference_date: referenceDate, dated_records: denom } })];
}

/** Combine every dimension's contributions (across however many source files a run has) into that dimension's score,
 *  then the overall score as the configured weighted mean. Every score is clamped into [0,100]; NaN/Infinity can never
 *  occur because a 0-opportunity dimension defines defect_rate = 0 (perfect score), not a division by zero. */
function combine(contributions, cfg) {
  const dims = ['completeness', 'validity', 'uniqueness', 'consistency', 'freshness'];
  const perDim = {};
  for (const d of dims) {
    const rows = contributions.filter(c => c.dimension === d);
    const opportunities = rows.reduce((s, r) => s + r.opportunities, 0);
    const weightedDefects = rows.reduce((s, r) => s + r.defects * r.severity_weight, 0);
    const rawDefects = rows.reduce((s, r) => s + r.defects, 0);
    const defect_rate = opportunities > 0 ? clamp(weightedDefects / opportunities, 0, 1) : 0;
    const score = clamp(round2(100 * (1 - defect_rate)), 0, 100);
    perDim[d] = { score, weight: cfg.dimension_weights[d], denominator: opportunities, defect_count: rawDefects, weighted_defects: round2(weightedDefects), defect_rate: round2(defect_rate), contributions: rows };
  }
  const overall = round2(dims.reduce((s, d) => s + perDim[d].score * cfg.dimension_weights[d], 0));
  return { overall: clamp(overall, 0, 100), dimensions: perDim };
}

module.exports = { scoreCompleteness, scoreValidity, scoreUniqueness, scoreConsistency, scoreFreshness, combine, worstSeverity };
