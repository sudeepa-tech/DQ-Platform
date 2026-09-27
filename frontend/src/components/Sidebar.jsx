import { useNavigate, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, Database, History, ShieldCheck, Search, FileWarning, Clock,
  Copy, Building2, AlertTriangle, Package, FileOutput, Lock, Layers
} from 'lucide-react';
import { useRunContext } from '../context/RunContext';
import { PRODUCT_SHORT_NAME, PRODUCT_TAGLINE } from '../config/brand';

// Each Phase 1 item is "run-scoped": it needs a currently-selected analysis
// run to point at. If none is selected yet, it falls back to the Datasets
// screen so the user is guided to pick/create one rather than hitting a
// dead route. Grouped to match the product's real information architecture
// (Overview / Data / Quality / Intelligence / Outputs) rather than one
// flat list.
const NAV_GROUPS = [
  {
    label: null,
    items: [
      { label: 'Overview', icon: LayoutDashboard, path: (runId) => `/runs/${runId}/overview`, scoped: true }
    ]
  },
  {
    label: 'Data',
    items: [
      { label: 'Datasets', icon: Database, path: () => '/', scoped: false },
      { label: 'Analysis Runs', icon: History, path: () => '/analysis-runs', scoped: false }
    ]
  },
  {
    label: 'Quality',
    items: [
      { label: 'Data Quality', icon: ShieldCheck, path: (runId) => `/runs/${runId}/quality`, scoped: true },
      { label: 'Issue Explorer', icon: Search, path: (runId) => `/runs/${runId}/issues`, scoped: true },
      { label: 'Missing & Invalid', icon: FileWarning, path: (runId) => `/runs/${runId}/missing-invalid`, scoped: true },
      { label: 'Data Freshness', icon: Clock, path: (runId) => `/runs/${runId}/freshness`, scoped: true }
    ]
  },
  {
    label: 'Intelligence',
    items: [
      { label: 'Duplicates & Matches', icon: Copy, path: (runId) => `/runs/${runId}/duplicates`, scoped: true },
      { label: 'Entity Intelligence', icon: Building2, path: (runId) => `/runs/${runId}/entities`, scoped: true },
      { label: 'Conflicts', icon: AlertTriangle, path: (runId) => `/runs/${runId}/conflicts`, scoped: true },
      { label: 'Item / Material Intelligence', icon: Package, path: (runId) => `/runs/${runId}/items`, scoped: true }
    ]
  },
  {
    label: 'Outputs',
    items: [
      { label: 'Reports & Exports', icon: FileOutput, path: (runId) => `/runs/${runId}/reports`, scoped: true }
    ]
  }
];

const PHASE2_ITEMS = [
  { label: 'Golden Records', key: 'golden-records', desc: 'Merge validated duplicate clusters into a single trusted master record per entity, with full history of what was merged and why.' },
  { label: 'Review & Approvals', key: 'review-approvals', desc: 'Route flagged data-quality issues to the right owner for review, with an approve/reject workflow and audit trail.' },
  { label: 'Data Governance', key: 'governance', desc: 'Define ownership, stewardship responsibilities, and data-quality SLAs across datasets and business domains.' },
  { label: 'Data Lineage', key: 'lineage', desc: 'Trace how a value moved and changed across systems, uploads, and analysis runs over time.' },
  { label: 'Continuous Monitoring', key: 'monitoring', desc: 'Automatically re-run analysis as new SAP/ERP extracts arrive and alert on quality regressions.' },
  { label: 'Historical Quality Trends', key: 'trends', desc: 'Track how your Data Health Score and issue counts evolve run over run.' },
  { label: 'Advanced Rules', key: 'rules', desc: 'Author custom validation and matching rules specific to your business, beyond the built-in engines.' },
  { label: 'SAP Integration', key: 'sap', desc: 'Connect directly to SAP/ERP systems for scheduled extraction, instead of manual file upload.' },
  { label: 'Master Data Management', key: 'mdm', desc: 'Publish golden records back into source systems as the single source of truth.' },
  { label: 'Enterprise Administration', key: 'admin', desc: 'Manage users, roles, organizations, and platform-wide settings.' }
];

export default function Sidebar({ onLockedClick }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { current } = useRunContext();
  const runId = current?.runId;

  function go(item) {
    if (item.scoped && !runId) {
      navigate('/');
      return;
    }
    navigate(item.path(runId));
  }

  function isActive(item) {
    if (!item.scoped) return location.pathname === item.path();
    return runId && location.pathname === item.path(runId);
  }

  function onItemKeyDown(e, item) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(item); } }
  function onLockedKeyDown(e, item) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onLockedClick(item); } }

  return (
    <aside className="sidebar" aria-label="Application">
      <div className="brand">
        <div className="brand-mark" aria-hidden="true"><Layers size={16} strokeWidth={2.2} /></div>
        <div>
          <div className="brand-name">{PRODUCT_SHORT_NAME}</div>
          <div className="brand-sub">{PRODUCT_TAGLINE}</div>
        </div>
      </div>

      {current?.datasetName && (
        <div className="sidebar-current-context">
          <div className="text-tertiary" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Active dataset</div>
          <div style={{ fontSize: 13, fontWeight: 500, marginTop: 2 }} title={current.datasetName}>{current.datasetName}</div>
        </div>
      )}

      <nav aria-label="Main navigation">
        <div className="nav-section-label" id="nav-data-intelligence">DATA INTELLIGENCE</div>
        {NAV_GROUPS.map((group, gi) => (
          <div key={gi}>
            {group.label && <div className="nav-group-label" id={`nav-group-${gi}`}>{group.label}</div>}
            <ul className="nav-list" aria-labelledby={group.label ? `nav-group-${gi}` : 'nav-data-intelligence'}>
              {group.items.map(item => {
                const Icon = item.icon; const disabled = item.scoped && !runId; const active = isActive(item);
                return (
                  <li key={item.label}
                    className={`nav-item ${active ? 'active' : ''} ${disabled ? 'nav-item-muted' : ''}`}
                    role="button" tabIndex={0} aria-current={active ? 'page' : undefined}
                    aria-label={disabled ? `${item.label} (select or open a dataset first)` : item.label}
                    onClick={() => go(item)} onKeyDown={e => onItemKeyDown(e, item)}
                    title={disabled ? 'Select or open a dataset first' : undefined}>
                    <Icon size={15} strokeWidth={1.6} aria-hidden="true" />
                    <span>{item.label}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <nav aria-label="Phase 2 (locked)">
        <div className="nav-section-label" id="nav-phase2">GOVERNANCE — PHASE 2</div>
        <ul className="nav-list" aria-labelledby="nav-phase2">
          {PHASE2_ITEMS.map(item => (
            <li key={item.key} className="nav-item locked" role="button" tabIndex={0} aria-disabled="true"
              aria-label={`${item.label} (coming in Phase 2)`} onClick={() => onLockedClick(item)} onKeyDown={e => onLockedKeyDown(e, item)}>
              <Lock size={12} strokeWidth={1.6} aria-hidden="true" />
              <span>{item.label}</span>
            </li>
          ))}
        </ul>
      </nav>

      <div style={{ marginTop: 'auto' }}>
        <div className="sidebar-phase2-card">
          <div className="sidebar-phase2-card-title">Governance suite</div>
          <div className="sidebar-phase2-card-desc">
            Golden records, approvals, lineage, and continuous monitoring arrive in Phase 2, building on this
            Phase 1 data foundation.
          </div>
        </div>
      </div>
    </aside>
  );
}
