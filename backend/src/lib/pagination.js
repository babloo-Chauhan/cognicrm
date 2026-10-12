import { badRequest } from './errors.js';

export const MAX_PAGE_SIZE = 200;

/** page ≥ 1 and 1 ≤ limit ≤ 200 from the query string; junk values fall back to the defaults. */
export function pageParams(query, defaultLimit = 50) {
  const int = (v) => (/^\d+$/.test(String(v ?? '')) ? Number(v) : NaN);
  const page = int(query.page);
  const limit = int(query.limit);
  return {
    page: page >= 1 ? Math.min(page, 100000) : 1,
    limit: limit >= 1 ? Math.min(limit, MAX_PAGE_SIZE) : defaultLimit,
  };
}

/**
 * "-createdAt" / "score" → a Mongo sort. Only `allowed` fields (ones with an index) can be used, so a client
 * can't ask for a sort that makes the database order a whole company's records in memory.
 */
export function sortParam(sort, fallback, allowed = null) {
  if (!sort) return fallback;
  const s = String(sort);
  const field = s.replace(/^-/, '');
  if (!/^-?[A-Za-z][\w.]{0,60}$/.test(s) || (allowed && !allowed.includes(field))) {
    throw badRequest(`Cannot sort by "${field}"${allowed ? ` (use ${allowed.join(', ')})` : ''}`);
  }
  return { [field]: s.startsWith('-') ? -1 : 1 };
}
