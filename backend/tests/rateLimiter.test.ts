/**
 * These exercise the real Lua script against a real Redis, because the whole
 * point of the limiter is atomicity — a mocked Redis would prove nothing.
 *
 *   docker compose up -d redis
 *   npm run test
 *
 * The suite skips itself if Redis is unreachable, so `npm test` still passes in
 * an environment without the infrastructure.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acquireSendSlot,
  currentWindowStart,
  resetSenderWindow,
  senderUsage,
  HOUR_MS,
} from '../src/services/rateLimiter';
import { redis, closeRedis } from '../src/queue/connection';

let redisUp = false;

before(async () => {
  try {
    await redis.ping();
    redisUp = true;
  } catch {
    redisUp = false;
  }
});

after(async () => {
  if (redisUp) {
    await resetSenderWindow('limiter-test', 'sender-a').catch(() => undefined);
    await resetSenderWindow('limiter-test', 'sender-b').catch(() => undefined);
    await resetSenderWindow('limiter-parallel', 'sender-p').catch(() => undefined);
  }
  await closeRedis().catch(() => undefined);
});

describe('rate limiter', { skip: process.env.SKIP_REDIS_TESTS === '1' }, () => {
  test('allows the first send and consumes exactly one slot', async (t) => {
    if (!redisUp) return t.skip('Redis is not reachable');
    await resetSenderWindow('limiter-test', 'sender-a');

    const decision = await acquireSendSlot({
      userId: 'limiter-test',
      senderId: 'sender-a',
      senderHourlyLimit: 3,
      minGapMs: 50,
    });

    assert.equal(decision.allowed, true);
    assert.equal((await senderUsage('limiter-test', 'sender-a')).used, 1);
  });

  test('defers rather than fails when the minimum gap has not elapsed', async (t) => {
    if (!redisUp) return t.skip('Redis is not reachable');

    const decision = await acquireSendSlot({
      userId: 'limiter-test',
      senderId: 'sender-a',
      senderHourlyLimit: 3,
      minGapMs: 5000,
    });

    assert.equal(decision.allowed, false);
    if (!decision.allowed) {
      assert.equal(decision.reason, 'MIN_GAP');
      assert.ok(decision.retryAfterMs > 0);
    }
  });

  test('a denied attempt does not consume quota', async (t) => {
    if (!redisUp) return t.skip('Redis is not reachable');
    assert.equal((await senderUsage('limiter-test', 'sender-a')).used, 1);
  });

  test('stops at the hourly ceiling and points at the next window', async (t) => {
    if (!redisUp) return t.skip('Redis is not reachable');
    await resetSenderWindow('limiter-test', 'sender-b');

    const args = {
      userId: 'limiter-test',
      senderId: 'sender-b',
      senderHourlyLimit: 2,
      minGapMs: 0,
    };

    assert.equal((await acquireSendSlot(args)).allowed, true);
    assert.equal((await acquireSendSlot(args)).allowed, true);

    const denied = await acquireSendSlot(args);
    assert.equal(denied.allowed, false);
    if (!denied.allowed) {
      assert.equal(denied.reason, 'SENDER_HOURLY_LIMIT');
      assert.equal(denied.used, 2);
      assert.equal(denied.limit, 2);

      const windowEndsAt = currentWindowStart(Date.now()) + HOUR_MS;
      const resumesAt = Date.now() + denied.retryAfterMs;
      assert.ok(
        Math.abs(resumesAt - windowEndsAt) < 2000,
        'a limited job resumes at the start of the next hour window',
      );
    }
  });

  test('20 concurrent workers cannot exceed a limit of 5', async (t) => {
    if (!redisUp) return t.skip('Redis is not reachable');
    await resetSenderWindow('limiter-parallel', 'sender-p');

    const attempts = Array.from({ length: 20 }, () =>
      acquireSendSlot({
        userId: 'limiter-parallel',
        senderId: 'sender-p',
        senderHourlyLimit: 5,
        minGapMs: 0,
      }),
    );

    const results = await Promise.all(attempts);
    const winners = results.filter((result) => result.allowed).length;

    assert.equal(winners, 5, 'exactly five attempts may win the race');
    assert.equal((await senderUsage('limiter-parallel', 'sender-p')).used, 5);
  });

  test('a per-sender request above the configured maximum is clamped', async (t) => {
    if (!redisUp) return t.skip('Redis is not reachable');
    await resetSenderWindow('limiter-test', 'sender-clamp');

    const decision = await acquireSendSlot({
      userId: 'limiter-test',
      senderId: 'sender-clamp',
      senderHourlyLimit: 10_000,
      minGapMs: 0,
    });

    assert.equal(decision.allowed, true);
    // MAX_EMAILS_PER_HOUR_PER_SENDER, not the 10 000 the caller asked for.
    assert.ok(decision.limit <= 200);
  });
});
