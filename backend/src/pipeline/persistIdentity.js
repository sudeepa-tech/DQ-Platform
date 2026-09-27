'use strict';
/*
 * Persist S5 identity output (entity matches/candidates/clusters, material candidates/groups, transaction candidates, conflicts)
 * into entity_clusters / entity_cluster_members / match_pairs / match_evidence / conflict_groups / conflict_group_members.
 *
 * Distinguishes what S5 already distinguishes (S6 charter #10): exact_business_duplicate, normalized_duplicate, entity_match
 * (incl. identity_match_vendor_code_variant), attribute_variant, audit_date_variant, fuzzy_candidate, material_match,
 * transaction_duplicate, ambiguous_entity -- never a single "exact duplicate" label for everything.
 * A candidate (fuzzy / material / transaction / hard-id-unknown / ambiguous) is persisted with confidence = NULL and
 * is_scored = 0 until a human decision promotes it; this mirrors S5's own in-memory rule, now durable.
 */
const crypto = require('crypto');
const uuid = () => crypto.randomUUID();

const STRENGTH_TO_EVIDENCE_CLASS = { hard: 'hard_agree', strong: 'strong_support', supporting: 'weak_support', observation: 'neutral', conflict: 'hard_conflict' };
const EQUAL_TYPES = new Set(['legal_id_agree', 'vendor_code_agree', 'name_equal', 'phone_equal', 'email_equal', 'address_equal', 'uom_equal', 'category_equal', 'material_exact_description', 'material_exact_description_ignoring_spaces', 'reference_equal', 'amount_equal', 'date_equal', 'vendor_equal']);
const DIFFER_TYPES = new Set(['legal_id_conflict', 'vendor_code_differs', 'name_different', 'uom_differs', 'category_differs']);
function relationOf(e) {
  if (EQUAL_TYPES.has(e.type)) return e.type === 'material_exact_description_ignoring_spaces' ? 'equal_normalized' : (e.normalized && Array.isArray(e.normalized) && e.normalized[0] !== e.normalized[1] ? 'equal_normalized' : 'equal');
  if (DIFFER_TYPES.has(e.type)) return 'different';
  if (e.type === 'name_compatible' || e.type === 'material_near_description') return 'similar';
  return 'not_comparable';
}
const val = v => (v === undefined || v === null) ? null : (typeof v === 'object' ? JSON.stringify(v) : String(v));
function insEvidence(db, ins, runId, pairId, evList) {
  let n = 0;
  for (const e of evList || []) {
    const [va, vb] = Array.isArray(e.values) ? e.values : [e.values, undefined];
    const [na, nb] = Array.isArray(e.normalized) ? e.normalized : [e.normalized, e.normalized];
    ins.run(uuid(), runId, pairId, e.role || e.type, (e.fields || [])[0] || null, (e.fields || [])[1] || null, val(va), val(vb), val(na), val(nb),
      relationOf(e), typeof e.similarity === 'number' ? e.similarity : null, STRENGTH_TO_EVIDENCE_CLASS[e.strength] || 'neutral', null, e.type);
    n++;
  }
  return n;
}
const REVIEW_STATUS = s => ({ auto_accepted: 'not_required', needs_review: 'pending', confirmed: 'confirmed', rejected: 'rejected', candidate_needs_review: 'pending', confirmed_by_human: 'confirmed' }[s] || 'pending');
const PAIR_CLASS_FROM_DUPTYPE = { exact_business_duplicate: 'exact_business_duplicate', normalized_duplicate: 'normalized_duplicate', audit_date_variant: 'audit_date_variant', attribute_variant: 'attribute_variant', fuzzy_name_variant: 'attribute_variant' };

