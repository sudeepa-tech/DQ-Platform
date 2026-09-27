'use strict';
/* S3 acceptance: semantic roles + dataset understanding, verified on the four real datasets through what the semantic layer PERSISTED (canonical ingest -> profile -> mapping set) in a real temp database.
   Expectations come from INDEPENDENT truth (S0 truth files, the oracle's canonical field map, the ingest oracle's physical facts) - never from the code under test. The SAP files carry no dataset-type label in the oracle
   (baselines are label-free), so their expected types are pre-registered below from the S3 charter's own description of the files (Material Master = material master; Service Entry Sheet = transaction).
   Real-SAP tests skip (never pass vacuously) if the files are absent: set DQ_SAP_DIR.
   RT-70 dataset type   RT-71 Material Master   RT-72 Service Entry   RT-73 ERP_Dump + hold-out vs the oracle's canonical field map   RT-74 persistence / physical integrity   RT-75 determinism + perturbation
   RT-76 no dataset/file awareness + S4/S5 scope guard   RT-67 requiredness sources [S3 contract]   RT-68 auto-accept only at HIGH [S3 contract]   RT-77 immutable configuration + versioning   */
const { describe, it, before, test } = require('node:test'); const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const REPO = path.resolve(__dirname, '..', '..'); const UP = process.env.DQ_SAP_DIR || '/mnt/user-data/uploads';
const { DatabaseSync } = require('node:sqlite'); const { migrate } = require(path.join(REPO, 'backend/src/db/migrate')); const { ingestFile } = require(path.join(REPO, 'backend/src/ingest'));
const { openSource } = require(path.join(REPO, 'backend/src/ingest/reader')); const { readCanonical } = require(path.join(REPO, 'backend/src/ingest/canonicalize'));
const S = require(path.join(REPO, 'backend/src/semantic')); const svc = require(path.join(REPO, 'backend/src/semantic/schemaService')); const cs = require(path.join(REPO, 'backend/src/semantic/configSnapshot'));
const T = n => JSON.parse(fs.readFileSync(path.join(REPO, 'qa/oracle/truth', n)));
const INGEST = T('ingest.truth.json'), ERP = T('erp_dump.truth.json'), HOLD = T('holdout.truth.json'), MM = T('material_master.baseline.json'), SE = T('service_entry.baseline.json'), HOLD_EXPECTED = JSON.parse(fs.readFileSync(path.join(REPO, 'qa/oracle/holdout.expected_roles.json')));
const FILES = { service_entry: [`${UP}/Service_Entry_Sheet_23_09_2026.xlsx`, undefined], material_master: [`${UP}/Material_Master_23_09_2026.xlsx`, undefined],
  holdout: [path.join(REPO, 'qa/fixtures/holdout_master_entity.xlsx'), 'Vendor_Master'], erp_dump: [path.join(REPO, 'qa/fixtures/ERP_DQ_Authenticity_Test_Dump.xlsx'), 'ERP_Dump'] };
// pre-registered from the charter (the oracle has no label for the SAP files); ERP_Dump / hold-out come from the oracle itself
const EXPECTED_TYPE = { erp_dump: ERP.meta.mapping.semantics.table_type, holdout: HOLD.meta.mapping.semantics.table_type, material_master: 'master_material', service_entry: 'transaction' };
// the oracle's canonical field names -> the S3 taxonomy (test tooling; the oracle keeps its own vocabulary)
const ORACLE_TO_ROLE = { row_id: 'row_id', entity_type: 'entity_type', name: 'name', gstin: 'legal_id', vendor_code: 'entity_id', item_code: 'material_id', item_desc: 'description', uom: 'uom', quantity: 'quantity', unit_price: 'unit_price', tax_rate: 'tax_rate',
  email: 'email', phone: 'phone', address: 'address', city: 'city', state: 'state', postal: 'postal_code', created: 'creation_date', modified: 'modification_date', payment_terms: 'payment_terms', currency: 'currency' };
// baseline vocabulary (S0 truth files) -> taxonomy, for "no column may be mapped to ..."
const BASE_TO_ROLE = { entity_name: 'name', gstin: 'legal_id', email: 'email', phone: 'phone', address: 'address', address_street: 'address', material_key: 'material_id', created_date: 'creation_date', modified_date: 'modification_date' };

