-- ============================================================================
-- 0009  S8: quality_issues was missing an INSERT-time immutability guard. Since P0, a BEFORE UPDATE trigger already
-- stopped an EXISTING finding from being edited once its run completed, but nothing stopped a NEW finding from being
-- inserted into an already-completed run -- unlike match_pairs / entity_clusters / conflict_groups / score_contributions
-- / run_scores, which all already carry this exact guard (added in 0007/0008). Closing the same gap here, structurally.
-- ============================================================================
CREATE TRIGGER IF NOT EXISTS trg_issues_writable BEFORE INSERT ON quality_issues
WHEN (SELECT status FROM analysis_runs WHERE id = NEW.run_id) = 'complete'
BEGIN SELECT RAISE(ABORT, 'results of a completed run are immutable'); END;
