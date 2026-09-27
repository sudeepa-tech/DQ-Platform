-- ============================================================================
-- 0003  P0 integrity guards (S1)
-- ----------------------------------------------------------------------------
-- Database-level enforcement of the approved semantic decisions, so they hold no matter which code path writes the data.
-- All guards are scoped to NEW columns / NEW tables or to COMPLETED runs, so the legacy engine's own write path is untouched
-- (verified: it only UPDATEs records/analysis_runs while a run is still in progress).
-- ============================================================================

-- ------------------------------------------------ immutable, versioned configuration
CREATE TRIGGER IF NOT EXISTS trg_analysis_configs_immutable
BEFORE UPDATE OF dataset_id, version, table_type, stale_threshold_years, reference_date_mode, reference_date,
                 config_json, config_schema_version, rule_catalog_version, config_hash ON analysis_configs
BEGIN SELECT RAISE(ABORT, 'analysis_configs rows are immutable: create a new config version instead'); END;

CREATE TRIGGER IF NOT EXISTS trg_config_rule_settings_immutable
BEFORE UPDATE ON config_rule_settings
BEGIN SELECT RAISE(ABORT, 'config_rule_settings rows are immutable: create a new config version instead'); END;

CREATE TRIGGER IF NOT EXISTS trg_config_rule_settings_frozen
BEFORE INSERT ON config_rule_settings
WHEN EXISTS (SELECT 1 FROM analysis_runs WHERE config_id = NEW.config_id)
BEGIN SELECT RAISE(ABORT, 'this config version is already used by a run and can no longer change'); END;

-- ------------------------------------------------ run provenance: engine version, frozen reference date & config
CREATE TRIGGER IF NOT EXISTS trg_runs_engine_version_immutable
BEFORE UPDATE OF engine_version ON analysis_runs
WHEN NEW.engine_version IS NOT OLD.engine_version
BEGIN SELECT RAISE(ABORT, 'analysis_runs.engine_version is immutable: a run is never re-interpreted by another engine'); END;

-- once set, the reference date / threshold / config of a run never change (never re-read the server clock)
CREATE TRIGGER IF NOT EXISTS trg_runs_provenance_frozen_once_set
BEFORE UPDATE OF reference_date, stale_threshold_years, config_hash, effective_config_json, table_type, config_id, input_hash ON analysis_runs
WHEN (OLD.reference_date IS NOT NULL AND NEW.reference_date IS NOT OLD.reference_date)
  OR (OLD.stale_threshold_years IS NOT NULL AND NEW.stale_threshold_years IS NOT OLD.stale_threshold_years)
  OR (OLD.config_hash IS NOT NULL AND NEW.config_hash IS NOT OLD.config_hash)
  OR (OLD.effective_config_json IS NOT NULL AND NEW.effective_config_json IS NOT OLD.effective_config_json)
  OR (OLD.table_type IS NOT NULL AND NEW.table_type IS NOT OLD.table_type)
  OR (OLD.config_id IS NOT NULL AND NEW.config_id IS NOT OLD.config_id)
  OR (OLD.input_hash IS NOT NULL AND NEW.input_hash IS NOT OLD.input_hash)
BEGIN SELECT RAISE(ABORT, 'run provenance (reference date, threshold, config, table type) is frozen once set'); END;

-- a completed run's headline results and lineage are immutable
CREATE TRIGGER IF NOT EXISTS trg_runs_complete_frozen
BEFORE UPDATE OF dataset_id, parent_run_id, config_json, config_id, config_hash, effective_config_json, table_type, reference_date,
                 stale_threshold_years, input_hash, health_score, health_breakdown_json, records_analyzed ON analysis_runs
WHEN OLD.status = 'complete'
BEGIN SELECT RAISE(ABORT, 'a completed run is immutable'); END;

-- a v1 run cannot complete without a frozen reference date, threshold, config hash and table type
CREATE TRIGGER IF NOT EXISTS trg_runs_v1_complete_gate_update
BEFORE UPDATE OF status ON analysis_runs
WHEN NEW.status = 'complete' AND NEW.engine_version <> 'legacy_v0'
 AND (NEW.reference_date IS NULL OR NEW.stale_threshold_years IS NULL OR NEW.config_hash IS NULL OR NEW.table_type IS NULL)
BEGIN SELECT RAISE(ABORT, 'a v1 run cannot complete without a frozen reference date, stale threshold, config hash and table type'); END;

