import { badRequest } from './errors.js';

import mongoose from 'mongoose';

export const MAX_PAGE_SIZE = 200;

/**
 * Cursor ("give me the records after this one") for load-more lists. Unlike page numbers it costs the same
 * on the 2nd and the 2000th page: the database seeks straight to the position in the index.
 * The cursor holds the sort value and _id of the last record shown.
 */
export function encodeCursor(item, field) {
  const value = item?.[field];
  if (value === undefined || value === null) return null; // records without a value can't be positioned
  return Buffer.from(JSON.stringify([value instanceof Date ? value.toISOString() : value, String(item.id ?? item._id)])).toString('base64url');
}

/**
 * The records after `cursor` in `sort` order ({ field: ±1 }), as two conditions the index can answer by range:
 * `tie` (same sort value, later _id — usually none) and `rest` (strictly later sort value). A single $or of the
 * two is not turned into index bounds by MongoDB and scans everything before the cursor. 400 for a bad cursor.
 */
export function cursorFilter(cursor, sort, Model) {
  const [field, dir] = Object.entries(sort)[0];
  let value;
  let id;
  try {
    [value, id] = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (!mongoose.isValidObjectId(id)) throw new Error('id');
  } catch {
    throw badRequest('Invalid cursor');
  }
  if (Model.schema.path(field)?.instance === 'Date') value = new Date(value);
  const cmp = dir < 0 ? '$lt' : '$gt';
  const oid = new mongoose.Types.ObjectId(id);
  return { tie: { [field]: value, _id: { [cmp]: oid } }, rest: { [field]: { [cmp]: value } } };
}

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
