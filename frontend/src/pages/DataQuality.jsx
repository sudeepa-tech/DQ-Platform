import { useParams, useNavigate } from 'react-router-dom';
import { useRunDashboard } from '../hooks/useRunDashboard';
import { LoadingState, ErrorState } from '../components/common';
import RunHeaderBar from '../components/RunHeaderBar';

const DIMENSIONS = [
  { key: 'completeness', label: 'Completeness', desc: 'Are required fields populated?', category: 'completeness' },
  { key: 'validity', label: 'Validity', desc: 'Do values match expected formats (GSTIN, email, phone, dates)?', category: 'validity' },
  { key: 'uniqueness', label: 'Uniqueness', desc: 'Are there exact or near-duplicate records?', category: 'uniqueness' },
  { key: 'consistency', label: 'Consistency', desc: 'Do related fields agree with each other (e.g. dates, identifiers)?', category: 'consistency' },
  { key: 'freshness', label: 'Freshness', desc: 'How recently was each record created or modified?', category: 'freshness' }
];

export default function DataQuality() {
  const { runId } = useParams();
  const navigate = useNavigate();
  const { dashboard, error, loading } = useRunDashboard(runId);

  if (error) return <ErrorState message={error} />;
  if (loading || !dashboard) return <LoadingState label="Loading data quality breakdown…" />;

  const { health, affected_records_by_category, summary } = dashboard;

  return (
    <div>
      <RunHeaderBar dashboard={dashboard} title="Data Quality" subtitle="Score, affected records, and methodology for every quality dimension." />

      {health?.methodology && (
        <div className="panel mb-4">
          <div className="panel-title">Methodology</div>
          <p className="text-secondary text-sm" style={{ margin: 0 }}>{health.methodology}</p>
        </div>
      )}

      <div className="quality-cards-grid">
        {DIMENSIONS.map(dim => {
          const d = health?.breakdown?.[dim.key];
          const affected = affected_records_by_category.find(a => a.category === dim.category)?.c || 0;
          const pct = summary.records_analyzed ? Math.round((affected / summary.records_analyzed) * 1000) / 10 : 0;
          if (!d) return null;
          return (
            <div key={dim.key} className="panel quality-card" onClick={() => navigate(`/runs/${runId}/issues?category=${dim.category}`)}>
              <div className="flex items-center justify-between mb-2">
                <div style={{ fontWeight: 600, fontSize: 14 }}>{dim.label}</div>
                <div className="quality-card-score" style={{ color: dimColor(d.score) }}>{d.score}</div>
              </div>
              <div className="text-secondary text-sm mb-2">{dim.desc}</div>
              <div className="quality-dim-bar-track mb-2">
                <div className="quality-dim-bar-fill" style={{ width: `${d.score}%`, background: dimColor(d.score) }} />
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-tertiary">{affected.toLocaleString()} records affected ({pct}%)</span>
                <span className="text-tertiary">{d.issue_count} issue(s) · weight {Math.round(d.weight * 100)}%</span>
              </div>
            </div>
          );
        })}
      </div>

      {health?.breakdown?.conflict_penalty_applied > 0 && (
        <div className="panel mt-2">
          <div className="text-sm text-secondary">
            An additional <strong>{health.breakdown.conflict_penalty_applied}-point</strong> penalty was applied to the overall
            score for cross-field conflicts (shared identifiers across different entities) —
            <span className="hero-link" style={{ marginLeft: 4 }} onClick={() => navigate(`/runs/${runId}/conflicts`)}>view conflicts &rarr;</span>
          </div>
        </div>
      )}
    </div>
  );
}

function dimColor(score) {
  if (score >= 80) return 'var(--success)';
  if (score >= 60) return 'var(--sev-medium)';
  if (score >= 40) return 'var(--sev-high)';
  return 'var(--sev-critical)';
}
