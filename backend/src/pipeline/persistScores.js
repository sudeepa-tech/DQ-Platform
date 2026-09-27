'use strict';
/*
 * Persist a scored run's dimension scores, overall score and per-rule contributions. Never writes for a legacy or
 * already-completed run (structural triggers refuse it regardless). One explanation_json per dimension (and one for
 * 'overall') so the UI never has to reconstruct the explanation tree from raw findings.
 */
const crypto = require('crypto');
const uuid = () => crypto.randomUUID();

function explanationFor(dim, d) {
  return { score: d.score, weight: d.weight, denominator: d.denominator, defect_count: d.defect_count, weighted_defects: d.weighted_defects, defect_rate: d.defect_rate,
    items: d.contributions.map(c => ({ rule_id: c.rule_id, scope: c.scope, scoring_unit: c.scoring_unit, opportunities: c.opportunities, defects: c.defects, defect_rate: c.defect_rate, severity_weight: c.severity_weight, penalty_points: c.penalty_points, explanation: c.explanation })) };
}

function persistScoreResult(db, { runId, scored }) {
  const insScore = db.prepare(`INSERT INTO run_scores (run_id, dimension, score, weight, denominator, defect_count, explanation_json, formula_version) VALUES (?,?,?,?,?,?,?,?)`);
  const insContrib = db.prepare(`INSERT INTO score_contributions (id, run_id, source_file_id, dimension, rule_id, scope, scoring_unit, opportunities, defects, defect_rate, severity_weight, penalty_points, explanation, evidence_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const dims = ['completeness', 'validity', 'uniqueness', 'consistency', 'freshness'];
  for (const dim of dims) {
    const d = scored.dimensions[dim];
    insScore.run(runId, dim, d.score, d.weight, d.denominator, d.defect_count, JSON.stringify(explanationFor(dim, d)), scored.engine_version);
    for (const c of d.contributions) insContrib.run(uuid(), runId, c.source_file_id, c.dimension, c.rule_id, c.scope, c.scoring_unit, c.opportunities, c.defects, c.defect_rate, c.severity_weight, c.penalty_points, c.explanation, c.evidence ? JSON.stringify(c.evidence) : null);
  }
  const overallExplanation = { overall: scored.overall, dimension_weights: Object.fromEntries(dims.map(d => [d, scored.dimensions[d].weight])), dimension_scores: Object.fromEntries(dims.map(d => [d, scored.dimensions[d].score])), mixed_unknown_caveat: scored.mixed_unknown_caveat };
  insScore.run(runId, 'overall', scored.overall, null, null, null, JSON.stringify(overallExplanation), scored.engine_version);
  return { dimensions: dims.length, contributions: dims.reduce((s, d) => s + scored.dimensions[d].contributions.length, 0) };
}
module.exports = { persistScoreResult };
