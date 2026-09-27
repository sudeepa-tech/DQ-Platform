'use strict';
/*
 * IMMUTABLE RUN CONFIGURATION. A configuration is a hashed, append-only snapshot of everything that decides how a run interprets a dataset:
 * dataset type, every column's role / requiredness / include flag / validation profile, the semantic policy that produced them, and the versions.
 * It can only be built from CONFIRMED (locked) mapping versions. Changing anything creates a NEW mapping version and a NEW configuration
 * (`planReRun`); the parent run and its configuration are never touched.
 */
const S = require('./index'); const svc = require('./schemaService');
const { err, inTxn, uuid } = svc;
const RC = require('../rules/config'); const RCAT = require('../rules/catalog'); const IC = require('../identity/config'); const SC = require('../scoring/config');   // S4: the rule configuration is part of every run configuration
const J = v => JSON.stringify(v); const P = s => (s ? JSON.parse(s) : null);

function buildSnapshot(db, sources, settings, ruleOverrides, identityOverrides, scoringOverrides) {
  const cfgDefaults = S.DEFAULT_SEMANTIC_CONFIG.run_settings_defaults; const parts = []; let semantic = null; let datasetType = null;
  for (const s of sources) {
    const sf = db.prepare('SELECT * FROM source_files WHERE id = ?').get(s.sourceFileId); if (!sf) throw err(404, `Source file ${s.sourceFileId} not found.`);
    const set = svc.getSet(db, s.sourceFileId, s.mappingVersion); if (!set) throw err(404, `Mapping version ${s.mappingVersion} not found for ${s.sourceFileId}.`);
    if (!set.locked_at) throw err(409, `Mapping version ${s.mappingVersion} of ${sf.original_filename} is not confirmed. A run configuration can only be built from a confirmed (locked) mapping.`);
    if (datasetType && datasetType !== set.dataset_type) throw err(409, 'All sources of one configuration must share the same dataset type.');
    datasetType = set.dataset_type; semantic = semantic || JSON.parse(set.semantic_config_json);
    const ms = svc.loadMappings(db, s.sourceFileId, s.mappingVersion);
    parts.push({ source_file_id: sf.id, dataset_id: sf.dataset_id, content_sha256: sf.content_sha256, ingest_fingerprint: sf.ingest_fingerprint, sheet_name: sf.sheet_name, data_row_count: sf.data_row_count,
      mapping_version: set.mapping_version, dataset_type_source: set.dataset_type_source, engine_version: set.engine_version, taxonomy_version: set.taxonomy_version, semantic_config_hash: set.semantic_config_hash,
      columns: ms.map(m => ({ file_column_id: m.file_column_id, position: m.column_index, header_raw: m.header_raw, header_key: m.header_key, role: m.role, role_family: m.role_family, status: m.status, confidence_tier: m.confidence_tier,
        requiredness: m.requiredness, requiredness_source: m.requiredness_source, include_in_analysis: !!m.include_in_analysis, validation_profile: m.validation_profile, user_overridden: !!m.user_overridden, primary_for_role: m.primary_for_role === null ? null : !!m.primary_for_role })) });
  }
  const st = { stale_threshold_years: cfgDefaults.stale_threshold_years, reference_date_mode: cfgDefaults.reference_date_mode, reference_date: null, ...(settings || {}) };
  if (!(st.stale_threshold_years > 0)) throw err(400, 'stale_threshold_years must be a positive number.');
  if (!['run_date', 'fixed'].includes(st.reference_date_mode)) throw err(400, "reference_date_mode must be 'run_date' or 'fixed'.");
  if (st.reference_date_mode === 'fixed' && !/^\d{4}-\d{2}-\d{2}$/.test(st.reference_date || '')) throw err(400, 'A fixed reference date must be YYYY-MM-DD.');
  if (st.reference_date_mode === 'run_date') st.reference_date = null;
  const effective = RC.resolveRuleConfig(ruleOverrides);   // validated strictly: an unknown rule / key / type is an error, never a silent no-op
  const rules = { engine_version: RCAT.RULE_ENGINE_VERSION, catalog_version: RCAT.RULE_CATALOG_VERSION, overrides: ruleOverrides || {}, config: effective, config_hash: RC.hashRuleConfig(effective) };
  const ieff = IC.resolveIdentityConfig(identityOverrides);   // S5: the identity configuration is part of every run configuration, validated strictly
  const identity = { engine_version: IC.IDENTITY_ENGINE_VERSION, overrides: identityOverrides || {}, config: ieff, config_hash: IC.hashIdentityConfig(ieff) };
  const seff = SC.resolveScoringConfig(scoringOverrides);   // S7: the scoring configuration is part of every run configuration, validated strictly
  const scoring = { engine_version: SC.SCORING_ENGINE_VERSION, overrides: scoringOverrides || {}, config: seff, config_hash: SC.hashConfig(seff) };
  return { schema_version: 4, dataset_type: datasetType, sources: parts, semantic: { engine_version: S.SEMANTIC_ENGINE_VERSION, taxonomy_version: S.TAXONOMY_VERSION, config: semantic, config_hash: S.hashConfig(semantic) }, rules, identity, scoring, settings: st };
}

