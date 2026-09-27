import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Database, Search as SearchIcon } from 'lucide-react';
import { api } from '../api/client';
import { HealthGauge } from '../components/common';

export default function DatasetsList() {
  const [datasets, setDatasets] = useState(null);
  const [error, setError] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const q = searchParams.get('q') || '';

  async function load() {
    try {
      const res = await api.listDatasets();
      setDatasets(res.datasets);
    } catch (e) {
      setError(e.message);
    }
  }

  useEffect(() => { load(); }, []);

  const filteredDatasets = useMemo(() => {
    if (!datasets) return datasets;
    if (!q.trim()) return datasets;
    const needle = q.trim().toLowerCase();
    return datasets.filter(ds =>
      ds.name?.toLowerCase().includes(needle) || ds.description?.toLowerCase().includes(needle)
    );
  }, [datasets, q]);

  async function handleCreate(e) {
    e.preventDefault();
    setCreating(true);
    try {
      const res = await api.createDataset({ name, description });
      navigate(`/datasets/${res.dataset.id}`);
    } catch (e) {
      setError(e.message);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 style={{ margin: 0, fontSize: "inherit", fontWeight: "inherit" }}>Datasets</h1>
          <p className="text-secondary text-sm" style={{ marginTop: 4 }}>
            Upload SAP/ERP exports and run data-quality intelligence against them.
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowCreate(true)}>+ New dataset</button>
      </div>

      <div className="flex gap-2 mb-4" style={{ maxWidth: 360 }}>
        <div className="topbar-search" style={{ maxWidth: 'none' }}>
          <SearchIcon size={14} aria-hidden="true" />
          <input
            aria-label="Search datasets"
            placeholder="Search datasets by name or description…"
            value={q}
            onChange={e => setSearchParams(e.target.value ? { q: e.target.value } : {}, { replace: true })}
          />
        </div>
      </div>

      {error && <div className="panel mb-4" style={{ color: 'var(--sev-critical)' }}>{error}</div>}

      {showCreate && (
        <div className="panel mb-4">
          <form onSubmit={handleCreate}>
            <div className="grid-2">
              <div className="field">
                <label className="field-label">Dataset name</label>
                <input className="input" value={name} onChange={e => setName(e.target.value)} required placeholder="e.g. Vendor Master — Q3 SAP Export" />
              </div>
              <div className="field">
                <label className="field-label">Description (optional)</label>
                <input className="input" value={description} onChange={e => setDescription(e.target.value)} />
              </div>
            </div>
            <div className="flex gap-2">
              <button className="btn btn-primary" disabled={creating}>{creating ? 'Creating…' : 'Create dataset'}</button>
              <button type="button" className="btn btn-ghost" onClick={() => setShowCreate(false)}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      {datasets === null ? (
        <div className="panel text-secondary">Loading datasets…</div>
      ) : datasets.length === 0 ? (
        <div className="panel state-block">
          <div className="state-title">No datasets yet</div>
          <div className="text-sm">Create a dataset and upload a SAP/ERP export (.xlsx or .csv) to begin.</div>
        </div>
      ) : filteredDatasets.length === 0 ? (
        <div className="panel state-block">
          <div className="state-title">No datasets match "{q}"</div>
          <div className="text-sm">Try a different name, or <span className="hero-link" style={{ cursor: 'pointer' }} onClick={() => setSearchParams({}, { replace: true })}>clear the search</span>.</div>
        </div>
      ) : (
        <div className="grid-3">
          {filteredDatasets.map(ds => (
            <div key={ds.id} className="panel kpi-clickable" style={{ cursor: 'pointer' }} onClick={() => navigate(`/datasets/${ds.id}`)}>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-3" style={{ minWidth: 0 }}>
                  <div className="kpi-icon-tile kpi-icon-blue"><Database size={16} strokeWidth={2} aria-hidden="true" /></div>
                  <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ds.name}</div>
                </div>
                {ds.latest_health_score !== null && ds.latest_health_score !== undefined && (
                  <HealthGauge score={ds.latest_health_score} size={48} />
                )}
              </div>
              {ds.description && <div className="text-secondary text-sm mb-2">{ds.description}</div>}
              <div className="text-tertiary text-sm">{ds.file_count} file(s)</div>
              {ds.latest_run_status && (
                <div className="mt-2">
                  <span className={`badge ${ds.latest_run_status === 'complete' ? 'badge-success' : ds.latest_run_status === 'failed' ? 'badge-critical' : 'badge-signal'}`}>
                    {ds.latest_run_status}
                  </span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
