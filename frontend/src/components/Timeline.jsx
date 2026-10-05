import { get } from '../lib/api.js';
import { dateTime, duration, label } from '../lib/format.js';
import { useRealtime } from '../lib/realtime.jsx';
import { RecordingPlayer } from '../calling/RecordingPlayer.jsx';
import { Empty, ErrorAlert, Loading } from './ui.jsx';
import { useAsync } from '../lib/hooks.js';

const ICONS = {
  call: '📞', sms: '💬', whatsapp: '🟢', email: '✉️', webchat: '🗨️', chat: '🗨️', note: '📝', task_created: '✅',
  lead_created: '✨', lead_converted: '🎉', deal_created: '💼', stage_changed: '➡️', ticket_created: '🎫',
  appointment: '📅', call_summary: '🤖', contact_created: '👤', account_created: '🏢',
};

/** Unified communication timeline for any CRM record. */
export function Timeline({ entityType, entityId }) {
  const { data, loading, error, reload } = useAsync(() => get(`/timeline/${entityType}/${entityId}`), [entityType, entityId]);
  useRealtime('timeline:activity', (a) => {
    const key = `${entityType}Id`;
    if (String(a.links?.[key]) === String(entityId)) reload();
  });
  if (loading && !data) return <Loading />;
  if (error) return <ErrorAlert error={error} />;
  if (!data.items.length) return <Empty>No activity yet.</Empty>;
  return (
    <ul className="timeline">
      {data.items.map((a) => (
        <li key={a.id || a._id}>
          <div className="tl-icon" aria-hidden="true">{ICONS[a.type] || '•'}</div>
          <div>
            <div className="row">
              <strong>{a.title}</strong>
              <span className="tl-meta right">{dateTime(a.occurredAt)}</span>
            </div>
            {a.type === 'call' && <CallActivity data={a.data} callId={a.refId} />}
            {['sms', 'whatsapp', 'email', 'webchat'].includes(a.type) && a.data?.body && <div className="muted">{a.data.body}</div>}
            {a.type === 'call_summary' && (
              <div className="stack small">
                <div>{a.data?.summary}</div>
                {a.data?.nextSteps?.length > 0 && <div className="muted">Next: {a.data.nextSteps.join('; ')}</div>}
              </div>
            )}
            {a.type === 'stage_changed' && <div className="muted small">{label(a.data?.from)} → {label(a.data?.to)}</div>}
          </div>
        </li>
      ))}
    </ul>
  );
}

function CallActivity({ data = {}, callId }) {
  return (
    <div className="tl-meta row" style={{ gap: 14 }}>
      <span>{label(data.direction)} · {label(data.status)}</span>
      {data.durationSeconds > 0 && <span>Duration {duration(data.durationSeconds)}</span>}
      {data.agentName && <span>Agent {data.agentName}</span>}
      {data.disposition && <span>Disposition <strong>{data.disposition}</strong></span>}
      <span>Recording {data.hasRecording ? 'available' : '—'}</span>
      <span>Transcript {data.hasTranscript ? 'available' : '—'}</span>
      {data.hasRecording && <RecordingPlayer callId={callId} />}
    </div>
  );
}
