import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { get, patch, post } from '../../lib/api.js';
import { ErrorAlert, Field, Loading } from '../../components/ui.jsx';
import { RefSelect } from '../EntityForm.jsx';
import { TotalsTable } from './common.jsx';

const EMPTY_ITEM = { productId: null, name: '', description: '', hsnSac: '', unit: '', quantity: 1, unitPrice: 0, discountPercent: 0, taxRate: null };
const CUSTOMER_FIELDS = [
  ['name', 'Contact name'], ['company', 'Company'], ['email', 'Email'], ['phone', 'Phone'], ['gstin', 'GSTIN'], ['state', 'State (place of supply)'],
];

const toDateInput = (v) => (v ? String(v).slice(0, 10) : '');
const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v));

/** Fills blank customer fields from the selected deal / contact / account. */
async function crmCustomer({ dealId, contactId, accountId }) {
  const deal = dealId ? await get(`/deals/${dealId}`).catch(() => null) : null;
  const cId = contactId || deal?.contactId;
  const contact = cId ? await get(`/contacts/${cId}`).catch(() => null) : null;
  const aId = accountId || deal?.accountId || contact?.accountId;
  const account = aId ? await get(`/accounts/${aId}`).catch(() => null) : null;
  return {
    links: { dealId: deal?.id || dealId || null, contactId: contact?.id || null, accountId: account?.id || null },
    customer: {
      name: contact ? `${contact.firstName} ${contact.lastName || ''}`.trim() : account?.name || '',
      company: account?.name || contact?.company || '',
      email: contact?.email || '',
      phone: contact?.phone || account?.phone || '',
    },
  };
}

