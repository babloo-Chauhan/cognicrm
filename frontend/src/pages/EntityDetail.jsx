import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { get, patch, post } from '../lib/api.js';
import { dateTime, label, money } from '../lib/format.js';
import { ErrorAlert, Loading, Modal, StatusBadge } from '../components/ui.jsx';
import { useAsync } from '../lib/hooks.js';
import { Timeline } from '../components/Timeline.jsx';
import { ContactActions } from '../calling/CallButton.jsx';
import { useCalls } from '../calling/CallContext.jsx';
import { ENTITY_CONFIG } from './entities.js';
import { useAuth } from '../lib/auth.jsx';
import { EntityForm } from './EntityForm.jsx';
import { CallbackModal } from '../calling/CallbackModal.jsx';
import { DocList } from './sales/DocList.jsx';
import { ProcessSteps } from './sales/common.jsx';

const PRIORITY_TONE = { high: 'danger', medium: 'warning', low: '' };

function NextBestAction({ kind, id, phone, name }) {
  const { dial } = useCalls();
  const { data, error } = useAsync(() => get(`/ai/next-best-action/${kind}/${id}`), [kind, id]);
  if (error) return null;
  if (!data) return <Loading />;
  return (
    <div className="card">
      <div className="card-header"><h3>Next best action</h3><span className="badge badge-info">Score {data.score}</span></div>
      <div className="card-body stack">
        {data.suggestions.slice(0, 4).map((s, i) => (
          <div key={i} className="stack" style={{ gap: 4 }}>
            <div className="row">
              <span className={`badge ${PRIORITY_TONE[s.priority] ? `badge-${PRIORITY_TONE[s.priority]}` : ''}`}>{s.priority}</span>
              <strong>{s.title}</strong>
              {s.action === 'call' && phone && <button type="button" className="btn btn-sm btn-success right" onClick={() => dial(phone, { related: { [`${kind}Id`]: id }, name })}>Call</button>}
            </div>
            <div className="small muted">Why: {s.reasons.join(' · ')}</div>
          </div>
        ))}
        <details className="small">
          <summary className="muted">Score breakdown</summary>
          <ul>{data.scoreFactors.map((f) => <li key={f.factor}>{f.detail}: {f.points > 0 ? '+' : ''}{f.points}</li>)}</ul>
        </details>
      </div>
    </div>
  );
}

