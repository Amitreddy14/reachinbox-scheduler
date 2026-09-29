import type { User } from '../db/schema';

declare global {
  namespace Express {
    interface Request {
      /** Populated by `requireAuth`. */
      user?: User;
    }
  }
}

export {};
