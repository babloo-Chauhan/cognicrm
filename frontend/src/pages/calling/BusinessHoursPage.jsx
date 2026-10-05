import { useState } from 'react';
import { get, post, put } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.jsx';
import { DataTable, ErrorAlert, Field, Modal, StatusBadge } from '../../components/ui.jsx';
import { useAsync } from '../../lib/hooks.js';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function HoursEditor({ initial, onClose, onSaved }) {
  const [bh, setBh] = useState(initial);
  const [error, setError] = useState(null);
  const [holiday, setHoliday] = useState({ date: '', name: '' });
  const [special, setSpecial] = useState({ date: '', open: '10:00', close: '14:00', closed: false });
  const rangeFor = (day) => bh.weekly.find((w) => w.day === day);
  const toggleDay = (day, on) => setBh({ ...bh, weekly: on ? [...bh.weekly, { day, open: '09:00', close: '18:00' }] : bh.weekly.filter((w) => w.day !== day) });
  const setRange = (day, k, v) => setBh({ ...bh, weekly: bh.weekly.map((w) => (w.day === day ? { ...w, [k]: v } : w)) });
  const save = async () => {
    setError(null);
    const body = { name: bh.name, timezone: bh.timezone, weekly: bh.weekly, holidays: bh.holidays, specialHours: bh.specialHours };
    try {
      if (bh.id) await put(`/business-hours/${bh.id}`, body);
      else await post('/business-hours', body);
      onSaved();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <Modal title={bh.id ? bh.name : 'New schedule'} size="lg" onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" onClick={save}>Save</button></>}>
      <ErrorAlert error={error} />
      <div className="stack">
        <div className="form-grid">
          <Field label="Name"><input className="input" value={bh.name} onChange={(e) => setBh({ ...bh, name: e.target.value })} /></Field>
          <Field label="Time zone"><input className="input" value={bh.timezone} onChange={(e) => setBh({ ...bh, timezone: e.target.value })} placeholder="Asia/Kolkata" /></Field>
        </div>
        <table className="table">
          <tbody>
            {DAYS.map((d, i) => {
              const r = rangeFor(i);
              return (
                <tr key={d}>
                  <td style={{ width: 160 }}><label className="checkbox"><input type="checkbox" checked={Boolean(r)} onChange={(e) => toggleDay(i, e.target.checked)} /> {d}</label></td>
                  <td>{r ? <span className="row"><input className="input" type="time" style={{ width: 130 }} value={r.open} onChange={(e) => setRange(i, 'open', e.target.value)} /> – <input className="input" type="time" style={{ width: 130 }} value={r.close} onChange={(e) => setRange(i, 'close', e.target.value)} /></span> : <span className="muted">Closed</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <h3>Holidays</h3>
        <div className="row">{bh.holidays.map((h) => <span key={h.date} className="badge">{h.date} {h.name} <button type="button" className="btn btn-ghost btn-sm" onClick={() => setBh({ ...bh, holidays: bh.holidays.filter((x) => x.date !== h.date) })}>✕</button></span>)}</div>
        <div className="row">
          <input className="input" type="date" style={{ width: 170 }} value={holiday.date} onChange={(e) => setHoliday({ ...holiday, date: e.target.value })} aria-label="Holiday date" />
          <input className="input" style={{ width: 200 }} placeholder="Name" value={holiday.name} onChange={(e) => setHoliday({ ...holiday, name: e.target.value })} />
          <button type="button" className="btn btn-sm" disabled={!holiday.date} onClick={() => { setBh({ ...bh, holidays: [...bh.holidays, holiday] }); setHoliday({ date: '', name: '' }); }}>Add holiday</button>
        </div>
        <h3>Special hours</h3>
        <div className="row">{bh.specialHours.map((s) => <span key={s.date} className="badge">{s.date} {s.closed ? 'closed' : `${s.open}–${s.close}`} <button type="button" className="btn btn-ghost btn-sm" onClick={() => setBh({ ...bh, specialHours: bh.specialHours.filter((x) => x.date !== s.date) })}>✕</button></span>)}</div>
        <div className="row">
          <input className="input" type="date" style={{ width: 170 }} value={special.date} onChange={(e) => setSpecial({ ...special, date: e.target.value })} aria-label="Special date" />
          {!special.closed && <><input className="input" type="time" style={{ width: 120 }} value={special.open} onChange={(e) => setSpecial({ ...special, open: e.target.value })} /><input className="input" type="time" style={{ width: 120 }} value={special.close} onChange={(e) => setSpecial({ ...special, close: e.target.value })} /></>}
          <label className="checkbox small"><input type="checkbox" checked={special.closed} onChange={(e) => setSpecial({ ...special, closed: e.target.checked })} /> Closed</label>
          <button type="button" className="btn btn-sm" disabled={!special.date} onClick={() => { setBh({ ...bh, specialHours: [...bh.specialHours, special.closed ? { date: special.date, closed: true } : special] }); setSpecial({ date: '', open: '10:00', close: '14:00', closed: false }); }}>Add</button>
        </div>
      </div>
    </Modal>
  );
}

export function BusinessHoursPage() {
  const { can } = useAuth();
  const { data, error, reload } = useAsync(() => get('/business-hours'), []);
  const [editing, setEditing] = useState(null);
  const manage = can('business_hours:manage');
  return (
    <div className="stack">
      <div className="row">
        <span className="muted">Schedules decide open / closed / holiday routing for numbers and IVR flows.</span>
        {manage && <button type="button" className="btn btn-primary right" onClick={() => setEditing({ name: '', timezone: 'Asia/Kolkata', weekly: [], holidays: [], specialHours: [] })}>+ New schedule</button>}
      </div>
      <ErrorAlert error={error} />
      <div className="card">
        <DataTable
          rows={data?.items}
          onRowClick={manage ? setEditing : undefined}
          columns={[
            { key: 'name', label: 'Schedule' },
            { key: 'timezone', label: 'Time zone' },
            { key: 'weekly', label: 'Weekly hours', render: (b) => b.weekly.map((w) => `${DAYS[w.day].slice(0, 3)} ${w.open}–${w.close}`).join(', ') || '—' },
            { key: 'holidays', label: 'Holidays', render: (b) => b.holidays.length },
            { key: 'now', label: 'Right now', render: (b) => <StatusBadge status={b.currentStatus === 'open' ? 'open' : b.currentStatus === 'holiday' ? 'paused' : 'closed'} text={b.currentStatus} /> },
          ]}
        />
      </div>
      {editing && <HoursEditor initial={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
    </div>
  );
}