/** Quotations and invoices linked to a deal, contact or account, with a shortcut to start a quotation. */
function SalesDocs({ type, id }) {
  const navigate = useNavigate();
  const [tab, setTab] = useState('quote');
  const key = `${type}Id`;
  return (
    <div className="card">
      <div className="card-header">
        <div className="row">
          <button type="button" className={`btn btn-sm ${tab === 'quote' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab('quote')}>Quotations</button>
          <button type="button" className={`btn btn-sm ${tab === 'invoice' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab('invoice')}>Invoices</button>
        </div>
        <button type="button" className="btn btn-sm" onClick={() => navigate(`/${tab === 'quote' ? 'quotes' : 'invoices'}/new?${key}=${id}`)}>
          + New {tab === 'quote' ? 'quotation' : 'invoice'}
        </button>
      </div>
      <DocList kind={tab} filter={{ [key]: id }} embedded />
    </div>
  );
}

const DEAL_STEP = { won: 3, lost: 1 };

function Notes({ type, id }) {
  const [body, setBody] = useState('');
  const add = async () => {
    await post('/notes', { body, related: { [`${type}Id`]: id } });
    setBody('');
  };
  return (
    <div className="row" style={{ flexWrap: 'nowrap' }}>
      <input className="input" placeholder="Add a note…" value={body} onChange={(e) => setBody(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && body && add()} />
      <button type="button" className="btn" disabled={!body} onClick={add}>Add</button>
    </div>
  );
}

export function EntityDetail({ entity }) {
  const { id } = useParams();
  const { hasModule } = useAuth();
  const navigate = useNavigate();
  const cfg = ENTITY_CONFIG[entity];
  const { data, loading, error, reload } = useAsync(() => get(`/${entity}/${id}`), [entity, id]);
  const [editing, setEditing] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [aiResult, setAiResult] = useState(null);
  const [scheduling, setScheduling] = useState(false);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorAlert error={error} />;
  const related = { [`${cfg.type}Id`]: data.id };

  const save = async () => {
    setSaveError(null);
    try {
      await patch(`/${entity}/${id}`, editing);
      setEditing(null);
      reload();
    } catch (e) {
      setSaveError(e);
    }
  };
  const convert = async () => {
    const res = await post(`/leads/${id}/convert`, {});
    // Next step of the sales process is quoting the new deal
    navigate(res.deal ? `/deals/${res.deal.id}` : `/contacts/${res.contact.id}`);
  };
  const qualify = async () => {
    try {
      setAiResult(await post(`/ai/qualify/lead/${id}`));
    } catch (e) {
      setAiResult({ error: e.message });
    }
  };

  return (
    <>
      <div className="page-header">
        <div>
          <div className="small muted">{cfg.singular}</div>
          <h1>{cfg.nameOf(data)}</h1>
          <div className="row" style={{ marginTop: 6 }}>
            {data.status && <StatusBadge status={data.status} />}
            {data.stage && <StatusBadge status={data.stage} />}
            {data.score != null && <span className="badge badge-info">Score {data.score}</span>}
          </div>
        </div>
        <div className="row">
          <ContactActions phone={data.phone} email={data.email} name={cfg.nameOf(data)} related={related} />
          {data.phone && <button type="button" className="btn" onClick={() => setScheduling(true)}>📅 Callback</button>}
          {entity === 'leads' && data.status !== 'converted' && <button type="button" className="btn" onClick={qualify}>🤖 Qualify</button>}
          {entity === 'leads' && data.status !== 'converted' && <button type="button" className="btn" onClick={convert}>Convert</button>}
          <button type="button" className="btn btn-primary" onClick={() => setEditing(data)}>Edit</button>
        </div>
      </div>
      {entity === 'leads' && <ProcessSteps step={data.status === 'converted' ? 1 : 0} />}
      {entity === 'deals' && <ProcessSteps step={DEAL_STEP[data.stage] ?? (data.stage === 'proposal' || data.stage === 'negotiation' ? 2 : 1)} links={data.leadId ? { 0: `/leads/${data.leadId}` } : {}} />}
      {entity === 'deals' && data.stage !== 'won' && data.stage !== 'lost' && (
        <div className="alert alert-info row" style={{ marginBottom: 12 }}>
          <span>Next step: send this customer a quotation.</span>
          <button type="button" className="btn btn-sm btn-primary right" onClick={() => navigate(`/quotes/new?dealId=${data.id}`)}>Create quotation</button>
        </div>
      )}
      {aiResult && (
        <div className={`alert ${aiResult.error ? 'alert-warning' : 'alert-info'}`} style={{ marginBottom: 16 }}>
          {aiResult.error || `${aiResult.qualified ? 'Qualified' : 'Not qualified yet'} — ${aiResult.reasoning}`}
        </div>
      )}
      <div className="grid grid-detail">
        <div className="stack" style={{ gap: 16 }}>
          {['deals', 'contacts', 'accounts'].includes(entity) && <SalesDocs type={cfg.type} id={data.id} />}
          <div className="card">
            <div className="card-header"><h3>Activity timeline</h3></div>
            <div className="card-body stack">
              <Notes type={cfg.type} id={data.id} />
              <Timeline entityType={cfg.type} entityId={data.id} />
            </div>
          </div>
        </div>
        <div className="stack" style={{ gap: 16 }}>
          <div className="card">
            <div className="card-header"><h3>Details</h3></div>
            <div className="card-body">
              <dl className="stack small" style={{ margin: 0 }}>
                {cfg.fields.filter((f) => f.type !== 'ref').map((f) => (
                  <div key={f.key} className="row" style={{ justifyContent: 'space-between' }}>
                    <dt className="muted">{f.label}</dt>
                    <dd style={{ margin: 0, textAlign: 'right' }}>
                      {f.type === 'checkbox' ? (data[f.key] ? 'Yes' : 'No')
                        : f.key === 'value' || f.key === 'estimatedValue' ? money(data[f.key])
                          : f.type === 'date' || f.type === 'datetime' ? dateTime(data[f.key])
                            : f.type === 'select' ? label(data[f.key]) : (data[f.key] || '—')}
                    </dd>
                  </div>
                ))}
                <div className="row" style={{ justifyContent: 'space-between' }}><dt className="muted">Created</dt><dd style={{ margin: 0 }}>{dateTime(data.createdAt)}</dd></div>
              </dl>
            </div>
          </div>
          {(entity === 'leads' || entity === 'deals') && hasModule('ai') && <NextBestAction kind={cfg.type} id={data.id} phone={data.phone} name={cfg.nameOf(data)} />}
        </div>
      </div>
      {scheduling && <CallbackModal phone={data.phone} name={cfg.nameOf(data)} related={related} onClose={() => setScheduling(false)} />}
      {editing && (
        <Modal title={`Edit ${cfg.singular}`} onClose={() => setEditing(null)} footer={<><button type="button" className="btn" onClick={() => setEditing(null)}>Cancel</button><button type="button" className="btn btn-primary" onClick={save}>Save</button></>}>
          <ErrorAlert error={saveError} />
          <EntityForm entity={entity} value={editing} onChange={setEditing} />
        </Modal>
      )}
    </>
  );
}
