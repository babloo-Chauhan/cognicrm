import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { get, post } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useRealtime } from '../lib/realtime.jsx';
import { isMobileDevice, TERMINAL } from './callState.js';

const CallContext = createContext(null);

export function CallProvider({ children }) {
  const { user, can, hasModule } = useAuth();
  const [capabilities, setCapabilities] = useState(null);
  const [activeCall, setActiveCall] = useState(null);
  const [incoming, setIncoming] = useState(null); // { call, context }
  const [wrapUpCall, setWrapUpCall] = useState(null);
  const [open, setOpen] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [error, setError] = useState(null);
  const [deviceState, setDeviceState] = useState('disabled');
  const [muted, setMuted] = useState(false);
  const [context, setContext] = useState(null);
  // Where desktop calls go: 'phone' (the COGNIEOS mobile app dials) or 'line' (company line / provider).
  const [callVia, setCallViaState] = useState(() => { try { return localStorage.getItem('cognieos.callVia') || 'phone'; } catch { return 'phone'; } });
  const setCallVia = useCallback((v) => { setCallViaState(v); try { localStorage.setItem('cognieos.callVia', v); } catch { /* storage unavailable */ } }, []);
  const [linkedPhones, setLinkedPhones] = useState(null);
  const deviceRef = useRef(null);
  const deviceCallRef = useRef(null);
  const pendingIncomingRef = useRef(null);
  const expectOutboundRef = useRef(false);

  useEffect(() => {
    if (!user) return undefined;
    const check = () => get('/push-tokens').then((r) => setLinkedPhones(r.devices)).catch(() => {});
    check();
    const t = setInterval(check, 30000);
    return () => clearInterval(t);
  }, [user]);

  // Only companies whose plan includes calling have telephony to ask about
  const callingEnabled = Boolean(user) && hasModule('calling');
  useEffect(() => {
    if (!callingEnabled) return;
    get('/telephony/capabilities').then(setCapabilities).catch(() => setCapabilities({ configured: false, capabilities: {} }));
    get('/calls/active').then((r) => {
      const mine = r.items.find((c) => String(c.agentId?.id || c.agentId) === String(user.id));
      if (mine) setActiveCall(mine);
    }).catch(() => {});
  }, [user, callingEnabled]);

  // Browser softphone: provider WebRTC SDK (only loaded when the provider supports it)
  useEffect(() => {
    if (!user || !capabilities?.capabilities?.webrtc || capabilities.provider !== 'twilio' || !can('calls:make')) return undefined;
    let cancelled = false;
    let device;
    (async () => {
      try {
        setDeviceState('connecting');
        const { Device } = await import('@twilio/voice-sdk');
        const { token } = await get('/telephony/token');
        if (cancelled) return;
        device = new Device(token, { codecPreferences: ['opus', 'pcmu'], closeProtection: true });
        device.on('registered', () => setDeviceState('ready'));
        device.on('error', (e) => { setDeviceState('error'); setError(e.message); });
        device.on('tokenWillExpire', async () => device.updateToken((await get('/telephony/token')).token));
        device.on('incoming', (twCall) => {
          twCall.on('disconnect', () => { deviceCallRef.current = null; setMuted(false); });
          twCall.on('cancel', () => { pendingIncomingRef.current = null; });
          // Agent-first outbound calls ring this browser: accept automatically.
          if (expectOutboundRef.current) {
            expectOutboundRef.current = false;
            twCall.accept();
            deviceCallRef.current = twCall;
          } else {
            pendingIncomingRef.current = twCall;
          }
        });
        await device.register();
        deviceRef.current = device;
      } catch (e) {
        setDeviceState('error');
        setError(`Softphone unavailable: ${e.message}`);
      }
    })();
    return () => {
      cancelled = true;
      device?.destroy();
      deviceRef.current = null;
    };
  }, [user, capabilities, can]);

  const loadContext = useCallback(async (callId) => {
    try {
      setContext(await get(`/calls/${callId}/context`));
    } catch {
      setContext(null);
    }
  }, []);

  useRealtime('call:update', (call) => {
    const mine = String(call.agentId?.id || call.agentId) === String(user?.id);
    setActiveCall((current) => {
      if (current && current.id === call.id) {
        // Placed from the agent's phone: the app does the wrap-up, the browser only follows the status.
        if (current.sentToDevice) return { ...call, sentToDevice: true, displayName: current.displayName };
        if (TERMINAL.includes(call.status)) {
          if (call.answeredAt && mine && !call.disposition?.code) setWrapUpCall(call);
          return call.answeredAt ? call : { ...call };
        }
        return call;
      }
      if (!current && mine && !TERMINAL.includes(call.status) && call.status !== 'queued') return call;
      return current;
    });
    if (incoming?.call?.id === call.id && (TERMINAL.includes(call.status) || (call.agentId && !mine))) setIncoming(null);
  });

  useRealtime('call:incoming', ({ call, context: ctx }) => {
    setIncoming({ call, context: ctx });
    setOpen(true);
    setMinimized(false);
  });

  const dial = useCallback(async (to, { related = {}, source = 'click_to_call', name } = {}) => {
    setError(null);
    setOpen(true);
    setMinimized(false);
    // Phone browser → its own dialer. Desktop → the agent's choice ("Call via"): their phone through the
    // COGNIEOS app (one click: the app dials), or the company line (softphone / bridge via the provider).
    const mobile = isMobileDevice();
    const devices = mobile ? 0 : (await get('/push-tokens').catch(() => ({ devices: 0 }))).devices;
    setLinkedPhones(devices);
    const line = capabilities?.configured ? (capabilities?.capabilities?.webrtc ? 'webrtc' : 'bridge') : null;
    let mode;
    if (mobile) mode = 'native';
    else if (callVia === 'line' && line) mode = line;
    else if (devices) mode = 'device';
    else if (line) mode = line;
    else {
      setError('No phone is linked to your account. Open the COGNIEOS app on your phone, sign in with this account and tap “Enable notifications”.');
      return null;
    }
    try {
      expectOutboundRef.current = mode === 'webrtc';
      const res = await post('/calls', { to, mode, related, name, source: mode === 'native' ? 'mobile' : source });
      setActiveCall({ ...res.call, displayName: name, sentToDevice: Boolean(res.sentToDevice) });
      loadContext(res.call.id);
      if (res.dial) window.location.href = res.dial;
      return res.call;
    } catch (e) {
      expectOutboundRef.current = false;
      setError(e.message);
      return null;
    }
  }, [capabilities, loadContext, callVia]);

  const act = useCallback(async (path, body) => {
    if (!activeCall) return;
    setError(null);
    try {
      const updated = await post(`/calls/${activeCall.id}/${path}`, body);
      if (updated?.id) setActiveCall(updated);
    } catch (e) {
      setError(e.message);
    }
  }, [activeCall]);

  const hangup = useCallback(async () => {
    deviceCallRef.current?.disconnect();
    if (activeCall && !TERMINAL.includes(activeCall.status)) await act('hangup');
  }, [act, activeCall]);

  const toggleMute = useCallback(async () => {
    const next = !muted;
    if (deviceCallRef.current) {
      deviceCallRef.current.mute(next);
      setMuted(next);
    } else if (capabilities?.capabilities?.mute) {
      await act('mute', { muted: next });
      setMuted(next);
    }
  }, [muted, act, capabilities]);

  const sendDigits = useCallback(async (digits) => {
    // With WebRTC, DTMF goes straight through the media path; otherwise via the provider API.
    if (deviceCallRef.current) deviceCallRef.current.sendDigits(digits);
    else await act('dtmf', { digits });
  }, [act]);

  const accept = useCallback(async () => {
    if (!incoming) return;
    pendingIncomingRef.current?.accept();
    deviceCallRef.current = pendingIncomingRef.current;
    pendingIncomingRef.current = null;
    setActiveCall(incoming.call);
    setContext(incoming.context);
    setIncoming(null);
  }, [incoming]);

  const reject = useCallback(() => {
    pendingIncomingRef.current?.reject();
    pendingIncomingRef.current = null;
    setIncoming(null);
  }, []);

  const finishWrapUp = useCallback(() => {
    setWrapUpCall(null);
    setActiveCall(null);
    setContext(null);
    setMuted(false);
  }, []);

  const logNativeOutcome = useCallback(async (durationSeconds, connected) => {
    if (!activeCall) return;
    const call = await post(`/calls/${activeCall.id}/log`, { durationSeconds, connected });
    setActiveCall(call);
    if (call.answeredAt) setWrapUpCall(call);
    else finishWrapUp();
  }, [activeCall, finishWrapUp]);

  const value = useMemo(() => ({
    capabilities, activeCall, incoming, wrapUpCall, open, minimized, error, deviceState, muted, context, callVia, setCallVia, linkedPhones,
    setOpen, setMinimized, setError, dial, hangup, toggleMute, sendDigits, accept, reject, finishWrapUp, logNativeOutcome,
    hold: () => act('hold'),
    resume: () => act('resume'),
    transfer: (body) => act('transfer', body),
    conference: (target) => act('conference', { target }),
    clear: () => { setActiveCall(null); setContext(null); },
  }), [capabilities, activeCall, incoming, wrapUpCall, open, minimized, error, deviceState, muted, context, callVia, setCallVia, linkedPhones, dial, hangup, toggleMute, sendDigits, accept, reject, finishWrapUp, logNativeOutcome, act]);

  return <CallContext.Provider value={value}>{children}</CallContext.Provider>;
}

export function useCalls() {
  return useContext(CallContext);
}

