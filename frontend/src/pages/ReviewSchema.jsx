import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { FileCheck2 } from 'lucide-react';
import { api } from '../api/client';
import { SeverityBadge, Breadcrumb } from '../components/common';

const DATASET_TYPES = ['master_entity', 'master_material', 'transaction', 'mixed_unknown'];
const REQUIREDNESS = ['required', 'expected', 'optional'];

function Pct({ value }) {
  if (value === null || value === undefined) return <span className="text-tertiary">—</span>;
  return <span>{Math.round(value * 100)}%</span>;
}

/**
 * The real Schema Review screen (S6), built on the S3 API: dataset type + confidence + reasons, every physical column with its
 * detected role, confidence, alternatives, requiredness, validation profile, include/exclude, duplicate-header identity and
 * review status. Nothing uncertain is hidden -- every low/medium-confidence item is visibly flagged, not just the ones the
 * classifier marked review_required. The user can override role, requiredness and include/exclude, override the dataset
 * type, then confirm -- which is the only thing that unlocks a real analysis run for this file.
 */
export default function ReviewSchema() {
  const { fileId } = useParams();
  const [search] = useState(() => new URLSearchParams(window.location.search));
  const datasetId = search.get('dataset');
  const navigate = useNavigate();

  const [model, setModel] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(null);

  const load = useCallback(async (version) => {
    try { setModel(await api.getSchemaReview(fileId, version)); }
    catch (e) {
      if (/not been canonically ingested/i.test(e.message)) { setError('This file is still being ingested. Refresh in a moment.'); return; }
      // No mapping suggested yet: ask the classifier for one, then load it.
      try { const s = await api.suggestSchema(fileId); setModel(s.review); }
      catch (e2) { setError(e2.message); }
    }
  }, [fileId]);

  useEffect(() => { load(); }, [load]);

  async function reSuggest() {
    setBusy(true); setError(null);
    try { const s = await api.suggestSchema(fileId, true); setModel(s.review); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function changeDatasetType(value) {
    setBusy(true); setError(null);
    try { setModel(await api.setDatasetType(fileId, model.mapping.version, value, 'Reviewer override')); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function changeColumn(col, changes) {
    setBusy(true); setError(null);
    try { setModel(await api.overrideColumn(fileId, model.mapping.version, col.file_column_id, changes)); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function confirm(acceptRemaining) {
    setBusy(true); setError(null);
    try {
      const r = await api.confirmSchema(fileId, model.mapping.version, acceptRemaining);
      setModel(r);
      if (r.mapping.locked) navigate(datasetId ? `/datasets/${datasetId}` : -1);
    } catch (e) {
      if (e.unresolved) { setError(`${e.unresolved.length} column(s) still need a decision below.`); }
      else setError(e.message);
    } finally { setBusy(false); }
  }
  async function reviseAndEdit() {
    setBusy(true); setError(null);
    try { const r = await api.reviseSchema(fileId, model.mapping.version, 'Editing a confirmed mapping'); setModel(r.review); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  if (error && !model) return <div className="page"><div className="panel mb-2" style={{ color: 'var(--sev-critical)' }}>{error}</div></div>;
  if (!model) return <div className="page"><div className="text-tertiary">Loading schema review…</div></div>;

  const { source_file, mapping, dataset_type, summary, columns } = model;
  const openColumns = columns.filter(c => c.review_required && c.status === 'suggested');
  const unresolvedTotal = openColumns.length + (dataset_type.needs_review ? 1 : 0);

  // Real 4-stage progress for THIS review, derived from actual model state --
  // never a fabricated "step N of 4", just what's genuinely resolved so far.
  const steps = [
    { label: 'Dataset Type', done: !dataset_type.needs_review },
    { label: 'Column Mapping', done: openColumns.length === 0 },
    { label: 'Review', done: unresolvedTotal === 0 },
    { label: 'Confirm', done: mapping.locked }
  ];
  let stepActiveIdx = steps.findIndex(s => !s.done);
  if (stepActiveIdx === -1) stepActiveIdx = steps.length - 1;

  return (
    <div>
      <Breadcrumb items={[
        { label: 'Datasets', onClick: () => navigate(datasetId ? `/datasets/${datasetId}` : '/') },
        { label: 'Schema Review' }
      ]} />
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 style={{ margin: '2px 0 0 0', fontSize: 'inherit', fontWeight: 'inherit' }}>Schema Review</h1>
          <p className="text-secondary text-sm" style={{ marginTop: 4 }}>
            Review and confirm the detected schema before analysis — {source_file.original_filename}
            {source_file.sheet_name ? ` — ${source_file.sheet_name}` : ''} · {source_file.data_row_count} rows · mapping v{mapping.version}{mapping.locked ? ' (confirmed)' : ' (draft)'}
          </p>
        </div>
        <div className="flex gap-2">
          {mapping.locked ? (
            <button className="btn btn-primary" disabled={busy} onClick={reviseAndEdit}>Revise this mapping</button>
          ) : (
            <>
              <button className="btn btn-ghost" disabled={busy} onClick={reSuggest}>Re-run classifier</button>
              <button className="btn btn-primary" disabled={busy} onClick={() => confirm(false)}>Confirm mapping</button>
              {unresolvedTotal > 0 && (
                <button className="btn btn-ghost" disabled={busy} onClick={() => confirm(true)} title="Confirm, accepting the classifier's own suggestions for anything still open">
                  Confirm as-is ({unresolvedTotal} unresolved)
                </button>
              )}
            </>
          )}
        </div>
      </div>

      <div className="workflow-stepper mb-4">
        {steps.map((s, i) => (
          <div key={s.label} className={`workflow-step ${s.done ? 'done' : i === stepActiveIdx ? 'active' : ''}`}>
            <div className="workflow-step-dot">{s.done ? '✓' : i + 1}</div>
            <div className="workflow-step-label">{s.label}</div>
            {i < steps.length - 1 && <div className="workflow-step-connector" />}
          </div>
        ))}
      </div>

      {error && <div className="panel mb-4" style={{ color: 'var(--sev-critical)' }}>{error}</div>}
      {mapping.locked && (
        <div className="panel mb-4" style={{ borderLeft: '3px solid var(--success)' }}>
          This mapping is confirmed and locked. Values can only change by revising it into a new draft version.
        </div>
      )}

      <div className="panel mb-4">
        <div className="panel-title">
          <span>Detected Dataset Type</span>
          {dataset_type.needs_review && <span className="badge badge-high">needs review</span>}
        </div>
        <div className="flex items-center gap-3 mb-2" style={{ flexWrap: 'wrap' }}>
          <div className="kpi-icon-tile kpi-icon-blue"><FileCheck2 size={18} strokeWidth={2} aria-hidden="true" /></div>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontWeight: 600, fontSize: 15, textTransform: 'capitalize' }}>{dataset_type.value.replace('_', ' ')}</div>
            <div className="text-tertiary text-sm"><Pct value={dataset_type.confidence} /> confidence · source: {dataset_type.source}</div>
          </div>
          {!mapping.locked && (
            <div className="flex items-center gap-2">
              <label className="text-secondary text-sm" htmlFor="dataset-type-override">Change:</label>
              <select id="dataset-type-override" className="input" style={{ width: 200 }} value={dataset_type.value} disabled={busy} onChange={e => changeDatasetType(e.target.value)}>
                {DATASET_TYPES.map(t => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}
              </select>
            </div>
          )}
        </div>
        {dataset_type.reasons.length > 0 && (
          <ul className="text-tertiary text-sm" style={{ margin: '4px 0 0 18px' }}>{dataset_type.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
        )}
        {dataset_type.alternatives.some(a => a.score > 0) && (
          <div className="table-wrap mt-2">
            <table className="data-table">
              <thead><tr><th>Alternative</th><th>Evidence share</th><th>Score</th></tr></thead>
              <tbody>{dataset_type.alternatives.map(a => <tr key={a.dataset_type}><td style={{ textTransform: 'capitalize' }}>{a.dataset_type.replace('_', ' ')}</td><td><Pct value={a.share} /></td><td>{a.score}</td></tr>)}</tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel">
        <div className="panel-title">
          <span>Column Mapping</span>
          <span className="text-tertiary text-sm">{summary.included}/{summary.columns} included{summary.empty_columns ? `, ${summary.empty_columns} empty` : ''}</span>
        </div>
        <div className="flex gap-2 mb-4" style={{ flexWrap: 'wrap' }}>
          {summary.unresolved_review > 0 && <span className="badge badge-high">{summary.unresolved_review} need review</span>}
          <span className="badge badge-neutral">{summary.by_requiredness.required || 0} required</span>
          <span className="badge badge-neutral">{summary.by_requiredness.expected || 0} expected</span>
          <span className="badge badge-neutral">{summary.by_requiredness.optional || 0} optional</span>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr><th>Column Name</th><th>Detected Role</th><th>Confidence</th><th>Requiredness</th><th>Status</th><th>Include</th><th></th></tr>
            </thead>
            <tbody>
              {columns.map(c => (
                <ColumnRow key={c.file_column_id} col={c} locked={mapping.locked} busy={busy}
                  expanded={expanded === c.file_column_id} onExpand={() => setExpanded(expanded === c.file_column_id ? null : c.file_column_id)}
                  onChange={changes => changeColumn(c, changes)} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function confidenceColor(tier) {
  if (tier === 'high') return 'var(--success)';
  if (tier === 'medium') return 'var(--sev-medium)';
  return 'var(--sev-high)';
}

function ColumnRow({ col, locked, busy, expanded, onExpand, onChange }) {
  return (
    <>
      <tr style={col.review_required ? { background: 'var(--sev-medium-tint)' } : undefined}>
        <td>
          <button className="btn btn-ghost btn-sm" style={{ fontWeight: 600, padding: '4px 6px' }} onClick={onExpand}>{col.header_raw}</button>
          {col.is_duplicate_header && <span className="badge badge-neutral" style={{ marginLeft: 6 }} title={`Duplicate header, occurrence #${col.duplicate_ordinal}`}>dup #{col.duplicate_ordinal}</span>}
        </td>
        <td>
          {locked ? <span className="mono text-sm">{col.role}</span> : (
            <select className="input" style={{ width: 150 }} aria-label={`Role for column ${col.header_raw}`} value={col.role} disabled={busy} onChange={e => onChange({ role: e.target.value })}>
              <option value={col.role}>{col.role}</option>
              {(col.alternatives || []).map(a => <option key={a.role} value={a.role}>{a.role} ({Math.round(a.confidence * 100)}%)</option>)}
              <option value="unknown">unknown</option>
            </select>
          )}
        </td>
        <td>
          <div className="confidence-bar-cell">
            <div className="confidence-bar-track">
              <div className="confidence-bar-fill" style={{ width: `${Math.round((col.confidence || 0) * 100)}%`, background: confidenceColor(col.confidence_tier) }} />
            </div>
            <span className="text-sm" style={{ color: confidenceColor(col.confidence_tier), fontWeight: 600, whiteSpace: 'nowrap' }}><Pct value={col.confidence} /></span>
          </div>
        </td>
        <td>
          {locked ? <span className="text-sm" style={{ textTransform: 'capitalize' }}>{col.requiredness}</span> : (
            <select className="input" style={{ width: 110 }} aria-label={`Requiredness for column ${col.header_raw}`} value={col.requiredness} disabled={busy} onChange={e => onChange({ requiredness: e.target.value })}>
              {REQUIREDNESS.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          )}
        </td>
        <td>
          <div className="flex items-center gap-2" style={{ flexWrap: 'wrap' }}>
            <span className={`badge ${col.status === 'confirmed' || col.status === 'auto_accepted' ? 'badge-success' : col.status === 'overridden' ? 'badge-signal' : 'badge-neutral'}`}>{col.status.replace(/_/g, ' ')}</span>
            {col.review_required && col.status === 'suggested' && <SeverityBadge severity="high" />}
          </div>
        </td>
        <td>
          <label className="switch">
            <input type="checkbox" aria-label={`Include column ${col.header_raw} in analysis`} checked={col.include_in_analysis} disabled={locked || busy} onChange={e => onChange({ include_in_analysis: e.target.checked })} />
            <span className="switch-track" aria-hidden="true" />
          </label>
        </td>
        <td><button className="btn btn-ghost btn-sm" onClick={onExpand}>{expanded ? 'Hide' : 'Details'}</button></td>
      </tr>
      {expanded && (
        <tr><td colSpan={7} style={{ background: 'var(--surface-hover)' }}>
          {col.review_reasons && col.review_reasons.length > 0 && (
            <div className="text-sm mb-2"><strong>Why this needs review:</strong><ul style={{ margin: '4px 0 0 18px' }}>{col.review_reasons.map((r, i) => <li key={i}>{r}</li>)}</ul></div>
          )}
          {col.validation_profile && (
            <div className="text-sm mb-2"><strong>Validation profile:</strong> {Object.entries(col.validation_profile).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('; ')}</div>
          )}
          <div className="text-tertiary text-sm">populated {Math.round((col.populated_ratio || 0) * 100)}% · distinct {col.distinct_count ?? '—'} · content type: {col.content_type}{col.primary_for_role === false ? ' · not the primary column for this role' : ''}</div>
        </td></tr>
      )}
    </>
  );
}
