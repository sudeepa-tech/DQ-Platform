-- ============================================================================
-- 0007  S6 pipeline integration: the persisted FINDING MODEL and the state vocabularies the production pipeline needs
-- ----------------------------------------------------------------------------
-- Structural changes only (business policy stays in versioned engine configuration, per 0005):
--   * quality_issues   scope widened to record|field|dataset|group|cluster|conflict_group|pair  (a finding no longer needs ONE record id);
--                      + source lineage (file, sheet, physical row), links to cluster / conflict group / pair, engine + config version per finding
--   * match_pairs      similarity_score / confidence become NULLABLE (a candidate carries NO score until a human confirms);
--                      pair_class += material_match | transaction_duplicate | ambiguous_entity ; decision += candidate
--   * entity_clusters  confidence NULLABLE (candidate groups); match_class += material_match
--   * finding_members  relational membership for group / cluster / conflict-group findings (which records a finding involves)
--   * run_rule_stats   per-run, per-rule defect counts (the persisted input contract for S7 scoring; S6 computes NO score)
--   * source_files.purged_at   retention: the ORIGINAL file may be purged after ingest; canonical rows (and every run) are unaffected
-- The three rebuilt tables are copied row-for-row (children are restored too); every trigger and index is re-created. No v1 result table has ever been
-- populated by a production path, and legacy rows carry NULL in every new column.
-- ============================================================================

CREATE TEMP TABLE _bk_clusters AS SELECT * FROM entity_clusters;
CREATE TEMP TABLE _bk_members AS SELECT * FROM entity_cluster_members;
CREATE TEMP TABLE _bk_pairs AS SELECT * FROM match_pairs;
CREATE TEMP TABLE _bk_evidence AS SELECT * FROM match_evidence;
CREATE TEMP TABLE _bk_issues AS SELECT * FROM quality_issues;
DROP TRIGGER IF EXISTS trg_match_evidence_writable;
DROP TRIGGER IF EXISTS trg_match_evidence_run_consistent;
DROP TABLE quality_issues;
DROP TABLE match_evidence;
DROP TABLE match_pairs;
DROP TABLE entity_cluster_members;
DROP TABLE entity_clusters;

CREATE TABLE entity_clusters (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  cluster_kind TEXT NOT NULL DEFAULT 'entity', -- entity | item
  representative_name TEXT,
  record_count INTEGER NOT NULL,
  confidence REAL,
  matching_factors_json TEXT,   -- e.g. ["GSTIN match","Phone match","Name similarity: 94%"]
  conflicts_json TEXT,          -- e.g. ["Different vendor codes"]
  is_exact_repeat INTEGER NOT NULL DEFAULT 0,
  -- TRUE when every member is byte-identical (case/whitespace aside) on
  -- the field(s) used to match them -- i.e. this is the same known
  -- entity/item recurring (e.g. a vendor referenced on many transaction
  -- lines), not a spelling/formatting variant that needs a human's
  -- attention. Kept separate from confidence: a cluster can be 100%
  -- confident AND be an exact repeat, or 100% confident and be a genuine
  -- variant (e.g. "BluePeak Traders 02" vs "BluePeak  Traders  02").
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
, match_class TEXT CHECK (match_class IS NULL OR match_class IN
  ('exact_business_duplicate','normalized_duplicate','entity_match','attribute_variant','audit_date_variant','fuzzy_candidate','material_match')), match_subtype TEXT, composition_json TEXT CHECK (composition_json IS NULL OR json_valid(composition_json)), decision_reason TEXT, review_status TEXT NOT NULL DEFAULT 'not_required'
  CHECK (review_status IN ('not_required','pending','confirmed','rejected')));
CREATE TABLE entity_cluster_members (
  id TEXT PRIMARY KEY,
  cluster_id TEXT NOT NULL REFERENCES entity_clusters(id) ON DELETE CASCADE,
  record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE
);
CREATE TABLE match_pairs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  record_a_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  record_b_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  match_type TEXT NOT NULL, -- exact|normalized|fuzzy|multi_field|semantic
  similarity_score REAL,
  confidence REAL,
  matching_factors_json TEXT,
  conflicting_factors_json TEXT