/** create (or reuse, when byte-identical) an immutable analysis configuration for a dataset */
function createAnalysisConfig(db, { datasetId, sources, settings, userId, note, lineage, ruleOverrides, identityOverrides, scoringOverrides }) {
  if (!Array.isArray(sources) || !sources.length) throw err(400, 'sources is required: [{ source_file_id, mapping_version }].');
  const norm = sources.map(s => ({ sourceFileId: s.source_file_id || s.sourceFileId, mappingVersion: Number(s.mapping_version || s.mappingVersion) }));
  for (const s of norm) { const sf = db.prepare('SELECT dataset_id FROM source_files WHERE id = ?').get(s.sourceFileId); if (!sf || sf.dataset_id !== datasetId) throw err(400, 'Every source must belong to the dataset.'); }
  const snapshot = buildSnapshot(db, norm, settings, ruleOverrides, identityOverrides, scoringOverrides); const hash = S.hashConfig(snapshot);
  const dup = db.prepare('SELECT id, version FROM analysis_configs WHERE dataset_id = ? AND config_hash = ?').get(datasetId, hash);
  if (dup) return { config_id: dup.id, version: dup.version, config_hash: hash, reused: true, table_type: snapshot.dataset_type };
  const id = uuid();
  inTxn(db, () => {
    const version = ((db.prepare('SELECT MAX(version) v FROM analysis_configs WHERE dataset_id = ?').get(datasetId) || {}).v || 0) + 1;
    db.prepare(`INSERT INTO analysis_configs (id, dataset_id, version, table_type, stale_threshold_years, reference_date_mode, reference_date, config_json, config_schema_version, rule_catalog_version, config_hash, note, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, datasetId, version, snapshot.dataset_type, snapshot.settings.stale_threshold_years, snapshot.settings.reference_date_mode, snapshot.settings.reference_date, J({ snapshot, lineage: lineage || null }), 1, snapshot.rules.catalog_version, hash, note || null, userId || null);
    const ins = db.prepare('INSERT INTO config_rule_settings (id, config_id, rule_id, enabled, severity_override, params_json) VALUES (?,?,?,?,?,?)');   // rule-level control, stored per configuration
    for (const r of RC.ruleSettingRows(snapshot.rules.config)) ins.run(uuid(), id, r.rule_id, r.enabled, r.severity_override, r.params_json);
  });
  const row = db.prepare('SELECT version FROM analysis_configs WHERE id = ?').get(id);
  return { config_id: id, version: row.version, config_hash: hash, reused: false, table_type: snapshot.dataset_type };
}
const getAnalysisConfig = (db, configId) => { const r = db.prepare('SELECT * FROM analysis_configs WHERE id = ?').get(configId); if (!r) throw err(404, 'Configuration not found.'); return { ...r, config: P(r.config_json) }; };

/**
 * PLAN A RE-RUN from a completed run: apply the requested mapping/requiredness/settings changes as NEW mapping versions and a NEW configuration.
 * Writes nothing to the parent run or its configuration. (Creating the run itself belongs to the orchestrator stage, which receives this plan.)
 */
const mergeOverrides = (a, b) => { const o = JSON.parse(JSON.stringify(a || {})); for (const [k, v] of Object.entries(b || {})) { if (k === 'rules') { o.rules = o.rules || {}; for (const [id, s] of Object.entries(v)) o.rules[id] = { ...(o.rules[id] || {}), ...s, ...(s.params || (o.rules[id] || {}).params ? { params: { ...((o.rules[id] || {}).params || {}), ...(s.params || {}) } } : {}) }; } else o[k] = { ...(o[k] || {}), ...v }; } return o; };
const deepMerge = (a, b) => { const o = JSON.parse(JSON.stringify(a || {})); for (const [k, v] of Object.entries(b || {})) o[k] = v && typeof v === 'object' && !Array.isArray(v) && o[k] && typeof o[k] === 'object' && !Array.isArray(o[k]) ? deepMerge(o[k], v) : JSON.parse(JSON.stringify(v)); return o; };
function planReRun(db, { parentRunId, changes, settings, userId, reason, ruleOverrides, identityOverrides, scoringOverrides }) {
  const run = db.prepare('SELECT id, dataset_id, config_id, engine_version, status FROM analysis_runs WHERE id = ?').get(parentRunId); if (!run) throw err(404, 'Parent run not found.');
  if (!run.config_id) throw err(409, 'The parent run has no immutable configuration (it predates the configuration model), so it cannot be re-planned.');
  const parent = getAnalysisConfig(db, run.config_id); const snap = parent.config.snapshot; const moves = []; const newSources = [];
  for (const src of snap.sources) {
    const ch = (changes || []).filter(c => c.source_file_id === src.source_file_id);
    if (!ch.length && !(changes || []).some(c => c.dataset_type && (!c.source_file_id || c.source_file_id === src.source_file_id))) { newSources.push({ source_file_id: src.source_file_id, mapping_version: src.mapping_version }); continue; }
    const rev = svc.reviseMapping(db, src.source_file_id, src.mapping_version, userId, reason || `re-run of ${parentRunId}`);
    for (const c of ch) {
      if (c.dataset_type) svc.setDatasetType(db, src.source_file_id, rev.version, c.dataset_type, c.note, userId);
      const col = c.file_column_id || (db.prepare('SELECT id FROM file_columns WHERE source_file_id = ? AND header_key = ?').get(src.source_file_id, c.header_key) || {}).id;
      if (!c.dataset_type || col) { if (!col) throw err(400, 'Each change needs file_column_id or header_key.'); svc.overrideColumn(db, src.source_file_id, rev.version, col, { role: c.role, requiredness: c.requiredness, include_in_analysis: c.include_in_analysis, note: c.note }, userId); }
    }
    svc.confirmMapping(db, src.source_file_id, rev.version, { userId, acceptSuggestions: true });
    moves.push({ source_file_id: src.source_file_id, from_mapping_version: src.mapping_version, to_mapping_version: rev.version }); newSources.push({ source_file_id: src.source_file_id, mapping_version: rev.version });
  }
  const cfg = createAnalysisConfig(db, { datasetId: run.dataset_id, sources: newSources, settings: { ...snap.settings, ...(settings || {}) }, ruleOverrides: mergeOverrides(snap.rules ? snap.rules.overrides : {}, ruleOverrides), identityOverrides: deepMerge(snap.identity ? snap.identity.overrides : {}, identityOverrides), scoringOverrides: deepMerge(snap.scoring ? snap.scoring.overrides : {}, scoringOverrides), userId, note: reason || null,
    lineage: { parent_run_id: run.id, parent_config_id: run.config_id, parent_config_hash: parent.config_hash, parent_engine_version: run.engine_version, mapping_moves: moves } });
  return { parent_run_id: run.id, parent_config_id: run.config_id, new_config_id: cfg.config_id, new_config_version: cfg.version, new_config_hash: cfg.config_hash, config_reused: cfg.reused, mapping_moves: moves, engine_version: run.engine_version, rerun_reason: reason || null,
    note: 'Planned only: no run was created and the parent run and its configuration are untouched.' };
}
module.exports = { buildSnapshot, createAnalysisConfig, getAnalysisConfig, planReRun };
