import express, { Router } from 'express';
import { badRequest, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { readTable, sendTable } from '../../lib/spreadsheet.js';
import { requirePermission, requireResource } from '../../middleware/auth.js';
import { checkLimit, remaining } from '../saas/usage.js';
import { logActivity } from '../timeline/service.js';
import { buildExport, importRows, templateHeaders } from './importExport.js';

const PROTECTED_FIELDS = ['_id', 'id', 'organizationId', 'createdAt', 'updatedAt'];

function clean(body) {
  const copy = { ...body };
  for (const f of PROTECTED_FIELDS) delete copy[f];
  return copy;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function listFilter(req, searchFields, filterFields) {
  const filter = { organizationId: req.orgId };
  const { q } = req.query;
  if (q && searchFields.length) {
    const rx = new RegExp(escapeRegex(String(q)), 'i');
    filter.$or = searchFields.map((f) => ({ [f]: rx }));
  }
  for (const f of filterFields) if (req.query[f] !== undefined && req.query[f] !== '') filter[f] = req.query[f];
  return filter;
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
} = {}) {
  const router = Router();
  const name = `${Model.collection.collectionName}`;

  if (io) {
    // Registered before "/:id" so "export" and "import" are not read as record IDs
    router.get('/export', requirePermission('crm:export'), async (req, res) => {
      const { headers, rows } = await buildExport(Model, io, listFilter(req, searchFields, filterFields), defaultSort);
      await audit(req, `${name}.export`, { resourceType: Model.modelName, details: { count: rows.length, format: fileFormat(req) } });
      await sendTable(res, { headers, rows, name, format: fileFormat(req) });
    });

    router.get('/import/template', requirePermission('crm:import'), async (req, res) => {
      await sendTable(res, { headers: templateHeaders(io), rows: [], name: `${name}-import-template`, format: fileFormat(req) });
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

  router.get('/', async (req, res) => {
    const filter = listFilter(req, searchFields, filterFields);
    const { page = 1, limit = 50, sort } = req.query;
    const lim = Math.min(Number(limit) || 50, 200);
    const sortSpec = sort ? { [String(sort).replace(/^-/, '')]: String(sort).startsWith('-') ? -1 : 1 } : defaultSort;
    const [items, total] = await Promise.all([
      Model.find(filter).sort(sortSpec).skip((Math.max(Number(page), 1) - 1) * lim).limit(lim),
      Model.countDocuments(filter),
    ]);
    res.json({ items, total, page: Number(page), limit: lim });
  });

  router.get('/:id', async (req, res) => {
    const doc = await Model.findOne({ _id: req.params.id, organizationId: req.orgId });
    if (!doc) throw notFound(Model.modelName);
    res.json(doc);
  });

  router.post('/', async (req, res) => {
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
    const doc = await Model.findOne({ _id: req.params.id, organizationId: req.orgId });
    if (!doc) throw notFound(Model.modelName);
    const before = doc.toObject();
    doc.set(clean(req.body));
    if (onUpdate) await onUpdate(doc, before, req);
    await doc.save();
    if (afterUpdate) await afterUpdate(doc, req);
    res.json(doc);
  });

  router.delete('/:id', async (req, res) => {
    const result = await Model.deleteOne({ _id: req.params.id, organizationId: req.orgId });
    if (!result.deletedCount) throw notFound(Model.modelName);
    res.status(204).end();
  });

  return router;
}
