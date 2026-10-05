import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/auth.jsx';
import { RealtimeProvider } from './lib/realtime.jsx';
import { CallProvider } from './calling/CallContext.jsx';
import { Layout } from './components/Layout.jsx';
import { Login } from './pages/Login.jsx';
import { Dashboard } from './pages/Dashboard.jsx';
import { EntityList } from './pages/EntityList.jsx';
import { EntityDetail } from './pages/EntityDetail.jsx';
import { Inbox } from './pages/Inbox.jsx';
import { Assistant } from './pages/Assistant.jsx';
import { Settings } from './pages/Settings.jsx';
import { VoiceAgents } from './pages/VoiceAgents.jsx';
import { Loading } from './components/ui.jsx';
import { SalesOverview } from './pages/sales/SalesOverview.jsx';
import { DocList } from './pages/sales/DocList.jsx';
import { DocDetail } from './pages/sales/DocDetail.jsx';
import { DocEditor } from './pages/sales/DocEditor.jsx';
import './App.css';

// The call center bundles charts and the IVR node editor, so it loads on demand.
const CallingPage = lazy(() => import('./pages/calling/CallingPage.jsx').then((m) => ({ default: m.CallingPage })));

const ENTITIES = ['leads', 'contacts', 'accounts', 'deals', 'tickets', 'tasks', 'products'];
const NO_DETAIL = ['tasks', 'products'];

function Shell() {
  const { user, loading, connectionError, refresh, logout } = useAuth();
  if (loading) return <Loading />;
  if (!user && connectionError) {
    return (
      <div className="auth-page">
        <div className="card auth-card"><div className="card-body stack">
          <h1>Can’t reach the server</h1>
          <p className="muted">{connectionError.message}. Your session is kept — try again in a moment.</p>
          <div className="row"><button type="button" className="btn btn-primary" onClick={refresh}>Retry</button><button type="button" className="btn" onClick={logout}>Sign out</button></div>
        </div></div>
      </div>
    );
  }
  if (!user) return <Login />;
  return (
    <RealtimeProvider>
      <CallProvider>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Dashboard />} />
            {ENTITIES.map((e) => <Route key={e} path={e} element={<EntityList entity={e} />} />)}
            {ENTITIES.filter((e) => !NO_DETAIL.includes(e)).map((e) => <Route key={`${e}-d`} path={`${e}/:id`} element={<EntityDetail entity={e} />} />)}
            <Route path="sales" element={<SalesOverview />} />
            {[['quote', 'quotes'], ['invoice', 'invoices']].map(([kind, path]) => [
              <Route key={`${path}-l`} path={path} element={<DocList kind={kind} />} />,
              <Route key={`${path}-n`} path={`${path}/new`} element={<DocEditor key="new" kind={kind} />} />,
              <Route key={`${path}-e`} path={`${path}/:id/edit`} element={<DocEditor kind={kind} />} />,
              <Route key={`${path}-d`} path={`${path}/:id`} element={<DocDetail kind={kind} />} />,
            ])}
            <Route path="inbox" element={<Inbox />} />
            <Route path="calling" element={<Suspense fallback={<Loading />}><CallingPage /></Suspense>} />
            <Route path="assistant" element={<Assistant />} />
            <Route path="voice-agents" element={<VoiceAgents />} />
            <Route path="settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </CallProvider>
    </RealtimeProvider>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Shell />
      </AuthProvider>
    </BrowserRouter>
  );
}
