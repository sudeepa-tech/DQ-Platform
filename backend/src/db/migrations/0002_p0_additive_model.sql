-- ============================================================================
-- 0002  P0 additive data model (S1)
-- ----------------------------------------------------------------------------
-- ADDITIVE ONLY. No legacy column is altered, dropped or re-typed. Every column added to an existing table is nullable
-- or has a constant default, so (a) the legacy engine keeps working unchanged and (b) every legacy row keeps its exact
-- content. Legacy runs are identified by analysis_runs.engine_version = 'legacy_v0' and are never re-interpreted.
-- FK NOTE: new references deliberately use the default NO ACTION (checked at end of statement) rather than SET NULL: a dataset
-- delete cascades to all of them in one statement, whereas SET NULL would run as an UPDATE against completed-run guards (0003).
-- Conventions: JSON columns are validated with json_valid(); enumerations are CHECK-constrained; the DB (not only the
-- application) enforces the approved semantic decisions (see 0003 for the trigger-based guards).
-- ============================================================================

-- ---------------------------------------------------------------- datasets: table type + visible interpretation
-- Table type is CONFIGURATION (decision 6), never hard-coded in a parser. NULL = not determined (all legacy datasets).
ALTER TABLE datasets ADD COLUMN table_type TEXT
  CHECK (table_type IS NULL OR table_type IN ('master_entity','master_material','transaction','mixed_unknown'));
ALTER TABLE datasets ADD COLUMN table_type_source TEXT
  CHECK (table_type_source IS NULL OR table_type_source IN ('user','inferred'));
ALTER TABLE datasets ADD COLUMN table_type_confidence REAL
  CHECK (table_type_confidence IS NULL OR (table_type_confidence >= 0 AND table_type_confidence <= 1));
-- What the engine thinks the dataset represents must be visible BEFORE analysis; low confidence => review_required.
ALTER TABLE datasets ADD COLUMN interpretation_status TEXT NOT NULL DEFAULT 'not_interpreted'
  CHECK (interpretation_status IN ('not_interpreted','review_required','auto_accepted','confirmed'));
ALTER TABLE datasets ADD COLUMN interpretation_json TEXT
  CHECK (interpretation_json IS NULL OR json_valid(interpretation_json));   -- primary key, supporting keys, important fields...
ALTER TABLE datasets ADD COLUMN interpretation_updated_at TEXT;

-- ---------------------------------------------------------------- source_files: ingest provenance
ALTER TABLE source_files ADD COLUMN content_sha256 TEXT;
ALTER TABLE source_files ADD COLUMN header_row INTEGER CHECK (header_row IS NULL OR header_row >= 1);
ALTER TABLE source_files ADD COLUMN has_duplicate_headers INTEGER NOT NULL DEFAULT 0 CHECK (has_duplicate_headers IN (0,1));
ALTER TABLE source_files ADD COLUMN ingest_version TEXT;
ALTER TABLE source_files ADD COLUMN ingested_at TEXT;