let db, R = {}, M = {}; const missing = n => (fs.existsSync(FILES[n][0]) ? false : `file not found (${FILES[n][0]})`);
const byHeader = (model, h) => model.columns.filter(c => c.header_raw.trim() === h);
const first = (model, h) => byHeader(model, h)[0];
const snap = (t, w, ...a) => crypto.createHash('sha256').update(JSON.stringify(db.prepare(`SELECT * FROM ${t} WHERE ${w}`).all(...a))).digest('hex');
const mem = n => { const [file, sheet] = FILES[n]; const c = readCanonical(openSource(file, { sheetName: sheet }), {}); return { c, r: S.analyzeSemantics(c.columns, c.rows) }; };
const DANGEROUS = ['phone', 'legal_id', 'email', 'address', 'name'];

before(() => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dq-rt13-')), 't.db'); db = new DatabaseSync(f); db.exec('PRAGMA foreign_keys=ON'); migrate(db, { dbFile: f });
  db.exec("INSERT INTO organizations(id,name) VALUES('o','O'); INSERT INTO users(id,organization_id,name,email,password_hash,role) VALUES('u','o','U','u@x','x','admin')");
  let i = 0; for (const [n, [file, sheet]] of Object.entries(FILES)) if (fs.existsSync(file)) { const d = 'ds' + (++i); db.prepare('INSERT INTO datasets(id,organization_id,name) VALUES(?,?,?)').run(d, 'o', n); R[n] = { ...ingestFile(db, { datasetId: d, filePath: file, sheetName: sheet }), datasetId: d }; svc.suggestMapping(db, R[n].sourceFileId, { userId: 'u' }); M[n] = svc.getReviewModel(db, R[n].sourceFileId, 1); }
});

describe('RT-70 dataset type is evidence-based and correct on all four datasets', () => {
  for (const n of Object.keys(FILES)) it(`[${n}] classified as ${EXPECTED_TYPE[n]} with reasons, alternatives and no review flag`, { skip: missing(n) }, () => {
    const d = M[n].dataset_type; assert.equal(d.value, EXPECTED_TYPE[n]); assert.equal(d.source, 'classifier'); assert.ok(d.confidence >= 0.6, `confidence ${d.confidence}`); assert.equal(d.needs_review, false); assert.ok(d.reasons.length >= 1); assert.ok(d.alternatives.length >= 2);
  });
  it('it is the COLUMNS that decide: opaque headers lower confidence; removing the identity columns changes the type', { skip: missing('erp_dump') }, () => {
    const { c, r } = mem('erp_dump'); const opaque = c.columns.map((x, i) => ({ ...x, header_raw: 'Col' + i, header_normalized: 'col' + i })); const ro = S.analyzeSemantics(opaque, c.rows).dataset;
    assert.ok(ro.dataset_type === 'mixed_unknown' || ro.confidence < r.dataset.confidence, `opaque headers must not classify as confidently as real ones (${ro.dataset_type} ${ro.confidence} vs ${r.dataset.confidence})`);
    const idCols = new Set(Object.entries(ERP.meta.mapping.columns).filter(([k]) => ['name', 'gstin', 'vendor_code', 'email', 'phone', 'address', 'entity_type', 'city', 'state', 'postal'].includes(k)).map(([, v]) => v));
    const keep = c.columns.filter(x => !idCols.has(x.header_raw)); const stripped = S.analyzeSemantics(keep, c.rows).dataset; assert.notEqual(stripped.dataset_type, 'master_entity', 'without any entity-identity columns it is not an entity master');
    const { c: h, r: hr } = mem('holdout'); const matIds = new Set([HOLD.meta.mapping.columns.item_code, HOLD.meta.mapping.columns.item_desc, HOLD.meta.mapping.columns.uom, HOLD.meta.mapping.columns.quantity, HOLD.meta.mapping.columns.unit_price, HOLD.meta.mapping.columns.tax_rate]);
    assert.equal(S.analyzeSemantics(h.columns.filter(x => !matIds.has(x.header_raw)), h.rows).dataset.dataset_type, 'master_entity', 'dropping the item columns leaves an entity master'); assert.ok(hr.dataset.confidence > 0);
  });
});

