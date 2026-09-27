'use strict';
/*
 * THE IDENTITY ENGINE (S5): confirmed semantic mapping + canonical rows + validity findings (S4) + identity config -> matches, candidates, clusters, conflicts.
 * Pure and deterministic: no clock, no database, no file names. Candidates come from inverted-index BLOCKING only (never all-pairs).
 *   accepted matches   hard-id agreement with a compatible name (or a second hard / contact signal when a name is missing); never a fuzzy name alone
 *   candidates         REVIEW ONLY: no cluster, no score (confidence null, scoring_eligible false) until a human confirms
 *   clusters           constrained union-find: never two different valid legal ids, never a cannot-link pair, never incompatible numeric name signatures
 *   conflicts          one cause = one group
 * Human decisions ({ a, b, decision: 'confirm' | 'reject' } by row number) feed back into clustering.
 */
const crypto = require('crypto'); const C = require('./config'); const E = require('./entity'); const CF = require('./conflicts'); const M = require('./material'); const X = require('./transaction'); const T = require('./text');
const { hashConfig } = require('../semantic/config');
const LABEL = { legal_id_agree: 'Same legal identifier (GSTIN / PAN)', vendor_code_agree: 'Same vendor code', name_equal: 'Same name (normalized)', name_compatible: 'Compatible name', phone_equal: 'Same phone', email_equal: 'Same e-mail', address_equal: 'Same postal code and address' };
const fid = (...p) => crypto.createHash('sha256').update(p.join('|')).digest('hex').slice(0, 16); const ref = CF.ref;
const pk = (a, b) => (a < b ? a + '|' + b : b + '|' + a);

