import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { ApiError } from '../utils/errors';
import { childLogger } from '../config/logger';
import { isProduction } from '../config/env';

const log = childLogger('http');

/** Postgres error codes we translate into meaningful HTTP responses. */
const PG_UNIQUE_VIOLATION = '23505';
const PG_FOREIGN_KEY_VIOLATION = '23503';

function pgErrorCode(err: unknown): string | null {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: `No route matches ${req.method} ${req.originalUrl}` },
  });
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof ZodError) {
    res.status(422).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'The request body failed validation',
        details: err.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    });
    return;
  }

  if (err instanceof ApiError) {
    res.status(err.statusCode).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }

  const code = pgErrorCode(err);
  if (code === PG_UNIQUE_VIOLATION) {
    res.status(409).json({
      error: { code: 'CONFLICT', message: 'A record with these values already exists' },
    });
    return;
  }
  if (code === PG_FOREIGN_KEY_VIOLATION) {
    res.status(409).json({
      error: { code: 'CONFLICT', message: 'A referenced record does not exist' },
    });
    return;
  }

  log.error({ err }, 'unhandled error');
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: isProduction
        ? 'Something went wrong'
        : ((err as Error)?.message ?? 'Unknown error'),
    },
  });
}
