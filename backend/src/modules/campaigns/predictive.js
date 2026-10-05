/**
 * Predictive dialer pacing model.
 *
 * Calculates how many calls to place right now from:
 *  - available agents (and agents about to finish wrap-up)
 *  - historical answer probability
 *  - average handle time vs. ring time
 *  - current abandon rate
 *
 * Compliance safeguards (never optional):
 *  - predictive mode must be explicitly enabled AND compliance-acknowledged per campaign
 *  - dial ratio is capped by `maxDialRatio`
 *  - if the measured abandon rate exceeds `maxAbandonRate`, pacing falls back to 1:1 (power dialing)
 *  - with too little history, pacing stays at 1:1
 */
export function computePredictiveDialCount({
  availableAgents,
  agentsFinishingSoon = 0,
  inFlightCalls = 0,
  answerRate, // 0..1 from history
  abandonRate = 0, // 0..1 over recent window
  sampleSize = 0,
  settings = {},
}) {
  const { enabled = false, complianceAcknowledged = false, maxAbandonRate = 0.03, maxDialRatio = 1.5, minSample = 50 } = settings;
  const capacity = Math.max(0, availableAgents + Math.floor(agentsFinishingSoon * 0.5));
  if (capacity === 0) return { dialCount: 0, ratio: 0, reason: 'No agent capacity' };

  if (!enabled || !complianceAcknowledged) {
    return { dialCount: Math.max(0, availableAgents - inFlightCalls), ratio: 1, reason: 'Predictive pacing disabled — 1:1 dialing' };
  }
  if (sampleSize < minSample || !answerRate) {
    return { dialCount: Math.max(0, availableAgents - inFlightCalls), ratio: 1, reason: 'Not enough history — 1:1 dialing' };
  }
  if (abandonRate > maxAbandonRate) {
    return { dialCount: Math.max(0, availableAgents - inFlightCalls), ratio: 1, reason: `Abandon rate ${(abandonRate * 100).toFixed(1)}% above limit — throttled to 1:1` };
  }
  const ratio = Math.min(maxDialRatio, Math.max(1, 1 / answerRate));
  const dialCount = Math.max(0, Math.floor(capacity * ratio) - inFlightCalls);
  return { dialCount, ratio: Number(ratio.toFixed(2)), reason: `Answer rate ${(answerRate * 100).toFixed(0)}%` };
}
