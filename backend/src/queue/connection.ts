import IORedis, { type Redis } from 'ioredis';
import { env } from '../config/env';
import { childLogger } from '../config/logger';

const log = childLogger('redis');

/**
 * BullMQ requires `maxRetriesPerRequest: null` on the connection it blocks on.
 * We keep two clients:
 *   - `queueConnection` for BullMQ itself
 *   - `redis` for our own counters, locks and Lua scripts
 * so that a long blocking read in BullMQ never stalls a rate-limit check.
 */

function build(name: string, overrides: Record<string, unknown> = {}): Redis {
  const client = new IORedis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: false,
    ...overrides,
  });

  client.on('error', (err) => log.error({ err, client: name }, 'redis connection error'));
  client.on('reconnecting', () => log.warn({ client: name }, 'redis reconnecting'));
  return client;
}

export const queueConnection = build('bullmq');
export const redis = build('app');

export async function closeRedis(): Promise<void> {
  await Promise.allSettled([queueConnection.quit(), redis.quit()]);
}
