import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Copy, GitCompareArrows, Sparkles, Layers } from 'lucide-react';
import { api } from '../api/client';
import { ConfidenceBadge, Modal, LoadingState, ErrorState, KpiCard, Pagination } from '../components/common';
import { useRunDashboard } from '../hooks/useRunDashboard';
import RunHeaderBar from '../components/RunHeaderBar';

const MATCH_TYPE_LABELS = {
  exact: { label: 'Exact Duplicates', desc: 'Identical normalized name, no other signal needed.', icon: Copy, tone: 'red' },
  multi_field: { label: 'Probable Matches', desc: 'Name similarity corroborated by a matching identifier (GSTIN, phone, email, or item code).', icon: GitCompareArrows, tone: 'amber' },
  fuzzy: { label: 'Possible Matches', desc: 'Name similarity only — no corroborating identifier found.', icon: Sparkles, tone: 'blue' }
};

export default function DuplicatesMatches() {
  const { runId } = useParams();
  const navigate = useNavigate();
  const { dashboard } = useRunDashboard(runId);
  const [summary, setSummary] = useState(null);
  const [kind, setKind] = useState('');
  const [repeatFilter, setRepeatFilter] = useState('variant'); // 'variant' | 'exact' | ''
  const [clusters, setClusters] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [detail, setDetail] = useState(null);
  const pageSize = 20;

  useEffect(() => { api.getMatchSummary(runId).then(setSummary); }, [runId]);

  useEffect(() => {
    setLoading(true);
    const params = { page, page_size: pageSize };
    if (kind) params.kind = kind;
    if (repeatFilter) params.exact_repeat = repeatFilter === 'exact' ? 'true' : 'false';
    api.getClusters(runId, params)
      .then(res => { setClusters(res.clusters); setTotal(res.total); setError(null); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [runId, kind, repeatFilter, page]);

  async function openDetail(cluster) {
    const res = await api.getClusterDetail(runId, cluster.id);
    setDetail(res);
  }

  if (error) return <ErrorState message={error} />;

  return (
    <div>
      {dashboard && <RunHeaderBar dashboard={dashboard} title="Duplicates & Matches" subtitle="Real duplicate candidates found by the entity resolution engine — nothing is merged automatically." />}

      <div className="kpi-grid">
        {summary?.by_type.map(t => (
          <KpiCard key={t.match_type} icon={MATCH_TYPE_LABELS[t.match_type]?.icon} tone={MATCH_TYPE_LABELS[t.match_type]?.tone || 'blue'}
            label={MATCH_TYPE_LABELS[t.match_type]?.label || t.match_type} value={t.c.toLocaleString()} sub={MATCH_TYPE_LABELS[t.match_type]?.desc} />
        ))}
        <KpiCard icon={Layers} tone="purple" label="Duplicate Clusters" value={summary?.cluster_count ?? '—'}
          sub="Records grouped as the same real-world entity/item" />
      </div>

      <div className="panel mb-4">
        <div className="flex gap-3">
          <select className="input" style={{ width: 220 }} value={kind} onChange={e => { setKind(e.target.value); setPage(1); }}>
            <option value="">All kinds</option>
            <option value="entity">Entities (vendors/customers)</option>
            <option value="item">Items / materials</option>
          </select>
          <select className="input" style={{ width: 300 }} value={repeatFilter} onChange={e => { setRepeatFilter(e.target.value); setPage(1); }}>
            <option value="variant">Needs review (spelling/format variants)</option>
            <option value="exact">Same entity recurring (not a data-quality issue)</option>
            <option value="">Show both</option>
          </select>
        </div>
        {repeatFilter === 'variant' && (
          <p className="text-tertiary text-sm mt-2" style={{ marginBottom: 0 }}>
            Showing only clusters where members differ in spelling or formatting — worth a human's attention.
            A cluster where every member is textually identical (e.g. the same vendor appearing on many transaction
            rows) is expected in transactional data and is filtered out of this default view.
          </p>
        )}
      </div>

      <div className="panel">
        <div className="panel-title">
          <span>Duplicate Clusters</span>
          <span className="text-tertiary text-sm">{total} cluster(s)</span>
        </div>
        {loading ? (
          <LoadingState label="Loading clusters…" />
        ) : clusters.length === 0 ? (
          <div className="text-secondary text-sm">No potential duplicate clusters were detected.</div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>Cluster</th><th>Kind</th><th>Records</th><th>Confidence</th><th>Type</th><th>Matched because</th><th>Conflicts</th><th></th></tr></thead>
              <tbody>
                {clusters.map(c => (
                  <tr key={c.id} className="clickable" onClick={() => openDetail(c)}>
                    <td className="mono text-sm">D-{c.id.slice(0, 6)}</td>
                    <td>
                      <div style={{ fontWeight: 500 }}>{c.representative_name}</div>
                      <div className="text-tertiary text-sm" style={{ textTransform: 'capitalize' }}>{c.cluster_kind}</div>
                    </td>
                    <td>{c.record_count}</td>
                    <td><ConfidenceBadge confidence={c.confidence} /></td>
                    <td>
                      {c.is_exact_repeat
                        ? <span className="badge badge-neutral">Same entity recurring</span>
                        : <span className="badge badge-medium">Variant — review</span>}
                    </td>
                    <td className="text-sm text-secondary">{c.matching_factors.map(f => `✓ ${f}`).join('  ')}</td>
                    <td className="text-sm" style={{ color: c.conflicts.length ? 'var(--sev-high)' : 'var(--text-tertiary)' }}>
                      {c.conflicts.length ? c.conflicts.join(', ') : '—'}
                    </td>
                    <td><span className="text-secondary text-sm">View Records &rarr;</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination page={page} pageSize={pageSize} total={total} onPageChange={setPage} />
      </div>

      {detail && (
        <Modal title={`Cluster D-${detail.cluster.id.slice(0, 6)}: ${detail.cluster.representative_name}`} onClose={() => setDetail(null)} width={760}>
          <div className="flex gap-2 mb-4">
            <ConfidenceBadge confidence={detail.cluster.confidence} />
            <span className="badge badge-neutral">{detail.members.length} records</span>
            <span className="badge badge-neutral" style={{ textTransform: 'capitalize' }}>{detail.cluster.cluster_kind}</span>
            {detail.cluster.is_exact_repeat
              ? <span className="badge badge-neutral">Same entity recurring</span>
              : <span className="badge badge-medium">Variant — review</span>}
          </div>
          <div className="mb-4">
            <div className="text-secondary text-sm mb-2">Matched because</div>
            <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
              {detail.cluster.matching_factors.map((f, i) => <span key={i} className="badge badge-success">✓ {f}</span>)}
            </div>
          </div>
          {detail.cluster.conflicts.length > 0 && (
            <div className="mb-4">
              <div className="text-secondary text-sm mb-2">But conflicts within this cluster</div>
              <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
                {detail.cluster.conflicts.map((f, i) => <span key={i} className="badge badge-high">{f}</span>)}
              </div>
            </div>
          )}
          <div className="text-secondary text-sm mb-2">Member records</div>
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>Row</th><th>Data</th><th></th></tr></thead>
              <tbody>
                {detail.members.map(m => (
                  <tr key={m.id}>
                    <td className="mono">#{m.source_row_ref}</td>
                    <td>
                      {Object.entries(m.raw).slice(0, 5).map(([k, v]) => (
                        <div key={k} className="text-sm"><span className="text-tertiary">{k}:</span> {String(v ?? '—')}</div>
                      ))}
                    </td>
                    <td>
                      <button className="btn btn-ghost btn-sm" onClick={() => navigate(`/records/${m.id}`)}>Open</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {detail.members.length === 2 && (
            <button className="btn btn-primary mt-2" onClick={() => navigate(`/compare?a=${detail.members[0].id}&b=${detail.members[1].id}`)}>
              Compare side by side
            </button>
          )}
        </Modal>
      )}
    </div>
  );
}
