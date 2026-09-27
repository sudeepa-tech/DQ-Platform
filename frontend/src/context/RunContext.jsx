import { createContext, useContext, useState, useCallback, useEffect } from 'react';

const RunContext = createContext(null);

// Tracks which dataset/run the sidebar's run-scoped screens (Executive
// Overview, Data Quality, Duplicates & Matches, etc.) should point at.
// Persisted to localStorage so refreshing the page or coming back later
// doesn't lose the user's place. This is deliberately NOT the source of
// truth for any data -- it's just "where should the sidebar links go" --
// every screen still fetches its own real data for whatever runId is in
// the URL.
export function RunProvider({ children }) {
  const [current, setCurrentState] = useState(() => {
    try {
      const raw = localStorage.getItem('dq_current_run');
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  });

  const setCurrent = useCallback((runId, datasetId, datasetName) => {
    const value = { runId, datasetId, datasetName };
    setCurrentState(value);
    localStorage.setItem('dq_current_run', JSON.stringify(value));
  }, []);

  const clearCurrent = useCallback(() => {
    setCurrentState(null);
    localStorage.removeItem('dq_current_run');
  }, []);

  return (
    <RunContext.Provider value={{ current, setCurrent, clearCurrent }}>
      {children}
    </RunContext.Provider>
  );
}

export function useRunContext() {
  return useContext(RunContext);
}
