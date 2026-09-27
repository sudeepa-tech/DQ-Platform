'use strict';
/* Material matching (material master): material_id + description semantics. Candidates are REVIEW-ONLY: they carry no score until a human confirms. Repeated codes are never entity duplicates. */
const T = require('./text'); const { candidatePairs, rawStr } = require('./entity'); const { ref } = require('./conflicts');
function materialRecord(row, i, roles, cfg) {
  const c = r => (roles[r] || [])[0]; const idC = c('material_id'), dC = c('description'), uC = c('uom'), gC = c('category'); const raw = dC ? rawStr(row, dC) : null;
  return { i, rowNumber: row.rowNumber, sheetRow: row.sheetRow === undefined ? null : row.sheetRow, key: (roles.row_id || [])[0] ? rawStr(row, roles.row_id[0]) : (idC ? rawStr(row, idC) : null), id: idC ? rawStr(row, idC) : null, idHeader: idC && idC.header_raw,
    desc: raw, descHeader: dC && dC.header_raw, nd: raw ? T.normalizeDescription(raw, cfg.name) : '', uom: uC ? rawStr(row, uC) : null, category: gC ? rawStr(row, gC) : null };
}
function materialCandidates(recs, cfg) {
  const min = cfg.material.description_compatible_at_or_above; const keys = r => { if (!r.nd) return []; const f = r.nd.split(' ')[0]; return ['d:' + r.nd, 'c:' + r.nd.replace(/ /g, ''), 's:' + f + '|' + T.numSignature(r.nd)]; };
  const { pairs, skipped } = candidatePairs(recs, keys, () => cfg.material.block_max); const out = [];
  for (const p of pairs) {
    const x = recs[p.i], y = recs[p.j]; if (x.id !== null && x.id === y.id) continue; let kind = null, sim = null;
    if (x.nd === y.nd) { kind = 'exact_description'; sim = 1; } else if (x.nd.replace(/ /g, '') === y.nd.replace(/ /g, '')) { kind = 'exact_description_ignoring_spaces'; sim = 1; }
    else if (T.descriptionCompatible(x.nd, y.nd, min)) { kind = 'near_description'; sim = +T.similarity(x.nd, y.nd).toFixed(4); } if (!kind) continue;
    const ev = [{ type: kind, strength: kind === 'near_description' ? 'supporting' : 'strong', role: 'description', fields: [x.descHeader, y.descHeader], values: [x.desc, y.desc], normalized: [x.nd, y.nd], similarity: sim }];
    const cev = []; if (x.uom && y.uom) (x.uom === y.uom ? ev : cev).push({ type: x.uom === y.uom ? 'uom_equal' : 'uom_differs', strength: x.uom === y.uom ? 'supporting' : 'observation', role: 'uom', fields: ['uom'], values: [x.uom, y.uom], normalized: [x.uom, y.uom] });
    if (x.category && y.category) (x.category === y.category ? ev : cev).push({ type: x.category === y.category ? 'category_equal' : 'category_differs', strength: 'observation', role: 'category', fields: ['category'], values: [x.category, y.category], normalized: [x.category, y.category] });
    out.push({ class: 'candidate', candidate_kind: 'material_' + kind, a: ref(x), b: ref(y), material_ids: [x.id, y.id], status: 'candidate_needs_review', confidence: null, scoring_eligible: false, evidence: ev, counter_evidence: cev, i: p.i, j: p.j });
  }
  return { candidates: out, skipped };
}
module.exports = { materialRecord, materialCandidates };
