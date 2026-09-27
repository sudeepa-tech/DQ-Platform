'use strict';
/* Conflict groups. ONE underlying cause = ONE group, however many evidence paths (GSTIN + phone + e-mail ...) reveal it and however many record pairs it touches. */
const crypto = require('crypto'); const T = require('./text');
const fid = (...p) => crypto.createHash('sha256').update(p.join('|')).digest('hex').slice(0, 16);
const ref = r => ({ row_number: r.rowNumber, sheet_row: r.sheetRow, record_key: r.key });
function groupEntityConflicts(conflictPairs, recs) {
  const groups = new Map();
  for (const p of conflictPairs) {
    const k = p.conflict_type + '|' + p.subject; let g = groups.get(k);
    if (!g) groups.set(k, g = { type: p.conflict_type, subject: p.subject, members: new Map(), pairs: [], paths: new Set() });
    g.members.set(p.i, recs[p.i]); g.members.set(p.j, recs[p.j]); g.pairs.push(p); for (const e of [...p.evidence, ...p.counter_evidence]) g.paths.add(e.type);
  }
  return [...groups.values()].map(g => {
    const mem = [...g.members.values()].sort((a, b) => a.rowNumber - b.rowNumber); const x = mem[0]; const roleOf = { gstin_shared_identity: 'legal_id', gstin_mismatch: 'entity_id', vendor_code_identity: 'entity_id', identity_name_conflict: 'legal_id' }[g.type];
    const field = roleOf === 'legal_id' ? (mem.find(m => m.legal) || x).legal.header : (mem.find(m => m.vendor) || x).vendor.header;
    return { kind: 'entity', id: fid('conflict', g.type, g.subject), type: g.type, subject: g.subject, field, members: mem.map(ref), status: 'open', severity: 'high', review_required: true, evidence_paths: [...g.paths].sort(),
      pairs: g.pairs.sort((a, b) => a.i - b.i || a.j - b.j).map(p => ({ a: ref(recs[p.i]), b: ref(recs[p.j]), name_relation: p.name_relation, name_similarity: p.name_similarity, evidence: p.evidence, counter_evidence: p.counter_evidence })) };
  }).sort((a, b) => a.type.localeCompare(b.type) || a.members[0].row_number - b.members[0].row_number);
}
/** the same item / material code carrying different descriptions: one group per code; the MINORITY records are the flagged ones (a tie flags every class) */
function itemDescriptionConflicts(items, cfg) {
  const byCode = new Map(); for (const r of items) { if (!r.code || !r.nd) continue; (byCode.get(r.code) || byCode.set(r.code, []).get(r.code)).push(r); }
  const min = cfg.item_conflicts.description_compatible_at_or_above, out = [];
  for (const [code, list] of byCode) {
    const classes = []; for (const r of list) { const c = classes.find(k => T.descriptionCompatible(k.rep, r.nd, min)); if (c) c.records.push(r); else classes.push({ rep: r.nd, records: [r] }); }
    if (classes.length < 2) continue; classes.sort((a, b) => b.records.length - a.records.length || a.rep.localeCompare(b.rep)); const tie = classes[0].records.length === classes[1].records.length;
    const flagged = tie ? (cfg.item_conflicts.on_tie === 'flag_all' ? classes.flatMap(c => c.records) : []) : classes.slice(1).flatMap(c => c.records); if (!flagged.length) continue;
    out.push({ kind: 'item', id: fid('conflict', 'material_code_description', code), type: 'material_code_description', subject: code, field: list[0].codeHeader, status: 'open', severity: 'medium', review_required: true, tie,
      members: flagged.sort((a, b) => a.rowNumber - b.rowNumber).map(ref), evidence_paths: ['description_differs'],
      classes: classes.map((c, i) => ({ description: c.rep, description_field: list[0].descHeader, count: c.records.length, majority: !tie && i === 0, records: c.records.map(ref).sort((a, b) => a.row_number - b.row_number) })) });
  }
  return out.sort((a, b) => a.subject.localeCompare(b.subject));
}
module.exports = { groupEntityConflicts, itemDescriptionConflicts, ref, fid };
