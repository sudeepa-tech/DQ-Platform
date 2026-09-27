# S0 pre-registration (frozen before any S1+ engine code exists)

Date frozen: 2026-09-24T08:04Z (session date 2026-09-24). Any later change to this file, the oracle, the generators, the
truth files or the acceptance bars requires a written justification in the S-gate report. Hashes (first 16 hex of sha256):

| artifact | sha256[:16] |
|---|---|
| oracle/oracle.py (v1.2; was v1.1 `95d24dbcaf21516b`) | 1bbc50354a7c3102 |
| oracle/gen_holdout.py (seed 7919) | 2867c4ca7bdb62b9 |
| oracle/truth/erp_dump.truth.json (was `a6b7e3524a68af75`) | 7ab4b4a3504ce3d5 |
| oracle/truth/holdout.truth.json (was `3b2bf02e822f18b7`) | 7c5fb09648e2a053 |
| oracle/truth/holdout.plant.json | 7babee75ba54ba1b |
| oracle/truth/material_master.baseline.json | a17431a2f6645e8a |
| oracle/truth/service_entry.baseline.json | 09ee6354cdc34efb |
| oracle/holdout.expected_roles.json | badf6defcef62846 |
| fixtures/holdout_master_entity.xlsx | aa2895812049ecae |

## Acceptance bars (chosen BEFORE seeing any new-engine result; identical for every dataset)
- entity clusters: record-level AND pair-level precision >= 0.98 and recall >= 0.98
- hard invariant: 0 clusters containing two different valid GSTINs; 0 fuzzy candidates auto-clustered
- conflicts: every oracle conflict type detected 100%, each group reported exactly once, 0 groups outside truth
- item-code conflicts: all codes found, none spurious, minority-record recall 1.0 and flagged-record precision >= 0.90
- missing / invalid / temporal / future: exact set match (0 false negatives, 0 false positives) against the oracle rule set
- stale: exact match against the engine's OWN configured threshold + reference date (the oracle publishes a 1-5 year table)
- consistency score sensitivity: <= 100 x (1 - 0.5 x share of records in conflict/temporal/item-minority groups)
- header vocabulary generalization on the unseen hold-out headers: >= 85%
- real SAP files: 0 forbidden role assignments, 0 issues on 100%-empty columns, no (column, rule) failing on >= 90% of populated values,
  header/content conflicts flagged for review, duplicate headers kept as distinct columns
- scale: 2,000 / 5,000 / 10,000 rows complete for BOTH load shapes (P0 gate), timezone matrix: 0 mismatches in all 3 zones

## Oracle semantic decisions (RESOLVED by the product owner at S0 approval, 2026-09-24 - see Addendum A)
1. Same GSTIN + same name + DIFFERENT vendor codes = DUPLICATE (one company, two vendor codes), not a conflict.
2. Same vendor code + two different valid GSTINs = conflict (gstin_mismatch); same vendor code + unrelated names = conflict (vendor_code_identity).
3. Names 0.60-0.90 similar (difflib) with hard-ID agreement are AMBIGUOUS and excluded from scoring (neither reward nor penalty).
4. "Expected" fields (>= 95% populated) that are blank count as missing-data findings (lower severity than confirmed-Required) - per decision 5.
5. Stale threshold / reference date are configuration; the oracle reports 1-5 year counts instead of choosing one.
6. Vendor vs Customer type is never an identity veto (decision 2).

## Pre-registered ambiguous pairs (excluded from precision/recall by design)
- hold-out: S.No 264 / 760 (different companies sharing two name words; same vendor code). ERP_Dump: none.

## Addendum A - S1 (2026-09-24): approved decisions and the one oracle change they required
Approved by the product owner with S0 approval:
1. **Same GSTIN + same/compatible name + different vendor codes = ENTITY MATCH, subtype `identity_match_vendor_code_variant`** - not a hard identity conflict;
   reviewable, never silently merged. A *different valid GSTIN* remains a strong identity conflict. (Resolves items 1-2 above; the oracle already treated it as a match.)
2. **Requiredness has three states** - REQUIRED (missing = high), EXPECTED (missing = low/medium), OPTIONAL (missing = no completeness defect). A 100%-empty optional column
   yields no record-level findings; a 100%-empty REQUIRED column yields ONE dataset-level issue. (Resolves item 4.)
