import type { Redis } from 'ioredis';
import { redis } from '../queue/connection';
import { env } from '../config/env';
import { childLogger } from '../config/logger';
import { currentWindowStart, HOUR_MS } from '../utils/time';

const log = childLogger('rate-limiter');

// Re-exported so callers that already depend on the limiter need not reach for
// a second module just to read a window boundary.
export { currentWindowStart, HOUR_MS };

/**
 * Why a Lua script instead of GET/INCR from Node
 * ----------------------------------------------
 * Three conditions have to be evaluated together for a send to be legal:
 *
 *   1. the sender has not used up its hourly quota,
 *   2. the account has not used up its global hourly quota,
 *   3. enough wall-clock time has passed since this sender's previous send.
 *
 * Checking them with separate round trips leaves a window where two workers
 * both read "199 of 200" and both send. Redis runs a script atomically on a
 * single thread, so the check-and-consume below is indivisible no matter how
 * many worker processes or machines are running. Nothing is held in process
 * memory, which is what makes this safe to scale horizontally.
 *
 * The script either consumes a slot (and moves the sender's next-allowed
 * timestamp forward) or consumes nothing at all and reports how long to wait.
 */
const ACQUIRE_SLOT = `
local senderCountKey = KEYS[1]
local senderGateKey  = KEYS[2]
local globalCountKey = KEYS[3]

local now           = tonumber(ARGV[1])
local senderLimit   = tonumber(ARGV[2])
local globalLimit   = tonumber(ARGV[3])
local minGapMs      = tonumber(ARGV[4])
local windowEndsAt  = tonumber(ARGV[5])
local windowTtl     = tonumber(ARGV[6])

-- 1. hourly quota for this sender
local senderUsed = tonumber(redis.call('GET', senderCountKey) or '0')
if senderUsed >= senderLimit then
  return { 0, windowEndsAt - now, 'SENDER_HOURLY_LIMIT', senderUsed, senderLimit }
end

-- 2. hourly quota across every sender of the account
local globalUsed = tonumber(redis.call('GET', globalCountKey) or '0')
if globalUsed >= globalLimit then
  return { 0, windowEndsAt - now, 'GLOBAL_HOURLY_LIMIT', globalUsed, globalLimit }
end

-- 3. minimum spacing between two sends from this sender
local nextAllowedAt = tonumber(redis.call('GET', senderGateKey) or '0')
if now < nextAllowedAt then
  return { 0, nextAllowedAt - now, 'MIN_GAP', senderUsed, senderLimit }
end

-- all three passed: consume the slot
redis.call('SET', senderGateKey, now + minGapMs, 'PX', minGapMs + 60000)
local newSenderUsed = redis.call('INCR', senderCountKey)
if newSenderUsed == 1 then redis.call('EXPIRE', senderCountKey, windowTtl) end
local newGlobalUsed = redis.call('INCR', globalCountKey)
if newGlobalUsed == 1 then redis.call('EXPIRE', globalCountKey, windowTtl) end

return { 1, 0, 'OK', newSenderUsed, senderLimit }
`;

export type DenyReason = 'SENDER_HOURLY_LIMIT' | 'GLOBAL_HOURLY_LIMIT' | 'MIN_GAP';

export type SlotDecision =
  | { allowed: true; used: number; limit: number; windowStart: number }
  | {
      allowed: false;
      reason: DenyReason;
      retryAfterMs: number;
      used: number;
      limit: number;
      windowStart: number;
    };

export interface AcquireSlotInput {
  userId: string;
  senderId: string;
  /** Per-sender hourly ceiling; clamped to the env maximum by the caller. */
  senderHourlyLimit: number;
  /** Minimum gap in ms between two sends from this sender. */
  minGapMs: number;
  now?: number;
}

function keys(userId: string, senderId: string, windowStart: number) {
  return {
    senderCount: `rl:sender:${senderId}:${windowStart}`,
    senderGate: `rl:gate:${senderId}`,
    globalCount: `rl:user:${userId}:${windowStart}`,
  };
}

let scriptSha: string | null = null;

async function evalAcquire(client: Redis, argKeys: string[], argv: (string | number)[]) {
  try {
    if (!scriptSha) scriptSha = await client.script('LOAD', ACQUIRE_SLOT) as string;
    return (await client.evalsha(scriptSha, argKeys.length, ...argKeys, ...argv)) as unknown[];
  } catch (err) {
    // A flushed script cache (or a failover to a fresh Redis) invalidates the
    // SHA. Fall back to a full EVAL once and re-cache on the next call.
    if (err instanceof Error && err.message.includes('NOSCRIPT')) {
      scriptSha = null;
      return (await client.eval(ACQUIRE_SLOT, argKeys.length, ...argKeys, ...argv)) as unknown[];
    }
    throw err;
  }
}

/**
 * Atomically reserve the right to send one email now, or find out how long to
 * wait. Consumes quota only when it returns `allowed: true`.
 */
export async function acquireSendSlot(input: AcquireSlotInput): Promise<SlotDecision> {
  const now = input.now ?? Date.now();
  const windowStart = currentWindowStart(now);
  const windowEndsAt = windowStart + HOUR_MS;

  const senderLimit = Math.max(
    1,
    Math.min(input.senderHourlyLimit, env.MAX_EMAILS_PER_HOUR_PER_SENDER),
  );

  const k = keys(input.userId, input.senderId, windowStart);

  const raw = await evalAcquire(
    redis,
    [k.senderCount, k.senderGate, k.globalCount],
    [
      now,
      senderLimit,
      env.MAX_EMAILS_PER_HOUR_GLOBAL,
      Math.max(0, input.minGapMs),
      windowEndsAt,
      Math.ceil(HOUR_MS / 1000) + 60,
    ],
  );

  const ok = Number(raw[0]) === 1;
  const retryAfterMs = Number(raw[1]);
  const reason = String(raw[2]) as DenyReason | 'OK';
  const used = Number(raw[3]);
  const limit = Number(raw[4]);

  if (ok) return { allowed: true, used, limit, windowStart };

  log.debug({ senderId: input.senderId, reason, retryAfterMs, used, limit }, 'send slot denied');
  return {
    allowed: false,
    reason: reason as DenyReason,
    // Never return 0 — a 0ms delay would spin the worker.
    retryAfterMs: Math.max(retryAfterMs, 250),
    used,
    limit,
    windowStart,
  };
}

/** Read-only view of a sender's current hour, for the dashboard. */
export async function senderUsage(
  userId: string,
  senderId: string,
  now = Date.now(),
): Promise<{ used: number; globalUsed: number; windowStart: number; windowEndsAt: number }> {
  const windowStart = currentWindowStart(now);
  const k = keys(userId, senderId, windowStart);
  const [used, globalUsed] = await redis.mget(k.senderCount, k.globalCount);
  return {
    used: Number(used ?? 0),
    globalUsed: Number(globalUsed ?? 0),
    windowStart,
    windowEndsAt: windowStart + HOUR_MS,
  };
}

/**
 * Only used by the test/demo helper that resets a sender's hour so the limit
 * can be shown twice in one recording.
 */
export async function resetSenderWindow(userId: string, senderId: string): Promise<void> {
  const windowStart = currentWindowStart(Date.now());
  const k = keys(userId, senderId, windowStart);
  await redis.del(k.senderCount, k.senderGate, k.globalCount);
}
