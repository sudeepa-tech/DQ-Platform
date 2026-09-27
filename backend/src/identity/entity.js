'use strict';
/*
 * Entity identity: records -> blocking -> pair classification -> constrained clustering.
 * Evidence classes (approved strategy): HARD = valid legal id (GSTIN/PAN), valid vendor/entity id; STRONG = phone, e-mail, normalized name, postal + address core; SUPPORTING = compatible (fuzzy) name.
 * NEVER identity evidence: an invalid id (the validity layer's finding), a row identifier, city / state alone, a repeated item / material code.
 */
const T = require('./text'); const { PLACEHOLDERS } = require('../rules/catalog');
const rawStr = (row, c) => { const v = row.raw[c.header_key]; if (v === undefined || v === null) return null; const s = typeof v === 'string' ? v.trim() : String(v); return s === '' ? null : s; };
function roleColumns(columns) {
  const by = {}; for (const c of columns) { if (c.include_in_analysis === false || c.include_in_analysis === 0) continue; (by[c.role] = by[c.role] || []).push(c); }
  for (const l of Object.values(by)) l.sort((a, b) => (b.primary_for_role === true) - (a.primary_for_role === true) || a.position - b.position); return by;
}
const hasRoles = (roles, ...r) => r.every(x => (roles[x] || []).length);
/** which identity evidence this dataset can offer (decided from the confirmed mapping, never from headers) */
function entityCapability(roles) {
  const hard = ['legal_id', 'entity_id'].filter(r => (roles[r] || []).length), strong = ['phone', 'email', 'postal_code', 'address'].filter(r => (roles[r] || []).length);
  return { possible: hasRoles(roles, 'name') && (hard.length > 0 || strong.length > 0), hard, strong, has_name: hasRoles(roles, 'name'), has_row_id: hasRoles(roles, 'row_id') };
}
function entityRecord(row, i, roles, cfg, invalid) {
  const bad = c => invalid.has(row.rowNumber + '|' + c.header_key); const first = (role, fn) => { for (const c of roles[role] || []) { if (bad(c)) continue; const raw = rawStr(row, c); if (raw === null) continue; const k = fn(raw); if (k !== null && k !== undefined && k !== '') return { raw, key: k, header: c.header_raw }; } return null; };
  const all = (role, fn) => { const out = []; for (const c of roles[role] || []) { if (bad(c)) continue; const raw = rawStr(row, c); if (raw === null) continue; const k = fn(raw); if (k) out.push({ raw, key: k, header: c.header_raw }); } return out; };
  const nameC = (roles.name || []).find(c => rawStr(row, c) !== null); const nameRaw = nameC ? rawStr(row, nameC) : null; const nn = nameRaw ? T.normalizeName(nameRaw, cfg.name) : '';
  const cityC = (roles.city || [])[0], stateC = (roles.state || [])[0], addrC = (roles.address || [])[0], postC = (roles.postal_code || []).find(c => !bad(c) && rawStr(row, c) !== null);
  const city = cityC ? rawStr(row, cityC) : null, state = stateC ? rawStr(row, stateC) : null; const ac = addrC && !bad(addrC) ? T.addressCore(rawStr(row, addrC), city, state) : '';
  const rk = (roles.row_id || [])[0]; const legal = first('legal_id', T.legalKey), vendor = first('entity_id', v => T.vendorKey(v, PLACEHOLDERS));
  return { i, rowNumber: row.rowNumber, sheetRow: row.sheetRow === undefined ? null : row.sheetRow, key: rk ? rawStr(row, rk) : null,
    name: nameRaw ? { raw: nameRaw, header: nameC.header_raw } : null, nn, nums: T.numSignature(nn),
    legal, vendor, phones: all('phone', T.phoneKey), emails: all('email', T.emailKey), postal: postC ? rawStr(row, postC) : null, addr: ac, city, state, vals: null };
}
const blockKeys = (r, cfg) => {
  const k = []; if (r.legal) k.push('g:' + r.legal.key.kind + ':' + r.legal.key.value); if (r.vendor) k.push('v:' + r.vendor.key); for (const p of r.phones) k.push('p:' + p.key); for (const e of r.emails) k.push('e:' + e.key); if (r.postal && r.addr) k.push('a:' + r.postal + '|' + r.addr);
  if (cfg.blocking.name_blocks && r.nn) { k.push('n:' + r.nn); const first = r.nn.split(' ')[0]; k.push('r:' + first + '|' + r.nums); } return k;
};
/** candidate pairs from inverted indexes only (never all-pairs). Oversize blocks are skipped AND reported. */
function candidatePairs(recs, keysOf, capFor) {
  const idx = new Map(); for (const r of recs) for (const k of keysOf(r)) { let l = idx.get(k); if (!l) idx.set(k, l = []); l.push(r.i); }
  const seen = new Map(), skipped = []; const N = recs.length + 1;
  for (const [k, l] of idx) { if (l.length < 2) continue; if (l.length > capFor(k)) { skipped.push({ block: k.slice(0, 2) === 'n:' || k.slice(0, 2) === 'r:' ? k.slice(0, 2) + '…' : k.split(':')[0] + ':…', size: l.length, cap: capFor(k) }); continue; }
    for (let a = 0; a < l.length; a++) for (let b = a + 1; b < l.length; b++) { const i = Math.min(l[a], l[b]), j = Math.max(l[a], l[b]), p = i * N + j; let s = seen.get(p); if (!s) seen.set(p, s = { i, j, keys: new Set() }); s.keys.add(k[0]); } }
  return { pairs: [...seen.values()].sort((a, b) => a.i - b.i || a.j - b.j), skipped };
}
const shared = (xs, ys) => { for (const a of xs) for (const b of ys) if (a.key === b.key) return [a, b]; return null; };
/** evidence-weighted confidence in [0, max]; only ever attached to ACCEPTED (or human-confirmed) matches */
const confidenceFromEvidence = (ev, W) => Math.min(W.max_confidence, +(ev.reduce((s, e) => s + ({ legal_id_agree: W.legal_id_agree, vendor_code_agree: W.vendor_code_agree, name_equal: W.name_equal, name_compatible: W.name_compatible, phone_equal: W.phone_equal, email_equal: W.email_equal, address_equal: W.address_equal }[e.type] || 0), 0)).toFixed(4));
/** Classify one candidate pair by the approved semantics. Pure. */
function classifyPair(x, y, cfg, W) {
  const gsAgree = !!(x.legal && y.legal && x.legal.key.kind === y.legal.key.kind && x.legal.key.value === y.legal.key.value);
  const gsConf = !!(x.legal && y.legal && x.legal.key.kind === y.legal.key.kind && x.legal.key.value !== y.legal.key.value);
  const vcAgree = !!(x.vendor && y.vendor && x.vendor.key === y.vendor.key), vcDiffers = !!(x.vendor && y.vendor && x.vendor.key !== y.vendor.key);
  const nr = T.nameRelation(x.nn, y.nn, cfg.name), rel = nr.rel; const ph = shared(x.phones, y.phones), em = shared(x.emails, y.emails); const contactEq = !!(ph || em);
  const addrEq = !!(x.postal && y.postal && x.postal === y.postal && x.addr && x.addr === y.addr); const hard = gsAgree || vcAgree;
  const ev = [];
  if (gsAgree) ev.push({ type: 'legal_id_agree', strength: 'hard', role: 'legal_id', fields: [x.legal.header, y.legal.header], values: [x.legal.raw, y.legal.raw], normalized: x.legal.key.value });
  if (vcAgree) ev.push({ type: 'vendor_code_agree', strength: 'hard', role: 'entity_id', fields: [x.vendor.header, y.vendor.header], values: [x.vendor.raw, y.vendor.raw], normalized: x.vendor.key });
  if (rel === 'eq' || rel === 'sim') ev.push({ type: rel === 'eq' ? 'name_equal' : 'name_compatible', strength: rel === 'eq' ? 'strong' : 'supporting', role: 'name', fields: [x.name.header, y.name.header], values: [x.name.raw, y.name.raw], normalized: [x.nn, y.nn], similarity: nr.sim });
  if (ph) ev.push({ type: 'phone_equal', strength: 'strong', role: 'phone', fields: [ph[0].header, ph[1].header], values: [ph[0].raw, ph[1].raw], normalized: ph[0].key });
  if (em) ev.push({ type: 'email_equal', strength: 'strong', role: 'email', fields: [em[0].header, em[1].header], values: [em[0].raw, em[1].raw], normalized: em[0].key });
  if (addrEq) ev.push({ type: 'address_equal', strength: 'strong', role: 'address', fields: ['postal_code', 'address'], values: [x.postal + ' ' + x.addr, y.postal + ' ' + y.addr], normalized: x.postal + '|' + x.addr });
  const cev = []; if (gsConf) cev.push({ type: 'legal_id_conflict', strength: 'conflict', role: 'legal_id', fields: [x.legal.header, y.legal.header], values: [x.legal.raw, y.legal.raw], normalized: [x.legal.key.value, y.legal.key.value] });
  if (vcDiffers) cev.push({ type: 'vendor_code_differs', strength: 'observation', role: 'entity_id', fields: [x.vendor.header, y.vendor.header], values: [x.vendor.raw, y.vendor.raw], normalized: [x.vendor.key, y.vendor.key] });
  if (rel === 'different') cev.push({ type: 'name_different', strength: 'observation', role: 'name', fields: [x.name.header, y.name.header], values: [x.name.raw, y.name.raw], normalized: [x.nn, y.nn], similarity: nr.sim });
  const base = { name_relation: rel, name_similarity: nr.sim === null ? null : +nr.sim.toFixed(4), evidence: ev, counter_evidence: cev, flags: { gsAgree, gsConf, vcAgree, vcDiffers, contactEq, addrEq } };
  const conf = () => confidenceFromEvidence(ev, W);
  let ctype = null, subject = null;
  if (gsAgree && vcAgree && rel === 'different') { ctype = 'identity_name_conflict'; subject = x.legal.key.value + '|' + x.vendor.key; }
  else if (gsAgree && rel === 'different' && !vcAgree) { ctype = 'gstin_shared_identity'; subject = x.legal.key.value; }
  else if (vcAgree && gsConf) { ctype = 'gstin_mismatch'; subject = x.vendor.key; }
  else if (vcAgree && rel === 'different' && !gsAgree) { ctype = 'vendor_code_identity'; subject = x.vendor.key; }
  if (ctype) return { ...base, class: 'conflict', conflict_type: ctype, subject };
  if (hard && !gsConf) {
    if (rel === 'eq' || rel === 'sim' || (rel === 'unknown' && ((gsAgree && vcAgree) || contactEq))) {
      const variant = gsAgree && vcDiffers && (rel === 'eq' || rel === 'sim'); return { ...base, class: 'match', match_class: variant ? 'entity_match' : 'duplicate', match_subtype: variant ? 'identity_match_vendor_code_variant' : null, status: variant && cfg.review.vendor_code_variant_needs_review ? 'needs_review' : 'auto_accepted', confidence: conf(), strength: (gsAgree ? 1 : 0) + (vcAgree ? 1 : 0) };
    }
    if (rel === 'ambiguous') return { ...base, class: 'ambiguous', status: 'needs_review', confidence: null };
    return { ...base, class: 'candidate', candidate_kind: 'hard_id_name_unknown', status: 'candidate_needs_review', confidence: null };
  }
  if (!hard && !gsConf && (rel === 'eq' || rel === 'sim')) { const strong = (ph ? 1 : 0) + (em ? 1 : 0) + (addrEq ? 1 : 0); if (strong >= cfg.fuzzy.min_strong_signals) return { ...base, class: 'candidate', candidate_kind: 'fuzzy_entity', strong_signals: strong, status: 'candidate_needs_review', confidence: null }; }
  if (contactEq) return { ...base, class: 'observation', observation: 'shared_contact' };
  return { ...base, class: 'none' };
}
/**
 * Constrained union-find. A union is REFUSED (and recorded) when the two sets would hold: two different valid legal ids of the same kind, an explicit cannot-link pair,
 * or incompatible numeric name signatures ("... 05" vs "... 06") that no direct hard-id agreement supports.
 */