-- ---------------------------------------------------------------- versioned, immutable analysis configuration
CREATE TABLE IF NOT EXISTS analysis_configs (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version >= 1),                 -- per dataset; a change = a NEW version, never an edit
  table_type TEXT NOT NULL CHECK (table_type IN ('master_entity','master_material','transaction','mixed_unknown')),
  -- staleness: default 4 years (approved); 1/2/3/4/5 or any custom positive number of years
  stale_threshold_years REAL NOT NULL DEFAULT 4 CHECK (stale_threshold_years > 0),
  -- 'run_date' = resolved ONCE when a run starts and then frozen on that run; 'fixed' = a user-chosen date
  reference_date_mode TEXT NOT NULL DEFAULT 'run_date' CHECK (reference_date_mode IN ('run_date','fixed')),
  reference_date TEXT CHECK (reference_date IS NULL OR reference_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  config_json TEXT NOT NULL CHECK (json_valid(config_json)),     -- validation packs, thresholds, rule overrides (dataset-level defaults)
  config_schema_version INTEGER NOT NULL DEFAULT 1,
  rule_catalog_version TEXT,
  config_hash TEXT NOT NULL,                                     -- sha256 of canonical config (set by the application)
  note TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (dataset_id, version),
  CHECK (reference_date_mode <> 'fixed' OR reference_date IS NOT NULL),
  CHECK (reference_date_mode <> 'run_date' OR reference_date IS NULL)
);
-- Rule-level control (decision 3: advanced GSTIN checksum / state / PIN packs are configurable per dataset, run and rule)
CREATE TABLE IF NOT EXISTS config_rule_settings (
  id TEXT PRIMARY KEY,
  config_id TEXT NOT NULL REFERENCES analysis_configs(id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  severity_override TEXT CHECK (severity_override IS NULL OR severity_override IN ('critical','high','medium','low')),
  params_json TEXT CHECK (params_json IS NULL OR json_valid(params_json)),
  UNIQUE (config_id, rule_id)
);

-- ---------------------------------------------------------------- INGEST: source rows (canonical, run-independent)
-- One row per source row per file. Lets a dataset be re-analysed without re-upload (approved requirement) and gives every
-- issue / duplicate / conflict a permanent lineage anchor: file -> sheet -> row -> Record_ID -> raw values.
CREATE TABLE IF NOT EXISTS source_rows (
  id TEXT PRIMARY KEY,
  source_file_id TEXT NOT NULL REFERENCES source_files(id) ON DELETE CASCADE,
  row_number INTEGER NOT NULL CHECK (row_number >= 1),           -- 1-based, header excluded (same basis as records.source_row_ref)
  sheet_row INTEGER,                                             -- physical spreadsheet row (header counted): "go to row N in Excel"
  source_sheet TEXT,                                             -- sheet name at ingest; NULL for csv
  row_identifier TEXT,                                           -- dataset-supplied row id (e.g. Record_ID) if mapped. NEVER business evidence.
  raw_json TEXT NOT NULL CHECK (json_valid(raw_json)),           -- verbatim cell values keyed by file_columns.header_key (duplicate headers stay distinct)
  raw_meta_json TEXT CHECK (raw_meta_json IS NULL OR json_valid(raw_meta_json)),   -- per-cell metadata (excel kind, number format)
  raw_hash TEXT NOT NULL,
  ingest_version TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (source_file_id, row_number)
);
CREATE INDEX IF NOT EXISTS idx_source_rows_identifier ON source_rows(source_file_id, row_identifier);
CREATE INDEX IF NOT EXISTS idx_source_rows_hash ON source_rows(raw_hash);

-- ---------------------------------------------------------------- PROFILE: one row per physical column
CREATE TABLE IF NOT EXISTS file_columns (
  id TEXT PRIMARY KEY,
  source_file_id TEXT NOT NULL REFERENCES source_files(id) ON DELETE CASCADE,
  column_index INTEGER NOT NULL CHECK (column_index >= 0),       -- physical position: disambiguates duplicate headers
  header_raw TEXT NOT NULL,                                      -- exactly as in the file
  header_key TEXT NOT NULL,                                      -- unique within the file ("Item", "Item (2)", "Item (3)")
  is_duplicate_header INTEGER NOT NULL DEFAULT 0 CHECK (is_duplicate_header IN (0,1)),
  populated_count INTEGER,
  populated_ratio REAL CHECK (populated_ratio IS NULL OR (populated_ratio >= 0 AND populated_ratio <= 1)),
  distinct_count INTEGER,
  is_empty INTEGER NOT NULL DEFAULT 0 CHECK (is_empty IN (0,1)), -- 100% empty: never generates record-level findings
  cell_kinds_json TEXT CHECK (cell_kinds_json IS NULL OR json_valid(cell_kinds_json)),   -- {"date":1000} from cell metadata
  value_shapes_json TEXT CHECK (value_shapes_json IS NULL OR json_valid(value_shapes_json)),
  profile_json TEXT CHECK (profile_json IS NULL OR json_valid(profile_json)),
  UNIQUE (source_file_id, column_index),
  UNIQUE (source_file_id, header_key)
);

-- ---------------------------------------------------------------- INFER / REVIEW / CONFIRM: schema mappings (versioned)
CREATE TABLE IF NOT EXISTS schema_mappings (
  id TEXT PRIMARY KEY,
  source_file_id TEXT NOT NULL REFERENCES source_files(id) ON DELETE CASCADE,
  file_column_id TEXT NOT NULL REFERENCES file_columns(id) ON DELETE CASCADE,
  mapping_version INTEGER NOT NULL DEFAULT 1 CHECK (mapping_version >= 1),   -- an edit creates a new version; old versions stay
  role TEXT,                                                     -- semantic role id; NULL = unmapped
  role_family TEXT,                                              -- legal_id | entity_id | material_id | doc_id | doc_ref | row_id | audit_user | attribute ...
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  confidence_tier TEXT NOT NULL DEFAULT 'low' CHECK (confidence_tier IN ('high','medium','low')),
  status TEXT NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested','auto_accepted','confirmed','overridden','rejected')),
  is_critical_identity INTEGER NOT NULL DEFAULT 0 CHECK (is_critical_identity IN (0,1)),
  review_required INTEGER NOT NULL DEFAULT 0 CHECK (review_required IN (0,1)),
  review_reason TEXT,                                            -- e.g. header/content conflict
  requiredness TEXT NOT NULL DEFAULT 'unknown' CHECK (requiredness IN ('required','expected','optional','unknown')),
  requiredness_source TEXT NOT NULL DEFAULT 'inferred' CHECK (requiredness_source IN ('inferred','user','rule','sap_domain')),
  include_in_analysis INTEGER NOT NULL DEFAULT 1 CHECK (include_in_analysis IN (0,1)),
  alternatives_json TEXT CHECK (alternatives_json IS NULL OR json_valid(alternatives_json)),   -- important alternative mappings
  evidence_json TEXT CHECK (evidence_json IS NULL OR json_valid(evidence_json)),               -- header tokens, content shape, vocabulary hits
  decided_by TEXT REFERENCES users(id),
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (file_column_id, mapping_version),
  -- decision 5: "95% populated" can suggest EXPECTED but never proves REQUIRED; required needs user / rule / domain authority
  CHECK (requiredness <> 'required' OR requiredness_source IN ('user','rule','sap_domain')),
  -- HIGH confidence may be auto-accepted; anything else needs a human; CRITICAL identity roles never auto-accept below HIGH
  CHECK (status <> 'auto_accepted' OR confidence_tier = 'high')
);
CREATE INDEX IF NOT EXISTS idx_schema_mappings_file ON schema_mappings(source_file_id, mapping_version);

-- ---------------------------------------------------------------- run provenance: which files + which mapping version each run used
CREATE TABLE IF NOT EXISTS run_inputs (
  run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  source_file_id TEXT NOT NULL REFERENCES source_files(id) ON DELETE CASCADE,
  mapping_version INTEGER NOT NULL CHECK (mapping_version >= 1),
  row_count INTEGER NOT NULL,
  content_sha256 TEXT,
  PRIMARY KEY (run_id, source_file_id)
);

-- ---------------------------------------------------------------- analysis_runs: engine version, lineage, frozen config
-- engine_version DEFAULT 'legacy_v0': every run created by today's engine (and every pre-existing run) is stamped legacy
-- automatically, with no change to the legacy code path. The v1 engine stamps its own version explicitly.
ALTER TABLE analysis_runs ADD COLUMN engine_version TEXT NOT NULL DEFAULT 'legacy_v0';
ALTER TABLE analysis_runs ADD COLUMN parent_run_id TEXT REFERENCES analysis_runs(id);   -- re-run lineage (no SET NULL action: FK actions run as UPDATEs and would hit the completed-run guards)
ALTER TABLE analysis_runs ADD COLUMN rerun_reason TEXT;
ALTER TABLE analysis_runs ADD COLUMN config_id TEXT REFERENCES analysis_configs(id);
ALTER TABLE analysis_runs ADD COLUMN config_hash TEXT;
ALTER TABLE analysis_runs ADD COLUMN effective_config_json TEXT CHECK (effective_config_json IS NULL OR json_valid(effective_config_json));
ALTER TABLE analysis_runs ADD COLUMN table_type TEXT
  CHECK (table_type IS NULL OR table_type IN ('master_entity','master_material','transaction','mixed_unknown'));
-- Reproducibility: the reference date is resolved when the run STARTS and frozen. Nothing may ever read the server clock afterwards.
-- NULL for legacy runs = "not recorded" (the legacy engine used the server clock implicitly and never stored it).
ALTER TABLE analysis_runs ADD COLUMN reference_date TEXT
  CHECK (reference_date IS NULL OR reference_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]');
ALTER TABLE analysis_runs ADD COLUMN stale_threshold_years REAL CHECK (stale_threshold_years IS NULL OR stale_threshold_years > 0);
ALTER TABLE analysis_runs ADD COLUMN input_hash TEXT;      -- sha256(source rows + mapping version + config hash): "same inputs => same results"
CREATE INDEX IF NOT EXISTS idx_runs_dataset ON analysis_runs(dataset_id, started_at);
CREATE INDEX IF NOT EXISTS idx_runs_parent ON analysis_runs(parent_run_id);
CREATE INDEX IF NOT EXISTS idx_runs_engine ON analysis_runs(engine_version);

-- ---------------------------------------------------------------- records: lineage, normalized values, business hashes
ALTER TABLE records ADD COLUMN source_row_id TEXT REFERENCES source_rows(id);
ALTER TABLE records ADD COLUMN source_sheet TEXT;
ALTER TABLE records ADD COLUMN row_identifier TEXT;                -- Record_ID etc. Traceability only, never evidence.
ALTER TABLE records ADD COLUMN business_key_json TEXT CHECK (business_key_json IS NULL OR json_valid(business_key_json));
-- Business content EXCLUDING row id / ingestion / source-file / sheet / row metadata (decision 1).
-- business_hash includes audit dates when they belong to the master-record snapshot; business_hash_excl_audit does not, which
-- is what separates exact_business_duplicate from audit_date_variant without hard-coding "audit dates always count".
ALTER TABLE records ADD COLUMN business_hash TEXT;
ALTER TABLE records ADD COLUMN business_hash_excl_audit TEXT;
ALTER TABLE records ADD COLUMN normalization_version TEXT;
CREATE INDEX IF NOT EXISTS idx_records_source_row ON records(source_row_id);
CREATE INDEX IF NOT EXISTS idx_records_business_hash ON records(run_id, business_hash);
CREATE INDEX IF NOT EXISTS idx_records_business_hash_core ON records(run_id, business_hash_excl_audit);

-- ---------------------------------------------------------------- quality_issues: rule identity, scope, requiredness, values
ALTER TABLE quality_issues ADD COLUMN rule_id TEXT;                -- stable id, e.g. validity.gstin.structure
ALTER TABLE quality_issues ADD COLUMN rule_version TEXT;
ALTER TABLE quality_issues ADD COLUMN scope TEXT NOT NULL DEFAULT 'record' CHECK (scope IN ('record','field','dataset'));
ALTER TABLE quality_issues ADD COLUMN file_column_id TEXT REFERENCES file_columns(id);
ALTER TABLE quality_issues ADD COLUMN requiredness TEXT CHECK (requiredness IS NULL OR requiredness IN ('required','expected','optional','unknown'));
ALTER TABLE quality_issues ADD COLUMN observed_value TEXT;         -- raw value that triggered the issue
ALTER TABLE quality_issues ADD COLUMN normalized_value TEXT;
ALTER TABLE quality_issues ADD COLUMN evidence_json TEXT CHECK (evidence_json IS NULL OR json_valid(evidence_json));
ALTER TABLE quality_issues ADD COLUMN affects_score INTEGER NOT NULL DEFAULT 1 CHECK (affects_score IN (0,1));
CREATE INDEX IF NOT EXISTS idx_issues_rule ON quality_issues(run_id, rule_id);
CREATE INDEX IF NOT EXISTS idx_issues_scope ON quality_issues(run_id, scope);
CREATE INDEX IF NOT EXISTS idx_issues_column ON quality_issues(file_column_id);

-- ---------------------------------------------------------------- entity_clusters: explicit duplicate classes
-- match_class (decision 1): exact_business_duplicate | normalized_duplicate | entity_match | attribute_variant | audit_date_variant | fuzzy_candidate
-- match_subtype is open-ended text, e.g. 'identity_match_vendor_code_variant' (same GSTIN + compatible name + different vendor codes).
ALTER TABLE entity_clusters ADD COLUMN match_class TEXT CHECK (match_class IS NULL OR match_class IN
  ('exact_business_duplicate','normalized_duplicate','entity_match','attribute_variant','audit_date_variant','fuzzy_candidate'));
ALTER TABLE entity_clusters ADD COLUMN match_subtype TEXT;
ALTER TABLE entity_clusters ADD COLUMN composition_json TEXT CHECK (composition_json IS NULL OR json_valid(composition_json));
ALTER TABLE entity_clusters ADD COLUMN decision_reason TEXT;
ALTER TABLE entity_clusters ADD COLUMN review_status TEXT NOT NULL DEFAULT 'not_required'
  CHECK (review_status IN ('not_required','pending','confirmed','rejected'));
CREATE INDEX IF NOT EXISTS idx_clusters_class ON entity_clusters(run_id, match_class);

-- ---------------------------------------------------------------- match_pairs: decision, class, review (decision 4: fuzzy never auto-clusters)
ALTER TABLE match_pairs ADD COLUMN cluster_id TEXT REFERENCES entity_clusters(id);
ALTER TABLE match_pairs ADD COLUMN pair_class TEXT CHECK (pair_class IS NULL OR pair_class IN
  ('exact_business_duplicate','normalized_duplicate','entity_match','attribute_variant','audit_date_variant','fuzzy_candidate'));
ALTER TABLE match_pairs ADD COLUMN pair_subtype TEXT;
-- 'not_same' stores near-misses so the app can answer "why were these records NOT considered duplicates?"
ALTER TABLE match_pairs ADD COLUMN decision TEXT CHECK (decision IS NULL OR decision IN ('same_entity','fuzzy_candidate','not_same','conflict','ambiguous'));
ALTER TABLE match_pairs ADD COLUMN reason_text TEXT;
ALTER TABLE match_pairs ADD COLUMN review_status TEXT NOT NULL DEFAULT 'not_required'
  CHECK (review_status IN ('not_required','pending','confirmed','rejected'));
ALTER TABLE match_pairs ADD COLUMN reviewed_by TEXT REFERENCES users(id);
ALTER TABLE match_pairs ADD COLUMN reviewed_at TEXT;
ALTER TABLE match_pairs ADD COLUMN review_note TEXT;
ALTER TABLE match_pairs ADD COLUMN is_scored INTEGER NOT NULL DEFAULT 1 CHECK (is_scored IN (0,1));   -- fuzzy candidates are excluded until confirmed
CREATE INDEX IF NOT EXISTS idx_matchpairs_class ON match_pairs(run_id, pair_class);
CREATE INDEX IF NOT EXISTS idx_matchpairs_review ON match_pairs(run_id, review_status);
CREATE INDEX IF NOT EXISTS idx_matchpairs_cluster ON match_pairs(cluster_id);

-- per-field evidence for every pair: the data behind "why were these two records (not) duplicates / which field caused the conflict"
CREATE TABLE IF NOT EXISTS match_evidence (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  match_pair_id TEXT NOT NULL REFERENCES match_pairs(id) ON DELETE CASCADE,
  field_role TEXT NOT NULL,                                      -- e.g. legal_id, entity_name, vendor_code, phone
  column_a TEXT, column_b TEXT,
  value_a_raw TEXT, value_b_raw TEXT,
  value_a_normalized TEXT, value_b_normalized TEXT,
  relation TEXT NOT NULL CHECK (relation IN ('equal','equal_normalized','similar','different','missing_a','missing_b','missing_both','invalid_a','invalid_b','not_comparable')),
  similarity REAL CHECK (similarity IS NULL OR (similarity >= 0 AND similarity <= 1)),
  evidence_class TEXT NOT NULL CHECK (evidence_class IN ('hard_agree','hard_conflict','strong_support','weak_support','neutral','contradiction')),
  weight REAL,
  explanation TEXT
);
CREATE INDEX IF NOT EXISTS idx_evidence_pair ON match_evidence(match_pair_id);
CREATE INDEX IF NOT EXISTS idx_evidence_run ON match_evidence(run_id);

-- ---------------------------------------------------------------- conflict groups (one row per distinct member set: fixes 3x inflation)
CREATE TABLE IF NOT EXISTS conflict_groups (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  conflict_type TEXT NOT NULL,     -- gstin_shared_identity | gstin_mismatch | vendor_code_identity | identity_name_conflict | item_code_description_conflict | ...
  severity TEXT NOT NULL CHECK (severity IN ('critical','high','medium','low')),
  subject_role TEXT,               -- role the group is about, e.g. legal_id
  subject_value TEXT,              -- the shared / conflicting value
  member_set_hash TEXT NOT NULL,   -- sha256 of the sorted member record ids
  member_count INTEGER NOT NULL CHECK (member_count >= 2),
  fields_json TEXT CHECK (fields_json IS NULL OR json_valid(fields_json)),   -- which fields agree / differ
  explanation TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (run_id, conflict_type, member_set_hash)                 -- the same group can never be stored twice
);
CREATE INDEX IF NOT EXISTS idx_conflict_groups_run ON conflict_groups(run_id, conflict_type);
CREATE TABLE IF NOT EXISTS conflict_group_members (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  conflict_group_id TEXT NOT NULL REFERENCES conflict_groups(id) ON DELETE CASCADE,
  record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  member_role TEXT NOT NULL DEFAULT 'member' CHECK (member_role IN ('member','majority','minority')),
  values_json TEXT CHECK (values_json IS NULL OR json_valid(values_json)),
  UNIQUE (conflict_group_id, record_id)
);
CREATE INDEX IF NOT EXISTS idx_cgm_group ON conflict_group_members(conflict_group_id);
CREATE INDEX IF NOT EXISTS idx_cgm_record ON conflict_group_members(record_id);

-- ---------------------------------------------------------------- scoring: which rule affected which score, and by how much
CREATE TABLE IF NOT EXISTS score_contributions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  dimension TEXT NOT NULL CHECK (dimension IN ('completeness','validity','uniqueness','consistency','freshness')),
  rule_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('cell','record','dataset')),
  opportunities INTEGER NOT NULL CHECK (opportunities >= 0),     -- how many things the rule could have flagged
  defects INTEGER NOT NULL CHECK (defects >= 0),
  defect_rate REAL NOT NULL CHECK (defect_rate >= 0 AND defect_rate <= 1),
  severity_weight REAL NOT NULL CHECK (severity_weight >= 0),
  penalty_points REAL NOT NULL CHECK (penalty_points >= 0),      -- points removed from the dimension score
  explanation TEXT,
  UNIQUE (run_id, dimension, rule_id),
  CHECK (defects <= opportunities)
);
CREATE INDEX IF NOT EXISTS idx_score_contrib_run ON score_contributions(run_id, dimension);
CREATE TABLE IF NOT EXISTS run_scores (
  run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  dimension TEXT NOT NULL CHECK (dimension IN ('overall','completeness','validity','uniqueness','consistency','freshness')),
  score REAL NOT NULL CHECK (score >= 0 AND score <= 100),
  weight REAL CHECK (weight IS NULL OR (weight >= 0 AND weight <= 1)),
  formula_version TEXT NOT NULL,
  PRIMARY KEY (run_id, dimension)
);
