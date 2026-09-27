-- ============================================================
-- Enterprise Data Quality & Master Data Intelligence Platform
-- Database Schema (Phase 1, with Phase 2 extension points)
-- SQLite (production-portable to Postgres later; see notes.md)
-- ============================================================

PRAGMA foreign_keys = ON;

-- ---------------- Identity / Org (Phase 2-ready) ----------------
CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'analyst', -- analyst | admin (authorization-ready)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------- Datasets / Files / Runs ----------------
CREATE TABLE IF NOT EXISTS datasets (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  description TEXT,
  entity_kind TEXT NOT NULL DEFAULT 'auto', -- auto | vendor_customer | item_material | generic
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  is_sample INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS source_files (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  original_filename TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  file_size_bytes INTEGER NOT NULL,
  file_type TEXT NOT NULL, -- xlsx | csv
  sheet_name TEXT,          -- null for csv
  status TEXT NOT NULL DEFAULT 'uploaded', -- uploaded | validating | parsed | failed
  error_message TEXT,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
  row_count INTEGER,
  column_count INTEGER
);

CREATE TABLE IF NOT EXISTS analysis_runs (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued',
  -- queued|profiling|validating|normalizing|matching|scoring|complete|failed
  progress_pct INTEGER NOT NULL DEFAULT 0,
  current_stage TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  error_message TEXT,
  config_json TEXT,          -- matching thresholds etc, for reproducibility
  records_analyzed INTEGER,
  health_score REAL,
  health_breakdown_json TEXT
);

-- ---------------- Schema understanding ----------------
CREATE TABLE IF NOT EXISTS field_profiles (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  source_file_id TEXT NOT NULL REFERENCES source_files(id) ON DELETE CASCADE,
  column_name TEXT NOT NULL,
  column_index INTEGER NOT NULL,
  inferred_type TEXT,         -- string|number|date|boolean|identifier
  inferred_role TEXT,         -- name|address|phone|email|gstin|pan|item_code|item_desc|created_date|modified_date|status|numeric|categorical|unknown
  role_confidence REAL,
  null_count INTEGER,
  null_pct REAL,
  distinct_count INTEGER,
  cardinality_ratio REAL,
  sample_values_json TEXT,
  stats_json TEXT             -- min/max/mean/stddev for numeric, min/max date etc.
);

-- ---------------- Canonical records (normalized ingestion) --------
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  source_file_id TEXT NOT NULL REFERENCES source_files(id) ON DELETE CASCADE,
  source_row_ref INTEGER NOT NULL,   -- original row number (1-based, excl header)
  record_kind TEXT NOT NULL DEFAULT 'entity', -- entity | item | transaction (both entity+item attributes on one row)
  raw_json TEXT NOT NULL,            -- original row, verbatim
  normalized_json TEXT,              -- system-generated normalized view
  created_date TEXT,                 -- detected creation date (ISO) if any
  modified_date TEXT,                -- detected modification date (ISO) if any
  primary_name TEXT,                 -- detected name/description used for display+matching
  blocking_key TEXT                  -- precomputed key for candidate blocking
);
CREATE INDEX IF NOT EXISTS idx_records_run ON records(run_id);
CREATE INDEX IF NOT EXISTS idx_records_blocking ON records(run_id, blocking_key);

-- ---------------- Data quality issues ----------------
CREATE TABLE IF NOT EXISTS quality_issues (
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
);
CREATE INDEX IF NOT EXISTS idx_issues_run ON quality_issues(run_id);
CREATE INDEX IF NOT EXISTS idx_issues_severity ON quality_issues(run_id, severity);
CREATE INDEX IF NOT EXISTS idx_issues_category ON quality_issues(run_id, category);

-- ---------------- Duplicate / entity clusters ----------------
CREATE TABLE IF NOT EXISTS entity_clusters (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  cluster_kind TEXT NOT NULL DEFAULT 'entity', -- entity | item
  representative_name TEXT,
  record_count INTEGER NOT NULL,
  confidence REAL NOT NULL,
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
);
CREATE INDEX IF NOT EXISTS idx_clusters_run ON entity_clusters(run_id);

CREATE TABLE IF NOT EXISTS entity_cluster_members (
  id TEXT PRIMARY KEY,
  cluster_id TEXT NOT NULL REFERENCES entity_clusters(id) ON DELETE CASCADE,
  record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_cluster_members_cluster ON entity_cluster_members(cluster_id);
CREATE INDEX IF NOT EXISTS idx_cluster_members_record ON entity_cluster_members(record_id);

-- Pairwise match evidence (explainability, drill-down)
CREATE TABLE IF NOT EXISTS match_pairs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  record_a_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  record_b_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  match_type TEXT NOT NULL, -- exact|normalized|fuzzy|multi_field|semantic
  similarity_score REAL NOT NULL,
  confidence REAL NOT NULL,
  matching_factors_json TEXT,
  conflicting_factors_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_matchpairs_run ON match_pairs(run_id);

-- ---------------- Cross-field conflicts ----------------
CREATE TABLE IF NOT EXISTS conflicts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  conflict_type TEXT NOT NULL, -- shared_gstin_multi_entity|shared_phone_diff_entity|shared_email_diff_entity|item_desc_attr_conflict
  severity TEXT NOT NULL,
  shared_value TEXT NOT NULL,
  field_name TEXT NOT NULL,
  explanation TEXT NOT NULL,
  record_ids_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_conflicts_run ON conflicts(run_id);

-- ---------------- Processing jobs (async) ----------------
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES analysis_runs(id) ON DELETE CASCADE,
  job_type TEXT NOT NULL, -- analysis | export
  status TEXT NOT NULL DEFAULT 'queued', -- queued|running|complete|failed
  progress_pct INTEGER NOT NULL DEFAULT 0,
  stage TEXT,
  result_json TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------- Exports ----------------
CREATE TABLE IF NOT EXISTS exports (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  export_type TEXT NOT NULL, -- full_analysis|issues|duplicates|clusters|conflicts|missing|invalid|stale|normalized|summary
  format TEXT NOT NULL,      -- xlsx|csv|json|pdf
  file_path TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- PHASE 2 EXTENSION POINTS (tables created but intentionally
-- unused/empty in Phase 1 -- referenced only by the "locked
-- module" UI to demonstrate architecture readiness).
-- ============================================================
CREATE TABLE IF NOT EXISTS golden_records (
  id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES analysis_runs(id),
  cluster_id TEXT REFERENCES entity_clusters(id),
  status TEXT DEFAULT 'not_available_phase1',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS governance_reviews (
  id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES analysis_runs(id),
  status TEXT DEFAULT 'not_available_phase1',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lineage_events (
  id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES analysis_runs(id),
  event_type TEXT,
  detail_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
