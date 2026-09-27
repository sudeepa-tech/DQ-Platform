import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { SeverityBadge, LoadingState, ErrorState } from '../components/common';

export default function RecordDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => { api.getRecord(id).then(setData).catch(e => setError(e.message)); }, [id]);

  if (error) return <ErrorState message={error} />;
  if (!data) return <LoadingState label="Loading record…" />;

  const { record, source_file, issues, related_records, match_pairs, age_years, years_since_modification } = data;

  return (
    <div>
      <button className="btn btn-ghost btn-sm mb-2" onClick={() => navigate(-1)}>&larr; Back</button>
      <h1 style={{ margin: "0 0 4px 0", fontSize: "inherit", fontWeight: "inherit" }}>{record.primary_name || 'Unnamed record'}</h1>
      <div className="text-tertiary text-sm mb-4">
        Row #{record.source_row_ref} · {source_file?.original_filename} {source_file?.sheet_name ? `(${source_file.sheet_name})` : ''} · Analysis run {record.run_id.slice(0, 8)}
      </div>

      <div className="grid-2 mb-4">
        <div className="panel">
          <div className="panel-title">Original Source Data</div>
          <KeyValueTable data={record.raw} />
        </div>
        <div className="panel">
          <div className="panel-title">Record Metadata</div>
          <div className="text-sm flex flex-col gap-2">
            <MetaRow label="Record kind" value={record.record_kind} />
            <MetaRow label="Created date" value={record.created_date ? record.created_date.slice(0, 10) : 'Not detected'} />
            <MetaRow label="Last modified" value={record.modified_date ? record.modified_date.slice(0, 10) : 'Not detected'} />
            <MetaRow label="Age" value={age_years !== null ? `${age_years.toFixed(1)} years` : '—'} />
            <MetaRow label="Time since modification" value={years_since_modification !== null ? `${years_since_modification.toFixed(1)} years` : '—'} />
            <MetaRow label="Source row reference" value={`#${record.source_row_ref}`} />
          </div>
        </div>
      </div>

      <div className="panel mb-4">
        <div className="panel-title">
          <span>Detected Issues</span>
          <span className="text-tertiary text-sm">{issues.length}</span>
        </div>
        {issues.length === 0 ? (
          <div className="text-secondary text-sm">No data-quality issues were detected for this record.</div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>Severity</th><th>Category</th><th>Field</th><th>Explanation</th><th>Detection method</th></tr></thead>
              <tbody>
                {issues.map(i => (
                  <tr key={i.id}>
                    <td><SeverityBadge severity={i.severity} /></td>
                    <td className="text-secondary" style={{ textTransform: 'capitalize' }}>{i.category}</td>
                    <td className="mono text-sm">{i.field_name || '—'}</td>
                    <td>{i.explanation}</td>
                    <td className="text-tertiary text-sm">{i.detection_method}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel">
        <div className="panel-title">
          <span>Potential Duplicates / Related Records</span>
          <span className="text-tertiary text-sm">{related_records.length}</span>
        </div>
        {related_records.length === 0 ? (
          <div className="text-secondary text-sm">No related records were found in the same duplicate cluster.</div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>Record</th><th>Row</th><th>Match evidence</th><th></th></tr></thead>
              <tbody>
                {related_records.map(r => {
                  const pair = match_pairs.find(p => p.record_a_id === r.id || p.record_b_id === r.id);
                  return (
                    <tr key={r.id}>
                      <td>{r.primary_name}</td>
                      <td className="mono">#{r.source_row_ref}</td>
                      <td className="text-sm text-secondary">{pair ? pair.matching_factors.join(', ') : '—'}</td>
                      <td><button className="btn btn-ghost btn-sm" onClick={() => navigate(`/records/${r.id}`)}>View</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function KeyValueTable({ data }) {
  return (
    <div className="flex flex-col gap-2 text-sm">
      {Object.entries(data).map(([k, v]) => (
        <div key={k} className="flex justify-between gap-3" style={{ borderBottom: '1px solid var(--border-subtle)', paddingBottom: 6 }}>
          <span className="text-tertiary">{k}</span>
          <span className="mono" style={{ textAlign: 'right' }}>{v === null || v === undefined || v === '' ? '—' : String(v)}</span>
        </div>
      ))}
    </div>
  );
}

function MetaRow({ label, value }) {
  return (
    <div className="flex justify-between">
      <span className="text-tertiary">{label}</span>
      <span>{value}</span>
    </div>
  );
}
