'use strict';
/*
 * Persistence + workflow for the semantic layer (the Review Gate domain model).
 *   profile -> suggest (new DRAFT mapping version) -> review / override -> confirm (LOCKS the version) -> [revise = new draft version]
 * A locked mapping version is immutable (database-enforced, structurally). Nothing here touches a run: runs consume a locked mapping version through a
 * run-configuration snapshot (configSnapshot.js).
 */
const crypto = require('crypto');
const S = require('./index');
const { ROLES, isRole, familyOf, REQUIREDNESS, DATASET_TYPES, describeTaxonomy } = S;

const uuid = () => crypto.randomUUID();
const J = v => (v === undefined || v === null ? null : JSON.stringify(v));
const P = s => (s ? JSON.parse(s) : null);
const err = (status, message) => Object.assign(new Error(message), { status });
const inTxn = (db, fn) => { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { try { db.exec('ROLLBACK'); } catch (_) { /* nothing open */ } throw e; } };

function loadSource(db, sourceFileId) {
  const sf = db.prepare('SELECT * FROM source_files WHERE id = ?').get(sourceFileId);
  if (!sf) throw err(404, 'Source file not found.');
  if (sf.ingest_status !== 'ingested') throw err(409, `This file has not been canonically ingested (status: ${sf.ingest_status}); the semantic stage runs after ingestion.`);
  return sf;
}
const loadColumns = (db, sfId) => db.prepare('SELECT * FROM file_columns WHERE source_file_id = ? ORDER BY column_index').all(sfId);
const toClassifierColumn = c => ({ position: c.column_index, header_key: c.header_key, header_raw: c.header_raw, header_normalized: c.header_normalized, distinct_count: c.distinct_count });

function* iterRows(db, sfId, batch = 2000) {
  let last = 0; const q = db.prepare('SELECT row_number, raw_json, raw_meta_json FROM source_rows WHERE source_file_id = ? AND row_number > ? ORDER BY row_number LIMIT ?');
  for (;;) { const rows = q.all(sfId, last, batch); if (!rows.length) return; for (const r of rows) yield { raw: JSON.parse(r.raw_json), meta: r.raw_meta_json ? JSON.parse(r.raw_meta_json) : {} }; last = rows[rows.length - 1].row_number; }
}

/** PROFILE stage: full-column content profile, stored per physical column and reused while the profile version is unchanged */
function profileSource(db, sourceFileId) {
  const sf = loadSource(db, sourceFileId); const cols = loadColumns(db, sourceFileId);
  const have = db.prepare('SELECT file_column_id, profile_json FROM column_profiles WHERE source_file_id = ? AND profile_version = ?').all(sourceFileId, S.versions(S.DEFAULT_SEMANTIC_CONFIG).profile);
  if (have.length === cols.length) { const m = new Map(have.map(h => [h.file_column_id, JSON.parse(h.profile_json)])); return { sourceFile: sf, columns: cols, profiles: cols.map(c => m.get(c.id)), reused: true }; }
  const profiles = S.profileColumns(cols.map(toClassifierColumn), iterRows(db, sourceFileId));
  inTxn(db, () => { const ins = db.prepare('INSERT OR REPLACE INTO column_profiles (id, source_file_id, file_column_id, profile_version, profile_json) VALUES (?,?,?,?,?)'); cols.forEach((c, i) => ins.run(uuid(), sourceFileId, c.id, profiles[i].version, JSON.stringify(profiles[i]))); });
  return { sourceFile: sf, columns: cols, profiles, reused: false };
}

const latestVersion = (db, sfId) => (db.prepare('SELECT MAX(mapping_version) v FROM schema_mapping_sets WHERE source_file_id = ?').get(sfId) || {}).v || 0;
const getSet = (db, sfId, version) => db.prepare('SELECT * FROM schema_mapping_sets WHERE source_file_id = ? AND mapping_version = ?').get(sfId, version);
function requireSet(db, sfId, version) { const s = getSet(db, sfId, version); if (!s) throw err(404, `Mapping version ${version} does not exist for this file.`); return s; }
function requireDraft(db, sfId, version) { const s = requireSet(db, sfId, version); if (s.locked_at) throw err(409, `Mapping version ${version} is confirmed and locked. Revise it to create a new version; a locked version is never edited.`); return s; }

