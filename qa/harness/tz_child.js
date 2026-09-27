'use strict';
/* Runs in a child process with TZ set by the parent. Extracts calendar dates through the engine's ingestion path and prints JSON.
   --adapter=legacy : backend/legacy_v0/engines/fileParser.parseXlsxSheet (+ qualityEngine for the record-date layer)
   --adapter=v1     : S2 canonical ingest (backend/src/ingest) into a temp database under this TZ; persisted canonical values are read back. Same output shape. */
const path = require('path'); const REPO = path.resolve(__dirname, '..', '..');
const [, , adapter, file, sheet, ...cols] = process.argv; const out = { tz: process.env.TZ || '(unset)', tzOffsetMinutes: -new Date(2014, 2, 27).getTimezoneOffset(), columns: {}, recordLayer: {} };
if (adapter === 'legacy') {
  const { parseXlsxSheet } = require(path.join(REPO, 'backend/legacy_v0/engines/fileParser')); const { profileSheet } = require(path.join(REPO, 'backend/legacy_v0/engines/schemaProfiler')); const { runQualityChecks } = require(path.join(REPO, 'backend/src/engines/qualityEngine'));
  const { headers, rows } = parseXlsxSheet(file, sheet === '-' ? undefined : sheet);
  for (const c of cols) out.columns[c] = rows.map(r => (r[c] === null || r[c] === undefined ? null : String(r[c]).slice(0, 10)));
  const profiles = profileSheet(rows, headers); const recs = rows.map((raw, i) => ({ id: 'r' + i, raw }));
  const dateProfiles = profiles.map(p => ({ column_name: p.column_name, inferred_role: p.inferred_role })); runQualityChecks({ records: recs, fieldProfiles: dateProfiles, runId: 'x' });
  out.recordLayer = { created: recs.map(r => (r.createdDate ? r.createdDate.slice(0, 10) : null)), modified: recs.map(r => (r.modifiedDate ? r.modifiedDate.slice(0, 10) : null)), createdRoleColumns: profiles.filter(p => p.inferred_role === 'created_date').map(p => p.column_name) };
} else if (adapter === 'v1') {
  // canonical ingest into a real (temp) database under this process's TZ, then read the PERSISTED canonical values back
  const fs = require('fs'), os = require('os'); const { DatabaseSync } = require('node:sqlite');
  const { migrate } = require(path.join(REPO, 'backend/src/db/migrate')); const { ingestFile } = require(path.join(REPO, 'backend/src/ingest'));
  const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dq-tz-v1-')), 't.db'); const db = new DatabaseSync(dbFile); db.exec('PRAGMA foreign_keys=ON'); migrate(db, { dbFile });
  db.exec("INSERT INTO organizations(id,name) VALUES('o','O'); INSERT INTO datasets(id,organization_id,name) VALUES('d','o','D')");
  const r = ingestFile(db, { datasetId: 'd', filePath: file, sheetName: sheet === '-' ? undefined : sheet });
  const keyOf = {}; for (const c of db.prepare('SELECT header_raw, header_key FROM file_columns WHERE source_file_id=? ORDER BY column_index').all(r.sourceFileId)) if (!(c.header_raw.trim() in keyOf)) keyOf[c.header_raw.trim()] = c.header_key;
  const persisted = db.prepare('SELECT row_number, raw_json, canonical_json FROM source_rows WHERE source_file_id=? ORDER BY row_number').all(r.sourceFileId).map(x => ({ n: x.row_number, raw: JSON.parse(x.raw_json), can: x.canonical_json ? JSON.parse(x.canonical_json) : {} }));
  const col = c => { const k = keyOf[c]; const a = []; for (const x of persisted) { const v = x.can[k] !== undefined ? x.can[k] : (x.raw[k] === undefined ? null : x.raw[k]); a[x.n - 1] = v === null ? null : String(v).slice(0, 10); } for (let i = 0; i < a.length; i++) if (a[i] === undefined) a[i] = null; return a; };
  for (const c of cols) out.columns[c] = col(c);
  const role = process.env.QA_ROLE_COL; out.recordLayer = { created: role ? col(role) : [], modified: [], createdRoleColumns: role ? [role] : [], note: 'v1: dates as persisted by canonical ingest (record layer arrives with S6)' };
} else { out.error = 'unknown adapter ' + adapter; }
process.stdout.write('@@' + JSON.stringify(out));
