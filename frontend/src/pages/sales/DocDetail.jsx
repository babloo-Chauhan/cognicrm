import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { del, get, post } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.jsx';
import { dateTime, label } from '../../lib/format.js';
import { ErrorAlert, Field, Loading, Modal, StatusBadge } from '../../components/ui.jsx';
import { useAsync } from '../../lib/hooks.js';
import { ItemsView, ProcessSteps } from './common.jsx';
import {
  copyText, customerName, docNumber, invoiceStep, money2, PAYMENT_METHODS, quoteStep, whatsappShare,
} from './salesUtils.js';

const today = () => new Date().toISOString().slice(0, 10);

function ShareBox({ doc, kind, delivery }) {
  const [copied, setCopied] = useState(false);
  const text = kind === 'quote'
    ? `Hello ${doc.customer?.name || ''}, please find our quotation ${doc.number} for ${money2(doc.totals.total, doc.currency)}: ${doc.publicUrl}`
    : `Hello ${doc.customer?.name || ''}, invoice ${doc.number} for ${money2(doc.totals.total, doc.currency)} is ready: ${doc.publicUrl}`;
  return (
    <div className="card">
      <div className="card-header"><h3>Share with customer</h3></div>
      <div className="card-body stack">
        {delivery && (
          <div className={`alert ${delivery.emailed ? 'alert-info' : 'alert-warning'}`}>
            {delivery.emailed ? 'Emailed to the customer.' : `Not emailed${delivery.emailError ? ` (${delivery.emailError})` : ''}. Share the link below instead.`}
          </div>
        )}
        <input className="input small" readOnly value={doc.publicUrl} aria-label="Customer link" onFocus={(e) => e.target.select()} />
        <div className="row">
          <button type="button" className="btn btn-sm" onClick={async () => setCopied(await copyText(doc.publicUrl))}>{copied ? 'Copied ✓' : 'Copy link'}</button>
          {doc.customer?.phone && <a className="btn btn-sm" href={whatsappShare(doc.customer.phone, text)} target="_blank" rel="noreferrer">WhatsApp</a>}
          {doc.customer?.email && <a className="btn btn-sm" href={`mailto:${doc.customer.email}?subject=${encodeURIComponent(`${kind === 'quote' ? 'Quotation' : 'Invoice'} ${doc.number}`)}&body=${encodeURIComponent(text)}`}>Email app</a>}
          <a className="btn btn-sm" href={`${doc.publicUrl}?preview=1`} target="_blank" rel="noreferrer">Customer view</a>
        </div>
        {doc.viewedAt && <p className="small muted" style={{ margin: 0 }}>Customer opened it on {dateTime(doc.viewedAt)}</p>}
      </div>
    </div>
  );
}

function SendModal({ doc, kind, onClose, onSent }) {
  const [form, setForm] = useState({ email: Boolean(doc.customer?.email), to: doc.customer?.email || '', message: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = { email: form.email, message: form.message || undefined, to: form.email && form.to ? form.to : undefined };
      onSent(await post(`/${kind === 'quote' ? 'quotes' : 'invoices'}/${doc.id}/send`, body));
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };
  return (
    <Modal
      title={kind === 'quote' ? 'Send quotation' : (doc.status === 'draft' ? 'Issue & send invoice' : 'Send invoice')}
      onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={busy} onClick={send}>{busy ? 'Sending…' : 'Send'}</button></>}
    >
      <div className="stack">
        <ErrorAlert error={error} />
        {kind === 'invoice' && doc.status === 'draft' && <div className="alert alert-info">Sending issues the invoice: it gets its invoice number and can no longer be edited.</div>}
        <label className="checkbox"><input type="checkbox" checked={form.email} onChange={(e) => setForm({ ...form, email: e.target.checked })} /> Email the link to the customer</label>
        {form.email && <Field label="Email to"><input className="input" type="email" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} /></Field>}
        <Field label="Message (optional)"><textarea className="input" value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} /></Field>
        <p className="small muted" style={{ margin: 0 }}>You’ll also get a link to share on WhatsApp or anywhere else.</p>
      </div>
    </Modal>
  );
}

function PromptModal({ title, fieldLabel, initial = '', confirm, danger, onClose, onConfirm }) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState(null);
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} onClick={() => onConfirm(value).catch(setError)}>{confirm}</button></>}
    >
      <ErrorAlert error={error} />
      <Field label={fieldLabel}><input className="input" value={value} onChange={(e) => setValue(e.target.value)} /></Field>
    </Modal>
  );
}

