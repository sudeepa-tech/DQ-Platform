import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import { api } from '../api/client';
import { SeverityBadge, LoadingState, ErrorState, KpiCard } from '../components/common';
import { useRunDashboard } from '../hooks/useRunDashboard';
import RunHeaderBar from '../components/RunHeaderBar';

const CONFLICT_TYPE_LABELS = {
  shared_gstin_multi_entity: 'GSTIN conflict',
  shared_phone_diff_entity: 'Phone conflict',
  shared_email_diff_entity: 'Email conflict',
  item_code_conflict: 'Item / material conflict'
};

export default function ConflictsPage() {
  const { runId } = useParams();
  const navigate = useNavigate();
  const { dashboard } = useRunDashboard(runId);
  const [conflicts, setConflicts] = useState(null);
  const [error, setError] = useState(null);
  const [typeFilter, setTypeFilter] = useState('');

  useEffect(() => { api.getConflicts(runId).then(res => setConflicts(res.conflicts)).catch(e => setError(e.message)); }, [runId]);

  if (error) return <ErrorState message={error} />;

  const filtered = conflicts?.filter(c => !typeFilter || c.conflict_type === typeFilter) || [];
  const types = conflicts ? [...new Set(conflicts.map(c => c.conflict_type))] : [];

  // Real per-category counts, replacing a single generic total -- each
  // category is clickable to filter the table below.
  const countsByType = {};
  (conflicts || []).forEach(c => { countsByType[c.conflict_type] = (countsByType[c.conflict_type] || 0) + 1; });

  return (
    <div>
      {dashboard && <RunHeaderBar dashboard={dashboard} title="Conflicts" subtitle="Cases where the same identifier is shared across records that appear to be different entities." />}

      {conflicts && conflicts.length > 0 && (
        <div className="kpi-grid">
          {Object.entries(countsByType).map(([type, count]) => (
            <KpiCard key={type} icon={AlertTriangle} tone="red" label={CONFLICT_TYPE_LABELS[type] || type.replace(/_/g, ' ')}
              value={count} onClick={() => setTypeFilter(typeFilter === type ? '' : type)} />
          ))}
        </div>
      )}

      <div className="panel mb-4">
        <div className="flex gap-3">
          <select className="input" style={{ width: 220 }} value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
            <option value="">All conflict types</option>
            {types.map(t => <option key={t} value={t}>{CONFLICT_TYPE_LABELS[t] || t.replace(/_/g, ' ')}</option>)}
          </select>
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">
          <span>Conflict Investigation</span>
          <span className="text-tertiary text-sm">{filtered.length} conflict(s)</span>
        </div>
        {conflicts === null ? (
          <LoadingState label="Loading conflicts…" />
        ) : filtered.length === 0 ? (
          <div className="text-secondary text-sm">
            {conflicts.length === 0
              ? 'No cross-field conflicts were detected — no identifier (GSTIN, phone, email) is shared across clearly different entities.'
              : 'No conflicts match this filter.'}
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>Severity</th><th>Type</th><th>Shared value</th><th>Field</th><th>Explanation</th><th>Records affected</th><th></th></tr></thead>
              <tbody>
                {filtered.map(c => (
                  <tr key={c.id}>
                    <td><SeverityBadge severity={c.severity} /></td>
                    <td>{CONFLICT_TYPE_LABELS[c.conflict_type] || c.conflict_type.replace(/_/g, ' ')}</td>
                    <td className="mono">{c.shared_value}</td>
                    <td className="text-secondary">{c.field_name}</td>
                    <td style={{ maxWidth: 400 }}>{c.explanation}</td>
                    <td>{c.record_ids.length}</td>
                    <td>
                      {c.record_ids.length === 2 ? (
                        <button className="btn btn-ghost btn-sm" onClick={() => navigate(`/compare?a=${c.record_ids[0]}&b=${c.record_ids[1]}`)}>Compare</button>
                      ) : (
                        <button className="btn btn-ghost btn-sm" onClick={() => navigate(`/records/${c.record_ids[0]}`)}>View first</button>
                      )}
                    </td>
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
