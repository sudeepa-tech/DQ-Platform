import { useEffect, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { ListChecks, AlertOctagon, AlertTriangle, AlertCircle, Info } from 'lucide-react';
import { api } from '../api/client';
import { SeverityBadge, LoadingState, ErrorState, KpiCard, Pagination } from '../components/common';
import { useRunDashboard } from '../hooks/useRunDashboard';
import RunHeaderBar from '../components/RunHeaderBar';

export default function IssueExplorerPage() {
  const { runId } = useParams();
  const navigate = useNavigate();
  const { dashboard } = useRunDashboard(runId);
  const [searchParams, setSearchParams] = useSearchParams();

  const [severity, setSeverity] = useState(searchParams.get('severity') || '');
  const [category, setCategory] = useState(searchParams.get('category') || '');
  const [issueType, setIssueType] = useState(searchParams.get('issue_type') || '');
  const [recordKind, setRecordKind] = useState(searchParams.get('record_kind') || '');
  const [fieldName, setFieldName] = useState(searchParams.get('field_name') || '');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [issues, setIssues] = useState([]);
  const [total, setTotal] = useState(0);
  const [fields, setFields] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const pageSize = 50;

  useEffect(() => { api.getIssueFields(runId).then(res => setFields(res.fields)); }, [runId]);

  useEffect(() => {
    setLoading(true);
    const params = { page, page_size: pageSize };
    if (severity) params.severity = severity;
    if (category) params.category = category;
    if (issueType) params.issue_type = issueType;
    if (recordKind) params.record_kind = recordKind;
    if (fieldName) params.field_name = fieldName;
    if (search) params.search = search;
    setSearchParams(params, { replace: true });
    api.getIssues(runId, params)
      .then(res => { setIssues(res.issues); setTotal(res.total); setError(null); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, severity, category, issueType, recordKind, fieldName, search, page]);

  if (error) return <ErrorState message={error} />;

  return (
    <div>
      {dashboard && <RunHeaderBar dashboard={dashboard} title="Issue Explorer" subtitle="Every detected issue, in one searchable, filterable workspace." />}

      {dashboard && (
        <div className="kpi-grid-secondary mb-4">
          <KpiCard icon={ListChecks} tone="blue" label="Total Issues" value={dashboard.summary.total_issues.toLocaleString()}
            onClick={() => { setSeverity(''); setPage(1); }} compact />
          <KpiCard icon={AlertOctagon} tone="red" label="Critical" value={(sevCount(dashboard, 'critical')).toLocaleString()}
            onClick={() => { setSeverity('critical'); setPage(1); }} compact />
          <KpiCard icon={AlertTriangle} tone="amber" label="High" value={(sevCount(dashboard, 'high')).toLocaleString()}
            onClick={() => { setSeverity('high'); setPage(1); }} compact />
          <KpiCard icon={AlertCircle} tone="amber" label="Medium" value={(sevCount(dashboard, 'medium')).toLocaleString()}
            onClick={() => { setSeverity('medium'); setPage(1); }} compact />
          <KpiCard icon={Info} tone="blue" label="Low" value={(sevCount(dashboard, 'low')).toLocaleString()}
            onClick={() => { setSeverity('low'); setPage(1); }} compact />
        </div>
      )}

      <div className="panel mb-4">
        <div className="flex gap-3" style={{ flexWrap: 'wrap' }}>
          <select className="input" style={{ width: 150 }} value={severity} onChange={e => { setSeverity(e.target.value); setPage(1); }}>
            <option value="">All severities</option>
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
          <select className="input" style={{ width: 190 }} value={category} onChange={e => { setCategory(e.target.value); setPage(1); }}>
            <option value="">All categories</option>
            <option value="completeness">Completeness</option>
            <option value="validity">Validity</option>
            <option value="uniqueness">Uniqueness</option>
            <option value="consistency">Consistency</option>
            <option value="freshness">Freshness</option>
          </select>
          <select className="input" style={{ width: 170 }} value={recordKind} onChange={e => { setRecordKind(e.target.value); setPage(1); }}>
            <option value="">Entities + items</option>
            <option value="entity">Entities only</option>
            <option value="item">Items only</option>
          </select>
          <select className="input" style={{ width: 190 }} value={fieldName} onChange={e => { setFieldName(e.target.value); setPage(1); }}>
            <option value="">All fields</option>
            {fields.map(f => <option key={f} value={f}>{f}</option>)}
          </select>
          <input className="input" style={{ flex: 1, minWidth: 200 }} placeholder="Search explanations…" value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} />
          {(severity || category || issueType || recordKind || fieldName || search) && (
            <button className="btn btn-ghost btn-sm" onClick={() => { setSeverity(''); setCategory(''); setIssueType(''); setRecordKind(''); setFieldName(''); setSearch(''); setPage(1); }}>
              Clear filters
            </button>
          )}
        </div>
        {issueType && (
          <div className="mt-2 text-sm text-secondary">
            Filtered to issue type: <span className="mono">{issueType}</span>
            <button className="btn btn-ghost btn-sm" style={{ marginLeft: 8 }} onClick={() => setIssueType('')}>&times; remove</button>
          </div>
        )}
      </div>

      <div className="panel">
        <div className="panel-title">
          <span>Issue Explorer</span>
          <span className="text-tertiary text-sm">{total.toLocaleString()} issue(s)</span>
        </div>
        {loading ? (
          <LoadingState label="Loading issues…" />
        ) : issues.length === 0 ? (
          <div className="text-secondary text-sm">No issues match these filters.</div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr><th>Severity</th><th>Rule</th><th>Record</th><th>Field</th><th>Value</th><th>Reason</th><th>Source</th><th></th></tr>
              </thead>
              <tbody>
                {issues.map(issue => (
                  <tr key={issue.id}>
                    <td><SeverityBadge severity={issue.severity} /></td>
                    <td>
                      <div className="mono text-sm">{issue.rule_id || issue.issue_type}</div>
                      <div className="text-tertiary text-sm" style={{ textTransform: 'capitalize' }}>{issue.category} &middot; {issue.scope}</div>
                    </td>
                    <td className="text-sm">
                      {issue.record_name || issue.business_key || issue.source_row_id
                        ? <>{issue.record_name && <div>{issue.record_name}</div>}{(issue.business_key || issue.source_row_id) && <div className="mono text-tertiary">{issue.business_key || issue.source_row_id}</div>}</>
                        : <span className="text-tertiary">dataset-level</span>}
                    </td>
                    <td className="mono text-sm">{issue.field_name || '—'}</td>
                    <td className="mono text-sm" style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis' }} title={issue.observed_value || ''}>{issue.observed_value ?? '—'}</td>
                    <td style={{ maxWidth: 340 }}>
                      {issue.explanation}
                      {issue.evidence && <details className="text-tertiary text-sm mt-1"><summary>Evidence</summary><pre className="mono" style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(issue.evidence, null, 1)}</pre></details>}
                    </td>
                    <td className="text-tertiary text-sm">
                      {issue.source_file && <div>{issue.source_file}{issue.sheet ? ` — ${issue.sheet}` : ''}</div>}
                      {issue.row_number != null && <div>row {issue.row_number}</div>}
                    </td>
                    <td>
                      {issue.record_id && (
                        <button className="btn btn-ghost btn-sm" onClick={() => navigate(`/records/${issue.record_id}`)}>View record</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination page={page} pageSize={pageSize} total={total} onPageChange={setPage} />
      </div>
    </div>
  );
}

function sevCount(dashboard, sev) {
  return dashboard.issues_by_severity.find(s => s.severity === sev)?.c || 0;
}