3. **Default stale threshold = 4 years**, reference date = the run date frozen at run start, both user-configurable (1/2/3/4/5/custom) and always displayed. The server clock is
   never read after a run. (Resolves item 5; the oracle still publishes the 1-5 year table.)

**Oracle change v1.1 -> v1.2 (justification):** decision 1 names a class and subtype the oracle did not emit. v1.2 ADDS `match_class` and `match_subtype` to each duplicate pair
(`entity_match` / `identity_match_vendor_code_variant` when GSTIN agrees, name is equal/similar and vendor codes both exist and differ; otherwise `match_class` = the existing
`dup_type`, `match_subtype` = null). **No existing field changed**: verified by diffing regenerated truth against v1.1 - the only differences are the two new fields plus
`meta.oracle_version` / `meta.semantics_sha256`. Result: hold-out 15 pairs classified `identity_match_vendor_code_variant` (= the 15 planted); ERP_Dump 0.
No acceptance bar changed. Both oracle self-crosschecks re-run and pass.

New frozen S1 artifacts (legacy compatibility fixture, built by the ORIGINAL pre-migration server):
| artifact | sha256[:16] |
|---|---|
| fixtures/legacy/legacy_v0.db | d97cfd7cded736e4 |
| fixtures/legacy/legacy_v0.manifest.json | caeba840bebdad04 |
| fixtures/legacy/legacy_v0.api_snapshot.json | f32e730c71cf2574 |

## Addendum B - S2 (2026-09-24): independent ingest truth and what it does not change
S2 adds one truth file and changes NO acceptance bar, NO existing truth file and NO oracle semantics (oracle stays v1.2).
- `oracle/ingest_truth.py` (sha256 `a17a278b9e74cb13567d75c4fa6d6cc129755a4d97d893c5c768972ef8fb1c68`) -> `oracle/truth/ingest.truth.json` (sha256 `e028a694448c1ec0ea1ef033383173d3af798ecc61a80054ea2cbd4519b55cb1`).
  It is produced with `openpyxl` and python `datetime`, never with the code under test. It records, per dataset: physical column count, original headers, per-column populated / distinct / kind counts,
  every Excel date/time cell as a calendar string, exact raw values of identifier and audit-user columns, and a pattern + calendar-validity classification of TEXT dates under the default profile
  (DD.MM.YYYY, YYYY-MM-DD): parsed / invalid / needs_configuration / plain text.
- Approved decisions 1-3 (Addendum A) are unchanged. Decision 2 (three requiredness states) and the fuzzy-candidate rule are still product requirements; S2 (migration 0005) only moves their ENFORCEMENT out of database
  triggers into versioned rule configuration and the engine, per the product owner's S2 instruction. They are tracked as pending contracts RT-66..RT-69 until the phase that owns them.
- Definition fixed in S2: a column's `distinct_count` counts distinct RAW values (physical fact, independent of the date-format profile).

## Addendum C - S3 (2026-09-24): semantic layer - what was pre-registered, what did not change, and one caveat
S3 changes NO acceptance bar, NO existing truth file, NO oracle semantics (oracle stays v1.2), NO fixture and NO test expectation of RT-01..RT-12. The six S0 semantic-role tests (RT-01/02 x2 files, RT-04, RT-05)
turn green only because the semantic layer is now wired to the new engine (`QA_SEMANTIC=v1`); with `QA_SEMANTIC=legacy` they are red again, exactly as recorded in `baseline/legacy/`.

**Expected dataset types (RT-70).** ERP_Dump and the hold-out come from the oracle (`meta.mapping.semantics.table_type` = `master_entity`, both). The two SAP baselines are deliberately LABEL-FREE in the oracle, so their
expected types are pre-registered here from the S3 charter's own description of the files, not derived from any code: Material_Master = `master_material`; Service_Entry_Sheet = `transaction`.

**Translation tables used by rt13 (test tooling; the oracle keeps its own vocabulary).** oracle canonical field -> S3 role: `gstin`->legal_id, `vendor_code`->entity_id, `item_code`->material_id, `item_desc`->description,
`postal`->postal_code, `created`->creation_date, `modified`->modification_date, `name`->name; the rest map to the identically named role. Baseline vocabulary -> role for "no column may be mapped to": `entity_name`->name,
`gstin`->legal_id, `address_street`->address, `material_key`->material_id. Adding a role to these tables needs the same written justification as any oracle change.

