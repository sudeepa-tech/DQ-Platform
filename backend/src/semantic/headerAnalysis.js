'use strict';
/*
 * Header analysis: WHOLE-WORD tokens (never substrings), classified by a small general lexicon and parsed compositionally into
 * SUBJECT (what it is about: entity / material / document) + HEAD (what the field is: name, number, date, phone ...).
 * A role's header score is its rule weight discounted by COVERAGE: the share of the header's content words the rule explains.
 * ("Push Deployment from Supplier" is 1 explained word out of 3 - it is not a supplier name.)  The lexicon is general ERP/business vocabulary;
 * there are no dataset-specific phrases here (a static test forbids full header phrases from the QA datasets as literals).
 */
const { familyOf } = require('./taxonomy');
const LEXICON_VERSION = 'header-lexicon-1.0.0';
const W = {
  S_ENT: 'vendor supplier customer party client company firm organisation organization business partner dealer distributor payee creditor debtor contractor entity',
  S_MAT: 'material product article sku part goods item',
  S_DOC: 'document invoice order po voucher bill receipt challan delivery requisition contract entry sheet shipment transaction purchase purchasing sales grn',
  H_ID: 'number id code key identifier',
  H_REF: 'reference',
  H_NAME: 'name',
  H_DESC: 'description text remark comment narration title',
  H_ADDR: 'address street',
  H_LOC: 'location',
  H_CITY: 'city town',
  H_STATE: 'state region province',
  H_COUNTRY: 'country nation',
  H_POSTAL: 'pin pincode postal postcode zip zipcode',
  H_PHONE: 'phone mobile telephone cell',
  H_CONTACT: 'contact',
  H_EMAIL: 'email mail',
  H_LEGAL: 'gstin gstn pan tin cin vat',
  H_TAX: 'tax gst cgst sgst igst',
  M_CREATE: 'created creation entered added inserted',
  M_MODIFY: 'changed change modified modification updated update amended revised',
  M_POST: 'posting posted',
  M_VALID: 'valid effective expiry expiration validity start end from to period',
  H_DATE: 'date on',
  H_TIME: 'time',
  H_BY: 'by',
  H_USER: 'user author owner',
  H_QTY: 'quantity count',
  H_PRICE: 'price cost mrp',
  H_RATE: 'rate',
  H_PCT: 'percent percentage',
  H_CURR: 'currency',
  H_UOM: 'uom',
  H_UNIT: 'unit',
  H_AMOUNT: 'amount value total balance sum',
  H_MEASURE: 'weight volume length width height depth capacity diameter thickness size area measure',
  H_CAT: 'type category group class kind division industry segment sector',
  H_STATUS: 'status indicator flag stage',
  H_PAY: 'payment',
  H_TERMS: 'terms',
  H_SERIAL: 'serial',
  H_RECORD: 'record row index',
  H_LINE: 'line position',
  H_PERSON: 'person',
  H_RESP: 'responsible',
  NEUTRAL: 'base maximum max minimum min net gross allowed last first original current actual planned default standard internal external internally externally new old main primary secondary additional general relevant short long full complete final',
  STOP: 'of the at a an for in and or to per w with without'
};
const TAGS = new Map();
for (const [tag, words] of Object.entries(W)) for (const w of words.split(/\s+/)) { if (!TAGS.has(w)) TAGS.set(w, new Set()); TAGS.get(w).add(tag); }
// 'to' / 'from' are validity words only next to a date; STOP otherwise. 'on' is a date marker only after created/changed/posted words.
const ABBREV = { no: 'number', nr: 'number', num: 'number', nbr: 'number', qty: 'quantity', qnty: 'quantity', desc: 'description', descr: 'description', descn: 'description', addr: 'address', curr: 'currency', cur: 'currency', ccy: 'currency',
  amt: 'amount', val: 'value', dt: 'date', doc: 'document', ref: 'reference', cust: 'customer', vend: 'vendor', supp: 'supplier', suppl: 'supplier', matl: 'material', mat: 'material', pers: 'person', resp: 'responsible',
  rsp: 'responsible', cat: 'category', grp: 'group', wt: 'weight', vol: 'volume', mob: 'mobile', ph: 'phone', tel: 'telephone', org: 'organisation', inv: 'invoice', pur: 'purchase', purch: 'purchase', ord: 'order', pymt: 'payment',
  pmt: 'payment', payt: 'payment', trm: 'terms', ind: 'indicator', indic: 'indicator', stat: 'status', txn: 'transaction', unit: 'unit', uom: 'uom', gst: 'gst', cgst: 'cgst', sgst: 'sgst', igst: 'igst', pct: 'percent', prc: 'price', sr: 'serial', sl: 'serial' };
