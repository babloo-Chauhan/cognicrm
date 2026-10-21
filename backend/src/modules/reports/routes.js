import { Router } from 'express';
import { requirePermission } from '../../middleware/auth.js';
import { cached } from '../../lib/cache.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { employeeCalls, employeeReport, leadExport, leadReport, teamReport } from './service.js';

/**
 * Employee-wise reports for the company admin. `reports:team` is only in the admin's `*` by default;
 * an admin can add it to a custom role from Team → Roles.
 */
const router = Router();
router.use('/reports', requirePermission('reports:team'));

const periodKey = (q) => `${q.from || ''}:${q.to || ''}`;

router.get('/reports/team', async (req, res) => {
  res.json(await cached(req.orgId, `reports:team:${periodKey(req.query)}`, 60, () => teamReport(req.orgId, req.query)));
});

router.get('/reports/leads', async (req, res) => {
  const ownerId = typeof req.query.ownerId === 'string' ? req.query.ownerId : '';
  if (ownerId && !/^[a-f0-9]{24}$/i.test(ownerId)) throw badRequest('Invalid ownerId');
  const q = { from: req.query.from, to: req.query.to, ownerId };
  res.json(await cached(req.orgId, `reports:leads:${periodKey(q)}:${ownerId}`, 60, () => leadReport(req.orgId, q)));
});

/** All leads of the period, one row each, for the Excel export of the lead report. */
router.get('/reports/leads/export', async (req, res) => {
  const ownerId = typeof req.query.ownerId === 'string' ? req.query.ownerId : '';
  if (ownerId && !/^[a-f0-9]{24}$/i.test(ownerId)) throw badRequest('Invalid ownerId');
  res.json(await leadExport(req.orgId, { from: req.query.from, to: req.query.to, ownerId }));
});

router.get('/reports/employees/:id', async (req, res) => {
  if (!/^[a-f0-9]{24}$/i.test(req.params.id)) throw badRequest('Invalid employee');
  const report = await employeeReport(req.orgId, req.params.id, req.query);
  if (!report) throw notFound('Employee');
  res.json(report);
});

router.get('/reports/employees/:id/calls', async (req, res) => {
  if (!/^[a-f0-9]{24}$/i.test(req.params.id)) throw badRequest('Invalid employee');
  res.json(await employeeCalls(req.orgId, req.params.id, req.query));
});

export default router;