**Pending contracts converted (same IDs, same wording).** RT-67 [S3] (no heuristic can make a field REQUIRED) and RT-68 [S3] (auto-accept only at HIGH confidence) were `todo` in rt12; they are now real tests in rt13.
RT-27, RT-28, RT-32, RT-45 (user-visible interpretation, review-before-analysis, requiredness labels in the UI, one dataset-level finding) stay `todo`: S3 supplies their data/API basis, the visible behaviour belongs to S6/S4.

**Caveat - the hold-out is NOT blind for S3.** Its headers and pre-registered classes (`holdout.expected_roles.json`) were read before the S3 vocabulary was written. No vocabulary entry was edited to fit it, and every
fix made while tuning was a general defect that also showed on ERP_Dump / the SAP files (e.g. a wrong near-constant rule, camelCase splitting of `UoM`), but the hold-out can no longer be claimed as an unseen test for this layer.
S3 therefore adds header/content cases that appear in none of the four datasets (backend/tests/semantic.test.js) and perturbation tests (rt13 RT-75). A genuinely independent file from a different ERP is requested for final acceptance.

**Mutation testing (qa/harness/mutation_s3.js, committed).** 43 deliberate bugs injected into isolated copies of the semantic layer, service, routes and migration; control run green; 42 killed, 0 survived, 1 documented
equivalent mutant (M11: content fit < 0.2 already caps the score below the assignment threshold). The first pass left 11 survivors; each became a targeted test, and two of them exposed real defects
(`No. of Documents` mapped to doc_id; a near-miss on a high-risk role declined silently). A later review of the real-data output found three more general defects (a spurious review flag on a confident role, `Rem.` expanded to "remark", 1-4 digit position numbers read as material numbers) and one scale defect (uniqueness above the 20,000-value tracking cap), each fixed and pinned by a test or mutant (M43). Results: `reports/s3_mutation.json`.

**Known side effect.** Running the regression suite rewrites `baseline/gate/scale.json` (RT-34 records its latest result). Its content is the same failure as the S0 baseline (legacy engine: stack overflow at 2,000 rows); only timings change.

## Addendum D - S4 (2026-09-24): rules layer - what was pre-registered, what did not change, and two caveats
S4 changes NO acceptance bar, NO existing truth file, NO oracle semantics (oracle stays v1.2), NO fixture and NO expectation of RT-01..RT-77. The S0 tests it turns green (missing / invalid / temporal / future / stale / repeated-code noise on ERP_Dump and the
hold-out, RT-21, RT-22, RT-40, RT-17) become green only because the rules layer is measured through the new engine (`QA_RULES=v1`, default); with `QA_RULES=legacy` the run view carries the legacy engine's own issues and the recorded S3 failures return
exactly (verified: the 40 failing tests are the S3 set). The live upload route is still the legacy engine; `qa/harness/rules_v1.js` runs the real S2 -> S3 -> immutable-snapshot -> S4 path in a temp database and `inproc.js` overlays its findings on the run view.

**What the oracle is, for this layer.** The oracle's validity definitions (GSTIN structure, e-mail shape, Indian PIN, phone, quantity/price >= 0, tax rate 0-100, unparseable dates, modified < created, future dates, the 365.25-day stale table) are the pre-registered SPECIFICATION of
"invalid / temporal / stale". The S4 validators implement those standard definitions; they are not an independent rediscovery of them. What is independent is that the engine does not know the oracle's rule names, field names or files: every rule attaches through the confirmed S3 role mapping, and the
same engine is scored on data with different headers (hold-out) and on real SAP files that have no planted truth (RT-81/82).

**Stale definition.** The engine uses calendar years (date + threshold, on the anniversary or earlier = not stale); the oracle uses days / 365.25. They coincide exactly at 4 years (every 4-year span contains exactly one leap day), which is the default and what RT-83 asserts as exact.
For other thresholds RT-83 allows a difference ONLY on records within one day of the boundary and fails on any other difference. This is a documented definitional tolerance, not a weakened assertion.

**Pending contracts converted (same IDs, same wording).** RT-29 (rt08) and RT-66 (rt12) are now real tests in rt14. RT-30 (needs a PIN pack that is not built), RT-45 / RT-46 / RT-47 (their UI / read-path halves belong to S6) stay `todo`.
RT-16 stays red: its detection half passes, its second assertion is the dashboard uniqueness SCORE (S7). It was not edited.

**Caveat 1 - the hold-out is NOT blind for S4 either.** Its truth file was read to understand the oracle's definitions before the rules were written (as for S3). No rule was tuned to a value in it, and the two defects the measurement exposed were general (see below),
but an unseen file from a different ERP is still requested for final acceptance.

