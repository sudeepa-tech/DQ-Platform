'use strict';
/*
 * SCORING CONFIGURATION (S7): versioned, hashed, strictly validated -- exactly like S4's rule config and S5's identity config.
 * Dimension weights, severity weights, and the per-dimension scoring policy are DATA here, not buried in the engine.
 */
const crypto = require('crypto');
const SCORING_ENGINE_VERSION = 'scoring-1.0.0'; const SCORING_CONFIG_VERSION = 'scoring-config-1.0.0';
const deepFreeze = o => { for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v); return Object.freeze(o); };
const err = m => Object.assign(new Error(m), { status: 400 });
const canonical = v => (Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']' : v && typeof v === 'object' ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}' : JSON.stringify(v));
const hashConfig = cfg => crypto.createHash('sha256').update(canonical(cfg)).digest('hex');

const DEFAULT_SCORING_CONFIG = deepFreeze({
  version: SCORING_CONFIG_VERSION,
  dimension_weights: { completeness: 0.20, validity: 0.20, uniqueness: 0.20, consistency: 0.20, freshness: 0.20 },
  severity_weights: { critical: 1.0, high: 0.75, medium: 0.50, low: 0.25 },
  // an entirely-empty required/expected column is ONE dataset-level defect (weight below), never one defect per row
  completeness: { column_empty_severity_weight: { required: 1.0, expected: 0.5 } },
  uniqueness: {
    scoring_unit: 'record',            // 'record': defect_rate is per redundant RECORD (comparable to the other dimensions' per-record rates)
    dataset_type_population: { master_entity: 'entity', master_material: 'material', transaction: 'transaction', mixed_unknown: 'entity' }
  },
  consistency: {
    scoring_unit: 'record',             // affected records, deduplicated across a group's evidence paths and across a record's several group memberships
    dataset_type_population: { master_entity: 'entity', master_material: 'material', transaction: 'transaction', mixed_unknown: 'entity' }
  },
  freshness: { exclude_records_with_no_date: true }   // a record with NEITHER creation nor modification date is excluded from both the denominator and the defect count (not silently counted as fresh, not penalised as stale)
});

function resolveScoringConfig(overrides) {
  const o = overrides || {}; for (const k of Object.keys(o)) if (k === 'version') throw err('The scoring config version cannot be overridden.');
  const c = JSON.parse(JSON.stringify(DEFAULT_SCORING_CONFIG));
  const merge = (base, patch, path) => { for (const [k, v] of Object.entries(patch)) { if (!(k in base)) throw err(`Unknown scoring setting "${path}${k}".`);
    if (base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) { if (!v || typeof v !== 'object' || Array.isArray(v)) throw err(`Scoring setting "${path}${k}" must be an object.`); merge(base[k], v, path + k + '.'); }
    else { if (typeof v !== typeof base[k]) throw err(`Scoring setting "${path}${k}" has the wrong type.`); base[k] = v; } } };
  merge(c, o, '');
  const w = c.dimension_weights; const dims = ['completeness', 'validity', 'uniqueness', 'consistency', 'freshness'];
  for (const d of dims) if (!(typeof w[d] === 'number' && w[d] >= 0 && w[d] <= 1)) throw err(`dimension_weights.${d} must be a number between 0 and 1.`);
  const sum = dims.reduce((s, d) => s + w[d], 0); if (Math.abs(sum - 1) > 1e-6) throw err(`dimension_weights must sum to 1 (got ${sum.toFixed(4)}).`);
  for (const [k, v] of Object.entries(c.severity_weights)) { if (!['critical', 'high', 'medium', 'low'].includes(k)) throw err(`Unknown severity "${k}" in severity_weights.`); if (!(typeof v === 'number' && v >= 0 && v <= 1)) throw err(`severity_weights.${k} must be a number between 0 and 1.`); }
  for (const k of ['critical', 'high', 'medium', 'low']) if (!(k in c.severity_weights)) throw err(`severity_weights.${k} is required.`);
  if (!['record', 'cluster'].includes(c.uniqueness.scoring_unit)) throw err("uniqueness.scoring_unit must be 'record' or 'cluster'.");
  if (!['record', 'group'].includes(c.consistency.scoring_unit)) throw err("consistency.scoring_unit must be 'record' or 'group'.");
  return deepFreeze(c);
}
module.exports = { SCORING_ENGINE_VERSION, SCORING_CONFIG_VERSION, DEFAULT_SCORING_CONFIG, resolveScoringConfig, hashConfig: c => hashConfig(c) };
