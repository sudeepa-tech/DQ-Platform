/** Reusable KPI card with a colored icon tile, per the approved design
 * reference (Total Datasets / Total Records / Quality Issues / Entity
 * Clusters style cards). `tone` picks the icon-tile palette; `compact`
 * matches the smaller secondary-KPI-row treatment used lower on pages. */
export function KpiCard({ icon: Icon, tone = 'blue', label, value, sub, trend, onClick, compact = false }) {
  const clickable = typeof onClick === 'function';
  return (
    <div
      className={`kpi ${compact ? 'kpi-compact' : ''} ${clickable ? 'kpi-clickable' : ''}`}
      onClick={onClick}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(e); } }) : undefined}
    >
      <div className="kpi-icon-row">
        {Icon && (
          <div className={`kpi-icon-tile kpi-icon-${tone}`}>
            <Icon size={18} strokeWidth={2} aria-hidden="true" />
          </div>
        )}
        <div className="kpi-icon-body">
          <div className="kpi-label">{label}</div>
          <div className="kpi-value">{value}</div>
          {sub && <div className="kpi-sub">{sub}</div>}
          {trend && <div className={`kpi-trend kpi-trend-${trend.direction || 'neutral'}`}>{trend.text}</div>}
        </div>
      </div>
    </div>
  );
}

/** Page-header breadcrumb, e.g. "Datasets / ERP_Dump", per reference. */
export function Breadcrumb({ items }) {
  return (
    <div className="run-breadcrumb">
      {items.map((it, i) => {
        const last = i === items.length - 1;
        return (
          <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            {i > 0 && <span aria-hidden="true">/</span>}
            {it.onClick && !last ? (
              <span className="crumb-link" onClick={it.onClick} role="link" tabIndex={0}
                onKeyDown={e => { if (e.key === 'Enter') it.onClick(); }}>{it.label}</span>
            ) : (
              <span className={last ? 'crumb-current' : ''}>{it.label}</span>
            )}
          </span>
        );
      })}
    </div>
  );
}

/** Numbered pagination bar shared by every filterable table in the app. */
export function Pagination({ page, pageSize, total, onPageChange }) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (totalPages <= 1) return null;
  const pages = [];
  const windowSize = 5;
  let start = Math.max(1, page - Math.floor(windowSize / 2));
  let end = Math.min(totalPages, start + windowSize - 1);
  start = Math.max(1, end - windowSize + 1);
  for (let p = start; p <= end; p++) pages.push(p);

  return (
    <div className="pagination-bar">
      <span className="text-tertiary text-sm">
        Showing {Math.min((page - 1) * pageSize + 1, total)}–{Math.min(page * pageSize, total)} of {total.toLocaleString()}
      </span>
      <div className="pagination-pages">
        <button className="pagination-page-btn" disabled={page <= 1} onClick={() => onPageChange(page - 1)} aria-label="Previous page">&lsaquo;</button>
        {start > 1 && <span className="text-tertiary text-sm" style={{ padding: '0 4px' }}>&hellip;</span>}
        {pages.map(p => (
          <button key={p} className={`pagination-page-btn ${p === page ? 'active' : ''}`} onClick={() => onPageChange(p)} aria-current={p === page ? 'page' : undefined}>{p}</button>
        ))}
        {end < totalPages && <span className="text-tertiary text-sm" style={{ padding: '0 4px' }}>&hellip;</span>}
        <button className="pagination-page-btn" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)} aria-label="Next page">&rsaquo;</button>
      </div>
    </div>
  );
}

export function SeverityBadge({ severity }) {
  const cls = { critical: 'badge-critical', high: 'badge-high', medium: 'badge-medium', low: 'badge-low' }[severity] || 'badge-neutral';
  return <span className={`badge ${cls}`}>{severity}</span>;
}

export function CategoryBadge({ category }) {
  return <span className="badge badge-neutral">{category}</span>;
}

export function ConfidenceBadge({ confidence }) {
  const pct = Math.round((confidence || 0) * 100);
  const cls = pct >= 90 ? 'badge-success' : pct >= 70 ? 'badge-signal' : 'badge-neutral';
  return <span className={`badge ${cls}`}>{pct}% confidence</span>;
}

