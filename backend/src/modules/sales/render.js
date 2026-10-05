import { amountInWords } from './calc.js';

/** Server-rendered quotation / invoice page: the customer's view, the print view and "Save as PDF". */

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const nl = (v) => esc(v).replace(/\n/g, '<br>');

function money(v, currency = 'INR') {
  try {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency, minimumFractionDigits: 2 }).format(v || 0);
  } catch {
    return `${currency} ${Number(v || 0).toFixed(2)}`;
  }
}

const date = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const label = (s) => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

const STYLE = `
  :root { --ink:#1f2933; --muted:#616e7c; --line:#e4e7eb; --accent:#2457d6; --ok:#137a3f; --warn:#a15c07; --bad:#b42318; }
  * { box-sizing: border-box; }
  body { margin:0; background:#f3f4f6; color:var(--ink); font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  .page { max-width: 860px; margin: 24px auto; background:#fff; padding: 36px 40px; border-radius: 10px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  header { display:flex; justify-content:space-between; gap:24px; align-items:flex-start; border-bottom:2px solid var(--ink); padding-bottom:16px; }
  h1 { margin:0; font-size:26px; letter-spacing:.5px; } h2 { margin:0 0 4px; font-size:18px; }
  .muted { color:var(--muted); } .small { font-size:12px; } .right { text-align:right; }
  .meta { display:grid; grid-template-columns: auto auto; gap:2px 16px; font-size:13px; }
  .parties { display:grid; grid-template-columns:1fr 1fr; gap:24px; margin:20px 0; }
  .box h3 { margin:0 0 6px; font-size:12px; text-transform:uppercase; letter-spacing:.6px; color:var(--muted); }
  table { width:100%; border-collapse:collapse; } th, td { padding:8px 6px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { background:#f8fafc; font-size:12px; text-align:left; color:var(--muted); text-transform:uppercase; letter-spacing:.4px; }
  td.num, th.num { text-align:right; white-space:nowrap; }
  .totals { margin-left:auto; width: 320px; margin-top:12px; } .totals td { border:0; padding:4px 6px; }
  .totals tr.grand td { border-top:2px solid var(--ink); font-size:16px; font-weight:700; padding-top:8px; }
  .words { margin-top:8px; font-style:italic; }
  .status { display:inline-block; padding:3px 10px; border-radius:999px; font-weight:600; font-size:12px; background:#eef2ff; color:var(--accent); }
  .status.accepted, .status.paid { background:#e7f6ec; color:var(--ok); } .status.rejected, .status.void, .status.overdue, .status.expired { background:#fdecea; color:var(--bad); }
  .status.partially_paid { background:#fff4e5; color:var(--warn); }
  .section { margin-top:22px; } .section h3 { font-size:13px; margin:0 0 6px; }
  .actions { margin-top:28px; padding:18px; border:1px solid var(--line); border-radius:10px; background:#fafbfc; }
  .actions form { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin:8px 0; }
  input[type=text] { flex:1; min-width:200px; padding:8px 10px; border:1px solid #cbd2d9; border-radius:6px; font:inherit; }
  button { padding:9px 16px; border-radius:6px; border:1px solid #cbd2d9; background:#fff; font:inherit; font-weight:600; cursor:pointer; }
  button.primary { background:var(--ok); border-color:var(--ok); color:#fff; } button.danger { color:var(--bad); }
  .banner { padding:12px 16px; border-radius:8px; margin-bottom:16px; font-weight:600; }
  .banner.ok { background:#e7f6ec; color:var(--ok); } .banner.bad { background:#fdecea; color:var(--bad); } .banner.info { background:#eef2ff; color:var(--accent); }
  .toolbar { max-width:860px; margin:16px auto 0; display:flex; justify-content:flex-end; gap:8px; }
  .watermark { position:fixed; top:40%; left:0; right:0; text-align:center; font-size:110px; font-weight:800; color:rgba(180,35,24,.08); transform:rotate(-20deg); pointer-events:none; }
  @media (max-width: 640px) { .page { padding:20px 16px; margin:0; border-radius:0; } header, .parties { display:block; } .totals { width:100%; } .meta { margin-top:12px; } }
  @media print { body { background:#fff; } .page { box-shadow:none; margin:0; max-width:none; padding:0; } .toolbar, .actions, .no-print { display:none !important; } }
`;

function partyBlock(title, p = {}) {
  return `<div class="box"><h3>${esc(title)}</h3>
    ${p.company ? `<strong>${esc(p.company)}</strong><br>` : ''}
    ${p.name && p.name !== p.company ? `${esc(p.name)}<br>` : ''}
    ${p.address ? `${nl(p.address)}<br>` : ''}
    ${p.state ? `State: ${esc(p.state)}<br>` : ''}
    ${p.gstin ? `GSTIN: <strong>${esc(p.gstin)}</strong><br>` : ''}
    ${p.email ? `${esc(p.email)}<br>` : ''}${p.phone ? esc(p.phone) : ''}
  </div>`;
}