**Caveat 2 - three S3 refinements were made by S4 because measurement showed real defects; each is covered by tests and left every role/tier/review flag of all four datasets identical (before/after diff).**
(a) quantity / unit_price non-negative checks are role-intrinsic (an entity master had none, so negative quantities/prices were missed); (b) numeric-looking TEXT counts as numeric in the content profiler (content-profile-1.2.0; a CSV has no cell types, so `Quantity` never got its role);
(c) the primary column of a role is chosen by populated share before confidence (a 9%-populated `Reference` had out-ranked the fully populated `Purchasing Document`, producing 913 false "missing" findings on Service Entry). One line-level slip was found and fixed by the same before/after diff (a comment swallowing statements).

**Mutation testing (qa/harness/mutation_s4.js, committed).** 53 deliberate bugs injected into isolated copies of the rules layer and the S3 lines S4 changed; control green; first pass 52 killed / 1 survived (M53: requiredness primary ranking, a real test gap for non-critical duplicate roles);
a targeted test (semantic.test.js) killed it: 53/53, 0 equivalent. The S3 harness was re-run after S4's S3-side edits: unchanged (43 mutants, 42 killed, 1 documented equivalent, control green).

## Addendum E - S5 (2026-09-24): identity layer - what was pre-registered, what did not change, and four caveats
S5 changes NO acceptance bar, NO truth file, NO oracle semantics (oracle stays v1.2), NO fixture and NO expectation of RT-01..RT-83. The S0 identity tests it turns green (RT-09/10/11/13/14, RT-37/38/39 and the ten GOLD entity / conflict / item tests on ERP_Dump and the hold-out) become green only because clusters and conflicts are measured through the new engine (`QA_IDENTITY=v1`, default); with `QA_IDENTITY=legacy` the recorded S4 failures return (verified: 28 of 28; nothing that passed at S4 regresses). The new rt15 tests call the identity path directly and are therefore independent of the selector. RT-15 stays red: its clustering half passes, its second assertion is the dashboard duplicate KPI (S6/S7). It was not edited.

**What the oracle is, for this layer.** The oracle's identity semantics (hard ids, name relation eq / sim / different / ambiguous / unknown, DUPLICATE / CONFLICT / FUZZY-CANDIDATE rules, constrained union-find, item-code minority logic) are the S0 product-owner-approved decisions, implemented independently in Python. The S5 engine implements the SAME approved semantics; what is independent is the code, the language, the similarity metric (normalized Damerau-Levenshtein, not difflib) and that the engine knows no dataset, file, column-header or truth-file name (static-guarded). It is not an independent rediscovery of the rules.

**Caveat 1 - the hold-out is NOT blind for S5 either.** Its truth file was read before the engine was written. No threshold was tuned to it; the name thresholds (0.90 / 0.60 / overlap guard) are the oracle's approved values, expressed as versioned configuration. The perfect scores (clusters exact, precision = recall = 1.0) therefore demonstrate that the approved semantics are implemented faithfully, not that they generalise to another ERP. An unseen file remains requested for final acceptance.

**Caveat 2 - the similarity metrics differ, so pairs near the 0.90 / 0.60 boundaries could in principle fall on different sides.** None does in the four datasets (the one ambiguous pair is ambiguous in both). Such pairs are excluded from precision / recall by design (as pre-registered) and surfaced as review items.

**Caveat 3 - name blocking is OFF by default.** Under the approved rules a pair needs a shared hard or strong key to be classified at all, so name blocks change no result while adding ~100x candidate pairs (hold-out: 16,333 vs 161; identical clusters / conflicts / candidates). It remains configurable and is unit-tested.

**Caveat 4 - the address signal.** A postal-code-plus-address-core match is a STRONG signal only when the postal codes are equal; the engine and the oracle agree on this, and the address block is only reachable at `fuzzy.min_strong_signals = 1` or via another shared key (covered by tests / mutants M24, M37).

