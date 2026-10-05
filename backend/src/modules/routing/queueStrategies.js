/**
 * Agent selection strategies for call queues. Pure functions, easy to test.
 *
 * @param agents  available agents: [{ userId, priority, lastCallEndedAt, activeCalls, callsToday, since }]
 * @param queue   { strategy, lastAssignedIndex }
 * @returns { selected: agents[], nextIndex? }  — ring_all returns every agent, others return one.
 */
export function selectAgents(agents, queue, random = Math.random) {
  if (!agents.length) return { selected: [] };
  const byPriority = [...agents].sort((a, b) => (b.priority || 0) - (a.priority || 0));
  const topPriority = byPriority[0].priority || 0;
  const pool = byPriority.filter((a) => (a.priority || 0) === topPriority);

  switch (queue.strategy) {
    case 'ring_all':
      return { selected: pool };
    case 'round_robin': {
      const ordered = [...pool].sort((a, b) => String(a.userId).localeCompare(String(b.userId)));
      const nextIndex = ((queue.lastAssignedIndex ?? -1) + 1) % ordered.length;
      return { selected: [ordered[nextIndex]], nextIndex };
    }
    case 'least_busy': {
      const sorted = [...pool].sort((a, b) => (a.callsToday || 0) - (b.callsToday || 0)
        || idleSince(a) - idleSince(b));
      return { selected: [sorted[0]] };
    }
    case 'random':
      return { selected: [pool[Math.floor(random() * pool.length)]] };
    case 'longest_idle':
    default: {
      const sorted = [...pool].sort((a, b) => idleSince(a) - idleSince(b));
      return { selected: [sorted[0]] };
    }
  }
}

function idleSince(agent) {
  return new Date(agent.lastCallEndedAt || agent.since || 0).getTime();
}
