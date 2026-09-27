import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { LoadingState, ErrorState } from '../components/common';
import { useRunContext } from '../context/RunContext';

export default function AnalysisRuns() {
  const navigate = useNavigate();
  const { setCurrent } = useRunContext();
  const [runs, setRuns] = useState(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState(null);

  useEffect(() => {
    const params = {};
    if (status) params.status = status;
    api.listRuns(params).then(res => setRuns(res.runs)).catch(e => setError(e.message));
  }, [status]);

  if (error) return <ErrorState message={error} />;

  function open(run) {
    if (run.status !== 'complete') return;
    setCurrent(run.id, run.dataset_id, run.dataset_name);
    navigate(`/runs/${run.id}/overview`);
  }

  function duration(run) {
    if (!run.finished_at || !run.started_at) return '—';
    const secs = Math.round((new Date(run.finished_at.replace(' ', 'T') + 'Z') - new Date(run.started_at.replace(' ', 'T') + 'Z')) / 1000);
    if (!isFinite(secs) || secs < 0) return '—';
    if (secs < 60) return `${secs}s`;
    return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 style={{ margin: 0, fontSize: "inherit", fontWeight: "inherit" }}>Analysis Runs</h1>
          <p className="text-secondary text-sm" style={{ marginTop: 4 }}>Full traceability history across every dataset in your organization.</p>
        </div>
        <select className="input" style={{ width: 180 }} value={status} onChange={e => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          <option value="complete">Complete</option>
          <option value="failed">Failed</option>
          <option value="queued">Queued</option>
          <option value="matching">In progress</option>
        </select>
      </div>

      <div className="panel">
        {runs === null ? (
          <LoadingState label="Loading analysis runs…" />
        ) : runs.length === 0 ? (
          <div className="text-secondary text-sm">No analysis runs yet. Upload a dataset and start an analysis to see history here.</div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Run ID</th><th>Dataset</th><th>Started</th><th>Completed</th>
                  <th>Records</th><th>Duration</th><th>Health Score</th><th>Issues</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {runs.map(r => (
                  <tr key={r.id} className={r.status === 'complete' ? 'clickable' : ''} onClick={() => open(r)}>
                    <td className="mono text-sm">{r.id.slice(0, 8)}</td>
                    <td>{r.dataset_name}</td>
                    <td className="text-sm">{r.started_at}</td>
                    <td className="text-sm">{r.finished_at || '—'}</td>
                    <td>{r.records_analyzed ?? '—'}</td>
                    <td className="text-sm">{duration(r)}</td>
                    <td>{r.health_score ?? '—'}</td>
                    <td>{r.issue_count}</td>
                    <td>
                      <span className={`badge ${r.status === 'complete' ? 'badge-success' : r.status === 'failed' ? 'badge-critical' : 'badge-signal'}`}>
                        {r.status}
                      </span>
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
