'use strict';
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

function getRunOrThrow(req) {
  const run = db.prepare(`SELECT ar.* FROM analysis_runs ar
    JOIN datasets d ON d.id = ar.dataset_id
    WHERE ar.id = ? AND d.organization_id = ?`).get(req.params.runId, req.user.org);
  return run;
}

// A 'transaction' record (a row that carries both entity and item
// attributes -- see analysisOrchestrator.js) genuinely belongs to BOTH
// semantic categories at once. Filtering by record_kind=entity or
// record_kind=item should therefore include 'transaction' rows too,
// rather than only exact-matching the literal stored kind -- otherwise
// every count and filter involving record_kind silently excludes
// transactional data, which is exactly the bug that made item-level
// issues/records invisible for transactional exports.
function expandRecordKind(kind) {
  if (kind === 'entity') return ['entity', 'transaction'];
  if (kind === 'item') return ['item', 'transaction'];
  return [kind];
}

// ---------------- Analysis Runs (org-wide history / traceability) ----------------
router.get('/', (req, res) => {
  const { dataset_id, status, page = 1, page_size = 50 } = req.query;
  const where = ['d.organization_id = ?'];
  const params = [req.user.org];
  if (dataset_id) { where.push('ar.dataset_id = ?'); params.push(dataset_id); }
  if (status) { where.push('ar.status = ?'); params.push(status); }
  const whereSql = where.join(' AND ');

  const total = db.prepare(`SELECT COUNT(*) c FROM analysis_runs ar JOIN datasets d ON d.id = ar.dataset_id WHERE ${whereSql}`).get(...params).c;
  const limit = Math.min(200, Number(page_size));
  const offset = (Number(page) - 1) * limit;
  const runs = db.prepare(`
    SELECT ar.*, d.name as dataset_name,
      (SELECT COUNT(*) FROM quality_issues qi WHERE qi.run_id = ar.id) as issue_count,
      (SELECT COUNT(*) FROM conflicts c WHERE c.run_id = ar.id) as conflict_count,
      (SELECT COALESCE(SUM(record_count),0) FROM entity_clusters ec WHERE ec.run_id = ar.id) as duplicate_record_count
    FROM analysis_runs ar JOIN datasets d ON d.id = ar.dataset_id
    WHERE ${whereSql} ORDER BY ar.started_at DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  res.json({ runs, total, page: Number(page), page_size: limit });
});

router.get('/:runId', (req, res) => {
  const run = getRunOrThrow(req);
  if (!run) return res.status(404).json({ error: 'Analysis run not found.' });
  res.json({ run });
});

router.get('/:runId/dashboard', (req, res) => {
  const run = getRunOrThrow(req);
  if (!run) return res.status(404).json({ error: 'Analysis run not found.' });

  const recordCount = db.prepare('SELECT COUNT(*) c FROM records WHERE run_id = ?').get(run.id).c;
  const fileCount = db.prepare('SELECT COUNT(DISTINCT source_file_id) c FROM records WHERE run_id = ?').get(run.id).c;

  const issuesBySeverity = db.prepare(`SELECT severity, COUNT(*) c FROM quality_issues WHERE run_id = ? GROUP BY severity`).all(run.id);
  const issuesByCategory = db.prepare(`SELECT category, COUNT(*) c FROM quality_issues WHERE run_id = ? GROUP BY category`).all(run.id);
  const affectedByCategory = db.prepare(`SELECT category, COUNT(DISTINCT record_id) c FROM quality_issues WHERE run_id = ? AND record_id IS NOT NULL GROUP BY category`).all(run.id);
  const issuesByType = db.prepare(`SELECT issue_type, category, severity, COUNT(*) c FROM quality_issues WHERE run_id = ? GROUP BY issue_type ORDER BY c DESC LIMIT 20`).all(run.id);

  const criticalCount = db.prepare(`SELECT COUNT(*) c FROM quality_issues WHERE run_id = ? AND severity = 'critical'`).get(run.id).c;
  const incompleteCount = db.prepare(`SELECT COUNT(DISTINCT record_id) c FROM quality_issues WHERE run_id = ? AND category = 'completeness'`).get(run.id).c;
  const invalidCount = db.prepare(`SELECT COUNT(DISTINCT record_id) c FROM quality_issues WHERE run_id = ? AND category = 'validity'`).get(run.id).c;
  const staleCount = db.prepare(`SELECT COUNT(DISTINCT record_id) c FROM quality_issues WHERE run_id = ? AND issue_type = 'stale_record'`).get(run.id).c;
  const recordsWithAnyIssue = db.prepare(`SELECT COUNT(DISTINCT record_id) c FROM quality_issues WHERE run_id = ? AND record_id IS NOT NULL`).get(run.id).c;

  const clusters = db.prepare(`SELECT cluster_kind, COUNT(*) c, SUM(record_count) records, AVG(confidence) avg_conf,
      SUM(CASE WHEN is_exact_repeat = 0 THEN 1 ELSE 0 END) variant_clusters,
      SUM(CASE WHEN is_exact_repeat = 0 THEN record_count ELSE 0 END) variant_records
    FROM entity_clusters WHERE run_id = ? GROUP BY cluster_kind`).all(run.id);
  // "Duplicate candidates" (the headline KPI) counts only records in
  // clusters that are genuine spelling/formatting VARIANTS -- a cluster
  // where every member is textually identical (the same known vendor or
  // material legitimately recurring across many transaction rows) is not
  // a data-quality finding and must not inflate this number. Exact-repeat
  // volume is still reported, just under its own honest label.
  const totalDuplicateRecords = db.prepare(`SELECT COALESCE(SUM(record_count),0) c FROM entity_clusters WHERE run_id = ? AND is_exact_repeat = 0`).get(run.id).c;
  const exactRepeatRecords = db.prepare(`SELECT COALESCE(SUM(record_count),0) c FROM entity_clusters WHERE run_id = ? AND is_exact_repeat = 1`).get(run.id).c;
  const conflictCount = db.prepare(`SELECT COUNT(*) c FROM conflicts WHERE run_id = ?`).get(run.id).c;

  const ageBuckets = db.prepare(`
    SELECT
      CASE
        WHEN modified_date IS NULL THEN 'unknown'
        WHEN julianday('now') - julianday(modified_date) <= 365 THEN '< 1 year'
        WHEN julianday('now') - julianday(modified_date) <= 365*3 THEN '1-3 years'
        WHEN julianday('now') - julianday(modified_date) <= 365*5 THEN '3-5 years'
        ELSE '5+ years'
      END as bucket,
      COUNT(*) c
    FROM records WHERE run_id = ? GROUP BY bucket
  `).all(run.id);

  const fieldProfiles = db.prepare(`SELECT column_name, inferred_type, inferred_role, null_pct, distinct_count, cardinality_ratio, source_file_id
    FROM field_profiles WHERE run_id = ?`).all(run.id);

  const healthBreakdown = run.health_breakdown_json ? JSON.parse(run.health_breakdown_json) : null;

  const totalIssueCount = db.prepare(`SELECT COUNT(*) c FROM quality_issues WHERE run_id = ?`).get(run.id).c;

  res.json({
    run,
    summary: {
      records_analyzed: recordCount,
      files_analyzed: fileCount,
      health_score: run.health_score,
      critical_issues: criticalCount,
      total_issues: totalIssueCount,
      records_with_any_issue: recordsWithAnyIssue,
      pct_records_requiring_attention: recordCount ? Math.round((recordsWithAnyIssue / recordCount) * 1000) / 10 : 0,
      potential_duplicate_records: totalDuplicateRecords,
      exact_repeat_records: exactRepeatRecords,
      incomplete_records: incompleteCount,
      invalid_records: invalidCount,
      conflicts: conflictCount,
      stale_records: staleCount
    },
    health: healthBreakdown,
    issues_by_severity: issuesBySeverity,
    issues_by_category: issuesByCategory,
    affected_records_by_category: affectedByCategory,
    top_issue_types: issuesByType,
    clusters_by_kind: clusters,
    age_distribution: ageBuckets,
    field_profiles: fieldProfiles
  });
});

router.get('/:runId/field-profiles', (req, res) => {
  const run = getRunOrThrow(req);
  if (!run) return res.status(404).json({ error: 'Analysis run not found.' });
  const profiles = db.prepare(`SELECT fp.*, sf.original_filename FROM field_profiles fp
    JOIN source_files sf ON sf.id = fp.source_file_id WHERE fp.run_id = ? ORDER BY sf.original_filename, fp.column_index`).all(run.id);
  res.json({ field_profiles: profiles.map(p => ({ ...p, sample_values: JSON.parse(p.sample_values_json || '[]'), stats: JSON.parse(p.stats_json || '{}') })) });
});

// ---------------- Issue Explorer ----------------
router.get('/:runId/issues', (req, res) => {
  const run = getRunOrThrow(req);
  if (!run) return res.status(404).json({ error: 'Analysis run not found.' });
  const { severity, category, issue_type, record_kind, field_name, search, page = 1, page_size = 50 } = req.query;

  const where = ['qi.run_id = ?'];
  const params = [run.id];
  const joinRecords = !!record_kind;
  if (severity) { where.push('qi.severity = ?'); params.push(severity); }
  if (category) { where.push('qi.category = ?'); params.push(category); }
  if (issue_type) { where.push('qi.issue_type = ?'); params.push(issue_type); }
  if (field_name) { where.push('qi.field_name = ?'); params.push(field_name); }
  if (record_kind) {
    const kinds = expandRecordKind(record_kind);
    where.push(`r.record_kind IN (${kinds.map(() => '?').join(',')})`);
    for (const k of kinds) params.push(k);
  }
  if (search) { where.push('qi.explanation LIKE ?'); params.push(`%${search}%`); }

  const whereSql = where.join(' AND ');
  const fromSql = (joinRecords ? 'quality_issues qi JOIN records r ON r.id = qi.record_id' : 'quality_issues qi LEFT JOIN records r ON r.id = qi.record_id')
    + ' LEFT JOIN source_files sf ON sf.id = COALESCE(qi.source_file_id, r.source_file_id)';
  const total = db.prepare(`SELECT COUNT(*) c FROM ${fromSql} WHERE ${whereSql}`).get(...params).c;
  const limit = Math.min(200, Number(page_size));
  const offset = (Number(page) - 1) * limit;
  const issues = db.prepare(`SELECT qi.*, r.primary_name AS record_name, r.row_identifier AS source_row_id, r.business_key_json,
      COALESCE(qi.source_sheet, r.source_sheet) AS sheet, sf.original_filename AS source_file
    FROM ${fromSql} WHERE ${whereSql} ORDER BY
    CASE qi.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END
    LIMIT ? OFFSET ?`).all(...params, limit, offset)
    .map(i => ({ ...i, business_key: (() => { try { return i.business_key_json ? Object.values(JSON.parse(i.business_key_json)).filter(Boolean).join(' | ') : null; } catch (_) { return null; } })(), business_key_json: undefined,
      evidence: i.evidence_json ? JSON.parse(i.evidence_json) : null, evidence_json: undefined }));

  res.json({ issues, total, page: Number(page), page_size: limit });
});

// Distinct field names that currently have at least one issue, for the
// Issue Explorer's field filter dropdown -- built from real data, not a
// static list, so it only ever offers filters that actually return results.
router.get('/:runId/issues/fields', (req, res) => {
  const run = getRunOrThrow(req);
  if (!run) return res.status(404).json({ error: 'Analysis run not found.' });
  const fields = db.prepare(`SELECT DISTINCT field_name FROM quality_issues WHERE run_id = ? AND field_name IS NOT NULL ORDER BY field_name`).all(run.id);
  res.json({ fields: fields.map(f => f.field_name) });
});

// ---------------- Duplicates & Matches: match-pair summary by real type ----------------
// "exact" = identical normalized name, no corroborating identifier needed.
// "multi_field" = name similarity backed by a matching strong identifier
// (GSTIN/phone/email/item code) -- the highest-confidence tier short of
// exact. "fuzzy" = name-similarity only, no corroborating identifier --
// the lowest-confidence tier. These are the actual match types the
// matching engine produces (see matchingEngine.js); nothing here is
// invented to fit a label.
router.get('/:runId/match-summary', (req, res) => {
  const run = getRunOrThrow(req);
  if (!run) return res.status(404).json({ error: 'Analysis run not found.' });
  const byType = db.prepare(`SELECT match_type, COUNT(*) c, AVG(confidence) avg_conf FROM match_pairs WHERE run_id = ? GROUP BY match_type`).all(run.id);
  const clusterCount = db.prepare(`SELECT COUNT(*) c FROM entity_clusters WHERE run_id = ?`).get(run.id).c;
  res.json({ by_type: byType, cluster_count: clusterCount });
});

// ---------------- Clusters ----------------
router.get('/:runId/clusters', (req, res) => {
  const run = getRunOrThrow(req);
  if (!run) return res.status(404).json({ error: 'Analysis run not found.' });
  const { kind, min_confidence, exact_repeat, page = 1, page_size = 50 } = req.query;
  const where = ['run_id = ?'];
  const params = [run.id];
  if (kind) { where.push('cluster_kind = ?'); params.push(kind); }
  if (min_confidence) { where.push('confidence >= ?'); params.push(Number(min_confidence)); }
  if (exact_repeat !== undefined) { where.push('is_exact_repeat = ?'); params.push(exact_repeat === 'true' ? 1 : 0); }
  const whereSql = where.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) c FROM entity_clusters WHERE ${whereSql}`).get(...params).c;
  const limit = Math.min(200, Number(page_size));
  const offset = (Number(page) - 1) * limit;
  const clusters = db.prepare(`SELECT * FROM entity_clusters WHERE ${whereSql} ORDER BY confidence DESC, record_count DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
  res.json({
    clusters: clusters.map(c => ({
      ...c,
      is_exact_repeat: !!c.is_exact_repeat,
      matching_factors: JSON.parse(c.matching_factors_json || '[]'),
      conflicts: JSON.parse(c.conflicts_json || '[]')
    })),
    total, page: Number(page), page_size: limit
  });
});

router.get('/:runId/clusters/:clusterId', (req, res) => {
  const run = getRunOrThrow(req);
  if (!run) return res.status(404).json({ error: 'Analysis run not found.' });
  const cluster = db.prepare('SELECT * FROM entity_clusters WHERE id = ? AND run_id = ?').get(req.params.clusterId, run.id);
  if (!cluster) return res.status(404).json({ error: 'Cluster not found.' });
  const members = db.prepare(`SELECT r.* FROM entity_cluster_members ecm JOIN records r ON r.id = ecm.record_id WHERE ecm.cluster_id = ?`).all(cluster.id);
  const memberIds = members.map(m => m.id);
  const pairs = memberIds.length ? db.prepare(`SELECT * FROM match_pairs WHERE run_id = ? AND record_a_id IN (${memberIds.map(() => '?').join(',')}) AND record_b_id IN (${memberIds.map(() => '?').join(',')})`).all(run.id, ...memberIds, ...memberIds) : [];
  res.json({
    cluster: { ...cluster, is_exact_repeat: !!cluster.is_exact_repeat, matching_factors: JSON.parse(cluster.matching_factors_json || '[]'), conflicts: JSON.parse(cluster.conflicts_json || '[]') },
    members: members.map(m => ({ ...m, raw: JSON.parse(m.raw_json) })),
    pairs: pairs.map(p => ({ ...p, matching_factors: JSON.parse(p.matching_factors_json || '[]'), conflicting_factors: JSON.parse(p.conflicting_factors_json || '[]') }))
  });
});

// ---------------- Conflicts ----------------
router.get('/:runId/conflicts', (req, res) => {
  const run = getRunOrThrow(req);
  if (!run) return res.status(404).json({ error: 'Analysis run not found.' });
  // v1 runs persist conflicts into conflict_groups/conflict_group_members (S6); the legacy `conflicts` table is only
  // ever populated by the retired legacy engine. A run has rows in exactly one of the two, never both.
  const groups = db.prepare('SELECT * FROM conflict_groups WHERE run_id = ? ORDER BY CASE severity WHEN \'critical\' THEN 0 WHEN \'high\' THEN 1 WHEN \'medium\' THEN 2 ELSE 3 END').all(run.id);
  if (groups.length) {
    const memberStmt = db.prepare(`SELECT cgm.member_role, r.id, r.primary_name, r.row_identifier, r.source_row_ref, r.business_key_json
      FROM conflict_group_members cgm JOIN records r ON r.id = cgm.record_id WHERE cgm.conflict_group_id = ?`);
    return res.json({ conflicts: groups.map(g => ({ ...g, fields: JSON.parse(g.fields_json || '[]'), fields_json: undefined,
      members: memberStmt.all(g.id).map(m => ({ record_id: m.id, name: m.primary_name, source_row_id: m.row_identifier, source_row_ref: m.source_row_ref, member_role: m.member_role,
        business_key: (() => { try { return m.business_key_json ? Object.values(JSON.parse(m.business_key_json)).filter(Boolean).join(' | ') : null; } catch (_) { return null; } })() })) })) });
  }
  const conflicts = db.prepare('SELECT * FROM conflicts WHERE run_id = ? ORDER BY CASE severity WHEN \'critical\' THEN 0 WHEN \'high\' THEN 1 WHEN \'medium\' THEN 2 ELSE 3 END').all(run.id);
  res.json({ conflicts: conflicts.map(c => ({ ...c, record_ids: JSON.parse(c.record_ids_json || '[]') })) });
});

// Match pairs (S6/S7): every accepted match AND every unconfirmed candidate (fuzzy / hard-id-name-unknown / ambiguous /
// material / transaction), distinctly labelled by pair_class -- never all lumped together as "exact duplicate".
router.get('/:runId/pairs', (req, res) => {
  const run = getRunOrThrow(req);
  if (!run) return res.status(404).json({ error: 'Analysis run not found.' });
  const { decision, pair_class, page = 1, page_size = 50 } = req.query;
  const where = ['mp.run_id = ?']; const params = [run.id];
  if (decision) { where.push('mp.decision = ?'); params.push(decision); }
  if (pair_class) { where.push('mp.pair_class = ?'); params.push(pair_class); }
  const whereSql = where.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) c FROM match_pairs mp WHERE ${whereSql}`).get(...params).c;
  const limit = Math.min(200, Number(page_size)); const offset = (Number(page) - 1) * limit;
  const pairs = db.prepare(`SELECT mp.*, a.primary_name AS a_name, a.row_identifier AS a_row_id, a.business_key_json AS a_business_key_json,
      b.primary_name AS b_name, b.row_identifier AS b_row_id, b.business_key_json AS b_business_key_json
    FROM match_pairs mp JOIN records a ON a.id = mp.record_a_id JOIN records b ON b.id = mp.record_b_id
    WHERE ${whereSql} ORDER BY mp.confidence DESC NULLS LAST LIMIT ? OFFSET ?`).all(...params, limit, offset);
  const bk = j => { try { return j ? Object.values(JSON.parse(j)).filter(Boolean).join(' | ') : null; } catch (_) { return null; } };
  res.json({
    pairs: pairs.map(p => ({ ...p, matching_factors: JSON.parse(p.matching_factors_json || '[]'), conflicting_factors: JSON.parse(p.conflicting_factors_json || '[]'),
      a: { record_id: p.record_a_id, name: p.a_name, source_row_id: p.a_row_id, business_key: bk(p.a_business_key_json) },
      b: { record_id: p.record_b_id, name: p.b_name, source_row_id: p.b_row_id, business_key: bk(p.b_business_key_json) },
      matching_factors_json: undefined, conflicting_factors_json: undefined, a_name: undefined, a_row_id: undefined, a_business_key_json: undefined, b_name: undefined, b_row_id: undefined, b_business_key_json: undefined })),
    total, page: Number(page), page_size: limit
  });
});