function itemsTable(doc) {
  const showHsn = doc.items.some((i) => i.hsnSac);
  const showDisc = doc.items.some((i) => i.discountPercent);
  const cur = doc.currency;
  const rows = doc.items.map((i, n) => `<tr>
      <td>${n + 1}</td>
      <td><strong>${esc(i.name)}</strong>${i.description ? `<div class="small muted">${nl(i.description)}</div>` : ''}</td>
      ${showHsn ? `<td>${esc(i.hsnSac || '')}</td>` : ''}
      <td class="num">${esc(i.quantity)} ${esc(i.unit || '')}</td>
      <td class="num">${money(i.unitPrice, cur)}</td>
      ${showDisc ? `<td class="num">${i.discountPercent ? `${esc(i.discountPercent)}%` : '—'}</td>` : ''}
      <td class="num">${money(i.amount, cur)}</td>
      ${doc.appliedTaxMode === 'none' ? '' : `<td class="num">${esc(i.taxRate)}%</td>`}
      <td class="num">${money(i.total, cur)}</td>
    </tr>`).join('');
  return `<table><thead><tr><th>#</th><th>Item</th>${showHsn ? '<th>HSN/SAC</th>' : ''}<th class="num">Qty</th><th class="num">Rate</th>
    ${showDisc ? '<th class="num">Disc.</th>' : ''}<th class="num">Amount</th>${doc.appliedTaxMode === 'none' ? '' : '<th class="num">GST</th>'}<th class="num">Total</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

function totalsTable(doc, { invoice } = {}) {
  const t = doc.totals || {};
  const cur = doc.currency;
  const line = (k, v, cls = '') => `<tr class="${cls}"><td>${k}</td><td class="num">${v}</td></tr>`;
  return `<table class="totals">
    ${line('Subtotal', money(t.subtotal, cur))}
    ${t.discountTotal ? line('Discount', `− ${money(t.discountTotal, cur)}`) : ''}
    ${line('Taxable amount', money(t.taxableAmount, cur))}
    ${doc.appliedTaxMode === 'intra' ? line('CGST', money(t.cgst, cur)) + line('SGST', money(t.sgst, cur)) : ''}
    ${doc.appliedTaxMode === 'inter' ? line('IGST', money(t.igst, cur)) : ''}
    ${t.roundOff ? line('Round off', money(t.roundOff, cur)) : ''}
    ${line('Total', money(t.total, cur), 'grand')}
    ${invoice && doc.amountPaid ? line('Paid', `− ${money(doc.amountPaid, cur)}`) : ''}
    ${invoice && doc.status !== 'void' ? line('<strong>Balance due</strong>', `<strong>${money(doc.balanceDue, cur)}</strong>`) : ''}
  </table>
  <div class="words small">${esc(amountInWords(t.total, cur))}</div>`;
}

function paymentDetails(billing, doc) {
  const b = billing.bank || {};
  const hasBank = b.accountNumber || b.ifsc;
  if (!hasBank && !billing.upiId) return '';
  const upiLink = billing.upiId
    ? `upi://pay?pa=${encodeURIComponent(billing.upiId)}&pn=${encodeURIComponent(billing.companyName || '')}&am=${encodeURIComponent(doc.balanceDue ?? doc.totals.total)}&cu=INR&tn=${encodeURIComponent(doc.number || '')}`
    : null;
  return `<div class="section"><h3>Payment details</h3><div class="small">
    ${hasBank ? `Bank: ${esc(b.bankName)}${b.branch ? `, ${esc(b.branch)}` : ''}<br>Account name: ${esc(b.accountName || billing.companyName)}<br>
      Account no.: <strong>${esc(b.accountNumber)}</strong> &nbsp; IFSC: <strong>${esc(b.ifsc)}</strong><br>` : ''}
    ${billing.upiId ? `UPI: <strong>${esc(billing.upiId)}</strong> <a class="no-print" href="${esc(upiLink)}">Pay with UPI app</a>` : ''}
  </div></div>`;
}

/**
 * kind: 'quote' | 'invoice'. `flash` shows the result of an accept / reject action. With `print` the page opens the
 * browser print dialog (Save as PDF) — the script carries a nonce because the page's CSP blocks other scripts.
 */
