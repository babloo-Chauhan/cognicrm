import { useState } from 'react';
import { del, get, patch, post } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useAsync } from '../lib/hooks.js';
import { money } from '../lib/format.js';
import {
  ConfirmDialog, ErrorAlert, Field, Modal, Skeleton,
} from '../components/ui.jsx';
import { toast } from '../lib/toast.js';

function PipelineModal({ initial, onClose, onSaved }) {
  const [name, setName] = useState(initial.name || '');
  const [isDefault, setIsDefault] = useState(Boolean(initial.isDefault));
  // Won/Lost are always appended by the server, so the editor shows only the working stages
  const [stages, setStages] = useState((initial.stages || [{ label: 'New' }, { label: 'Qualified' }, { label: 'Proposal' }]).filter((s) => !['won', 'lost'].includes(s.key)));
  const [error, setError] = useState(null);
  const update = (i, k, v) => setStages(stages.map((s, j) => (j === i ? { ...s, [k]: v } : s)));
  const move = (i, d) => {
    const next = [...stages];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    setStages(next);
  };
  const save = async () => {
    setError(null);
    try {
      const body = { name, isDefault, stages: stages.map((s) => ({ key: s.key, label: s.label, probability: Number(s.probability) || 0 })) };
      if (initial.id) await patch(`/pipelines/${initial.id}`, body);
      else await post('/pipelines', body);
      toast('Pipeline saved');
      onSaved();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <Modal size="lg" title={initial.id ? `Pipeline: ${initial.name}` : 'New pipeline'} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" onClick={save}>Save</button></>}>
      <div className="stack">
        <ErrorAlert error={error} />
        <div className="form-grid">
          <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <label className="checkbox"><input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} /> Default pipeline for new deals</label>
        </div>
        <h3>Stages</h3>
        {stages.map((s, i) => (
          <div key={s.key || i} className="row">
            <span className="muted mono" style={{ width: 22 }}>{i + 1}</span>
            <input className="input" style={{ flex: 1, minWidth: 140 }} value={s.label} onChange={(e) => update(i, 'label', e.target.value)} aria-label={`Stage ${i + 1} name`} />
            <input className="input" style={{ width: 90 }} type="number" min="0" max="100" value={s.probability ?? 0} onChange={(e) => update(i, 'probability', e.target.value)} aria-label="Win probability %" title="Win probability %" />
            <button type="button" className="btn btn-sm btn-ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">↑</button>
            <button type="button" className="btn btn-sm btn-ghost" disabled={i === stages.length - 1} onClick={() => move(i, 1)} aria-label="Move down">↓</button>
            <button type="button" className="btn btn-sm btn-ghost" disabled={stages.length <= 1} onClick={() => setStages(stages.filter((_, j) => j !== i))} aria-label="Remove stage">✕</button>
          </div>
        ))}
        <button type="button" className="btn btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => setStages([...stages, { label: '', probability: 50 }])}>+ Add stage</button>
        <p className="small muted" style={{ margin: 0 }}>Every pipeline ends with Won and Lost so reports stay comparable.</p>
      </div>
    </Modal>
  );
}

export function Pipelines() {
  const { can } = useAuth();
  const pipelines = useAsync(() => get('/pipelines'), []);
  const deals = useAsync(() => get('/deals', { limit: 200 }), []);
  const [form, setForm] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const manage = can('pipelines:manage');
  if (!pipelines.data) return pipelines.error ? <ErrorAlert error={pipelines.error} /> : <Skeleton />;
  const dealsOf = (p, stage) => (deals.data?.items || []).filter((d) => (String(d.pipelineId || '') === p.id || (!d.pipelineId && p.isDefault)) && d.stage === stage);
  return (
    <>
      <div className="page-header">
        <div><h1>Pipelines</h1><p>Your company’s sales processes and the deals in each stage.</p></div>
        {manage && <button type="button" className="btn btn-primary" onClick={() => setForm({})}>+ New pipeline</button>}
      </div>
      <div className="stack">
        {pipelines.data.items.map((p) => (
          <div key={p.id} className="card">
            <div className="card-header">
              <h3>{p.name} {p.isDefault && <span className="badge badge-info">Default</span>}</h3>
              {manage && (
                <div className="row">
                  <button type="button" className="btn btn-sm" onClick={() => setForm(p)}>Edit</button>
                  {!p.isDefault && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirm(p)}>Delete</button>}
                </div>
              )}
            </div>
            <div className="card-body" style={{ overflowX: 'auto' }}>
              <div className="row" style={{ flexWrap: 'nowrap', alignItems: 'stretch' }}>
                {p.stages.map((s) => {
                  const list = dealsOf(p, s.key);
                  return (
                    <div key={s.key} style={{ minWidth: 160, flex: 1, background: 'var(--surface-2)', borderRadius: 8, padding: 10 }}>
                      <div className="small" style={{ fontWeight: 600 }}>{s.label} <span className="muted">· {s.probability}%</span></div>
                      <div className="small muted">{list.length} deals · {money(list.reduce((a, d) => a + (d.value || 0), 0))}</div>
                      {list.slice(0, 5).map((d) => <div key={d.id} className="small" style={{ marginTop: 6 }}>{d.name}</div>)}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        ))}
      </div>
      {form && <PipelineModal initial={form} onClose={() => setForm(null)} onSaved={() => { setForm(null); pipelines.reload(); }} />}
      {confirm && <ConfirmDialog title="Delete pipeline" message={`Delete ${confirm.name}? Pipelines with deals cannot be deleted.`} danger confirmLabel="Delete" onConfirm={async () => { await del(`/pipelines/${confirm.id}`); pipelines.reload(); }} onClose={() => setConfirm(null)} />}
    </>
  );
}
