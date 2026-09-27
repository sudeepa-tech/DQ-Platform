'use strict';
/* QA adapter for the S5 identity layer: S2 ingest -> S3 confirmed mapping -> immutable snapshot -> S4 rules -> S5 identity, in a temp database. Test tooling only. */
const path = require('path'); const REPO = path.resolve(__dirname, '..', '..'); const B = p => require(path.join(REPO, 'backend/src', p)); const A = require('./rules_v1'); const cache = new Map();
function analyzeIdentity(file, { sheet, identityOverrides, decisions, ...rest } = {}) {
  const key = JSON.stringify([file, sheet || '', identityOverrides || {}, decisions || [], rest, require('fs').statSync(file).mtimeMs]); if (cache.has(key)) return cache.get(key);
  const out = A.analyzeFile(file, { sheet, ...rest }); const cs = B('semantic/configSnapshot'), RS = B('rules/ruleService'), I = B('identity');
  const snap = cs.getAnalysisConfig(out.db, out.configId).config.snapshot; const src = snap.sources[0];
  const id = I.runIdentity({ datasetType: snap.dataset_type, columns: src.columns, rows: () => RS.iterCanonicalRows(out.db, out.sourceFileId), ruleFindings: out.result.findings, identityConfig: I.resolveIdentityConfig(identityOverrides), decisions });
  const r = { ...out, identity: id }; cache.set(key, r); return r;
}
/** identity result -> the engine-neutral RunView pieces the scorer understands. Members are the view's business keys (never internal ids). */
function toLegacyView(o, keyColumn) {
  const keys = A.rowKeys(o, keyColumn); const k = m => keys.get(m.row_number) || null; const id = o.identity; const e = id.entity;
  const entityClusters = e ? e.clusters.map(c => ({ id: c.id, kind: 'entity', members: c.members.map(k).filter(Boolean).sort(), exactRepeat: c.exact_repeat, confidence: c.confidence, factors: c.factors, conflicts: c.conflicts })) : [];
  const itemClusters = id.material ? id.material.groups.map(g => ({ id: g.id, kind: 'item', members: g.members.map(k).filter(Boolean).sort(), exactRepeat: false, confidence: null, factors: [], conflicts: [] })) : [];
  const conflicts = id.conflicts.map(c => ({ type: c.type, subject: c.subject, field: c.field, members: c.members.map(k).filter(Boolean).sort() }));
  const pairs = (e ? e.matches.length + e.candidates.length + e.ambiguous.length : 0) + (id.material ? id.material.candidates.length : 0);
  return { entityClusters, itemClusters, conflicts, persistedPairs: pairs };
}
module.exports = { analyzeIdentity, toLegacyView };
