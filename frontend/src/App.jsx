import { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useParams } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { RunProvider, useRunContext } from './context/RunContext';
import Sidebar from './components/Sidebar';
import TopBar from './components/TopBar';
import { LockedModuleModal } from './components/common';
import { api } from './api/client';

import Login from './pages/Login';
import DatasetsList from './pages/DatasetsList';
import DatasetDetail from './pages/DatasetDetail';
import ExecutiveOverview from './pages/ExecutiveOverview';
import DataQuality from './pages/DataQuality';
import DuplicatesMatches from './pages/DuplicatesMatches';
import EntityIntelligence from './pages/EntityIntelligence';
import ItemIntelligence from './pages/ItemIntelligence';
import ConflictsPage from './pages/ConflictsPage';
import MissingInvalid from './pages/MissingInvalid';
import Freshness from './pages/Freshness';
import IssueExplorerPage from './pages/IssueExplorerPage';
import ReportsExports from './pages/ReportsExports';
import AnalysisRuns from './pages/AnalysisRuns';
import RecordDetail from './pages/RecordDetail';
import RecordCompare from './pages/RecordCompare';
import ReviewSchema from './pages/ReviewSchema';

function ProtectedShell({ children }) {
  const { user, logout } = useAuth();
  const [lockedItem, setLockedItem] = useState(null);

  if (!user) return <Navigate to="/login" replace />;

  return (
    <div className="app-shell">
      <a href="#main-content" className="skip-link">Skip to main content</a>
      <Sidebar onLockedClick={setLockedItem} />
      <div className="main-area">
        <TopBar user={user} onSignOut={logout} />
        <main id="main-content" className="content" tabIndex={-1}>{children}</main>
      </div>
      <LockedModuleModal item={lockedItem} onClose={() => setLockedItem(null)} />
    </div>
  );
}

/** Any /runs/:runId/* route reached directly (bookmark, refresh, back
 * button) keeps the sidebar's "active dataset" context in sync with the
 * URL, rather than only updating it when navigated to via a click. */
function SyncRunContext({ children }) {
  const { runId } = useParams();
  const { current, setCurrent } = useRunContext();

  useEffect(() => {
    if (!runId || current?.runId === runId) return;
    api.getRun(runId).then(res => {
      api.getDataset(res.run.dataset_id).then(dsRes => {
        setCurrent(runId, res.run.dataset_id, dsRes.dataset.name);
      }).catch(() => {});
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  return children;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<ProtectedShell><DatasetsList /></ProtectedShell>} />
      <Route path="/datasets/:id" element={<ProtectedShell><DatasetDetail /></ProtectedShell>} />
      <Route path="/analysis-runs" element={<ProtectedShell><AnalysisRuns /></ProtectedShell>} />
      <Route path="/schema-review/:fileId" element={<ProtectedShell><ReviewSchema /></ProtectedShell>} />

      <Route path="/runs/:runId/overview" element={<ProtectedShell><SyncRunContext><ExecutiveOverview /></SyncRunContext></ProtectedShell>} />
      <Route path="/runs/:runId/quality" element={<ProtectedShell><SyncRunContext><DataQuality /></SyncRunContext></ProtectedShell>} />
      <Route path="/runs/:runId/duplicates" element={<ProtectedShell><SyncRunContext><DuplicatesMatches /></SyncRunContext></ProtectedShell>} />
      <Route path="/runs/:runId/entities" element={<ProtectedShell><SyncRunContext><EntityIntelligence /></SyncRunContext></ProtectedShell>} />
      <Route path="/runs/:runId/items" element={<ProtectedShell><SyncRunContext><ItemIntelligence /></SyncRunContext></ProtectedShell>} />
      <Route path="/runs/:runId/conflicts" element={<ProtectedShell><SyncRunContext><ConflictsPage /></SyncRunContext></ProtectedShell>} />
      <Route path="/runs/:runId/missing-invalid" element={<ProtectedShell><SyncRunContext><MissingInvalid /></SyncRunContext></ProtectedShell>} />
      <Route path="/runs/:runId/freshness" element={<ProtectedShell><SyncRunContext><Freshness /></SyncRunContext></ProtectedShell>} />
      <Route path="/runs/:runId/issues" element={<ProtectedShell><SyncRunContext><IssueExplorerPage /></SyncRunContext></ProtectedShell>} />
      <Route path="/runs/:runId/reports" element={<ProtectedShell><SyncRunContext><ReportsExports /></SyncRunContext></ProtectedShell>} />

      <Route path="/records/:id" element={<ProtectedShell><RecordDetail /></ProtectedShell>} />
      <Route path="/compare" element={<ProtectedShell><RecordCompare /></ProtectedShell>} />

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <RunProvider>
          <AppRoutes />
        </RunProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
