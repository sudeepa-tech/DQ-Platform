import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { Sparkles, Hourglass, AlertOctagon, HelpCircle, CalendarX } from 'lucide-react';
import { api } from '../api/client';
import { LoadingState, ErrorState, SeverityBadge, KpiCard } from '../components/common';
import { useRunDashboard } from '../hooks/useRunDashboard';
import RunHeaderBar from '../components/RunHeaderBar';

const BUCKET_COLORS = { fresh: '#16a34a', aging: '#d97706', stale: '#dc2626', unknown: '#64748b' };
const BUCKET_LABELS = { fresh: 'Fresh (< 1 year)', aging: 'Aging (1-3 years)', stale: 'Stale (3+ years)', unknown: 'Unknown (no date)' };
const BUCKET_ICONS = { fresh: Sparkles, aging: Hourglass, stale: AlertOctagon, unknown: HelpCircle };
const BUCKET_TONES = { fresh: 'green', aging: 'amber', stale: 'red', unknown: 'blue' };

export default function Freshness() {
  const { runId } = useParams();
  const navigate = useNavigate();
  const { dashboard } = useRunDashboard(runId);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => { api.getFreshness(runId).then(setData).catch(e => setError(e.message)); }, [runId]);

  if (error) return <ErrorState message={error} />;
  if (!data) return <LoadingState label="Loading freshness intelligence…" />;

  const chartData = ['fresh', 'aging', 'stale', 'unknown'].map(bucket => ({
    bucket,
    label: BUCKET_LABELS[bucket],
    count: data.age_distribution.find(b => b.bucket === bucket)?.c || 0
  }));

  return (
    <div>
      {dashboard && <RunHeaderBar dashboard={dashboard} title="Data Freshness" subtitle="Record age, modification recency, and temporal data-quality issues." />}

      <div className="kpi-grid">
        {chartData.map(b => (
          <KpiCard key={b.bucket} icon={BUCKET_ICONS[b.bucket]} tone={BUCKET_TONES[b.bucket]} label={b.label} value={b.count.toLocaleString()} />
        ))}
        <KpiCard icon={CalendarX} tone="blue" label="Never Modified" value={data.never_modified.toLocaleString()} sub="No modification date on record" />
      </div>

      <div className="grid-2 mb-4">
        <div className="panel">
          <div className="panel-title">Freshness Distribution</div>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={chartData} layout="vertical" margin={{ left: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" horizontal={false} />
              <XAxis type="number" tick={{ fill: 'var(--text-tertiary)', fontSize: 11 }} />
              <YAxis type="category" dataKey="label" tick={{ fill: 'var(--text-secondary)', fontSize: 11 }} width={110} />
              <Tooltip contentStyle={{ background: 'var(--surface-raised)', border: '1px solid var(--border-strong)', fontSize: 12 }} />
              <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                {chartData.map((d, i) => <Cell key={i} fill={BUCKET_COLORS[d.bucket]} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="panel">
          <div className="panel-title">
            <span>Oldest Records (by last modification)</span>
          </div>
          {data.oldest_records.length === 0 ? (
            <div className="text-secondary text-sm">No modification dates were detected in this dataset.</div>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead><tr><th>Record</th><th>Created</th><th>Last modified</th></tr></thead>
                <tbody>
                  {data.oldest_records.slice(0, 10).map(r => (
                    <tr key={r.id} className="clickable" onClick={() => navigate(`/records/${r.id}`)}>
                      <td>{r.primary_name || `Row #${r.source_row_ref}`}</td>
                      <td className="text-secondary text-sm">{r.created_date ? r.created_date.slice(0, 10) : '—'}</td>
                      <td className="text-secondary text-sm">{r.modified_date ? r.modified_date.slice(0, 10) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">
          <span>Invalid or Suspicious Temporal Data</span>
          <span className="text-tertiary text-sm">{data.invalid_temporal_issues.length}</span>
        </div>
        {data.invalid_temporal_issues.length === 0 ? (
          <div className="text-secondary text-sm">No future-dated, out-of-order, or unparseable dates were detected.</div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>Severity</th><th>Record</th><th>Field</th><th>Explanation</th><th></th></tr></thead>
              <tbody>
                {data.invalid_temporal_issues.map(i => (
                  <tr key={i.id}>
                    <td><SeverityBadge severity={i.severity} /></td>
                    <td>{i.primary_name || `Row #${i.source_row_ref}`}</td>
                    <td className="mono text-sm">{i.field_name || '—'}</td>
                    <td>{i.explanation}</td>
                    <td>{i.record_id && <button className="btn btn-ghost btn-sm" onClick={() => navigate(`/records/${i.record_id}`)}>View</button>}</td>
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
