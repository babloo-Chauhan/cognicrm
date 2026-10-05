import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../../lib/auth.jsx';
import { Tabs } from '../../components/ui.jsx';
import { Overview } from './Overview.jsx';
import { Dialer } from './Dialer.jsx';
import { ActiveCalls } from './ActiveCalls.jsx';
import { Queues } from './Queues.jsx';
import { Agents } from './Agents.jsx';
import { CallHistory } from './CallHistory.jsx';
import { Recordings } from './Recordings.jsx';
import { Campaigns } from './Campaigns.jsx';
import { PhoneNumbers } from './PhoneNumbers.jsx';
import { IvrPage } from './IvrPage.jsx';
import { BusinessHoursPage } from './BusinessHoursPage.jsx';
import { CallingSettings } from './CallingSettings.jsx';

const TABS = [
  { key: 'overview', label: 'Overview', component: Overview },
  { key: 'dialer', label: 'Dialer', component: Dialer },
  { key: 'active', label: 'Active Calls', component: ActiveCalls },
  { key: 'queues', label: 'Queues', component: Queues },
  { key: 'agents', label: 'Agents', component: Agents },
  { key: 'history', label: 'Call History', component: CallHistory },
  { key: 'recordings', label: 'Recordings', component: Recordings },
  { key: 'campaigns', label: 'Campaigns', component: Campaigns },
  { key: 'numbers', label: 'Phone Numbers', component: PhoneNumbers },
  { key: 'ivr', label: 'IVR', component: IvrPage, permission: 'ivr:manage' },
  { key: 'hours', label: 'Business Hours', component: BusinessHoursPage },
  { key: 'settings', label: 'Settings', component: CallingSettings, permission: 'settings:manage' },
];

export function CallingPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const tabs = TABS.filter((t) => !t.permission || can(t.permission));
  const current = tabs.find((t) => t.key === params.get('tab')) || tabs[0];
  const Component = current.component;
  return (
    <>
      <div className="page-header"><h1>Calling</h1></div>
      <Tabs tabs={tabs} value={current.key} onChange={(tab) => setParams({ tab })} />
      <Component />
    </>
  );
}
