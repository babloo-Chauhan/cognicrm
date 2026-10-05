import { useEffect, useState } from 'react';
import { get, post } from '../lib/api.js';
import { duration } from '../lib/format.js';
import { ErrorAlert, Field, Modal } from '../components/ui.jsx';
import { useCalls } from './CallContext.jsx';

const LEAD_STATUSES = ['', 'contacted', 'qualified', 'unqualified'];
const DEAL_STAGES = ['', 'prospecting', 'qualification', 'proposal', 'negotiation', 'won', 'lost'];

/** After-call work: disposition, notes and follow-up actions in one step. */
export function WrapUpModal() {
  const { wrapUpCall } = useCalls();
  if (!wrapUpCall) return null;
  // Keyed by call so every wrap-up starts with a fresh form.
  return <WrapUpForm key={wrapUpCall.id} wrapUpCall={wrapUpCall} />;
}

function WrapUpForm({ wrapUpCall }) {
  const { finishWrapUp, capabilities } = useCalls();
  const [dispositions, setDispositions] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [form, setForm] = useState({ code: '', notes: '' });
  const [extras, setExtras] = useState({});
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [remaining, setRemaining] = useState(null);

  useEffect(() => {
    get('/call-dispositions').then((r) => setDispositions(r.items)).catch(() => {});
    get('/message-templates', { channel: 'whatsapp' }).then((r) => setTemplates(r.items)).catch(() => {});
    get('/organization').then((o) => setRemaining(o.settings?.wrapUpSeconds || null)).catch(() => {});
  }, []);

  useEffect(() => {
    if (remaining == null || remaining <= 0) return undefined;
    const t = setTimeout(() => setRemaining((r) => r - 1), 1000);
    return () => clearTimeout(t);
  }, [remaining]);

  const related = wrapUpCall.related || {};
  const dispo = dispositions.find((d) => d.code === form.code);
  const set = (k, v) => setExtras({ ...extras, [k]: v });

  const save = async () => {
    setSaving(true);
    setError(null);
    const body = { code: form.code, notes: form.notes || undefined };
    if (extras.taskTitle) body.createTask = { title: extras.taskTitle, dueAt: extras.taskDue ? new Date(extras.taskDue).toISOString() : undefined };
    if (extras.callbackAt) body.callback = { scheduledAt: new Date(extras.callbackAt).toISOString(), notes: extras.callbackNotes };
    if (extras.leadStatus) body.leadUpdate = { status: extras.leadStatus };
    if (extras.dealStage) body.dealUpdate = { stage: extras.dealStage };
    if (extras.ticketSubject) body.createTicket = { subject: extras.ticketSubject };
    if (extras.emailSubject && extras.emailBody) body.sendEmail = { subject: extras.emailSubject, body: extras.emailBody };
    if (extras.whatsappBody || extras.whatsappTemplate) body.sendWhatsApp = { body: extras.whatsappBody || undefined, templateId: extras.whatsappTemplate || undefined };
    if (extras.addToDnc) body.addToDnc = true;
    try {
      const res = await post(`/calls/${wrapUpCall.id}/disposition`, body);
      const failed = Object.entries(res.errors || {});
      if (failed.length) setError(`Saved, but: ${failed.map(([k, v]) => `${k}: ${v}`).join('; ')}`);
      else finishWrapUp();
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Wrap up call"
      size="lg"
      onClose={() => {}}
      footer={(
        <>
          {remaining != null && <span className="muted small" style={{ marginRight: 'auto' }}>{remaining > 0 ? `Wrap-up time left: ${duration(remaining)}` : 'Wrap-up time is over'}</span>}
          <button type="button" className="btn" onClick={finishWrapUp}>Skip</button>
          <button type="button" className="btn btn-primary" disabled={!form.code || saving} onClick={save}>Save & finish</button>
        </>
      )}
    >
      <div className="stack">
        <div className="muted">{wrapUpCall.direction === 'inbound' ? 'Inbound' : 'Outbound'} call with {wrapUpCall.customerPhone} · {duration(wrapUpCall.durationSeconds)}</div>
        <ErrorAlert error={error} />
        <div className="row" role="radiogroup" aria-label="Disposition">
          {dispositions.map((d) => (
            <button type="button" key={d.code} className={`btn btn-sm ${form.code === d.code ? 'active' : ''}`} onClick={() => setForm({ ...form, code: d.code })}>{d.label}</button>
          ))}
        </div>
        <Field label="Notes"><textarea className="input" rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
        <div className="form-grid">
          <Field label="Create task"><input className="input" placeholder="Task title" value={extras.taskTitle || ''} onChange={(e) => set('taskTitle', e.target.value)} /></Field>
          <Field label="Task due"><input className="input" type="datetime-local" value={extras.taskDue || ''} onChange={(e) => set('taskDue', e.target.value)} /></Field>
          <Field label={`Schedule callback${dispo?.requiresCallback ? ' (required)' : ''}`}><input className="input" type="datetime-local" value={extras.callbackAt || ''} onChange={(e) => set('callbackAt', e.target.value)} /></Field>
          <Field label="Callback notes"><input className="input" value={extras.callbackNotes || ''} onChange={(e) => set('callbackNotes', e.target.value)} /></Field>
          {related.leadId && (
            <Field label="Update lead status">
              <select className="input" value={extras.leadStatus || ''} onChange={(e) => set('leadStatus', e.target.value)}>
                {LEAD_STATUSES.map((s) => <option key={s} value={s}>{s || '— no change —'}</option>)}
              </select>
            </Field>
          )}
          {related.dealId && (
            <Field label="Update deal stage">
              <select className="input" value={extras.dealStage || ''} onChange={(e) => set('dealStage', e.target.value)}>
                {DEAL_STAGES.map((s) => <option key={s} value={s}>{s || '— no change —'}</option>)}
              </select>
            </Field>
          )}
          <Field label="Create ticket"><input className="input" placeholder="Ticket subject" value={extras.ticketSubject || ''} onChange={(e) => set('ticketSubject', e.target.value)} /></Field>
          <Field label="Send WhatsApp">
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <select className="input" value={extras.whatsappTemplate || ''} onChange={(e) => set('whatsappTemplate', e.target.value)}>
                <option value="">Free text</option>
                {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
              {!extras.whatsappTemplate && <input className="input" placeholder="Message" value={extras.whatsappBody || ''} onChange={(e) => set('whatsappBody', e.target.value)} />}
            </div>
          </Field>
          <Field label="Send email — subject"><input className="input" value={extras.emailSubject || ''} onChange={(e) => set('emailSubject', e.target.value)} /></Field>
          <Field label="Email body"><input className="input" value={extras.emailBody || ''} onChange={(e) => set('emailBody', e.target.value)} /></Field>
        </div>
        <label className="checkbox small"><input type="checkbox" checked={Boolean(extras.addToDnc)} onChange={(e) => set('addToDnc', e.target.checked)} /> Customer asked not to be called again (add to Do-Not-Call list)</label>
        {!capabilities?.configured && <div className="small muted">Messages require an SMS/WhatsApp/email provider.</div>}
      </div>
    </Modal>
  );
}
