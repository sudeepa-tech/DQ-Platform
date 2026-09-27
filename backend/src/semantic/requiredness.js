'use strict';
/*
 * REQUIREDNESS  (required | expected | optional). Decisions are data in the run configuration, never hidden logic:
 *   1. a user decision always wins                                        (source 'user')
 *   2. versioned rule default for (dataset type, role), PRIMARY column only (source 'rule')
 *   3. >= 95% populated is a HEURISTIC for `expected` only - it can never produce `required`   (source 'inferred')
 *   4. otherwise optional
 * `missingDisposition` says what a missing value MEANS for the later rule stage (this stage creates no issues):
 *   optional -> never a completeness defect; a required/expected column that is entirely empty -> ONE dataset-level finding, not one per row.
 */
const { REQUIREDNESS } = require('./taxonomy');

function resolveRequiredness(mappings, profiles, datasetType, cfg, overrides = {}) {
  const rc = cfg.requiredness; const defaults = rc.rule_defaults[datasetType] || {};
  const primary = new Map();                                              // role -> index of the primary column
  mappings.forEach((m, i) => { if (m.role === 'unknown' || m.include_in_analysis === 0 || m.include_in_analysis === false) return; const cur = primary.get(m.role);
    const share = j => (profiles[j] && profiles[j].rows ? Math.round(10 * profiles[j].populated / profiles[j].rows) : 0);
    const rank = j => [mappings[j].primary_for_role === true ? 1 : 0, profiles[j] && profiles[j].populated > 0 ? 1 : 0, share(j), mappings[j].confidence, profiles[j] ? profiles[j].populated : 0, -j];
    if (cur === undefined) primary.set(m.role, i); else { const A = rank(i), B = rank(cur); for (let k = 0; k < A.length; k++) { if (A[k] !== B[k]) { if (A[k] > B[k]) primary.set(m.role, i); break; } } } });
  return mappings.map((m, i) => {
    const key = m.header_key; const ov = overrides[key];
    if (ov) { if (!REQUIREDNESS.includes(ov.requiredness)) throw Object.assign(new Error(`requiredness must be one of ${REQUIREDNESS.join(', ')}`), { status: 400 }); return { requiredness: ov.requiredness, source: 'user', reason: ov.note || 'set by the user', confirmed: true }; }
    if (m.role === 'unknown') return { requiredness: 'optional', source: 'inferred', reason: 'role not identified: nothing to require', confirmed: false };
    if (m.include_in_analysis === 0 || m.include_in_analysis === false) return { requiredness: 'optional', source: 'inferred', reason: 'excluded from analysis', confirmed: false };
    const d = defaults[m.role];
    if (d && primary.get(m.role) === i) return { requiredness: d, source: 'rule', reason: `policy ${cfg.version}: ${m.role} is ${d} in a ${datasetType} dataset`, confirmed: false };
    if (d) return { requiredness: 'optional', source: 'rule', reason: `secondary column for ${m.role} (the primary is ${mappings[primary.get(m.role)].header_key})`, confirmed: false };
    const p = profiles[i]; const ratio = p && p.rows ? p.populated / p.rows : 0;
    if (ratio >= rc.heuristic_expected_min_populated) return { requiredness: 'expected', source: 'inferred', reason: `${(ratio * 100).toFixed(0)}% populated (heuristic: expected, never required)`, confirmed: false };
    return { requiredness: 'optional', source: 'inferred', reason: 'no rule or evidence that a value is needed', confirmed: false };
  });
}
/** what a missing value means for the rule stage (this function creates no issues) */
function missingDisposition(requiredness, populated, rows, cfg) {
  const sev = cfg.requiredness.severity_candidates;
  if (requiredness === 'optional' || !REQUIREDNESS.includes(requiredness)) return { scope: 'none', severity_candidate: 'none', reason: 'optional: a missing value is not a completeness defect' };
  if (rows === 0) return { scope: 'none', severity_candidate: 'none', reason: 'no rows' };
  if (populated === 0) return { scope: 'dataset', severity_candidate: sev[requiredness], reason: `${requiredness} column is entirely empty: one dataset-level finding, not one per row` };
  if (populated < rows) return { scope: 'record', severity_candidate: sev[requiredness], reason: `${requiredness} value missing on ${rows - populated} of ${rows} rows` };
  return { scope: 'none', severity_candidate: 'none', reason: 'fully populated' };
}
module.exports = { resolveRequiredness, missingDisposition };
