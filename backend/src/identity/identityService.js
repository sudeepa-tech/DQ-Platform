'use strict';
/*
 * Identity execution against PERSISTED, CONFIRMED inputs: the run's immutable configuration snapshot is the source of truth (confirmed mapping + identity configuration + rule configuration).
 * Uses the S4 rule results as input (invalid ids are never identity evidence). Does not create runs and does not write matches, clusters or conflicts (persistence belongs to the orchestration phase).
 */
const { runIdentity } = require('./engine'); const { resolveIdentityConfig, hashIdentityConfig } = require('./config'); const cs = require('../semantic/configSnapshot'); const { err } = require('../semantic/schemaService'); const RS = require('../rules/ruleService');
function runIdentityFromSnapshot(db, { configId, sourceFileId, todayISO, ruleResult, decisions }) {
  const cfg = cs.getAnalysisConfig(db, configId); const snap = cfg.config.snapshot; const src = sourceFileId ? snap.sources.find(s => s.source_file_id === sourceFileId) : snap.sources[0]; if (!src) throw err(404, 'That source file is not part of this configuration.');
  const sf = db.prepare('SELECT content_sha256, ingest_status FROM source_files WHERE id = ?').get(src.source_file_id);
  if (!sf || sf.ingest_status !== 'ingested') throw err(409, 'The source file is not canonically ingested.'); if (sf.content_sha256 !== src.content_sha256) throw err(409, 'The stored file no longer matches the configuration snapshot (content hash differs).');
  let identityConfig; if (snap.identity) { identityConfig = resolveIdentityConfig(snap.identity.overrides); if (hashIdentityConfig(identityConfig) !== snap.identity.config_hash) throw err(409, 'The identity configuration in the snapshot does not match its recorded hash.'); } else identityConfig = resolveIdentityConfig();
  const rules = ruleResult || RS.runRulesFromSnapshot(db, { configId, sourceFileId: src.source_file_id, todayISO });
  const out = runIdentity({ datasetType: snap.dataset_type, columns: src.columns, rows: () => RS.iterCanonicalRows(db, src.source_file_id), ruleFindings: rules.findings, identityConfig, decisions });
  out.provenance = { ...out.provenance, config_id: configId, config_hash: cfg.config_hash, config_version: cfg.version, mapping_version: src.mapping_version, source_file_id: src.source_file_id, content_sha256: src.content_sha256, rules_results_hash: rules.provenance.results_hash };
  return out;
}
module.exports = { runIdentityFromSnapshot };
