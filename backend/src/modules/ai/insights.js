import { Call, Deal, Lead, Organization, Task } from '../../models/index.js';
import { notFound } from '../../lib/errors.js';
import {
  computeDealScore, computeLeadScore, forecastDeals, mergeScoringConfig, suggestNextBestActions,
} from './scoring.js';

export const POSITIVE_DISPOSITIONS = ['interested', 'demo_scheduled', 'qualified', 'converted'];
export const CONNECTED_STATUSES = ['completed'];

async function callStats(orgId, filter) {
  const calls = await Call.find({ organizationId: orgId, ...filter }).select('answeredAt disposition status startedAt').lean();
  return {
    connectedCalls: calls.filter((c) => c.answeredAt).length,
    positiveDispositions: calls.filter((c) => POSITIVE_DISPOSITIONS.includes(c.disposition?.code)).length,
  };
}

async function sourceConversionRate(orgId, source) {
  const [total, converted] = await Promise.all([
    Lead.countDocuments({ organizationId: orgId, source }),
    Lead.countDocuments({ organizationId: orgId, source, status: 'converted' }),
  ]);
  // Only meaningful with enough history
  return total >= 10 ? converted / total : null;
}

export async function scoreLead(orgId, leadOrId, { save = true } = {}) {
  const lead = leadOrId?._id ? leadOrId : await Lead.findOne({ _id: leadOrId, organizationId: orgId });
  if (!lead) throw notFound('Lead');
  const org = await Organization.findById(orgId).lean();
  const config = mergeScoringConfig(org?.settings?.leadScoring);
  const stats = await callStats(orgId, { 'related.leadId': lead._id });
  stats.sourceConversionRate = await sourceConversionRate(orgId, lead.source);
  const result = computeLeadScore(lead.toObject ? lead.toObject() : lead, stats, config);
  if (save) await Lead.updateOne({ _id: lead._id }, { score: result.score, scoreFactors: result.factors });
  return result;
}

export async function scoreDeal(orgId, dealOrId, { save = true } = {}) {
  const deal = dealOrId?._id ? dealOrId : await Deal.findOne({ _id: dealOrId, organizationId: orgId });
  if (!deal) throw notFound('Deal');
  const stats = await callStats(orgId, { 'related.dealId': deal._id });
  const result = computeDealScore(deal.toObject ? deal.toObject() : deal, stats);
  if (save) await Deal.updateOne({ _id: deal._id }, { score: result.score, scoreFactors: result.factors });
  return result;
}

export async function nextBestAction(orgId, kind, id) {
  const Model = kind === 'lead' ? Lead : Deal;
  const record = await Model.findOne({ _id: id, organizationId: orgId }).lean();
  if (!record) throw notFound(kind === 'lead' ? 'Lead' : 'Deal');
  const relKey = kind === 'lead' ? 'related.leadId' : 'related.dealId';
  const [lastCall, openTasks, scoreResult] = await Promise.all([
    Call.findOne({ organizationId: orgId, [relKey]: id }).sort({ startedAt: -1 }).lean(),
    Task.find({ organizationId: orgId, [relKey]: id, status: 'open' }).lean(),
    kind === 'lead' ? scoreLead(orgId, id, { save: false }) : scoreDeal(orgId, id, { save: false }),
  ]);
  const suggestions = suggestNextBestActions({ kind, record, lastCall, openTasks, score: scoreResult.score });
  return { kind, id, score: scoreResult.score, scoreFactors: scoreResult.factors, suggestions };
}

export async function salesForecast(orgId) {
  const deals = await Deal.find({ organizationId: orgId }).lean();
  return forecastDeals(deals);
}

export async function rescoreRelated(orgId, related = {}) {
  if (related.leadId) await scoreLead(orgId, related.leadId).catch(() => null);
  if (related.dealId) await scoreDeal(orgId, related.dealId).catch(() => null);
}