, cluster_id TEXT REFERENCES entity_clusters(id), pair_class TEXT CHECK (pair_class IS NULL OR pair_class IN
  ('exact_business_duplicate','normalized_duplicate','entity_match','attribute_variant','audit_date_variant','fuzzy_candidate','material_match','transaction_duplicate','ambiguous_entity')), pair_subtype TEXT, decision TEXT CHECK (decision IS NULL OR decision IN ('same_entity','fuzzy_candidate','not_same','conflict','ambiguous','candidate')), reason_text TEXT, review_status TEXT NOT NULL DEFAULT 'not_required'
  CHECK (review_status IN ('not_required','pending','confirmed','rejected')), reviewed_by TEXT REFERENCES users(id), reviewed_at TEXT, review_note TEXT, is_scored INTEGER NOT NULL DEFAULT 1 CHECK (is_scored IN (0,1)));
CREATE TABLE match_evidence (
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
CREATE TABLE quality_issues (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  record_id TEXT REFERENCES records(id) ON DELETE CASCADE,
  category TEXT NOT NULL,     -- completeness|validity|uniqueness|consistency|freshness
  issue_type TEXT NOT NULL,   -- e.g. missing_required_field, invalid_email, exact_duplicate...
  severity TEXT NOT NULL,     -- critical|high|medium|low
  field_name TEXT,
  explanation TEXT NOT NULL,
  detection_method TEXT NOT NULL, -- rule|statistical|fuzzy|ai
  confidence REAL,
  extra_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
, rule_id TEXT, rule_version TEXT, scope TEXT NOT NULL DEFAULT 'record' CHECK (scope IN ('record','field','dataset','group','cluster','conflict_group','pair')), file_column_id TEXT REFERENCES file_columns(id), requiredness TEXT CHECK (requiredness IS NULL OR requiredness IN ('required','expected','optional','unknown')), observed_value TEXT, normalized_value TEXT, evidence_json TEXT CHECK (evidence_json IS NULL OR json_valid(evidence_json)), affects_score INTEGER NOT NULL DEFAULT 1 CHECK (affects_score IN (0,1)),
  source_file_id TEXT REFERENCES source_files(id),
  source_sheet TEXT,
  sheet_row INTEGER,
  row_number INTEGER,
  cluster_id TEXT REFERENCES entity_clusters(id),
  conflict_group_id TEXT REFERENCES conflict_groups(id),
  match_pair_id TEXT REFERENCES match_pairs(id),
  engine_version TEXT,
  config_version TEXT
);

INSERT INTO entity_clusters (id, run_id, cluster_kind, representative_name, record_count, confidence, matching_factors_json, conflicts_json, is_exact_repeat, created_at, match_class, match_subtype, composition_json, decision_reason, review_status) SELECT id, run_id, cluster_kind, representative_name, record_count, confidence, matching_factors_json, conflicts_json, is_exact_repeat, created_at, match_class, match_subtype, composition_json, decision_reason, review_status FROM _bk_clusters;
INSERT INTO entity_cluster_members (id, cluster_id, record_id) SELECT id, cluster_id, record_id FROM _bk_members;
INSERT INTO match_pairs (id, run_id, record_a_id, record_b_id, match_type, similarity_score, confidence, matching_factors_json, conflicting_factors_json, cluster_id, pair_class, pair_subtype, decision, reason_text, review_status, reviewed_by, reviewed_at, review_note, is_scored) SELECT id, run_id, record_a_id, record_b_id, match_type, similarity_score, confidence, matching_factors_json, conflicting_factors_json, cluster_id, pair_class, pair_subtype, decision, reason_text, review_status, reviewed_by, reviewed_at, review_note, is_scored FROM _bk_pairs;
INSERT INTO match_evidence (id, run_id, match_pair_id, field_role, column_a, column_b, value_a_raw, value_b_raw, value_a_normalized, value_b_normalized, relation, similarity, evidence_class, weight, explanation) SELECT id, run_id, match_pair_id, field_role, column_a, column_b, value_a_raw, value_b_raw, value_a_normalized, value_b_normalized, relation, similarity, evidence_class, weight, explanation FROM _bk_evidence;
INSERT INTO quality_issues (id, run_id, record_id, category, issue_type, severity, field_name, explanation, detection_method, confidence, extra_json, created_at, rule_id, rule_version, scope, file_column_id, requiredness, observed_value, normalized_value, evidence_json, affects_score) SELECT id, run_id, record_id, category, issue_type, severity, field_name, explanation, detection_method, confidence, extra_json, created_at, rule_id, rule_version, scope, file_column_id, requiredness, observed_value, normalized_value, evidence_json, affects_score FROM _bk_issues;

DROP TABLE _bk_clusters; DROP TABLE _bk_members; DROP TABLE _bk_pairs; DROP TABLE _bk_evidence; DROP TABLE _bk_issues;

CREATE INDEX idx_clusters_run ON entity_clusters(run_id);

CREATE INDEX idx_clusters_class ON entity_clusters(run_id, match_class);

CREATE INDEX idx_cluster_members_cluster ON entity_cluster_members(cluster_id);

CREATE INDEX idx_cluster_members_record ON entity_cluster_members(record_id);

CREATE INDEX idx_matchpairs_run ON match_pairs(run_id);

CREATE INDEX idx_matchpairs_class ON match_pairs(run_id, pair_class);

CREATE INDEX idx_matchpairs_review ON match_pairs(run_id, review_status);

CREATE INDEX idx_matchpairs_cluster ON match_pairs(cluster_id);

CREATE INDEX idx_evidence_pair ON match_evidence(match_pair_id);

CREATE INDEX idx_evidence_run ON match_evidence(run_id);

CREATE INDEX idx_issues_run ON quality_issues(run_id);

CREATE INDEX idx_issues_severity ON quality_issues(run_id, severity);

CREATE INDEX idx_issues_category ON quality_issues(run_id, category);

CREATE INDEX idx_issues_rule ON quality_issues(run_id, rule_id);

CREATE INDEX idx_issues_scope ON quality_issues(run_id, scope);

CREATE INDEX idx_issues_column ON quality_issues(file_column_id);

CREATE TRIGGER trg_clusters_complete_frozen
BEFORE UPDATE OF cluster_kind, representative_name, record_count, confidence, matching_factors_json, conflicts_json, is_exact_repeat,
                 match_class, match_subtype, composition_json, decision_reason ON entity_clusters
WHEN (SELECT status FROM analysis_runs WHERE id = OLD.run_id) = 'complete'
BEGIN SELECT RAISE(ABORT, 'results of a completed run are immutable'); END;

CREATE TRIGGER trg_pairs_complete_frozen
BEFORE UPDATE OF record_a_id, record_b_id, match_type, similarity_score, confidence, matching_factors_json, conflicting_factors_json,
                 cluster_id, pair_class, pair_subtype, decision, reason_text, is_scored ON match_pairs
WHEN (SELECT status FROM analysis_runs WHERE id = OLD.run_id) = 'complete'
BEGIN SELECT RAISE(ABORT, 'results of a completed run are immutable'); END;

CREATE TRIGGER trg_match_evidence_writable BEFORE INSERT ON match_evidence
WHEN (SELECT engine_version FROM analysis_runs WHERE id = NEW.run_id) = 'legacy_v0' OR (SELECT status FROM analysis_runs WHERE id = NEW.run_id) = 'complete'
BEGIN SELECT RAISE(ABORT, 'v1 result rows cannot be written to a legacy run or a completed run'); END;

CREATE TRIGGER trg_match_evidence_run_consistent BEFORE INSERT ON match_evidence
WHEN (SELECT run_id FROM match_pairs WHERE id = NEW.match_pair_id) IS NOT NEW.run_id
BEGIN SELECT RAISE(ABORT, 'evidence must belong to a pair of the same run'); END;

CREATE TRIGGER trg_issues_complete_frozen
BEFORE UPDATE OF record_id, category, issue_type, severity, field_name, explanation, detection_method, confidence, extra_json,
                 rule_id, rule_version, scope, file_column_id, requiredness, observed_value, normalized_value, evidence_json, affects_score,
                 source_file_id, source_sheet, sheet_row, row_number, cluster_id, conflict_group_id, match_pair_id, engine_version, config_version ON quality_issues
WHEN (SELECT status FROM analysis_runs WHERE id = OLD.run_id) = 'complete'
BEGIN SELECT RAISE(ABORT, 'results of a completed run are immutable'); END;

CREATE TRIGGER trg_issues_scope_no_record_insert BEFORE INSERT ON quality_issues
WHEN NEW.scope IN ('dataset','field') AND NEW.record_id IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'dataset/field-scope issues carry no record id'); END;

