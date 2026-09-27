'use strict';
/*
 * IDENTITY CONFIGURATION (S5): versioned, hashed, strictly validated (typos / wrong types / bad values are errors, never silent no-ops).
 * The approved identity strategy lives here as data: which evidence is HARD / STRONG / SUPPORTING is fixed by the engine's structure, the thresholds, vocabulary,
 * blocking limits and confidence weights are configuration.
 */
const { hashConfig } = require('../semantic/config');
const IDENTITY_ENGINE_VERSION = 'identity-1.0.0'; const IDENTITY_CONFIG_VERSION = 'identity-config-1.0.0';
const deepFreeze = o => { for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v); return Object.freeze(o); };
const err = m => Object.assign(new Error(m), { status: 400 });
const DEFAULT_IDENTITY_CONFIG = deepFreeze({
  version: IDENTITY_CONFIG_VERSION,
  name: {
    legal_suffixes: ['pvt', 'private', 'ltd', 'limited', 'llp', 'inc', 'incorporated'], drop_words: ['the'],
    abbreviations: { engg: 'engineering', mfg: 'manufacturing', co: 'company', corp: 'corporation', intl: 'international', ind: 'industries' },
    compatible_at_or_above: 0.90,          // similarity at/above this (with equal numeric tokens) = compatible ("sim")
    different_below: 0.60,                 // below this = different
    token_overlap_guard: { applies_below: 0.85, max_jaccard: 0.34 }   // below 0.85 similarity, sharing <= 1 token in 3 is "different": shared suffix words must not fake similarity
  },
  blocking: { max_block_size: 400, name_blocks: false, name_block_max: 200 },   // name blocks add ~100x candidate pairs and, under the approved rules (a pair needs a shared hard/strong key to be anything), change no result
  fuzzy: { min_strong_signals: 2 },
  weights: { legal_id_agree: 0.55, vendor_code_agree: 0.35, name_equal: 0.20, name_compatible: 0.12, phone_equal: 0.10, email_equal: 0.10, address_equal: 0.05, max_confidence: 0.99 },
  review: { vendor_code_variant_needs_review: true },
  material: { description_compatible_at_or_above: 0.92, block_max: 200 },
  item_conflicts: { description_compatible_at_or_above: 0.92, on_tie: 'flag_all' },     // on_tie: 'flag_all' | 'flag_none'
  transaction: { require_reference: true, require_equal_amount: true, require_equal_date_or_entity: true },
  dataset_types: { entity_matching: ['master_entity', 'mixed_unknown'], item_conflicts: ['master_entity', 'mixed_unknown'], material_matching: ['master_material'], transaction_matching: ['transaction'] }
});
const clone = o => JSON.parse(JSON.stringify(o)); const sameShape = (a, b) => (Array.isArray(a) ? Array.isArray(b) : typeof a === typeof b) && (a === null) === (b === null);
function check(base, over, path) { for (const [k, v] of Object.entries(over)) { if (!(k in base)) throw err(`Unknown identity setting "${path}${k}".`); if (base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) { if (!v || typeof v !== 'object' || Array.isArray(v)) throw err(`Identity setting "${path}${k}" must be an object.`); check(base[k], v, path + k + '.'); } else if (!sameShape(base[k], v)) throw err(`Identity setting "${path}${k}" has the wrong type.`); } }
const merge = (a, b) => { const o = clone(a); for (const [k, v] of Object.entries(b || {})) o[k] = v && typeof v === 'object' && !Array.isArray(v) && o[k] && typeof o[k] === 'object' && !Array.isArray(o[k]) ? merge(o[k], v) : clone(v); return o; };
const unit = (v, n) => { if (!(typeof v === 'number' && v >= 0 && v <= 1)) throw err(`${n} must be a number between 0 and 1.`); };
function resolveIdentityConfig(overrides) {
  const o = overrides || {}; for (const k of Object.keys(o)) if (k === 'version') throw err('The identity config version cannot be overridden.');
  check(DEFAULT_IDENTITY_CONFIG, o, ''); const c = merge(DEFAULT_IDENTITY_CONFIG, o); const n = c.name;
  unit(n.compatible_at_or_above, 'name.compatible_at_or_above'); unit(n.different_below, 'name.different_below'); unit(n.token_overlap_guard.applies_below, 'name.token_overlap_guard.applies_below'); unit(n.token_overlap_guard.max_jaccard, 'name.token_overlap_guard.max_jaccard'); unit(c.material.description_compatible_at_or_above, 'material.description_compatible_at_or_above'); unit(c.item_conflicts.description_compatible_at_or_above, 'item_conflicts.description_compatible_at_or_above');
  if (n.different_below > n.compatible_at_or_above) throw err('name.different_below must not exceed name.compatible_at_or_above.');
  for (const [k, v] of Object.entries(c.weights)) unit(v, 'weights.' + k);
  if (!(Number.isInteger(c.blocking.max_block_size) && c.blocking.max_block_size >= 2) || !(Number.isInteger(c.blocking.name_block_max) && c.blocking.name_block_max >= 2)) throw err('blocking sizes must be integers >= 2.');
  if (!(Number.isInteger(c.fuzzy.min_strong_signals) && c.fuzzy.min_strong_signals >= 1 && c.fuzzy.min_strong_signals <= 3)) throw err('fuzzy.min_strong_signals must be 1-3.');
  if (!['flag_all', 'flag_none'].includes(c.item_conflicts.on_tie)) throw err("item_conflicts.on_tie must be 'flag_all' or 'flag_none'.");
  for (const [k, v] of Object.entries(c.dataset_types)) for (const t of v) if (!['master_entity', 'master_material', 'transaction', 'mixed_unknown'].includes(t)) throw err(`dataset_types.${k}: unknown dataset type "${t}".`);
  return c;
}
const hashIdentityConfig = c => hashConfig(c);
module.exports = { IDENTITY_ENGINE_VERSION, IDENTITY_CONFIG_VERSION, DEFAULT_IDENTITY_CONFIG, resolveIdentityConfig, hashIdentityConfig };
