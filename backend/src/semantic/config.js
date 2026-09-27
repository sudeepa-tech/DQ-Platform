'use strict';
/*
 * Versioned semantic configuration. EVERY threshold, weight and policy of the semantic layer lives here (not in the database and not scattered in code).
 * A run's configuration snapshot embeds this object and its hash, so a result can always be tied to the exact policy that produced it.
 */
const crypto = require('crypto');
const SEMANTIC_ENGINE_VERSION = 'semantic-1.0.0';
const deepFreeze = o => { for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v); return Object.freeze(o); };
const DEFAULT_SEMANTIC_CONFIG = deepFreeze({
  version: 'semantic-config-1.1.0',
  confidence_tiers: { high: 0.85, medium: 0.6 },
  min_assign: 0.45,                    // below this the role is `unknown` (alternatives are kept)
  unknown_floor: 0.3,
  ambiguity_margin: 0.12,              // top-2 closer than this -> review
  ambiguity_alt_min: 0.4,              // ...if the runner-up is at least this strong
  corroboration: { min_header: 0.7, min_fit: 0.9, bonus: 0.1, max: 0.95 },   // header AND content agree
  header_content_veto_fit: 0.2,        // header says X but content fits X below this -> conflict
  high_risk_min_fit: 0.5,              // high-risk roles need content that fits at least this well
  empty_column: { header_factor: 0.6, confidence_cap: 0.6, high_risk_min_header: 0.9 },
  content_only_cap: 0.8,               // a role inferred from content alone can never exceed this
  auto_accept_min_tier: 'high',
  run_settings_defaults: { stale_threshold_years: 4, reference_date_mode: 'run_date' },   // application defaults (S1 decision 3); a run configuration may override them
  dataset_type: {
    role_weights: {
      master_entity: { legal_id: 3, name: 3, entity_id: 3, entity_type: 1, address: 1.5, city: 1, state: 1, country: 0.5, postal_code: 1, phone: 1.5, email: 1.5 },
      master_material: { material_id: 3, description: 2, uom: 2, category: 1, measure: 1, quantity: 0.5, unit_price: 0.5 },
      transaction: { doc_id: 3, doc_ref: 2, line_item: 2, posting_date: 2, document_date: 2, amount: 2, quantity: 1, unit_price: 1, tax_rate: 1, currency: 1 }
    },
    min_role_confidence: 0.5,          // roles below this do not count as evidence
    min_evidence: 3,                   // total weighted evidence below this -> mixed_unknown
    min_share: 0.5, min_margin: 0.15,  // winner must own this share and lead by this margin
    needs_review_below: 0.6
  },
  requiredness: {
    heuristic_expected_min_populated: 0.95,     // a HEURISTIC for `expected` only; it can never produce `required`
    rule_defaults: {                            // source = 'rule'; versioned policy, editable per run; applies to the PRIMARY column of a role only
      master_entity: { name: 'required', entity_id: 'required', legal_id: 'expected', email: 'expected', phone: 'expected', address: 'expected', city: 'expected', postal_code: 'expected', creation_date: 'expected' },
      master_material: { material_id: 'required', description: 'required', uom: 'required' },   // S5 (product owner, S4 approval decision 4): only the explicitly approved defaults; anything else is expected only when the user / configuration confirms it
      transaction: { doc_id: 'required' },
      mixed_unknown: {}
    },
    severity_candidates: { required: 'high', expected: 'low', optional: 'none' }
  }
});
const canonical = v => (Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']' : v && typeof v === 'object' ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}' : JSON.stringify(v === undefined ? null : v));
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const hashConfig = cfg => sha256(canonical(cfg));
const deepMerge = (a, b) => { if (!b) return a; const o = { ...a }; for (const k of Object.keys(b)) o[k] = a[k] && typeof a[k] === 'object' && !Array.isArray(a[k]) && typeof b[k] === 'object' ? deepMerge(a[k], b[k]) : b[k]; return o; };
const resolveConfig = overrides => deepMerge(DEFAULT_SEMANTIC_CONFIG, overrides);
const tierOf = (conf, cfg) => (conf >= cfg.confidence_tiers.high ? 'high' : conf >= cfg.confidence_tiers.medium ? 'medium' : 'low');
module.exports = { SEMANTIC_ENGINE_VERSION, DEFAULT_SEMANTIC_CONFIG, resolveConfig, hashConfig, canonical, sha256, tierOf };