function runIdentity(input) {
  const cfg = input.identityConfig || C.resolveIdentityConfig(); const datasetType = input.datasetType || 'mixed_unknown'; const columns = input.columns; const rowsOf = () => (typeof input.rows === 'function' ? input.rows() : input.rows);
  const invalid = new Set(); for (const f of input.ruleFindings || []) if (f.category === 'validity' && f.scope === 'record' && f.header_key) invalid.add(f.row_number + '|' + f.header_key);
  const roles = E.roleColumns(columns); const cap = E.entityCapability(roles); const on = k => cfg.dataset_types[k].includes(datasetType);
  const capabilities = {
    entity_matching: on('entity_matching') ? (cap.possible ? { ran: true, hard_evidence_roles: cap.hard, strong_evidence_roles: cap.strong } : { ran: false, reason: 'needs a name column plus at least one identity column (legal id, entity id, phone, e-mail, postal code, address)' }) : { ran: false, reason: `not applied to a ${datasetType} dataset` },
    item_conflicts: on('item_conflicts') ? (E.hasRoles(roles, 'material_id', 'description') ? { ran: true } : { ran: false, reason: 'needs material-id and description columns' }) : { ran: false, reason: `not applied to a ${datasetType} dataset` },
    material_matching: on('material_matching') ? (E.hasRoles(roles, 'description') ? { ran: true } : { ran: false, reason: 'needs a description column' }) : { ran: false, reason: `not applied to a ${datasetType} dataset` },
    transaction_matching: on('transaction_matching') ? (E.hasRoles(roles, 'doc_ref') ? { ran: true } : { ran: false, reason: 'needs a document-reference column' }) : { ran: false, reason: `not applied to a ${datasetType} dataset` } };
  const doE = capabilities.entity_matching.ran, doI = capabilities.item_conflicts.ran, doM = capabilities.material_matching.ran, doT = capabilities.transaction_matching.ran;
  const recs = [], items = [], mats = [], txns = []; let n = 0;
  for (const row of rowsOf()) {
    n++;
    if (doE) recs.push(E.entityRecord(row, recs.length, roles, cfg, invalid));
    if (doI) { const cc = roles.material_id[0], dc = roles.description[0]; const code = E.rawStr(row, cc), d = E.rawStr(row, dc); items.push({ rowNumber: row.rowNumber, sheetRow: row.sheetRow === undefined ? null : row.sheetRow, key: (roles.row_id || [])[0] ? E.rawStr(row, roles.row_id[0]) : null, code: code ? code.toUpperCase() : null, nd: d ? T.normalizeDescription(d, cfg.name) : '', codeHeader: cc.header_raw, descHeader: dc.header_raw }); }
    if (doM) mats.push(M.materialRecord(row, mats.length, roles, cfg)); if (doT) txns.push(X.transactionRecord(row, txns.length, roles));
  }
  const out = { entity: null, conflicts: [], item_conflicts: [], material: null, transaction: null };
  // ---------------- entity identity
  if (doE) {
    const { pairs, skipped } = E.candidatePairs(recs, r => E.blockKeys(r, cfg), k => (k[0] === 'n' || k[0] === 'r' ? cfg.blocking.name_block_max : cfg.blocking.max_block_size));
    const cls = pairs.map(c => ({ ...E.classifyPair(recs[c.i], recs[c.j], cfg, cfg.weights), i: c.i, j: c.j, keys: [...c.keys].sort() })); const dec = new Map(); for (const d of input.decisions || []) dec.set(pk(d.a, d.b), d.decision);
    const accepted = [], cannot = [], conflictPairs = [], candidates = [], ambiguous = [], observations = []; let nameOnly = 0, none = 0;
    for (const p of cls) {
      const d = dec.get(pk(recs[p.i].rowNumber, recs[p.j].rowNumber));
      if (p.class === 'conflict') { conflictPairs.push(p); cannot.push([p.i, p.j]); continue; }
      if (p.class === 'match') { if (d === 'reject') { p.status = 'rejected'; p.class = 'rejected'; cannot.push([p.i, p.j]); } else { if (d === 'confirm') p.status = 'confirmed'; accepted.push(p); } continue; }
      if (p.class === 'candidate' || p.class === 'ambiguous') { if (d === 'confirm') { p.class = 'match'; p.match_class = 'confirmed_' + (p.candidate_kind || 'ambiguous'); p.match_subtype = null; p.status = 'confirmed'; p.confidence = E.confidenceFromEvidence(p.evidence, cfg.weights); p.strength = 0; accepted.push(p); } else if (d === 'reject') { p.status = 'rejected'; cannot.push([p.i, p.j]); (p.class === 'candidate' ? candidates : ambiguous).push(p); } else (p.class === 'candidate' ? candidates : ambiguous).push(p); continue; }
      if (p.class === 'observation') { observations.push(p); continue; } if (p.keys.every(k => k === 'n' || k === 'r')) nameOnly++; else none++;
    }
    accepted.sort((a, b) => b.strength - a.strength || b.confidence - a.confidence || a.i - b.i || a.j - b.j);
    const cl = E.cluster(recs, accepted, cannot); const inCl = new Set(cl.components.flat()); const compOf = new Map(); cl.components.forEach((m, k) => m.forEach(i => compOf.set(i, k)));
    // second pass: the raw business values of clustered records, for exact per-field differences (no raw data is retained for the other records)
    const need = new Set(); for (const p of accepted) if (compOf.get(p.i) !== undefined && compOf.get(p.i) === compOf.get(p.j)) { need.add(recs[p.i].rowNumber); need.add(recs[p.j].rowNumber); }
    const diffCols = columns.filter(c => c.include_in_analysis !== false && c.include_in_analysis !== 0 && c.role !== 'row_id'); const byRow = new Map(recs.map(r => [r.rowNumber, r]));
    if (need.size) for (const row of rowsOf()) if (need.has(row.rowNumber)) byRow.get(row.rowNumber).vals = diffCols.map(c => E.rawStr(row, c));
    const nameKeys = new Set((roles.name || []).map(c => c.header_key)), dateKeys = new Set([...(roles.creation_date || []), ...(roles.modification_date || [])].map(c => c.header_key));
    const outPair = p => { const x = recs[p.i], y = recs[p.j]; const o = { id: fid('pair', x.rowNumber, y.rowNumber), a: ref(x), b: ref(y), class: p.class, match_class: p.match_class || null, match_subtype: p.match_subtype || null, candidate_kind: p.candidate_kind || null, status: p.status || null, name_relation: p.name_relation, name_similarity: p.name_similarity,
      confidence: p.class === 'match' ? p.confidence : null, scoring_eligible: p.class === 'match', review_required: p.status === 'needs_review' || p.class === 'candidate' || p.class === 'ambiguous', evidence: p.evidence, counter_evidence: p.counter_evidence, found_by_blocks: p.keys, diff_fields: null, dup_type: null, decision: { state: dec.get(pk(x.rowNumber, y.rowNumber)) === 'confirm' ? 'confirmed' : dec.get(pk(x.rowNumber, y.rowNumber)) === 'reject' ? 'rejected' : p.class === 'match' && p.status === 'auto_accepted' ? 'auto' : 'pending_review' } };
      if (p.class === 'match' && x.vals && y.vals) { const d = []; diffCols.forEach((c, k) => { const u = x.vals[k], v = y.vals[k]; if (u === null && v === null) return; if ((u === null) !== (v === null)) d.push({ field: c.header_raw, header_key: c.header_key, kind: 'null_gap' }); else if (u !== v) d.push({ field: c.header_raw, header_key: c.header_key, kind: 'value' }); }); o.diff_fields = d; const keys = new Set(d.map(f => f.header_key));
        o.dup_type = !d.length ? 'exact_business_duplicate' : ([...keys].every(k => nameKeys.has(k)) && x.nn === y.nn) ? 'normalized_duplicate' : [...keys].every(k => dateKeys.has(k)) ? 'audit_date_variant' : p.name_relation === 'sim' ? 'fuzzy_name_variant' : 'attribute_variant'; } return o; };
    const matchOut = accepted.filter(p => compOf.get(p.i) !== undefined && compOf.get(p.i) === compOf.get(p.j)).map(outPair).sort((a, b) => a.a.row_number - b.a.row_number || a.b.row_number - b.b.row_number);
    const clusters = cl.components.map((m, k) => { const ps = matchOut.filter(p => compOf.get(byRow.get(p.a.row_number).i) === k); const facs = new Set(); for (const p of ps) for (const e of p.evidence) if (LABEL[e.type]) facs.add(LABEL[e.type]);
      const conf = ps.length ? ps.reduce((m, p) => Math.min(m, p.confidence), Infinity) : null; const dt = {}; for (const p of ps) if (p.dup_type) dt[p.dup_type] = (dt[p.dup_type] || 0) + 1;
      return { id: fid('cluster', recs[m[0]].rowNumber), members: m.map(i => ref(recs[i])), pair_ids: ps.map(p => p.id), confidence: conf, review_required: ps.some(p => p.review_required), match_subtypes: [...new Set(ps.map(p => p.match_subtype).filter(Boolean))], dup_types: dt, exact_repeat: ps.length > 0 && ps.every(p => p.dup_type === 'exact_business_duplicate'), factors: [...facs].sort(), conflicts: [], scoring_eligible: true, status: ps.some(p => p.decision.state === 'confirmed') ? 'confirmed' : ps.some(p => p.review_required) ? 'needs_review' : 'auto_accepted' }; });
    out.entity = { records: recs.length, capability: capabilities.entity_matching, matches: matchOut, candidates: candidates.map(outPair).sort((a, b) => a.a.row_number - b.a.row_number || a.b.row_number - b.b.row_number), ambiguous: ambiguous.map(outPair).sort((a, b) => a.a.row_number - b.a.row_number || a.b.row_number - b.b.row_number),
      clusters, refused_unions: cl.refused.map(r => ({ a: ref(recs[r.a]), b: ref(recs[r.b]), reason: r.reason })), observations: { shared_contact_pairs: observations.length, examples: observations.slice(0, 200).map(p => ({ a: ref(recs[p.i]), b: ref(recs[p.j]), evidence: p.evidence })) },
      blocking: { candidate_pairs: pairs.length, skipped_blocks: skipped, name_only_pairs_ignored: nameOnly, unclassified_pairs: none } };
    for (const c of CF.groupEntityConflicts(conflictPairs, recs)) out.conflicts.push(c);
  }
  if (doI) { out.item_conflicts = CF.itemDescriptionConflicts(items, cfg); for (const c of out.item_conflicts) out.conflicts.push(c); }
  if (doM) { const { candidates, skipped } = M.materialCandidates(mats, cfg); const par = mats.map((_, i) => i); const f = x => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; }; for (const c of candidates) par[f(c.i)] = f(c.j);
    const comp = new Map(); for (const c of candidates) for (const i of [c.i, c.j]) { const r = f(i); (comp.get(r) || comp.set(r, new Set()).get(r)).add(i); }
    out.material = { records: mats.length, candidates: candidates.map(({ i, j, ...c }) => ({ id: fid('mpair', c.a.row_number, c.b.row_number), ...c })).sort((a, b) => a.a.row_number - b.a.row_number || a.b.row_number - b.b.row_number),
      groups: [...comp.values()].map(s => [...s].sort((a, b) => a - b)).sort((a, b) => a[0] - b[0]).map(m => ({ id: fid('mgroup', mats[m[0]].rowNumber), status: 'candidate_needs_review', scoring_eligible: false, members: m.map(i => ({ ...ref(mats[i]), material_id: mats[i].id })) })), blocking: { skipped_blocks: skipped } }; }
  if (doT) { const { candidates, skipped } = X.transactionCandidates(txns, cfg); out.transaction = { records: txns.length, candidates: candidates.map(({ i, j, ...c }) => ({ id: fid('tpair', c.a.row_number, c.b.row_number), ...c })).sort((a, b) => a.a.row_number - b.a.row_number || a.b.row_number - b.b.row_number), blocking: { skipped_blocks: skipped } }; }
  const summary = { rows: n, capabilities, entity: out.entity && { records: out.entity.records, accepted_pairs: out.entity.matches.length, candidates: out.entity.candidates.length, ambiguous: out.entity.ambiguous.length, clusters: out.entity.clusters.length, clustered_records: out.entity.clusters.reduce((a, c) => a + c.members.length, 0), needs_review_clusters: out.entity.clusters.filter(c => c.review_required).length, refused_unions: out.entity.refused_unions.length, ...out.entity.blocking },
    conflict_groups: out.conflicts.length, conflicts_by_type: out.conflicts.reduce((a, c) => { a[c.type] = (a[c.type] || 0) + 1; return a; }, {}), material_candidates: out.material ? out.material.candidates.length : null, transaction_candidates: out.transaction ? out.transaction.candidates.length : null };
  const provenance = { engine_version: C.IDENTITY_ENGINE_VERSION, identity_config_version: cfg.version, identity_config_hash: C.hashIdentityConfig(cfg), dataset_type: datasetType, decisions_applied: (input.decisions || []).length };
  provenance.results_hash = hashConfig({ p: provenance, e: out.entity && out.entity.clusters.map(c => c.id + c.members.map(m => m.row_number).join(',')), c: out.conflicts.map(c => c.id), m: out.material && out.material.candidates.map(c => c.id), t: out.transaction && out.transaction.candidates.map(c => c.id), i: out.entity && out.entity.candidates.map(c => c.id) });
  return { ...out, summary, provenance };
}
module.exports = { runIdentity, LABEL };
