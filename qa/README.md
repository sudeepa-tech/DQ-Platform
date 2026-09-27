# QA / validation harness (Phase 1, S0 - S3)

Everything under `qa/` is test tooling. **Nothing here is imported by, or changes, production code.**
S0 was read/test/baseline only; the legacy engine's measured state is stored in `qa/baseline/legacy/`.
S1 added `regression/rt10`-`rt11` and `fixtures/legacy/` (a real legacy database) - still test tooling only. The application's own DB/migration tests live in `backend/tests/` (`npm test`).
S2 added `regression/rt12` (canonical ingest + date engine, verified on the four real datasets against `oracle/ingest_truth.py`) and `harness/engine_under_test.js` (which engine each pipeline LAYER is tested against).

## Layout
| Path | Purpose |
|---|---|
| `oracle/oracle.py` | Independent oracle (Python, difflib metric, explicit column mapping). Semantics documented in its header. |
| `oracle/gen_holdout.py` | Hold-out adversarial dataset generator (seed 7919). Different headers, id formats, date encodings and traps than ERP_Dump. |
| `oracle/sap_baselines.py`, `dates_truth.py` | Independent facts about the two real SAP exports; calendar-date truth read straight from workbook cells. |
| `oracle/ingest_truth.py` | S2 truth (openpyxl + python `datetime`, never the code under test): physical columns, per-column populated/distinct/kind facts, every Excel date/time cell, exact raw identifier columns, and an independent pattern+calendar classification of TEXT dates. Writes `oracle/truth/ingest.truth.json`. |
| `oracle/crosscheck_*.py` | Validate the ORACLE itself against each generator's planted structure. Never used to judge the engine. |
| `oracle/truth/` | Generated truth/baseline files (frozen: see `PREREGISTRATION.md`). |
| `fixtures/` | ERP_Dump copy, hold-out workbook, header/shape files for all 4 datasets, 5-row real-data repro (`min/`). **Real SAP files are not copied** (set `DQ_SAP_DIR`, default `/mnt/user-data/uploads`). |
| `harness/` | Runners, adapters, scorer, timezone matrix, scale gate, regression runner. |
| `regression/` | `rt01`-`rt13` test files (`node:test`). `rt10` = S0-discovered defects + approved semantic decisions; `rt11` = legacy-database compatibility through the real server startup path; `rt12` = S2 canonical ingest / date engine on the real files (RT-56..RT-63) + contracts moved out of the database (RT-66..RT-69, todo). |
| `harness/engine_under_test.js` | Per-layer engine selector. `ingest` = `v1` from S2 (`QA_INGEST=legacy` restores the old parser so the S0/S1 baselines stay reproducible). Semantic profiler, matching and rules are still legacy. |
| `fixtures/legacy/` | `legacy_v0.db` written by the ORIGINAL pre-migration server (2 completed runs), its table manifest (row counts + content hashes) and a 37-endpoint API snapshot. Rebuild only with `build_legacy_fixture.js` against the pristine tree. |
| `baseline/legacy/` | Legacy-engine measurements: per-dataset metrics, `tz_matrix.json`, `scale.json`, `regression_status.json`. |
| `PREREGISTRATION.md` | Acceptance bars, oracle decisions awaiting confirmation, frozen hashes. |

## Commands (run from repo root; Node 22)
```
node qa/harness/mutation_s3.js [--jobs=4] [--only=M07,M10] [--validate]                # S3 mutation testing: 43 injected bugs, each in an isolated copy; report -> qa/reports/s3_mutation.json
QA_SEMANTIC=legacy node --experimental-sqlite qa/harness/run_regression.js               # run the suite with the LEGACY role profiler (RT-01/02/04/05 go red again)
QA_RULES=legacy node --experimental-sqlite qa/harness/run_regression.js                  # run the suite with the LEGACY engine's issues in the run view (the S3 failures return exactly)
node --experimental-sqlite qa/harness/run_regression.js [--out=qa/baseline/<engine>/regression_status.json]   # all tests, compact table
bash qa/harness/run_all_baselines.sh                                       # 4 datasets through a real server + scoring
node --experimental-sqlite qa/harness/tz_matrix.js --adapter=v1            # Asia/Kolkata, UTC, America/New_York (new ingest, persisted values read back from a temp DB)
node --experimental-sqlite qa/harness/tz_matrix.js --adapter=legacy        # same matrix on the legacy parser (expected to FAIL under Asia/Kolkata: the S0 defect)
QA_INGEST=legacy node --experimental-sqlite qa/harness/run_regression.js   # run the suite with the LEGACY ingest layer (RT-03/06/35/36 go red again)
python3 qa/oracle/ingest_truth.py [uploads_dir]                            # regenerate S2 truth (changes need justification)
node --experimental-sqlite qa/harness/scale_run.js --sizes=2000,5000,10000 --shapes=master,txn --label=<engine>   # FULL P0 scale gate
python3 qa/oracle/oracle.py --data <xlsx> --sheet <s> --mapping <json> --out <truth.json>   # regenerate truth (changes need justification)
```
Requires `python3` with `pandas` + `openpyxl` only for regenerating oracle/baseline files; the test suite itself needs only Node.

