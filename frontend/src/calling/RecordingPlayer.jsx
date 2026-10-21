import { useCallback, useEffect, useRef, useState } from 'react';
import { get } from '../lib/api.js';

const SPEEDS = [1, 1.25, 1.5, 2];
const clock = (s) => {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

/** Play / pause, ±10 s, a seek bar over the whole call, elapsed / total time and playback speed. */
function Player({ src }) {
  const audio = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [length, setLength] = useState(0);
  const [speed, setSpeed] = useState(1);
  useEffect(() => { if (audio.current) audio.current.playbackRate = speed; }, [speed]);
  const seek = (t) => {
    const a = audio.current;
    if (!a) return;
    a.currentTime = Math.min(Math.max(0, t), length || a.duration || 0);
    setTime(a.currentTime);
  };
  const toggle = () => {
    const a = audio.current;
    if (a.paused) a.play().catch(() => {});
    else a.pause();
  };
  return (
    <div style={{ display: 'grid', gap: 4, minWidth: 250, width: '100%' }}>
      <audio
        ref={audio}
        src={src}
        autoPlay
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => { setLength(e.currentTarget.duration); e.currentTarget.playbackRate = speed; }}
        onDurationChange={(e) => setLength(e.currentTarget.duration)}
      />
      <div className="row" style={{ gap: 4, alignItems: 'center', flexWrap: 'nowrap' }}>
        <button type="button" className="btn btn-sm" onClick={() => seek(time - 10)} title="Back 10 seconds" aria-label="Back 10 seconds">⏪ 10</button>
        <button type="button" className="btn btn-sm btn-primary" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'} style={{ minWidth: 34 }}>{playing ? '❚❚' : '▶'}</button>
        <button type="button" className="btn btn-sm" onClick={() => seek(time + 10)} title="Forward 10 seconds" aria-label="Forward 10 seconds">10 ⏩</button>
        <span className="small muted" style={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', marginLeft: 'auto' }}>{clock(time)} / {clock(length)}</span>
        <select className="input" value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Playback speed" style={{ width: 'auto', padding: '0 4px', height: 26, fontSize: 12 }}>
          {SPEEDS.map((s) => <option key={s} value={s}>{s}×</option>)}
        </select>
      </div>
      {/* The whole call: drag anywhere to jump there */}
      <input
        type="range"
        min={0}
        max={length || 0}
        step={0.1}
        value={Math.min(time, length || 0)}
        onChange={(e) => seek(Number(e.target.value))}
        aria-label="Position in the recording"
        style={{ width: '100%', accentColor: 'var(--primary)', margin: 0 }}
      />
    </div>
  );
}

/** Fetches a short-lived signed URL on demand; recordings are never public. `autoLoad` starts at once. */
export function RecordingPlayer({ recordingId, callId, autoLoad = false }) {
  const [src, setSrc] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(async () => {
    setError(null);
    try {
      let id = recordingId;
      if (!id && callId) {
        const detail = await get(`/calls/${callId}`);
        id = detail.recordings?.[0]?.id;
      }
      if (!id) throw new Error('No recording');
      const { url } = await get(`/recordings/${id}/url`);
      setSrc(url);
    } catch (e) {
      setError(e.message);
    }
  }, [recordingId, callId]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch the signed link when asked to start right away
    if (autoLoad) load();
  }, [autoLoad, load]);
  if (src) return <Player src={src} />;
  if (autoLoad && !error) return <span className="small muted">Loading recording…</span>;
  return (
    <span className="row">
      <button type="button" className="btn btn-sm" onClick={load}>▶ Play</button>
      {error && <span className="small" style={{ color: 'var(--danger)' }}>{error}</span>}
    </span>
  );
}
