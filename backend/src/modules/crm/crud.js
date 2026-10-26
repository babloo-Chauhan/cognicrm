import express, { Router } from 'express';
import { badRequest, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { validateField } from '../../lib/validation.js';
import { cursorFilter, encodeCursor, pageParams, sortParam } from '../../lib/pagination.js';
import { searchTerms } from '../../models/search.js';
import { buildTemplateWorkbook, readTable, sendTable } from '../../lib/spreadsheet.js';
import { requirePermission, requireResource } from '../../middleware/auth.js';
import { checkLimit, remaining } from '../saas/usage.js';
import { logActivity } from '../timeline/service.js';
import { importRows, streamExport, templateGuide, templateHeaders } from './importExport.js';
import { bumpCompany, cached } from '../../lib/cache.js';

const PROTECTED_FIELDS = ['_id', 'id', 'organizationId', 'createdAt', 'updatedAt', '_search', '__v'];

function clean(body) {
  const copy = { ...body };
  for (const f of PROTECTED_FIELDS) delete copy[f];
  return copy;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A lean list row in the same shape toJSON gives (models/plugins.js). */
function toListItem({ _id, __v, _search, ...rest }) {
  return { id: String(_id), ...rest };
}

/** Unanchored, case-insensitive match on the search fields (reads every record of the company). */
const regexSearch = (q, searchFields) => {
  const rx = new RegExp(escapeRegex(String(q).trim()), 'i');
  return { $or: searchFields.map((f) => ({ [f]: rx })) };
};

/**
 * List filter: company, ?q= search and ?field= filters. Models with search tokens (models/search.js) are
 * searched through their index by word prefix; others with a regex. `?ownerId=none` lists records nobody owns.
 */
export function listFilter(req, searchFields, filterFields, Model, scope) {
  const filter = { organizationId: req.orgId };
  const only = scope?.(req);
  if (only) filter.$and = [only];
  const { q } = req.query;
  if (q && String(q).trim() && searchFields.length) {
    const terms = Model?.searchFields && searchTerms(q);
    Object.assign(filter, terms ? { _search: { $all: terms } } : regexSearch(q, searchFields));
  }
  for (const f of filterFields) {
    const v = req.query[f];
    if (v !== undefined && v !== '' && typeof v === 'string') filter[f] = v === 'none' && /Id$/.test(f) ? null : v;
  }
  return filter;
}

/**
 * Applies form rules to a request body. A create checks every rule (required fields too);
 * an update only checks the fields it sends, so a partial PATCH stays valid.
 */
function checkRules(rules, body, partial) {
  if (!rules) return;
  const problems = rules
    .filter((r) => !partial || Object.prototype.hasOwnProperty.call(body, r.key))
    .map((r) => ({ path: [r.key], message: validateField(r, body[r.key]) }))
    .filter((p) => p.message);
  if (problems.length) throw badRequest(problems[0].message, problems);
}

const fileFormat = (req) => (req.query.format === 'xlsx' ? 'xlsx' : 'csv');

/**
 * Builds tenant-scoped CRUD routes for a model.
 * Every query is filtered by req.orgId so records never leak across organizations.
 * With `io` (an IO_SPECS entry) it also adds CSV/Excel export, an import template and import.
 */
export function crudRouter(Model, {
  searchFields = [],
  filterFields = [],
  defaultSort = { createdAt: -1 },
  onCreate,
  onUpdate,
  afterUpdate, // (doc, req) after the update is saved
  afterCreate, // (doc, req) after the record is saved, e.g. notifications
  activity, // { type, title: (doc) => string, related: (doc) => ({...}) }
  io,
  resource, // permission prefix: GET → `${resource}:read`, POST → create, PATCH → update, DELETE → delete
  limit, // plan limit key checked before creating (users, customers, leads, deals)
  rules, // form rules (fieldRules.js) checked on create and update
  sortable = ['createdAt', 'updatedAt'], // ?sort= fields clients may use (each needs an index in the model)
  scope, // (req) => extra filter limiting which records this user may see, or null for all (e.g. own leads only)
  queryFilter, // async (req) => extra list filter from entity-specific ?params (e.g. leads ?reminder=missed)
  decorate, // async (items, req) => list rows with extra read-only fields (e.g. a lead's last follow-up)
} = {}) {
  const router = Router();
  const name = `${Model.collection.collectionName}`;

  if (io) {
    // Registered before "/:id" so "export" and "import" are not read as record IDs
    router.get('/export', requirePermission('crm:export'), async (req, res) => {
      const format = fileFormat(req);
      const result = await streamExport(res, Model, io, listFilter(req, searchFields, filterFields, Model, scope), defaultSort, { format, name });
      await audit(req, `${name}.export`, { resourceType: Model.modelName, details: { count: result.count, truncated: result.truncated, format } });
    });

    router.get('/import/template', requirePermission('crm:import'), async (req, res) => {
      const file = `${name}-import-template`;
      if (fileFormat(req) !== 'xlsx') return sendTable(res, { headers: templateHeaders(io), rows: [], name: file, format: 'csv' });
      // Excel: dropdowns, highlighted required columns and an Instructions sheet
      const wb = buildTemplateWorkbook({ sheet: name.charAt(0).toUpperCase() + name.slice(1), columns: await templateGuide(io, req.orgId) });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${file}.xlsx"`);
      await wb.xlsx.write(res);
      return res.end();
    });

    // The file is the raw request body (text/csv or the .xlsx bytes); options come from the query string
    router.post('/import', requirePermission('crm:import'), express.raw({ type: () => true, limit: '10mb' }), async (req, res) => {
      if (!Buffer.isBuffer(req.body)) throw badRequest('Send the CSV or Excel file as the request body');
      const format = ['csv', 'xlsx'].includes(req.query.format) ? req.query.format : undefined;
      const table = await readTable(req.body, format);
      const dryRun = ['1', 'true'].includes(String(req.query.dryRun));
      if (limit && !dryRun && (req.query.mode || 'skip') !== 'update') {
        // Rejects a file that would push the company over its plan limit (header row excluded)
        const rows = Math.max(0, table.length - 1);
        if (rows > await remaining(req.orgId, limit)) await checkLimit(req.orgId, limit, rows);
      }
      const summary = await importRows(Model, io, req.orgId, table, { mode: req.query.mode || 'skip', dryRun });
      if (!dryRun) {
        await audit(req, `${name}.import`, {
          resourceType: Model.modelName,
          details: { mode: req.query.mode || 'skip', created: summary.created, updated: summary.updated, skipped: summary.skipped, failed: summary.failed },
        });
      }
      res.json(summary);
    });
  }

  if (resource) router.use(requireResource(resource));

  // A successful write makes this company's cached dashboards / reports stale (lib/cache.js)
  router.use((req, res, next) => {
    if (req.method !== 'GET') res.on('finish', () => { if (res.statusCode < 400) bumpCompany(req.orgId); });
    next();
  });

  router.get('/', async (req, res) => {
    const filter = listFilter(req, searchFields, filterFields, Model, scope);
    if (queryFilter) Object.assign(filter, await queryFilter(req));
    const { page, limit } = pageParams(req.query);
    const sort = sortParam(req.query.sort, defaultSort, [...new Set([...sortable, ...Object.keys(defaultSort)])]);
    // _id as a tie-breaker (same direction as the sort, so the indexes in the models serve it) keeps pages
    // stable when many records share a value — e.g. thousands imported in the same millisecond
    const order = { ...sort, _id: Object.values(sort)[0] };
    // Lean rows (≈3× less CPU than full documents) shaped like toJSON: id instead of _id, no internals.
    // The total is the costly part on big companies (it reads every matching index entry), so it is cached
    // per filter; any write to the company refreshes it (bumpCompany).
    const { organizationId: _org, ...countKey } = filter;
    // ?after=<cursor> (from the previous reply's `next`): seek instead of skipping — constant cost at any depth
    const after = req.query.after ? cursorFilter(req.query.after, sort, Model) : null;
    const findPage = async (f, opts) => {
      if (!after) return Model.find(f, null, opts).sort(order).skip((page - 1) * limit).limit(limit).lean();
      const tie = await Model.find({ ...f, ...after.tie }, null, opts).sort(order).limit(limit).lean();
      if (tie.length >= limit) return tie;
      return [...tie, ...await Model.find({ $and: [f, after.rest] }, null, opts).sort(order).limit(limit - tie.length).lean()];
    };
    const run = (f, opts = {}) => Promise.all([
      findPage(f, opts).then((rows) => rows.map(toListItem)),
      f === filter
        ? cached(req.orgId, `count:${Model.modelName}:${JSON.stringify(countKey)}`, 30, () => Model.countDocuments(f, opts))
        : Model.countDocuments(f, opts),
    ]);
    let [items, total] = await run(filter);
    // Word-prefix search found nothing: also try "contains" (e.g. "arma" in Sharma), time-boxed so a large
    // company never waits long for it
    if (!total && filter._search && String(req.query.q).trim().length >= 3) {
      const { _search, ...rest } = filter;
      [items, total] = await run({ ...rest, ...regexSearch(req.query.q, searchFields) }, { maxTimeMS: 1500 }).catch(() => [[], 0]);
    }
    const sortField = Object.keys(sort)[0];
    const next = items.length === limit ? encodeCursor(items[items.length - 1], sortField) : null;
    if (decorate && items.length) items = await decorate(items, req);
    res.json({ items, total, page, limit, pages: Math.ceil(total / limit), next });
  });

  router.get('/:id', async (req, res) => {
    const doc = await Model.findOne({ _id: req.params.id, organizationId: req.orgId, ...(scope?.(req) || {}) });
    if (!doc) throw notFound(Model.modelName);
    res.json(doc);
  });

  router.post('/', async (req, res) => {
    checkRules(rules, req.body || {}, false);
    if (limit) await checkLimit(req.orgId, limit);
    const data = { ...clean(req.body), organizationId: req.orgId };
    const doc = new Model(data);
    if (onCreate) await onCreate(doc, req);
    await doc.save();
    if (activity) {
      await logActivity(req.orgId, {
        type: activity.type, title: activity.title(doc), related: activity.related(doc),
        refType: Model.modelName, refId: doc._id, userId: req.user._id,
      });
    }
    if (afterCreate) await afterCreate(doc, req);
    res.status(201).json(doc);
  });

  router.patch('/:id', async (req, res) => {
    const doc = await Model.findOne({ _id: req.params.id, organizationId: req.orgId, ...(scope?.(req) || {}) });
    if (!doc) throw notFound(Model.modelName);
    checkRules(rules, req.body || {}, true);
    const before = doc.toObject();
    doc.set(clean(req.body));
    if (onUpdate) await onUpdate(doc, before, req);
    await doc.save();
    if (afterUpdate) await afterUpdate(doc, req);
    res.json(doc);
  });

  router.delete('/:id', async (req, res) => {
    const result = await Model.deleteOne({ _id: req.params.id, organizationId: req.orgId, ...(scope?.(req) || {}) });
    if (!result.deletedCount) throw notFound(Model.modelName);
    res.status(204).end();
  });

  return router;
}
