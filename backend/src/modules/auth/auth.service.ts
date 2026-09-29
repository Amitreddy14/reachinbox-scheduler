import { eq } from 'drizzle-orm';
import { OAuth2Client } from 'google-auth-library';
import jwt, { type SignOptions } from 'jsonwebtoken';
import { env } from '../../config/env';
import { db } from '../../db/client';
import { users, type User } from '../../db/schema';
import { ApiError } from '../../utils/errors';

const googleClient = new OAuth2Client(env.GOOGLE_CLIENT_ID);

export interface SessionPayload {
  sub: string;
  email: string;
}

export function issueSessionToken(user: User): string {
  const payload: SessionPayload = { sub: user.id, email: user.email };
  const options: SignOptions = { expiresIn: env.JWT_EXPIRES_IN as SignOptions['expiresIn'] };
  return jwt.sign(payload, env.JWT_SECRET, options);
}

export function verifySessionToken(token: string): SessionPayload {
  try {
    return jwt.verify(token, env.JWT_SECRET) as SessionPayload;
  } catch {
    throw ApiError.unauthorized('Session token is invalid or has expired');
  }
}

export interface GoogleProfile {
  googleId: string;
  email: string;
  name: string;
  avatarUrl: string | null;
}

/**
 * The frontend completes the Google consent screen and forwards the resulting
 * ID token. We verify the signature and the audience here rather than trusting
 * the profile fields the browser sends, then mint our own session token so the
 * API never depends on Google being reachable afterwards.
 */
export async function verifyGoogleIdToken(idToken: string): Promise<GoogleProfile> {
  if (!env.GOOGLE_CLIENT_ID) {
    throw ApiError.internal('GOOGLE_CLIENT_ID is not configured on the server');
  }

  let ticket;
  try {
    ticket = await googleClient.verifyIdToken({ idToken, audience: env.GOOGLE_CLIENT_ID });
  } catch {
    throw ApiError.unauthorized('Google ID token could not be verified');
  }

  const payload = ticket.getPayload();
  if (!payload?.sub || !payload.email) {
    throw ApiError.unauthorized('Google ID token is missing the required claims');
  }
  if (payload.email_verified === false) {
    throw ApiError.forbidden('This Google account does not have a verified email address');
  }

  return {
    googleId: payload.sub,
    email: payload.email.toLowerCase(),
    name: payload.name ?? payload.email.split('@')[0] ?? 'ReachInbox user',
    avatarUrl: payload.picture ?? null,
  };
}

export async function upsertUser(profile: GoogleProfile): Promise<User> {
  const [user] = await db
    .insert(users)
    .values({
      googleId: profile.googleId,
      email: profile.email,
      name: profile.name,
      avatarUrl: profile.avatarUrl,
    })
    .onConflictDoUpdate({
      target: users.googleId,
      set: {
        email: profile.email,
        name: profile.name,
        avatarUrl: profile.avatarUrl,
        updatedAt: new Date(),
      },
    })
    .returning();

  if (!user) throw ApiError.internal('Could not persist the signed-in user');
  return user;
}

export async function findUserById(id: string): Promise<User | null> {
  const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return user ?? null;
}
