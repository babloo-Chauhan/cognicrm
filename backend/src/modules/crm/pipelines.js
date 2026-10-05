import { Router } from 'express';
import { z } from 'zod';
import { Deal, Pipeline } from '../../models/index.js';
import { requirePermission } from '../../middleware/auth.js';
import { validate } from '../../middleware/common.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { DEFAULT_PIPELINE } from '../saas/provisioning.js';

const router = Router();
const objectId = (v) => /^[a-f0-9]{24}$/i.test(String(v));

/** The company's default pipeline, created on first use for companies that predate pipelines. */
export async function defaultPipeline(orgId) {
  return await Pipeline.findOne({ organizationId: orgId, isDefault: true })
    || Pipeline.findOneAndUpdate(
      { organizationId: orgId, name: DEFAULT_PIPELINE.name },
      { $setOnInsert: { ...DEFAULT_PIPELINE, organizationId: orgId } },
      { upsert: true, returnDocument: 'after' },
    );
}

/** Deal stage must belong to the deal's pipeline (of the same company). Sets the default pipeline when missing. */
export async function validateDealStage(doc, orgId) {
  let pipeline;
  if (doc.pipelineId) {
    pipeline = await Pipeline.findOne({ _id: doc.pipelineId, organizationId: orgId }).lean();
    if (!pipeline) throw badRequest('Unknown pipeline');
  } else {
    pipeline = await defaultPipeline(orgId);
    doc.pipelineId = pipeline._id;
  }
  if (!doc.stage) doc.stage = pipeline.stages[0]?.key;
  const stage = pipeline.stages.find((s) => s.key === doc.stage);
  if (!stage) throw badRequest(`Stage "${doc.stage}" is not in pipeline "${pipeline.name}"`);
  if (doc.probability === undefined || doc.probability === null) doc.probability = stage.probability;
}

const stageSchema = z.object({
  key: z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_]{0,39}$/, 'Stage key: lowercase letters, digits, underscore').optional(),
  label: z.string().trim().min(1).max(40),
  probability: z.number().min(0).max(100).optional(),
});

const pipelineSchema = z.object({
  name: z.string().trim().min(2).max(60),
  isDefault: z.boolean().optional(),
  stages: z.array(stageSchema).min(2).max(20),
});

function normalizeStages(stages) {
  const out = stages.map((s) => ({
    key: s.key || s.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'stage',
    label: s.label,
    probability: s.probability ?? 0,
  }));
  // Reports and forecasting rely on the closing stages
  if (!out.some((s) => s.key === 'won')) out.push({ key: 'won', label: 'Won', probability: 100 });
  if (!out.some((s) => s.key === 'lost')) out.push({ key: 'lost', label: 'Lost', probability: 0 });
  const keys = out.map((s) => s.key);
  if (new Set(keys).size !== keys.length) throw badRequest('Stage keys must be unique');
  return out;
}

router.get('/pipelines', requirePermission('deals:read'), async (req, res) => {
  await defaultPipeline(req.orgId);
  res.json({ items: await Pipeline.find({ organizationId: req.orgId }).sort({ isDefault: -1, name: 1 }) });
});

router.post('/pipelines', requirePermission('pipelines:manage'), validate(pipelineSchema), async (req, res) => {
  if (await Pipeline.exists({ organizationId: req.orgId, name: req.body.name })) throw conflict('A pipeline with this name already exists');
  if (req.body.isDefault) await Pipeline.updateMany({ organizationId: req.orgId }, { isDefault: false });
  const pipeline = await Pipeline.create({ organizationId: req.orgId, name: req.body.name, isDefault: Boolean(req.body.isDefault), stages: normalizeStages(req.body.stages) });
  await audit(req, 'pipeline.create', { module: 'deals', resourceType: 'Pipeline', resourceId: pipeline._id });
  res.status(201).json(pipeline);
});

router.patch('/pipelines/:id', requirePermission('pipelines:manage'), validate(pipelineSchema.partial()), async (req, res) => {
  if (!objectId(req.params.id)) throw badRequest('Invalid id');
  const pipeline = await Pipeline.findOne({ _id: req.params.id, organizationId: req.orgId });
  if (!pipeline) throw notFound('Pipeline');
  if (req.body.stages) {
    const stages = normalizeStages(req.body.stages);
    const removed = pipeline.stages.map((s) => s.key).filter((k) => !stages.some((s) => s.key === k));
    if (removed.length && await Deal.exists({ organizationId: req.orgId, pipelineId: pipeline._id, stage: { $in: removed } })) {
      throw conflict(`Move deals out of stage(s) ${removed.join(', ')} before removing them`);
    }
    pipeline.stages = stages;
  }
  if (req.body.name) pipeline.name = req.body.name;
  if (req.body.isDefault) {
    await Pipeline.updateMany({ organizationId: req.orgId, _id: { $ne: pipeline._id } }, { isDefault: false });
    pipeline.isDefault = true;
  }
  await pipeline.save();
  await audit(req, 'pipeline.update', { module: 'deals', resourceType: 'Pipeline', resourceId: pipeline._id });
  res.json(pipeline);
});

router.delete('/pipelines/:id', requirePermission('pipelines:manage'), async (req, res) => {
  if (!objectId(req.params.id)) throw badRequest('Invalid id');
  const pipeline = await Pipeline.findOne({ _id: req.params.id, organizationId: req.orgId });
  if (!pipeline) throw notFound('Pipeline');
  if (pipeline.isDefault) throw badRequest('Make another pipeline the default first');
  if (await Deal.exists({ organizationId: req.orgId, pipelineId: pipeline._id })) throw conflict('Move or delete this pipeline’s deals first');
  await pipeline.deleteOne();
  await audit(req, 'pipeline.delete', { module: 'deals', resourceType: 'Pipeline', resourceId: pipeline._id });
  res.status(204).end();
});

export default router;
