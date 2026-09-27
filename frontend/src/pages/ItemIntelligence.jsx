import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Package, Layers3, Copy, AlertTriangle } from 'lucide-react';
import { api } from '../api/client';
import { ConfidenceBadge, Modal, LoadingState, ErrorState, KpiCard } from '../components/common';
import { useRunDashboard } from '../hooks/useRunDashboard';
import RunHeaderBar from '../components/RunHeaderBar';

export default function ItemIntelligence() {
  const { runId } = useParams();
  const navigate = useNavigate();
  const { dashboard } = useRunDashboard(runId);
  const [totalItems, setTotalItems] = useState(null);
  const [clusters, setClusters] = useState(null);
  const [issueCount, setIssueCount] = useState(null);
  const [conflicts, setConflicts] = useState(null);
  const [error, setError] = useState(null);
  const [detail, setDetail] = useState(null);

  useEffect(() => {
    api.getRunRecords(runId, { record_kind: 'item', page_size: 1 }).then(res => setTotalItems(res.total)).catch(e => setError(e.message));
    api.getClusters(runId, { kind: 'item', page_size: 100 }).then(res => setClusters(res.clusters)).catch(e => setError(e.message));
    api.getIssues(runId, { record_kind: 'item', page_size: 1 }).then(res => setIssueCount(res.total)).catch(e => setError(e.message));
    api.getConflicts(runId).then(res => setConflicts(res.conflicts.filter(c => c.conflict_type === 'material_code_description'))).catch(() => setConflicts([]));
  }, [runId]);

  async function openDetail(cluster) {
    const res = await api.getClusterDetail(runId, cluster.id);
    setDetail(res);
  }

  if (error) return <ErrorState message={error} />;

  const duplicateItemRecords = clusters?.reduce((sum, c) => sum + c.record_count, 0) || 0;

  return (
    <div>
      {dashboard && <RunHeaderBar dashboard={dashboard} title="Item / Material Intelligence" subtitle="Item-code and material-master duplicate and quality analysis." />}

      <div className="kpi-grid">
        <KpiCard icon={Package} tone="blue" label="Total Items" value={totalItems === null ? '—' : totalItems.toLocaleString()}
          sub="Records classified as item/material" />
        <KpiCard icon={Layers3} tone="purple" label="Item Clusters" value={clusters === null ? '—' : clusters.length}
          sub="Groups of records believed to be the same material" />
        <KpiCard icon={Copy} tone="amber" label="Records in a Duplicate Cluster" value={duplicateItemRecords.toLocaleString()}
          sub='e.g. "Steel Sheet 2mm" vs "2mm Steel Sheet"' />
        <KpiCard icon={AlertTriangle} tone="red" label="Item Data-Quality Issues" value={issueCount === null ? '—' : issueCount.toLocaleString()}
          sub="Missing, invalid, or inconsistent item fields" onClick={() => navigate(`/runs/${runId}/issues?record_kind=item`)} />
      </div>

      {conflicts && conflicts.length > 0 && (
        <div className="panel mb-4">
          <div className="panel-title"><span>Material code / description conflicts</span><span className="text-tertiary text-sm">{conflicts.length}</span></div>
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>Code</th><th>Affected records</th><th>Severity</th><th></th></tr></thead>
              <tbody>
                {conflicts.map(cf => (
                  <tr key={cf.id}>
                    <td className="mono">{cf.subject_value}</td>
                    <td>{cf.members.map(m => m.name || m.business_key || m.source_row_id).join(', ')}</td>
                    <td><span className="badge badge-medium">{cf.severity}</span></td>
                    <td><button className="btn btn-ghost btn-sm" onClick={() => navigate(`/runs/${runId}/issues?search=${encodeURIComponent(cf.subject_value)}`)}>View</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="panel">
        <div className="panel-title">
          <span>Item Duplicate Clusters</span>
          <span className="text-tertiary text-sm">{clusters?.length ?? 0}</span>
        </div>
        {clusters === null ? (
          <LoadingState label="Loading item clusters…" />
        ) : clusters.length === 0 ? (
          <div className="text-secondary text-sm">No duplicate item/material codes or descriptions were detected.</div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>Description</th><th>Records</th><th>Confidence</th><th>Type</th><th>Matched because</th><th></th></tr></thead>
              <tbody>
                {clusters.map(c => (
                  <tr key={c.id} className="clickable" onClick={() => openDetail(c)}>
                    <td style={{ fontWeight: 500 }}>{c.representative_name}</td>
                    <td>{c.record_count}</td>
                    <td><ConfidenceBadge confidence={c.confidence} /></td>
                    <td><span className="badge badge-medium" title="S5 material matching is always review-only; nothing is auto-confirmed">Candidate — needs review</span></td>
                    <td className="text-sm text-secondary">{c.matching_factors.join(', ')}</td>
                    <td><span className="text-secondary text-sm">Inspect &rarr;</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {detail && (
        <Modal title={detail.cluster.representative_name} onClose={() => setDetail(null)} width={720}>
          <div className="flex gap-2 mb-4">
            <ConfidenceBadge confidence={detail.cluster.confidence} />
            <span className="badge badge-neutral">{detail.members.length} records</span>
          </div>
          <div className="mb-4">
            <div className="text-secondary text-sm mb-2">Matched because</div>
            <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
              {detail.cluster.matching_factors.map((f, i) => <span key={i} className="badge badge-success">✓ {f}</span>)}
            </div>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>Row</th><th>Data</th><th></th></tr></thead>
              <tbody>
                {detail.members.map(m => (
                  <tr key={m.id}>
                    <td className="mono">#{m.source_row_ref}</td>
                    <td>{Object.entries(m.raw).map(([k, v]) => (
                      <div key={k} className="text-sm"><span className="text-tertiary">{k}:</span> {String(v ?? '—')}</div>
                    ))}</td>
                    <td><button className="btn btn-ghost btn-sm" onClick={() => navigate(`/records/${m.id}`)}>Open</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Modal>
      )}
    </div>
  );
}
