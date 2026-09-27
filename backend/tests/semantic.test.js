'use strict';
/* S3 semantic layer: pure-function tests (no database). Role safety, ambiguity, dataset typing, requiredness, validation profiles, config, static guards. */
const { test } = require('node:test'); const assert = require('node:assert/strict'); const fs = require('fs'); const path = require('path');
const S = require('../src/semantic'); const { headerEvidence, tokenize } = require('../src/semantic/headerAnalysis'); const { mk, G } = require('./helpers/semanticFixtures');
const one = (header, fn, n = 60) => { const t = mk([[header, fn]], n); return S.analyzeSemantics(t.columns, t.rows).mappings[0]; };
const roleOf = (header, fn, n) => one(header, fn, n).role;

test('taxonomy: every charter role exists, grouped into the six families; extensions are marked', () => {
  const need = { identifier: ['legal_id', 'entity_id', 'material_id', 'doc_id', 'doc_ref', 'row_id'], person_audit: ['audit_user'], entity_attribute: ['name', 'address', 'city', 'state', 'postal_code', 'phone', 'email'],
    material_attribute: ['description', 'uom', 'quantity', 'unit_price', 'tax_rate'], date: ['creation_date', 'modification_date', 'effective_date', 'posting_date', 'document_date'], other: ['currency', 'payment_terms', 'status', 'unknown'] };
  for (const [fam, roles] of Object.entries(need)) for (const r of roles) { assert.ok(S.isRole(r), r); assert.equal(S.familyOf(r), fam, r); }
  assert.deepEqual(S.DATASET_TYPES, ['master_entity', 'master_material', 'transaction', 'mixed_unknown']); assert.deepEqual(S.REQUIREDNESS, ['required', 'expected', 'optional']);
  const ext = Object.entries(S.ROLES).filter(([, v]) => v.extra).map(([k]) => k).sort(); assert.deepEqual(ext, ['amount', 'category', 'country', 'entity_type', 'line_item', 'measure', 'time_of_day']);
});

test('header analysis uses whole words, never substrings (Intellectual Property is not a phone; a supplier word inside a sentence is not a supplier name)', () => {
  assert.equal(headerEvidence('Intellectual Property').candidates.length, 0);
  assert.equal(headerEvidence('Product allocation').candidates.length, 0);
  assert.equal(headerEvidence('Push Deployment from Supplier').candidates.filter(c => c.score >= 0.45).length, 0);
  assert.equal(headerEvidence('DF at client level').candidates.filter(c => c.score >= 0.45).length, 0);
  assert.deepEqual(tokenize('Min. Rem. Shelf Life').slice(0, 3), ['min', 'rem', 'shelf'], '"Rem." is not guessed to be "remark"'); assert.ok(!tokenize('Cont. Details').includes('contact') && !tokenize('Cont. Details').includes('contract'), 'an ambiguous prefix is left alone'); assert.deepEqual(tokenize('Cust. Name'), ['customer', 'name']); assert.deepEqual(tokenize('Vend. Code'), ['vendor', 'code']);
  assert.deepEqual(tokenize('CreatedBy'), ['created', 'by']); assert.deepEqual(tokenize('Base UoM'), ['base', 'uom']); assert.deepEqual(tokenize('Tax %'), ['tax', 'percent']); assert.deepEqual(tokenize('S.No'), ['serial', 'number']);
});

