/**
 * Hour-window helpers.
 *
 * Rate limiting is keyed by a fixed, wall-clock hour window rather than a
 * rolling one: every worker computes the same key from the same timestamp with
 * no coordination, and the counter expires on its own. A rolling window would
 * need a sorted set per sender and a read-modify-write on every send.
 *
 * These live outside the limiter so that scheduling logic can reason about
 * windows without opening a Redis connection.
 */

export const HOUR_MS = 60 * 60 * 1000;

/** Start of the hour window containing `timestamp`. */
export function currentWindowStart(timestamp: number): number {
  return Math.floor(timestamp / HOUR_MS) * HOUR_MS;
}

export function nextWindowStart(timestamp: number): number {
  return currentWindowStart(timestamp) + HOUR_MS;
}
