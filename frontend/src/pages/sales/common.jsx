import { Link } from 'react-router-dom';
import { money2 } from './salesUtils.js';

/**
 * Where a record is in the sales process: Lead → Deal → Quotation → Accepted → Invoice → Paid.
 * `step` is the index of the current step; earlier steps show as done.
 */
const STEPS = ['Lead', 'Deal', 'Quotation sent', 'Accepted', 'Invoiced', 'Paid'];
export function ProcessSteps({ step, links = {} }) {
  return (
    <ol className="process-steps" aria-label="Sales process">
      {STEPS.map((s, i) => {
        const state = i < step ? 'done' : i === step ? 'current' : '';
        const content = links[i] ? <Link to={links[i]}>{s}</Link> : s;
        return <li key={s} className={state} aria-current={state === 'current' ? 'step' : undefined}><span className="dot">{i < step ? '✓' : i + 1}</span>{content}</li>;
      })}
    </ol>
  );
}

/** Items + totals table (read-only view used on detail pages). */
export function ItemsView({ doc }) {
  const cur = doc.currency;
  const t = doc.totals || {};
  const row = (k, v, strong) => (
    <tr><td>{strong ? <strong>{k}</strong> : k}</td><td className="mono" style={{ textAlign: 'right' }}>{strong ? <strong>{v}</strong> : v}</td></tr>
  );
  const fmt = (v) => money2(v, cur);
  return (
    <>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Item</th><th style={{ textAlign: 'right' }}>Qty</th><th style={{ textAlign: 'right' }}>Rate</th><th style={{ textAlign: 'right' }}>Disc.</th><th style={{ textAlign: 'right' }}>GST</th><th style={{ textAlign: 'right' }}>Total</th></tr></thead>
          <tbody>
            {doc.items.map((i, n) => (
              <tr key={n}>
                <td><strong>{i.name}</strong>{i.hsnSac && <span className="small muted"> · HSN/SAC {i.hsnSac}</span>}{i.description && <div className="small muted">{i.description}</div>}</td>
                <td className="mono" style={{ textAlign: 'right' }}>{i.quantity} {i.unit || ''}</td>
                <td className="mono" style={{ textAlign: 'right' }}>{fmt(i.unitPrice)}</td>
                <td className="mono" style={{ textAlign: 'right' }}>{i.discountPercent ? `${i.discountPercent}%` : '—'}</td>
                <td className="mono" style={{ textAlign: 'right' }}>{doc.appliedTaxMode === 'none' ? '—' : `${i.taxRate}%`}</td>
                <td className="mono" style={{ textAlign: 'right' }}>{fmt(i.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <TotalsTable totals={t} currency={cur} taxMode={doc.appliedTaxMode} extra={(
        <>
          {doc.amountPaid > 0 && row('Paid', `− ${fmt(doc.amountPaid)}`)}
          {doc.balanceDue !== undefined && doc.status && doc.status !== 'draft' && doc.status !== 'void' && row('Balance due', fmt(doc.balanceDue), true)}
        </>
      )} />
    </>
  );
}

export function TotalsTable({ totals: t = {}, currency, taxMode, extra }) {
  const fmt = (v) => money2(v, currency);
  const row = (k, v, strong) => (
    <tr key={k}><td>{strong ? <strong>{k}</strong> : k}</td><td className="mono" style={{ textAlign: 'right' }}>{strong ? <strong>{v}</strong> : v}</td></tr>
  );
  return (
    <table className="totals-table">
      <tbody>
        {row('Subtotal', fmt(t.subtotal))}
        {t.discountTotal > 0 && row('Discount', `− ${fmt(t.discountTotal)}`)}
        {row('Taxable amount', fmt(t.taxableAmount))}
        {taxMode === 'intra' && row('CGST', fmt(t.cgst))}
        {taxMode === 'intra' && row('SGST', fmt(t.sgst))}
        {taxMode === 'inter' && row('IGST', fmt(t.igst))}
        {t.roundOff ? row('Round off', fmt(t.roundOff)) : null}
        {row('Total', fmt(t.total), true)}
        {extra}
      </tbody>
    </table>
  );
}