describe('RT-71 Material Master (real SAP export)', { skip: missing('material_master') }, () => {
  it('308 physical columns are all mapped; headers equal the independent truth, byte for byte, in order', () => {
    const tr = INGEST.material_master; assert.equal(M.material_master.columns.length, tr.physical_columns); assert.deepEqual(M.material_master.columns.map(c => c.header_raw), tr.columns.map(c => c.header));
    assert.equal(new Set(M.material_master.columns.map(c => c.file_column_id)).size, tr.physical_columns);
  });
  it('Material is the material_id; every other column with the header "Material" is a separate physical column that does NOT claim it', () => {
    const tr = INGEST.material_master; const mats = byHeader(M.material_master, 'Material'); assert.ok(mats.length >= 2, 'the export carries a duplicate Material column'); assert.equal(mats.length, tr.columns.filter(c => c.header === 'Material').length);
    assert.equal(mats.filter(c => c.role === 'material_id').length, 1); const primary = mats.find(c => c.role === 'material_id'); assert.equal(primary.confidence_tier, 'high'); assert.equal(primary.requiredness.value, 'required'); assert.equal(primary.is_empty, false);
    for (const c of mats.filter(x => x !== primary)) { const truthCol = tr.columns[c.position]; assert.equal(truthCol.populated, 0, 'the twin is empty in the independent truth'); assert.equal(c.role, 'unknown'); assert.equal(c.requiredness.value, 'optional'); assert.notEqual(c.file_column_id, primary.file_column_id); }
  });
  it('no column is mapped to a role the baseline forbids (name / GSTIN / e-mail / phone / address), and the S0 traps hold', () => {
    const forbidden = MM.expected_roles.no_column_may_be_mapped_to.map(x => BASE_TO_ROLE[x]).filter(Boolean); const bad = M.material_master.columns.filter(c => forbidden.includes(c.role)).map(c => `${c.header_key}->${c.role}`); assert.deepEqual(bad, []);
    for (const h of ['Product allocation', 'Maximum Capacity', 'Load Capacity', 'Intellectual Property', 'Form Name', 'DF at client level', 'Push Deployment from Supplier']) for (const c of byHeader(M.material_master, h)) assert.ok(!['address', 'city', 'phone', 'name', 'quantity'].includes(c.role), `${h} -> ${c.role}`);
    assert.equal(first(M.material_master, 'Created By').role, 'audit_user'); assert.ok(!/date/.test(first(M.material_master, 'Created At Time').role)); for (const c of byHeader(M.material_master, 'Material Description')) assert.equal(c.role, 'description');
    assert.equal(byHeader(M.material_master, 'Material description').every(c => c.role === 'description'), true);
  });
  it('the empty columns do NOT become record-level completeness defects: none has record scope; an empty REQUIRED/EXPECTED column is exactly one dataset-level finding', () => {
    const emptyIdx = new Set(INGEST.material_master.columns.filter(c => c.populated === 0).map(c => c.index)); assert.equal(emptyIdx.size, INGEST.material_master.empty_columns);
    const rows = M.material_master.source_file.data_row_count; let recordLevel = 0, datasetLevel = 0;
    for (const c of M.material_master.columns.filter(x => emptyIdx.has(x.position))) { assert.equal(c.is_empty, true); const d = c.requiredness.if_missing; if (d.scope === 'record') recordLevel += rows; if (d.scope === 'dataset') { datasetLevel += 1; assert.ok(['required', 'expected'].includes(c.requiredness.value)); } assert.notEqual(d.scope, 'record', `${c.header_key}`); }
    assert.equal(recordLevel, 0); assert.ok(datasetLevel <= emptyIdx.size);
    const optionalEmpty = M.material_master.columns.filter(x => emptyIdx.has(x.position) && x.requiredness.value === 'optional'); assert.ok(optionalEmpty.length > 0.9 * emptyIdx.size, 'nearly all empty columns are simply optional'); for (const c of optionalEmpty) assert.equal(c.requiredness.if_missing.severity_candidate, 'none');
  });
});

