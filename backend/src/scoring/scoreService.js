'use strict';
/*
 * Adapts S4's raw rule result and S5's raw identity result (the SAME in-memory objects the pipeline already computed
 * for persistence) into the plain inputs the pure engine needs, then combines one or more source files' contributions
 * into the run's dimension scores and overall score, and builds the persisted explanation tree.
 */
const E = require('./engine'); const { resolveScoringConfig, hashConfig, SCORING_ENGINE_VERSION } = require('./config');

function groupFindingsByRuleColumn(findings) {
  const m = new Map();
  for (const f of findings) {
    if (f.scope === 'record' || f.scope === 'dataset') { const k = f.rule_id + '|' + (f.header_key || ''); if (!m.has(k)) m.set(k, []); m.get(k).push(f); }
  }
  return m;
}
function populatedCountsOf(columns) { const m = new Map(); for (const c of columns) m.set(c.header_key, c.populated_count || 0); return m; }
const primaryColumnFor = (columns, role) => columns.filter(c => c.role === role && c.include_in_analysis !== false).sort((a, b) => (b.primary_for_role === true) - (a.primary_for_role === true))[0];

/** Score ONE source file's worth of S4/S5 output; returns the raw contribution rows (not yet combined across files). */
function scoreSourceFile({ datasetType, sourceFileId, columns, rowCount, ruleResult, identity, scoringConfig }) {
  const cfg = scoringConfig; const findingsByRuleColumn = groupFindingsByRuleColumn(ruleResult.findings);
  const populatedCounts = populatedCountsOf(columns);
  const contributions = [
    ...E.scoreCompleteness({ columns, rowCount, findingsByRuleColumn, cfg, sourceFileId }),
    ...E.scoreValidity({ columns, findingsByRuleColumn, populatedCounts, cfg, sourceFileId })
  ];

  const popKey = cfg.uniqueness.dataset_type_population[datasetType] || 'entity';
  const population = popKey === 'material' ? (identity.material ? identity.material.records : 0) : popKey === 'transaction' ? (identity.transaction ? identity.transaction.records : 0) : (identity.entity ? identity.entity.records : 0);
  const entityClusters = identity.entity ? identity.entity.clusters : [];
  const materialGroups = [];   // S5 material candidates are ALWAYS review-only (confidence null, never auto-confirmed; there is no
  // confirmation path for them yet) -- per the charter, an unconfirmed candidate is never a uniqueness defect, so material
  // clusters contribute nothing here until a future confirmation mechanism exists. `identity.material` still sets the
  // POPULATION (denominator) below, so a material-master run is still scored -- it will read 100 until that mechanism exists,
  // which is an honest reflection of S5's current scope, not a bug.
  for (const c of E.scoreUniqueness({ datasetType, entityClusters, materialGroups, population, cfg, sourceFileId })) contributions.push(c);
  for (const c of E.scoreConsistency({ conflicts: identity.conflicts, population, cfg, sourceFileId })) contributions.push(c);

  const modCol = primaryColumnFor(columns, 'modification_date'), crCol = primaryColumnFor(columns, 'creation_date');
  const staleList = [modCol, crCol].filter(Boolean).flatMap(c => findingsByRuleColumn.get('freshness.stale_record|' + c.header_key) || []);
  const basis = ruleResult.summary.freshness_basis || {};
  const basisCol = basis.freshness_reference_field === 'creation_date' ? crCol : basis.freshness_reference_field === 'modification_date' ? modCol : (modCol || crCol);
  const datedRowCount = basisCol ? (populatedCounts.get(basisCol.header_key) || 0) : 0;
  for (const c of E.scoreFreshness({ freshnessBasis: basis, staleCount: staleList.length, datedRowCount, staleSeverity: staleList[0] && staleList[0].severity,
    cfg, sourceFileId, staleThresholdYears: ruleResult.provenance.stale_threshold_years, referenceDate: ruleResult.provenance.reference_date })) contributions.push(c);
  return contributions;
}

/** Score a whole run: one or more (sourceFileId, columns, rowCount, ruleResult, identity) tuples sharing one dataset type. */
function scoreRun({ datasetType, files, scoringOverrides }) {
  const cfg = resolveScoringConfig(scoringOverrides);
  const contributions = files.flatMap(f => scoreSourceFile({ datasetType, scoringConfig: cfg, ...f }));
  const combined = E.combine(contributions, cfg);
  return { ...combined, config: cfg, config_hash: hashConfig(cfg), engine_version: SCORING_ENGINE_VERSION,
    mixed_unknown_caveat: datasetType === 'mixed_unknown' ? 'Dataset type is mixed_unknown (a human confirmed this); scores use entity-oriented identity semantics as a default and may not suit this dataset.' : null };
}
module.exports = { scoreRun, scoreSourceFile, groupFindingsByRuleColumn };