// ---------------- Records list (for a run) ----------------
router.get('/:runId/records', (req, res) => {
  const run = getRunOrThrow(req);
  if (!run) return res.status(404).json({ error: 'Analysis run not found.' });
  const { search, record_kind, page = 1, page_size = 50 } = req.query;
  const where = ['run_id = ?'];
  const params = [run.id];
  if (search) { where.push('primary_name LIKE ?'); params.push(`%${search}%`); }
  if (record_kind) {
    const kinds = expandRecordKind(record_kind);
    where.push(`record_kind IN (${kinds.map(() => '?').join(',')})`);
    for (const k of kinds) params.push(k);
  }
  const whereSql = where.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) c FROM records WHERE ${whereSql}`).get(...params).c;
  const limit = Math.min(200, Number(page_size));
  const offset = (Number(page) - 1) * limit;
  const records = db.prepare(`SELECT id, primary_name, record_kind, created_date, modified_date, source_row_ref, source_file_id
    FROM records WHERE ${whereSql} ORDER BY source_row_ref LIMIT ? OFFSET ?`).all(...params, limit, offset);
  res.json({ records, total, page: Number(page), page_size: limit });
});

// ---------------- Missing & Invalid Data: per-field issue summary ----------------
// Powers the "Missing & Invalid Data" screen: for each (category, field_name)
// combination, how many DISTINCT records are affected, what percentage of
// the whole dataset that is, the dominant severity, and a few real example
// explanations -- so the screen never needs to invent anything, it just
// aggregates what the quality engine already persisted.
router.get('/:runId/field-issue-summary', (req, res) => {
  const run = getRunOrThrow(req);
  if (!run) return res.status(404).json({ error: 'Analysis run not found.' });
  const { category } = req.query;
  const totalRecords = db.prepare('SELECT COUNT(*) c FROM records WHERE run_id = ?').get(run.id).c;

  const where = ['run_id = ?', "field_name IS NOT NULL"];
  const params = [run.id];
  if (category) { where.push('category = ?'); params.push(category); }
  const whereSql = where.join(' AND ');

  const rows = db.prepare(`
    SELECT field_name, category, issue_type,
      COUNT(DISTINCT record_id) as affected_records,
      MAX(CASE severity WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END) as severity_rank
    FROM quality_issues
    WHERE ${whereSql}
    GROUP BY field_name, category, issue_type
    ORDER BY affected_records DESC
  `).all(...params);

  const severityLabel = { 4: 'critical', 3: 'high', 2: 'medium', 1: 'low' };

  const summary = rows.map(r => {
    const example = db.prepare(`SELECT explanation FROM quality_issues WHERE run_id = ? AND field_name = ? AND issue_type = ? LIMIT 3`)
      .all(run.id, r.field_name, r.issue_type);
    return {
      field_name: r.field_name,
      category: r.category,
      issue_type: r.issue_type,
      affected_records: r.affected_records,
      percentage: totalRecords ? Math.round((r.affected_records / totalRecords) * 1000) / 10 : 0,
      severity: severityLabel[r.severity_rank] || 'low',
      examples: example.map(e => e.explanation)
    };
  });

  res.json({ total_records: totalRecords, summary });
});

// ---------------- Data Freshness intelligence ----------------
router.get('/:runId/freshness', (req, res) => {
  const run = getRunOrThrow(req);
  if (!run) return res.status(404).json({ error: 'Analysis run not found.' });

  const ageBuckets = db.prepare(`
    SELECT
      CASE
        WHEN modified_date IS NULL THEN 'unknown'
        WHEN julianday('now') - julianday(modified_date) <= 365 THEN 'fresh'
        WHEN julianday('now') - julianday(modified_date) <= 365*3 THEN 'aging'
        ELSE 'stale'
      END as bucket,
      COUNT(*) c
    FROM records WHERE run_id = ? GROUP BY bucket
  `).all(run.id);

  const neverModified = db.prepare(`SELECT COUNT(*) c FROM records WHERE run_id = ? AND modified_date IS NULL`).get(run.id).c;
  const noDateAtAll = db.prepare(`SELECT COUNT(*) c FROM records WHERE run_id = ? AND modified_date IS NULL AND created_date IS NULL`).get(run.id).c;

  const oldestRecords = db.prepare(`
    SELECT id, primary_name, created_date, modified_date, source_row_ref
    FROM records WHERE run_id = ? AND modified_date IS NOT NULL
    ORDER BY modified_date ASC LIMIT 20
  `).all(run.id);

  const invalidTemporalIssues = db.prepare(`
    SELECT qi.*, r.primary_name, r.source_row_ref FROM quality_issues qi
    JOIN records r ON r.id = qi.record_id
    WHERE qi.run_id = ? AND qi.issue_type IN ('invalid_date', 'future_created_date', 'modified_before_created', 'missing_date_info')
    ORDER BY CASE qi.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END
    LIMIT 100
  `).all(run.id);

  res.json({
    age_distribution: ageBuckets,
    never_modified: neverModified,
    no_date_at_all: noDateAtAll,
    oldest_records: oldestRecords,
    invalid_temporal_issues: invalidTemporalIssues
  });
});

// ---------------- Reports & Exports: list past exports for a run ----------------
router.get('/:runId/exports', (req, res) => {
  const run = getRunOrThrow(req);
  if (!run) return res.status(404).json({ error: 'Analysis run not found.' });
  const exportsList = db.prepare('SELECT * FROM exports WHERE run_id = ? ORDER BY created_at DESC').all(run.id);
  res.json({ exports: exportsList });
});

module.exports = router;
