const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Returns the wall-clock date/time parts in a time zone. */
export function localParts(date, timeZone = 'UTC') {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}`,
    day: WEEKDAYS[parts.weekday],
  };
}

export function inRange(time, open, close) {
  if (!open || !close) return false;
  if (open === close) return true; // 24h
  if (open < close) return time >= open && time < close;
  return time >= open || time < close; // crosses midnight
}

/**
 * Evaluates a BusinessHours config at a moment.
 * @returns {'open'|'closed'|'holiday'}
 */
export function evaluateBusinessHours(config, now = new Date()) {
  if (!config) return 'open';
  const { date, time, day } = localParts(now, config.timezone || 'UTC');
  if ((config.holidays || []).some((h) => h.date === date)) return 'holiday';
  const special = (config.specialHours || []).find((s) => s.date === date);
  if (special) {
    if (special.closed) return 'closed';
    return inRange(time, special.open, special.close) ? 'open' : 'closed';
  }
  const ranges = (config.weekly || []).filter((w) => w.day === day);
  return ranges.some((r) => inRange(time, r.open, r.close)) ? 'open' : 'closed';
}

/** Generic "allowed window" check used by calling-hours compliance and campaign schedules. */
export function isWithinWindow({ timezone = 'UTC', days, start, end }, now = new Date()) {
  const { time, day } = localParts(now, timezone);
  if (days?.length && !days.includes(day)) return false;
  if (!start || !end) return true;
  return inRange(time, start, end);
}
