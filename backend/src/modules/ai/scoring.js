/**
 * Explainable scoring models. Every score comes with the factors that produced it so users can
 * see *why* a lead or deal is rated the way it is. Weights are configurable per organization
 * (Organization.settings.leadScoring overrides DEFAULT_LEAD_SCORING).
 */

export const DEFAULT_LEAD_SCORING = {
  sources: { referral: 20, inbound_call: 15, website: 12, event: 10, campaign: 8, social: 6, cold: 2, other: 4 },
  engagement: {
    emailOpen: 2, emailOpenMax: 10,
    emailReply: 6, emailReplyMax: 18,
    connectedCall: 6, connectedCallMax: 18,
    positiveDisposition: 12,
    websiteVisit: 1, websiteVisitMax: 10,
  },
  company: { sizes: { '1-10': 2, '11-50': 5, '51-200': 8, '201-1000': 10, '1000+': 12 }, industryKnown: 3 },
  dealValue: [{ min: 1000000, points: 15 }, { min: 100000, points: 10 }, { min: 10000, points: 5 }],
  historicalConversionMax: 15,
  inactivity: { afterDays: 30, points: -10 },
  hotThreshold: 70,
};

export function mergeScoringConfig(override) {
  if (!override) return DEFAULT_LEAD_SCORING;
  return {
    ...DEFAULT_LEAD_SCORING,
    ...override,
    sources: { ...DEFAULT_LEAD_SCORING.sources, ...(override.sources || {}) },
    engagement: { ...DEFAULT_LEAD_SCORING.engagement, ...(override.engagement || {}) },
    company: { ...DEFAULT_LEAD_SCORING.company, ...(override.company || {}) },
  };
}

const capped = (count, each, max) => Math.min((count || 0) * each, max);

/**
 * @param lead     Lead document (plain object)
 * @param stats    { connectedCalls, positiveDispositions, sourceConversionRate (0..1) }
 * @param config   scoring config
 */
export function computeLeadScore(lead, stats = {}, config = DEFAULT_LEAD_SCORING, now = new Date()) {
  const factors = [];
  const add = (factor, points, detail) => { if (points) factors.push({ factor, points, detail }); };
  const e = config.engagement;

  const sourcePoints = config.sources[lead.source] ?? config.sources.other ?? 0;
  add('source', sourcePoints, `Source "${lead.source || 'other'}"`);
  add('email_opens', capped(lead.emailOpens, e.emailOpen, e.emailOpenMax), `${lead.emailOpens || 0} email opens`);
  add('email_replies', capped(lead.emailReplies, e.emailReply, e.emailReplyMax), `${lead.emailReplies || 0} email replies`);
  add('calls', capped(stats.connectedCalls, e.connectedCall, e.connectedCallMax), `${stats.connectedCalls || 0} connected calls`);
  if (stats.positiveDispositions) add('call_outcome', e.positiveDisposition, 'Showed interest on a call');
  add('website', capped(lead.websiteVisits, e.websiteVisit, e.websiteVisitMax), `${lead.websiteVisits || 0} website visits`);
  add('company_size', config.company.sizes[lead.companySize] || 0, `Company size ${lead.companySize || 'unknown'}`);
  if (lead.industry) add('company_industry', config.company.industryKnown, `Industry: ${lead.industry}`);
  const tier = (config.dealValue || []).find((t) => (lead.estimatedValue || 0) >= t.min);
  if (tier) add('deal_value', tier.points, `Estimated value ${lead.estimatedValue}`);
  if (stats.sourceConversionRate != null) {
    add('historical_conversion', Math.round(stats.sourceConversionRate * config.historicalConversionMax),
      `${Math.round(stats.sourceConversionRate * 100)}% of past "${lead.source}" leads converted`);
  }
  const last = lead.lastContactedAt || lead.updatedAt || lead.createdAt;
  if (last) {
    const days = (now - new Date(last)) / 86400000;
    if (days > config.inactivity.afterDays) add('inactivity', config.inactivity.points, `No contact for ${Math.floor(days)} days`);
  }

  const raw = factors.reduce((s, f) => s + f.points, 0);
  const score = Math.max(0, Math.min(100, Math.round(raw)));
  return { score, factors, label: score >= config.hotThreshold ? 'hot' : score >= 40 ? 'warm' : 'cold' };
}

export const STAGE_PROBABILITY = { prospecting: 10, qualification: 25, proposal: 50, negotiation: 70, won: 100, lost: 0 };

export function computeDealScore(deal, stats = {}, now = new Date()) {
  const factors = [];
  const add = (factor, points, detail) => { if (points) factors.push({ factor, points, detail }); };
  const base = deal.probability ?? STAGE_PROBABILITY[deal.stage] ?? 10;
  add('stage', base, `Stage "${deal.stage}"`);
  if (deal.stage === 'won' || deal.stage === 'lost') {
    return { score: base, factors, probability: base };
  }
  const last = deal.lastActivityAt || deal.updatedAt || deal.createdAt;
  const idleDays = last ? Math.floor((now - new Date(last)) / 86400000) : 0;
  if (idleDays > 21) add('inactivity', -20, `No activity for ${idleDays} days`);
  else if (idleDays > 7) add('inactivity', -10, `No activity for ${idleDays} days`);
  else add('recent_activity', 5, 'Activity in the last week');
  if (stats.connectedCalls) add('calls', Math.min(stats.connectedCalls * 3, 10), `${stats.connectedCalls} connected calls`);
  if (stats.positiveDispositions) add('call_outcome', 8, 'Positive call outcome');
  if (deal.expectedCloseDate && new Date(deal.expectedCloseDate) < now) add('overdue', -10, 'Expected close date has passed');
  const score = Math.max(0, Math.min(100, factors.reduce((s, f) => s + f.points, 0)));
  return { score, factors, probability: score, idleDays };
}

