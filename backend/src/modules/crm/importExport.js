import {
  Account, Contact, DEAL_STAGES, LEAD_STATUSES, Organization, User,
} from '../../models/index.js';
import { badRequest } from '../../lib/errors.js';
import { normalizePhone } from '../../lib/phone.js';
import { restoreFormula } from '../../lib/spreadsheet.js';

export const MAX_IMPORT_ROWS = 10000;
export const MAX_EXPORT_ROWS = 50000;
export const IMPORT_MODES = ['skip', 'update', 'create'];

const OPT_OUTS = [
  { key: 'doNotCall', header: 'Do Not Call', type: 'boolean' },
  { key: 'smsOptOut', header: 'SMS Opt-out', type: 'boolean' },
  { key: 'whatsappOptOut', header: 'WhatsApp Opt-out', type: 'boolean' },
  { key: 'emailOptOut', header: 'Email Opt-out', type: 'boolean' },
];
const OWNER = { key: 'ownerId', header: 'Owner', type: 'user', aliases: ['owner email'] };
const CREATED = { key: 'createdAt', header: 'Created At', type: 'datetime', exportOnly: true };

/**
 * Column definitions per CRM entity. `header` is what export writes and the template contains; import also accepts
 * the field key and `aliases`, ignoring case, spaces and punctuation. `matchBy` finds existing records to skip/update.
 * Reference columns are written as readable values (account name, contact email, user email) and resolved on import.
 */
export const IO_SPECS = {
  leads: {
    fields: [
      { key: 'name', header: 'Name', required: true, aliases: ['full name', 'lead name'] },
      { key: 'email', header: 'Email', type: 'email' },
      { key: 'phone', header: 'Phone', type: 'phone', aliases: ['mobile', 'phone number'] },
      { key: 'company', header: 'Company' },
      { key: 'source', header: 'Source', type: 'enum' },
      { key: 'status', header: 'Status', type: 'enum', values: LEAD_STATUSES },
      { key: 'industry', header: 'Industry' },
      { key: 'companySize', header: 'Company Size' },
      { key: 'estimatedValue', header: 'Estimated Value', type: 'number' },
      ...OPT_OUTS,
      OWNER,
      { key: 'score', header: 'Score', type: 'number', exportOnly: true },
      CREATED,
    ],
    matchBy: ['email', 'phone'],
  },
  contacts: {
    fields: [
      { key: 'firstName', header: 'First Name', required: true },
      { key: 'lastName', header: 'Last Name', aliases: ['surname'] },
      { key: 'email', header: 'Email', type: 'email' },
      { key: 'phone', header: 'Phone', type: 'phone', aliases: ['mobile', 'phone number'] },
      { key: 'company', header: 'Company' },
      { key: 'accountId', header: 'Account', type: 'account', aliases: ['account name'] },
      { key: 'customerId', header: 'Customer ID' },
      ...OPT_OUTS,
      OWNER,
      { key: 'lastContactedAt', header: 'Last Contacted', type: 'datetime', exportOnly: true },
      CREATED,
    ],
    matchBy: ['email', 'phone'],
  },
  accounts: {
    fields: [
      { key: 'name', header: 'Name', required: true, aliases: ['account name', 'company'] },
      { key: 'industry', header: 'Industry' },
      { key: 'size', header: 'Size' },
      { key: 'website', header: 'Website' },
      { key: 'phone', header: 'Phone', type: 'phone' },
      { key: 'customerId', header: 'Customer ID' },
      OWNER,
      CREATED,
    ],
    matchBy: ['name'],
  },
  deals: {
    fields: [
      { key: 'name', header: 'Name', required: true, aliases: ['deal name'] },
      { key: 'value', header: 'Value', type: 'number', aliases: ['amount'] },
      { key: 'currency', header: 'Currency' },
      { key: 'stage', header: 'Stage', type: 'enum', values: DEAL_STAGES },
      { key: 'probability', header: 'Probability', type: 'number' },
      { key: 'expectedCloseDate', header: 'Expected Close Date', type: 'date', aliases: ['close date'] },
      { key: 'contactId', header: 'Contact', type: 'contact', aliases: ['contact email'] },
      { key: 'accountId', header: 'Account', type: 'account', aliases: ['account name'] },
      OWNER,
      { key: 'score', header: 'Score', type: 'number', exportOnly: true },
      CREATED,
    ],
    matchBy: ['name'],
  },
  tickets: {
    fields: [
      { key: 'subject', header: 'Subject', required: true },
      { key: 'description', header: 'Description' },
      { key: 'status', header: 'Status', type: 'enum', values: ['open', 'pending', 'resolved', 'closed'] },
      { key: 'priority', header: 'Priority', type: 'enum', values: ['low', 'medium', 'high', 'urgent'] },
      { key: 'contactId', header: 'Contact', type: 'contact', aliases: ['contact email'] },
      { key: 'accountId', header: 'Account', type: 'account', aliases: ['account name'] },
      { key: 'assigneeId', header: 'Assignee', type: 'user', aliases: ['assignee email', 'assigned to'] },
      CREATED,
    ],
    matchBy: [],
  },
  tasks: {
    fields: [
      { key: 'title', header: 'Title', required: true },
      { key: 'description', header: 'Description' },
      { key: 'dueAt', header: 'Due At', type: 'datetime', aliases: ['due', 'due date'] },
      { key: 'status', header: 'Status', type: 'enum', values: ['open', 'done', 'cancelled'] },
      { key: 'priority', header: 'Priority', type: 'enum', values: ['low', 'medium', 'high'] },
      { key: 'assigneeId', header: 'Assignee', type: 'user', aliases: ['assignee email', 'assigned to'] },
      CREATED,
    ],
    matchBy: [],
  },
};