function cluster(recs, accepted, cannotLink) {
  const n = recs.length, parent = Array.from({ length: n }, (_, i) => i), legal = recs.map(r => (r.legal ? new Map([[r.legal.key.kind, r.legal.key.value]]) : new Map())), sig = recs.map(r => (r.nn ? new Set([r.nums]) : new Set())), forbid = recs.map(() => new Set());
  const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (const [a, b] of cannotLink) { forbid[a].add(b); forbid[b].add(a); }   // forbid sets hold RECORD indexes; merged sets are consulted by root below
  const forbidRoots = new Map(); const fr = r => { if (!forbidRoots.has(r)) forbidRoots.set(r, new Set()); return forbidRoots.get(r); }; for (let i = 0; i < n; i++) if (forbid[i].size) { fr(i); for (const j of forbid[i]) fr(i).add(j); }
  const refused = [], unions = [];
  for (const p of accepted) {
    const ra = find(p.i), rb = find(p.j); if (ra === rb) { unions.push(p); continue; }
    let reason = null; const A = legal[ra], B = legal[rb]; for (const [k, v] of A) if (B.has(k) && B.get(k) !== v) reason = 'two_different_valid_legal_ids';
    if (!reason) { const fa = forbidRoots.get(ra), fb = forbidRoots.get(rb); const hit = (f, other) => f && [...f].some(m => find(m) === other); if (hit(fa, rb) || hit(fb, ra)) reason = 'cannot_link_pair'; }
    if (!reason && sig[ra].size && sig[rb].size && [...sig[ra]].some(s => !sig[rb].has(s))) reason = 'numeric_identity_distinction';
    if (reason) { refused.push({ a: p.i, b: p.j, reason }); continue; }
    parent[ra] = rb; for (const [k, v] of A) B.set(k, v); for (const s of sig[ra]) sig[rb].add(s); const fa = forbidRoots.get(ra); if (fa) { const t = fr(rb); for (const m of fa) t.add(m); } unions.push(p);
  }
  const comp = new Map(); for (let i = 0; i < n; i++) { const r = find(i); (comp.get(r) || comp.set(r, []).get(r)).push(i); }
  return { components: [...comp.values()].filter(m => m.length > 1).map(m => m.sort((x, y) => x - y)).sort((a, b) => a[0] - b[0]), refused, unions };
}
module.exports = { confidenceFromEvidence, roleColumns, hasRoles, entityCapability, entityRecord, blockKeys, candidatePairs, classifyPair, cluster, rawStr };
