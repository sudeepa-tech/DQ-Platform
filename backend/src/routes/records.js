'use strict';
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const dayjs = require('dayjs');

const router = express.Router();
router.use(requireAuth);

router.get('/:id', (req, res) => {
  const record = db.prepare(`SELECT r.* FROM records r
    JOIN analysis_runs ar ON ar.id = r.run_id
    JOIN datasets d ON d.id = ar.dataset_id
    WHERE r.id = ? AND d.organization_id = ?`).get(req.params.id, req.user.org);
  if (!record) return res.status(404).json({ error: 'Record not found.' });

  const sourceFile = db.prepare('SELECT * FROM source_files WHERE id = ?').get(record.source_file_id);
  const issues = db.prepare('SELECT * FROM quality_issues WHERE record_id = ? ORDER BY CASE severity WHEN \'critical\' THEN 0 WHEN \'high\' THEN 1 WHEN \'medium\' THEN 2 ELSE 3 END').all(record.id);

  const clusterMembership = db.prepare(`SELECT ec.* FROM entity_cluster_members ecm
    JOIN entity_clusters ec ON ec.id = ecm.cluster_id WHERE ecm.record_id = ?`).all(record.id);

  const relatedViaClusters = new Set();
  for (const cluster of clusterMembership) {
    const members = db.prepare('SELECT record_id FROM entity_cluster_members WHERE cluster_id = ?').all(cluster.id);
    members.forEach(m => { if (m.record_id !== record.id) relatedViaClusters.add(m.record_id); });
  }
  const relatedRecords = relatedViaClusters.size
    ? db.prepare(`SELECT id, primary_name, source_row_ref FROM records WHERE id IN (${[...relatedViaClusters].map(() => '?').join(',')})`).all(...relatedViaClusters)
    : [];

  const pairs = db.prepare('SELECT * FROM match_pairs WHERE record_a_id = ? OR record_b_id = ?').all(record.id, record.id);

  let age = null, sinceModified = null;
  if (record.modified_date) sinceModified = dayjs().diff(dayjs(record.modified_date), 'day') / 365.25;
  if (record.created_date) age = dayjs().diff(dayjs(record.created_date), 'day') / 365.25;

  res.json({
    record: {
      ...record,
      raw: JSON.parse(record.raw_json),
      normalized: record.normalized_json ? JSON.parse(record.normalized_json) : null
    },
    source_file: sourceFile,
    issues,
    clusters: clusterMembership.map(c => ({ ...c, matching_factors: JSON.parse(c.matching_factors_json || '[]'), conflicts: JSON.parse(c.conflicts_json || '[]') })),
    related_records: relatedRecords,
    match_pairs: pairs.map(p => ({ ...p, matching_factors: JSON.parse(p.matching_factors_json || '[]'), conflicting_factors: JSON.parse(p.conflicting_factors_json || '[]') })),
    age_years: age,
    years_since_modification: sinceModified
  });
});

module.exports = router;