const STOP_IF_NOT_DATE = new Set(['to', 'from']);

function singular(t) { if (t.length > 4 && t.endsWith('ies')) return t.slice(0, -3) + 'y'; if (t.length > 4 && t.endsWith('sses')) return t.slice(0, -2); if (t.length > 3 && t.endsWith('s') && !/(ss|us|is|as)$/.test(t)) return t.slice(0, -1); return t; }
function tokenize(header) {
  let s = String(header).normalize('NFKC').replace(/([a-z])([A-Z])(?=[a-z])/g, '$1 $2');   // CreatedBy -> Created By, but UoM stays UoM
  s = s.toLowerCase().replace(/%/g, ' percent ').replace(/#/g, ' number ').replace(/e[-\s]?mail/g, 'email').replace(/w\/o/g, 'without').replace(/\b(s|sl|sr)\.?\s?no\b\.?/g, 'serial number');
  const dotted = new Set((s.match(/[a-z]+(?=\.)/g) || []));
  const raw = s.split(/[^a-z0-9]+/).filter(Boolean); const out = [];
  for (let t of raw) {
    if (ABBREV[t]) t = ABBREV[t]; else if (dotted.has(t) && t.length >= 4 && !TAGS.has(t)) {   // "Cust." style prefixes: only from 4 letters, and only when every candidate word means the same kind of thing ("Rem." is not "remark"; "Cont." is not guessed)
      const cand = [...TAGS.keys()].filter(w => w.startsWith(t) && w.length > t.length).sort((a, b) => a.length - b.length); const sig = w => [...TAGS.get(w)].sort().join('|');
      if (cand.length && cand.every(w => sig(w) === sig(cand[0]))) t = cand[0]; }
    t = TAGS.has(t) ? t : singular(t);
    out.push(t);
  }
  return out;
}
function parse(header) {
  const words = tokenize(header); const toks = words.map(t => ({ t, tags: new Set(TAGS.get(t) || []) }));
  const hasDateHead = toks.some(x => x.t === 'date');
  const verbs = toks.some(x => x.tags.has('M_CREATE') || x.tags.has('M_MODIFY') || x.tags.has('M_POST'));
  for (const x of toks) if (x.t === 'on' && !verbs) { x.tags.delete('H_DATE'); x.tags.add('STOP'); }   // "on" marks a date only after created / changed / posted
  for (const x of toks) { if (STOP_IF_NOT_DATE.has(x.t) && !hasDateHead && !toks.some(y => y.t === 'period')) { x.tags.delete('M_VALID'); x.tags.add('STOP'); } }
  const content = toks.filter(x => !x.tags.has('STOP') && !/^\d+$/.test(x.t));
  const has = tag => toks.some(x => x.tags.has(tag)); const of = tag => toks.filter(x => x.tags.has(tag));
  return { header, words, toks, content, has, of, text: words.join(' ') };
}

const cand = (role, weight, used, rule) => ({ role, weight, used, rule });
/** header-only candidate roles with weights BEFORE coverage discount */
function candidates(p) {
  const { has, of, toks } = p; const out = []; const all = tags => tags.flatMap(t => of(t));
  const only = (...tags) => { const allowed = new Set([...tags, 'NEUTRAL', 'STOP']); return p.content.every(x => [...x.tags].some(t => allowed.has(t))); };
  const idx = t => toks.findIndex(x => x.t === t);
  const countPhrase = /\bnumber of\b/.test(p.text);   // on the EXPANDED tokens, so "No. of X" / "Nr of X" count too
  const SUBJ = ['S_ENT', 'S_MAT', 'S_DOC']; const by = has('H_BY'), dateHead = has('H_DATE') && toks.some(x => x.t === 'date' || (x.t === 'on' && (has('M_CREATE') || has('M_MODIFY') || has('M_POST'))));
  // ---- self-describing formats
  if (has('H_EMAIL')) out.push(cand('email', 0.98, all(['H_EMAIL', 'H_ADDR', 'H_ID', 'H_CONTACT']), 'email'));
  if (has('H_PHONE')) out.push(cand('phone', 0.97, all(['H_PHONE', 'H_ID', 'H_CONTACT']), 'phone'));
  else if (has('H_CONTACT') && has('H_ID')) out.push(cand('phone', 0.7, all(['H_CONTACT', 'H_ID']), 'contact number'));
  else if (has('H_CONTACT') && only('H_CONTACT', 'H_ID')) out.push(cand('phone', 0.45, all(['H_CONTACT']), 'contact (ambiguous)'));
  if (has('H_POSTAL')) out.push(cand('postal_code', 0.95, all(['H_POSTAL', 'H_ID']), 'postal'));
  if (has('H_LEGAL') && !has('H_PCT') && !has('H_RATE')) out.push(cand('legal_id', 0.95, all(['H_LEGAL', 'H_ID', 'H_TAX']), 'legal id'));
  if (has('H_TAX') && !has('H_LEGAL')) {
    if (has('H_PCT') || has('H_RATE')) out.push(cand('tax_rate', 0.95, all(['H_TAX', 'H_PCT', 'H_RATE']), 'tax rate'));
    else if (has('H_ID')) out.push(cand('legal_id', toks.some(x => x.t === 'gst') ? 0.95 : 0.85, all(['H_TAX', 'H_ID']), 'tax id'));
    else out.push(cand('tax_rate', 0.55, all(['H_TAX']), 'tax (ambiguous)'), cand('legal_id', 0.3, all(['H_TAX']), 'tax (ambiguous)'));
  }
  if (has('H_LEGAL') && (has('H_PCT') || has('H_RATE'))) out.push(cand('tax_rate', 0.95, all(['H_LEGAL', 'H_PCT', 'H_RATE']), 'tax rate'));
  if (has('H_CURR')) out.push(cand('currency', 0.98, all(['H_CURR', 'H_ID', ...SUBJ]), 'currency'));
  // ---- quantities and values
  if (has('H_QTY') && !has('H_ID')) out.push(cand('quantity', toks.some(x => x.t === 'count') ? 0.55 : 0.95, all(['H_QTY', ...SUBJ]), 'quantity'));
  if (countPhrase) out.push(cand('quantity', 0.55, all(['H_ID']), 'number of'));
  if (has('H_PRICE')) { const pi = idx('price') >= 0 ? idx('price') : idx('cost'); const ui = idx('unit'); out.push(cand('unit_price', ui >= 0 && ui < pi ? 0.95 : (ui > pi ? 0.55 : (toks.some(x => x.t === 'price') ? 0.85 : 0.6)), all(['H_PRICE', 'H_UNIT', ...SUBJ]), 'price')); }
  if (has('H_RATE') && !has('H_PCT') && !has('H_TAX') && !has('H_LEGAL')) out.push(cand('unit_price', 0.5, all(['H_RATE']), 'rate (ambiguous)'), cand('tax_rate', 0.4, all(['H_RATE']), 'rate (ambiguous)'));
  if (has('H_PCT') && !has('H_TAX') && !has('H_LEGAL') && !has('H_RATE')) out.push(cand('tax_rate', 0.35, all(['H_PCT']), 'percent (ambiguous)'));
  if (has('H_AMOUNT')) out.push(cand('amount', 0.85, all(['H_AMOUNT', ...SUBJ]), 'amount'));
  if (has('H_MEASURE')) out.push(cand('measure', has('H_UNIT') ? 0.4 : 0.85, all(['H_MEASURE', ...SUBJ]), 'measure'));
  if (has('H_UOM')) out.push(cand('uom', 0.97, all(['H_UOM', 'H_MEASURE', ...SUBJ]), 'uom'));
  else if (has('H_UNIT') && !has('H_PRICE')) out.push(cand('uom', has('H_MEASURE') || toks.some(x => x.t === 'measure') ? 0.85 : 0.7, all(['H_UNIT', 'H_MEASURE']), 'unit'));
  // ---- classifications
  if (has('H_CAT')) { if (has('S_ENT')) out.push(cand('entity_type', 0.92, all(['S_ENT', 'H_CAT']), 'entity type'), cand('category', 0.3, all(['H_CAT']), 'type')); else out.push(cand('category', 0.8, all(['S_MAT', 'H_CAT']), 'category')); }
  if (has('H_STATUS')) out.push(cand('status', 0.85, all(['H_STATUS', ...SUBJ]), 'status'));
  if (has('H_PAY') && has('H_TERMS')) out.push(cand('payment_terms', 0.95, all(['H_PAY', 'H_TERMS']), 'payment terms'));
  // ---- text fields
  if (has('H_DESC')) out.push(cand('description', 0.9, all(['H_DESC', 'S_MAT', 'S_DOC']), 'description'));
  if (has('H_NAME')) {
    if (has('S_ENT')) out.push(cand('name', 0.95, all(['S_ENT', 'H_NAME']), 'entity name'));
    else if (has('S_MAT')) out.push(cand('description', 0.85, all(['S_MAT', 'H_NAME']), 'material name'));
    else out.push(cand('name', 0.55, all(['H_NAME']), 'name (ambiguous)'), cand('description', 0.35, all(['H_NAME']), 'name (ambiguous)'));
  } else if (has('S_ENT') && only('S_ENT')) out.push(cand('name', 0.6, all(['S_ENT']), 'entity word alone'), cand('entity_id', 0.4, all(['S_ENT']), 'entity word alone'));
  if (has('H_ADDR')) out.push(cand('address', 0.92, all(['H_ADDR', 'H_LOC']), 'address'));
  if (has('H_LOC') && !has('H_ADDR')) out.push(cand('address', 0.5, all(['H_LOC']), 'location'), cand('city', 0.4, all(['H_LOC']), 'location'));
  if (has('H_CITY')) out.push(cand('city', 0.95, all(['H_CITY']), 'city'));
  if (has('H_STATE')) { out.push(cand('state', 0.9, all(['H_STATE']), 'state')); if (has('S_DOC') || has('H_STATUS') || toks.some(x => x.t === 'release')) out.push(cand('status', 0.55, all(['H_STATE']), 'state as status')); }
  if (has('H_COUNTRY')) out.push(cand('country', 0.95, all(['H_COUNTRY']), 'country'));
  // ---- identifiers
  const idHead = has('H_ID');
  if (has('H_SERIAL') || (has('H_RECORD') && (idHead || only('H_RECORD')))) out.push(cand('row_id', 0.95, all(['H_SERIAL', 'H_RECORD', 'H_ID']), 'row id'));
  if (has('H_LINE') && !has('H_DATE')) out.push(cand('line_item', 0.9, all(['H_LINE', 'S_MAT']), 'line item'));
  if (has('S_MAT') && !has('H_NAME') && !has('H_DESC') && !has('H_CAT') && !has('H_QTY') && !has('H_LINE') && !has('H_PRICE') && !has('H_AMOUNT')) {
    const isItem = toks.some(x => x.t === 'item');
    if (idHead) out.push(cand('material_id', 0.95, all(['S_MAT', 'H_ID']), 'material id'), ...(isItem ? [cand('line_item', 0.5, all(['S_MAT', 'H_ID']), 'item number (ambiguous)')] : []));
    else if (only('S_MAT')) out.push(cand('material_id', isItem ? 0.55 : 0.78, all(['S_MAT']), 'material word alone'), ...(isItem ? [cand('line_item', 0.6, all(['S_MAT']), 'item alone')] : []));
  }
  if (has('S_ENT') && idHead) out.push(cand('entity_id', 0.95, all(['S_ENT', 'H_ID']), 'entity id'));
  if (has('H_REF')) out.push(cand('doc_ref', has('S_DOC') ? 0.9 : 0.85, all(['H_REF', 'S_DOC', 'H_ID']), 'reference'));
  if (has('S_DOC') && !dateHead && !has('H_DESC') && !has('H_NAME') && !has('H_CAT') && !has('H_STATUS') && !has('H_PRICE') && !has('H_AMOUNT') && !has('H_QTY') && !has('S_MAT') && !has('H_TIME') && !has('H_USER') && !has('H_STATE')) {
    if (idHead) out.push(cand('doc_id', 0.85, all(['S_DOC', 'H_ID']), 'document id'), cand('doc_ref', 0.78, all(['S_DOC', 'H_ID']), 'document id'));
    else if (only('S_DOC')) out.push(cand('doc_id', 0.75, all(['S_DOC']), 'document word alone'), cand('doc_ref', 0.68, all(['S_DOC']), 'document word alone'));
  }
  if (idHead && !has('S_ENT') && !has('S_MAT') && !has('S_DOC') && !has('H_REF') && !has('H_SERIAL') && !has('H_RECORD') && !has('H_POSTAL') && !has('H_LEGAL') && !has('H_TAX') && !has('H_PHONE') && !has('H_CONTACT') && !has('H_CURR') && !has('H_UOM') && !has('H_EMAIL') && !has('H_LINE')) {
    // a bare "Number" / "ID" / "Code" says nothing about WHAT it identifies: every reading stays a low-confidence alternative
    for (const r of ['row_id', 'entity_id', 'doc_id', 'doc_ref', 'material_id']) out.push(cand(r, 0.4, all(['H_ID']), 'generic identifier word'));
  }
  // ---- people and audit
  if (by && (has('M_CREATE') || has('M_MODIFY') || has('M_POST') || has('H_USER') || has('H_PERSON'))) out.push(cand('audit_user', 0.95, all(['H_BY', 'M_CREATE', 'M_MODIFY', 'M_POST', 'H_USER']), 'audit user'));
  else if (has('H_USER') && !has('H_DATE')) out.push(cand('audit_user', 0.65, all(['H_USER']), 'user word'));
  if (has('H_PERSON') && has('H_RESP')) out.push(cand('audit_user', 0.6, all(['H_PERSON', 'H_RESP']), 'person responsible'));
  // ---- dates and times (never when the header says "by")
  if (!by) {
    const dt = has('H_DATE'), tm = has('H_TIME');
    if (tm && !dt) out.push(cand('time_of_day', 0.92, all(['H_TIME', 'M_CREATE', 'M_MODIFY']), 'time'));
    if (has('M_CREATE') && !has('S_DOC')) out.push(cand('creation_date', dt ? 0.95 : (tm ? 0.4 : 0.65), all(['M_CREATE', 'H_DATE', 'H_TIME']), 'creation'));
    if (has('M_MODIFY')) out.push(cand('modification_date', dt ? 0.95 : (tm ? 0.4 : 0.62), all(['M_MODIFY', 'H_DATE', 'H_TIME']), 'modification'));
    if (has('M_POST')) out.push(cand('posting_date', dt ? 0.95 : 0.6, all(['M_POST', 'H_DATE']), 'posting'));
    if (has('S_DOC') && dt) out.push(cand('document_date', 0.9, all(['S_DOC', 'H_DATE']), 'document subject + date head'));
    if (has('M_VALID') && (dt || only('M_VALID'))) out.push(cand('effective_date', dt ? 0.85 : 0.5, all(['M_VALID', 'H_DATE']), 'validity'));
    if (dt && !has('M_CREATE') && !has('M_MODIFY') && !has('M_POST') && !has('S_DOC') && !has('M_VALID')) { out.push(cand('effective_date', 0.5, p.content.map(x => x), 'date (generic)')); for (const r of ['creation_date', 'modification_date', 'document_date', 'posting_date']) out.push(cand(r, 0.3, p.content.map(x => x), 'date (generic)')); }
  }
  if (toks.some(x => x.t === 'date')) return out.filter(c => familyOf(c.role) === 'date');
  if (countPhrase) return out.filter(c => familyOf(c.role) !== 'identifier');   // "number of X" is a count, never an identifier
  return out;
}
/** best score per role after the coverage discount */
function headerEvidence(header, cfg = {}) {
  const p = parse(header); const total = p.content.length; const neutral = new Set(p.content.filter(x => x.tags.has('NEUTRAL')));
  const per = new Map();
  for (const c of candidates(p)) {
    const used = new Set(c.used); for (const n of neutral) used.add(n);
    const explained = p.content.filter(x => used.has(x)).length; const coverage = total ? explained / total : 0;
    const score = c.weight * (0.35 + 0.65 * coverage);
    const prev = per.get(c.role); if (!prev || score > prev.score) per.set(c.role, { role: c.role, weight: c.weight, coverage: +coverage.toFixed(3), score: +score.toFixed(4), rule: c.rule, ambiguous: /ambiguous|generic/.test(c.rule) });
  }
  return { header, tokens: p.words, content_tokens: p.content.map(x => x.t), unexplained: p.content.filter(x => !x.tags.size || [...x.tags].every(t => t === 'NEUTRAL' && false)).map(x => x.t), candidates: [...per.values()].sort((a, b) => b.score - a.score), lexicon: LEXICON_VERSION };
}
module.exports = { LEXICON_VERSION, tokenize, parse, headerEvidence };
