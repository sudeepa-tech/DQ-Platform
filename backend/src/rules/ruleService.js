'use strict';
/*
 * Rule execution against PERSISTED, CONFIRMED inputs. The source of truth is the run's immutable configuration snapshot (confirmed mapping + rule configuration + run settings),
 * never the mutable tables: the same snapshot, the same file and the same reference date always give the same findings.
 * It does not create runs and does not write findings (run creation / persistence / live wiring belong to the orchestration phase).
 */
const { runRules } = require('./engine'); const { resolveRuleConfig, hashRuleConfig } = require('./config'); const D = require('./dates');
const cs = require('../semantic/configSnapshot'); const { err } = require('../semantic/schemaService');

function* iterCanonicalRows(db, sourceFileId, batch = 2000) {
  let last = 0; const q = db.prepare('SELECT row_number, sheet_row, raw_json, raw_meta_json, canonical_json FROM source_rows WHERE source_file_id = ? AND row_number > ? ORDER BY row_number LIMIT ?');
  for (;;) { const rows = q.all(sourceFileId, last, batch); if (!rows.length) return;
    for (const r of rows) yield { rowNumber: r.row_number, sheetRow: r.sheet_row, raw: JSON.parse(r.raw_json), meta: r.raw_meta_json ? JSON.parse(r.raw_meta_json) : {}, canonical: r.canonical_json ? JSON.parse(r.canonical_json) : {} };
    last = rows[rows.length - 1].row_number; }
}
/** reference date resolution for a stored configuration: frozen ONCE by the caller at run start (todayISO is the caller's clock, never read here) */
const referenceDateFor = (config, todayISO) => D.resolveReferenceDate(config.config.snapshot.settings, todayISO);

function runRulesFromSnapshot(db, { configId, sourceFileId, todayISO }) {
  const cfg = cs.getAnalysisConfig(db, configId); const snap = cfg.config.snapshot;
  const src = sourceFileId ? snap.sources.find(s => s.source_file_id === sourceFileId) : snap.sources[0]; if (!src) throw err(404, 'That source file is not part of this configuration.');
  const sf = db.prepare('SELECT content_sha256, ingest_status FROM source_files WHERE id = ?').get(src.source_file_id);
  if (!sf || sf.ingest_status !== 'ingested') throw err(409, 'The source file is not canonically ingested.');
  if (sf.content_sha256 !== src.content_sha256) throw err(409, 'The stored file no longer matches the configuration snapshot (content hash differs).');
  let ruleConfig; if (snap.rules) { ruleConfig = resolveRuleConfig(snap.rules.overrides); if (hashRuleConfig(ruleConfig) !== snap.rules.config_hash) throw err(409, 'The rule configuration in the snapshot does not match its recorded hash.'); } else ruleConfig = resolveRuleConfig();
  const ref = D.resolveReferenceDate(snap.settings, todayISO);
  const out = runRules({ columns: src.columns, datasetType: snap.dataset_type, rows: iterCanonicalRows(db, src.source_file_id), ruleConfig, settings: { reference_date: ref.reference_date, stale_threshold_years: snap.settings.stale_threshold_years } });
  out.provenance = { ...out.provenance, config_id: configId, config_hash: cfg.config_hash, config_version: cfg.version, mapping_version: src.mapping_version, source_file_id: src.source_file_id, content_sha256: src.content_sha256, reference_date_source: ref.source };
  return out;
}
module.exports = { runRulesFromSnapshot, iterCanonicalRows, referenceDateFor };