export function renderDocument({ kind, doc, billing, token, print = false, flash, nonce }) {
  const isQuote = kind === 'quote';
  const heading = isQuote ? 'QUOTATION' : (billing.gstin ? 'TAX INVOICE' : 'INVOICE');
  const number = doc.number ? `${esc(doc.number)}${isQuote && doc.version > 1 ? ` (Rev ${doc.version})` : ''}` : 'Draft';
  const meta = isQuote
    ? [['Quotation no.', number], ['Date', date(doc.issueDate)], ['Valid until', date(doc.validUntil)]]
    : [['Invoice no.', number], ['Invoice date', date(doc.issueDate)], ['Due date', date(doc.dueDate)]];
  if (doc.customer?.state) meta.push(['Place of supply', esc(doc.customer.state)]);
  const expired = isQuote && doc.status === 'sent' && doc.validUntil && new Date(doc.validUntil) < new Date();
  const canRespond = isQuote && doc.status === 'sent' && !expired;
  const banner = flash
    ? `<div class="banner ${flash.tone}">${esc(flash.text)}</div>`
    : expired ? '<div class="banner bad">This quotation has expired. Please contact us for an updated quotation.</div>'
      : doc.status === 'accepted' ? `<div class="banner ok">Accepted${doc.acceptedBy ? ` by ${esc(doc.acceptedBy)}` : ''} on ${date(doc.acceptedAt)}. Thank you!</div>`
        : doc.status === 'paid' ? '<div class="banner ok">Paid in full. Thank you!</div>'
          : doc.status === 'revised' ? '<div class="banner info">This quotation was replaced by a newer revision.</div>' : '';
  const actions = canRespond ? `<div class="actions">
      <h3 style="margin:0">Respond to this quotation</h3>
      <form method="post" action="${esc(token)}/accept">
        <input type="text" name="name" placeholder="Your full name" required maxlength="120" aria-label="Your full name">
        <button class="primary" type="submit">Accept quotation</button>
      </form>
      <form method="post" action="${esc(token)}/reject">
        <input type="text" name="reason" placeholder="Reason (optional)" maxlength="500" aria-label="Reason for declining">
        <button class="danger" type="submit">Decline</button>
      </form>
      <p class="small muted" style="margin:0">By accepting you agree to the prices and terms in this quotation.</p>
    </div>` : '';
  const watermark = ['draft', 'void', 'revised'].includes(doc.status) ? `<div class="watermark">${esc(doc.status.toUpperCase())}</div>` : '';
  const title = `${isQuote ? 'Quotation' : 'Invoice'} ${doc.number || ''} — ${billing.companyName || ''}`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><meta name="robots" content="noindex"><style>${STYLE}</style></head><body>
${watermark}
<div class="toolbar no-print"><button type="button" id="print">Download / Print PDF</button></div>
<div class="page">
  ${banner}
  <header>
    <div>
      ${billing.logoUrl ? `<img src="${esc(billing.logoUrl)}" alt="" style="max-height:56px;margin-bottom:8px"><br>` : ''}
      <h2>${esc(billing.companyName || 'Your Company')}</h2>
      <div class="small muted">${nl(billing.address)}${billing.state ? `<br>State: ${esc(billing.state)}` : ''}
        ${billing.gstin ? `<br>GSTIN: <strong>${esc(billing.gstin)}</strong>` : ''}${billing.pan ? ` · PAN: ${esc(billing.pan)}` : ''}
        ${billing.email || billing.phone ? `<br>${esc([billing.email, billing.phone].filter(Boolean).join(' · '))}` : ''}</div>
    </div>
    <div class="right">
      <h1>${heading}</h1>
      <div style="margin:6px 0"><span class="status ${esc(doc.status)}">${esc(label(doc.status))}</span></div>
      <div class="meta">${meta.map(([k, v]) => `<span class="muted">${k}</span><strong>${v}</strong>`).join('')}</div>
    </div>
  </header>
  <div class="parties">${partyBlock(isQuote ? 'Quotation for' : 'Bill to', doc.customer)}
    ${doc.title && !['Quotation', 'Tax Invoice'].includes(doc.title) ? `<div class="box"><h3>Subject</h3>${esc(doc.title)}</div>` : ''}</div>
  ${itemsTable(doc)}
  ${totalsTable(doc, { invoice: !isQuote })}
  ${!isQuote && doc.status !== 'void' ? paymentDetails(billing, doc) : ''}
  ${doc.notes ? `<div class="section"><h3>Notes</h3><div class="small">${nl(doc.notes)}</div></div>` : ''}
  ${doc.terms ? `<div class="section"><h3>Terms &amp; conditions</h3><div class="small">${nl(doc.terms)}</div></div>` : ''}
  ${!isQuote ? '<p class="small muted section">This is a computer-generated invoice.</p>' : ''}
  ${actions}
</div>
<script nonce="${nonce}">
  document.getElementById('print').addEventListener('click', function () { window.print(); });
  ${print ? 'window.addEventListener("load", function () { setTimeout(function () { window.print(); }, 300); });' : ''}
</script>
</body></html>`;
}
