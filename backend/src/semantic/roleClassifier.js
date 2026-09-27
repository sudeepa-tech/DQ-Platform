'use strict';
/*
 * Semantic ROLE classification. For every physical column:  header evidence  x  content fit  (+ content-only detection for self-identifying content),
 * with vetoes for header/content conflicts, extra scrutiny for high-risk roles, alternatives kept, and review flags instead of silent choices.
 * Pure function of (columns, profiles, config): no I/O, no dataset names, deterministic.
 */
const { ROLES, ROLE_NAMES, familyOf } = require('./taxonomy');
const { headerEvidence } = require('./headerAnalysis');
const { tierOf } = require('./config');

const clamp = x => Math.max(0, Math.min(1, x));
const dateShare = P => P.kinds.date + 0.8 * P.kinds.date_unresolved + 0.6 * P.kinds.date_invalid;
const tx = P => P.text;
const ts = P => P.kinds.text;                                            // share of populated cells that are plain text
const idLike = P => { const t = tx(P); const textPart = t ? ts(P) * Math.max(t.id_shape, t.all_digits) * (t.avg_words > 2 ? 0 : 1) : 0; return clamp(textPart + 0.6 * P.kinds.number); };
const positionNumbers = P => !!(tx(P) && ts(P) >= 0.9 && tx(P).all_digits >= 0.9 && tx(P).avg_len <= 4);   // 10, 20, 30 ... are line positions, not material numbers
const numShare = P => P.kinds.number + (P.kinds.numeric_text || 0);          // real numbers + numeric-looking text (a CSV has no cell types)
const nearConstant = P => P.populated >= 20 && P.distinct <= 2;          // an identifier that never varies is not identifying anything
const lowCard = (P, cap = 50) => P.distinct <= Math.max(cap, 0.05 * P.populated);
const textish = P => ts(P) >= 0.8;