function PaymentModal({ invoice, onClose, onSaved }) {
  const [form, setForm] = useState({ amount: invoice.balanceDue, date: today(), method: 'bank_transfer', reference: '', note: '' });
  const [error, setError] = useState(null);
  const save = async () => {
    setError(null);
    try {
      onSaved(await post(`/invoices/${invoice.id}/payments`, { ...form, amount: Number(form.amount), reference: form.reference || undefined, note: form.note || undefined }));
    } catch (e) {
      setError(e);
    }
  };
  return (
    <Modal title="Record payment" onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" onClick={save}>Save payment</button></>}>
      <ErrorAlert error={error} />
      <div className="form-grid">
        <Field label={`Amount (balance ${money2(invoice.balanceDue, invoice.currency)})`}><input className="input" type="number" min="0" step="any" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></Field>
        <Field label="Date"><input className="input" type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></Field>
        <Field label="Method">
          <select className="input" value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}>
            {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m === 'upi' ? 'UPI' : label(m)}</option>)}
          </select>
        </Field>
        <Field label="Reference (UTR / cheque no.)"><input className="input" value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} /></Field>
        <Field label="Note" className="full"><input className="input" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

function InfoRow({ k, children }) {
  return <div className="row" style={{ justifyContent: 'space-between' }}><dt className="muted">{k}</dt><dd style={{ margin: 0, textAlign: 'right' }}>{children}</dd></div>;
}

