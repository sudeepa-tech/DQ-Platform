'use strict';
/*
 * DATASET TYPE classification from the roles found (never from a file name or a dataset identity):
 *   master_entity | master_material | transaction | mixed_unknown
 * Each type accumulates weighted evidence from the roles present (a role counts once, at its best confidence). The winner must own enough of the
 * evidence and lead by a margin; otherwise the dataset is mixed_unknown. Alternatives, reasons and a needs_review flag are always returned.
 * Weights and thresholds are configuration (config.js), so they can change per engine version without touching this code.
 */
const { DATASET_TYPES } = require('./taxonomy');
const TYPES = DATASET_TYPES.filter(t => t !== 'mixed_unknown');
const clamp = x => Math.max(0, Math.min(1, x));

function classifyDataset(mappings, cfg, override) {
  const dc = cfg.dataset_type; const best = {};
  for (const m of mappings) if (m.role !== 'unknown' && m.confidence >= dc.min_role_confidence) best[m.role] = Math.max(best[m.role] || 0, m.confidence);
  const scores = {};
  for (const t of TYPES) { let raw = 0; const roles = []; for (const [role, w] of Object.entries(dc.role_weights[t])) if (best[role]) { raw += w * best[role]; roles.push({ role, weight: w, confidence: +best[role].toFixed(3) }); } const max = Object.values(dc.role_weights[t]).reduce((a, b) => a + b, 0); scores[t] = { raw: +raw.toFixed(3), max_possible: max, roles }; }
  const total = TYPES.reduce((a, t) => a + scores[t].raw, 0);
  for (const t of TYPES) scores[t].share = total ? +(scores[t].raw / total).toFixed(4) : 0;
  const ranked = [...TYPES].sort((a, b) => scores[b].raw - scores[a].raw || a.localeCompare(b));
  const w = ranked[0], s2 = ranked[1]; const margin = scores[w].share - scores[s2].share;
  const reasons = []; let type, confidence;
  if (total < dc.min_evidence) { type = 'mixed_unknown'; confidence = 0.3; reasons.push(`too little recognised structure to tell (evidence ${total.toFixed(1)} < ${dc.min_evidence})`); }
  else if (scores[w].share < dc.min_share || margin < dc.min_margin) { type = 'mixed_unknown'; confidence = clamp(0.35 + 0.3 * scores[w].share); reasons.push(`evidence is split: ${ranked.map(t => `${t} ${Math.round(scores[t].share * 100)}%`).join(', ')}`); }
  else { type = w; confidence = clamp(0.5 * scores[w].share + 0.5 * Math.min(1, scores[w].raw / (0.6 * scores[w].max_possible))); }
  if (type !== 'mixed_unknown') { reasons.push(`${type} evidence: ${scores[type].roles.map(r => r.role).join(', ')}`); for (const t of TYPES) if (t !== type && scores[t].share >= 0.15) reasons.push(`also carries ${t} columns (${scores[t].roles.map(r => r.role).join(', ')}) - ${Math.round(scores[t].share * 100)}% of the evidence`); }
  const alternatives = ranked.filter(t => t !== type).map(t => ({ dataset_type: t, share: scores[t].share, score: scores[t].raw })).concat(type === 'mixed_unknown' ? [] : [{ dataset_type: 'mixed_unknown', share: 0, score: 0 }]);
  let needs_review = type === 'mixed_unknown' || confidence < dc.needs_review_below;
  const result = { dataset_type: type, confidence: +confidence.toFixed(4), needs_review, reasons, alternatives, evidence: { scores, margin: +margin.toFixed(4), total_evidence: +total.toFixed(3) }, source: 'classifier' };
  if (override) { if (!DATASET_TYPES.includes(override.dataset_type)) throw Object.assign(new Error(`Unknown dataset type "${override.dataset_type}"`), { status: 400 }); return { ...result, suggested_type: type, dataset_type: override.dataset_type, source: 'user', needs_review: false, reasons: [`set by the user${override.note ? ': ' + override.note : ''}`, ...reasons] }; }
  return result;
}
module.exports = { classifyDataset };