function ItemRow({ item, products, defaultTax, onChange, onRemove, canRemove }) {
  const set = (k, v) => onChange({ ...item, [k]: v });
  const pick = (id) => {
    const p = products.find((x) => x.id === id);
    if (!p) return onChange({ ...item, productId: null });
    return onChange({ ...item, productId: p.id, name: p.name, description: p.description || '', hsnSac: p.hsnSac || '', unit: p.unit || '', unitPrice: p.unitPrice, taxRate: p.taxRate });
  };
  return (
    <div className="item-row">
      <div className="stack" style={{ gap: 6 }}>
        <div className="row" style={{ flexWrap: 'nowrap' }}>
          {products.length > 0 && (
            <select className="input" style={{ maxWidth: 170 }} value={item.productId || ''} onChange={(e) => pick(e.target.value)} aria-label="Product">
              <option value="">Custom item</option>
              {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
          <input className="input" placeholder="Item name" value={item.name} onChange={(e) => set('name', e.target.value)} aria-label="Item name" />
        </div>
        <div className="row" style={{ flexWrap: 'nowrap' }}>
          <input className="input" placeholder="Description (optional)" value={item.description || ''} onChange={(e) => set('description', e.target.value)} aria-label="Description" />
          <input className="input" style={{ maxWidth: 110 }} placeholder="HSN/SAC" value={item.hsnSac || ''} onChange={(e) => set('hsnSac', e.target.value)} aria-label="HSN or SAC code" />
        </div>
      </div>
      <input className="input" type="number" min="0" step="any" value={item.quantity ?? ''} onChange={(e) => set('quantity', num(e.target.value))} aria-label="Quantity" />
      <input className="input" type="number" min="0" step="any" value={item.unitPrice ?? ''} onChange={(e) => set('unitPrice', num(e.target.value))} aria-label="Rate" />
      <input className="input" type="number" min="0" max="100" step="any" value={item.discountPercent ?? ''} onChange={(e) => set('discountPercent', num(e.target.value))} aria-label="Discount percent" />
      <select className="input" value={item.taxRate ?? defaultTax} onChange={(e) => set('taxRate', Number(e.target.value))} aria-label="GST rate">
        {[0, 0.25, 3, 5, 12, 18, 28].map((r) => <option key={r} value={r}>{r}%</option>)}
      </select>
      <button type="button" className="btn btn-ghost btn-icon" disabled={!canRemove} onClick={onRemove} aria-label="Remove item">✕</button>
    </div>
  );
}

/** Create / edit form for quotations (kind="quote") and invoices (kind="invoice"). */
export function DocEditor({ kind }) {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const path = kind === 'quote' ? 'quotes' : 'invoices';
  const [doc, setDoc] = useState(null);
  const [settings, setSettings] = useState(null);
  const [products, setProducts] = useState([]);
  const [calc, setCalc] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [s, p] = await Promise.all([get('/sales/settings'), get('/products', { active: 'true', limit: 200 })]);
        if (!alive) return;
        setSettings(s);
        setProducts(p.items);
        if (id) {
          const existing = await get(`/${path}/${id}`);
          if (alive) setDoc({ ...existing, customer: existing.customer || {} });
          return;
        }
        const links = { dealId: params.get('dealId'), contactId: params.get('contactId'), accountId: params.get('accountId') };
        const base = { title: '', customer: {}, items: [{ ...EMPTY_ITEM }], extraDiscount: 0, taxMode: 'auto', notes: s.defaultNotes, terms: s.defaultTerms };
        if (links.dealId || links.contactId || links.accountId) {
          const filled = await crmCustomer(links);
          if (alive) setDoc({ ...base, ...filled.links, customer: filled.customer });
        } else if (alive) setDoc(base);
      } catch (e) {
        if (alive) setError(e);
      }
    })();
    return () => { alive = false; };
  }, [id, path, params]);

  // Live totals (GST split, round off) from the server so the numbers match the saved document exactly
  const calcKey = doc ? JSON.stringify([doc.items, doc.extraDiscount, doc.taxMode, doc.customer?.state, doc.customer?.gstin]) : '';
  useEffect(() => {
    if (!doc) return undefined;
    const timer = setTimeout(() => {
      const items = doc.items.filter((i) => i.name || i.productId).map((i) => ({ ...i, name: i.name || 'Item', taxRate: i.taxRate ?? undefined }));
      post('/sales/calculate', { items, extraDiscount: doc.extraDiscount || 0, taxMode: doc.taxMode, customer: { state: doc.customer?.state, gstin: doc.customer?.gstin } })
        .then(setCalc).catch(() => {});
    }, 300);
    return () => clearTimeout(timer);
  }, [calcKey]); // eslint-disable-line react-hooks/exhaustive-deps -- calcKey captures the inputs

  if (error && !doc) return <ErrorAlert error={error} />;
  if (!doc || !settings) return <Loading />;

  const set = (k, v) => setDoc((d) => ({ ...d, [k]: v }));
  const setCustomer = (k, v) => setDoc((d) => ({ ...d, customer: { ...d.customer, [k]: v } }));
  const setItem = (i, item) => setDoc((d) => ({ ...d, items: d.items.map((x, n) => (n === i ? item : x)) }));
  const linkTo = async (key, value) => {
    const next = { dealId: doc.dealId, contactId: doc.contactId, accountId: doc.accountId, [key]: value };
    const filled = await crmCustomer(next);
    setDoc((d) => {
      const customer = { ...d.customer };
      for (const [k, v] of Object.entries(filled.customer)) if (!customer[k] && v) customer[k] = v;
      return { ...d, ...filled.links, [key]: value, customer };
    });
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    const items = doc.items.filter((i) => i.name || i.productId).map((i) => ({
      productId: i.productId || undefined, name: i.name, description: i.description || undefined, hsnSac: i.hsnSac || undefined, unit: i.unit || undefined,
      quantity: i.quantity ?? 1, unitPrice: i.unitPrice ?? 0, discountPercent: i.discountPercent ?? 0, taxRate: i.taxRate ?? settings.defaultTaxRate,
    }));
    const customer = Object.fromEntries(Object.entries(doc.customer || {}).filter(([, v]) => v !== undefined && v !== null));
    const body = {
      title: doc.title || undefined, dealId: doc.dealId || null, contactId: doc.contactId || null, accountId: doc.accountId || null,
      customer, items, extraDiscount: doc.extraDiscount || 0, taxMode: doc.taxMode, notes: doc.notes || '', terms: doc.terms || '',
    };
    if (kind === 'quote' && doc.validUntil) body.validUntil = doc.validUntil;
    if (kind === 'invoice' && doc.dueDate) body.dueDate = doc.dueDate;
    try {
      const saved = id ? await patch(`/${path}/${id}`, body) : await post(`/${path}`, body);
      navigate(`/${path}/${saved.id}`);
    } catch (e) {
      setError(e);
      setSaving(false);
    }
  };

  const title = `${id ? 'Edit' : 'New'} ${kind === 'quote' ? 'quotation' : 'invoice'}`;
  return (
    <>
      <div className="page-header">
        <div><h1>{title}</h1>{doc.number && <p>{doc.number}</p>}</div>
        <div className="row">
          <button type="button" className="btn" onClick={() => navigate(-1)}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save draft'}</button>
        </div>
      </div>
      <ErrorAlert error={error} />
      <div className="grid grid-detail" style={{ marginTop: 12 }}>
        <div className="stack" style={{ gap: 16 }}>
          <div className="card">
            <div className="card-header"><h3>Items</h3></div>
            <div className="card-body stack">
              <div className="item-row item-head small muted" aria-hidden="true"><span>Item</span><span>Qty</span><span>Rate</span><span>Disc %</span><span>GST</span><span /></div>
              {doc.items.map((item, i) => (
                <ItemRow
                  key={i}
                  item={item}
                  products={products}
                  defaultTax={settings.defaultTaxRate}
                  onChange={(it) => setItem(i, it)}
                  onRemove={() => set('items', doc.items.filter((_, n) => n !== i))}
                  canRemove={doc.items.length > 1}
                />
              ))}
              <div><button type="button" className="btn btn-sm" onClick={() => set('items', [...doc.items, { ...EMPTY_ITEM }])}>+ Add item</button></div>
              {calc && (
                <div className="row" style={{ alignItems: 'flex-start', justifyContent: 'space-between' }}>
                  <div className="stack" style={{ gap: 8, minWidth: 220 }}>
                    <Field label="Extra discount (flat amount)">
                      <input className="input" type="number" min="0" step="any" value={doc.extraDiscount ?? 0} onChange={(e) => set('extraDiscount', num(e.target.value) || 0)} />
                    </Field>
                    <Field label="Tax">
                      <select className="input" value={doc.taxMode} onChange={(e) => set('taxMode', e.target.value)}>
                        <option value="auto">Auto (by state / GSTIN)</option>
                        <option value="intra">CGST + SGST (same state)</option>
                        <option value="inter">IGST (other state)</option>
                        <option value="none">No tax</option>
                      </select>
                    </Field>
                  </div>
                  <TotalsTable totals={calc.totals} currency={settings.currency} taxMode={calc.appliedTaxMode} />
                </div>
              )}
            </div>
          </div>
          <div className="card">
            <div className="card-header"><h3>Notes &amp; terms</h3></div>
            <div className="card-body form-grid">
              <Field label="Notes (shown to the customer)" className="full"><textarea className="input" value={doc.notes || ''} onChange={(e) => set('notes', e.target.value)} /></Field>
              <Field label="Terms & conditions" className="full"><textarea className="input" value={doc.terms || ''} onChange={(e) => set('terms', e.target.value)} /></Field>
            </div>
          </div>
        </div>
        <div className="stack" style={{ gap: 16 }}>
          <div className="card">
            <div className="card-header"><h3>Customer</h3></div>
            <div className="card-body stack">
              <Field label="Deal"><RefSelect entity="deals" value={doc.dealId} onChange={(v) => linkTo('dealId', v)} /></Field>
              <Field label="Contact"><RefSelect entity="contacts" value={doc.contactId} onChange={(v) => linkTo('contactId', v)} /></Field>
              <Field label="Account"><RefSelect entity="accounts" value={doc.accountId} onChange={(v) => linkTo('accountId', v)} /></Field>
              {CUSTOMER_FIELDS.map(([k, l]) => (
                <Field key={k} label={l}><input className="input" value={doc.customer?.[k] || ''} onChange={(e) => setCustomer(k, e.target.value)} /></Field>
              ))}
              <Field label="Billing address"><textarea className="input" value={doc.customer?.address || ''} onChange={(e) => setCustomer('address', e.target.value)} /></Field>
              {settings.state ? <p className="small muted" style={{ margin: 0 }}>Your state: {settings.state}. A different customer state uses IGST.</p>
                : <p className="small muted" style={{ margin: 0 }}>Set your company state and GSTIN in Settings → Billing for correct GST.</p>}
            </div>
          </div>
          <div className="card">
            <div className="card-header"><h3>Details</h3></div>
            <div className="card-body stack">
              <Field label="Subject / title"><input className="input" value={doc.title || ''} onChange={(e) => set('title', e.target.value)} /></Field>
              {kind === 'quote'
                ? <Field label="Valid until"><input className="input" type="date" value={toDateInput(doc.validUntil)} onChange={(e) => set('validUntil', e.target.value || null)} /></Field>
                : <Field label="Due date (default: payment terms when issued)"><input className="input" type="date" value={toDateInput(doc.dueDate)} onChange={(e) => set('dueDate', e.target.value || null)} /></Field>}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
