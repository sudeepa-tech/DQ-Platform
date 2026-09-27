-- ============================================================================
-- 0008  S7 scoring persistence model (structural additions only; business formula stays in versioned scoring configuration)
-- ----------------------------------------------------------------------------
--   score_contributions: scope widened to include cluster | conflict_group | pair (uniqueness/consistency are not cell/record/
--                        dataset-scoped rules); + source_file_id (a run can span >1 source file; contributions stay
--                        file-scoped so the same rule_id on different files' columns never collides); + scoring_unit
--                        (record | cluster | group | pair -- so a KPI/contribution is never ambiguous about what it counts,
--                        per the "never mix pair/cluster/record/issue counts" requirement); + evidence_json (structured
--                        breakdown backing the human `explanation` string, e.g. affected field/business keys, so the UI
--                        never has to reconstruct it from raw findings).
--   run_scores: + explanation_json (the persisted, per-dimension -- and overall -- explanation tree) + denominator +
--                        defect_count, so a dimension's headline numbers are available without re-summing contributions.
-- No new competing table is created; both tables already existed for exactly this purpose (S1's original design).
-- ============================================================================
CREATE TEMP TABLE _bk_contrib AS SELECT * FROM score_contributions;
DROP TABLE score_contributions;
CREATE TABLE score_contributions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  source_file_id TEXT REFERENCES source_files(id),
  dimension TEXT NOT NULL CHECK (dimension IN ('completeness','validity','uniqueness','consistency','freshness')),
  rule_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('cell','record','dataset','cluster','conflict_group','pair')),
  scoring_unit TEXT NOT NULL DEFAULT 'record' CHECK (scoring_unit IN ('record','cluster','group','pair','column')),
  opportunities INTEGER NOT NULL CHECK (opportunities >= 0),
  defects INTEGER NOT NULL CHECK (defects >= 0),
  defect_rate REAL NOT NULL CHECK (defect_rate >= 0 AND defect_rate <= 1),
  severity_weight REAL NOT NULL CHECK (severity_weight >= 0),
  penalty_points REAL NOT NULL CHECK (penalty_points >= 0),
  explanation TEXT,
  evidence_json TEXT CHECK (evidence_json IS NULL OR json_valid(evidence_json)),
  UNIQUE (run_id, dimension, source_file_id, rule_id),
  CHECK (defects <= opportunities)
);
INSERT INTO score_contributions (id, run_id, dimension, rule_id, scope, opportunities, defects, defect_rate, severity_weight, penalty_points, explanation)
  SELECT id, run_id, dimension, rule_id, scope, opportunities, defects, defect_rate, severity_weight, penalty_points, explanation FROM _bk_contrib;
DROP TABLE _bk_contrib;
CREATE INDEX IF NOT EXISTS idx_score_contrib_run ON score_contributions(run_id);
CREATE INDEX IF NOT EXISTS idx_score_contrib_source ON score_contributions(run_id, source_file_id);
CREATE TRIGGER IF NOT EXISTS trg_score_contributions_writable BEFORE INSERT ON score_contributions
WHEN (SELECT engine_version FROM analysis_runs WHERE id = NEW.run_id) = 'legacy_v0' OR (SELECT status FROM analysis_runs WHERE id = NEW.run_id) = 'complete'
BEGIN SELECT RAISE(ABORT, 'v1 result rows cannot be written to a legacy run or a completed run'); END;

CREATE TEMP TABLE _bk_scores AS SELECT * FROM run_scores;
DROP TABLE run_scores;
CREATE TABLE run_scores (
  run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  dimension TEXT NOT NULL CHECK (dimension IN ('overall','completeness','validity','uniqueness','consistency','freshness')),
  score REAL NOT NULL CHECK (score >= 0 AND score <= 100),
  weight REAL CHECK (weight IS NULL OR (weight >= 0 AND weight <= 1)),
  denominator INTEGER CHECK (denominator IS NULL OR denominator >= 0),
  defect_count REAL CHECK (defect_count IS NULL OR defect_count >= 0),
  explanation_json TEXT CHECK (explanation_json IS NULL OR json_valid(explanation_json)),
  formula_version TEXT NOT NULL,
  PRIMARY KEY (run_id, dimension)
);
INSERT INTO run_scores (run_id, dimension, score, weight, formula_version) SELECT run_id, dimension, score, weight, formula_version FROM _bk_scores;
DROP TABLE _bk_scores;
CREATE TRIGGER IF NOT EXISTS trg_run_scores_writable BEFORE INSERT ON run_scores
WHEN (SELECT engine_version FROM analysis_runs WHERE id = NEW.run_id) = 'legacy_v0' OR (SELECT status FROM analysis_runs WHERE id = NEW.run_id) = 'complete'
BEGIN SELECT RAISE(ABORT, 'v1 result rows cannot be written to a legacy run or a completed run'); END;
