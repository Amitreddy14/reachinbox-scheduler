import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../utils/errors';
import { findUserById, verifySessionToken } from '../modules/auth/auth.service';

function extractToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  const cookie = (req as Request & { cookies?: Record<string, string> }).cookies?.session;
  return cookie ?? null;
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const token = extractToken(req);
    if (!token) throw ApiError.unauthorized();

    const payload = verifySessionToken(token);
    const user = await findUserById(payload.sub);
    if (!user) throw ApiError.unauthorized('The account on this session no longer exists');

    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

/** Same as requireAuth but never rejects — used by the Slack OAuth redirect. */
export async function optionalAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const token = extractToken(req);
    if (token) {
      const payload = verifySessionToken(token);
      const user = await findUserById(payload.sub);
      if (user) req.user = user;
    }
  } catch {
    // ignore: the route decides what to do without a user
  }
  next();
}

export function currentUser(req: Request) {
  if (!req.user) throw ApiError.unauthorized();
  return req.user;
}
