export class AppError extends Error {
  constructor(status, message, code, details) {
    super(message);
    this.status = status;
    this.code = code || 'ERROR';
    this.details = details;
  }
}

export const badRequest = (msg, details) => new AppError(400, msg, 'BAD_REQUEST', details);
export const unauthorized = (msg = 'Authentication required') => new AppError(401, msg, 'UNAUTHORIZED');
export const forbidden = (msg = 'You do not have permission to do this') => new AppError(403, msg, 'FORBIDDEN');
export const notFound = (what = 'Resource') => new AppError(404, `${what} not found`, 'NOT_FOUND');
export const conflict = (msg) => new AppError(409, msg, 'CONFLICT');
export const tooMany = (msg) => new AppError(429, msg, 'LIMIT_EXCEEDED');

/** Raised when a provider does not support a feature (capability check failed). */
export class CapabilityError extends AppError {
  constructor(provider, capability) {
    super(422, `Provider "${provider}" does not support "${capability}"`, 'CAPABILITY_NOT_SUPPORTED', { provider, capability });
  }
}

/** Raised when a feature needs a provider that has not been configured. */
export class NotConfiguredError extends AppError {
  constructor(what) {
    super(424, `${what} is not configured for this organization`, 'NOT_CONFIGURED', { what });
  }
}
