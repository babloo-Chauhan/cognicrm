import mongoose from 'mongoose';
import { ZodError } from 'zod';
import { AppError, badRequest } from '../lib/errors.js';

/** Validates req.body (or another key) with a zod schema and replaces it with the parsed value. */
export const validate = (schema, key = 'body') => (req, _res, next) => {
  const result = schema.safeParse(req[key]);
  if (!result.success) throw badRequest('Validation failed', result.error.issues);
  if (key === 'body') req.body = result.data;
  else req.validated = result.data;
  next();
};

export function notFoundHandler(req, res) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.path} not found` } });
}

export function errorHandler(err, req, res, _next) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err instanceof ZodError) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Validation failed', details: err.issues } });
  }
  if (err instanceof mongoose.Error.ValidationError) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: err.message } });
  }
  if (err instanceof mongoose.Error.CastError) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: `Invalid ${err.path}` } });
  }
  if (err?.code === 11000) {
    return res.status(409).json({ error: { code: 'CONFLICT', message: 'Duplicate record' } });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Malformed JSON' } });
  }
  console.error(err);
  return res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
}

export function isObjectId(value) {
  return mongoose.isValidObjectId(value);
}
