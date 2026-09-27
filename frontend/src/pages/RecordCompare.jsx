import { useEffect, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { LoadingState, ErrorState } from '../components/common';

export default function RecordCompare() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const aId = searchParams.get('a');
  const bId = searchParams.get('b');
  const [dataA, setDataA] = useState(null);
  const [dataB, setDataB] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!aId || !bId) { setError('Two records must be specified to compare.'); return; }
    Promise.all([api.getRecord(aId), api.getRecord(bId)])
      .then(([a, b]) => { setDataA(a); setDataB(b); })
      .catch(e => setError(e.message));
  }, [aId, bId]);

  if (error) return <ErrorState message={error} />;
  if (!dataA || !dataB) return <LoadingState label="Loading records for comparison…" />;

  const recordA = dataA.record, recordB = dataB.record;
  const allFields = [...new Set([...Object.keys(recordA.raw), ...Object.keys(recordB.raw)])];

  // Find the specific match_pair evidence between exactly these two records,
  // if one exists, so "why this was flagged" is the engine's real reasoning
  // and not a re-derivation.
  const pair = [...dataA.match_pairs, ...dataB.match_pairs].find(
    p => (p.record_a_id === recordA.id && p.record_b_id === recordB.id) || (p.record_a_id === recordB.id && p.record_b_id === recordA.id)
  );

  return (
    <div>
      <button className="btn btn-ghost btn-sm mb-2" onClick={() => navigate(-1)}>&larr; Back</button>
      <h2 style={{ margin: '0 0 4px 0' }}>Record Comparison</h2>
      <div className="text-tertiary text-sm mb-4">
        Row #{recordA.source_row_ref} vs Row #{recordB.source_row_ref}
      </div>

      {pair && (
        <div className="panel mb-4">
          <div className="panel-title">Why This Was Flagged</div>
          <div className="flex gap-2 mb-2" style={{ flexWrap: 'wrap' }}>
            <span className="badge badge-signal">{Math.round(pair.confidence * 100)}% confidence</span>
            <span className="badge badge-neutral" style={{ textTransform: 'capitalize' }}>{pair.match_type.replace(/_/g, ' ')} match</span>
          </div>
          {pair.matching_factors.length > 0 && (
            <div className="mb-2">
              <div className="text-secondary text-sm mb-1">Matching evidence</div>
              <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
                {pair.matching_factors.map((f, i) => <span key={i} className="badge badge-success">✓ {f}</span>)}
              </div>
            </div>
          )}
          {pair.conflicting_factors.length > 0 && (
            <div>
              <div className="text-secondary text-sm mb-1">Conflicting evidence</div>
              <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
                {pair.conflicting_factors.map((f, i) => <span key={i} className="badge badge-high">{f}</span>)}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="panel">
        <div className="panel-title">Field-by-Field Comparison</div>
        <div className="table-wrap">
          <table className="data-table compare-table">
            <thead>
              <tr>
                <th>Field</th>
                <th>Record A <span className="text-tertiary">(#{recordA.source_row_ref})</span></th>
                <th>Record B <span className="text-tertiary">(#{recordB.source_row_ref})</span></th>
              </tr>
            </thead>
            <tbody>
              {allFields.map(field => {
                const va = recordA.raw[field];
                const vb = recordB.raw[field];
                const sa = normalize(va), sb = normalize(vb);
                const match = sa && sb && sa === sb;
                const conflict = sa && sb && sa !== sb;
                return (
                  <tr key={field}>
                    <td className="text-secondary">{field}</td>
                    <td className={match ? 'compare-match' : conflict ? 'compare-conflict' : ''}>{va === null || va === undefined || va === '' ? '—' : String(va)}</td>
                    <td className={match ? 'compare-match' : conflict ? 'compare-conflict' : ''}>{vb === null || vb === undefined || vb === '' ? '—' : String(vb)}</td>
                  </tr>
                );
              })}
              <tr>
                <td className="text-secondary">Source file</td>
                <td className="text-sm">{dataA.source_file?.original_filename} {dataA.source_file?.sheet_name ? `(${dataA.source_file.sheet_name})` : ''}</td>
                <td className="text-sm">{dataB.source_file?.original_filename} {dataB.source_file?.sheet_name ? `(${dataB.source_file.sheet_name})` : ''}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="flex gap-2 mt-2">
          <button className="btn btn-ghost btn-sm" onClick={() => navigate(`/records/${recordA.id}`)}>Open Record A</button>
          <button className="btn btn-ghost btn-sm" onClick={() => navigate(`/records/${recordB.id}`)}>Open Record B</button>
        </div>
      </div>
    </div>
  );
}

function normalize(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim().toLowerCase();
}
