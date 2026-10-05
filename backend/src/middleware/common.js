import mongoose from 'mongoose';
import { ZodError } from 'zod';
import { env } from '../config/env.js';
import { AppError, badRequest } from '../lib/errors.js';
import { log } from '../lib/logger.js';

/** Validates req.body (or another key) with a zod schema and replaces it with the parsed value. */
export const validate = (schema, key = 'body') => (req, _res, next) => {
  const result = schema.safeParse(req[key]);
  if (!result.success) throw badRequest('Validation failed', result.error.issues);
  if (key === 'body') req.body = result.data;
  else req.validated = result.data;
  next();
};

/**
 * Mongo query protection: drops `$`-prefixed keys from JSON bodies so values like {"$gt": ""} or
 * {"$where": ...} can never reach a query or update. (Express 5's query parser does not build objects.)
 */
function stripOperators(value, depth = 0) {
  if (depth > 20 || !value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => stripOperators(v, depth + 1));
  if (Buffer.isBuffer(value)) return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (k.startsWith('$') || k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = stripOperators(v, depth + 1);
  }
  return out;
}

export function sanitizeBody(req, _res, next) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) req.body = stripOperators(req.body);
  next();
}

/**
 * Error body: `success`, `message`, `code`, `errors` (the documented contract) plus the legacy
 * `error: { code, message, details }` object that the existing web and mobile clients read.
 */
function send(res, status, code, message, errors) {
  return res.status(status).json({
    success: false, message, code, errors: errors || [], error: { code, message, details: errors },
  });
}

export function notFoundHandler(req, res) {
  send(res, 404, 'NOT_FOUND', `Route ${req.method} ${req.path} not found`);
}

export function errorHandler(err, req, res, _next) {
  if (err instanceof AppError) return send(res, err.status, err.code, err.message, err.details);
  if (err instanceof ZodError) return send(res, 400, 'BAD_REQUEST', 'Validation failed', err.issues);
  if (err instanceof mongoose.Error.ValidationError) {
    return send(res, 400, 'BAD_REQUEST', err.message, Object.values(err.errors).map((e) => ({ path: [e.path], message: e.message })));
  }
  if (err instanceof mongoose.Error.CastError) return send(res, 400, 'BAD_REQUEST', `Invalid ${err.path}`);
  if (err?.code === 11000) return send(res, 409, 'CONFLICT', 'Duplicate record');
  if (err?.type === 'entity.parse.failed') return send(res, 400, 'BAD_REQUEST', 'Malformed JSON');
  if (err?.type === 'entity.too.large') return send(res, 413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
  log.error('unhandled_error', {
    method: req.method, path: req.originalUrl.split('?')[0], error: err?.message, stack: env.nodeEnv === 'production' ? undefined : err?.stack,
  });
  // Production never exposes internals; development shows the message to speed up debugging
  return send(res, 500, 'INTERNAL', env.nodeEnv === 'production' ? 'Internal server error' : `Internal server error: ${err?.message}`);
}

export function isObjectId(value) {
  return mongoose.isValidObjectId(value);
}
