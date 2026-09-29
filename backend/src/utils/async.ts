import type { NextFunction, Request, Response, RequestHandler } from 'express';

/**
 * Express 4 does not forward rejected promises to the error middleware, so
 * every async handler is wrapped once here instead of carrying a try/catch.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    void fn(req, res, next).catch(next);
  };
}