describe('RT-72 Service Entry (real SAP export)', { skip: missing('service_entry') }, () => {
  it('Entry Sheet is a document id, Purchasing Document a document reference, Created By / Changed By are audit users (never dates)', () => {
    const m = M.service_entry; assert.equal(first(m, 'Entry Sheet').role, 'doc_id'); assert.equal(first(m, 'Purchasing Document').role, 'doc_ref'); assert.equal(first(m, 'Created By').role, 'audit_user'); assert.equal(first(m, 'Changed By').role, 'audit_user');
    assert.equal(first(m, 'Created On').role, 'creation_date'); assert.equal(first(m, 'Changed On').role, 'modification_date'); assert.equal(first(m, 'Gross Value').role, 'amount'); assert.equal(first(m, 'Currency').role, 'currency');
    for (const h of ['Entry Sheet', 'Purchasing Document']) assert.ok(!['phone', 'quantity'].includes(first(m, h).role));
  });
  it('person-responsible columns (text dates under a person header) are NOT guessed as dates: not a date role, needs review, status stays suggested', () => {
    for (const h of ['Pers. Rsp. (Internally)', 'Person Resp. (Externally)']) { const c = first(M.service_entry, h); assert.ok(!/date/.test(c.role), `${h} -> ${c.role}`); assert.equal(c.review_required, true); assert.equal(c.status, 'suggested'); assert.ok(c.review_reasons.some(r => /reads as audit_user/.test(r) && /date/.test(r)), 'the reason names what the header suggests AND what the values actually look like: ' + c.review_reasons.join(' | ')); }
  });
  it('the three Item columns stay three separately addressable physical columns', () => {
    const items = byHeader(M.service_entry, 'Item'); assert.equal(items.length, INGEST.service_entry.columns.filter(c => c.header === 'Item').length); assert.equal(items.length, 3); assert.equal(new Set(items.map(c => c.file_column_id)).size, 3); assert.equal(new Set(items.map(c => c.header_key)).size, 3);
    for (const c of items) assert.equal(c.role, 'line_item');
  });
  it('no column is mapped to a role the baseline forbids for this file (material key, entity name, GSTIN, e-mail, street address)', () => {
    const forbidden = SE.expected_roles.no_column_may_be_mapped_to.map(x => BASE_TO_ROLE[x]).filter(Boolean); assert.deepEqual(M.service_entry.columns.filter(c => forbidden.includes(c.role)).map(c => `${c.header_key}->${c.role}`), []);
    const short = first(M.service_entry, 'Short Text'); assert.notEqual(short.role, 'name'); assert.equal(short.role, 'description');
  });
});

describe('RT-73 ERP_Dump and hold-out against the ORACLE canonical field map (same rules, different headers, no fixture-specific code)', () => {
  for (const [n, truth] of [['erp_dump', ERP], ['holdout', HOLD]]) it(`[${n}] every mapped oracle field gets its expected role`, { skip: missing(n) }, () => {
    const cols = truth.meta.mapping.columns; const bad = [];
    for (const [field, header] of Object.entries(cols)) { const want = ORACLE_TO_ROLE[field]; assert.ok(want, `unmapped oracle field ${field}`); const c = first(M[n], header); if (!c) { bad.push(`${header}: missing`); continue; } if (c.role !== want) bad.push(`${header}: want ${want} got ${c.role} (${c.confidence_tier})`); }
    const ic = first(M[n], cols.item_code); assert.equal(ic.confidence_tier, 'high', `item code repeats across lines by design; it is still a high-confidence material_id (got ${ic.confidence})`);
    const measured = 1 - bad.length / Object.keys(cols).length; if (n === 'holdout') assert.ok(measured >= 0.85, `pre-registered bar 85%, measured ${(measured * 100).toFixed(0)}%`); assert.deepEqual(bad, [], `${(measured * 100).toFixed(0)}% of oracle fields`);
  });
  it('the pre-registered hold-out classes (S0) are all recovered', { skip: missing('holdout') }, () => {
    const QA = require(path.join(REPO, 'qa/harness/engine_facade')); const bad = []; for (const [h, want] of Object.entries(HOLD_EXPECTED)) { if (h.startsWith('_')) continue; const c = first(M.holdout, h); const got = (QA.V1_TO_QA[c.role] || c.role); if (!QA.acceptsClass(want, got)) bad.push(`${h}: want ${want} got ${got}`); } assert.deepEqual(bad, []);
  });
  it('the two files produce the same role structure although every header differs (vocabulary generalises)', { skip: missing('erp_dump') || missing('holdout') }, () => {
    const roles = m => m.columns.map(c => c.role).sort(); assert.deepEqual(roles(M.holdout), roles(M.erp_dump));
  });
});