/** Quotation or invoice page with the actions for each step of the process. */
export function DocDetail({ kind }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const isQuote = kind === 'quote';
  const path = isQuote ? 'quotes' : 'invoices';
  const { data: doc, loading, error, reload, setData } = useAsync(() => get(`/${path}/${id}`), [path, id]);
  const [modal, setModal] = useState(null);
  const [delivery, setDelivery] = useState(null);
  const [actionError, setActionError] = useState(null);

  if (loading && !doc) return <Loading />;
  if (error && !doc) return <ErrorAlert error={error} />;

  const billing = can('billing:manage');
  const act = async (fn) => {
    setActionError(null);
    try {
      await fn();
    } catch (e) {
      setActionError(e);
    }
  };
  const run = (action, body) => act(async () => {
    const res = await post(`/${path}/${id}/${action}`, body);
    setModal(null);
    if (action === 'revise') navigate(`/quotes/${res.id}`);
    else if (action === 'invoice') navigate(`/invoices/${res.id}`);
    else { setData({ ...doc, ...res }); reload(); }
  });
  const remove = () => act(async () => {
    if (!window.confirm(`Delete this draft ${isQuote ? 'quotation' : 'invoice'}?`)) return;
    await del(`/${path}/${id}`);
    navigate(`/${path}`);
  });
  const removePayment = (pid) => act(async () => {
    if (!window.confirm('Remove this payment?')) return;
    await del(`/invoices/${id}/payments/${pid}`);
    reload();
  });

  const printUrl = `${doc.publicUrl}?print=1`;
  const isDraft = doc.status === 'draft';
  const actions = [];
  if (isQuote) {
    if (isDraft) {
      actions.push(<button key="edit" type="button" className="btn" onClick={() => navigate(`/quotes/${id}/edit`)}>Edit</button>);
      actions.push(<button key="del" type="button" className="btn" onClick={remove}>Delete</button>);
      actions.push(<button key="send" type="button" className="btn btn-primary" onClick={() => setModal('send')}>Send to customer</button>);
    }
    if (doc.status === 'sent') {
      actions.push(<button key="rev" type="button" className="btn" onClick={() => run('revise')}>Revise</button>);
      actions.push(<button key="resend" type="button" className="btn" onClick={() => setModal('send')}>Resend</button>);
      actions.push(<button key="rej" type="button" className="btn" onClick={() => setModal('reject')}>Mark rejected</button>);
      actions.push(<button key="acc" type="button" className="btn btn-success" onClick={() => setModal('accept')}>Mark accepted</button>);
    }
    if (['rejected', 'expired'].includes(doc.status)) actions.push(<button key="rev" type="button" className="btn btn-primary" onClick={() => run('revise')}>Create revision</button>);
    if (doc.status === 'accepted') {
      actions.push(doc.invoiceId
        ? <Link key="inv" className="btn btn-primary" to={`/invoices/${doc.invoiceId}`}>View invoice</Link>
        : <button key="inv" type="button" className="btn btn-primary" onClick={() => run('invoice')}>Create invoice</button>);
    }
  } else {
    if (isDraft) {
      actions.push(<button key="edit" type="button" className="btn" onClick={() => navigate(`/invoices/${id}/edit`)}>Edit</button>);
      actions.push(<button key="del" type="button" className="btn" onClick={remove}>Delete</button>);
      if (billing) actions.push(<button key="issue" type="button" className="btn" onClick={() => run('issue')}>Issue</button>);
      if (billing) actions.push(<button key="send" type="button" className="btn btn-primary" onClick={() => setModal('send')}>Issue &amp; send</button>);
    } else if (doc.status !== 'void' && billing) {
      if (!doc.amountPaid) actions.push(<button key="void" type="button" className="btn" onClick={() => setModal('void')}>Void</button>);
      actions.push(<button key="send" type="button" className="btn" onClick={() => setModal('send')}>{doc.sentAt ? 'Resend' : 'Send'}</button>);
      if (doc.balanceDue > 0) actions.push(<button key="pay" type="button" className="btn btn-success" onClick={() => setModal('payment')}>Record payment</button>);
    }
  }

  const stepLinks = { 1: doc.dealId ? `/deals/${doc.dealId}` : undefined };
  if (!isQuote && doc.quoteId) stepLinks[2] = `/quotes/${doc.quoteId}`;
  if (isQuote && doc.invoiceId) stepLinks[4] = `/invoices/${doc.invoiceId}`;

  return (
    <>
      <div className="page-header">
        <div>
          <div className="small muted">{isQuote ? 'Quotation' : 'Invoice'}</div>
          <h1>{docNumber(doc, kind)}</h1>
          <div className="row" style={{ marginTop: 6 }}>
            <StatusBadge status={doc.status} />
            <span className="muted">{customerName(doc)} · {money2(doc.totals.total, doc.currency)}</span>
          </div>
        </div>
        <div className="row">
          <a className="btn" href={printUrl} target="_blank" rel="noreferrer">⬇ PDF / Print</a>
          {actions}
        </div>
      </div>
      <ProcessSteps step={isQuote ? quoteStep(doc) : invoiceStep(doc)} links={stepLinks} />
      <ErrorAlert error={actionError} />
      {!isQuote && !billing && <div className="alert alert-info" style={{ marginBottom: 12 }}>Issuing invoices and recording payments needs the billing permission (admin or supervisor).</div>}
      <div className="grid grid-detail" style={{ marginTop: 12 }}>
        <div className="stack" style={{ gap: 16 }}>
          <div className="card">
            <div className="card-header"><h3>{doc.title || 'Items'}</h3></div>
            <div className="card-body"><ItemsView doc={doc} /></div>
          </div>
          {!isQuote && doc.payments?.length > 0 && (
            <div className="card">
              <div className="card-header"><h3>Payments</h3></div>
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Date</th><th>Method</th><th>Reference</th><th style={{ textAlign: 'right' }}>Amount</th><th /></tr></thead>
                  <tbody>
                    {doc.payments.map((p) => (
                      <tr key={p.id}>
                        <td>{new Date(p.date).toLocaleDateString()}</td>
                        <td>{p.method === 'upi' ? 'UPI' : label(p.method)}</td>
                        <td>{p.reference || '—'}{p.note && <div className="small muted">{p.note}</div>}</td>
                        <td className="mono" style={{ textAlign: 'right' }}>{money2(p.amount, doc.currency)}</td>
                        <td>{billing && doc.status !== 'void' && <button type="button" className="btn btn-ghost btn-sm" onClick={() => removePayment(p.id)} aria-label="Remove payment">✕</button>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {(doc.notes || doc.terms) && (
            <div className="card">
              <div className="card-body stack small">
                {doc.notes && <div><strong>Notes</strong><div style={{ whiteSpace: 'pre-wrap' }}>{doc.notes}</div></div>}
                {doc.terms && <div><strong>Terms</strong><div style={{ whiteSpace: 'pre-wrap' }}>{doc.terms}</div></div>}
              </div>
            </div>
          )}
        </div>
        <div className="stack" style={{ gap: 16 }}>
          {!isDraft && doc.status !== 'void' && doc.status !== 'revised' && <ShareBox doc={doc} kind={kind} delivery={delivery} />}
          <div className="card">
            <div className="card-header"><h3>Details</h3></div>
            <div className="card-body">
              <dl className="stack small" style={{ margin: 0 }}>
                <InfoRow k="Customer">{doc.customer?.name || '—'}{doc.customer?.company && doc.customer.company !== doc.customer.name ? `, ${doc.customer.company}` : ''}</InfoRow>
                {doc.customer?.gstin && <InfoRow k="GSTIN">{doc.customer.gstin}</InfoRow>}
                {doc.customer?.state && <InfoRow k="Place of supply">{doc.customer.state}</InfoRow>}
                <InfoRow k="Tax">{{ intra: 'CGST + SGST', inter: 'IGST', none: 'No tax' }[doc.appliedTaxMode] || '—'}</InfoRow>
                {isQuote ? (
                  <>
                    <InfoRow k="Date">{new Date(doc.issueDate).toLocaleDateString()}</InfoRow>
                    <InfoRow k="Valid until">{doc.validUntil ? new Date(doc.validUntil).toLocaleDateString() : '—'}</InfoRow>
                    {doc.sentAt && <InfoRow k="Sent">{dateTime(doc.sentAt)}</InfoRow>}
                    {doc.acceptedAt && <InfoRow k="Accepted">{dateTime(doc.acceptedAt)}{doc.acceptedBy ? ` by ${doc.acceptedBy}` : ''}</InfoRow>}
                    {doc.rejectedAt && <InfoRow k="Rejected">{dateTime(doc.rejectedAt)}{doc.rejectionReason ? ` — ${doc.rejectionReason}` : ''}</InfoRow>}
                  </>
                ) : (
                  <>
                    <InfoRow k="Invoice date">{doc.issueDate ? new Date(doc.issueDate).toLocaleDateString() : 'On issue'}</InfoRow>
                    <InfoRow k="Due date">{doc.dueDate ? new Date(doc.dueDate).toLocaleDateString() : 'On issue'}</InfoRow>
                    {doc.paidAt && <InfoRow k="Paid">{dateTime(doc.paidAt)}</InfoRow>}
                    {doc.voidedAt && <InfoRow k="Voided">{dateTime(doc.voidedAt)}{doc.voidReason ? ` — ${doc.voidReason}` : ''}</InfoRow>}
                  </>
                )}
                {doc.dealId && <InfoRow k="Deal"><Link to={`/deals/${doc.dealId}`}>Open deal</Link></InfoRow>}
                {doc.contactId && <InfoRow k="Contact"><Link to={`/contacts/${doc.contactId}`}>Open contact</Link></InfoRow>}
              </dl>
            </div>
          </div>
          {isQuote && doc.versions?.length > 1 && (
            <div className="card">
              <div className="card-header"><h3>Versions</h3></div>
              <div className="card-body stack small">
                {doc.versions.map((v) => (
                  <div key={v.id || v._id} className="row" style={{ justifyContent: 'space-between' }}>
                    {String(v._id || v.id) === doc.id ? <strong>Rev {v.version} (this)</strong> : <Link to={`/quotes/${v._id || v.id}`}>Rev {v.version}</Link>}
                    <span><StatusBadge status={v.status} /> {money2(v.totals?.total, doc.currency)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
      {modal === 'send' && <SendModal doc={doc} kind={kind} onClose={() => setModal(null)} onSent={(res) => { setModal(null); setDelivery(res); setData({ ...doc, ...(res.quote || res.invoice) }); }} />}
      {modal === 'accept' && <PromptModal title="Mark quotation accepted" fieldLabel="Accepted by" initial={doc.customer?.name || ''} confirm="Mark accepted" onClose={() => setModal(null)} onConfirm={(v) => run('accept', { acceptedBy: v || undefined })} />}
      {modal === 'reject' && <PromptModal title="Mark quotation rejected" fieldLabel="Reason (optional)" confirm="Mark rejected" danger onClose={() => setModal(null)} onConfirm={(v) => run('reject', { reason: v || undefined })} />}
      {modal === 'void' && <PromptModal title="Void invoice" fieldLabel="Reason" confirm="Void invoice" danger onClose={() => setModal(null)} onConfirm={(v) => run('void', { reason: v || undefined })} />}
      {modal === 'payment' && <PaymentModal invoice={doc} onClose={() => setModal(null)} onSaved={(res) => { setModal(null); setData(res); }} />}
    </>
  );
}
