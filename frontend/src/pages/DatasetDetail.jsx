import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { Modal } from '../components/common';
import ProcessingStages from '../components/ProcessingStages';
import WorkflowStepper from '../components/WorkflowStepper';
import { useRunContext } from '../context/RunContext';

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function DatasetDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { setCurrent } = useRunContext();
  const [dataset, setDataset] = useState(null);
  const [files, setFiles] = useState([]);
  const [runs, setRuns] = useState([]);
  const [latestDashboard, setLatestDashboard] = useState(null);
  const [error, setError] = useState(null);
  const [dragActive, setDragActive] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [sheetModal, setSheetModal] = useState(null); // { fileId, sheets }
  const [selectedSheets, setSelectedSheets] = useState([]);
  const [activeRunId, setActiveRunId] = useState(null);
  const [activeRun, setActiveRun] = useState(null);
  const [pipelineStatus, setPipelineStatus] = useState(null);
  const fileInputRef = useRef(null);
  const pollRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const res = await api.getDataset(id);
      setDataset(res.dataset);
      setFiles(res.files);
      setRuns(res.runs);
      const latestComplete = res.runs.find(r => r.status === 'complete');
      if (latestComplete) {
        api.getDashboard(latestComplete.id).then(setLatestDashboard).catch(() => {});
      }
    } catch (e) { setError(e.message); }
    try { setPipelineStatus(await api.getDatasetStatus(id)); } catch (_) { /* status is best-effort */ }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!activeRunId) return;
    const poll = async () => {
      try {
        const res = await api.getRun(activeRunId);
        setActiveRun(res.run);
        if (res.run.status === 'complete' || res.run.status === 'failed') {
          clearInterval(pollRef.current);
          load();
        }
      } catch (e) { /* ignore transient poll errors */ }
    };
    poll();
    pollRef.current = setInterval(poll, 1200);
    return () => clearInterval(pollRef.current);
  }, [activeRunId, load]);

  async function handleFiles(fileList) {
    if (!fileList || fileList.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      for (const file of fileList) {
        const formData = new FormData();
        formData.append('file', file);
        const res = await api.uploadFile(id, formData);
        if (res.requires_sheet_selection) {
          setSheetModal({ fileId: res.file_id, sheets: res.sheets });
          setSelectedSheets([res.sheets[0]]);
        }
      }
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setUploading(false);
    }
  }

  async function confirmSheetSelection() {
    if (!sheetModal) return;
    try {
      await api.selectSheets(id, sheetModal.fileId, selectedSheets);
      setSheetModal(null);
      await load();
    } catch (e) {
      setError(e.message);
    }
  }

  async function handleDelete(fileId) {
    try {
      await api.deleteFile(id, fileId);
      await load();
    } catch (e) { setError(e.message); }
  }

  async function startAnalysis() {
    try {
      // The real gate: block on genuinely unresolved schema review (dataset type or a high-risk column still open) rather
      // than silently auto-accepting the classifier's own uncertain guess, which api.analyzeDataset's default (no
      // require_manual_review) would otherwise do for convenience.
      const res = await api.analyzeDatasetGated(id);
      setActiveRunId(res.run_id);
      setActiveRun({ status: 'queued', progress_pct: 0, current_stage: 'Queued' });
    } catch (e) {
      if (e.unresolved !== undefined || (e.message || '').includes('review')) { await load(); return; }
      setError(e.message);
    }
  }

  function openAnalysis(runId) {
    if (!dataset) return;
    setCurrent(runId, dataset.id, dataset.name);
    navigate(`/runs/${runId}/overview`);
  }

  // A file's ROW STATUS ('uploaded' | 'awaiting_sheet_selection' | 'parsed' | 'failed') tracks the raw-upload/parse
  // stage, not the ingestion outcome. Canonical ingest (S2) runs synchronously at upload time, so a successfully
  // ingested file already shows status 'parsed' by the time this list is fetched -- readiness for analysis must be
  // read from ingest_status ('ingested' | 'failed' | 'not_ingested'), the same field the backend's own
  // ensureConfirmedMappings gate already uses.
  const readyFiles = files.filter(f => f.ingest_status === 'ingested');
  const pendingSheetFiles = files.filter(f => f.status === 'awaiting_sheet_selection');
  const analysisInProgress = activeRunId && activeRun && activeRun.status !== 'complete' && activeRun.status !== 'failed';
  const latestCompleteRun = runs.find(r => r.status === 'complete');

  return (
    <div>
      <button className="btn btn-ghost btn-sm mb-2" onClick={() => navigate('/')}>&larr; All datasets</button>

      {dataset && (
        <>
          <WorkflowStepper hasFiles={files.length > 0} activeRun={activeRun} hasCompletedRun={!!latestCompleteRun} />
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 style={{ margin: 0, fontSize: "inherit", fontWeight: "inherit" }}>{dataset.name}</h1>
              {dataset.description && <div className="text-secondary text-sm">{dataset.description}</div>}
            </div>
            {latestCompleteRun && (
              <button className="btn btn-primary" onClick={() => openAnalysis(latestCompleteRun.id)}>Open Analysis &rarr;</button>
            )}
          </div>

          {/* ---- Dataset Intelligence summary ---- */}
          <div className="panel mb-4">
            <div className="dataset-intel-grid">
              <IntelStat label="Source files" value={files.length} />
              <IntelStat label="Records" value={latestDashboard ? latestDashboard.summary.records_analyzed.toLocaleString() : '—'} />
              <IntelStat label="Columns" value={latestDashboard ? latestDashboard.field_profiles.length : '—'} />
              <IntelStat label="Analysis" value={latestCompleteRun ? 'Completed' : (activeRun ? activeRun.status : 'Not yet run')} />
              <IntelStat label="Health" value={latestDashboard ? latestDashboard.summary.health_score : '—'}
                tone={latestDashboard && latestDashboard.summary.health_score < 60 ? 'critical' : undefined} />
            </div>
            {latestCompleteRun && latestDashboard && (
              <div className="dataset-intel-detail-row">
                <DetailItem label="Last analyzed" value={latestCompleteRun.finished_at || latestCompleteRun.started_at} />
                <DetailItem label="Issues found" value={latestDashboard.summary.total_issues.toLocaleString()} />
                <DetailItem label="Duplicates" value={latestDashboard.summary.potential_duplicate_records.toLocaleString()} />
                <DetailItem label="Conflicts" value={latestDashboard.summary.conflicts.toLocaleString()} />
                <DetailItem label="Stale records" value={latestDashboard.summary.stale_records.toLocaleString()} />
              </div>
            )}
          </div>
        </>
      )}

      {error && <div className="panel mb-4" style={{ color: 'var(--sev-critical)' }}>{error}</div>}

      <div className="grid-2 mb-4">
        <div className="panel">
          <div className="panel-title">Upload Data</div>
          <div
            className={`dropzone ${dragActive ? 'active' : ''}`}
            onClick={() => fileInputRef.current?.click()}
            onDragOver={e => { e.preventDefault(); setDragActive(true); }}
            onDragLeave={() => setDragActive(false)}
            onDrop={e => { e.preventDefault(); setDragActive(false); handleFiles(e.dataTransfer.files); }}
          >
            <div style={{ fontSize: 28, marginBottom: 8 }}>&#8593;</div>
            <div>{uploading ? 'Uploading…' : 'Drag & drop .xlsx or .csv files here, or click to browse'}</div>
            <div className="text-tertiary text-sm mt-2">Multiple files and multi-sheet workbooks are supported.</div>
          </div>
          <input ref={fileInputRef} type="file" multiple accept=".xlsx,.xls,.csv" style={{ display: 'none' }}
            onChange={e => handleFiles(e.target.files)} />

          {pendingSheetFiles.length > 0 && (
            <div className="mt-2 text-sm" style={{ color: 'var(--sev-medium)' }}>
              {pendingSheetFiles.length} file(s) need sheet selection before analysis.
              <button className="btn btn-sm btn-ghost" style={{ marginLeft: 8 }}
                onClick={() => setSheetModal({ fileId: pendingSheetFiles[0].id, sheets: null })}>
                Resolve
              </button>
            </div>
          )}
        </div>

        <div className="panel">
          <div className="panel-title">Source Files</div>
          {files.length === 0 ? (
            <div className="text-secondary text-sm">No files uploaded yet.</div>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead><tr><th>File</th><th>Sheet</th><th>Size</th><th>Rows</th><th>Status</th><th></th></tr></thead>
                <tbody>
                  {files.map(f => (
                    <tr key={f.id}>
                      <td>{f.original_filename}</td>
                      <td className="mono">{f.sheet_name || '—'}</td>
                      <td className="text-sm text-secondary">{formatBytes(f.file_size_bytes)}</td>
                      <td>{f.row_count ?? '—'}</td>
                      <td><span className={`badge ${f.ingest_status === 'ingested' ? 'badge-success' : (f.ingest_status === 'failed' || f.status === 'failed') ? 'badge-critical' : 'badge-medium'}`}>{f.status}</span></td>
                      <td><button className="btn btn-ghost btn-sm" onClick={() => handleDelete(f.id)}>Remove</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {pipelineStatus && pipelineStatus.status === 'review_required' && (
            <div className="mb-2" style={{ background: 'var(--sev-medium-tint)', border: '1px solid var(--sev-medium)', borderRadius: 'var(--radius-md)', padding: 'var(--space-4)' }}>
              <div style={{ fontWeight: 600, color: 'var(--sev-medium)', marginBottom: 4 }}>Schema review is required before analysis can start</div>
              <div className="flex flex-col gap-2">
                {pipelineStatus.files.filter(f => f.status === 'review_required').map(f => (
                  <div key={f.id} className="flex items-center justify-between gap-3" style={{ flexWrap: 'wrap' }}>
                    <span className="text-secondary text-sm">
                      {f.original_filename}{f.reason ? ` — ${f.reason}` : ''}
                    </span>
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => navigate(`/schema-review/${f.id}?dataset=${id}`)}
                    >
                      Review Schema &rarr;
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
          <button className="btn btn-primary mt-2" disabled={readyFiles.length === 0 || analysisInProgress || (pipelineStatus && pipelineStatus.status === 'review_required')} onClick={startAnalysis}>
            Start analysis ({readyFiles.length} file(s) ready)
          </button>
        </div>
      </div>

      {activeRun && (
        <div className="panel mb-4">
          <div className="panel-title">Current Analysis Run</div>
          <ProcessingStages currentStage={activeRun.current_stage} progressPct={activeRun.progress_pct} status={activeRun.status} />
          {activeRun.status === 'complete' && (
            <button className="btn btn-primary mt-2" onClick={() => openAnalysis(activeRunId)}>Open Analysis &rarr;</button>
          )}
          {activeRun.status === 'failed' && (
            <div className="text-sm mt-2" style={{ color: 'var(--sev-critical)' }}>{activeRun.error_message}</div>
          )}
        </div>
      )}

      <div className="panel">
        <div className="panel-title">Analysis History</div>
        {runs.length === 0 ? (
          <div className="text-secondary text-sm">No analysis runs yet.</div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>Started</th><th>Status</th><th>Records</th><th>Health Score</th><th></th></tr></thead>
              <tbody>
                {runs.map(r => (
                  <tr key={r.id} className={r.status === 'complete' ? 'clickable' : ''} onClick={() => r.status === 'complete' && openAnalysis(r.id)}>
                    <td>{r.started_at}</td>
                    <td><span className={`badge ${r.status === 'complete' ? 'badge-success' : r.status === 'failed' ? 'badge-critical' : 'badge-signal'}`}>{r.status}</span></td>
                    <td>{r.records_analyzed ?? '—'}</td>
                    <td>{r.health_score ?? '—'}</td>
                    <td>{r.status === 'complete' && <span className="text-secondary text-sm">Open &rarr;</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {sheetModal && (
        <Modal title="Select sheet(s) to import" onClose={() => setSheetModal(null)}>
          {sheetModal.sheets ? (
            <>
              <p className="text-secondary text-sm">This workbook has multiple sheets. Select which to include as separate data sources.</p>
              {sheetModal.sheets.map(s => (
                <label key={s} className="flex items-center gap-2 mb-2">
                  <input type="checkbox" checked={selectedSheets.includes(s)}
                    onChange={e => setSelectedSheets(prev => e.target.checked ? [...prev, s] : prev.filter(x => x !== s))} />
                  {s}
                </label>
              ))}
              <button className="btn btn-primary mt-2" onClick={confirmSheetSelection} disabled={selectedSheets.length === 0}>Confirm selection</button>
            </>
          ) : (
            <p className="text-secondary text-sm">Loading sheet list…</p>
          )}
        </Modal>
      )}
    </div>
  );
}

function IntelStat({ label, value, tone }) {
  return (
    <div>
      <div className="text-tertiary text-sm">{label}</div>
      <div style={{ fontSize: 22, fontWeight: 600, color: tone === 'critical' ? 'var(--sev-critical)' : 'var(--text-primary)' }}>{value}</div>
    </div>
  );
}

function DetailItem({ label, value }) {
  return (
    <div>
      <div className="text-tertiary text-sm">{label}</div>
      <div style={{ fontSize: 13, fontWeight: 500 }}>{value}</div>
    </div>
  );
}