CREATE TRIGGER trg_issues_scope_no_record_update BEFORE UPDATE OF scope, record_id ON quality_issues
WHEN NEW.scope IN ('dataset','field') AND NEW.record_id IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'dataset/field-scope issues carry no record id'); END;

CREATE INDEX IF NOT EXISTS idx_issues_cluster ON quality_issues(cluster_id) WHERE cluster_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_issues_conflict_group ON quality_issues(conflict_group_id) WHERE conflict_group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_issues_pair ON quality_issues(match_pair_id) WHERE match_pair_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_issues_record ON quality_issues(record_id) WHERE record_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_issues_source ON quality_issues(run_id, source_file_id, row_number);

-- ------------------------------------------------ relational membership of a finding (group / cluster / conflict-group / pair findings)
CREATE TABLE IF NOT EXISTS finding_members (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  finding_id TEXT NOT NULL REFERENCES quality_issues(id) ON DELETE CASCADE,
  record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  member_role TEXT NOT NULL DEFAULT 'member' CHECK (member_role IN ('member','majority','minority','a','b')),
  values_json TEXT CHECK (values_json IS NULL OR json_valid(values_json)),
  UNIQUE (finding_id, record_id)
);
CREATE INDEX IF NOT EXISTS idx_finding_members_finding ON finding_members(finding_id);
CREATE INDEX IF NOT EXISTS idx_finding_members_record ON finding_members(record_id);
CREATE TRIGGER IF NOT EXISTS trg_finding_members_run_consistent BEFORE INSERT ON finding_members
WHEN (SELECT run_id FROM quality_issues WHERE id = NEW.finding_id) IS NOT NEW.run_id OR (SELECT run_id FROM records WHERE id = NEW.record_id) IS NOT NEW.run_id
BEGIN SELECT RAISE(ABORT, 'finding members must belong to the same run as the finding'); END;
CREATE TRIGGER IF NOT EXISTS trg_finding_members_writable BEFORE INSERT ON finding_members
WHEN (SELECT engine_version FROM analysis_runs WHERE id = NEW.run_id) = 'legacy_v0' OR (SELECT status FROM analysis_runs WHERE id = NEW.run_id) = 'complete'
BEGIN SELECT RAISE(ABORT, 'v1 result rows cannot be written to a legacy run or a completed run'); END;

-- ------------------------------------------------ per-rule defect statistics: the persisted input contract for S7 scoring
CREATE TABLE IF NOT EXISTS run_rule_stats (
  run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  source_file_id TEXT NOT NULL REFERENCES source_files(id),
  rule_id TEXT NOT NULL,
  category TEXT NOT NULL,
  scope TEXT NOT NULL,
  severity TEXT NOT NULL,
  defects INTEGER NOT NULL CHECK (defects >= 0),
  records_affected INTEGER NOT NULL CHECK (records_affected >= 0),
  PRIMARY KEY (run_id, source_file_id, rule_id, scope, severity)
);
CREATE TRIGGER IF NOT EXISTS trg_run_rule_stats_writable BEFORE INSERT ON run_rule_stats
WHEN (SELECT engine_version FROM analysis_runs WHERE id = NEW.run_id) = 'legacy_v0' OR (SELECT status FROM analysis_runs WHERE id = NEW.run_id) = 'complete'
BEGIN SELECT RAISE(ABORT, 'v1 result rows cannot be written to a legacy run or a completed run'); END;

-- ------------------------------------------------ retention of the ORIGINAL uploaded file (canonical rows are the durable record)
ALTER TABLE source_files ADD COLUMN purged_at TEXT;
