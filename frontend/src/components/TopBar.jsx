import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Bell } from 'lucide-react';
import { useRunContext } from '../context/RunContext';
import { api } from '../api/client';

function formatWhen(iso) {
  if (!iso) return null;
  // Backend timestamps are SQLite "YYYY-MM-DD HH:MM:SS" (UTC, no offset).
  const d = new Date(iso.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export default function TopBar({ user, onSignOut }) {
  const { current } = useRunContext();
  const [run, setRun] = useState(null);
  const [query, setQuery] = useState('');
  const navigate = useNavigate();
  const initials = (user?.name || user?.email || '?').trim().split(/\s+/).map(p => p[0]).slice(0, 2).join('').toUpperCase();

  function submitSearch(e) {
    e.preventDefault();
    if (!query.trim()) return;
    navigate(`/?q=${encodeURIComponent(query.trim())}`);
  }

  useEffect(() => {
    if (!current?.runId) { setRun(null); return; }
    api.getRun(current.runId).then(res => setRun(res.run)).catch(() => setRun(null));
  }, [current?.runId]);

  return (
    <div className="topbar">
      <div className="topbar-context">
        {current?.datasetName ? (
          <>
            <span className="topbar-dataset">{current.datasetName}</span>
            {run && (
              <>
                <span className="topbar-sep">/</span>
                <span className={`topbar-status topbar-status-${run.status}`}>{run.status}</span>
                {run.finished_at && (
                  <>
                    <span className="topbar-sep">·</span>
                    <span className="topbar-when">analyzed {formatWhen(run.finished_at)}</span>
                  </>
                )}
              </>
            )}
          </>
        ) : (
          <span className="text-tertiary text-sm">No dataset selected</span>
        )}
      </div>
      <form className="topbar-search" onSubmit={submitSearch} role="search">
        <Search size={14} aria-hidden="true" />
        <input
          aria-label="Search datasets"
          placeholder="Search datasets, entities, issues…"
          value={query}
          onChange={e => setQuery(e.target.value)}
        />
      </form>

      <div className="topbar-actions">
        <button className="topbar-icon-btn" aria-label="Notifications" title="Notifications" type="button">
          <Bell size={17} strokeWidth={1.8} aria-hidden="true" />
          <span className="dot" aria-hidden="true" />
        </button>
        <div className="topbar-user">
          <div className="avatar-chip" aria-hidden="true">{initials}</div>
          <div className="topbar-user-meta">
            <span className="topbar-user-name">{user.name}</span>
            <span className="topbar-user-role">{user.email}</span>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onSignOut}>Sign out</button>
        </div>
      </div>
    </div>
  );
}
