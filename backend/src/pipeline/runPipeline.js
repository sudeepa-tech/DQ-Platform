'use strict';
/*
 * THE REAL PRODUCTION PIPELINE (S6). Replaces the legacy in-process orchestrator as the only path a live run takes:
 *   canonical rows (already ingested at upload time, S2) -> confirmed mapping / immutable run configuration (S3)
 *   -> S4 rules -> S5 identity/matching/conflicts -> persisted findings (this module) -> S7 scoring (not yet: left null)
 * Every run's config_id, engine_version, reference_date, stale_threshold_years and table_type are frozen BEFORE any row is
 * touched (the P0 completion-gate triggers refuse a v1 run from reaching 'complete' otherwise). A run never reads more than
 * one dataset's files; a run touching several source files processes each independently and pools nothing across files
 * except through S5's own cross-file blocking (identity blocking already spans a run's whole record set by design).
 */
const RS = require('../rules/ruleService'); const IS = require('../identity/identityService'); const cs = require('../semantic/configSnapshot');
const { persistRuleFindings } = require('./persistFindings'); const { persistIdentityResult } = require('./persistIdentity'); const { persistScoreResult } = require('./persistScores');
const SS = require('../scoring/scoreService');
const crypto = require('crypto'); const uuid = () => crypto.randomUUID();