function persistEntityIdentity(db, { runId, entity, recordIdOf, insCluster, insMember, insPair, insEv }) {
  if (!entity) return { clusters: 0, pairs: 0 };
  const clusterDbId = new Map(); let clusters = 0, pairs = 0;
  for (const c of entity.clusters) {
    const id = uuid(); clusterDbId.set(c.id, id);
    insCluster.run(id, runId, 'entity', null, c.members.length, c.confidence, JSON.stringify(c.factors), JSON.stringify([]), c.exact_repeat ? 1 : 0,
      'entity_match', c.match_subtypes[0] || null, JSON.stringify({ dup_types: c.dup_types, s5_cluster_id: c.id }), null, c.status === 'confirmed' ? 'confirmed' : (c.review_required ? 'pending' : 'not_required'));
    for (const m of c.members) { const rid = recordIdOf.get(m.row_number); if (rid) insMember.run(uuid(), id, rid); }
    clusters++;
  }
  const persistPair = (p, { decision, isScored, extraClass }) => {
    const a = recordIdOf.get(p.a.row_number), b = recordIdOf.get(p.b.row_number); if (!a || !b) return;
    const id = uuid(); const dupType = p.dup_type;
    const pairClass = extraClass || (p.match_subtype === 'identity_match_vendor_code_variant' ? 'entity_match' : p.candidate_kind === 'fuzzy_entity' ? 'fuzzy_candidate' : p.candidate_kind === 'hard_id_name_unknown' ? 'entity_match' : (dupType && PAIR_CLASS_FROM_DUPTYPE[dupType]) || (p.class === 'ambiguous' ? 'ambiguous_entity' : 'entity_match'));
    const subtype = p.match_subtype || p.candidate_kind || dupType || null;
    insPair.run(id, runId, a, b, p.class === 'match' ? 'multi_field' : 'fuzzy', p.name_similarity, p.confidence, JSON.stringify(p.evidence.map(e => e.type)), JSON.stringify(p.counter_evidence.map(e => e.type)),
      p.class === 'match' ? clusterDbId.get(findClusterOf(entity, p)) || null : null, pairClass, subtype, decision, p.name_relation ? `name relation: ${p.name_relation}` : null, REVIEW_STATUS(p.status), null, null, null, isScored ? 1 : 0);
    insEv(db, insEv._stmt, runId, id, [...p.evidence, ...p.counter_evidence]); pairs++;
  };
  for (const p of entity.matches) persistPair(p, { decision: p.status === 'confirmed' ? 'same_entity' : 'same_entity', isScored: true });
  for (const p of entity.candidates) persistPair(p, { decision: 'candidate', isScored: false });
  for (const p of entity.ambiguous) persistPair(p, { decision: 'ambiguous', isScored: false, extraClass: 'ambiguous_entity' });
  return { clusters, pairs };
}
function findClusterOf(entity, pair) { for (const c of entity.clusters) if (c.pair_ids.includes(pair.id)) return c.id; return null; }