CREATE TRIGGER IF NOT EXISTS trg_runs_v1_complete_gate_insert
BEFORE INSERT ON analysis_runs
WHEN NEW.status = 'complete' AND NEW.engine_version <> 'legacy_v0'
 AND (NEW.reference_date IS NULL OR NEW.stale_threshold_years IS NULL OR NEW.config_hash IS NULL OR NEW.table_type IS NULL)
BEGIN SELECT RAISE(ABORT, 'a v1 run cannot complete without a frozen reference date, stale threshold, config hash and table type'); END;

-- re-run lineage must stay within one dataset and cannot point at itself
CREATE TRIGGER IF NOT EXISTS trg_runs_parent_valid_insert
BEFORE INSERT ON analysis_runs
WHEN NEW.parent_run_id IS NOT NULL
 AND (NEW.parent_run_id = NEW.id OR (SELECT dataset_id FROM analysis_runs WHERE id = NEW.parent_run_id) IS NOT NEW.dataset_id)
BEGIN SELECT RAISE(ABORT, 'parent_run_id must be a different run of the same dataset'); END;

CREATE TRIGGER IF NOT EXISTS trg_runs_parent_valid_update
BEFORE UPDATE OF parent_run_id ON analysis_runs
WHEN NEW.parent_run_id IS NOT NULL
 AND (NEW.parent_run_id = NEW.id OR (SELECT dataset_id FROM analysis_runs WHERE id = NEW.parent_run_id) IS NOT NEW.dataset_id)
BEGIN SELECT RAISE(ABORT, 'parent_run_id must be a different run of the same dataset'); END;