const ID_HEADER = 'ID';
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const isObjectId = (s) => /^[a-f0-9]{24}$/i.test(s);
const fullName = (c) => `${c.firstName || ''} ${c.lastName || ''}`.trim();
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function importableFields(spec) {
  return spec.fields.filter((f) => !f.exportOnly);
}

export function templateHeaders(spec) {
  return importableFields(spec).map((f) => f.header);
}

// ---------------------------------------------------------------- export

const POPULATE = {
  account: { select: 'name' },
  contact: { select: 'firstName lastName email' },
  user: { select: 'email' },
};

function exportValue(field, v) {
  if (v === undefined || v === null || v === '') return '';
  switch (field.type) {
    case 'boolean': return v ? 'Yes' : 'No';
    case 'date': return new Date(v).toISOString().slice(0, 10);
    case 'datetime': return new Date(v).toISOString();
    case 'account': return v.name ?? String(v);
    case 'contact': return v.email || fullName(v) || String(v._id ?? v);
    case 'user': return v.email ?? String(v);
    default: return v;
  }
}

/** Loads matching records (same filter as the list view) and turns them into rows keyed by column header. */
export async function buildExport(Model, spec, filter, sort) {
  let query = Model.find(filter).sort(sort).limit(MAX_EXPORT_ROWS).lean();
  for (const f of spec.fields) if (POPULATE[f.type]) query = query.populate({ path: f.key, ...POPULATE[f.type] });
  const docs = await query;
  const headers = [ID_HEADER, ...spec.fields.map((f) => f.header)];
  const rows = docs.map((d) => {
    const row = { [ID_HEADER]: String(d._id) };
    for (const f of spec.fields) row[f.header] = exportValue(f, d[f.key]);
    return row;
  });
  return { headers, rows };
}

// ---------------------------------------------------------------- import: cell parsing

const TRUE_WORDS = new Set(['yes', 'y', 'true', '1', 'x']);
const FALSE_WORDS = new Set(['no', 'n', 'false', '0']);

/** Accepts Excel dates, ISO strings and day-first dates (DD/MM/YYYY or DD-MM-YYYY, as used in India). */
function parseDate(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  const s = String(v).trim();
  const dmy = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[ T](\d{1,2}):(\d{2}))?$/);
  if (dmy) {
    const [, d, m, y, hh = '0', mm = '0'] = dmy;
    const date = new Date(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm));
    return date.getDate() === Number(d) && date.getMonth() === Number(m) - 1 ? date : null;
  }
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return null;
  const date = new Date(s);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Converts one cell to the stored value. Returns { value } or { error }. Reference cells return { ref }. */
function parseCell(field, raw, ctx) {
  const v = restoreFormula(raw instanceof Date ? raw : typeof raw === 'string' ? raw.trim() : raw);
  switch (field.type) {
    case 'number': {
      const n = typeof v === 'number' ? v : Number(String(v).replace(/[,\s₹$]/g, ''));
      return Number.isFinite(n) ? { value: n } : { error: `${field.header}: "${v}" is not a number` };
    }
    case 'boolean': {
      const s = String(v).toLowerCase();
      if (typeof v === 'boolean') return { value: v };
      if (TRUE_WORDS.has(s)) return { value: true };
      if (FALSE_WORDS.has(s)) return { value: false };
      return { error: `${field.header}: "${v}" should be Yes or No` };
    }
    case 'date':
    case 'datetime': {
      const d = parseDate(v);
      return d ? { value: d } : { error: `${field.header}: "${v}" is not a valid date (use YYYY-MM-DD or DD/MM/YYYY)` };
    }
    case 'email': {
      const s = String(v).toLowerCase();
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? { value: s } : { error: `${field.header}: "${v}" is not a valid email` };
    }
    case 'phone':
      return { value: normalizePhone(String(v), ctx.countryCode) || String(v) };
    case 'enum': {
      const s = String(v).trim().toLowerCase().replace(/[\s-]+/g, '_');
      if (field.values && !field.values.includes(s)) return { error: `${field.header}: "${v}" must be one of ${field.values.join(', ')}` };
      return { value: s };
    }
    case 'account':
    case 'contact':
    case 'user':
      return { ref: String(v) };
    default:
      return { value: String(v) };
  }
}

