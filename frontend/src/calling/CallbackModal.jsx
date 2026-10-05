import { useState } from 'react';
import { patch, post } from '../lib/api.js';
import { ErrorAlert, Field, Modal } from '../components/ui.jsx';

const pad = (n) => String(n).padStart(2, '0');
const toLocalInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** Schedule a callback at the date and time the customer asked for (or reschedule `callback`). */
export function CallbackModal({ phone, name, related, callback, onClose, onSaved }) {
  const [form, setForm] = useState(() => ({
    at: callback ? toLocalInput(new Date(callback.scheduledAt)) : '',
    priority: callback?.priority || 'normal',
    notes: callback?.notes || '',
  }));
  const [error, setError] = useState(null);
  const [warning, setWarning] = useState(null);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    setError(null);
    if (!form.at) return setError(new Error('Choose the date and time the customer asked for.'));
    const at = new Date(form.at);
    if (at < new Date()) return setError(new Error('That time has already passed.'));
    try {
      const res = callback
        ? await patch(`/callbacks/${callback.id}`, { scheduledAt: at.toISOString(), priority: form.priority, notes: form.notes })
        : await post('/callbacks', { phone, customerName: name, related, scheduledAt: at.toISOString(), priority: form.priority, notes: form.notes || undefined });
      if (res.outsideCallingHours && !warning) {
        setWarning('Saved. Note: this time is outside your calling hours — you will still be reminded then.');
        onSaved?.(res);
        return;
      }
      onSaved?.(res);
      onClose();
    } catch (e) {
      setError(e);
    }
  };

  return (
    <Modal
      title={callback ? 'Reschedule callback' : `Schedule callback${name ? ` — ${name}` : ''}`}
      onClose={onClose}
      footer={warning
        ? <button type="button" className="btn btn-primary" onClick={onClose}>OK</button>
        : <><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" onClick={save}>{callback ? 'Reschedule' : 'Schedule'}</button></>}
    >
      <div className="stack">
        <ErrorAlert error={error} />
        {warning && <div className="alert alert-warning">{warning}</div>}
        <Field label="Customer asked to be called at"><input className="input" type="datetime-local" min={toLocalInput(new Date())} value={form.at} onChange={(e) => set('at', e.target.value)} /></Field>
        <Field label="Priority">
          <select className="input" value={form.priority} onChange={(e) => set('priority', e.target.value)}>
            {['low', 'normal', 'high', 'urgent'].map((p) => <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</option>)}
          </select>
        </Field>
        <Field label="What did the customer say?"><textarea className="input" rows={2} value={form.notes} onChange={(e) => set('notes', e.target.value)} placeholder="e.g. Call after 6 pm, wants pricing for 10 users" /></Field>
      </div>
    </Modal>
  );
}