function setStage(db, runId, jobId, stage, pct) {
  db.prepare(`UPDATE analysis_runs SET current_stage = ?, progress_pct = ? WHERE id = ?`).run(stage, pct, runId);
  if (jobId) db.prepare(`UPDATE jobs SET stage = ?, progress_pct = ?, updated_at = datetime('now') WHERE id = ?`).run(stage, pct, jobId);
}
function setStatus(db, runId, jobId, status) {
  db.prepare(`UPDATE analysis_runs SET status = ? WHERE id = ?`).run(status, runId);
  if (jobId) db.prepare(`UPDATE jobs SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status === 'running' ? 'running' : status, jobId);
}

/** Materialize `records` rows for a source file from its immutable canonical source_rows, inside the caller's transaction. Returns Map<row_number, records.id>. */
function materializeRecords(db, { runId, sourceFileId, sourceSheet, datasetType, columns, insertRecord }) {
  const recordIdOf = new Map();
  const nameCol = columns.find(c => c.role === 'name' && c.include_in_analysis !== false);
  const descCol = columns.find(c => c.role === 'description' && c.include_in_analysis !== false);
  const rowIdCol = columns.find(c => c.role === 'row_id');
  // Lineage fallback: when NO column was semantically classified as a row identifier (S3's own, appropriately cautious call
  // for a header too generic to be sure of), the leftmost included column is still shown as a human-readable "source row id"
  // for EXPORT / LINEAGE DISPLAY ONLY. This never feeds identity or matching (identity.js keys strictly off role === 'row_id').
  const displayIdCol = rowIdCol || columns.filter(c => c.include_in_analysis !== false).sort((a, b) => a.position - b.position)[0];
  const createdCol = columns.find(c => c.role === 'creation_date'), modifiedCol = columns.find(c => c.role === 'modification_date');
  const bizCols = columns.filter(c => ['entity_id', 'legal_id', 'doc_id', 'doc_ref', 'material_id'].includes(c.role) && c.include_in_analysis !== false);
  const kind = datasetType === 'transaction' ? 'transaction' : datasetType === 'master_material' ? 'item' : 'entity';
  for (const row of RS.iterCanonicalRows(db, sourceFileId)) {
    const id = uuid(); recordIdOf.set(row.rowNumber, id);
    const primary = nameCol ? row.raw[nameCol.header_key] : descCol ? row.raw[descCol.header_key] : null;
    const rowIdent = displayIdCol ? row.raw[displayIdCol.header_key] : null;
    const dateAt = col => { if (!col) return null; const m = (row.meta || {})[col.header_key], v = (row.canonical || {})[col.header_key]; return m && ['date_only', 'datetime', 'text_date'].includes(m.k) && typeof v === 'string' ? v.slice(0, 10) : null; };
    const bizKey = {}; for (const c of bizCols) { const v = row.raw[c.header_key]; if (v !== undefined && v !== null && String(v).trim() !== '') bizKey[c.role] = String(v).trim(); }
    insertRecord.run(id, runId, sourceFileId, row.rowNumber, kind, JSON.stringify(row.raw), null,
      dateAt(createdCol), dateAt(modifiedCol), primary === undefined || primary === null ? null : String(primary), null,
      null, sourceSheet || null, rowIdent === undefined || rowIdent === null ? null : String(rowIdent),
      Object.keys(bizKey).length ? JSON.stringify(bizKey) : null, null, null, null);
  }
  return recordIdOf;
}

function computeRuleStats(findings, sourceFileId) {
  const by = new Map();
  for (const f of findings) {
    const k = [f.rule_id, f.category, f.scope === 'group' ? 'group' : f.scope, f.severity].join('|');
    if (!by.has(k)) by.set(k, { rule_id: f.rule_id, category: f.category, scope: f.scope, severity: f.severity, defects: 0, records: new Set() });
    const e = by.get(k); e.defects++;
    if (f.scope === 'record') e.records.add(f.row_number); else if (f.scope === 'group') for (const m of f.rows || []) e.records.add(m.row_number);
  }
  return [...by.values()].map(e => ({ source_file_id: sourceFileId, rule_id: e.rule_id, category: e.category, scope: e.scope, severity: e.severity, defects: e.defects, records_affected: e.records.size }));
}

/** Execute one queued analysis run to completion (or fail it with a clear, persisted error). Never throws to the caller: failures are recorded on the run. */
async function executeRun(db, { runId, jobId, todayISO }) {
  try {
    const run = db.prepare('SELECT * FROM analysis_runs WHERE id = ?').get(runId); if (!run) throw new Error('Analysis run not found.');
    if (!run.config_id) throw new Error('This run has no confirmed configuration; it cannot be executed by the v1 pipeline.');
    const cfg = cs.getAnalysisConfig(db, run.config_id); const snap = cfg.config.snapshot;

    setStatus(db, runId, jobId, 'running'); setStage(db, runId, jobId, 'Loading configuration', 5);
    const insertRecord = db.prepare(`INSERT INTO records (id, run_id, source_file_id, source_row_ref, record_kind, raw_json, normalized_json, created_date, modified_date, primary_name, blocking_key, source_row_id, source_sheet, row_identifier, business_key_json, business_hash, business_hash_excl_audit, normalization_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insertInput = db.prepare(`INSERT INTO run_inputs (run_id, source_file_id, mapping_version, row_count, content_sha256) VALUES (?,?,?,?,?)`);
    const insertRuleStat = db.prepare(`INSERT INTO run_rule_stats (run_id, source_file_id, rule_id, category, scope, severity, defects, records_affected) VALUES (?,?,?,?,?,?,?,?)`);

    let totalRecords = 0, totalIssues = 0, totalMembers = 0, totalClusters = 0, totalPairs = 0, totalConflictGroups = 0;
    const scoringFiles = [];
    const nSources = snap.sources.length;
    for (let si = 0; si < nSources; si++) {
      const src = snap.sources[si]; const pct0 = 10 + Math.floor((si / nSources) * 80);
      setStage(db, runId, jobId, `Materializing records (${si + 1}/${nSources})`, pct0);
      const sf = db.prepare('SELECT sheet_name, ingest_status, content_sha256 FROM source_files WHERE id = ?').get(src.source_file_id);
      if (!sf || sf.ingest_status !== 'ingested') throw new Error(`Source file ${src.source_file_id} is not canonically ingested.`);
      if (sf.content_sha256 !== src.content_sha256) throw new Error(`Source file ${src.source_file_id} no longer matches the run's configuration snapshot (content changed since it was configured).`);
      const recordIdOf = materializeRecords(db, { runId, sourceFileId: src.source_file_id, sourceSheet: sf.sheet_name, datasetType: snap.dataset_type, columns: src.columns, insertRecord });
      totalRecords += recordIdOf.size;
      insertInput.run(runId, src.source_file_id, src.mapping_version, recordIdOf.size, src.content_sha256);

      setStage(db, runId, jobId, `Rules (${si + 1}/${nSources})`, pct0 + 15);
      const ruleResult = RS.runRulesFromSnapshot(db, { configId: run.config_id, sourceFileId: src.source_file_id, todayISO });
      const { issueCount, memberCount } = persistRuleFindings(db, { runId, sourceFileId: src.source_file_id, sourceSheet: sf.sheet_name, recordIdOf, ruleResult });
      totalIssues += issueCount; totalMembers += memberCount;
      for (const s of computeRuleStats(ruleResult.findings, src.source_file_id)) insertRuleStat.run(runId, s.source_file_id, s.rule_id, s.category, s.scope, s.severity, s.defects, s.records_affected);

      setStage(db, runId, jobId, `Identity / matching (${si + 1}/${nSources})`, pct0 + 30);
      const identity = IS.runIdentityFromSnapshot(db, { configId: run.config_id, sourceFileId: src.source_file_id, todayISO, ruleResult });
      setStage(db, runId, jobId, `Persisting findings (${si + 1}/${nSources})`, pct0 + 45);
      const p = persistIdentityResult(db, { runId, identity, recordIdOf });
      totalClusters += p.clusters; totalPairs += p.pairs; totalConflictGroups += p.conflictGroups;

      const colsWithCounts = db.prepare('SELECT header_key, populated_count FROM file_columns WHERE source_file_id = ?').all(src.source_file_id);
      const popByKey = new Map(colsWithCounts.map(c => [c.header_key, c.populated_count]));
      const columnsForScoring = src.columns.map(c => ({ ...c, populated_count: popByKey.get(c.header_key) || 0 }));
      scoringFiles.push({ sourceFileId: src.source_file_id, columns: columnsForScoring, rowCount: recordIdOf.size, ruleResult, identity });
    }

    setStage(db, runId, jobId, 'Scoring', 92);
    const scored = SS.scoreRun({ datasetType: snap.dataset_type, files: scoringFiles, scoringOverrides: snap.scoring ? snap.scoring.overrides : undefined });
    persistScoreResult(db, { runId, scored });

    setStage(db, runId, jobId, 'Finalizing', 95);
    db.prepare(`UPDATE analysis_runs SET status = 'complete', progress_pct = 100, current_stage = 'Complete', finished_at = datetime('now'), records_analyzed = ?, health_score = ?, health_breakdown_json = ? WHERE id = ?`)
      .run(totalRecords, scored.overall, JSON.stringify({ overall: scored.overall, breakdown: Object.fromEntries(['completeness', 'validity', 'uniqueness', 'consistency', 'freshness'].map(d => [d, { score: scored.dimensions[d].score, weight: scored.dimensions[d].weight }])), engine_version: scored.engine_version, config_hash: scored.config_hash, mixed_unknown_caveat: scored.mixed_unknown_caveat }), runId);
    if (jobId) db.prepare(`UPDATE jobs SET status = 'complete', progress_pct = 100, stage = 'Complete', result_json = ?, updated_at = datetime('now') WHERE id = ?`).run(JSON.stringify({ records_analyzed: totalRecords, issues: totalIssues, clusters: totalClusters, pairs: totalPairs, conflict_groups: totalConflictGroups }), jobId);
    return { runId, records: totalRecords, issues: totalIssues, clusters: totalClusters, pairs: totalPairs, conflictGroups: totalConflictGroups };
  } catch (err) {
    db.prepare(`UPDATE analysis_runs SET status = 'failed', error_message = ?, finished_at = datetime('now') WHERE id = ?`).run(String(err.message).slice(0, 2000), runId);
    if (jobId) db.prepare(`UPDATE jobs SET status = 'failed', error_message = ?, updated_at = datetime('now') WHERE id = ?`).run(String(err.message).slice(0, 2000), jobId);
    throw err;
  }
}
module.exports = { executeRun, materializeRecords };