function fingerprint(sf, config, extra = '') { return S.sha256([sf.content_sha256, sf.ingest_fingerprint, S.hashConfig(config), S.versions(config).profile, S.TAXONOMY_VERSION, S.SEMANTIC_ENGINE_VERSION, extra].join('|')); }

function insertMappings(db, sfId, version, cols, mappings, userId) {
  const ins = db.prepare(`INSERT INTO schema_mappings (id, source_file_id, file_column_id, mapping_version, role, role_family, confidence, confidence_tier, status, is_critical_identity, review_required, review_reason,
    requiredness, requiredness_source, include_in_analysis, alternatives_json, evidence_json, validation_profile_json, suggested_role, suggested_requiredness, user_overridden, requiredness_reason, review_reasons_json, primary_for_role, content_type)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  mappings.forEach((m, i) => ins.run(uuid(), sfId, cols[i].id, version, m.role, m.role_family, m.confidence, m.confidence_tier, m.review_required || m.confidence_tier !== 'high' ? 'suggested' : 'auto_accepted', m.is_critical_identity ? 1 : 0, m.review_required ? 1 : 0,
    m.review_reasons.join('; ') || null, m.requiredness, m.requiredness_source, m.include_in_analysis ? 1 : 0, J(m.alternatives), J(m.evidence), J(m.validation_profile), m.role, m.requiredness, 0, m.requiredness_reason, J(m.review_reasons), m.primary_for_role === undefined ? null : (m.primary_for_role ? 1 : 0), m.content_type));
}

/** SUGGEST: classify and store a new DRAFT mapping version. Idempotent: while the inputs (file content, ingest settings, semantic policy, versions) are unchanged the latest version -
 *  original or user-revised - is returned instead of a fresh draft that would shadow the user's reviewed work. `force` asks for a new classifier draft anyway. */
function suggestMapping(db, sourceFileId, opts = {}) {
  const { sourceFile, columns, profiles } = profileSource(db, sourceFileId);
  const config = S.resolveConfig(opts.config); const fp = fingerprint(sourceFile, config, J(opts.datasetTypeOverride) || '');
  const latest = latestVersion(db, sourceFileId);
  if (latest && !opts.force) { const cur = getSet(db, sourceFileId, latest); if (cur.input_fingerprint === fp) return { version: latest, reused: true }; }
  const r = S.analyzeFromProfiles(columns.map(toClassifierColumn), profiles, { config, resolved: true, datasetTypeOverride: opts.datasetTypeOverride });
  const version = latest + 1;
  inTxn(db, () => {
    db.prepare(`INSERT INTO schema_mapping_sets (id, source_file_id, mapping_version, parent_mapping_version, dataset_type, dataset_type_confidence, dataset_type_source, suggested_dataset_type, dataset_type_needs_review, dataset_type_evidence_json,
      engine_version, taxonomy_version, profile_version, semantic_config_json, semantic_config_hash, input_fingerprint, status, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'draft', ?)`)
      .run(uuid(), sourceFileId, version, null, r.dataset.dataset_type, r.dataset.confidence, r.dataset.source, r.dataset.suggested_type || r.dataset.dataset_type, r.dataset.needs_review ? 1 : 0, J({ reasons: r.dataset.reasons, alternatives: r.dataset.alternatives, evidence: r.dataset.evidence }),
        r.versions.engine, r.versions.taxonomy, r.versions.profile, JSON.stringify(config), r.versions.config_hash, fp, opts.userId || null);
    insertMappings(db, sourceFileId, version, columns, r.mappings, opts.userId);
  });
  return { version, reused: false };
}

const mapRow = m => ({ ...m, alternatives: P(m.alternatives_json) || [], evidence: P(m.evidence_json), validation_profile: P(m.validation_profile_json), review_reasons: P(m.review_reasons_json) || [] });
const loadMappings = (db, sfId, version) => db.prepare(`SELECT m.*, c.column_index, c.column_letter, c.header_raw, c.header_key, c.header_normalized, c.is_duplicate_header, c.duplicate_ordinal, c.populated_count, c.populated_ratio, c.is_empty
  FROM schema_mappings m JOIN file_columns c ON c.id = m.file_column_id WHERE m.source_file_id = ? AND m.mapping_version = ? ORDER BY c.column_index`).all(sfId, version).map(mapRow);

/** the Review Gate read model: everything the Schema Review screen shows and lets the user change */
function getReviewModel(db, sourceFileId, version, { includeEvidence = false } = {}) {
  const sf = db.prepare('SELECT * FROM source_files WHERE id = ?').get(sourceFileId); if (!sf) throw err(404, 'Source file not found.');
  const v = version || latestVersion(db, sourceFileId); if (!v) throw err(404, 'No semantic mapping has been suggested for this file yet.');
  const set = requireSet(db, sourceFileId, v); const cfg = JSON.parse(set.semantic_config_json); const rows = sf.data_row_count || 0; const ms = loadMappings(db, sourceFileId, v);
  const ev = P(set.dataset_type_evidence_json) || {};
  const columns = ms.map(m => ({ file_column_id: m.file_column_id, position: m.column_index, letter: m.column_letter, header_raw: m.header_raw, header_key: m.header_key, header_normalized: m.header_normalized, is_duplicate_header: !!m.is_duplicate_header, duplicate_ordinal: m.duplicate_ordinal,
    populated_count: m.populated_count, populated_ratio: m.populated_ratio, is_empty: !!m.is_empty, content_type: m.content_type,
    role: m.role, role_family: m.role_family, confidence: m.confidence, confidence_tier: m.confidence_tier, status: m.status, review_required: !!m.review_required, review_reasons: m.review_reasons, alternatives: m.alternatives,
    requiredness: { value: m.requiredness, source: m.requiredness_source, reason: m.requiredness_reason, if_missing: S.missingDisposition(m.requiredness, m.populated_count || 0, rows, cfg) },
    validation_profile: m.validation_profile, include_in_analysis: !!m.include_in_analysis, primary_for_role: m.primary_for_role === null ? null : !!m.primary_for_role,
    user_overridden: !!m.user_overridden, suggested_role: m.suggested_role, suggested_requiredness: m.suggested_requiredness, override_note: m.override_note, ...(includeEvidence ? { evidence: m.evidence } : {}) }));
  const count = (f, k) => columns.reduce((a, c) => { const x = f(c); a[x] = (a[x] || 0) + 1; return a; }, {});
  return {
    source_file: { id: sf.id, dataset_id: sf.dataset_id, original_filename: sf.original_filename, sheet_name: sf.sheet_name, content_sha256: sf.content_sha256, data_row_count: rows, column_count: columns.length },
    mapping: { version: set.mapping_version, parent_version: set.parent_mapping_version, status: set.status, locked: !!set.locked_at, locked_at: set.locked_at, engine_version: set.engine_version, taxonomy_version: set.taxonomy_version, config_version: cfg.version, config_hash: set.semantic_config_hash, created_at: set.created_at, confirmed_at: set.confirmed_at, latest_version: latestVersion(db, sourceFileId) },
    dataset_type: { value: set.dataset_type, confidence: set.dataset_type_confidence, source: set.dataset_type_source, suggested: set.suggested_dataset_type, needs_review: !!set.dataset_type_needs_review, reasons: ev.reasons || [], alternatives: ev.alternatives || [] },
    summary: { columns: columns.length, included: columns.filter(c => c.include_in_analysis).length, empty_columns: columns.filter(c => c.is_empty).length, review_required: columns.filter(c => c.review_required).length, unresolved_review: columns.filter(c => c.review_required && c.status === 'suggested').length,
      by_role_family: count(c => c.role_family), by_requiredness: count(c => c.requiredness.value), by_status: count(c => c.status) },
    columns, options: describeTaxonomy()
  };
}

/** recompute everything derived from the current (possibly user-edited) roles: dataset type suggestion, requiredness, validation profiles */
function recomputeDerived(db, sfId, version) {
  const set = requireDraft(db, sfId, version); const cfg = JSON.parse(set.semantic_config_json); const ms = loadMappings(db, sfId, version);
  const asC = ms.map(m => ({ role: m.role, confidence: m.user_overridden || m.status === 'confirmed' ? 1 : m.confidence }));
  const dataset = set.dataset_type_source === 'user' ? null : S.classifyDataset(asC, cfg);
  const datasetType = dataset ? dataset.dataset_type : set.dataset_type;
  const profiles = ms.map(m => ({ rows: 0, populated: m.populated_count || 0 })); const sf = db.prepare('SELECT data_row_count FROM source_files WHERE id = ?').get(sfId); profiles.forEach(p => { p.rows = sf.data_row_count || 0; });
  const ov = {}; ms.forEach(m => { if (m.requiredness_source === 'user') ov[m.header_key + '\u0000' + m.column_index] = true; });
  const mapped = ms.map(m => ({ header_key: m.header_key + '\u0000' + m.column_index, role: m.role, confidence: m.confidence, include_in_analysis: m.include_in_analysis, primary_for_role: m.primary_for_role === null ? undefined : !!m.primary_for_role }));
  const overrides = {}; ms.forEach(m => { if (m.requiredness_source === 'user') overrides[m.header_key + '\u0000' + m.column_index] = { requiredness: m.requiredness, note: m.requiredness_reason }; });
  const req = S.resolveRequiredness(mapped, profiles, datasetType, cfg, overrides);
  inTxn(db, () => {
    if (dataset) db.prepare('UPDATE schema_mapping_sets SET dataset_type = ?, dataset_type_confidence = ?, suggested_dataset_type = ?, dataset_type_needs_review = ?, dataset_type_evidence_json = ? WHERE source_file_id = ? AND mapping_version = ?')
      .run(dataset.dataset_type, dataset.confidence, dataset.dataset_type, dataset.needs_review ? 1 : 0, J({ reasons: dataset.reasons, alternatives: dataset.alternatives, evidence: dataset.evidence }), sfId, version);
    const up = db.prepare('UPDATE schema_mappings SET requiredness = ?, requiredness_source = ?, requiredness_reason = ?, validation_profile_json = ? WHERE id = ?');
    ms.forEach((m, i) => { const vp = S.buildValidationProfile(datasetType, { role: m.role, confidence_tier: m.confidence_tier, review_required: !!m.review_required && m.status === 'suggested' }, cfg, m.status === 'confirmed' || m.status === 'overridden');
      up.run(req[i].requiredness, req[i].source, req[i].reason, J(vp), m.id); });
  });
}

/** OVERRIDE one column (draft only). Accepts: role, requiredness, include_in_analysis, confirm (accept the suggestion as is), note */
function overrideColumn(db, sourceFileId, version, fileColumnId, changes, userId) {
  requireDraft(db, sourceFileId, version);
  const m = db.prepare('SELECT * FROM schema_mappings WHERE source_file_id = ? AND mapping_version = ? AND file_column_id = ?').get(sourceFileId, version, fileColumnId);
  if (!m) throw err(404, 'That column has no mapping in this version.');
  const ch = changes || {}; const sets = []; const args = [];
  if (ch.role !== undefined) { if (!isRole(ch.role)) throw err(400, `Unknown role "${ch.role}". Allowed: ${Object.keys(ROLES).join(', ')}.`);
    sets.push('role = ?', 'role_family = ?', 'is_critical_identity = ?', 'confidence = ?', "confidence_tier = 'high'", "status = 'overridden'", 'user_overridden = 1', 'review_required = 0', 'review_reason = NULL', 'review_reasons_json = NULL');
    args.push(ch.role, familyOf(ch.role), ROLES[ch.role].critical && ch.role !== 'unknown' ? 1 : 0, 1); }
  else if (ch.confirm === true) { sets.push("status = 'confirmed'", 'review_required = 0'); }
  if (ch.requiredness !== undefined) { if (!REQUIREDNESS.includes(ch.requiredness)) throw err(400, `requiredness must be one of ${REQUIREDNESS.join(', ')}.`); sets.push('requiredness = ?', "requiredness_source = 'user'", 'requiredness_reason = ?'); args.push(ch.requiredness, ch.note || 'set by the user'); }
  if (ch.include_in_analysis !== undefined) { sets.push('include_in_analysis = ?'); args.push(ch.include_in_analysis ? 1 : 0); }
  if (ch.note !== undefined) { sets.push('override_note = ?'); args.push(ch.note); }
  if (!sets.length) throw err(400, 'Nothing to change: send role, requiredness, include_in_analysis, confirm or note.');
  sets.push('decided_by = ?', "decided_at = datetime('now')"); args.push(userId || null);
  db.prepare(`UPDATE schema_mappings SET ${sets.join(', ')} WHERE id = ?`).run(...args, m.id);
  recomputeDerived(db, sourceFileId, version);
  return getReviewModel(db, sourceFileId, version);
}
function setDatasetType(db, sourceFileId, version, datasetType, note, userId) {
  requireDraft(db, sourceFileId, version);
  if (!DATASET_TYPES.includes(datasetType)) throw err(400, `dataset_type must be one of ${DATASET_TYPES.join(', ')}.`);
  db.prepare("UPDATE schema_mapping_sets SET dataset_type = ?, dataset_type_source = 'user', dataset_type_needs_review = 0, note = COALESCE(?, note) WHERE source_file_id = ? AND mapping_version = ?").run(datasetType, note || null, sourceFileId, version);
  recomputeDerived(db, sourceFileId, version); return getReviewModel(db, sourceFileId, version);
}
/** CONFIRM: lock the version. Refuses while columns flagged for review are still undecided, unless the caller explicitly accepts the suggestions. */
function confirmMapping(db, sourceFileId, version, { userId, acceptSuggestions = false } = {}) {
  const set = requireDraft(db, sourceFileId, version); const ms = loadMappings(db, sourceFileId, version);
  const open = ms.filter(m => m.review_required && m.status === 'suggested');
  const dsOpen = set.dataset_type_needs_review && set.dataset_type_source === 'classifier';
  // An UNCERTAIN dataset type (mixed_unknown, needs_review, or below the configured decision threshold -- all three are
  // exactly what dataset_type_needs_review means) is NEVER accepted by accept_suggestions, for ANY caller: it decides which
  // S5 matchers even run, so unlike a column-level suggestion it is never a low-risk convenience to auto-accept. This is
  // enforced here, in the service every caller goes through (the route layer's own gate is defence in depth, not the source
  // of truth). Only an explicit setDatasetType() call (source becomes 'user') clears it.
  if (dsOpen) {
    const model = getReviewModel(db, sourceFileId, version);
    throw Object.assign(err(409, `The dataset type is uncertain (${model.dataset_type.value}, ${Math.round(model.dataset_type.confidence * 100)}% confidence) and must be explicitly confirmed or overridden before this mapping can be confirmed; accept_suggestions does not bypass this.`),
      { unresolved: open.map(m => ({ file_column_id: m.file_column_id, header_raw: m.header_raw, role: m.role, reasons: m.review_reasons })), dataset_type_unresolved: true, dataset_type: model.dataset_type,
        required_action: `PATCH /api/schema/sources/${sourceFileId}/versions/${version}/dataset-type with an explicit dataset_type, then confirm again.` });
  }
  if (open.length && !acceptSuggestions) throw Object.assign(err(409, `${open.length} column(s) still need a decision. Resolve them, or confirm with accept_suggestions to take the suggestions as they are.`), { unresolved: open.map(m => ({ file_column_id: m.file_column_id, header_raw: m.header_raw, role: m.role, reasons: m.review_reasons })), dataset_type_unresolved: false });
  inTxn(db, () => {
    db.prepare("UPDATE schema_mappings SET status = 'confirmed', decided_by = COALESCE(decided_by, ?), decided_at = COALESCE(decided_at, datetime('now')) WHERE source_file_id = ? AND mapping_version = ? AND status = 'suggested'").run(userId || null, sourceFileId, version);
  });
  recomputeDerivedLocked(db, sourceFileId, version);
  db.prepare("UPDATE schema_mapping_sets SET status = 'confirmed', locked_at = datetime('now'), confirmed_at = datetime('now'), confirmed_by = ? WHERE source_file_id = ? AND mapping_version = ?").run(userId || null, sourceFileId, version);
  return getReviewModel(db, sourceFileId, version);
}
const recomputeDerivedLocked = (db, sfId, v) => recomputeDerived(db, sfId, v);     // still a draft at this point; the lock is applied right after

/** REVISE: copy any version into a new DRAFT version (the only way to change what a run was configured with) */
function reviseMapping(db, sourceFileId, fromVersion, userId, note) {
  const from = requireSet(db, sourceFileId, fromVersion); const version = latestVersion(db, sourceFileId) + 1;
  inTxn(db, () => {
    db.prepare(`INSERT INTO schema_mapping_sets (id, source_file_id, mapping_version, parent_mapping_version, dataset_type, dataset_type_confidence, dataset_type_source, suggested_dataset_type, dataset_type_needs_review, dataset_type_evidence_json,
      engine_version, taxonomy_version, profile_version, semantic_config_json, semantic_config_hash, input_fingerprint, status, created_by, note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'draft', ?, ?)`)
      .run(uuid(), sourceFileId, version, fromVersion, from.dataset_type, from.dataset_type_confidence, from.dataset_type_source, from.suggested_dataset_type, from.dataset_type_needs_review, from.dataset_type_evidence_json, from.engine_version, from.taxonomy_version, from.profile_version,
        from.semantic_config_json, from.semantic_config_hash, from.input_fingerprint, userId || null, note || `revised from version ${fromVersion}`);
    db.prepare(`INSERT INTO schema_mappings (id, source_file_id, file_column_id, mapping_version, role, role_family, confidence, confidence_tier, status, is_critical_identity, review_required, review_reason, requiredness, requiredness_source, include_in_analysis,
      alternatives_json, evidence_json, decided_by, decided_at, validation_profile_json, suggested_role, suggested_requiredness, user_overridden, override_note, requiredness_reason, review_reasons_json, primary_for_role, content_type)
      SELECT lower(hex(randomblob(16))), source_file_id, file_column_id, ?, role, role_family, confidence, confidence_tier, status, is_critical_identity, review_required, review_reason, requiredness, requiredness_source, include_in_analysis,
      alternatives_json, evidence_json, decided_by, decided_at, validation_profile_json, suggested_role, suggested_requiredness, user_overridden, override_note, requiredness_reason, review_reasons_json, primary_for_role, content_type
      FROM schema_mappings WHERE source_file_id = ? AND mapping_version = ?`).run(version, sourceFileId, fromVersion);
  });
  return { version, parent_version: fromVersion };
}
module.exports = { profileSource, suggestMapping, getReviewModel, overrideColumn, setDatasetType, confirmMapping, reviseMapping, loadMappings, getSet, latestVersion, loadSource, err, inTxn, uuid };