/**
 * Next best action for a lead or deal. Returns ordered suggestions, each with the reasons behind it.
 * @param ctx { kind: 'lead'|'deal', record, score, lastCall, openTasks, daysInactive, lastEmailAt }
 */
export function suggestNextBestActions(ctx, now = new Date()) {
  const s = [];
  const { kind, record, lastCall, openTasks = [], score = 0 } = ctx;
  const last = record.lastContactedAt || record.lastActivityAt || record.updatedAt || record.createdAt;
  const daysInactive = last ? Math.floor((now - new Date(last)) / 86400000) : null;
  const overdueTasks = openTasks.filter((t) => t.dueAt && new Date(t.dueAt) < now);
  const dispo = lastCall?.disposition?.code;

  if (overdueTasks.length) {
    s.push({ action: 'complete_task', priority: 'high', title: `Complete overdue task: ${overdueTasks[0].title}`,
      reasons: [`${overdueTasks.length} overdue task(s)`], taskId: overdueTasks[0]._id });
  }
  if (dispo === 'callback_requested') {
    s.push({ action: 'call', priority: 'high', title: 'Call back — customer requested a callback',
      reasons: ['Last call disposition: Callback Requested'] });
  }
  if (dispo === 'interested' && kind === 'lead') {
    s.push({ action: 'schedule_meeting', priority: 'high', title: 'Schedule a demo/meeting',
      reasons: ['Customer showed interest on the last call'] });
  }
  if (lastCall && ['no_answer', 'busy', 'not_connected'].includes(dispo || lastCall.status)) {
    s.push({ action: 'send_message', priority: 'medium', title: 'Send a WhatsApp/SMS follow-up',
      reasons: ['Last call did not connect'] });
  }
  if (kind === 'lead') {
    if (record.status === 'new' && !lastCall) {
      s.push({ action: 'call', priority: score >= 60 ? 'high' : 'medium', title: 'Make the first call',
        reasons: ['Lead has not been contacted yet', `Lead score ${score}`] });
    }
    if (score >= 70 && record.status !== 'qualified') {
      s.push({ action: 'qualify', priority: 'medium', title: 'Qualify this lead', reasons: [`High lead score (${score})`] });
    }
  }
  if (kind === 'deal') {
    if (record.stage === 'proposal' && daysInactive != null && daysInactive >= 5) {
      s.push({ action: 'send_email', priority: 'high', title: 'Follow up on the proposal',
        reasons: [`Proposal stage with no activity for ${daysInactive} days`] });
    }
    if (dispo === 'demo_scheduled' && record.stage === 'qualification') {
      s.push({ action: 'move_stage', priority: 'medium', title: 'Move deal to Proposal', toStage: 'proposal',
        reasons: ['A demo has been scheduled'] });
    }
    if (record.expectedCloseDate && new Date(record.expectedCloseDate) < now && !['won', 'lost'].includes(record.stage)) {
      s.push({ action: 'update_close_date', priority: 'medium', title: 'Update expected close date',
        reasons: ['Expected close date has passed'] });
    }
  }
  if (daysInactive != null && daysInactive >= 7 && !s.some((x) => x.action === 'call')) {
    s.push({ action: 'call', priority: daysInactive >= 14 ? 'high' : 'medium', title: 'Re-engage with a call',
      reasons: [`No interaction for ${daysInactive} days`] });
  }
  if (!openTasks.length) {
    s.push({ action: 'create_follow_up', priority: 'low', title: 'Create a follow-up task',
      reasons: ['No open follow-up task exists'] });
  }
  const rank = { high: 0, medium: 1, low: 2 };
  return s.sort((a, b) => rank[a.priority] - rank[b.priority]);
}

/** Weighted pipeline forecast grouped by expected close month. */
export function forecastDeals(deals) {
  const months = {};
  for (const d of deals) {
    if (d.stage === 'lost') continue;
    const key = d.expectedCloseDate ? new Date(d.expectedCloseDate).toISOString().slice(0, 7) : 'unscheduled';
    months[key] ||= { month: key, pipeline: 0, weighted: 0, won: 0, deals: 0 };
    const p = (d.score ?? d.probability ?? STAGE_PROBABILITY[d.stage] ?? 0) / 100;
    months[key].deals += 1;
    if (d.stage === 'won') months[key].won += d.value || 0;
    else {
      months[key].pipeline += d.value || 0;
      months[key].weighted += Math.round((d.value || 0) * p);
    }
  }
  return Object.values(months).sort((a, b) => a.month.localeCompare(b.month));
}
