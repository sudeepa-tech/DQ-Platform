'use strict';
/* Transaction matching: documents are compared by their document identifier / reference. A repeated vendor or material value alone is NEVER a transaction duplicate:
   a candidate needs the SAME external reference AND the same amount AND (the same date OR the same vendor). Same document id is the validity layer's repeated-identifier finding, not matched here. */
const { candidatePairs, rawStr } = require('./entity'); const { ref } = require('./conflicts'); const { parseNumeric } = require('../rules/validators'); const T = require('./text'); const { PLACEHOLDERS } = require('../rules/catalog');
function transactionRecord(row, i, roles) {
  const c = r => (roles[r] || [])[0]; const g = r => (c(r) ? rawStr(row, c(r)) : null); const amt = c('amount') ? row.raw[c('amount').header_key] : null;
  const dateOf = col => { if (!col) return null; const m = (row.meta || {})[col.header_key], v = (row.canonical || {})[col.header_key]; return m && (m.k === 'date_only' || m.k === 'datetime' || (m.k === 'text_date' && m.st === 'parsed')) && typeof v === 'string' ? v.slice(0, 10) : null; };
  const ref_ = g('doc_ref'); return { i, rowNumber: row.rowNumber, sheetRow: row.sheetRow === undefined ? null : row.sheetRow, key: (roles.row_id || [])[0] ? rawStr(row, roles.row_id[0]) : g('doc_id'), docId: g('doc_id'), docIdHeader: c('doc_id') && c('doc_id').header_raw,
    docRef: ref_ && !PLACEHOLDERS.includes(ref_.toLowerCase()) ? ref_.toUpperCase() : null, refHeader: c('doc_ref') && c('doc_ref').header_raw, line: g('line_item'), amount: typeof amt === 'number' ? amt : amt === undefined || amt === null ? null : parseNumeric(String(amt).trim()), amountHeader: c('amount') && c('amount').header_raw,
    date: dateOf(c('posting_date')) || dateOf(c('document_date')), dateHeader: (c('posting_date') || c('document_date') || {}).header_raw, vendor: c('entity_id') ? T.vendorKey(g('entity_id'), PLACEHOLDERS) : null, vendorHeader: c('entity_id') && c('entity_id').header_raw };
}
function transactionCandidates(recs, cfg) {
  const { pairs, skipped } = candidatePairs(recs, r => (r.docRef ? ['r:' + r.docRef] : []), () => cfg.blocking.max_block_size); const out = [], t = cfg.transaction;
  for (const p of pairs) {
    const x = recs[p.i], y = recs[p.j]; if (x.docId !== null && x.docId === y.docId && (x.line || '') === (y.line || '')) continue;
    const amountEq = x.amount !== null && y.amount !== null && Math.abs(x.amount - y.amount) < 1e-9, dateEq = !!(x.date && y.date && x.date === y.date), vendorEq = !!(x.vendor && y.vendor && x.vendor === y.vendor);
    if (t.require_equal_amount && !amountEq) continue; if (t.require_equal_date_or_entity && !(dateEq || vendorEq)) continue;
    const ev = [{ type: 'reference_equal', strength: 'hard', role: 'doc_ref', fields: [x.refHeader, y.refHeader], values: [x.docRef, y.docRef], normalized: x.docRef }]; if (amountEq) ev.push({ type: 'amount_equal', strength: 'strong', role: 'amount', fields: [x.amountHeader], values: [x.amount, y.amount], normalized: x.amount });
    if (dateEq) ev.push({ type: 'date_equal', strength: 'strong', role: 'posting_date', fields: [x.dateHeader], values: [x.date, y.date], normalized: x.date }); if (vendorEq) ev.push({ type: 'vendor_equal', strength: 'supporting', role: 'entity_id', fields: [x.vendorHeader], values: [x.vendor, y.vendor], normalized: x.vendor });
    out.push({ class: 'candidate', candidate_kind: 'transaction_duplicate', a: ref(x), b: ref(y), document_ids: [x.docId, y.docId], status: 'candidate_needs_review', confidence: null, scoring_eligible: false, evidence: ev, counter_evidence: [], i: p.i, j: p.j });
  }
  return { candidates: out, skipped };
}
module.exports = { transactionRecord, transactionCandidates };
