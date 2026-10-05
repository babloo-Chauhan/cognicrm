import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { get, patch, post } from '../lib/api.js';
import { dateTime, duration, label, time } from '../lib/format.js';
import { useAuth } from '../lib/auth.jsx';
import { useRealtime } from '../lib/realtime.jsx';
import { ErrorAlert, Loading } from '../components/ui.jsx';
import { useAsync } from '../lib/hooks.js';
import { CallButton } from '../calling/CallButton.jsx';

const CHANNEL_ICON = { sms: '💬', whatsapp: '🟢', email: '✉️', webchat: '🗨️', chat: '🗨️', voice: '📞' };

function Thread({ id, onChanged }) {
  const { user } = useAuth();
  const { data, loading, error, reload } = useAsync(() => get(`/inbox/conversations/${id}`), [id]);
  const [channel, setChannel] = useState(null);
  const [body, setBody] = useState('');
  const [subject, setSubject] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [templates, setTemplates] = useState([]);
  const [sendError, setSendError] = useState(null);
  const endRef = useRef(null);
  const conv = data?.conversation;
  const activeChannel = channel || conv?.lastChannel || 'sms';

  useRealtime('inbox:message', ({ conversation }) => { if (conversation.id === id) reload(); });
  useRealtime('inbox:status', () => reload());
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [data]);
  useEffect(() => {
    if (['sms', 'whatsapp', 'email'].includes(activeChannel)) get('/message-templates', { channel: activeChannel }).then((r) => setTemplates(r.items)).catch(() => {});
  }, [activeChannel]);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorAlert error={error} />;

  const send = async () => {
    setSendError(null);
    try {
      await post('/messages', { channel: activeChannel, conversationId: id, body: body || undefined, subject: activeChannel === 'email' ? subject : undefined, templateId: templateId || undefined });
      setBody('');
      setTemplateId('');
      reload();
      onChanged();
    } catch (e) {
      setSendError(e);
    }
  };
  const related = conv.related || {};
  const channels = [...new Set([...(conv.customer.phone ? ['sms', 'whatsapp'] : []), ...(conv.customer.email ? ['email'] : []), ...(conv.customer.visitorId ? ['webchat'] : []), ...conv.channels])];

  return (
    <div className="thread">
      <div className="card-header">
        <div>
          <strong>{conv.customer.name || conv.customer.phone || conv.customer.email || 'Visitor'}</strong>
          <div className="small muted">{[conv.customer.phone, conv.customer.email].filter(Boolean).join(' · ')}</div>
        </div>
        <div className="row">
          {related.contactId && <Link className="btn btn-sm" to={`/contacts/${related.contactId}`}>Contact</Link>}
          {related.leadId && <Link className="btn btn-sm" to={`/leads/${related.leadId}`}>Lead</Link>}
          <CallButton phone={conv.customer.phone} name={conv.customer.name} related={related} />
          {String(conv.assignedTo?.id || conv.assignedTo) !== String(user.id) && <button type="button" className="btn btn-sm" onClick={async () => { await patch(`/inbox/conversations/${id}`, { assignedTo: user.id }); reload(); onChanged(); }}>Assign to me</button>}
          <button type="button" className="btn btn-sm" onClick={async () => { await patch(`/inbox/conversations/${id}`, { status: conv.status === 'closed' ? 'open' : 'closed' }); reload(); onChanged(); }}>{conv.status === 'closed' ? 'Reopen' : 'Close'}</button>
        </div>
      </div>
      <div className="thread-messages">
        {data.timeline.map((t) => {
          if (t.kind === 'call') {
            return <div key={`c${t.item.id}`} className="thread-event">📞 {label(t.item.direction)} call · {label(t.item.status)}{t.item.durationSeconds ? ` · ${duration(t.item.durationSeconds)}` : ''}{t.item.disposition?.label ? ` · ${t.item.disposition.label}` : ''} · {dateTime(t.at)}</div>;
          }
          if (t.kind === 'note') return <div key={`n${t.item.id}`} className="thread-event">📝 {t.item.body}</div>;
          const m = t.item;
          return (
            <div key={m.id} className={`bubble ${m.direction === 'outbound' ? 'out' : ''}`}>
              {m.subject && <strong>{m.subject}<br /></strong>}
              {m.body}
              {m.attachments?.map((a, i) => <div key={i} className="small">📎 {a.name || a.contentType || 'attachment'}</div>)}
              <div className="meta">{CHANNEL_ICON[m.channel]} {label(m.channel)} · {time(m.createdAt)}{m.direction === 'outbound' ? ` · ${label(m.status)}` : ''}{m.error ? ` · ${m.error}` : ''}</div>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>
      <ErrorAlert error={sendError} />
      <div className="composer">
        <select className="input" style={{ width: 130 }} value={activeChannel} onChange={(e) => setChannel(e.target.value)} aria-label="Channel">
          {channels.map((c) => <option key={c} value={c}>{CHANNEL_ICON[c]} {label(c)}</option>)}
        </select>
        <div className="stack" style={{ flex: 1, gap: 6 }}>
          {activeChannel === 'email' && <input className="input" placeholder="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} />}
          {templates.length > 0 && (
            <select className="input" value={templateId} onChange={(e) => setTemplateId(e.target.value)} aria-label="Template">
              <option value="">No template</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          )}
          {!templateId && <textarea className="input" rows={2} placeholder="Type a reply…" value={body} onChange={(e) => setBody(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && body) { e.preventDefault(); send(); } }} />}
        </div>
        <button type="button" className="btn btn-primary" disabled={!body && !templateId} onClick={send}>Send</button>
      </div>
    </div>
  );
}

export function Inbox() {
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState('open');
  const [channelFilter, setChannelFilter] = useState('');
  const [q, setQ] = useState('');
  const { data, reload } = useAsync(() => get('/inbox/conversations', { status, channel: channelFilter, q }), [status, channelFilter, q]);
  const selected = params.get('c');
  useRealtime('inbox:message', () => reload());

  return (
    <>
      <div className="page-header">
        <h1>Unified inbox</h1>
        <div className="row">
          <input className="input" style={{ width: 220 }} placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select className="input" style={{ width: 140 }} value={channelFilter} onChange={(e) => setChannelFilter(e.target.value)} aria-label="Channel filter">
            <option value="">All channels</option>
            {['sms', 'whatsapp', 'email', 'webchat'].map((c) => <option key={c} value={c}>{label(c)}</option>)}
          </select>
          <select className="input" style={{ width: 120 }} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status filter">
            {['open', 'pending', 'closed'].map((s) => <option key={s} value={s}>{label(s)}</option>)}
          </select>
        </div>
      </div>
      <div className="card inbox">
        <div className="inbox-list">
          {!data?.items?.length && <div className="empty">No conversations.</div>}
          {data?.items?.map((c) => (
            <div key={c.id} role="button" tabIndex={0} className={`inbox-item ${selected === c.id ? 'active' : ''}`} onClick={() => setParams({ c: c.id })} onKeyDown={(e) => e.key === 'Enter' && setParams({ c: c.id })}>
              <div className="row">
                <strong>{c.customer.name || c.customer.phone || c.customer.email || 'Visitor'}</strong>
                {c.unreadCount > 0 && <span className="badge badge-danger">{c.unreadCount}</span>}
                <span className="small muted right">{time(c.lastMessageAt)}</span>
              </div>
              <div className="small muted">{CHANNEL_ICON[c.lastChannel]} {c.lastMessagePreview}</div>
            </div>
          ))}
        </div>
        {selected ? <Thread key={selected} id={selected} onChanged={reload} /> : <div className="empty">Select a conversation</div>}
      </div>
    </>
  );
}
