-- ============================================================================
-- 0005  Business semantics out of the database layer (architectural correction of 0002/0003)
-- ----------------------------------------------------------------------------
-- Database triggers/CHECKs enforce STRUCTURAL invariants. Evolving business decisions are versioned analysis/rule configuration
-- enforced by the engine (and its tests), so they can change per dataset and engine version without a schema migration. 0002/0003 encoded
-- four such decisions in the database; they are removed here (forward-only; no data is touched):
--   * requiredness -> severity mapping, and "optional gaps are not defects"          (was trg_issues_scope_and_requiredness_*)
--   * fuzzy-candidate clustering / scoring policy                                    (was trg_pairs_fuzzy_guard_*, trg_clusters_fuzzy_guard_*)
--   * "a heuristic can never make a field REQUIRED" / auto-accept confidence policy  (was two CHECK constraints on schema_mappings)
-- What stays: enumerations of state names (vocabulary), lineage/immutability/provenance triggers, uniqueness, JSON validity, foreign keys.
-- ============================================================================
DROP TRIGGER IF EXISTS trg_pairs_fuzzy_guard_insert;
DROP TRIGGER IF EXISTS trg_pairs_fuzzy_guard_update;
DROP TRIGGER IF EXISTS trg_clusters_fuzzy_guard_insert;
DROP TRIGGER IF EXISTS trg_clusters_fuzzy_guard_update;
DROP TRIGGER IF EXISTS trg_issues_scope_and_requiredness_insert;
DROP TRIGGER IF EXISTS trg_issues_scope_and_requiredness_update;

-- structural half of the old issue guard: an issue whose scope is the dataset or a field is not attached to a record
CREATE TRIGGER IF NOT EXISTS trg_issues_scope_no_record_insert BEFORE INSERT ON quality_issues
WHEN NEW.scope IN ('dataset','field') AND NEW.record_id IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'dataset/field-scope issues carry no record id'); END;
CREATE TRIGGER IF NOT EXISTS trg_issues_scope_no_record_update BEFORE UPDATE OF scope, record_id ON quality_issues
WHEN NEW.scope IN ('dataset','field') AND NEW.record_id IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'dataset/field-scope issues carry no record id'); END;

-- schema_mappings: same table without the two policy CHECKs (the table is new in 0002 and empty until S3; rows are copied anyway)
CREATE TABLE schema_mappings_new (
  id TEXT PRIMARY KEY,
  source_file_id TEXT NOT NULL REFERENCES source_files(id) ON DELETE CASCADE,
  file_column_id TEXT NOT NULL REFERENCES file_columns(id) ON DELETE CASCADE,
  mapping_version INTEGER NOT NULL DEFAULT 1 CHECK (mapping_version >= 1),
  role TEXT,
  role_family TEXT,
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  confidence_tier TEXT NOT NULL DEFAULT 'low' CHECK (confidence_tier IN ('high','medium','low')),
  status TEXT NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested','auto_accepted','confirmed','overridden','rejected')),
  is_critical_identity INTEGER NOT NULL DEFAULT 0 CHECK (is_critical_identity IN (0,1)),
  review_required INTEGER NOT NULL DEFAULT 0 CHECK (review_required IN (0,1)),
  review_reason TEXT,
  requiredness TEXT NOT NULL DEFAULT 'unknown' CHECK (requiredness IN ('required','expected','optional','unknown')),
  requiredness_source TEXT NOT NULL DEFAULT 'inferred' CHECK (requiredness_source IN ('inferred','user','rule','sap_domain')),
  include_in_analysis INTEGER NOT NULL DEFAULT 1 CHECK (include_in_analysis IN (0,1)),
  alternatives_json TEXT CHECK (alternatives_json IS NULL OR json_valid(alternatives_json)),
  evidence_json TEXT CHECK (evidence_json IS NULL OR json_valid(evidence_json)),
  decided_by TEXT REFERENCES users(id),
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (file_column_id, mapping_version)
);
INSERT INTO schema_mappings_new (id, source_file_id, file_column_id, mapping_version, role, role_family, confidence, confidence_tier, status, is_critical_identity, review_required,
    review_reason, requiredness, requiredness_source, include_in_analysis, alternatives_json, evidence_json, decided_by, decided_at, created_at)
  SELECT id, source_file_id, file_column_id, mapping_version, role, role_family, confidence, confidence_tier, status, is_critical_identity, review_required,
    review_reason, requiredness, requiredness_source, include_in_analysis, alternatives_json, evidence_json, decided_by, decided_at, created_at FROM schema_mappings;
DROP TABLE schema_mappings;
ALTER TABLE schema_mappings_new RENAME TO schema_mappings;
CREATE INDEX IF NOT EXISTS idx_schema_mappings_file ON schema_mappings(source_file_id, mapping_version);
-- structural lineage (kept): a mapping must reference a column of the same file
CREATE TRIGGER IF NOT EXISTS trg_schema_mappings_column_consistent BEFORE INSERT ON schema_mappings
WHEN (SELECT source_file_id FROM file_columns WHERE id = NEW.file_column_id) IS NOT NEW.source_file_id
BEGIN SELECT RAISE(ABORT, 'schema mapping must reference a column of the same file'); END;
