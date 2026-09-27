'use strict';
/*
 * RULE CONFIGURATION (S4): versioned, hashed, validated. Per-rule enable / severity / parameters plus engine policies.
 * The two RUN settings (reference date, stale threshold in years) are not here: they belong to the run configuration snapshot (S3 settings) and are passed to the engine explicitly.
 * Overrides are validated strictly (unknown rule / key / wrong type = error), so a typo can never silently disable a rule.
 */
const { RULES, SEVERITIES } = require('./catalog'); const { hashConfig, canonical } = require('../semantic/config');
const RULE_CONFIG_VERSION = 'rule-config-1.0.0';
const deepFreeze = o => { for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v); return Object.freeze(o); };
const err = m => Object.assign(new Error(m), { status: 400 });
const DEFAULT_RULE_CONFIG = deepFreeze({
  version: RULE_CONFIG_VERSION,
  rules: Object.fromEntries(Object.entries(RULES).map(([id, r]) => [id, { enabled: r.default_enabled, severity: null, params: JSON.parse(JSON.stringify(r.default_params)) }])),
  policies: {
    completeness: { severity: { required: 'high', expected: 'low' }, column_empty_severity: { required: 'critical', expected: 'medium' } },
    systematic_failure: { min_populated: 20, min_fail_ratio: 0.9 },
    freshness: { roles: ['modification_date', 'creation_date'], creation_fallback: 'when_modification_column_empty' },   // creation_fallback: 'never' | 'when_modification_column_empty' | 'always'
    temporal: { granularity: 'day', future_roles: ['creation_date', 'modification_date', 'posting_date', 'document_date'] },   // granularity: 'day' | 'instant'
    uniqueness: { unique_roles_by_dataset_type: { master_entity: [], master_material: ['material_id'], transaction: ['doc_id'], mixed_unknown: [] }, always_unique_roles: ['row_id'], composite_with_line_item: true },
    date_roles: ['creation_date', 'modification_date', 'effective_date', 'posting_date', 'document_date']
  }
});
const clone = o => JSON.parse(JSON.stringify(o));
const sameShape = (a, b) => (Array.isArray(a) ? Array.isArray(b) : typeof a === typeof b) && (a === null) === (b === null);
function checkPolicies(base, over, path) {
  for (const [k, v] of Object.entries(over)) {
    if (!(k in base)) throw err(`Unknown policy "${path}${k}".`);
    if (base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) { if (!v || typeof v !== 'object' || Array.isArray(v)) throw err(`Policy "${path}${k}" must be an object.`); checkPolicies(base[k], v, path + k + '.'); }
    else if (!sameShape(base[k], v)) throw err(`Policy "${path}${k}" has the wrong type.`);
  }
}
const merge = (a, b) => { const o = clone(a); for (const [k, v] of Object.entries(b || {})) o[k] = v && typeof v === 'object' && !Array.isArray(v) && o[k] && typeof o[k] === 'object' && !Array.isArray(o[k]) ? merge(o[k], v) : clone(v); return o; };
/** overrides: { rules: { '<rule_id>': { enabled?, severity?, params? } }, policies: { ... } }  ->  effective, validated config */
function resolveRuleConfig(overrides) {
  const out = clone(DEFAULT_RULE_CONFIG); const o = overrides || {};
  for (const k of Object.keys(o)) if (!['rules', 'policies'].includes(k)) throw err(`Unknown configuration section "${k}" (allowed: rules, policies).`);
  for (const [id, s] of Object.entries(o.rules || {})) {
    if (!RULES[id]) throw err(`Unknown rule "${id}".`);
    for (const k of Object.keys(s || {})) if (!['enabled', 'severity', 'params'].includes(k)) throw err(`Rule "${id}": unknown setting "${k}".`);
    if (s.enabled !== undefined) { if (typeof s.enabled !== 'boolean') throw err(`Rule "${id}": enabled must be true or false.`); out.rules[id].enabled = s.enabled; }
    if (s.severity !== undefined) { if (s.severity !== null && !SEVERITIES.includes(s.severity)) throw err(`Rule "${id}": severity must be one of ${SEVERITIES.join(', ')}.`); out.rules[id].severity = s.severity; }
    if (s.params !== undefined) { const base = out.rules[id].params; for (const [pk, pv] of Object.entries(s.params || {})) { if (!(pk in base)) throw err(`Rule "${id}": unknown parameter "${pk}".`); if (!sameShape(base[pk], pv)) throw err(`Rule "${id}": parameter "${pk}" has the wrong type.`); base[pk] = clone(pv); } }
  }
  if (o.policies) { checkPolicies(DEFAULT_RULE_CONFIG.policies, o.policies, ''); out.policies = merge(out.policies, o.policies); }
  const p = out.policies;
  if (!(p.systematic_failure.min_fail_ratio > 0 && p.systematic_failure.min_fail_ratio <= 1)) throw err('systematic_failure.min_fail_ratio must be in (0, 1].');
  if (!(Number.isInteger(p.systematic_failure.min_populated) && p.systematic_failure.min_populated >= 1)) throw err('systematic_failure.min_populated must be a positive integer.');
  if (!['day', 'instant'].includes(p.temporal.granularity)) throw err("temporal.granularity must be 'day' or 'instant'.");
  if (!['never', 'when_modification_column_empty', 'always'].includes(p.freshness.creation_fallback)) throw err('freshness.creation_fallback is not a known policy.');
  for (const lvl of ['required', 'expected']) for (const m of [p.completeness.severity, p.completeness.column_empty_severity]) if (!SEVERITIES.includes(m[lvl])) throw err('completeness severities must be one of ' + SEVERITIES.join(', ') + '.');
  return out;
}
const hashRuleConfig = cfg => hashConfig(cfg);
/** the deviations from the default, as config_rule_settings rows (rule-level control is stored per configuration) */
function ruleSettingRows(effective) {
  const rows = [];
  for (const [id, s] of Object.entries(effective.rules)) { const d = DEFAULT_RULE_CONFIG.rules[id]; if (s.enabled !== d.enabled || s.severity !== d.severity || canonical(s.params) !== canonical(d.params)) rows.push({ rule_id: id, enabled: s.enabled ? 1 : 0, severity_override: s.severity, params_json: canonical(s.params) !== canonical(d.params) ? JSON.stringify(s.params) : null }); }
  return rows;
}
module.exports = { RULE_CONFIG_VERSION, DEFAULT_RULE_CONFIG, resolveRuleConfig, hashRuleConfig, ruleSettingRows };