describe('RT-74 persistence keeps every physical column and equals the pure classification', () => {
  for (const n of Object.keys(FILES)) it(`[${n}] one mapping per physical column; empty flags equal the independent truth; DB roles == in-memory roles`, { skip: missing(n) }, () => {
    const tr = INGEST[n]; const m = M[n]; assert.equal(m.columns.length, tr.physical_columns); assert.equal(db.prepare('SELECT COUNT(*) c FROM schema_mappings WHERE source_file_id = ? AND mapping_version = 1').get(R[n].sourceFileId).c, tr.physical_columns);
    assert.deepEqual(m.columns.map(c => c.is_empty), tr.columns.map(c => c.populated === 0)); assert.equal(m.columns.filter(c => c.is_empty).length, tr.empty_columns);
    const { r } = mem(n); assert.deepEqual(m.columns.map(c => c.role), r.mappings.map(x => x.role)); assert.deepEqual(m.columns.map(c => c.requiredness.value), r.mappings.map(x => x.requiredness));
    const dup = {}; for (const c of tr.columns) dup[c.header] = (dup[c.header] || 0) + 1; for (const [h, k] of Object.entries(dup)) if (k > 1) { const g = byHeader(m, h); assert.equal(g.length, k, `duplicate header group "${h}"`); assert.equal(new Set(g.map(x => x.file_column_id)).size, k); }
  });
});

describe('RT-75 determinism and perturbation invariance', () => {
  for (const n of ['erp_dump', 'holdout', 'service_entry']) it(`[${n}] identical output twice; column order does not matter; header case / punctuation does not change any assigned role`, { skip: missing(n) }, () => {
    const { c, r } = mem(n); assert.equal(JSON.stringify(S.analyzeSemantics(c.columns, c.rows)), JSON.stringify(r));
    const rev = [...c.columns].reverse().map((x, i) => ({ ...x, position: i })); const rr = S.analyzeSemantics(rev, c.rows); const want = new Map(r.mappings.map(m => [m.header_key, m.role])); for (const m of rr.mappings) assert.equal(m.role, want.get(m.header_key), `order changed ${m.header_key}`); assert.equal(rr.dataset.dataset_type, r.dataset.dataset_type);
    for (const [label, f] of [['UPPER', h => h.toUpperCase()], ['lower', h => h.toLowerCase()], ['underscored', h => h.replace(/[\s.]+/g, '_')], ['padded', h => `  ${h}  `]]) { const cols = c.columns.map(x => ({ ...x, header_raw: f(x.header_raw), header_normalized: f(x.header_raw).toLowerCase().trim() })); const rp = S.analyzeSemantics(cols, c.rows); const diff = rp.mappings.map((m, i) => [c.columns[i].header_raw, r.mappings[i].role, m.role]).filter(([, a, b]) => a !== b); assert.deepEqual(diff, [], `${label} changed roles`); }
  });
  for (const n of ['service_entry', 'material_master']) it(`[${n}] with every header stripped to an opaque name no column becomes a dangerous role from content that merely looks like one (document numbers are not phones)`, { skip: missing(n) }, () => {
    const { c } = mem(n); const opaque = c.columns.map((x, i) => ({ ...x, header_raw: 'Col' + i, header_normalized: 'col' + i })); const r = S.analyzeSemantics(opaque, c.rows);
    const bad = r.mappings.filter(m => DANGEROUS.includes(m.role)).map(m => `${c.columns[m.position].header_raw}->${m.role}`); assert.deepEqual(bad, [], 'content alone never invents a phone / GSTIN / e-mail / address / company name here');
  });
});

