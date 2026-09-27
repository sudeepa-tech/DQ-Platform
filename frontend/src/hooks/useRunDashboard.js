import { useEffect, useState, useCallback } from 'react';
import { api } from '../api/client';

/** Fetches (and can refetch) the dashboard summary for a given run. Shared
 * across every run-scoped screen so the same real data backs the header,
 * the KPI cards, and any per-screen breakdown -- never re-derived or
 * duplicated client-side. */
export function useRunDashboard(runId) {
  const [dashboard, setDashboard] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(() => {
    if (!runId) return;
    setLoading(true);
    api.getDashboard(runId)
      .then(d => { setDashboard(d); setError(null); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [runId]);

  useEffect(() => { reload(); }, [reload]);

  return { dashboard, error, loading, reload };
}
