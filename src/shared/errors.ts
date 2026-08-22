/** Base class for errors that are safe to surface to API clients. */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id: string) {
    super(404, 'not_found', `${resource} '${id}' was not found`);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super(409, 'conflict', message, details);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(422, 'unprocessable_entity', message, details);
  }
}

/**
 * Authentication failure. The message is deliberately uniform: distinguishing
 * "unknown", "revoked" and "expired" to the caller is an enumeration oracle.
 */
export class UnauthorizedError extends AppError {
  constructor(message = 'invalid or missing API key') {
    super(401, 'unauthorized', message);
  }
}

/** Authenticated, but the key's role is insufficient for this route. */
export class ForbiddenError extends AppError {
  constructor(requiredRole: string) {
    super(403, 'forbidden', `this API key does not have the required '${requiredRole}' role`);
  }
}

/** Rate limit exceeded. `retryAfterSeconds` is surfaced as a `Retry-After` header. */
export class RateLimitedError extends AppError {
  constructor(
    readonly retryAfterSeconds: number,
    readonly scope: 'ip' | 'api_key' | 'bootstrap',
  ) {
    super(429, 'rate_limited', 'rate limit exceeded, retry later');
  }
}