function persistMaterialIdentity(db, { runId, material, recordIdOf, insCluster, insMember, insPair, insEv }) {
  if (!material) return { clusters: 0, pairs: 0 };
  let clusters = 0, pairs = 0; const byPairId = new Map();
  for (const g of material.groups) {
    const id = uuid(); insCluster.run(id, runId, 'item', null, g.members.length, null, JSON.stringify([]), JSON.stringify([]), 0, 'material_match', null, JSON.stringify({ s5_group_id: g.id }), null, 'pending');
    for (const m of g.members) { const rid = recordIdOf.get(m.row_number); if (rid) insMember.run(uuid(), id, rid); }
    clusters++;
  }
  for (const c of material.candidates) {
    const a = recordIdOf.get(c.a.row_number), b = recordIdOf.get(c.b.row_number); if (!a || !b) continue;
    const id = uuid();
    insPair.run(id, runId, a, b, 'semantic', c.evidence[0] && c.evidence[0].similarity, null, JSON.stringify(c.evidence.map(e => e.type)), JSON.stringify(c.counter_evidence.map(e => e.type)),
      null, 'material_match', c.candidate_kind, 'candidate', null, 'pending', null, null, null, 0);
    insEv(db, insEv._stmt, runId, id, [...c.evidence, ...c.counter_evidence]); pairs++;
  }
  return { clusters, pairs };
}
function persistTransactionIdentity(db, { runId, transaction, recordIdOf, insPair, insEv }) {
  if (!transaction) return { pairs: 0 };
  let pairs = 0;
  for (const c of transaction.candidates) {
    const a = recordIdOf.get(c.a.row_number), b = recordIdOf.get(c.b.row_number); if (!a || !b) continue;
    const id = uuid();
    insPair.run(id, runId, a, b, 'multi_field', null, null, JSON.stringify(c.evidence.map(e => e.type)), JSON.stringify([]), null, 'transaction_duplicate', null, 'candidate', null, 'pending', null, null, null, 0);
    insEv(db, insEv._stmt, runId, id, c.evidence); pairs++;
  }
  return { pairs };
}
function conflictSeverity(kind) { return kind === 'item' ? 'medium' : 'high'; }
function persistConflicts(db, { runId, conflicts, recordIdOf, insGroup, insGroupMember }) {
  let groups = 0;
  for (const c of conflicts) {
    const members = c.members.map(m => recordIdOf.get(m.row_number)).filter(Boolean); if (members.length < 2) continue;
    const memberSetHash = crypto.createHash('sha256').update([...members].sort().join(',')).digest('hex');
    const id = uuid();
    try {
      insGroup.run(id, runId, c.type, conflictSeverity(c.kind), c.field || null, c.subject, memberSetHash, members.length,
        JSON.stringify(c.kind === 'entity' ? c.evidence_paths : c.classes.map(k => ({ description: k.description, count: k.count, majority: k.majority }))),
        `${c.type.replace(/_/g, ' ')} on ${c.subject}`);
    } catch (e) { if (/UNIQUE/.test(e.message)) continue; throw e; }
    if (c.kind === 'item') { const min = new Set((c.members || []).map(m => m.row_number));
      for (const cl of c.classes) for (const m of cl.records) { const rid = recordIdOf.get(m.row_number); if (rid) insGroupMember.run(uuid(), runId, id, rid, cl.majority ? 'majority' : (min.has(m.row_number) ? 'minority' : 'member'), null); }
    } else { for (const m of c.members) { const rid = recordIdOf.get(m.row_number); if (rid) insGroupMember.run(uuid(), runId, id, rid, 'member', null); } }
    groups++;
  }
  return { groups };
}

function persistIdentityResult(db, { runId, identity, recordIdOf }) {
  const insCluster = db.prepare(`INSERT INTO entity_clusters (id, run_id, cluster_kind, representative_name, record_count, confidence, matching_factors_json, conflicts_json, is_exact_repeat, match_class, match_subtype, composition_json, decision_reason, review_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insMember = db.prepare(`INSERT INTO entity_cluster_members (id, cluster_id, record_id) VALUES (?,?,?)`);
  const insPair = db.prepare(`INSERT INTO match_pairs (id, run_id, record_a_id, record_b_id, match_type, similarity_score, confidence, matching_factors_json, conflicting_factors_json, cluster_id, pair_class, pair_subtype, decision, reason_text, review_status, reviewed_by, reviewed_at, review_note, is_scored) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insEvStmt = db.prepare(`INSERT INTO match_evidence (id, run_id, match_pair_id, field_role, column_a, column_b, value_a_raw, value_b_raw, value_a_normalized, value_b_normalized, relation, similarity, evidence_class, weight, explanation) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insGroup = db.prepare(`INSERT INTO conflict_groups (id, run_id, conflict_type, severity, subject_role, subject_value, member_set_hash, member_count, fields_json, explanation) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const insGroupMember = db.prepare(`INSERT INTO conflict_group_members (id, run_id, conflict_group_id, record_id, member_role, values_json) VALUES (?,?,?,?,?,?)`);
  const insEv = (db_, _stmt, runId_, pairId, list) => insEvidence(db, insEvStmt, runId_, pairId, list); insEv._stmt = insEvStmt;

  const e = persistEntityIdentity(db, { runId, entity: identity.entity, recordIdOf, insCluster, insMember, insPair, insEv });
  const m = persistMaterialIdentity(db, { runId, material: identity.material, recordIdOf, insCluster, insMember, insPair, insEv });
  const t = persistTransactionIdentity(db, { runId, transaction: identity.transaction, recordIdOf, insPair, insEv });
  const c = persistConflicts(db, { runId, conflicts: identity.conflicts, recordIdOf, insGroup, insGroupMember });
  return { clusters: e.clusters + m.clusters, pairs: e.pairs + m.pairs + t.pairs, conflictGroups: c.groups };
}
module.exports = { persistIdentityResult };
