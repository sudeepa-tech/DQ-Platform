import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { SeverityBadge, LoadingState, ErrorState } from '../components/common';
import { useRunDashboard } from '../hooks/useRunDashboard';
import RunHeaderBar from '../components/RunHeaderBar';

export default function MissingInvalid() {
  const { runId } = useParams();
  const navigate = useNavigate();
  const { dashboard } = useRunDashboard(runId);
  const [category, setCategory] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const params = {};
    if (category) params.category = category;
    api.getFieldIssueSummary(runId, params)
      .then(res => {
        // This screen is scoped to Missing & Invalid Data specifically
        // (completeness + validity) -- freshness/uniqueness issues have
        // their own dedicated screens. The backend endpoint is
        // intentionally general (any category or none), so when no
        // specific category is selected here, restrict client-side to
        // the two categories this screen is actually about rather than
        // silently showing an unrelated freshness/duplicate breakdown
        // under a "Completeness + Validity" label.
        const summary = category ? res.summary : res.summary.filter(r => r.category === 'completeness' || r.category === 'validity');
        setData({ ...res, summary });
      })
      .catch(e => setError(e.message));
  }, [runId, category]);

  if (error) return <ErrorState message={error} />;

  return (
    <div>
      {dashboard && <RunHeaderBar dashboard={dashboard} title="Missing & Invalid Data" subtitle="Every field with incomplete or malformed values, ranked by how many records it affects." />}

      <div className="panel mb-4">
        <div className="flex gap-3">
          <select className="input" style={{ width: 220 }} value={category} onChange={e => setCategory(e.target.value)}>
            <option value="">Completeness + Validity</option>
            <option value="completeness">Completeness only (missing fields)</option>
            <option value="validity">Validity only (malformed values)</option>
          </select>
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">
          <span>Affected Fields</span>
          {data && <span className="text-tertiary text-sm">{data.total_records.toLocaleString()} total records analyzed</span>}
        </div>
        {data === null ? (
          <LoadingState label="Loading field summary…" />
        ) : data.summary.length === 0 ? (
          <div className="text-secondary text-sm">No missing or invalid data issues were detected.</div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>Field</th><th>Category</th><th>Severity</th><th>Affected records</th><th>% of dataset</th><th>Example</th><th></th></tr></thead>
              <tbody>
                {data.summary.map((row, i) => (
                  <tr key={i} className="clickable" onClick={() => navigate(`/runs/${runId}/issues?field_name=${encodeURIComponent(row.field_name)}&category=${row.category}`)}>
                    <td className="mono">{row.field_name}</td>
                    <td className="text-secondary" style={{ textTransform: 'capitalize' }}>{row.category}</td>
                    <td><SeverityBadge severity={row.severity} /></td>
                    <td>{row.affected_records.toLocaleString()}</td>
                    <td>
                      <div className="flex items-center gap-2">
                        <div style={{ width: 60, height: 6, background: 'var(--surface-hover)', borderRadius: 3, overflow: 'hidden' }}>
                          <div style={{ width: `${Math.min(100, row.percentage)}%`, height: '100%', background: 'var(--signal)' }} />
                        </div>
                        <span>{row.percentage}%</span>
                      </div>
                    </td>
                    <td className="text-sm text-secondary" style={{ maxWidth: 320 }}>{row.examples[0] || '—'}</td>
                    <td><span className="text-secondary text-sm">Investigate &rarr;</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
