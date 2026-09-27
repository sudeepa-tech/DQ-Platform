import { useNavigate, useLocation } from 'react-router-dom';
import { useRunContext } from '../context/RunContext';

/** The run-scoped quick-navigation tabs, in the same order as the sidebar's
 * "Data Intelligence" groups. Purely a faster, page-header way to switch
 * between the analysis screens for the current run -- the sidebar itself
 * is untouched and remains the canonical navigation. */
const RUN_TABS = [
  { label: 'Overview', path: (id) => `/runs/${id}/overview` },
  { label: 'Quality Score', path: (id) => `/runs/${id}/quality` },
  { label: 'Issues', path: (id) => `/runs/${id}/issues` },
  { label: 'Missing & Invalid', path: (id) => `/runs/${id}/missing-invalid` },
  { label: 'Freshness', path: (id) => `/runs/${id}/freshness` },
  { label: 'Duplicates', path: (id) => `/runs/${id}/duplicates` },
  { label: 'Entities', path: (id) => `/runs/${id}/entities` },
  { label: 'Items', path: (id) => `/runs/${id}/items` },
  { label: 'Conflicts', path: (id) => `/runs/${id}/conflicts` },
  { label: 'Reports & Export', path: (id) => `/runs/${id}/reports` }
];

export default function RunHeaderBar({ dashboard, title, subtitle, actions }) {
  const navigate = useNavigate();
  const location = useLocation();
  if (!dashboard) return null;
  const { run, summary } = dashboard;

  return (
    <div style={{ marginBottom: 'var(--space-5)' }}>
      <div className="run-header-bar">
        <div className="run-header-left">
          <HeaderBreadcrumb dashboard={dashboard} navigate={navigate} />
          <div className="run-title-row">
            <h1 style={{ margin: '2px 0 0 0', fontSize: 'inherit', fontWeight: 'inherit' }}>{title}</h1>
            <span className={`topbar-status ${run.status === 'complete' ? 'topbar-status-complete' : run.status === 'failed' ? 'topbar-status-failed' : ''}`}>{run.status}</span>
          </div>
          {subtitle && <div className="text-secondary text-sm" style={{ marginTop: 4 }}>{subtitle}</div>}
        </div>
        <div className="run-header-right">
          <div className="run-header-stat">
            <div className="text-tertiary text-sm">Records analyzed</div>
            <div style={{ fontSize: 18, fontWeight: 600 }}>{summary.records_analyzed.toLocaleString()}</div>
          </div>
          <div className="run-header-stat">
            <div className="text-tertiary text-sm">Health score</div>
            <div style={{ fontSize: 18, fontWeight: 600, color: healthColor(summary.health_score) }}>{summary.health_score ?? '—'}</div>
          </div>
          {actions && <div className="run-header-actions">{actions}</div>}
        </div>
      </div>

      <nav className="run-tab-strip" aria-label="Run sections">
        {RUN_TABS.map(t => {
          const path = t.path(run.id);
          const active = location.pathname === path;
          return (
            <span key={t.label} className={`run-tab ${active ? 'active' : ''}`} onClick={() => navigate(path)}
              role="link" tabIndex={0} aria-current={active ? 'page' : undefined}
              onKeyDown={e => { if (e.key === 'Enter') navigate(path); }}>
              {t.label}
            </span>
          );
        })}
      </nav>
    </div>
  );
}

function HeaderBreadcrumb({ dashboard, navigate }) {
  const { run } = dashboard;
  const { current } = useRunContext();
  const label = (current?.runId === run.id && current?.datasetName) || `Analysis run ${run.id.slice(0, 8)}`;
  return (
    <div className="run-breadcrumb">
      <span className="crumb-link" onClick={() => navigate('/')}>Datasets</span>
      <span aria-hidden="true">/</span>
      <span className="crumb-link" onClick={() => navigate(`/datasets/${run.dataset_id}`)}>{label}</span>
    </div>
  );
}

function healthColor(score) {
  if (score === null || score === undefined) return 'var(--text-secondary)';
  if (score >= 80) return 'var(--success)';
  if (score >= 60) return 'var(--sev-medium)';
  if (score >= 40) return 'var(--sev-high)';
  return 'var(--sev-critical)';
}
