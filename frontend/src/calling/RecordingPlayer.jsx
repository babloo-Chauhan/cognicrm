import { useState } from 'react';
import { get } from '../lib/api.js';

/** Fetches a short-lived signed URL on demand; recordings are never public. */
export function RecordingPlayer({ recordingId, callId }) {
  const [src, setSrc] = useState(null);
  const [error, setError] = useState(null);
  const load = async () => {
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
  };
  if (src) return <audio controls autoPlay src={src} style={{ height: 32, maxWidth: 260 }} />;
  return (
    <span className="row">
      <button type="button" className="btn btn-sm" onClick={load}>▶ Play</button>
      {error && <span className="small" style={{ color: 'var(--danger)' }}>{error}</span>}
    </span>
  );
}