/** how well the column's CONTENT fits each role (0..1). Only called for populated columns. */
const FIT = {
  email: P => (tx(P) ? ts(P) * tx(P).email : 0),
  legal_id: P => { const t = tx(P); if (!t) return 0; const strict = ts(P) * Math.max(t.gstin, t.pan); const loose = (t.len_uniform >= 0.9 && t.avg_len >= 8 && t.avg_len <= 20 && t.id_shape >= 0.9 && P.unique_ratio >= 0.5) ? 0.35 * ts(P) : 0; return clamp(Math.max(strict, loose)); },
  phone: P => { const t = tx(P); const fromText = t ? ts(P) * clamp(t.phone_formatted + t.mobile10) : 0; const fromNum = P.number ? P.kinds.number * P.number.mobile10 : 0; return clamp(fromText + fromNum); },
  postal_code: P => { const t = tx(P); return clamp((t ? ts(P) * t.pin : 0) + (P.number ? P.kinds.number * P.number.pin : 0)); },
  name: P => { const t = tx(P); if (!t || ts(P) < 0.9) return 0; let f = 0.35 * Math.min(1, t.avg_words / 2) + 0.3 * Math.max(t.org_suffix, t.title_case) + 0.1 * (1 - t.has_digit) + 0.25 * (1 - t.all_digits); if (t.id_shape >= 0.9 && t.avg_words < 1.3) f *= 0.3; if (t.avg_len > 60) f *= 0.5; return clamp(f); },
  description: P => { const t = tx(P); if (!t || ts(P) < 0.8) return 0; let f = ts(P) * Math.min(1, Math.max(t.avg_len / 20, t.avg_words / 3)); if (t.id_shape >= 0.9 && t.avg_words < 1.2) f *= 0.2; return clamp(f); },
  address: P => { const t = tx(P); if (!t || ts(P) < 0.8) return 0; let f = 0.5 * t.address_token + 0.25 * t.comma + 0.15 * Math.min(1, t.avg_len / 25) + 0.1 * t.has_digit; if (t.avg_words < 2) f *= 0.4; return clamp(f); },
  city: P => { const t = tx(P); if (!t || ts(P) < 0.8) return 0; return clamp(t.alpha_only * (t.avg_words <= 3 ? 1 : 0.5) * (P.unique_ratio <= 0.7 ? 1 : 0.7) * (1 - t.has_digit)); },
  state: P => { const t = tx(P); if (!t || ts(P) < 0.8) return 0; const g = t.state_name; return g >= 0.6 ? 1 : (t.alpha_only >= 0.9 && P.distinct <= 60 ? 0.4 : 0.15); },
  country: P => { const t = tx(P); if (!t || ts(P) < 0.8) return 0; return t.country >= 0.6 ? 1 : (t.alpha_only >= 0.9 && P.distinct <= 60 ? 0.3 : 0.1); },
  currency: P => { const t = tx(P); if (!t || ts(P) < 0.8) return 0; return t.currency_code >= 0.8 ? 1 : (t.avg_len === 3 && t.len_uniform >= 0.95 && P.distinct <= 30 ? 0.4 : 0.1); },
  uom: P => { const t = tx(P); if (!t || ts(P) < 0.8) return 0; return clamp(0.6 * t.uom_code + 0.4 * (t.avg_len <= 5 && P.distinct <= 100 ? 1 : 0)); },
  quantity: P => (numShare(P) >= 0.9 ? (P.number.non_negative >= 0.9 ? 1 : 0.7) : 0.2 * ts(P)),
  unit_price: P => (numShare(P) >= 0.9 ? (P.number.non_negative >= 0.9 ? 1 : 0.6) : 0.1),
  amount: P => (numShare(P) >= 0.9 ? 1 : 0.1),
  measure: P => (numShare(P) >= 0.9 ? 1 : 0.2),
  tax_rate: P => (numShare(P) >= 0.9 ? (P.number.within_0_100 >= 0.9 ? (P.distinct <= 20 ? 1 : 0.7) : 0.3) : 0.1),
  category: P => (textish(P) ? (lowCard(P) ? 1 : 0.3) : (P.kinds.number >= 0.9 && lowCard(P) ? 0.5 : 0.2)),
  status: P => ((textish(P) || P.kinds.boolean > 0.5) ? (lowCard(P, 20) && (!tx(P) || tx(P).avg_len <= 14) ? 1 : 0.35) : 0.2),
  payment_terms: P => { const t = tx(P); if (!t || ts(P) < 0.8) return 0; return clamp(0.5 * t.has_digit + 0.5 * (lowCard(P, 30) ? 1 : 0)); },
  entity_type: P => { const t = tx(P); if (!t || ts(P) < 0.8) return 0; return t.alpha_only >= 0.9 && lowCard(P, 15) ? 1 : 0.25; },
  material_id: P => clamp(idLike(P) * (nearConstant(P) ? 0.4 : 1) * (positionNumbers(P) ? 0.6 : 1)),   // repeats are fine here: whether they are a defect depends on the dataset type (S4/S5)
  entity_id: P => clamp(idLike(P) * (nearConstant(P) ? 0.4 : 1)),
  doc_id: P => clamp(idLike(P) * (P.unique_ratio >= 0.98 ? 1 : 0.4) * (nearConstant(P) ? 0.5 : 1)),
  doc_ref: P => clamp(idLike(P) * (P.unique_ratio >= 0.98 ? 0.85 : 1) * (nearConstant(P) ? 0.4 : 1)),
  row_id: P => (P.unique_ratio >= 0.99 ? clamp(0.5 * idLike(P) + (P.sequence && P.sequence.step1_share >= 0.9 ? 0.5 : 0.2)) : 0.1),
  line_item: P => { const t = tx(P); const digits = (t && ts(P) * t.all_digits) + (P.kinds.number >= 0.9 && P.number.integers_only ? P.kinds.number : 0); return digits >= 0.9 ? (P.distinct <= Math.max(60, 0.1 * P.populated) ? 1 : 0.3) : 0.1; },
  audit_user: P => (dateShare(P) > 0.05 ? 0 : (textish(P) ? (P.unique_ratio <= 0.6 ? 1 : 0.5) : 0.1)),
  creation_date: P => clamp(dateShare(P)), modification_date: P => clamp(dateShare(P)), effective_date: P => clamp(dateShare(P)), posting_date: P => clamp(dateShare(P)), document_date: P => clamp(dateShare(P)),
  time_of_day: P => clamp(P.kinds.time)
};
/** roles that identify themselves by content alone (used when the header gives no clue, capped by config.content_only_cap) */
const SELF_ID = {
  email: P => (FIT.email(P) >= 0.8 ? 0.9 : 0),
  legal_id: P => (tx(P) && ts(P) * Math.max(tx(P).gstin, tx(P).pan) >= 0.6 ? 0.9 : 0),
  currency: P => (tx(P) && tx(P).currency_code >= 0.9 && P.distinct <= 30 && ts(P) >= 0.9 ? 0.75 : 0),
  state: P => (tx(P) && tx(P).state_name >= 0.7 && ts(P) >= 0.9 ? 0.7 : 0),
  country: P => (tx(P) && tx(P).country >= 0.8 && ts(P) >= 0.9 && P.distinct <= 60 ? 0.6 : 0),
  time_of_day: P => (P.kinds.time >= 0.9 ? 0.75 : 0),
  phone: P => (tx(P) && ts(P) * tx(P).phone_formatted >= 0.7 ? 0.7 : 0),
  uom: P => (tx(P) && tx(P).uom_code >= 0.9 && P.distinct <= 40 ? 0.6 : 0),
  row_id: P => (P.unique_ratio >= 0.99 && P.sequence && P.sequence.step1_share >= 0.95 ? 0.7 : 0)
};
function CONTENT_TYPE(P) { if (!P || !P.populated) return 'empty'; const k = P.kinds; const top = Object.entries(k).sort((a, b) => b[1] - a[1])[0]; if (top[1] < 0.9) return 'mixed'; return top[0] === 'date_unresolved' ? 'date' : top[0]; }

