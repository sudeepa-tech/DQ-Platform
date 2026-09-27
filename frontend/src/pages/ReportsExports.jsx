import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api/client';
import { LoadingState } from '../components/common';
import { useRunDashboard } from '../hooks/useRunDashboard';
import RunHeaderBar from '../components/RunHeaderBar';

const EXPORT_TYPES = [
  { value: 'full_analysis', label: 'Complete analysis report (all sections)', formats: ['xlsx', 'json'] },
  { value: 'issues', label: 'Data-quality issues', formats: ['xlsx', 'csv', 'json'] },
  { value: 'duplicates', label: 'Duplicate groups / entity clusters', formats: ['xlsx', 'csv', 'json'] },
  { value: 'conflicts', label: 'Cross-field conflicts', formats: ['xlsx', 'csv', 'json'] },
  { value: 'missing', label: 'Missing / incomplete data', formats: ['xlsx', 'csv', 'json'] },
  { value: 'invalid', label: 'Invalid data', formats: ['xlsx', 'csv', 'json'] },
  { value: 'stale', label: 'Stale records', formats: ['xlsx', 'csv', 'json'] },
  { value: 'normalized', label: 'Normalized / standardized data', formats: ['xlsx', 'csv', 'json'] },
  { value: 'summary', label: 'Summary report', formats: ['xlsx', 'csv', 'json'] }
];

export default function ReportsExports() {
  const { runId } = useParams();
  const { dashboard } = useRunDashboard(runId);
  const [type, setType] = useState('full_analysis');
  const [format, setFormat] = useState('xlsx');
  const [generating, setGenerating] = useState(false);
  const [history, setHistory] = useState(null);
  const [error, setError] = useState(null);

  const availableFormats = EXPORT_TYPES.find(t => t.value === type)?.formats || ['xlsx'];

  function loadHistory() {
    api.getRunExports(runId).then(res => setHistory(res.exports)).catch(e => setError(e.message));
  }
  useEffect(() => { loadHistory(); }, [runId]);

  async function handleGenerate() {
    setGenerating(true);
    setError(null);
    try {
      await api.createExport(runId, type, availableFormats.includes(format) ? format : availableFormats[0]);
      loadHistory();
    } catch (e) {
      setError(e.message);
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div>
      {dashboard && <RunHeaderBar dashboard={dashboard} title="Reports & Exports" subtitle="Generate actionable, traceable outputs from this analysis run." />}

      <div className="grid-2">
        <div className="panel">
          <div className="panel-title">Generate Report</div>
          <div className="field">
            <label className="field-label">What to export</label>
            <select className="input" value={type} onChange={e => { setType(e.target.value); setFormat(EXPORT_TYPES.find(t => t.value === e.target.value).formats[0]); }}>
              {EXPORT_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          <div className="field">
            <label className="field-label">Format</label>
            <select className="input" value={format} onChange={e => setFormat(e.target.value)}>
              {availableFormats.map(f => <option key={f} value={f}>{f.toUpperCase()}</option>)}
            </select>
          </div>
          {error && <div className="text-sm mb-2" style={{ color: 'var(--sev-critical)' }}>{error}</div>}
          <button className="btn btn-primary" onClick={handleGenerate} disabled={generating}>
            {generating ? 'Generating…' : 'Generate report'}
          </button>
          <p className="text-tertiary text-sm mt-2">
            Every exported row preserves its original source file, sheet, and row reference for traceability.
            Text fields are automatically sanitized against spreadsheet formula injection.
          </p>
        </div>

        <div className="panel">
          <div className="panel-title">
            <span>Report History</span>
            <span className="text-tertiary text-sm">This analysis run</span>
          </div>
          {history === null ? (
            <LoadingState label="Loading history…" />
          ) : history.length === 0 ? (
            <div className="text-secondary text-sm">Generated exports will appear here with a download link.</div>
          ) : (
            <div className="flex flex-col gap-2">
              {history.map(h => (
                <div key={h.id} className="flex items-center justify-between" style={{ padding: '8px 0', borderBottom: '1px solid var(--border-subtle)' }}>
                  <div>
                    <div style={{ fontSize: 13 }}>{EXPORT_TYPES.find(t => t.value === h.export_type)?.label || h.export_type.replace(/_/g, ' ')}</div>
                    <div className="text-tertiary text-sm">{h.format.toUpperCase()} · generated {h.created_at}</div>
                  </div>
                  <button className="btn btn-sm btn-ghost" onClick={() => api.downloadExport(h.id, `${h.export_type}.${h.format}`)}>
                    Download
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
