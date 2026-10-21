import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import { FEATURES } from '../lib/features.js';

/** Renders the page only when the company's plan includes `module`; otherwise an upgrade card (no API calls). */
export function ModuleGate({ module, children }) {
  const { hasModule, can, company } = useAuth();
  if (!module || hasModule(module)) return children;
  // Switched off by the company (Settings → Features), not missing from the plan
  const feature = FEATURES[module];
  if (feature && company?.modules?.includes(feature.module)) {
    return (
      <div className="card" style={{ maxWidth: 560, margin: '40px auto' }}>
        <div className="card-body stack">
          <h2>{feature.label} is switched off</h2>
          <p className="muted" style={{ margin: 0 }}>Your company does not use this. Nothing was deleted.</p>
          {can('settings:manage') ? <Link className="btn btn-primary" style={{ alignSelf: 'flex-start' }} to="/settings">Switch it on in Settings</Link> : <p className="small muted" style={{ margin: 0 }}>Ask your company admin if you need it.</p>}
        </div>
      </div>
    );
  }
  const lapsed = company && !company.premium && company.plan?.modules && (company.plan.modules.includes('*') || company.plan.modules.includes(module));
  return (
    <div className="card" style={{ maxWidth: 560, margin: '40px auto' }}>
      <div className="card-body stack">
        <h2>{lapsed ? 'Your subscription has expired' : 'Not included in your plan'}</h2>
        <p className="muted" style={{ margin: 0 }}>
          {lapsed
            ? 'Renew to use this feature again. Your data is safe.'
            : `This feature is part of a higher plan. You are on ${company?.plan?.name || 'your current plan'}.`}
        </p>
        {can('billing:manage') ? <Link className="btn btn-primary" style={{ alignSelf: 'flex-start' }} to="/billing">View plans</Link> : <p className="small muted" style={{ margin: 0 }}>Ask your company admin to upgrade.</p>}
      </div>
    </div>
  );
}