// ---------------------------------------------------------------- import: references & matching

async function resolveRefs(orgId, wanted) {
  const maps = { account: new Map(), contact: new Map(), user: new Map() };
  const ci = { locale: 'en', strength: 2 };
  const idsOf = (set) => [...set].filter(isObjectId);
  if (wanted.account.size) {
    const names = [...wanted.account];
    const accounts = await Account.find({ organizationId: orgId, $or: [{ _id: { $in: idsOf(wanted.account) } }, { name: { $in: names } }] })
      .collation(ci).select('name').lean();
    for (const a of accounts) { maps.account.set(String(a._id), a._id); maps.account.set(norm(a.name), a._id); }
  }
  if (wanted.user.size) {
    const users = await User.find({ organizationId: orgId, $or: [{ _id: { $in: idsOf(wanted.user) } }, { email: { $in: [...wanted.user].map((s) => s.toLowerCase()) } }] })
      .select('email').lean();
    for (const u of users) { maps.user.set(String(u._id), u._id); maps.user.set(norm(u.email), u._id); }
  }
  if (wanted.contact.size) {
    const values = [...wanted.contact];
    const emails = values.filter((s) => s.includes('@')).map((s) => s.toLowerCase());
    const names = values.filter((s) => !s.includes('@') && !isObjectId(s));
    const or = [{ _id: { $in: idsOf(wanted.contact) } }, { email: { $in: emails } }];
    if (names.length) or.push({ firstName: { $in: names.map((n) => new RegExp(`^${escapeRegex(n.split(/\s+/)[0])}$`, 'i')) } });
    const contacts = await Contact.find({ organizationId: orgId, $or: or }).select('firstName lastName email').lean();
    for (const c of contacts) {
      maps.contact.set(String(c._id), c._id);
      if (c.email) maps.contact.set(norm(c.email), c._id);
      maps.contact.set(norm(fullName(c)), c._id);
    }
  }
  return maps;
}

const matchKey = (field, value) => (value === undefined || value === null || value === '' ? null : `${field}:${norm(value)}`);

function keysOf(spec, data) {
  return spec.matchBy.map((f) => matchKey(f, data[f])).filter(Boolean);
}

async function loadExisting(Model, orgId, spec, parsed, mode) {
  const byId = new Map();
  const byKey = new Map();
  if (mode === 'create') return { byId, byKey };
  const ids = parsed.map((p) => p.id).filter(Boolean);
  const or = [];
  if (ids.length) or.push({ _id: { $in: ids } });
  for (const f of spec.matchBy) {
    const values = [...new Set(parsed.map((p) => p.data[f]).filter((v) => v !== undefined && v !== ''))];
    if (values.length) or.push({ [f]: { $in: values } });
  }
  if (!or.length) return { byId, byKey };
  const docs = await Model.find({ organizationId: orgId, $or: or }).collation({ locale: 'en', strength: 2 });
  for (const d of docs) {
    byId.set(String(d._id), d);
    for (const k of keysOf(spec, d)) if (!byKey.has(k)) byKey.set(k, d);
  }
  return { byId, byKey };
}

// ---------------------------------------------------------------- import

/** Maps file headers to fields. Unknown headers are reported and ignored. */
export function mapHeaders(spec, headerRow) {
  const lookup = new Map([[norm(ID_HEADER), 'id'], [norm('_id'), 'id']]);
  for (const f of importableFields(spec)) {
    for (const name of [f.header, f.key, ...(f.aliases || [])]) if (!lookup.has(norm(name))) lookup.set(norm(name), f);
  }
  const columns = [];
  const ignored = [];
  const seen = new Set();
  headerRow.forEach((h, i) => {
    const target = lookup.get(norm(h));
    if (!target || seen.has(target)) { if (String(h).trim()) ignored.push(String(h)); return; }
    seen.add(target);
    columns.push({ index: i, target });
  });
  const missing = importableFields(spec).filter((f) => f.required && !seen.has(f));
  return { columns, ignored, missing };
}

/**
 * Imports parsed spreadsheet rows. Rows are validated against the model before anything is written.
 * mode: skip (default) leaves records that already exist; update fills in their non-empty cells; create always inserts.
 * Existing records are found by the ID column, then by the entity's matchBy fields (case-insensitive).
 */