test('ROLE SAFETY: Created By / Changed By are audit users, never dates - even under headers that also say "date"-like things nearby', () => {
  for (const h of ['Created By', 'Changed By', 'Last Modified By', 'entered_by', 'UpdatedBy']) { const m = one(h, G.user); assert.equal(m.role, 'audit_user', h); assert.equal(m.role_family, 'person_audit'); }
  for (const h of ['Created By', 'Changed By']) assert.ok(!/date/.test(roleOf(h, G.user)));
});
test('ROLE SAFETY: document numbers that look like phone numbers are not phones (Entry Sheet / Purchasing Document), but real mobile numbers under a phone header are', () => {
  for (const h of ['Entry Sheet', 'Purchasing Document', 'Material']) { const m = one(h, G.digits10); assert.notEqual(m.role, 'phone', h); assert.ok(!m.alternatives.some(a => a.role === 'phone' && a.score >= 0.45), `${h} must not carry phone as a serious alternative`); }
  assert.equal(roleOf('Mobile', G.mobile), 'phone'); assert.equal(roleOf('Contact No.', G.mobile), 'phone');
  const bad = one('Mobile', G.digits10); assert.notEqual(bad.role, 'phone', 'a phone header over document-style numbers is a header/content conflict, not a phone'); assert.ok(bad.review_required); assert.ok(bad.review_reasons.some(r => /look like/.test(r)));
});
test('ROLE SAFETY: capacities / loads / allocations are never addresses; unrelated business text is never a company name; materials are never entity names', () => {
  assert.equal(roleOf('Maximum Capacity', G.qty), 'measure'); assert.equal(roleOf('Load Capacity', () => 0), 'measure');
  for (const h of ['Product allocation', 'Form Name', 'Push Deployment from Supplier', 'DF at client level', 'Intellectual Property']) { assert.notEqual(roleOf(h, () => null), 'address', h); assert.ok(!['name', 'address', 'phone', 'city'].includes(roleOf(h, () => null)), `${h} (empty)`); }
  for (const h of ['Form Name', 'Push Deployment from Supplier', 'DF at client level']) assert.notEqual(roleOf(h, G.company), 'name', `${h} over company-like text: header explains too little of the words`);
  assert.equal(roleOf('Material Description', G.freeText), 'description'); assert.notEqual(roleOf('Material Description', G.freeText), 'name'); assert.equal(roleOf('Item_Description', G.freeText), 'description');
});
test('ROLE SAFETY: a person-responsible header over date values is a header/content conflict: not a date role, flagged for review', () => {
  const m = one('Pers. Rsp. (Internally)', G.textDate); assert.ok(!/_date$/.test(m.role)); assert.notEqual(m.role, 'audit_user'); assert.ok(m.review_required); assert.ok(m.alternatives.some(a => a.role === 'audit_user')); assert.ok(m.review_reasons.some(r => /reads as audit_user/.test(r) && /date/.test(r)), 'the reason says what the header suggests AND what the values are: ' + m.review_reasons.join(' | '));
});
test('AMBIGUITY: a bare Number / ID / Code / Date / Name keeps every reading as an alternative, is not silently assigned a dangerous role, and needs review', () => {
  for (const h of ['Number', 'ID', 'Code', 'No.', 'Key']) { const m = one(h, G.digits10); assert.ok(!['phone', 'entity_id', 'doc_id', 'legal_id'].includes(m.role), `${h} -> ${m.role}`); assert.ok(m.review_required || m.role === 'unknown', h); assert.ok(m.alternatives.length >= 2, `${h} alternatives`); }
  const d = one('Date', G.date); assert.ok(d.review_required, 'a generic Date needs review'); assert.notEqual(d.confidence_tier, 'high');
  const n = one('Name', G.company); assert.notEqual(n.confidence_tier, 'high'); assert.ok(n.review_required);
});
test('MEDIUM/LOW confidence on high-impact roles always needs review; auto-accept only at HIGH tier without review reasons', () => {
  const t = mk([['Supplier Name', G.company], ['Vendor', G.company], ['Client', G.vendorCode], ['Ref', G.digits10]]); const r = S.analyzeSemantics(t.columns, t.rows);
  for (const m of r.mappings) if (m.role !== 'unknown' && (S.ROLES[m.role].critical || S.ROLES[m.role].risk === 'high') && m.confidence_tier !== 'high') assert.ok(m.review_required, `${m.header_raw} ${m.role} ${m.confidence_tier}`);
});
test('roles of SELF-IDENTIFYING content are found without helpful headers, but capped (content alone can never be as sure as header + content)', () => {
  const t = mk([['Col1', G.email], ['Col2', G.gstin], ['Col3', G.currency], ['Col4', G.state]]); const m = S.analyzeSemantics(t.columns, t.rows).mappings;
  assert.deepEqual(m.map(x => x.role), ['email', 'legal_id', 'currency', 'state']); for (const x of m) assert.ok(x.confidence <= S.DEFAULT_SEMANTIC_CONFIG.content_only_cap + 0.05 + 1e-9, `${x.header_raw} ${x.confidence}`);
  const t2 = mk([['Col1', G.digits10], ['Col2', G.matId], ['Col3', G.freeText]]); for (const x of S.analyzeSemantics(t2.columns, t2.rows).mappings) assert.ok(!['phone', 'legal_id', 'email', 'address', 'name'].includes(x.role), `${x.header_raw} -> ${x.role}`);
});
test('generalises to headers it has never seen (synonyms, abbreviations, punctuation, case, camelCase)', () => {
  const cases = [['Client Name', G.company, 'name'], ['Cust. Name', G.company, 'name'], ['VENDOR_CODE', G.vendorCode, 'entity_id'], ['Article No.', G.matId, 'material_id'], ['GSTN', G.gstin, 'legal_id'], ['Tax ID', G.gstin, 'legal_id'], ['Invoice Amount', G.price, 'amount'],
    ['Mobile Number', G.mobile, 'phone'], ['Pincode', G.pin, 'postal_code'], ['Zip', G.pin, 'postal_code'], ['District Town', G.city, 'city'], ['Ord. Qty', G.qty, 'quantity'], ['GST %', G.taxPct, 'tax_rate'], ['Ccy', G.currency, 'currency'],
    ['unit of measure', G.uom, 'uom'], ['Posting Date', G.date, 'posting_date'], ['DocumentDate', G.date, 'document_date'], ['Sl No', G.seq, 'row_id'], ['E-Mail Address', G.email, 'email'], ['Province', G.state, 'state'], ['Payment Terms', () => 'Net 30', 'payment_terms'], ['Street', G.address, 'address']];
  for (const [h, fn, want] of cases) assert.equal(roleOf(h, fn), want, h);
});
test('EMPTY columns: header alone never assigns a high-risk role unless the header is exact; confidence is capped and review is required', () => {
  const cfg = S.DEFAULT_SEMANTIC_CONFIG; for (const h of ['Phone', 'Email', 'GSTIN', 'Supplier Name', 'Postal Code']) { const m = one(h, () => null); if (m.role !== 'unknown') { assert.ok(m.confidence <= cfg.empty_column.confidence_cap, h); assert.ok(m.review_required, h); } }
  for (const h of ['Form Name', 'Contact Details', 'Address Notes', 'Phone Support Group']) assert.equal(roleOf(h, () => null), 'unknown', h);
});
test('DUPLICATE identity columns: the populated column is primary; an empty twin stays a separate mapping but does not claim the identity role', () => {
  const t = mk([['Material', G.matId, 'Material [A]'], ['Material', () => null, 'Material [B]'], ['Material Description', G.freeText, 'Material Description [C]'], ['Material Description', G.freeText, 'Material Description [D]']]); const r = S.analyzeSemantics(t.columns, t.rows).mappings;
  assert.equal(r.length, 4); assert.equal(r[0].role, 'material_id'); assert.equal(r[0].primary_for_role, true); assert.equal(r[1].role, 'unknown'); assert.ok(r[1].alternatives.some(a => a.role === 'material_id')); assert.equal(r[2].role, 'description'); assert.equal(r[3].role, 'description');
  assert.equal(r[1].requiredness, 'optional', 'the empty twin is never required'); assert.equal(r[0].requiredness, 'required');
  const two = mk([['Vendor Code', G.vendorCode, 'Vendor Code [A]'], ['Vendor Code', G.vendorCode, 'Vendor Code [B]']]); const m2 = S.analyzeSemantics(two.columns, two.rows).mappings; assert.ok(m2.some(m => m.review_required && /also holds/.test(m.review_reasons.join(' '))), 'two populated identity claims need review');
});
test('DATASET TYPE is evidence-based: entity, material and transaction shapes classify from their columns, whatever the headers are called', () => {
  const ent = mk([['Supplier Name', G.company], ['GST No', G.gstin], ['Supplier No.', G.vendorCode], ['E-mail', G.email], ['Mobile', G.mobile], ['Street', G.address], ['Town', G.city], ['Region', G.state], ['PIN', G.pin]]);
  const mat = mk([['Material', G.matId], ['Material Description', G.freeText], ['Base UoM', G.uom], ['Material Group', () => 'GRP' + 1], ['Gross Weight', G.qty], ['Net Weight', G.qty]]);
  const txn = mk([['Document Number', G.docNo], ['Reference', G.digits10], ['Posting Date', G.date], ['Document Date', G.date], ['Net Value', G.price], ['Currency', G.currency], ['Item', i => String((i % 5 + 1) * 10)]]);
  const T = t => S.analyzeSemantics(t.columns, t.rows).dataset; assert.equal(T(ent).dataset_type, 'master_entity'); assert.equal(T(mat).dataset_type, 'master_material'); assert.equal(T(txn).dataset_type, 'transaction');
  for (const d of [T(ent), T(mat), T(txn)]) { assert.ok(d.reasons.length && d.alternatives.length >= 2 && d.confidence > 0.5, JSON.stringify(d.reasons)); assert.equal(d.needs_review, false); }
  const shuffled = { columns: [...ent.columns].reverse().map((c, i) => ({ ...c, position: i })), rows: ent.rows }; assert.equal(T(shuffled).dataset_type, 'master_entity', 'column order does not matter');
});
test('DATASET TYPE: thin or split evidence is mixed_unknown and needs review; the classifier never guesses; a user override is honoured and remembers the suggestion', () => {
  const thin = mk([['Number', G.digits10], ['Text', G.freeText]]); const d1 = S.analyzeSemantics(thin.columns, thin.rows).dataset; assert.equal(d1.dataset_type, 'mixed_unknown'); assert.ok(d1.needs_review);
  const split = mk([['Supplier Name', G.company], ['GST No', G.gstin], ['Material', G.matId], ['Material Description', G.freeText], ['Base UoM', G.uom], ['Order Qty', G.qty]]); const d2 = S.analyzeSemantics(split.columns, split.rows).dataset;
  assert.ok(d2.alternatives.length >= 2 && d2.reasons.length);
  const tie = mk([['Supplier Name', G.company], ['GST No', G.gstin], ['Supplier No.', G.vendorCode], ['Material', G.matId], ['Material Description', G.freeText], ['Base UoM', G.uom], ['Material Group', () => 'GRP1'], ['Gross Weight', G.qty]]); const dt = S.analyzeSemantics(tie.columns, tie.rows).dataset;
  const sh = dt.evidence.scores; assert.ok(Math.abs(sh.master_entity.share - sh.master_material.share) < S.DEFAULT_SEMANTIC_CONFIG.dataset_type.min_margin, 'the fixture really is a near tie: ' + JSON.stringify([sh.master_entity.share, sh.master_material.share]));
  assert.equal(dt.dataset_type, 'mixed_unknown', 'a near tie between two dataset types is never resolved by picking one'); assert.equal(dt.needs_review, true); assert.ok(dt.alternatives.some(a => a.dataset_type === 'master_entity') && dt.alternatives.some(a => a.dataset_type === 'master_material'));
  const ov = S.analyzeSemantics(thin.columns, thin.rows, { datasetTypeOverride: { dataset_type: 'transaction', note: 'we know' } }).dataset; assert.equal(ov.dataset_type, 'transaction'); assert.equal(ov.source, 'user'); assert.equal(ov.suggested_type, 'mixed_unknown');
  assert.throws(() => S.analyzeSemantics(thin.columns, thin.rows, { datasetTypeOverride: { dataset_type: 'bogus' } }), /Unknown dataset type/);
});
test('ADVERSARIAL header/content: a person header over DATES, a date-word header over prices, "on" outside a date phrase, and "number of X" counts', () => {
  const cb = one('Created By', G.date); assert.ok(!/_date$/.test(cb.role), 'a Created By column that holds dates is bad data, not a creation date: ' + cb.role); assert.ok(cb.review_required);
  for (const h of ['Date Created By', 'Date Changed By']) { const d = one(h, G.date); assert.ok(!/_date$/.test(d.role), `${h}: a header that names a person AND a date is contradictory - never silently a date role (${d.role})`); assert.ok(d.review_required, h); }
  const mixed = one('Created By', i => (i % 10 === 0 ? G.date(i) : G.user(i))); assert.notEqual(mixed.role, 'audit_user', 'a person column polluted with dates is not trusted as an audit user'); assert.ok(mixed.review_required);
  const sale = one('Sale on Approval', G.date); assert.equal(sale.role, 'unknown', '"on" only marks a date after created / changed / posted'); assert.ok(sale.review_required);
  const pd = one('Price Date', G.price); assert.notEqual(pd.role, 'unit_price', 'a header that says "date" over price values is a conflict, not a price'); assert.ok(!['unit_price', 'amount'].includes(pd.role));
  for (const h of ['Number of Sheets', 'Number of Pages', 'No. of Documents']) { const n = one(h, G.digits10); assert.notEqual(n.role_family, 'identifier', `${h} -> ${n.role}`); }
});
test('identifiers that REPEAT are still identifiers (a catalog of item codes over many lines); one that never varies is not', () => {
  const rep = one('Item Code', i => 'MAT-' + (1000 + (i % 12)), 300); assert.equal(rep.role, 'material_id'); assert.equal(rep.confidence_tier, 'high', 'repeating catalog codes must not be penalised as if they were constant');
  assert.equal(rep.review_required, false, 'a confident material id must not be interrupted by a weaker losing reading of the same header (line_item)');
  const pos = one('Item', i => String((i % 5 + 1) * 10), 200); assert.equal(pos.role, 'line_item', '10/20/30... are line positions'); assert.equal(pos.review_required, false, 'a position column is not an ambiguity');
  const long = one('Item', i => String(400000 + i * 7), 200); assert.equal(long.role, 'material_id', 'long digit strings that vary are material numbers');
  const constant = one('Product', () => 'X-100', 300); assert.notEqual(constant.role, 'material_id', 'a value that never varies identifies nothing');
  const two = one('Product', i => (i % 2 ? 'X-100' : 'X-200'), 300); assert.notEqual(two.role, 'material_id');
});
test('SCALE: above the profiler\'s distinct-tracking cap (20,000) uniqueness stays exact, so a unique document id is still a doc_id, not a repetitive reference', () => {
  const n = 25000; const t = mk([['Entry Sheet', i => String(1000000000 + i)]], n); t.columns[0].distinct_count = n;   // exact figure supplied by ingest
  const P = S.profileColumns(t.columns, t.rows)[0]; assert.equal(P.distinct_capped, true); assert.equal(P.distinct, n); assert.equal(P.unique_ratio, 1);
  const m = S.analyzeSemantics(t.columns, t.rows).mappings[0]; assert.equal(m.role, 'doc_id'); assert.equal(m.confidence_tier, 'high');
  const rep = mk([['Purchasing Document', i => String(4500000000 + (i % 5000))]], n); rep.columns[0].distinct_count = 5000; assert.equal(S.analyzeSemantics(rep.columns, rep.rows).mappings[0].role, 'doc_ref', 'a genuinely repeating reference is still a reference at scale');
  assert.equal(S.versions(S.DEFAULT_SEMANTIC_CONFIG).profile, 'content-profile-1.2.0', 'profile version pin (bumped in S4: numeric-looking text counts as numeric)');
});
test('REVIEW rules stand on their own: ambiguous wording, close runner-up (configurable margin), weak content for a high-risk role', () => {
  const rate = one('Rate', G.price); assert.equal(rate.role, 'unit_price'); assert.ok(rate.review_required && rate.review_reasons.some(r => /ambiguous/.test(r)), 'a bare "Rate" is ambiguous wording even when the content clearly favours one reading');
  const ent = mk([['Entry Sheet', G.digits10]]); assert.equal(S.analyzeSemantics(ent.columns, ent.rows).mappings[0].review_required, false, 'at the default margin a clear document id is not flagged');
  const wide = S.analyzeSemantics(ent.columns, ent.rows, { config: { ambiguity_margin: 0.5, ambiguity_alt_min: 0.3 } }).mappings[0]; assert.ok(wide.review_required && wide.review_reasons.some(r => /nearly as likely/.test(r)), 'the ambiguity margin is configuration, not code: ' + wide.review_reasons.join('|'));
  const weak = one('Phone', i => (i % 5 < 2 ? G.mobile(i) : 'N/A')); assert.notEqual(weak.role, 'phone', 'a phone header over mostly non-phone values is not assigned a phone (high-risk role needs fitting content)'); assert.ok(weak.review_required);
});
test('PRIMARY column of a role: a populated column is preferred over an empty twin even when its own confidence is lower', () => {
  const base = S.profileColumns([{ header_key: 'a' }], mk([['a', G.vendorCode]], 100).rows)[0]; const weak = JSON.parse(JSON.stringify(base)); weak.kinds.text = 0.3;   // populated, but only 30% of its values look like codes
  const empty = { ...JSON.parse(JSON.stringify(base)), populated: 0, distinct: 0, unique_ratio: 0, kinds: { date: 0, date_unresolved: 0, date_invalid: 0, time: 0, number: 0, boolean: 0, text: 0, error: 0 }, text: null, number: null, sequence: null };
  const cols = [{ position: 0, header_key: 'Vendor Code [A]', header_raw: 'Vendor Code', header_normalized: 'vendor code' }, { position: 1, header_key: 'Vendor Code [B]', header_raw: 'Vendor Code', header_normalized: 'vendor code' }];
  const out = S.classifyColumns(cols, [weak, empty], S.DEFAULT_SEMANTIC_CONFIG); assert.equal(out[0].role, 'entity_id'); assert.ok(out[1].confidence >= out[0].confidence || out[1].role === 'unknown', 'the fixture makes the empty twin look at least as confident as the populated one before resolution');
  assert.equal(out[0].primary_for_role, true); assert.equal(out[1].role, 'unknown'); assert.equal(out[1].primary_for_role, false);
});
test('classification is deterministic: identical input gives byte-identical output', () => {
  const t = mk([['Supplier Name', G.company], ['GST No', G.gstin], ['Created By', G.user], ['Created On', G.date], ['Number', G.digits10]]); const a = JSON.stringify(S.analyzeSemantics(t.columns, t.rows)), b = JSON.stringify(S.analyzeSemantics(t.columns, t.rows)); assert.equal(a, b);
});

