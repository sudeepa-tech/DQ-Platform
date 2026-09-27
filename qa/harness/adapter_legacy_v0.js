'use strict';
/* Adapter: legacy engine (engine_version undefined / v0) DB schema -> engine-neutral RunView.
   S6/S7 add adapter_v1.js exposing the SAME shape; scoring/regression code never touches engine tables directly. */
const { DatabaseSync } = require('node:sqlite');
function loadRun(dbPath, { runId, keyColumn }) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const run = runId ? db.prepare('SELECT * FROM analysis_runs WHERE id=?').get(runId) : db.prepare('SELECT * FROM analysis_runs ORDER BY started_at DESC LIMIT 1').get();
  const recs = db.prepare('SELECT id, raw_json, source_row_ref, created_date, modified_date FROM records WHERE run_id=?').all(run.id);
  const keyOf = new Map(), raw = new Map(), rows = new Map();
  for (const r of recs) { const j = JSON.parse(r.raw_json); const k = String(j[keyColumn]); keyOf.set(r.id, k); raw.set(k, j); rows.set(k, { row: r.source_row_ref, created: r.created_date, modified: r.modified_date }); }
  const members = new Map(); for (const m of db.prepare('SELECT cluster_id, record_id FROM entity_cluster_members').all()) { if (!members.has(m.cluster_id)) members.set(m.cluster_id, []); members.get(m.cluster_id).push(keyOf.get(m.record_id)); }
  const clusters = db.prepare('SELECT * FROM entity_clusters WHERE run_id=?').all(run.id).map(c => ({ id: c.id, kind: c.cluster_kind, members: (members.get(c.id) || []).filter(Boolean).sort(), exactRepeat: !!c.is_exact_repeat, confidence: c.confidence, factors: JSON.parse(c.matching_factors_json || '[]'), conflicts: JSON.parse(c.conflicts_json || '[]') }));
  const issues = db.prepare('SELECT record_id, category, issue_type, field_name, severity FROM quality_issues WHERE run_id=?').all(run.id).map(i => ({ key: i.record_id ? keyOf.get(i.record_id) : null, category: i.category, type: i.issue_type, field: i.field_name, severity: i.severity }));
  const conflicts = db.prepare('SELECT conflict_type, shared_value, field_name, record_ids_json FROM conflicts WHERE run_id=?').all(run.id).map(c => ({ type: c.conflict_type, subject: c.shared_value, field: c.field_name, members: JSON.parse(c.record_ids_json).map(i => keyOf.get(i)).sort() }));
  const pairs = db.prepare('SELECT COUNT(*) c FROM match_pairs WHERE run_id=?').get(run.id).c;
  const health = run.health_breakdown_json ? JSON.parse(run.health_breakdown_json) : null;
  db.close();
  return { engine: 'legacy_v0', run, records: raw, rows, entityClusters: clusters.filter(c => c.kind === 'entity'), itemClusters: clusters.filter(c => c.kind === 'item'), issues, conflicts,
    persistedPairs: pairs, scores: health ? { overall: health.overall, dims: Object.fromEntries(['completeness', 'validity', 'uniqueness', 'consistency', 'freshness'].map(d => [d, health.breakdown[d].score])) } : null,
    config: { stale_after_years: 3, reference: 'run-time clock (not persisted)', stale_definition: 'now.diff(modified,day)/365.25 > 3' } };
}
module.exports = { loadRun };
