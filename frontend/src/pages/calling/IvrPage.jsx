import { useState } from 'react';
import { get } from '../../lib/api.js';
import { dateTime } from '../../lib/format.js';
import { DataTable, ErrorAlert, StatusBadge } from '../../components/ui.jsx';
import { useAsync } from '../../lib/hooks.js';
import { IvrBuilder } from './IvrBuilder.jsx';

/** Starter flow from the spec: welcome + Sales / Support / Billing / Existing customer / Operator. */
const TEMPLATE = {
  name: 'Main menu',
  defaultLanguage: 'en',
  languages: ['en', 'hi'],
  nodes: [
    { id: 'start', type: 'start', position: { x: 300, y: 0 }, data: { label: 'Start' } },
    { id: 'welcome', type: 'tts', position: { x: 300, y: 90 }, data: { label: 'Welcome', text: { en: 'Welcome to COGNIEOS.', hi: 'COGNIEOS mein aapka swagat hai.' } } },
    {
      id: 'menu', type: 'dtmf', position: { x: 300, y: 190 },
      data: { label: 'Main menu', options: '1,2,3,4,0', numDigits: 1, prompt: { en: 'Press 1 for Sales. Press 2 for Support. Press 3 for Billing. Press 4 if you are an existing customer. Press 0 for the operator.', hi: 'Sales ke liye 1 dabaiye. Support ke liye 2. Billing ke liye 3. Existing customer ke liye 4. Operator ke liye 0.' } },
    },
    { id: 'sales', type: 'queue', position: { x: 0, y: 340 }, data: { label: 'Sales' } },
    { id: 'support', type: 'queue', position: { x: 160, y: 340 }, data: { label: 'Support' } },
    { id: 'billing', type: 'queue', position: { x: 320, y: 340 }, data: { label: 'Billing' } },
    { id: 'existing', type: 'gather', position: { x: 480, y: 340 }, data: { label: 'Customer ID', collect: true, variable: 'customerId', prompt: { en: 'Please enter your customer ID followed by the hash key.' } } },
    { id: 'lookup', type: 'api_request', position: { x: 480, y: 450 }, data: { label: 'Find customer', operation: 'customer_lookup', inputVariable: 'customerId', resultVariable: 'customer' } },
    { id: 'hello', type: 'tts', position: { x: 400, y: 560 }, data: { label: 'Greet customer', text: { en: 'Hello {{vars.customer.firstName}}, connecting you to support.' } } },
    { id: 'operator', type: 'voicemail', position: { x: 660, y: 340 }, data: { label: 'Operator / voicemail' } },
  ],
  edges: [
    { id: 'e1', source: 'start', target: 'welcome' },
    { id: 'e2', source: 'welcome', target: 'menu' },
    { id: 'e3', source: 'menu', target: 'sales', sourceHandle: '1' },
    { id: 'e4', source: 'menu', target: 'support', sourceHandle: '2' },
    { id: 'e5', source: 'menu', target: 'billing', sourceHandle: '3' },
    { id: 'e6', source: 'menu', target: 'existing', sourceHandle: '4' },
    { id: 'e7', source: 'menu', target: 'operator', sourceHandle: '0' },
    { id: 'e8', source: 'existing', target: 'lookup' },
    { id: 'e9', source: 'lookup', target: 'hello', sourceHandle: 'success' },
    { id: 'e10', source: 'lookup', target: 'support', sourceHandle: 'error' },
    { id: 'e11', source: 'hello', target: 'support' },
  ],
};

export function IvrPage() {
  const { data, error, reload } = useAsync(() => get('/ivr'), []);
  const [editing, setEditing] = useState(null);
  if (editing) {
    return (
      <div className="stack">
        <button type="button" className="btn btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => { setEditing(null); reload(); }}>← All IVR flows</button>
        <IvrBuilder key={editing.id || 'new'} flow={editing} onSaved={(f) => setEditing(f)} />
      </div>
    );
  }
  return (
    <div className="stack">
      <div className="row">
        <span className="muted">Visual IVR flows. Assign a published flow to a phone number to use it.</span>
        <span className="row right">
          <button type="button" className="btn" onClick={() => setEditing({ ...TEMPLATE })}>Start from template</button>
          <button type="button" className="btn btn-primary" onClick={() => setEditing({ name: 'New IVR', nodes: [{ id: 'start', type: 'start', position: { x: 200, y: 20 }, data: { label: 'Start' } }], edges: [], languages: ['en'] })}>+ New flow</button>
        </span>
      </div>
      <ErrorAlert error={error} />
      <div className="card">
        <DataTable
          rows={data?.items}
          empty="No IVR flows yet."
          onRowClick={setEditing}
          columns={[
            { key: 'name', label: 'Flow' },
            { key: 'status', label: 'Status', render: (f) => <StatusBadge status={f.status} /> },
            { key: 'languages', label: 'Languages', render: (f) => f.languages.join(', ') },
            { key: 'nodes', label: 'Nodes', render: (f) => f.nodes.length },
            { key: 'version', label: 'Version' },
            { key: 'updatedAt', label: 'Updated', render: (f) => dateTime(f.updatedAt) },
          ]}
        />
      </div>
    </div>
  );
}