test('REQUIREDNESS: a heuristic can only ever say EXPECTED; only a user or a versioned rule can say REQUIRED; optional gaps are not defects; an empty required column is one dataset-level finding', () => {
  const cfg = S.DEFAULT_SEMANTIC_CONFIG; const prof = (pop, rows = 100) => ({ rows, populated: pop });
  const cols = [{ header_key: 'a', role: 'category', confidence: 0.9 }, { header_key: 'b', role: 'measure', confidence: 0.9 }, { header_key: 'c', role: 'unknown', confidence: 0.3 }, { header_key: 'd', role: 'status', confidence: 0.9 }];
  const r = S.resolveRequiredness(cols, [prof(100), prof(96), prof(100), prof(50)], 'mixed_unknown', cfg);   // mixed_unknown has NO rule defaults -> only the heuristic is in play
  assert.deepEqual(r.map(x => x.requiredness), ['expected', 'expected', 'optional', 'optional']); assert.ok(r.every(x => x.requiredness !== 'required'));
  assert.ok(r.filter(x => x.requiredness === 'expected').every(x => x.source === 'inferred'));
  const u = S.resolveRequiredness(cols, [prof(100), prof(96), prof(100), prof(50)], 'mixed_unknown', cfg, { a: { requiredness: 'required', note: 'ours' } }); assert.equal(u[0].requiredness, 'required'); assert.equal(u[0].source, 'user');
  assert.throws(() => S.resolveRequiredness(cols, [prof(1), prof(1), prof(1), prof(1)], 'mixed_unknown', cfg, { a: { requiredness: 'mandatory' } }), /requiredness must be one of/);
  const ruled = S.resolveRequiredness([{ header_key: 'n', role: 'name', confidence: 0.9, primary_for_role: true }, { header_key: 'n2', role: 'name', confidence: 0.9 }], [prof(100), prof(100)], 'master_entity', cfg); assert.equal(ruled[0].requiredness, 'required'); assert.equal(ruled[0].source, 'rule'); assert.equal(ruled[1].requiredness, 'optional', 'secondary column for a role');
  const d = (q, p, n) => S.missingDisposition(q, p, n, cfg);
  assert.deepEqual([d('optional', 0, 100).scope, d('optional', 40, 100).scope, d('optional', 40, 100).severity_candidate], ['none', 'none', 'none']);
  assert.deepEqual([d('required', 0, 100).scope, d('required', 0, 100).severity_candidate], ['dataset', 'high']); assert.deepEqual([d('expected', 0, 100).scope, d('expected', 0, 100).severity_candidate], ['dataset', 'low']);
  assert.deepEqual([d('required', 60, 100).scope, d('required', 60, 100).severity_candidate, d('expected', 60, 100).severity_candidate], ['record', 'high', 'low']); assert.equal(d('required', 100, 100).scope, 'none');
});
test('REQUIREDNESS property: no combination of role / population / dataset type can yield source=inferred with requiredness=required', () => {
  const cfg = S.DEFAULT_SEMANTIC_CONFIG; for (const type of S.DATASET_TYPES) for (const role of S.ROLE_NAMES) for (const pop of [0, 50, 94, 95, 100]) { const r = S.resolveRequiredness([{ header_key: 'x', role, confidence: 0.99, primary_for_role: true }], [{ rows: 100, populated: pop }], type, cfg)[0]; if (r.source === 'inferred') assert.notEqual(r.requiredness, 'required', `${type}/${role}/${pop}`); }
});
test('VALIDATION PROFILES attach by ROLE (never by header substring), only for trusted mappings; low-confidence mappings are held until reviewed', () => {
  const sus = mk([['Phone Support Email Notes', G.freeText], ['Email Sent Flag', () => 'Y'], ['GST Notes', G.freeText]]); const r = S.analyzeSemantics(sus.columns, sus.rows);
  for (const m of r.mappings) assert.ok(!m.validation_profile.validators.some(v => /email|legal|phone/.test(v.rule_id)), `${m.header_raw} -> ${m.role} must not receive email/phone/GST validators`);
  const t = mk([['Supplier Name', G.company], ['E-mail', G.email], ['GST No', G.gstin], ['Created On', G.date], ['Order Qty', G.qty]]); const ok = S.analyzeSemantics(t.columns, t.rows).mappings; const by = h => ok.find(m => m.header_raw === h);
  assert.deepEqual(by('E-mail').validation_profile.validators.map(v => v.rule_id), ['validity.email_format']); assert.equal(by('E-mail').validation_profile.status, 'active');
  assert.deepEqual(by('GST No').validation_profile.validators.map(v => v.rule_id), ['validity.legal_id_format']); assert.deepEqual(by('Created On').validation_profile.validators.map(v => v.rule_id), ['validity.date_calendar']);
  const low = S.buildValidationProfile('master_entity', { role: 'email', confidence_tier: 'low', review_required: true }, S.DEFAULT_SEMANTIC_CONFIG); assert.equal(low.status, 'pending_review'); assert.equal(S.buildValidationProfile('master_entity', { role: 'email', confidence_tier: 'low', review_required: true }, S.DEFAULT_SEMANTIC_CONFIG, true).status, 'active');
  assert.equal(S.buildValidationProfile('master_entity', { role: 'unknown', confidence_tier: 'low' }, S.DEFAULT_SEMANTIC_CONFIG).status, 'not_applicable'); assert.equal(S.buildValidationProfile('master_entity', { role: 'amount', confidence_tier: 'high' }, S.DEFAULT_SEMANTIC_CONFIG).status, 'not_applicable', 'profiles are dataset-aware');
});
test('CONFIG: versioned, hashed, immutable defaults; overrides change the hash; thresholds live in config, not code', () => {
  const c = S.DEFAULT_SEMANTIC_CONFIG; assert.throws(() => { 'use strict'; c.min_assign = 0; }); assert.throws(() => { 'use strict'; c.requiredness.rule_defaults.master_entity.name = 'optional'; });
  const h1 = S.hashConfig(c); assert.equal(S.hashConfig(S.resolveConfig()), h1); assert.notEqual(S.hashConfig(S.resolveConfig({ min_assign: 0.5 })), h1);
  assert.equal(c.requiredness.heuristic_expected_min_populated, 0.95); assert.equal(c.run_settings_defaults.stale_threshold_years, 4);
  const strict = S.resolveConfig({ dataset_type: { min_evidence: 999 } }); const t = mk([['Supplier Name', G.company], ['GST No', G.gstin], ['Supplier No.', G.vendorCode]]); assert.equal(S.analyzeSemantics(t.columns, t.rows, { config: strict }).dataset.dataset_type, 'mixed_unknown', 'a configured threshold changes the decision');
});