**Mutation testing (qa/harness/mutation_s5.js, committed).** 71 deliberate bugs in the identity layer, the S3 snapshot lines and the S4 lines changed by the follow-up approvals; control green; first pass 64 killed / 7 survived (token-overlap guard, different_below, address-core city/state stripping, e-mail case, same-street-different-postal, union strength order, the identity service's own file-hash check). All seven were real test gaps (none equivalent); targeted tests killed them: 71/71, 0 equivalent. S4 harness re-run: 53/53. S3 harness re-run: 43 mutants, 42 killed, 1 documented equivalent (M11), control green.

**S5 gate decisions (product owner, 2026-09-24, S5 APPROVED).** These are now requirements, not caveats:
1. Name blocking stays OFF in the default production configuration (`identity-config-1.0.0`, `blocking.name_blocks = false`); it remains configurable for future use. Pinned by `identity.test.js` (DETERMINISM + CONFIGURATION) and mutant M64.
2. Different valid GSTINs are ALWAYS cannot-link. PAN is NOT used to relax this and different GSTINs are never grouped merely because they share a PAN; a PAN-based relationship may later be introduced only as an explicit, reviewable business relationship. Pinned by the same test (same PAN under state codes 27 / 29 -> conflict, no cluster, no candidate) and by mutants M29 / M38.
3. Temporal conflicts: no separate temporal-conflict system in S5. S4 owns record-level temporal validity; S5 retains relevant field differences (`diff_fields`, including audit-date differences) as pair evidence.
4. Item / material semantics: entity and mixed datasets -> item-code description-conflict analysis; material masters -> material-specific matching (review-only candidates); transactions -> document / reference semantics. Repeated material / item values are never entity identity.
5. The QA overlay (`QA_RULES`, `QA_IDENTITY`, `qa/harness/{rules_v1,identity_v1,inproc}.js`) is a TEMPORARY development / measurement mechanism. S6 MUST replace it with the production pipeline: Canonical Ingest -> Semantic Mapping / Confirmed Config -> S4 Rules -> S5 Identity / Matching / Conflicts -> Persisted Findings -> Scoring -> API -> Frontend -> Exports / Reports. The S5 identity, cluster and conflict tables (`entity_clusters`, `entity_cluster_members`, `match_pairs`, `conflicts`; currently empty by design, asserted by `identityService.test.js`) must be populated by that pipeline in S6, from the persisted run configuration snapshot.

**S6 gate re-verification (product owner, 2026-09-25): decision 2 correction, closed at the true enforcement point.** The first S6 report proposed that an uncertain dataset type (mixed_unknown / needs_review / below the configured decision threshold -- all three collapse to the single `dataset_type_needs_review` flag S3's classifier already computes) could still auto-confirm for API callers that skip `require_manual_review`. The product owner rejected this: uncertain dataset type must NEVER auto-confirm, for ANY caller, through ANY entry point, and the refusal must carry the dataset classification, confidence, reasons, alternatives and required action.
Fixed at the true source, `schemaService.confirmMapping` (S3's own service, not just the S6 route wrapper): `accept_suggestions` no longer bypasses an uncertain dataset type under any circumstance; only an explicit `setDatasetType()` call (source becomes `user`) clears it. The S6 `/analyze` route's own pre-check is defence in depth, not the enforcement boundary. Verified independently through three entry points: `confirmMapping()` directly, the schema API's own `/confirm` endpoint, and the production `/analyze` route (with `require_manual_review` true, false, and omitted -- no flag value unlocks a bypass). Column-level suggestions still auto-accept (decision 3, unaffected).
One real bug this surfaced and fixed: the route's own pre-check read the wrong field (`model.dataset_type_needs_review`, which does not exist, instead of the mapping set's `dataset_type_needs_review`), so it never actually fired; the enforcement that held was the service-layer fix. Both are now correct, and the route also converts a refusal from the service into the same detailed shape rather than leaking a generic error.
Three fixtures independently, honestly classify as mixed_unknown under this stricter gate (a scale-harness transaction fixture, one pre-existing integration test's one-column fixture, and RT-17): each was strengthened with more decisive header evidence so it again exercises what it was written to test (scale/crash-resistance, an export timing race, respectively) rather than dataset-type ambiguity; RT-17 itself remains an open, explicitly-reported decision item, not silently patched.
Regression after the fix: 245/245 backend, 102/5/11 QA (unchanged from the prior S6 checkpoint); all four real datasets (ERP_Dump, hold-out, Material_Master, Service_Entry) classify confidently and complete unaffected; `backend/src/identity/*` is byte-for-byte identical to the S5-approved state (9/9 files, verified by hash).

## Addendum F - S7 (2026-09-25): scoring and KPI intelligence
S2-S6 are untouched: `backend/src/rules/*`, `backend/src/identity/*` and every other semantic file are byte-for-byte identical to the S6-approved state (verified by hash, 28 files compared, only `semantic/configSnapshot.js` differs -- purely additive: a fifth `scoring` block alongside the existing `rules`/`identity` blocks in the run snapshot, schema_version 3 -> 4). No S5 matching, clustering, GSTIN/PAN, item/material, or name-blocking semantics changed.

**Architecture.** `backend/src/scoring/{config,engine,scoreService,index}.js`, mirroring S4/S5: `engine.js` is a pure function over already-computed S4 findings + S5 identity output + S2 populated-cell facts + the versioned scoring configuration; no clock, no I/O, no dataset/file-name awareness (static-guarded). `scoreService.js` adapts the pipeline's in-memory S4/S5 objects into the engine's plain inputs and combines however many source files a run has into one set of dimension scores. `pipeline/persistScores.js` writes `run_scores` (one row per dimension + one `overall` row, each with a persisted `explanation_json`) and `score_contributions` (one row per rule-or-identity-concept, per physical column where applicable, per source file). No new competing table was created; both existed for exactly this since S1.

**Formula**, per dimension: `defect_rate = weighted_defects / opportunities` (`weighted_defects = sum(defects * severity_weight)`), `score = 100 * (1 - min(1, defect_rate))`; overall = weighted mean of the five dimension scores, `dimension_weights` (default 20% each, must sum to 1) and `severity_weights` (critical 1.0 / high 0.75 / medium 0.50 / low 0.25) are both explicit, versioned, strictly-validated configuration, never buried in code.

**No double counting**, the mandatory requirement, is enforced structurally, not by convention:
- An entirely-empty required/expected column is ONE dataset-level contribution (opportunities=1, defects=1), never N row defects, even though S4's own `completeness.column_empty` finding does not suppress the per-row `required_missing`/`expected_missing` findings for that column -- the scoring layer detects the dataset-scope finding and skips the redundant per-row ones itself.
- A systematic-failure (dataset-scope) validity finding is used as-is (S4 itself never also emits the per-row findings it replaces, so there is nothing to double-count).
- A conflict group is one unit regardless of evidence paths (S5 already guarantees this); a record touched by several conflict groups counts once, at its worst severity.
- Uniqueness counts only clustered (accepted) matches; unconfirmed candidates -- fuzzy, hard-id-name-unknown, ambiguous, and ALL material/transaction candidates (which have no confirmation path yet at all) -- contribute nothing. This is a real, current limitation of S5's scope, not a scoring bug: a material-master run's uniqueness dimension reads 100 until a future confirmation mechanism exists.

**Bugs found and fixed while building this** (each caught by a real end-to-end pipeline run, not assumed away): (1) `E.scoreUniqueness` read `c.record_count`, a field that only exists on the *persisted* cluster row, not on S5's raw in-memory cluster objects (which expose `members`) -- produced NaN; (2) `E.scoreConsistency` used a conflict's member ref *object* as a Map key instead of its `row_number`, which would have silently over-counted distinct records since object identity, not value, decides Map key equality; (3) material candidates were being counted as uniqueness defects despite the code's own comment saying they shouldn't be -- fixed to match the charter's explicit rule that an unconfirmed candidate is never a defect.

**Results, all four real datasets** (overall / completeness / validity / uniqueness / consistency / freshness): ERP_Dump 95.42 (99.95/99.73/85.48/92.74/99.19); hold-out 96.89 (99.81/99.70/93.28/94.24/97.44); Material_Master 95.00 (100/100/100/100/75.00); Service_Entry 97.03 (99.92/100/100/100/85.23). All bounded in [0,100], all deterministic across timezones (UTC and UTC+14 give identical scores on the hold-out, verified directly). Material_Master's and Service_Entry's uniqueness/consistency read 100 because S5 currently produces no confirmed material/transaction duplicates or conflicts requiring review beyond what dataset-appropriate matching already resolves -- an honest reflection of the current pipeline, not a defect masked by the score.

**QA regression**: 105 pass / 2 fail / 11 pending (up from 102/5/11 at the S6 gate). Three tests move from FAIL to pass, exactly the three previously declared S7-owned: RT-16 and both GOLD consistency-score tests. Zero regressions. The two remaining failures are RT-07 (S8-owned dead legacy code) and RT-17 (the pre-existing, explicitly open dataset-classification decision item from the S6 gate, unrelated to scoring).
