'use strict';
/*
 * Schema Review API - the backend contract for the future Schema Review screen (S6 builds the UI).
 * Read model:  GET  /api/schema/sources/:sourceFileId            dataset type + every column: role, confidence, reasons, alternatives, requiredness, validation profile, include flag
 * Decisions:   PATCH .../versions/:v/dataset-type | .../columns/:fileColumnId ; POST .../confirm (locks) | .../revise (new draft)
 * Run config:  POST /api/schema/datasets/:datasetId/configs (immutable snapshot) ; POST /api/schema/runs/:runId/plan-rerun
 * Every source/dataset/run is checked against the caller's organization. The semantic stage requires a canonically ingested file (it is not wired into the upload route yet).
 */
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const svc = require('../semantic/schemaService');
const cfgs = require('../semantic/configSnapshot');
const { describeTaxonomy, DEFAULT_SEMANTIC_CONFIG, hashConfig, versions } = require('../semantic');

const router = express.Router();
router.use(requireAuth);

function ownSource(req) {
  const r = db.prepare('SELECT sf.id FROM source_files sf JOIN datasets d ON d.id = sf.dataset_id WHERE sf.id = ? AND d.organization_id = ?').get(req.params.sourceFileId, req.user.org);
  if (!r) throw svc.err(404, 'Source file not found.'); return r.id;
}
function ownDataset(req) {
  const r = db.prepare('SELECT id FROM datasets WHERE id = ? AND organization_id = ?').get(req.params.datasetId, req.user.org);
  if (!r) throw svc.err(404, 'Dataset not found.'); return r.id;
}
const ver = req => { const v = Number(req.params.v); if (!Number.isInteger(v) || v < 1) throw svc.err(400, 'Invalid mapping version.'); return v; };
const guard = (res, fn) => { try { return fn(); } catch (e) { if (e.unresolved || e.dataset_type_unresolved) return res.status(e.status || 409).json({ error: e.message, unresolved: e.unresolved, dataset_type_unresolved: e.dataset_type_unresolved, dataset_type: e.dataset_type, required_action: e.required_action }); throw e; } };

router.get('/taxonomy', (req, res) => res.json({ ...describeTaxonomy(), semantic_config_version: DEFAULT_SEMANTIC_CONFIG.version, semantic_config_hash: hashConfig(DEFAULT_SEMANTIC_CONFIG), versions: versions(DEFAULT_SEMANTIC_CONFIG) }));

router.get('/sources/:sourceFileId', (req, res) => {
  const id = ownSource(req); const v = req.query.version ? Number(req.query.version) : undefined;
  res.json(svc.getReviewModel(db, id, v, { includeEvidence: req.query.evidence === '1' }));
});
router.post('/sources/:sourceFileId/suggest', (req, res) => {
  const id = ownSource(req); const b = req.body || {};
  const s = svc.suggestMapping(db, id, { userId: req.user.sub, force: !!b.force });
  res.status(s.reused ? 200 : 201).json({ ...s, review: svc.getReviewModel(db, id, s.version) });
});
router.patch('/sources/:sourceFileId/versions/:v/dataset-type', (req, res) => {
  const id = ownSource(req); res.json(svc.setDatasetType(db, id, ver(req), (req.body || {}).dataset_type, (req.body || {}).note, req.user.sub));
});
router.patch('/sources/:sourceFileId/versions/:v/columns/:fileColumnId', (req, res) => {
  const id = ownSource(req); res.json(svc.overrideColumn(db, id, ver(req), req.params.fileColumnId, req.body || {}, req.user.sub));
});
router.post('/sources/:sourceFileId/versions/:v/confirm', (req, res) => {
  const id = ownSource(req); guard(res, () => res.json(svc.confirmMapping(db, id, ver(req), { userId: req.user.sub, acceptSuggestions: !!(req.body || {}).accept_suggestions })));
});
router.post('/sources/:sourceFileId/versions/:v/revise', (req, res) => {
  const id = ownSource(req); const r = svc.reviseMapping(db, id, ver(req), req.user.sub, (req.body || {}).note); res.status(201).json({ ...r, review: svc.getReviewModel(db, id, r.version) });
});
router.post('/datasets/:datasetId/configs', (req, res) => {
  const datasetId = ownDataset(req); const b = req.body || {};
  const r = cfgs.createAnalysisConfig(db, { datasetId, sources: b.sources, settings: b.settings, ruleOverrides: b.rule_overrides, identityOverrides: b.identity_overrides, scoringOverrides: b.scoring_overrides, userId: req.user.sub, note: b.note });
  res.status(r.reused ? 200 : 201).json(r);
});
router.get('/datasets/:datasetId/configs/:configId', (req, res) => {
  const datasetId = ownDataset(req); const c = cfgs.getAnalysisConfig(db, req.params.configId);
  if (c.dataset_id !== datasetId) throw svc.err(404, 'Configuration not found.'); res.json(c);
});
router.post('/runs/:runId/plan-rerun', (req, res) => {
  const run = db.prepare('SELECT ar.id FROM analysis_runs ar JOIN datasets d ON d.id = ar.dataset_id WHERE ar.id = ? AND d.organization_id = ?').get(req.params.runId, req.user.org);
  if (!run) throw svc.err(404, 'Run not found.'); const b = req.body || {};
  res.status(201).json(cfgs.planReRun(db, { parentRunId: run.id, changes: b.changes, settings: b.settings, ruleOverrides: b.rule_overrides, identityOverrides: b.identity_overrides, scoringOverrides: b.scoring_overrides, userId: req.user.sub, reason: b.reason }));
});
module.exports = router;
