import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/auth.jsx';
import { RealtimeProvider } from './lib/realtime.jsx';
import { CallProvider } from './calling/CallContext.jsx';
import { Layout } from './components/Layout.jsx';
import { Login } from './pages/Login.jsx';
import { Register } from './pages/Register.jsx';
import { Dashboard } from './pages/Dashboard.jsx';
import { EntityList } from './pages/EntityList.jsx';
import { EntityDetail } from './pages/EntityDetail.jsx';
import { Inbox } from './pages/Inbox.jsx';
import { Assistant } from './pages/Assistant.jsx';
import { Settings } from './pages/Settings.jsx';
import { VoiceAgents } from './pages/VoiceAgents.jsx';
import { Billing } from './pages/Billing.jsx';
import { TeamPage } from './pages/Team.jsx';
import { Pipelines } from './pages/Pipelines.jsx';
import { Loading, ToastHost } from './components/ui.jsx';
import { ModuleGate } from './components/ModuleGate.jsx';
import { SalesOverview } from './pages/sales/SalesOverview.jsx';
import { DocList } from './pages/sales/DocList.jsx';
import { DocDetail } from './pages/sales/DocDetail.jsx';
import { DocEditor } from './pages/sales/DocEditor.jsx';
import './App.css';

// The call center bundles charts and the IVR node editor, so it loads on demand; so does the super-admin console.
const CallingPage = lazy(() => import('./pages/calling/CallingPage.jsx').then((m) => ({ default: m.CallingPage })));
const SuperAdminApp = lazy(() => import('./pages/superadmin/SuperAdminApp.jsx').then((m) => ({ default: m.SuperAdminApp })));

const ENTITIES = ['leads', 'contacts', 'accounts', 'deals', 'tickets', 'tasks', 'products'];
const NO_DETAIL = ['tasks', 'products'];
// Plan module behind each page (see backend src/lib/modules.js)
const MODULE_OF = { leads: 'leads', contacts: 'customers', accounts: 'customers', deals: 'deals', tickets: 'support', tasks: 'tasks', products: 'invoices' };
const gate = (module, el) => <ModuleGate module={module}>{el}</ModuleGate>;

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
  if (!user) {
    return (
      <Routes>
        <Route path="register" element={<Register />} />
        <Route path="*" element={<Login />} />
      </Routes>
    );
  }
  return (
    <RealtimeProvider>
      <CallProvider>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Dashboard />} />
            {ENTITIES.map((e) => <Route key={e} path={e} element={gate(MODULE_OF[e], <EntityList entity={e} />)} />)}
            {ENTITIES.filter((e) => !NO_DETAIL.includes(e)).map((e) => <Route key={`${e}-d`} path={`${e}/:id`} element={gate(MODULE_OF[e], <EntityDetail entity={e} />)} />)}
            <Route path="pipelines" element={gate('deals', <Pipelines />)} />
            <Route path="sales" element={gate('invoices', <SalesOverview />)} />
            {[['quote', 'quotes'], ['invoice', 'invoices']].map(([kind, path]) => [
              <Route key={`${path}-l`} path={path} element={gate('invoices', <DocList kind={kind} />)} />,
              <Route key={`${path}-n`} path={`${path}/new`} element={gate('invoices', <DocEditor key="new" kind={kind} />)} />,
              <Route key={`${path}-e`} path={`${path}/:id/edit`} element={gate('invoices', <DocEditor kind={kind} />)} />,
              <Route key={`${path}-d`} path={`${path}/:id`} element={gate('invoices', <DocDetail kind={kind} />)} />,
            ])}
            <Route path="inbox" element={gate('whatsapp', <Inbox />)} />
            <Route path="calling" element={gate('calling', <Suspense fallback={<Loading />}><CallingPage /></Suspense>)} />
            <Route path="assistant" element={gate('ai', <Assistant />)} />
            <Route path="voice-agents" element={gate('ai', <VoiceAgents />)} />
            <Route path="billing" element={<Billing />} />
            <Route path="team" element={<TeamPage />} />
            <Route path="settings" element={<Settings />} />
            <Route path="register" element={<Navigate to="/" replace />} />
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
      <Routes>
        {/* Platform console: separate login and token, independent of any company session */}
        <Route path="super-admin/*" element={<Suspense fallback={<Loading />}><SuperAdminApp /></Suspense>} />
        <Route path="*" element={<AuthProvider><Shell /></AuthProvider>} />
      </Routes>
      <ToastHost />
    </BrowserRouter>
  );
}
