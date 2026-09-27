'use strict';
/*
 * Persist S4 rule findings into quality_issues (+ finding_members for group-scope findings).
 * The finding model supports record | field | dataset | group scope WITHOUT forcing a single record id (S6 charter #5):
 *   record  -> one row, one quality_issues row, record_id set
 *   group   -> quality_issues row carries NO record_id; every affected row is a finding_members row (member_role='member')
 *   dataset -> quality_issues row carries no record_id and no members: it is about the whole source
 * Every row carries full lineage (source file, sheet, physical row, rule, severity, evidence, engine + config version) so the
 * Issue Explorer never has to reconstruct provenance after the fact.
 */
const crypto = require('crypto');
const uuid = () => crypto.randomUUID();

/**
 * @param db            open database handle (writes must run inside the caller's transaction)
 * @param runId          the analysis_runs.id findings belong to
 * @param sourceFileId   which source file these findings came from
 * @param recordIdOf     Map<row_number, records.id> — resolves a canonical row to its persisted record
 * @param ruleResult     the S4 engine's { findings, provenance } output
 * @returns { issueCount, memberCount }
 */
function persistRuleFindings(db, { runId, sourceFileId, sourceSheet, recordIdOf, ruleResult }) {
  const insIssue = db.prepare(`INSERT INTO quality_issues
    (id, run_id, record_id, category, issue_type, severity, field_name, explanation, detection_method, confidence, extra_json,
     rule_id, rule_version, scope, file_column_id, requiredness, observed_value, normalized_value, evidence_json, affects_score,
     source_file_id, source_sheet, sheet_row, row_number, engine_version, config_version)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insMember = db.prepare(`INSERT INTO finding_members (id, run_id, finding_id, record_id, member_role, values_json) VALUES (?,?,?,?,?,?)`);
  let issueCount = 0, memberCount = 0;
  const engineVersion = ruleResult.provenance.engine_version, configVersion = ruleResult.provenance.config_version;

  for (const f of ruleResult.findings) {
    // The database id must always be a fresh, globally-unique key. S4's own finding.id is a content hash (rule_id/field/row)
    // meant for verifying determinism WITHIN one re-run of the SAME config -- it repeats across different datasets/runs
    // whenever their row numbers and field names happen to coincide, which a global primary key must never assume away.
    const id = uuid();
    if (f.scope === 'dataset') {
      insIssue.run(id, runId, null, f.category, f.type, f.severity, f.header_raw || null, f.message, 'rule', null, null,
        f.rule_id, engineVersion, 'dataset', f.file_column_id || null, f.evidence && f.evidence.requiredness || null, null, null,
        f.evidence ? JSON.stringify(f.evidence) : null, 1, sourceFileId, sourceSheet || null, null, null, engineVersion, configVersion);
      issueCount++;
    } else if (f.scope === 'group') {
      insIssue.run(id, runId, null, f.category, f.type, f.severity, f.header_raw || null, f.message, 'rule', null, null,
        f.rule_id, engineVersion, 'group', f.file_column_id || null, f.evidence && f.evidence.requiredness || null, null, null,
        f.evidence ? JSON.stringify(f.evidence) : null, 1, sourceFileId, sourceSheet || null, null, null, engineVersion, configVersion);
      issueCount++;
      for (const m of f.rows || []) {
        const recId = recordIdOf.get(m.row_number); if (!recId) continue;
        insMember.run(uuid(), runId, id, recId, 'member', m.value !== undefined ? JSON.stringify({ value: m.value }) : null); memberCount++;
      }
    } else {
      const recId = recordIdOf.get(f.row_number);
      insIssue.run(id, runId, recId || null, f.category, f.type, f.severity, f.header_raw || null, f.message, 'rule', null, null,
        f.rule_id, engineVersion, 'record', f.file_column_id || null, f.evidence && f.evidence.requiredness || null,
        f.value === undefined ? null : (f.value === null ? null : String(f.value)), null,
        f.evidence ? JSON.stringify(f.evidence) : null, 1, sourceFileId, sourceSheet || null, f.sheet_row || null, f.row_number || null, engineVersion, configVersion);
      issueCount++;
    }
  }
  return { issueCount, memberCount };
}
module.exports = { persistRuleFindings };