export function HealthGauge({ score, size = 120, variant = 'light' }) {
  if (score === null || score === undefined) {
    return <div className="text-tertiary text-sm">No score yet</div>;
  }
  const radius = size / 2 - 8;
  const circumference = 2 * Math.PI * radius;
  const pct = Math.max(0, Math.min(100, score));
  const offset = circumference * (1 - pct / 100);
  const dark = variant === 'dark';
  // On the dark forest-green hero panel, the same deep "success" green used
  // for text-on-white would nearly disappear into the background -- the
  // bright emerald (reserved elsewhere for positive-status badges) reads
  // clearly against dark green instead.
  const color = dark
    ? (pct >= 80 ? 'var(--success-bright)' : pct >= 60 ? '#f0c419' : pct >= 40 ? '#f0973f' : '#f2726b')
    : (pct >= 80 ? 'var(--success)' : pct >= 60 ? 'var(--sev-medium)' : pct >= 40 ? 'var(--sev-high)' : 'var(--sev-critical)');
  const trackColor = dark ? 'rgba(255,255,255,0.18)' : 'var(--border-subtle)';
  const textColor = dark ? '#ffffff' : 'var(--text-primary)';
  const labelColor = dark ? 'rgba(255,255,255,0.65)' : undefined;

  return (
    <div style={{ position: 'relative', width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size / 2} cy={size / 2} r={radius} stroke={trackColor} strokeWidth="7" fill="none" />
        <circle cx={size / 2} cy={size / 2} r={radius} stroke={color} strokeWidth="7" fill="none"
          strokeDasharray={circumference} strokeDashoffset={offset} strokeLinecap="round"
          style={{ transition: 'stroke-dashoffset 0.6s ease' }} />
      </svg>
      <div style={{
        position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center'
      }}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: size * 0.32, fontWeight: 500, lineHeight: 1, fontVariantNumeric: 'tabular-nums', color: textColor }}>{Math.round(pct)}</div>
        {size >= 80 && (
          <div className={dark ? '' : 'text-tertiary'} style={{ fontSize: Math.max(9, size * 0.075), marginTop: size * 0.06, letterSpacing: '0.06em', whiteSpace: 'nowrap', color: labelColor }}>HEALTH SCORE</div>
        )}
      </div>
    </div>
  );
}

import { useEffect, useId, useRef } from 'react';

export function Modal({ title, onClose, children, width }) {
  const titleId = useId(); const panelRef = useRef(null);
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    panelRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-panel" style={width ? { maxWidth: width } : undefined} onClick={e => e.stopPropagation()}
        role="dialog" aria-modal="true" aria-labelledby={titleId} ref={panelRef} tabIndex={-1}>
        <div className="flex items-center justify-between mb-4">
          <h3 id={titleId} style={{ margin: 0, fontSize: 15 }}>{title}</h3>
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close dialog">Close</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function EmptyState({ title, description, action }) {
  return (
    <div className="state-block">
      <div className="state-title">{title}</div>
      {description && <div className="text-sm">{description}</div>}
      {action}
    </div>
  );
}

export function LoadingState({ label = 'Loading…' }) {
  return (
    <div className="state-block">
      <div className="spinner" />
      <div className="text-sm">{label}</div>
    </div>
  );
}

export function ErrorState({ message }) {
  return (
    <div className="state-block">
      <div className="state-title" style={{ color: 'var(--sev-critical)' }}>Something went wrong</div>
      <div className="text-sm">{message}</div>
    </div>
  );
}

export function LockedModuleModal({ item, onClose }) {
  if (!item) return null;
  return (
    <Modal title={`${item.label} — Coming in the next platform release`} onClose={onClose}>
      <p className="text-secondary" style={{ marginTop: 0 }}>{item.desc}</p>
      <p className="text-tertiary text-sm">
        This module is part of Phase 2 (Data Governance & Continuous Intelligence), which builds on the
        data foundation established here in Phase 1.
      </p>
    </Modal>
  );
}
