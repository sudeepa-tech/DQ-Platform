import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Building2, Users, CheckCircle2, AlertTriangle, Search as SearchIcon } from 'lucide-react';
import { api } from '../api/client';
import { ConfidenceBadge, Modal, LoadingState, ErrorState, KpiCard } from '../components/common';

// Distinguish what S5 already distinguishes -- never a single "exact duplicate" label for everything.
function matchLabel(c) {
  if (c.match_class === 'material_match') return { text: 'Material match candidate', tone: 'badge-signal' };
  if (c.match_subtype === 'identity_match_vendor_code_variant') return { text: 'Entity match (vendor-code variant)', tone: 'badge-medium' };
  let dupTypes = {}; try { dupTypes = JSON.parse(c.composition_json || '{}').dup_types || {}; } catch (_) {}
  const kinds = Object.keys(dupTypes);
  if (kinds.length === 1 && kinds[0] === 'exact_business_duplicate') return { text: 'Exact duplicate', tone: 'badge-neutral' };
  if (kinds.includes('normalized_duplicate') && !kinds.includes('attribute_variant')) return { text: 'Normalized duplicate', tone: 'badge-success' };
  if (kinds.includes('audit_date_variant')) return { text: 'Audit-date variant', tone: 'badge-neutral' };
  return { text: 'Entity match', tone: 'badge-success' };
}
const PAIR_LABEL = { fuzzy_candidate: 'Fuzzy candidate', material_match: 'Material match candidate', transaction_duplicate: 'Transaction duplicate candidate', ambiguous_entity: 'Ambiguous — needs review', entity_match: 'Entity match candidate' };
import { useRunDashboard } from '../hooks/useRunDashboard';
import RunHeaderBar from '../components/RunHeaderBar';