// ---- static guards
const SEM = path.join(__dirname, '..', 'src', 'semantic'); const pure = ['taxonomy', 'gazetteers', 'contentProfile', 'headerAnalysis', 'config', 'roleClassifier', 'datasetClassifier', 'requiredness', 'validationProfiles', 'index'];
const code = f => fs.readFileSync(path.join(SEM, f + '.js'), 'utf8').split('\n').filter(l => !/^\s*(\/\/|\/?\*)/.test(l)).join('\n');
test('STATIC: the pure semantic modules do no I/O and read no clock (deterministic, testable without a database)', () => {
  for (const f of pure) { const s = code(f); assert.ok(!/require\(['"](fs|node:fs|path|node:sqlite|\.\.\/db|http|https)['"]\)/.test(s), `${f} must not do I/O`); assert.ok(!/\bDate\b|Math\.random|process\.env/.test(s), `${f} must not read clock/randomness/env`); }
});
test('STATIC: no dataset-specific header phrase appears as a literal in the semantic code (general vocabulary only)', () => {
  const repo = path.join(__dirname, '..', '..'); const heads = new Set();
  for (const f of ['erp_dump', 'holdout', 'service_entry', 'material_master']) { const p = path.join(repo, 'qa/fixtures/headers', f + '.headers.json'); if (!fs.existsSync(p)) continue; const d = JSON.parse(fs.readFileSync(p, 'utf8')); const hs = d.headers || d.columns.map(c => c.header); for (const h of hs) if (h.trim().split(/[\s._-]+/).filter(Boolean).length >= 2) heads.add(h.trim().toLowerCase()); }
  assert.ok(heads.size > 50, 'header fixtures loaded');
  const bad = []; for (const f of fs.readdirSync(SEM).filter(x => x.endsWith('.js'))) { const s = code(f.replace(/\.js$/, '')); for (const m of s.matchAll(/(['"`])((?:(?!\1)[^\\\n]|\\.)*)\1/g)) { const lit = m[2].trim().toLowerCase(); if (S.isRole(lit) || S.DATASET_TYPES.includes(lit)) continue;   // the product's own taxonomy names are not dataset headers
      if (heads.has(lit)) bad.push(`${f}: "${m[2]}"`); } }
  assert.deepEqual(bad, [], 'a full multi-word header from a test dataset is hard-coded');
});
test('S4 DUPLICATE non-critical roles: the requiredness default goes to the column that is substantially POPULATED, not to a sparse twin that merely has higher confidence', () => {
  const cfg = S.DEFAULT_SEMANTIC_CONFIG; const prof = (pop, rows = 100) => ({ rows, populated: pop });
  const twins = (confA, confB) => [{ header_key: 'a', role: 'city', confidence: confA }, { header_key: 'b', role: 'city', confidence: confB }];
  const sparseFirst = S.resolveRequiredness(twins(0.95, 0.7), [prof(9), prof(100)], 'master_entity', cfg);      // a: 9% populated, more confident; b: 100% populated
  assert.deepEqual(sparseFirst.map(x => x.requiredness), ['optional', 'expected'], 'the dense column carries the default; the sparse twin is optional (its gaps are never defects)');
  const denseFirst = S.resolveRequiredness(twins(0.7, 0.95), [prof(100), prof(9)], 'master_entity', cfg); assert.deepEqual(denseFirst.map(x => x.requiredness), ['expected', 'optional']);
  const tie = S.resolveRequiredness(twins(0.7, 0.95), [prof(100), prof(100)], 'master_entity', cfg); assert.deepEqual(tie.map(x => x.requiredness), ['optional', 'expected'], 'equally populated: confidence decides');
});

test('REQUIREDNESS DEFAULTS are exactly the explicitly approved S3 list (S4 approval, decision 4): nothing else is expected by default; config version bumped', () => {
  const d = S.DEFAULT_SEMANTIC_CONFIG.requiredness.rule_defaults; assert.deepEqual(d.master_material, { material_id: 'required', description: 'required', uom: 'required' }); assert.deepEqual(d.transaction, { doc_id: 'required' });
  assert.deepEqual(Object.keys(d.master_entity).sort(), ['address', 'city', 'creation_date', 'email', 'entity_id', 'legal_id', 'name', 'phone', 'postal_code']); assert.deepEqual(d.mixed_unknown, {}); for (const t of ['category', 'creation_date', 'doc_ref', 'posting_date', 'document_date', 'amount', 'currency', 'line_item']) assert.equal([d.master_material, d.transaction].some(x => t in x), false, t + ' must not be an automatic defect'); assert.equal(S.DEFAULT_SEMANTIC_CONFIG.version, 'semantic-config-1.1.0');
});