function classifyColumn(col, P, cfg) {
  const H = headerEvidence(col.header_raw); const hmap = new Map(H.candidates.map(c => [c.role, c])); const empty = !P || P.populated === 0;
  const scored = []; const flags = { empty, conflicts: [] };
  for (const role of ROLE_NAMES) {
    if (role === 'unknown') continue;
    const h = hmap.get(role); const hs = h ? h.score : 0;
    let fit = null; if (!empty) fit = FIT[role] ? FIT[role](P) : null;
    const so = !empty && SELF_ID[role] ? Math.min(cfg.content_only_cap, SELF_ID[role](P)) : 0;
    let s = 0;
    if (hs > 0) {
      if (empty) s = hs * cfg.empty_column.header_factor;
      else { s = hs * (0.25 + 0.75 * fit); if (fit < cfg.header_content_veto_fit) { s *= 0.5; flags.conflicts.push({ role, header_score: +hs.toFixed(3), content_fit: +fit.toFixed(3), why: `the header reads as ${role}, but the values look like ${CONTENT_TYPE(P) === 'empty' ? 'nothing' : CONTENT_TYPE(P)} values` }); }
        if (hs >= cfg.corroboration.min_header && fit >= cfg.corroboration.min_fit) s = Math.min(cfg.corroboration.max, s + cfg.corroboration.bonus); }
    }
    if (so > 0) { s = Math.max(s, so); if (hs >= 0.6 && so >= 0.6) s = Math.min(1, s + 0.05); }
    if (ROLES[role].risk === 'high' && s > 0) {                            // high-risk roles are never assigned without content that fits them
      if (empty && !(h && h.coverage >= 0.99 && h.weight >= cfg.empty_column.high_risk_min_header)) s = Math.min(s, cfg.min_assign - 0.01);
      else if (!empty && fit !== null && fit < cfg.high_risk_min_fit && so < 0.6) s = Math.min(s, cfg.min_assign - 0.01);
    }
    if (s > 0.05) scored.push({ role, score: +s.toFixed(4), header_score: +hs.toFixed(4), content_fit: fit === null ? null : +fit.toFixed(4), content_only: +so.toFixed(4), header_rule: h ? h.rule : null, ambiguous_header: !!(h && h.ambiguous) });
  }
  scored.sort((a, b) => b.score - a.score || a.role.localeCompare(b.role));
  const top = scored[0], second = scored[1];
  const assigned = top && top.score >= cfg.min_assign ? top : null;
  const role = assigned ? assigned.role : 'unknown';
  let confidence = assigned ? assigned.score : Math.max(cfg.unknown_floor, 0);
  if (empty && assigned) confidence = Math.min(confidence, cfg.empty_column.confidence_cap);
  const margin = assigned ? assigned.score - (second ? second.score : 0) : 0;
  const reasons = [];
  if (assigned) {
    const info = ROLES[role];
    if (assigned.ambiguous_header) reasons.push(`the header wording alone is ambiguous (${assigned.header_rule})`);
    if (second && margin < cfg.ambiguity_margin && second.score >= cfg.ambiguity_alt_min) reasons.push(`${second.role} is nearly as likely as ${role} (${second.score.toFixed(2)} vs ${assigned.score.toFixed(2)})`);
    if (tierOf(confidence, cfg) !== 'high' && (info.critical || info.risk === 'high')) reasons.push(`${role} is an identity/high-impact role and confidence is ${tierOf(confidence, cfg)}`);
    const winnerHeader = hmap.get(role) ? hmap.get(role).score : 0;
    const lost = flags.conflicts.find(c => c.role !== role && hmap.get(c.role) && hmap.get(c.role).score >= 0.5 && hmap.get(c.role).score >= winnerHeader);   // the header's BEST reading was overruled by the content
    if (lost) reasons.push(lost.why);
    if (flags.conflicts.some(c => c.role === role)) reasons.push('the values do not look like this role');
    if (empty && (info.critical || info.risk === 'high')) reasons.push('the column is empty, so the role rests on the header alone');
  } else {
    const lost = flags.conflicts.find(c => hmap.get(c.role) && hmap.get(c.role).score >= 0.5);
    if (lost) reasons.push(lost.why);
    if (scored.some(c => c.ambiguous_header && c.score >= 0.25)) reasons.push('the header wording is too generic to tell what this column holds');
    const near = scored.find(c => c.header_score >= 0.5 && c.content_fit !== null && c.score >= cfg.ambiguity_alt_min && !flags.conflicts.some(x => x.role === c.role));
    if (near) reasons.push(`the header reads as ${near.role}, but only ${Math.round(near.content_fit * 100)}% of the values fit - not enough to assign a ${ROLES[near.role].risk}-risk role`);   // declining a role silently would hide a near miss
    if (!empty && P.kinds.date + P.kinds.date_unresolved >= 0.8) reasons.push('values are dates but the header does not say which kind of date');
  }
  const review = reasons.length > 0;
  const tier = tierOf(confidence, cfg);
  const alternatives = scored.filter(c => c.role !== role).slice(0, 4).map(c => ({ role: c.role, score: c.score, header_score: c.header_score, content_fit: c.content_fit }));
  if (!assigned && !alternatives.length && H.candidates.length) for (const c of H.candidates.slice(0, 3)) alternatives.push({ role: c.role, score: +(c.score * 0.5).toFixed(4), header_score: c.score, content_fit: null });
  return { role, role_family: familyOf(role), confidence: +confidence.toFixed(4), confidence_tier: tier, review_required: review, review_reasons: reasons, alternatives, content_type: CONTENT_TYPE(P),
    is_critical_identity: !!(ROLES[role] && ROLES[role].critical && role !== 'unknown'),
    evidence: { header: { tokens: H.tokens, content_tokens: H.content_tokens, candidates: H.candidates.slice(0, 5) }, content_fit: Object.fromEntries(scored.filter(c => c.content_fit !== null).slice(0, 6).map(c => [c.role, c.content_fit])),
      decision: { margin: +margin.toFixed(4), top_score: top ? top.score : 0, assigned: !!assigned, empty_column: empty, conflicts: flags.conflicts.slice(0, 3) } } };
}

