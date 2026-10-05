import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCalls } from './CallContext.jsx';
import { useAuth } from '../lib/auth.jsx';
import { post } from '../lib/api.js';
import { Field, Modal, ErrorAlert } from '../components/ui.jsx';

/**
 * Reusable click-to-call control for any phone number in the CRM.
 * Desktop → browser softphone (or bridge call to the agent's phone).
 * Mobile → native phone dialer (the call is still logged in the CRM).
 */
export function CallButton({ phone, name, related = {}, size = 'sm', showLabel = false }) {
  const { dial, activeCall } = useCalls();
  const { can } = useAuth();
  if (!phone) return null;
  const busy = activeCall && !['completed', 'failed', 'busy', 'no_answer', 'canceled', 'voicemail', 'abandoned'].includes(activeCall.status);
  return (
    <button
      type="button"
      className={`btn btn-${size} btn-success`}
      title={busy ? 'Finish your current call first' : `Call ${name || phone}`}
      disabled={busy || !can('calls:make')}
      onClick={(e) => { e.stopPropagation(); dial(phone, { related, name }); }}
    >
      📞{showLabel && ' Call'}
    </button>
  );
}

/** Call + SMS + WhatsApp + Email actions shown next to every phone number / email. */
export function ContactActions({ phone, email, name, related = {} }) {
  const [compose, setCompose] = useState(null);
  return (
    <span className="row" onClick={(e) => e.stopPropagation()}>
      <CallButton phone={phone} name={name} related={related} />
      {phone && <button type="button" className="btn btn-sm" title="Send SMS" onClick={() => setCompose('sms')}>💬</button>}
      {phone && <button type="button" className="btn btn-sm" title="Send WhatsApp" onClick={() => setCompose('whatsapp')}>🟢</button>}
      {email && <button type="button" className="btn btn-sm" title="Send email" onClick={() => setCompose('email')}>✉️</button>}
      {compose && (
        <ComposeModal channel={compose} to={compose === 'email' ? email : phone} name={name} related={related} onClose={() => setCompose(null)} />
      )}
    </span>
  );
}

export function ComposeModal({ channel, to, name, related, onClose }) {
  const [body, setBody] = useState('');
  const [subject, setSubject] = useState('');
  const [error, setError] = useState(null);
  const [sending, setSending] = useState(false);
  const navigate = useNavigate();
  const send = async () => {
    setSending(true);
    setError(null);
    try {
      const res = await post('/messages', { channel, to, body, subject: channel === 'email' ? subject : undefined, related });
      onClose();
      navigate(`/inbox?c=${res.conversation.id}`);
    } catch (e) {
      setError(e);
      setSending(false);
    }
  };
  const title = { sms: 'SMS', whatsapp: 'WhatsApp', email: 'Email' }[channel];
  return (
    <Modal
      title={`${title} to ${name || to}`}
      onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={!body || sending} onClick={send}>Send</button></>}
    >
      <div className="stack">
        <ErrorAlert error={error} />
        {channel === 'email' && <Field label="Subject"><input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} /></Field>}
        <Field label="Message"><textarea className="input" rows={5} value={body} onChange={(e) => setBody(e.target.value)} autoFocus /></Field>
      </div>
    </Modal>
  );
}
