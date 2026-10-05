import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { get } from '../lib/api.js';
import { duration, label } from '../lib/format.js';
import { Field, Modal } from '../components/ui.jsx';
import { useCalls } from './CallContext.jsx';
import { TERMINAL, uiState } from './callState.js';

const KEYS = [['1', ''], ['2', 'ABC'], ['3', 'DEF'], ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'], ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'], ['*', ''], ['0', '+'], ['#', '']];

function useTimer(start) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!start) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [start]);
  return start ? (now - new Date(start).getTime()) / 1000 : 0;
}

/** Floating browser softphone: dial pad, call controls, caller info and notes. */
export function Softphone() {
  const c = useCalls();
  const [number, setNumber] = useState('');
  const [showKeypad, setShowKeypad] = useState(false);
  const [transferOpen, setTransferOpen] = useState(null); // 'transfer' | 'add'
  const [nativeLog, setNativeLog] = useState({ minutes: '', connected: true });
  const call = c.activeCall;
  const state = uiState(call);
  const live = call && !TERMINAL.includes(call.status);
  const elapsed = useTimer(call?.answeredAt && live ? call.answeredAt : null);
  const caps = c.capabilities?.capabilities || {};

  if (!c.open) {
    return (
      <button type="button" className="softphone-fab" onClick={() => c.setOpen(true)} aria-label="Open softphone" title="Softphone">
        📞
      </button>
    );
  }

  const press = (k) => {
    if (live && state === 'Connected') c.sendDigits(k);
    else setNumber((n) => n + k);
  };

  return (
    <section className="softphone" aria-label="Softphone">
      <div className="softphone-head">
        <span className="title">Softphone</span>
        <span className="small" title="Device status">{c.deviceState === 'ready' ? '● WebRTC' : c.capabilities?.configured ? `● ${c.capabilities.provider}` : '○ Native'}</span>
        <button type="button" onClick={() => c.setMinimized(!c.minimized)} aria-label={c.minimized ? 'Maximize' : 'Minimize'}>{c.minimized ? '▢' : '–'}</button>
        <button type="button" onClick={() => c.setOpen(false)} aria-label="Close" disabled={live}>✕</button>
      </div>
      {!c.minimized && (
        <div className="softphone-body">
          {c.error && <div className="alert small" role="alert">{c.error}</div>}
          {!call && (
            <div className="stack" style={{ gap: 6 }}>
              <div className="row small" role="radiogroup" aria-label="Call via">
                <span className="muted">Call via</span>
                <button type="button" role="radio" aria-checked={c.callVia === 'phone'} className={`btn btn-sm ${c.callVia === 'phone' ? 'btn-primary' : ''}`} onClick={() => c.setCallVia('phone')}>📱 My phone</button>
                {c.capabilities?.configured && (
                  <button type="button" role="radio" aria-checked={c.callVia === 'line'} className={`btn btn-sm ${c.callVia === 'line' ? 'btn-primary' : ''}`} onClick={() => c.setCallVia('line')}>☎️ Company line</button>
                )}
              </div>
              {c.callVia === 'phone' && (
                <div className={`small ${c.linkedPhones ? 'muted' : ''}`}>
                  {c.linkedPhones
                    ? `● Phone linked — calls open on your phone. Keep the COGNIEOS app open in “Ready for web calls” for one-click dialing.`
                    : '○ No phone linked yet: open the COGNIEOS app, sign in with this account and tap “Enable notifications”.'}
                </div>
              )}
            </div>
          )}
          {c.capabilities?.error && !call && (
            <div className="alert alert-warning small">{c.capabilities.error.message} <Link to="/calling?tab=settings">Open settings</Link></div>
          )}
          {!c.capabilities?.configured && !c.capabilities?.error && !call && (
            <div className="alert alert-info small">No telephony provider is connected. Calls use your device’s phone and are logged in the CRM. <Link to="/calling?tab=settings">Connect a provider</Link>.</div>
          )}

          {call ? (
            <>
              <div className="softphone-status">
                <div className="muted small">{label(call.direction)} · {state}</div>
                <div className="name">{c.context?.name || call.displayName || call.customerPhone}</div>
                {(c.context?.name || call.displayName) && <div className="muted small">{call.customerPhone}</div>}
                {c.context?.company && <div className="small">{c.context.company}</div>}
                <div className="timer">{state === 'Connected' || state === 'On Hold' ? duration(elapsed) : state === 'Completed' ? duration(call.durationSeconds) : '…'}</div>
                {call.recordingEnabled && live && <span className="rec-indicator"><span className="dot" /> Recording</span>}
              </div>

              {call.mode === 'native' && live && (
                <div className="stack">
                  {call.sentToDevice
                    ? <div className="alert alert-info small">📱 Sent to your phone. Tap the notification from the COGNIEOS app to dial — the app logs the outcome. If it did not arrive, log the call here:</div>
                    : <div className="small muted">Call placed with your phone. Log the outcome:</div>}
                  <div className="row">
                    <input className="input" style={{ width: 90 }} type="number" min="0" placeholder="Minutes" value={nativeLog.minutes} onChange={(e) => setNativeLog({ ...nativeLog, minutes: e.target.value })} />
                    <label className="checkbox small"><input type="checkbox" checked={nativeLog.connected} onChange={(e) => setNativeLog({ ...nativeLog, connected: e.target.checked })} /> Connected</label>
                  </div>
                  <div className="row" style={{ flexWrap: 'nowrap' }}>
                    <button type="button" className="btn" onClick={async () => { await c.hangup(); c.clear(); }}>Cancel call</button>
                    <button type="button" className="btn btn-primary" style={{ flex: 1 }} onClick={() => c.logNativeOutcome(Math.round(Number(nativeLog.minutes || 0) * 60), nativeLog.connected)}>Save call</button>
                  </div>
                </div>
              )}

              {call.mode !== 'native' && live && (
                <>
                  <div className="call-controls">
                    <button type="button" className={`btn ${c.muted ? 'active' : ''}`} onClick={c.toggleMute} disabled={!(c.deviceState === 'ready' || caps.mute)}><span className="ico">🎙️</span>{c.muted ? 'Unmute' : 'Mute'}</button>
                    {call.status === 'on_hold'
                      ? <button type="button" className="btn active" onClick={c.resume}><span className="ico">▶</span>Resume</button>
                      : <button type="button" className="btn" onClick={c.hold} disabled={!caps.hold || state !== 'Connected'}><span className="ico">⏸</span>Hold</button>}
                    <button type="button" className={`btn ${showKeypad ? 'active' : ''}`} onClick={() => setShowKeypad(!showKeypad)} disabled={!caps.dtmf && c.deviceState !== 'ready'}><span className="ico">⌨️</span>Keypad</button>
                    <button type="button" className="btn" onClick={() => setTransferOpen('transfer')} disabled={!caps.transferBlind}><span className="ico">↪</span>Transfer</button>
                    <button type="button" className="btn" onClick={() => setTransferOpen('add')} disabled={!caps.conference}><span className="ico">➕</span>Add</button>
                    <button type="button" className="btn btn-danger" onClick={c.hangup}><span className="ico">⏹</span>End</button>
                  </div>
                  {call.metadata?.consult && (
                    <div className="row">
                      <span className="small muted">Consulting…</span>
                      <button type="button" className="btn btn-sm btn-primary" onClick={() => c.transfer({ type: call.metadata.consult.type, phase: 'complete' })}>Complete transfer</button>
                      <button type="button" className="btn btn-sm" onClick={() => c.transfer({ type: call.metadata.consult.type, phase: 'cancel' })}>Cancel</button>
                    </div>
                  )}
                  {showKeypad && <Keypad onPress={press} />}
                </>
              )}

              {!live && (
                <button type="button" className="btn" onClick={c.clear}>New call</button>
              )}
              {c.context && <CallerInfo context={c.context} />}
            </>
          ) : (
            <>
              <input className="input mono" style={{ fontSize: 18, textAlign: 'center' }} placeholder="Enter number" value={number} onChange={(e) => setNumber(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && number && c.dial(number, { source: 'manual' })} aria-label="Phone number" />
              <Keypad onPress={press} />
              <div className="row" style={{ justifyContent: 'center' }}>
                <button type="button" className="btn btn-success" style={{ minWidth: 140 }} disabled={!number} onClick={() => c.dial(number, { source: 'manual' })}>📞 Call</button>
                <button type="button" className="btn btn-icon" onClick={() => setNumber((n) => n.slice(0, -1))} aria-label="Delete digit">⌫</button>
              </div>
            </>
          )}
        </div>
      )}
      {transferOpen && <TransferDialog mode={transferOpen} onClose={() => setTransferOpen(null)} />}
    </section>
  );
}

function Keypad({ onPress }) {
  return (
    <div className="dialpad">
      {KEYS.map(([k, sub]) => (
        <button type="button" key={k} onClick={() => onPress(k)}>{k}<small>{sub || ' '}</small></button>
      ))}
    </div>
  );
}

function CallerInfo({ context }) {
  return (
    <div className="card" style={{ boxShadow: 'none' }}>
      <div className="card-body stack small">
        {context.aiEscalation && (
          <div className="alert alert-info">
            <strong>AI hand-off:</strong> {context.aiEscalation.summary}
            {context.aiEscalation.intent && <div>Intent: {context.aiEscalation.intent}</div>}
          </div>
        )}
        {context.contact && <Link to={`/contacts/${context.contact.id || context.contact._id}`}>Open contact</Link>}
        {context.lead && <Link to={`/leads/${context.lead.id || context.lead._id}`}>Open lead</Link>}
        <div>Previous calls: {context.previousCalls?.length || 0}</div>
        {context.openDeals?.length > 0 && <div>Open deals: {context.openDeals.map((d) => d.name).join(', ')}</div>}
        {context.openTickets?.length > 0 && <div>Open tickets: {context.openTickets.map((t) => t.subject).join(', ')}</div>}
        {context.lastInteraction && <div className="muted">Last: {context.lastInteraction.title}</div>}
      </div>
    </div>
  );
}

/** Blind / warm / consult transfer, or add a participant (three-way / conference). */
export function TransferDialog({ mode, onClose }) {
  const c = useCalls();
  const [users, setUsers] = useState([]);
  const [queues, setQueues] = useState([]);
  const [target, setTarget] = useState({ kind: 'agent', value: '' });
  const [type, setType] = useState('blind');
  const caps = c.capabilities?.capabilities || {};
  useEffect(() => {
    get('/agents/status').then((r) => setUsers(r.items)).catch(() => {});
    get('/call-queues').then((r) => setQueues(r.items)).catch(() => {});
  }, []);
  const go = async () => {
    const t = target.kind === 'agent' ? { userId: target.value } : target.kind === 'queue' ? { queueId: target.value } : { number: target.value };
    if (mode === 'add') await c.conference(t);
    else await c.transfer({ type: target.kind === 'queue' ? 'blind' : type, phase: 'start', target: t });
    onClose();
  };
  return (
    <Modal title={mode === 'add' ? 'Add participant' : 'Transfer call'} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={!target.value} onClick={go}>{mode === 'add' ? 'Add' : 'Transfer'}</button></>}>
      <div className="stack">
        {mode === 'transfer' && (
          <Field label="Transfer type">
            <select className="input" value={type} onChange={(e) => setType(e.target.value)}>
              <option value="blind">Blind — send immediately</option>
              <option value="warm" disabled={!caps.transferWarm}>Warm — introduce, then hand over</option>
              <option value="consult" disabled={!caps.transferWarm}>Consult — customer on hold while you talk</option>
            </select>
          </Field>
        )}
        <Field label="Target">
          <select className="input" value={target.kind} onChange={(e) => setTarget({ kind: e.target.value, value: '' })}>
            <option value="agent">Agent</option>
            {mode === 'transfer' && <option value="queue">Queue</option>}
            <option value="number">External number</option>
          </select>
        </Field>
        {target.kind === 'agent' && (
          <select className="input" value={target.value} onChange={(e) => setTarget({ ...target, value: e.target.value })} aria-label="Agent">
            <option value="">Select an agent…</option>
            {users.map((u) => <option key={u.userId} value={u.userId}>{u.name} — {label(u.status)}</option>)}
          </select>
        )}
        {target.kind === 'queue' && (
          <select className="input" value={target.value} onChange={(e) => setTarget({ ...target, value: e.target.value })} aria-label="Queue">
            <option value="">Select a queue…</option>
            {queues.map((q) => <option key={q.id} value={q.id}>{q.name} ({q.agentsAvailable} available)</option>)}
          </select>
        )}
        {target.kind === 'number' && <input className="input" placeholder="+91…" value={target.value} onChange={(e) => setTarget({ ...target, value: e.target.value })} aria-label="Number" />}
      </div>
    </Modal>
  );
}
