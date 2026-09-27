import { useParams, useNavigate } from 'react-router-dom';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, PieChart, Pie, Legend } from 'recharts';
import { ShieldAlert, ListChecks, Copy, AlertTriangle, FileWarning, Ban, Clock, Files } from 'lucide-react';
import { useRunDashboard } from '../hooks/useRunDashboard';
import { HealthGauge, LoadingState, ErrorState, KpiCard } from '../components/common';
import RunHeaderBar from '../components/RunHeaderBar';

const SEV_COLORS = { critical: '#dc2626', high: '#d97706', medium: '#ca8a04', low: '#64748b' };
const CAT_COLORS = ['#2563eb', '#7c3aed', '#16a34a', '#d97706', '#64748b'];

const DIMENSION_LABELS = {
  completeness: 'Completeness',
  validity: 'Validity',
  uniqueness: 'Uniqueness',
  consistency: 'Consistency',
  freshness: 'Freshness'
};

export default function ExecutiveOverview() {
  const { runId } = useParams();
  const navigate = useNavigate();
  const { dashboard, error, loading } = useRunDashboard(runId);

  if (error) return <ErrorState message={error} />;
  if (loading || !dashboard) return <LoadingState label="Loading executive overview…" />;

  const { summary, health, top_issue_types, clusters_by_kind, age_distribution, issues_by_severity } = dashboard;

  const kpis = [
    {
      label: 'Duplicate Candidates', value: summary.potential_duplicate_records, icon: Copy, tone: 'purple',
      sub: 'Exact + normalized + probable matches',
      onClick: () => navigate(`/runs/${runId}/duplicates`)
    },
    {
      label: 'Entity Conflicts', value: summary.conflicts, icon: AlertTriangle, tone: summary.conflicts > 0 ? 'red' : 'green',
      sub: 'Shared identifier, different entity',
      onClick: () => navigate(`/runs/${runId}/conflicts`)
    },
    {
      label: 'Missing / Incomplete', value: summary.incomplete_records, icon: FileWarning, tone: 'amber',
      sub: 'Records missing key fields',
      onClick: () => navigate(`/runs/${runId}/missing-invalid`)
    },
    {
      label: 'Invalid Data', value: summary.invalid_records, icon: Ban, tone: 'amber',
      sub: 'Malformed GSTIN, email, phone, dates',
      onClick: () => navigate(`/runs/${runId}/missing-invalid`)
    },
    {
      label: 'Stale Records', value: summary.stale_records, icon: Clock, tone: 'blue',
      sub: 'No modification in 3+ years',
      onClick: () => navigate(`/runs/${runId}/freshness`)
    },
    {
      label: 'Source Files', value: summary.files_analyzed, icon: Files, tone: 'blue',
      sub: 'Analyzed in this run',
      onClick: () => navigate(`/runs/${runId}/issues`)
    }
  ];

  const sevData = ['critical', 'high', 'medium', 'low'].map(sev => ({
    severity: sev,
    count: issues_by_severity.find(s => s.severity === sev)?.c || 0
  }));
  const catData = dashboard.issues_by_category.map(c => ({ name: c.category, value: c.c }));

  const topRisks = [...top_issue_types]
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || b.c - a.c)
    .slice(0, 5);

  const highImpact = top_issue_types.filter(t => ['critical', 'high'].includes(t.severity));
  const mediumImpact = top_issue_types.filter(t => t.severity === 'medium');
  const lowImpact = top_issue_types.filter(t => t.severity === 'low');

  return (
    <div>
      <RunHeaderBar dashboard={dashboard} title="Executive Overview" subtitle="How healthy is your SAP/ERP data, and what needs attention first." />

      <div className="panel-hero mb-4 hero-health-panel">
        <div className="health-gauge-wrap">
          <HealthGauge score={summary.health_score} size={140} variant="dark" />
          <div style={{ flex: 1 }}>
            <div className="hero-health-headline">
              {summary.pct_records_requiring_attention}% of records require attention
            </div>
            <div className="text-secondary text-sm mb-2">
              {summary.records_with_any_issue.toLocaleString()} of {summary.records_analyzed.toLocaleString()} records analyzed have at least one detected issue.
            </div>
            <div className="hero-risk-chips">
              {summary.potential_duplicate_records > 0 && (
                <span className="badge badge-medium hero-chip" onClick={() => navigate(`/runs/${runId}/duplicates`)}>
                  {summary.potential_duplicate_records.toLocaleString()} duplicate candidates
                </span>
              )}
              {summary.incomplete_records > 0 && (
                <span className="badge badge-medium hero-chip" onClick={() => navigate(`/runs/${runId}/missing-invalid`)}>
                  {summary.incomplete_records.toLocaleString()} missing critical fields
                </span>
              )}
              {summary.conflicts > 0 && (
                <span className="badge badge-critical hero-chip" onClick={() => navigate(`/runs/${runId}/conflicts`)}>
                  {summary.conflicts.toLocaleString()} conflicts
                </span>
              )}
              {summary.stale_records > 0 && (
                <span className="badge badge-low hero-chip" onClick={() => navigate(`/runs/${runId}/freshness`)}>
                  {summary.stale_records.toLocaleString()} stale records
                </span>
              )}
              {summary.total_issues === 0 && <span className="badge badge-success">No issues detected in this run</span>}
            </div>
          </div>
        </div>
      </div>

      <div className="grid-2" style={{ marginBottom: 'var(--space-4)' }}>
        <div className="kpi-hero kpi-clickable" onClick={() => navigate(`/runs/${runId}/issues`)} style={{ marginBottom: 0 }}>
          <div className="kpi-hero-value">{summary.total_issues.toLocaleString()}</div>
          <div className="kpi-hero-body">
            <div className="kpi-hero-label">Issues Detected</div>
            <div className="kpi-hero-sub">{summary.pct_records_requiring_attention}% of records affected — click to investigate</div>
          </div>
        </div>
        <div className="kpi-hero" style={{ marginBottom: 0 }}>
          <div className="kpi-hero-value">{summary.records_analyzed.toLocaleString()}</div>
          <div className="kpi-hero-body">
            <div className="kpi-hero-label">Total Records</div>
            <div className="kpi-hero-sub">Analyzed across {summary.files_analyzed} source file(s)</div>
          </div>
        </div>
      </div>

      <div className="kpi-grid-secondary mb-4">
        {kpis.map(k => (
          <KpiCard key={k.label} icon={k.icon} tone={k.tone} label={k.label} value={(k.value ?? 0).toLocaleString()} sub={k.sub} onClick={k.onClick} compact />
        ))}
      </div>
      <div className="grid-2 mb-4">
        <div className="panel">
          <div className="panel-title">
            <span>Data Quality Breakdown</span>
            <span className="text-secondary text-sm hero-link" onClick={() => navigate(`/runs/${runId}/quality`)}>Full breakdown &rarr;</span>
          </div>
          {health?.breakdown ? (
            <div className="quality-dim-list">
              {Object.entries(DIMENSION_LABELS).map(([key, label]) => {
                const dim = health.breakdown[key];
                if (!dim) return null;
                return (
                  <div className="quality-dim-row" key={key}>
                    <div className="quality-dim-label">{label}</div>
                    <div className="quality-dim-bar-track">
                      <div className="quality-dim-bar-fill" style={{ width: `${dim.score}%`, background: dimColor(dim.score) }} />
                    </div>
                    <div className="quality-dim-score">{dim.score}</div>
                  </div>
                );
              })}
            </div>
          ) : <div className="text-secondary text-sm">No score available.</div>}
        </div>

        <div className="panel">
          <div className="panel-title">
            <span>Critical Data Risks</span>
            <ShieldAlert size={15} className="text-tertiary" />
          </div>
          {topRisks.length === 0 ? (
            <div className="text-secondary text-sm">No significant risks detected in this dataset.</div>
          ) : (
            <ol className="risk-list">
              {topRisks.map((r, i) => (
                <li key={r.issue_type} className="risk-item" onClick={() => navigate(`/runs/${runId}/issues?issue_type=${r.issue_type}`)}>
                  <span className={`risk-rank risk-rank-${r.severity}`}>{i + 1}</span>
                  <div style={{ flex: 1 }}>
                    <div className="risk-title">{r.c.toLocaleString()} {humanizeIssueType(r.issue_type)}</div>
                    <div className="text-tertiary text-sm">{issueTypeExplanation(r.issue_type)}</div>
                  </div>
                  <span className={`badge badge-${r.severity}`}>{r.severity}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>

      <div className="panel mb-4">
        <div className="panel-title">
          <span>What Should I Fix First</span>
          <ListChecks size={15} className="text-tertiary" />
        </div>
        <div className="grid-3">
          <PriorityColumn label="High Impact" tone="critical" items={highImpact} runId={runId} navigate={navigate} />
          <PriorityColumn label="Medium Impact" tone="medium" items={mediumImpact} runId={runId} navigate={navigate} />
          <PriorityColumn label="Low Impact" tone="low" items={lowImpact} runId={runId} navigate={navigate} />
        </div>
      </div>

      <div className="grid-2 mb-4">
        <div className="panel">
          <div className="panel-title">Issues by Severity</div>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={sevData} layout="vertical" margin={{ left: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" horizontal={false} />
              <XAxis type="number" tick={{ fill: 'var(--text-tertiary)', fontSize: 11 }} />
              <YAxis type="category" dataKey="severity" tick={{ fill: 'var(--text-secondary)', fontSize: 12 }} width={70} />
              <Tooltip contentStyle={{ background: 'var(--surface-raised)', border: '1px solid var(--border-strong)', fontSize: 12 }} />
              <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                {sevData.map((d, i) => <Cell key={i} fill={SEV_COLORS[d.severity]} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="panel">
          <div className="panel-title">Issues by Category</div>
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie data={catData} dataKey="value" nameKey="name" innerRadius={40} outerRadius={75} paddingAngle={2}>
                {catData.map((d, i) => <Cell key={i} fill={CAT_COLORS[i % CAT_COLORS.length]} />)}
              </Pie>
              <Legend wrapperStyle={{ fontSize: 12, color: 'var(--text-secondary)' }} />
              <Tooltip contentStyle={{ background: 'var(--surface-raised)', border: '1px solid var(--border-strong)', fontSize: 12 }} />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">Entity vs Item Duplicate Clusters</div>
        {clusters_by_kind.length === 0 ? (
          <div className="text-secondary text-sm">No duplicate clusters detected.</div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>Kind</th><th>Clusters</th><th>Records involved</th><th>Avg. confidence</th><th></th></tr></thead>
              <tbody>
                {clusters_by_kind.map(c => (
                  <tr key={c.cluster_kind} className="clickable" onClick={() => navigate(c.cluster_kind === 'item' ? `/runs/${runId}/items` : `/runs/${runId}/entities`)}>
                    <td style={{ textTransform: 'capitalize' }}>{c.cluster_kind}</td>
                    <td>{c.c}</td>
                    <td>{c.records}</td>
                    <td>{Math.round(c.avg_conf * 100)}%</td>
                    <td className="text-secondary text-sm">Investigate &rarr;</td>
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

function PriorityColumn({ label, tone, items, runId, navigate }) {
  return (
    <div>
      <div className={`priority-col-label priority-col-${tone}`}>{label}</div>
      {items.length === 0 ? (
        <div className="text-tertiary text-sm">None found.</div>
      ) : (
        <ul className="priority-list">
          {items.slice(0, 6).map(i => (
            <li key={i.issue_type} onClick={() => navigate(`/runs/${runId}/issues?issue_type=${i.issue_type}`)}>
              {humanizeIssueType(i.issue_type)} <span className="text-tertiary">({i.c})</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function severityRank(sev) { return { critical: 4, high: 3, medium: 2, low: 1 }[sev] || 0; }
function dimColor(score) {
  if (score >= 80) return 'var(--success)';
  if (score >= 60) return 'var(--sev-medium)';
  if (score >= 40) return 'var(--sev-high)';
  return 'var(--sev-critical)';
}
function humanizeIssueType(t) { return (t || '').replace(/_/g, ' '); }
function issueTypeExplanation(t) {
  const map = {
    shared_gstin_multi_entity: 'Same GSTIN associated with multiple legal entity names.',
    shared_phone_diff_entity: 'Same phone number associated with different entities.',
    shared_email_diff_entity: 'Same email address associated with different entities.',
    missing_primary_identifier: 'Primary name/identifier is missing for these records.',
    missing_field: 'A key business field is empty.',
    incomplete_record: 'Fewer than half of key fields are populated.',
    invalid_gstin: 'GSTIN does not match the standard format.',
    invalid_email: 'Email does not match a valid format.',
    invalid_phone: 'Phone number has an unusual digit count.',
    invalid_date: 'Date value could not be parsed.',
    stale_record: 'No modification in over 3 years.',
    exact_duplicate_row: 'Row is an exact duplicate of another.',
    duplicate_identifier: 'Identifier value repeats across multiple records.',
    future_created_date: 'Creation date is in the future.',
    modified_before_created: 'Last-modified date is earlier than the creation date.',
    missing_date_info: 'No creation or modification date available.'
  };
  return map[t] || 'Detected by the data-quality engine.';
}