export async function importRows(Model, spec, orgId, table, { mode = 'skip', dryRun = false } = {}) {
  if (!IMPORT_MODES.includes(mode)) throw badRequest(`mode must be one of ${IMPORT_MODES.join(', ')}`);
  if (!table.length) throw badRequest('The file has no header row');
  const { columns, ignored, missing } = mapHeaders(spec, table[0]);
  if (missing.length) {
    throw badRequest(`Missing required column(s): ${missing.map((f) => f.header).join(', ')}`, { expected: templateHeaders(spec) });
  }
  const body = table.slice(1);
  if (body.length > MAX_IMPORT_ROWS) throw badRequest(`Files can have at most ${MAX_IMPORT_ROWS} rows; split it into smaller files`);

  const org = await Organization.findById(orgId).select('settings.defaultCountryCode').lean();
  const ctx = { countryCode: org?.settings?.defaultCountryCode || '91' };
  const summary = { total: 0, created: 0, updated: 0, skipped: 0, failed: 0, errors: [], warnings: [], ignoredColumns: ignored, dryRun };
  const fail = (row, message) => { summary.failed += 1; if (summary.errors.length < 200) summary.errors.push({ row, message }); };
  const warn = (row, message) => { if (summary.warnings.length < 200) summary.warnings.push({ row, message }); };

  // 1. Parse cells
  const wanted = { account: new Set(), contact: new Set(), user: new Set() };
  const parsed = [];
  body.forEach((cells, i) => {
    const rowNumber = i + 2; // 1-based, after the header row
    if (!cells.some((c) => String(c ?? '').trim() !== '')) return;
    summary.total += 1;
    const entry = { rowNumber, data: {}, refs: {}, errors: [] };
    for (const { index, target } of columns) {
      const raw = cells[index];
      if (raw === undefined || raw === null || String(raw).trim() === '') continue;
      if (target === 'id') {
        const id = String(raw).trim();
        if (isObjectId(id)) entry.id = id; else entry.errors.push(`ID "${id}" is not a valid record ID`);
        continue;
      }
      const out = parseCell(target, raw, ctx);
      if (out.error) entry.errors.push(out.error);
      else if (out.ref !== undefined) { entry.refs[target.key] = { type: target.type, value: out.ref, header: target.header }; wanted[target.type].add(out.ref); }
      else entry.data[target.key] = out.value;
    }
    parsed.push(entry);
  });

  // 2. Resolve references and existing records in bulk
  const refMaps = await resolveRefs(orgId, wanted);
  const { byId, byKey } = await loadExisting(Model, orgId, spec, parsed, mode);

  // 3. Decide and validate each row
  const creates = [];
  const updates = new Set();
  for (const entry of parsed) {
    if (entry.errors.length) { fail(entry.rowNumber, entry.errors.join('; ')); continue; }
    for (const [key, ref] of Object.entries(entry.refs)) {
      const id = refMaps[ref.type].get(isObjectId(ref.value) ? ref.value : norm(ref.value));
      if (id) entry.data[key] = id;
      else warn(entry.rowNumber, `${ref.header} "${ref.value}" was not found; left empty`);
    }

    let target = null;
    if (mode !== 'create') {
      if (entry.id) {
        target = byId.get(entry.id);
        if (!target) { fail(entry.rowNumber, `No ${Model.modelName.toLowerCase()} with ID ${entry.id}`); continue; }
      } else {
        target = keysOf(spec, entry.data).map((k) => byKey.get(k)).find(Boolean) || null;
      }
    }
    if (target && mode === 'skip') { summary.skipped += 1; continue; }

    const isNew = !target;
    const missingRequired = isNew && importableFields(spec).find((f) => f.required && entry.data[f.key] === undefined);
    if (missingRequired) { fail(entry.rowNumber, `${missingRequired.header} is required`); continue; }
    const doc = target || new Model({ organizationId: orgId });
    const snapshot = isNew ? null : doc.toObject();
    doc.set(entry.data);
    try {
      await doc.validate();
    } catch (err) {
      const messages = Object.values(err.errors || {}).map((e) => e.message);
      if (snapshot) doc.overwrite(snapshot); // keep the shared instance clean for later rows
      fail(entry.rowNumber, messages.join('; ') || err.message);
      continue;
    }
    if (isNew) {
      creates.push(doc);
      summary.created += 1;
    } else {
      summary.updated += 1;
      if (!creates.includes(doc)) updates.add(doc); // a row may also merge into a record created earlier in this file
    }
    // Later rows in the same file that match this record are treated as duplicates of it
    byId.set(String(doc._id), doc);
    for (const k of keysOf(spec, doc)) if (!byKey.has(k)) byKey.set(k, doc);
  }

  // 4. Write
  if (!dryRun) {
    if (creates.length) await Model.insertMany(creates, { ordered: false });
    for (const doc of updates) await doc.save();
  }
  return summary;
}