/** classify every physical column, then resolve several columns claiming the same identity role */
function classifyColumns(columns, profiles, cfg) {
  const out = columns.map((c, i) => ({ position: c.position, header_key: c.header_key, header_raw: c.header_raw, header_normalized: c.header_normalized, ...classifyColumn(c, profiles[i], cfg) }));
  const byRole = new Map();
  out.forEach((m, i) => { if (m.is_critical_identity) { if (!byRole.has(m.role)) byRole.set(m.role, []); byRole.get(m.role).push(i); } });
  for (const [role, idxs] of byRole) {
    if (idxs.length < 2) { out[idxs[0]].primary_for_role = true; continue; }
    const share = i => (profiles[i] && profiles[i].rows ? Math.round(10 * profiles[i].populated / profiles[i].rows) : 0);   // populated share in 10% steps: a sparse column must not out-rank a dense one on confidence alone
    const rank = i => [profiles[i] && profiles[i].populated > 0 ? 1 : 0, share(i), out[i].confidence, profiles[i] ? profiles[i].populated : 0, -out[i].position];
    const sorted = [...idxs].sort((a, b) => { const A = rank(a), B = rank(b); for (let k = 0; k < A.length; k++) if (A[k] !== B[k]) return B[k] - A[k]; return 0; });
    const primary = sorted[0]; out[primary].primary_for_role = true;
    for (const i of sorted.slice(1)) {
      const m = out[i]; m.primary_for_role = false;
      if (!profiles[i] || profiles[i].populated === 0) {                     // an empty twin adds no evidence: it does not get to claim the identity role
        m.alternatives.unshift({ role: m.role, score: m.confidence, header_score: null, content_fit: null }); m.role = 'unknown'; m.role_family = 'other'; m.is_critical_identity = false; m.confidence = 0.3; m.confidence_tier = 'low';
        m.review_required = false; m.review_reasons = [`empty duplicate of column ${out[primary].header_key}, which holds the ${role}`];
      } else { m.review_required = true; m.review_reasons.push(`another column (${out[primary].header_key}) also holds the ${role}; one of them should be primary`); }
    }
  }
  return out;
}
module.exports = { classifyColumn, classifyColumns, FIT, SELF_ID };