export default function EntityIntelligence() {
  const { runId } = useParams();
  const navigate = useNavigate();
  const { dashboard } = useRunDashboard(runId);
  const [clusters, setClusters] = useState(null);
  const [candidates, setCandidates] = useState(null);
  const [error, setError] = useState(null);
  const [detail, setDetail] = useState(null);
  const [fieldRoles, setFieldRoles] = useState({});
  const [search, setSearch] = useState('');
  const [matchFilter, setMatchFilter] = useState('');

  useEffect(() => {
    api.getClusters(runId, { kind: 'entity', page_size: 100 })
      .then(res => setClusters(res.clusters))
      .catch(e => setError(e.message));
    api.getPairs(runId, { decision: 'candidate', page_size: 100 }).then(res => setCandidates(res.pairs)).catch(() => setCandidates([]));
    api.getFieldProfiles(runId).then(res => {
      const roles = {};
      res.field_profiles.forEach(fp => { roles[fp.column_name] = fp.inferred_role; });
      setFieldRoles(roles);
    });
  }, [runId]);

  async function openDetail(cluster) {
    const res = await api.getClusterDetail(runId, cluster.id);
    setDetail(res);
  }

  const matchTypes = useMemo(() => {
    const set = new Set();
    (clusters || []).forEach(c => set.add(matchLabel(c).text));
    return [...set];
  }, [clusters]);

  const filteredClusters = useMemo(() => {
    if (!clusters) return clusters;
    const needle = search.trim().toLowerCase();
    return clusters.filter(c => {
      if (matchFilter && matchLabel(c).text !== matchFilter) return false;
      if (!needle) return true;
      return c.representative_name?.toLowerCase().includes(needle);
    });
  }, [clusters, search, matchFilter]);

  if (error) return <ErrorState message={error} />;

  const totalRecords = clusters?.reduce((sum, c) => sum + c.record_count, 0) || 0;
  const confirmedCount = clusters?.filter(c => c.review_status === 'confirmed').length || 0;
  const conflictGroupCount = clusters?.filter(c => c.conflicts.length > 0).length || 0;

  return (
    <div>
      {dashboard && <RunHeaderBar dashboard={dashboard} title="Entity Intelligence" subtitle="Understand why records are believed to represent the same — or different — real-world companies." />}

      {clusters !== null && (
        <div className="kpi-grid-secondary mb-4">
          <KpiCard icon={Building2} tone="blue" label="Entity Clusters" value={clusters.length.toLocaleString()} compact />
          <KpiCard icon={Users} tone="purple" label="Total Records" value={totalRecords.toLocaleString()} compact />
          <KpiCard icon={CheckCircle2} tone="green" label="Confirmed Matches" value={confirmedCount.toLocaleString()} compact />
          <KpiCard icon={AlertTriangle} tone="amber" label="Conflict Groups" value={conflictGroupCount.toLocaleString()} compact />
        </div>
      )}

      {candidates && candidates.length > 0 && (
        <div className="panel mb-4">
          <div className="panel-title">
            <span>Candidates awaiting review</span>
            <span className="text-tertiary text-sm">{candidates.length} (never auto-clustered or scored until confirmed)</span>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>Type</th><th>Record A</th><th>Record B</th><th>Why they might match</th></tr></thead>
              <tbody>
                {candidates.map(p => (
                  <tr key={p.id}>
                    <td><span className="badge badge-medium">{PAIR_LABEL[p.pair_class] || p.pair_class}</span></td>
                    <td className="text-sm">{p.a.name || p.a.business_key || p.a.source_row_id}</td>
                    <td className="text-sm">{p.b.name || p.b.business_key || p.b.source_row_id}</td>
                    <td className="text-tertiary text-sm">{p.matching_factors.join(', ') || p.reason_text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="panel">
        <div className="panel-title">
          <span>Companies with Multiple Records</span>
          <span className="text-tertiary text-sm">{filteredClusters?.length ?? 0} of {clusters?.length ?? 0}</span>
        </div>
        {clusters && clusters.length > 0 && (
          <div className="flex gap-3 mb-4" style={{ flexWrap: 'wrap' }}>
            <div className="topbar-search" style={{ maxWidth: 280 }}>
              <SearchIcon size={14} aria-hidden="true" />
              <input aria-label="Search by company name" placeholder="Search by name, GSTIN, PAN…" value={search} onChange={e => setSearch(e.target.value)} />
            </div>
            <select className="input" style={{ width: 200 }} value={matchFilter} onChange={e => setMatchFilter(e.target.value)}>
              <option value="">All match types</option>
              {matchTypes.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
        )}
        {clusters === null ? (
          <LoadingState label="Loading entities…" />
        ) : clusters.length === 0 ? (
          <div className="text-secondary text-sm">No entities with multiple associated records were found in this dataset.</div>
        ) : filteredClusters.length === 0 ? (
          <div className="text-secondary text-sm">No entity clusters match these filters.</div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>Company</th><th>Associated records</th><th>Confidence</th><th>Match type</th><th>Review status</th><th>Conflicts</th><th></th></tr></thead>
              <tbody>
                {filteredClusters.map(c => (
                  <tr key={c.id} className="clickable" onClick={() => openDetail(c)}>
                    <td style={{ fontWeight: 500 }}>{c.representative_name}</td>
                    <td>{c.record_count}</td>
                    <td><ConfidenceBadge confidence={c.confidence} /></td>
                    <td><span className={`badge ${matchLabel(c).tone}`}>{matchLabel(c).text}</span></td>
                    <td><span className={`badge ${c.review_status === 'confirmed' ? 'badge-success' : c.review_status === 'pending' ? 'badge-medium' : 'badge-neutral'}`}>{c.review_status === 'not_required' ? 'auto-accepted' : c.review_status}</span></td>
                    <td style={{ color: c.conflicts.length ? 'var(--sev-high)' : 'var(--text-tertiary)' }}>{c.conflicts.length || '—'}</td>
                    <td><span className="text-secondary text-sm">Inspect &rarr;</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {detail && (
        <EntityDetailModal detail={detail} fieldRoles={fieldRoles} onClose={() => setDetail(null)} navigate={navigate} />
      )}
    </div>
  );
}

function EntityDetailModal({ detail, fieldRoles, onClose, navigate }) {
  const colsByRole = {};
  Object.entries(fieldRoles).forEach(([col, role]) => {
    if (!colsByRole[role]) colsByRole[role] = [];
    colsByRole[role].push(col);
  });

  function distinctValues(role) {
    const cols = colsByRole[role] || [];
    const values = new Set();
    detail.members.forEach(m => cols.forEach(c => { if (m.raw[c]) values.add(String(m.raw[c]).trim().toLowerCase()); }));
    return values;
  }

  const gstins = distinctValues('gstin');
  const addresses = distinctValues('address');
  const phones = distinctValues('phone');
  const emails = distinctValues('email');

  return (
    <Modal title={detail.cluster.representative_name} onClose={onClose} width={760}>
      <div className="grid-3 mb-4">
        <MiniStat label="Associated records" value={detail.members.length} />
        <MiniStat label="Distinct GSTINs" value={gstins.size} warn={gstins.size > 1} />
        <MiniStat label="Distinct addresses" value={addresses.size} warn={addresses.size > 1} />
        <MiniStat label="Distinct phone numbers" value={phones.size} />
        <MiniStat label="Distinct email addresses" value={emails.size} />
        <MiniStat label="Conflicts" value={detail.cluster.conflicts.length} warn={detail.cluster.conflicts.length > 0} />
      </div>

      <div className="mb-4">
        <div className="text-secondary text-sm mb-2">Why these records are believed to be the same entity</div>
        <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
          {detail.cluster.matching_factors.map((f, i) => <span key={i} className="badge badge-success">✓ {f}</span>)}
        </div>
      </div>

      {detail.cluster.conflicts.length > 0 && (
        <div className="mb-4">
          <div className="text-secondary text-sm mb-2">But these fields disagree</div>
          <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
            {detail.cluster.conflicts.map((f, i) => <span key={i} className="badge badge-high">{f}</span>)}
          </div>
        </div>
      )}

      <div className="text-secondary text-sm mb-2">Associated records</div>
      <div className="table-wrap">
        <table className="data-table">
          <thead><tr><th>Row</th><th>Data</th><th></th></tr></thead>
          <tbody>
            {detail.members.map(m => (
              <tr key={m.id}>
                <td className="mono">#{m.source_row_ref}</td>
                <td>{Object.entries(m.raw).slice(0, 5).map(([k, v]) => (
                  <div key={k} className="text-sm"><span className="text-tertiary">{k}:</span> {String(v ?? '—')}</div>
                ))}</td>
                <td><button className="btn btn-ghost btn-sm" onClick={() => navigate(`/records/${m.id}`)}>Open</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}

function MiniStat({ label, value, warn }) {
  return (
    <div className="panel" style={{ padding: 12 }}>
      <div className="text-tertiary text-sm">{label}</div>
      <div style={{ fontSize: 20, fontWeight: 600, color: warn ? 'var(--sev-high)' : 'var(--text-primary)' }}>{value}</div>
    </div>
  );
}