## Rules of the road (anti-overfitting)
1. **Never edit truth files, mappings, generators, or acceptance bars to make an engine pass.** A change needs a written justification in the gate report and a new hash in `PREREGISTRATION.md`.
2. **No expected count appears in any test.** Every expectation is computed from a truth file or a published bar.
3. **Production code must not mention any test dataset** (RT-08 enforces this for executable code).
4. The **hold-out is mandatory at every gate**. A gate that passes ERP_Dump but fails the hold-out has failed.
5. Ambiguous oracle pairs are excluded from scoring by design and listed in `PREREGISTRATION.md`; do not add to that list after seeing an engine result.
6. Guard tests that pass on the legacy engine must stay green (see `baseline/legacy/regression_status.json`).
7. **Tests never touch the real application database.** `backend/src/config/paths.js` redirects storage to a temp dir in any test context and refuses real paths; `backend/tests/testIsolation.test.js` (and `RT-41`) guard it.

## How later steps plug in (no test rewrites)
- **S2 (done):** the INGEST layer of `harness/engine_facade.js` (`profileFile`: `headerCells`, `rowKeys`, `null_pct`; `parseColumns`) and `harness/tz_child.js --adapter=v1` are wired to `backend/src/ingest`. The semantic fields of `profileFile` are still the legacy profiler.
- **S3:** re-point the semantic fields of `profileFile` at the new profiler. It must expose `semantic_class`, `review_required`, `confidence` per column (`null_pct` already comes from the ingest layer's full-column stats).
- **S6/S7:** add `harness/adapter_v1.js` returning the SAME RunView shape as `adapter_legacy_v0.js`
  (`records`, `entityClusters[{members,kind,exactRepeat,factors,conflicts}]`, `itemClusters`, `issues[{key,category,type,field,severity}]`,
  `conflicts[{type,subject,field,members}]`, `scores`, `config`, `persistedPairs`) and switch `inproc.view()` / `run_baseline.js` to it.
  For item conflicts the adapter should expose the MINORITY records as the flagged members.
- Pending contract tests `RT-27`..`RT-33` and `RT-45`..`RT-48` are `todo`; each is converted to a real test in the step that designs its API (S3/S4/S6/S7) and must be listed in that gate's report.

## Gate protocol
At every gate: run the full regression + timezone matrix + scale gate, inspect actual output (not just pass/fail), report deviations, and do not proceed past a failed gate.
P0 is complete only when ERP_Dump, Material_Master, Service_Entry_Sheet, 2k/5k/10k scale, the timezone matrix and the hold-out all pass.

## Data handling
`baseline/` and `oracle/truth/*baseline*` for the SAP files contain header names, value shapes, statistics and business keys (material numbers, entry-sheet numbers)
but no row-level business data. Treat the repo as internal. Temporary run data lives in OS temp dirs; `qa/.work/` holds generated scale CSVs (safe to delete).

## S0 findings -> permanent regression tests
| Finding | Test |
|---|---|
| duplicate headers silently collapsed | RT-03 (parse), RT-35 / RT-36 (content + profile per physical column, real SAP files) |
| empty duplicate `Material` column profiled as populated | RT-35 |
| three Service Entry `Item` columns collapsed | RT-36 |
| Record_ID / row id becomes evidence or conflict | RT-15, RT-37 |
| identical invoice lines on different invoice numbers flagged as duplicates | RT-17 |
| missing reverse-GST rule | RT-38 |
| missing vendor-code identity rule | RT-39 |
| missing PIN / price / quantity / tax range rules | RT-40 |
| tests touching the real platform.db | RT-41 + `backend/tests/testIsolation.test.js` |
| exports lack source sheet / business key | RT-19 (file/sheet/row), RT-42 (business key) |
| production comment referencing a test row (ERP-00290) | RT-43 (comments included; RT-08 ignores comments) |
| same GSTIN + name, different vendor codes (decision 1) | RT-44 (+ RT-48 todo for the evidence view) |
| legacy runs must survive migration untouched | RT-49..RT-55 |
| record detail re-reads the server clock (found in S1) | RT-47 (todo) |

## S2 findings -> permanent regression tests
| Finding / requirement | Test |
|---|---|
| dates shift by a day under non-UTC time zones (`cellDates` + `toISOString`) | RT-06 (all 4 datasets x 3 zones, `--adapter=v1`), RT-59, `backend/tests/dateModel.test.js` (5 zones, byte-identical output), RT-63 + static guard |
| Excel serial arithmetic (1900 leap-year bug, 1904 system, rounding, range) | `dateModel.test.js` (independent UTC oracle over every serial 61..73415 + sweep to 9999-12-31), RT-59 |
| date-only vs datetime vs time-only, never silently converted; hidden time recorded | `dateModel.test.js` (`classifyCell`), RT-60 |
| ambiguous / unconfigured text dates never guessed (raw + candidates + confidence + status) | `dateModel.test.js` (profiles), RT-60 (Service Entry hand-typed dates: 31 cells per column vs independent classification) |
| duplicate headers = distinct physical columns with provenance (header, normalized, letter, position, sheet) | RT-03, RT-35, RT-36, RT-56, RT-57 (Material Master), RT-58 (Service Entry `Item` x3), `ingest.test.js` |
| 308 / 52 physical columns; 225 / 10 empty columns represented as empty | RT-56, RT-57, RT-58 |
| identifiers and audit users stay raw text (Entry Sheet, Purchasing Document, Created By, Changed By) | RT-58 (all 1000 rows exact), `ingest.test.js` |
| source lineage (file, sheet, physical row, data row, raw hash); Record_ID kept apart from row number and DB id | RT-61, `ingest.test.js`, trigger `trg_source_rows_lineage_consistent` |
| re-ingestion identity; one source -> many runs; atomic ingest | RT-62, `ingest.test.js` |
| corrupt / mis-named files must not be ingested as junk rows (found by test; legacy parser has the same hole) | `ingest.test.js` (edge sources, ingestSourceFile) |
| scientific-notation number format misread as a date (found by test) | `dateModel.test.js` (format table) |
| business rules must not be database triggers (architectural correction 0005) | `schemaGuards.test.js` (exact structural allow-list; "policies are NOT database constraints"), RT-66..RT-69 (todo, engine phases) |

Mutation testing (S2): 33 deliberate defects injected one at a time into `backend/src/ingest` and the 0004 triggers, plus a business trigger added via a new migration - all 33 caught (gaps found and closed: bare `[$-F400]`/`[$-F800]` formats).

## S3 findings -> permanent regression tests
S3 added `regression/rt13_semantic_layer.test.js` (RT-70..RT-77, plus RT-67 and RT-68 promoted from pending contracts) and re-pointed the semantic layer of `harness/engine_facade.js` to `backend/src/semantic`
(`QA_SEMANTIC=v1` default; `legacy` restores the old substring profiler). Every test reads what the semantic layer PERSISTED in a real temp database, and compares to independent truth (oracle field map, S0 truth files,
the ingest oracle's physical facts). Backend unit/integration tests for the layer: `backend/tests/semantic.test.js` (pure classifier, requiredness, validation profiles, static guards) and `schemaReview.test.js`
(persistence, review gate, locking, immutable configuration, HTTP API).
| ID | Locks |
|---|---|
| RT-70 | dataset type is evidence-based: correct on all four datasets, with reasons + alternatives; opaque headers lower confidence; removing identity columns changes the type |
| RT-71 | Material Master: 308 columns all mapped, headers equal truth; `Material` = material_id, empty duplicate twin separate and not claiming it; no forbidden role; 225 empty columns produce no record-level defect |
| RT-72 | Service Entry: Entry Sheet doc_id, Purchasing Document doc_ref, Created/Changed By audit_user; person-responsible text dates NOT guessed as dates (flagged, with a reason naming both readings); three `Item` columns separate |
| RT-73 | ERP_Dump and hold-out vs the ORACLE canonical field map (21/21 each) and the pre-registered hold-out classes; both files give the same role structure |
| RT-74 | persistence keeps every physical column; empty flags equal the independent truth; DB roles == pure in-memory roles |
| RT-75 | determinism; column order, header case and punctuation do not change any role; opaque headers never invent phone / GSTIN / e-mail / address / name from lookalike content |
| RT-76 | the classifier never sees file/sheet/dataset names; no matching / fuzzy / clustering / scoring / staleness logic in S3; upload route untouched |
| RT-67 | no heuristic can make a field REQUIRED (only user / rule / SAP-domain sources) |
| RT-68 | auto-accept only at HIGH tier without review flags; confirm is gated on exactly the flagged columns |
| RT-77 | lock -> configuration snapshot -> revise -> new mapping version + new configuration; nothing already confirmed is touched; only the changed column differs between the two configurations |

## S4 findings -> permanent regression tests
Run with `QA_RULES=v1` (default) or `QA_RULES=legacy` (restores the legacy engine's issues in the run view). Path under test: S2 ingest -> S3 confirmed mapping -> immutable configuration snapshot -> S4 rules (`harness/rules_v1.js`). Mutation harness: `node qa/harness/mutation_s4.js` (53 mutants).
| ID | Locks |
|---|---|
| RT-80 | ERP_Dump and hold-out vs the ORACLE: missing and invalid data are exactly the oracle's (record, field) PAIRS (all rule families); temporal and future record sets exact; repeated item / vendor codes never a uniqueness defect; no dataset-level noise |
| RT-81 | all four datasets: optional and unidentified columns never raise completeness findings; a dataset-level finding exists only for an empty REQUIRED / EXPECTED column; excluded columns are out of every rule |
| RT-82 | the two real SAP files: no systematic-failure finding, no (column, rule) pair failing on >= 90% of populated values, nothing on the fully empty columns |
| RT-83 | stale sets vs the oracle's own stale table at its reference dates and thresholds 1-4y: exact at 4y; other thresholds differ only within one day of the boundary |
| RT-29 | (promoted) reference date and stale threshold are run-configurable; a changed setting changes ONLY the affected findings |
| RT-66 | (promoted) requiredness -> severity is versioned rule configuration; severity configuration never changes which records are flagged |
Pure-engine and persistence tests: `backend/tests/rules.test.js`, `backend/tests/rulesService.test.js`.

## S5 findings -> permanent regression tests
Run with `QA_IDENTITY=v1` (default) or `QA_IDENTITY=legacy` (restores the legacy engine's clusters / conflicts in the run view). Path under test: S2 ingest -> S3 confirmed mapping -> immutable configuration snapshot (identity configuration embedded, schema_version 3) -> S4 rules -> S5 identity, in a temp database (`qa/harness/identity_v1.js`). TEMPORARY OVERLAY: the live upload route is still the legacy engine; S6 must replace the overlay with the real pipeline.
| ID | Locks |
|---|---|
| RT-90 | ERP_Dump and hold-out vs the ORACLE: cluster MEMBER SETS exact; accepted pairs and their dup_type exact; vendor-code variants (`entity_match` / `identity_match_vendor_code_variant`, reviewable) exact; conflict member sets exact per type (one cause = one group); fuzzy candidates, the ambiguous pair and shared-contact observations exact and review-only; item-code minorities exact; evidence and lineage complete; deterministic |
| RT-97 | Material Master: entity / item matchers do not run; every oracle exact-description group surfaced as one review group; the near-duplicate review population explained candidate by candidate; all candidates review-only (no confidence, not scoring-eligible) |
| RT-98 | Service Entry: only the transaction matcher runs; every candidate has the same reference AND amount AND (date or vendor); review-only; no explosion |
| RT-99 | one explicit check per S0 identity failure: false clusters from shared city/street, Vendor_Code ignored, missed record with a missing name (ERP-00277), numeric-suffix collisions, GSTIN-conflict clustering, repeated Item_Code as entity, Record_ID false conflicts, item-matching explosion |
| RT-09..RT-14, RT-37..RT-39 | (existing S0 contracts, now green) minimal fixtures for each defect |
Pure-engine and persistence tests: `backend/tests/identity.test.js` (21), `backend/tests/identityService.test.js` (5). Mutation: `node qa/harness/mutation_s5.js` (71 mutants).

### Reproducing the S5 gate state
From the repo root (Node 22, `backend/node_modules` installed; SAP files at `/mnt/user-data/uploads` or `DQ_SAP_DIR`):
```
cd backend && env -u DATA_DIR node --experimental-sqlite --test tests/*.test.js          # backend suite
cd .. && node --experimental-sqlite qa/harness/run_regression.js --out=qa/reports/s5_regression_final.json   # QA regression (QA_IDENTITY=v1, QA_RULES=v1 defaults)
QA_IDENTITY=legacy node --experimental-sqlite qa/harness/run_regression.js --out=/tmp/legacy.json          # legacy selector: the S4 failures return
node qa/harness/mutation_s5.js --jobs=8 ; node qa/harness/mutation_s4.js --jobs=8 ; node qa/harness/mutation_s3.js --jobs=8   # mutation gates (clean /tmp/dq-* afterwards)
node --experimental-sqlite qa/harness/tz_matrix.js --adapter=v1                             # timezone matrix
node --experimental-sqlite --test qa/regression/rt15_identity_layer.test.js                 # S5 vs the independent oracle
```
File integrity: `sha256sum -c qa/reports/s5_manifest_after.sha256` from the repo root (covers backend/, frontend/, qa/ except qa/reports, and the top-level run scripts; excludes node_modules, data / upload / export directories and *.db* files). `qa/reports/S5_GATE_STATE.json` records the expected results.