-- ------------------------------------------------ completed runs: legacy result columns are immutable
-- (review_status / reviewed_* / review_note stay editable: a human's confirmation is a DECISION RECORD. Its effect on clusters and
--  scores is applied by a RE-RUN (child run, parent_run_id), never by editing a finished run's results.)
CREATE TRIGGER IF NOT EXISTS trg_records_complete_frozen
BEFORE UPDATE OF source_file_id, source_row_ref, record_kind, raw_json, normalized_json, created_date, modified_date, primary_name, blocking_key,
                 source_row_id, source_sheet, row_identifier, business_key_json, business_hash, business_hash_excl_audit, normalization_version ON records
WHEN (SELECT status FROM analysis_runs WHERE id = OLD.run_id) = 'complete'
BEGIN SELECT RAISE(ABORT, 'results of a completed run are immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_issues_complete_frozen
BEFORE UPDATE OF record_id, category, issue_type, severity, field_name, explanation, detection_method, confidence, extra_json,
                 rule_id, rule_version, scope, file_column_id, requiredness, observed_value, normalized_value, evidence_json, affects_score ON quality_issues
WHEN (SELECT status FROM analysis_runs WHERE id = OLD.run_id) = 'complete'
BEGIN SELECT RAISE(ABORT, 'results of a completed run are immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_clusters_complete_frozen
BEFORE UPDATE OF cluster_kind, representative_name, record_count, confidence, matching_factors_json, conflicts_json, is_exact_repeat,
                 match_class, match_subtype, composition_json, decision_reason ON entity_clusters
WHEN (SELECT status FROM analysis_runs WHERE id = OLD.run_id) = 'complete'
BEGIN SELECT RAISE(ABORT, 'results of a completed run are immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_pairs_complete_frozen
BEFORE UPDATE OF record_a_id, record_b_id, match_type, similarity_score, confidence, matching_factors_json, conflicting_factors_json,
                 cluster_id, pair_class, pair_subtype, decision, reason_text, is_scored ON match_pairs
WHEN (SELECT status FROM analysis_runs WHERE id = OLD.run_id) = 'complete'
BEGIN SELECT RAISE(ABORT, 'results of a completed run are immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_conflicts_complete_frozen
BEFORE UPDATE OF conflict_type, severity, shared_value, field_name, explanation, record_ids_json ON conflicts
WHEN (SELECT status FROM analysis_runs WHERE id = OLD.run_id) = 'complete'
BEGIN SELECT RAISE(ABORT, 'results of a completed run are immutable'); END;

-- ------------------------------------------------ v1-only result tables: never written for legacy runs or completed runs
CREATE TRIGGER IF NOT EXISTS trg_run_inputs_writable BEFORE INSERT ON run_inputs
WHEN (SELECT engine_version FROM analysis_runs WHERE id = NEW.run_id) = 'legacy_v0' OR (SELECT status FROM analysis_runs WHERE id = NEW.run_id) = 'complete'
BEGIN SELECT RAISE(ABORT, 'v1 result rows cannot be written to a legacy run or a completed run'); END;

CREATE TRIGGER IF NOT EXISTS trg_match_evidence_writable BEFORE INSERT ON match_evidence
WHEN (SELECT engine_version FROM analysis_runs WHERE id = NEW.run_id) = 'legacy_v0' OR (SELECT status FROM analysis_runs WHERE id = NEW.run_id) = 'complete'
BEGIN SELECT RAISE(ABORT, 'v1 result rows cannot be written to a legacy run or a completed run'); END;

CREATE TRIGGER IF NOT EXISTS trg_conflict_groups_writable BEFORE INSERT ON conflict_groups
WHEN (SELECT engine_version FROM analysis_runs WHERE id = NEW.run_id) = 'legacy_v0' OR (SELECT status FROM analysis_runs WHERE id = NEW.run_id) = 'complete'
BEGIN SELECT RAISE(ABORT, 'v1 result rows cannot be written to a legacy run or a completed run'); END;

CREATE TRIGGER IF NOT EXISTS trg_conflict_group_members_writable BEFORE INSERT ON conflict_group_members
WHEN (SELECT engine_version FROM analysis_runs WHERE id = NEW.run_id) = 'legacy_v0' OR (SELECT status FROM analysis_runs WHERE id = NEW.run_id) = 'complete'
BEGIN SELECT RAISE(ABORT, 'v1 result rows cannot be written to a legacy run or a completed run'); END;

CREATE TRIGGER IF NOT EXISTS trg_score_contributions_writable BEFORE INSERT ON score_contributions
WHEN (SELECT engine_version FROM analysis_runs WHERE id = NEW.run_id) = 'legacy_v0' OR (SELECT status FROM analysis_runs WHERE id = NEW.run_id) = 'complete'
BEGIN SELECT RAISE(ABORT, 'v1 result rows cannot be written to a legacy run or a completed run'); END;

CREATE TRIGGER IF NOT EXISTS trg_run_scores_writable BEFORE INSERT ON run_scores
WHEN (SELECT engine_version FROM analysis_runs WHERE id = NEW.run_id) = 'legacy_v0' OR (SELECT status FROM analysis_runs WHERE id = NEW.run_id) = 'complete'
BEGIN SELECT RAISE(ABORT, 'v1 result rows cannot be written to a legacy run or a completed run'); END;

-- ------------------------------------------------ decision 4: fuzzy candidates never auto-cluster, excluded from scoring until confirmed
CREATE TRIGGER IF NOT EXISTS trg_pairs_fuzzy_guard_insert BEFORE INSERT ON match_pairs
WHEN NEW.pair_class = 'fuzzy_candidate'
 AND ((NEW.review_status <> 'confirmed' AND (NEW.cluster_id IS NOT NULL OR NEW.is_scored = 1)) OR NEW.review_status = 'not_required')
BEGIN SELECT RAISE(ABORT, 'a fuzzy candidate needs a review status, never auto-clusters and is excluded from scoring until confirmed'); END;

CREATE TRIGGER IF NOT EXISTS trg_pairs_fuzzy_guard_update BEFORE UPDATE OF pair_class, review_status, cluster_id, is_scored ON match_pairs
WHEN NEW.pair_class = 'fuzzy_candidate'
 AND ((NEW.review_status <> 'confirmed' AND (NEW.cluster_id IS NOT NULL OR NEW.is_scored = 1)) OR NEW.review_status = 'not_required')
BEGIN SELECT RAISE(ABORT, 'a fuzzy candidate needs a review status, never auto-clusters and is excluded from scoring until confirmed'); END;

CREATE TRIGGER IF NOT EXISTS trg_clusters_fuzzy_guard_insert BEFORE INSERT ON entity_clusters
WHEN NEW.match_class = 'fuzzy_candidate' AND NEW.review_status <> 'confirmed'
BEGIN SELECT RAISE(ABORT, 'an unconfirmed fuzzy candidate can never be an entity cluster'); END;

CREATE TRIGGER IF NOT EXISTS trg_clusters_fuzzy_guard_update BEFORE UPDATE OF match_class, review_status ON entity_clusters
WHEN NEW.match_class = 'fuzzy_candidate' AND NEW.review_status <> 'confirmed'
BEGIN SELECT RAISE(ABORT, 'an unconfirmed fuzzy candidate can never be an entity cluster'); END;

-- ------------------------------------------------ decision 2: required / expected / optional
--   dataset- or field-level issues carry no record id (one finding for an empty required column, not 1,000 row findings)
--   OPTIONAL missing => no completeness defect;  REQUIRED missing => high/critical;  EXPECTED missing => low/medium
CREATE TRIGGER IF NOT EXISTS trg_issues_scope_and_requiredness_insert BEFORE INSERT ON quality_issues
WHEN (NEW.scope IN ('dataset','field') AND NEW.record_id IS NOT NULL)
  OR (NEW.category = 'completeness' AND NEW.requiredness = 'optional')
  OR (NEW.category = 'completeness' AND NEW.requiredness = 'required' AND NEW.severity NOT IN ('critical','high'))
  OR (NEW.category = 'completeness' AND NEW.requiredness = 'expected' AND NEW.severity NOT IN ('low','medium'))
BEGIN SELECT RAISE(ABORT, 'invalid issue: dataset/field scope carries no record; optional gaps are not defects; required=high, expected=low/medium'); END;

CREATE TRIGGER IF NOT EXISTS trg_issues_scope_and_requiredness_update BEFORE UPDATE OF scope, record_id, category, requiredness, severity ON quality_issues
WHEN (NEW.scope IN ('dataset','field') AND NEW.record_id IS NOT NULL)
  OR (NEW.category = 'completeness' AND NEW.requiredness = 'optional')
  OR (NEW.category = 'completeness' AND NEW.requiredness = 'required' AND NEW.severity NOT IN ('critical','high'))
  OR (NEW.category = 'completeness' AND NEW.requiredness = 'expected' AND NEW.severity NOT IN ('low','medium'))
BEGIN SELECT RAISE(ABORT, 'invalid issue: dataset/field scope carries no record; optional gaps are not defects; required=high, expected=low/medium'); END;

-- ------------------------------------------------ lineage integrity (traceability is permanent and self-consistent)
CREATE TRIGGER IF NOT EXISTS trg_source_rows_immutable
BEFORE UPDATE OF source_file_id, row_number, sheet_row, source_sheet, row_identifier, raw_json, raw_meta_json, raw_hash ON source_rows
BEGIN SELECT RAISE(ABORT, 'ingested source rows are immutable: re-ingest instead'); END;

CREATE TRIGGER IF NOT EXISTS trg_records_lineage_consistent BEFORE INSERT ON records
WHEN NEW.source_row_id IS NOT NULL
 AND ((SELECT source_file_id FROM source_rows WHERE id = NEW.source_row_id) IS NOT NEW.source_file_id
   OR (SELECT row_number FROM source_rows WHERE id = NEW.source_row_id) IS NOT NEW.source_row_ref)
BEGIN SELECT RAISE(ABORT, 'record lineage mismatch: source_row_id must belong to the same file and row number'); END;

CREATE TRIGGER IF NOT EXISTS trg_schema_mappings_column_consistent BEFORE INSERT ON schema_mappings
WHEN (SELECT source_file_id FROM file_columns WHERE id = NEW.file_column_id) IS NOT NEW.source_file_id
BEGIN SELECT RAISE(ABORT, 'schema mapping must reference a column of the same file'); END;

CREATE TRIGGER IF NOT EXISTS trg_match_evidence_run_consistent BEFORE INSERT ON match_evidence
WHEN (SELECT run_id FROM match_pairs WHERE id = NEW.match_pair_id) IS NOT NEW.run_id
BEGIN SELECT RAISE(ABORT, 'evidence must belong to a pair of the same run'); END;

CREATE TRIGGER IF NOT EXISTS trg_cgm_run_consistent BEFORE INSERT ON conflict_group_members
WHEN (SELECT run_id FROM conflict_groups WHERE id = NEW.conflict_group_id) IS NOT NEW.run_id
  OR (SELECT run_id FROM records WHERE id = NEW.record_id) IS NOT NEW.run_id
BEGIN SELECT RAISE(ABORT, 'conflict group members must belong to the same run as the group'); END;
