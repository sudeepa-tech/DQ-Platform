-- ============================================================================
-- 0006  S3 semantic layer: stored column profiles, versioned mapping sets, per-column validation/override fields
-- ----------------------------------------------------------------------------
-- Additive. Structural invariants only: a LOCKED mapping set (and its column mappings) can no longer be changed - a change is a NEW mapping version.
-- All semantic decisions (thresholds, role weights, requiredness defaults, validation catalogue) live in versioned application configuration,
-- which is copied into every mapping set (semantic_config_json) and into every run configuration snapshot.
-- ============================================================================
CREATE TABLE IF NOT EXISTS column_profiles (
  id TEXT PRIMARY KEY,
  source_file_id TEXT NOT NULL REFERENCES source_files(id) ON DELETE CASCADE,
  file_column_id TEXT NOT NULL REFERENCES file_columns(id) ON DELETE CASCADE,
  profile_version TEXT NOT NULL,
  profile_json TEXT NOT NULL CHECK (json_valid(profile_json)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (file_column_id, profile_version)
);
CREATE INDEX IF NOT EXISTS idx_column_profiles_file ON column_profiles(source_file_id, profile_version);

CREATE TABLE IF NOT EXISTS schema_mapping_sets (
  id TEXT PRIMARY KEY,
  source_file_id TEXT NOT NULL REFERENCES source_files(id) ON DELETE CASCADE,
  mapping_version INTEGER NOT NULL CHECK (mapping_version >= 1),
  parent_mapping_version INTEGER,                                            -- the version this one was revised from
  dataset_type TEXT NOT NULL CHECK (dataset_type IN ('master_entity','master_material','transaction','mixed_unknown')),
  dataset_type_confidence REAL CHECK (dataset_type_confidence IS NULL OR (dataset_type_confidence >= 0 AND dataset_type_confidence <= 1)),
  dataset_type_source TEXT NOT NULL DEFAULT 'classifier' CHECK (dataset_type_source IN ('classifier','user')),
  suggested_dataset_type TEXT,
  dataset_type_needs_review INTEGER NOT NULL DEFAULT 0 CHECK (dataset_type_needs_review IN (0,1)),
  dataset_type_evidence_json TEXT CHECK (dataset_type_evidence_json IS NULL OR json_valid(dataset_type_evidence_json)),
  engine_version TEXT NOT NULL,
  taxonomy_version TEXT NOT NULL,
  profile_version TEXT NOT NULL,
  semantic_config_json TEXT NOT NULL CHECK (json_valid(semantic_config_json)),
  semantic_config_hash TEXT NOT NULL,
  input_fingerprint TEXT NOT NULL,                                           -- sha256(content, ingest settings, semantic config, versions): "same inputs => same suggestion"
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','confirmed')),
  locked_at TEXT,
  confirmed_by TEXT REFERENCES users(id),
  confirmed_at TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  note TEXT,
  UNIQUE (source_file_id, mapping_version)
);

ALTER TABLE schema_mappings ADD COLUMN validation_profile_json TEXT CHECK (validation_profile_json IS NULL OR json_valid(validation_profile_json));
ALTER TABLE schema_mappings ADD COLUMN suggested_role TEXT;                  -- what the classifier proposed (kept when the user overrides)
ALTER TABLE schema_mappings ADD COLUMN suggested_requiredness TEXT;
ALTER TABLE schema_mappings ADD COLUMN user_overridden INTEGER NOT NULL DEFAULT 0 CHECK (user_overridden IN (0,1));
ALTER TABLE schema_mappings ADD COLUMN override_note TEXT;
ALTER TABLE schema_mappings ADD COLUMN requiredness_reason TEXT;
ALTER TABLE schema_mappings ADD COLUMN review_reasons_json TEXT CHECK (review_reasons_json IS NULL OR json_valid(review_reasons_json));
ALTER TABLE schema_mappings ADD COLUMN primary_for_role INTEGER CHECK (primary_for_role IS NULL OR primary_for_role IN (0,1));
ALTER TABLE schema_mappings ADD COLUMN content_type TEXT;

-- structural: a locked mapping set is immutable, and so are its column mappings (a change = a new mapping version)
CREATE TRIGGER IF NOT EXISTS trg_mapping_sets_locked_immutable
BEFORE UPDATE ON schema_mapping_sets
WHEN OLD.locked_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'a locked mapping set is immutable: revise it into a new mapping version'); END;

CREATE TRIGGER IF NOT EXISTS trg_schema_mappings_locked_insert
BEFORE INSERT ON schema_mappings
WHEN EXISTS (SELECT 1 FROM schema_mapping_sets s WHERE s.source_file_id = NEW.source_file_id AND s.mapping_version = NEW.mapping_version AND s.locked_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'a locked mapping set is immutable: revise it into a new mapping version'); END;

CREATE TRIGGER IF NOT EXISTS trg_schema_mappings_locked_update
BEFORE UPDATE ON schema_mappings
WHEN EXISTS (SELECT 1 FROM schema_mapping_sets s WHERE s.source_file_id = OLD.source_file_id AND s.mapping_version = OLD.mapping_version AND s.locked_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'a locked mapping set is immutable: revise it into a new mapping version'); END;