describe('RT-76 no dataset/file awareness; S4/S5 logic was not smuggled into S3', () => {
  const SEM = path.join(REPO, 'backend/src/semantic'); const src = f => fs.readFileSync(path.join(SEM, f), 'utf8').split('\n').filter(l => !/^\s*(\/\/|\/?\*)/.test(l)).join('\n');
  it('the classifier never receives or reads file names, sheet names or dataset names', () => {
    for (const f of ['taxonomy.js', 'gazetteers.js', 'contentProfile.js', 'headerAnalysis.js', 'config.js', 'roleClassifier.js', 'datasetClassifier.js', 'requiredness.js', 'validationProfiles.js', 'index.js']) assert.doesNotMatch(src(f), /original_filename|sheet_name|stored_path|dataset_id|\.xlsx|\.csv/i, f);
    assert.doesNotMatch(src('schemaService.js') + src('configSnapshot.js'), /analyzeSemantics\([^)]*original_filename|classifyDataset\([^)]*original_filename/);
  });
  it('S3 contains no matching, fuzzy, clustering, scoring or staleness logic', () => {
    for (const f of fs.readdirSync(SEM).filter(x => x.endsWith('.js'))) { const s = src(f).replace(/stale_threshold_years/g, '').replace(/run_settings_defaults/g, ''); assert.doesNotMatch(s, /levenshtein|jaro|fuzzy|cluster|similarity|health_score|consistency_score|match_pairs|entity_clusters|is_stale|stale_/i, f); }
  });
  it('S6: the live upload/analyze route DOES use the S3 semantic layer now (the pipeline is wired in), and no legacy engine module is required from anywhere under backend/src', () => {
    const upload = fs.readFileSync(path.join(REPO, 'backend/src/routes/datasets.js'), 'utf8');
    assert.match(upload, /semantic|schemaService|suggestMapping/, 'S6 wires the confirmed-mapping gate into the production upload/analyze route');
    const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
    for (const f of walk(path.join(REPO, 'backend/src')).filter(f => f.endsWith('.js'))) {
      assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /require\(['"].*legacy_v0/, path.relative(REPO, f) + ': production code must not require the quarantined legacy engine');
    }
  });
});

describe('RT-67 [S3 contract] no heuristic (populated %, header text) can ever make a field REQUIRED; only user / rule / SAP-domain sources can', () => {
  for (const n of Object.keys(FILES)) it(`[${n}] every REQUIRED column has source user | rule | sap_domain - never inferred`, { skip: missing(n) }, () => {
    const bad = M[n].columns.filter(c => c.requiredness.value === 'required' && !['user', 'rule', 'sap_domain'].includes(c.requiredness.source)).map(c => c.header_key); assert.deepEqual(bad, []);
    const heur = M[n].columns.filter(c => c.requiredness.source === 'inferred'); assert.ok(heur.every(c => c.requiredness.value !== 'required'));
    const wellPopulated = M[n].columns.filter(c => c.populated_ratio >= 0.95 && c.requiredness.source === 'inferred'); assert.ok(wellPopulated.every(c => ['expected', 'optional'].includes(c.requiredness.value)), '>=95% populated by itself can never rise above EXPECTED (an unidentified role stays optional)'); assert.ok(wellPopulated.some(c => c.requiredness.value === 'expected'), 'the heuristic does reach EXPECTED for identified roles');
  });
  it('forcing a mixed_unknown dataset (no rule defaults exist) leaves NOTHING required, however well populated', { skip: missing('holdout') }, () => {
    const { c } = mem('holdout'); const r = S.analyzeSemantics(c.columns, c.rows, { datasetTypeOverride: { dataset_type: 'mixed_unknown' } }); assert.equal(r.mappings.filter(m => m.requiredness === 'required').length, 0); assert.ok(r.mappings.some(m => m.requiredness === 'expected'));
  });
});
describe('RT-68 [S3 contract] a schema mapping is auto-accepted only at HIGH confidence; medium/low always require a human decision', () => {
  for (const n of Object.keys(FILES)) it(`[${n}] auto_accepted => high tier and no review flag; medium/low/flagged => suggested; confirm is gated on exactly the flagged columns`, { skip: missing(n) }, () => {
    const cols = M[n].columns; for (const c of cols) { if (c.status === 'auto_accepted') { assert.equal(c.confidence_tier, 'high', c.header_key); assert.equal(c.review_required, false, c.header_key); } if (c.confidence_tier !== 'high' || c.review_required) assert.equal(c.status, 'suggested', `${c.header_key} ${c.confidence_tier}`); }
    const open = cols.filter(c => c.review_required && c.status === 'suggested').map(c => c.file_column_id).sort();
    if (open.length) { try { svc.confirmMapping(db, R[n].sourceFileId, 1, { userId: 'u' }); assert.fail('confirm must be blocked while flagged columns are undecided'); } catch (e) { assert.equal(e.status, 409); assert.deepEqual(e.unresolved.map(x => x.file_column_id).sort(), open); } }
  });
});

describe('RT-77 immutable configuration + versioning (real Material Master)', { skip: missing('material_master') }, () => {
  it('lock -> config snapshot -> revise + change requiredness -> NEW mapping version and NEW configuration; nothing already confirmed is touched', () => {
    const sf = R.material_master.sourceFileId, ds = R.material_master.datasetId; svc.confirmMapping(db, sf, 1, { userId: 'u', acceptSuggestions: true });
    const c1 = cs.createAnalysisConfig(db, { datasetId: ds, sources: [{ source_file_id: sf, mapping_version: 1 }], userId: 'u' }); const s1 = cs.getAnalysisConfig(db, c1.config_id).config.snapshot;
    assert.equal(s1.sources[0].mapping_version, 1); assert.equal(s1.semantic.engine_version, S.SEMANTIC_ENGINE_VERSION); assert.equal(s1.semantic.taxonomy_version, S.TAXONOMY_VERSION); assert.equal(s1.semantic.config_hash, S.hashConfig(s1.semantic.config)); assert.equal(s1.sources[0].columns.length, 308);
    const cfgBefore = snap('analysis_configs', 'id = ?', c1.config_id), v1Before = snap('schema_mappings', 'source_file_id = ? AND mapping_version = 1', sf);
    assert.throws(() => db.prepare("UPDATE schema_mappings SET requiredness='required' WHERE source_file_id = ? AND mapping_version = 1").run(sf), /locked mapping set is immutable/);
    const rev = svc.reviseMapping(db, sf, 1, 'u', 'buyer wants Material Group required'); assert.deepEqual([rev.version, rev.parent_version], [2, 1]); const grp = first(svc.getReviewModel(db, sf, 2), 'Material Group');
    svc.overrideColumn(db, sf, 2, grp.file_column_id, { requiredness: 'required', note: 'mandatory for costing' }, 'u'); svc.confirmMapping(db, sf, 2, { userId: 'u', acceptSuggestions: true });
    const c2 = cs.createAnalysisConfig(db, { datasetId: ds, sources: [{ source_file_id: sf, mapping_version: 2 }], userId: 'u' }); assert.notEqual(c2.config_hash, c1.config_hash); assert.equal(c2.version, c1.version + 1);
    const s2 = cs.getAnalysisConfig(db, c2.config_id).config.snapshot; assert.equal(s2.sources[0].mapping_version, 2); assert.equal(s2.sources[0].columns.find(c => c.header_raw === 'Material Group').requiredness, 'required'); assert.notEqual(s1.sources[0].columns.find(c => c.header_raw === 'Material Group').requiredness, 'required', 'the earlier configuration still says what it said');
    assert.equal(snap('analysis_configs', 'id = ?', c1.config_id), cfgBefore); assert.equal(snap('schema_mappings', 'source_file_id = ? AND mapping_version = 1', sf), v1Before);
    const differing = s2.sources[0].columns.filter((c, i) => JSON.stringify(c) !== JSON.stringify(s1.sources[0].columns[i])).map(c => c.header_raw); assert.deepEqual(differing, ['Material Group'], 'only the changed column differs between the two configurations');
  });
});
