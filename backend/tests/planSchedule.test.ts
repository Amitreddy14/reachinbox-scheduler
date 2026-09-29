import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planSchedule } from '../src/modules/campaigns/planSchedule';
import { HOUR_MS } from '../src/utils/time';
import type { Sender } from '../src/db/schema';

function sender(id: string, hourlyLimit: number | null = null): Sender {
  return {
    id,
    userId: 'user-1',
    email: `${id}@ethereal.email`,
    displayName: id,
    smtpHost: 'smtp.ethereal.email',
    smtpPort: 587,
    smtpSecure: false,
    smtpUser: id,
    smtpPassword: 'secret',
    hourlyLimit,
    minGapMs: null,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

const START = new Date('2026-01-01T10:00:00.000Z');
const windowOf = (date: Date) => Math.floor(date.getTime() / HOUR_MS);

test('deals recipients round-robin across the active senders', () => {
  const plan = planSchedule(
    ['a@x.io', 'b@x.io', 'c@x.io', 'd@x.io'],
    [sender('s1'), sender('s2')],
    START,
    1000,
    100,
  );

  assert.deepEqual(
    plan.map((item) => item.senderId),
    ['s1', 's2', 's1', 's2'],
  );
});

test('spaces consecutive sends by the requested delay', () => {
  const plan = planSchedule(['a@x.io', 'b@x.io', 'c@x.io'], [sender('s1')], START, 2000, 100);

  assert.equal(plan[0]!.scheduledAt.getTime() - START.getTime(), 0);
  assert.equal(plan[1]!.scheduledAt.getTime() - START.getTime(), 2000);
  assert.equal(plan[2]!.scheduledAt.getTime() - START.getTime(), 4000);
});

test('keeps every recipient when the hourly cap is exceeded, pushing them into later windows', () => {
  const recipients = Array.from({ length: 5 }, (_, i) => `r${i}@x.io`);
  const plan = planSchedule(recipients, [sender('s1')], START, 0, 2);

  assert.equal(plan.length, 5, 'nothing is dropped');

  const base = windowOf(START);
  assert.deepEqual(
    plan.map((item) => windowOf(item.scheduledAt) - base),
    [0, 0, 1, 1, 2],
  );
});

test('a per-sender limit lower than the campaign limit wins', () => {
  const recipients = Array.from({ length: 4 }, (_, i) => `r${i}@x.io`);
  const plan = planSchedule(recipients, [sender('slow', 1)], START, 0, 500);

  const base = windowOf(START);
  assert.deepEqual(
    plan.map((item) => windowOf(item.scheduledAt) - base),
    [0, 1, 2, 3],
  );
});

test('sequence numbers stay dense and ordered so deferrals can restore FIFO', () => {
  const recipients = Array.from({ length: 6 }, (_, i) => `r${i}@x.io`);
  const plan = planSchedule(recipients, [sender('s1'), sender('s2')], START, 500, 100);

  assert.deepEqual(
    plan.map((item) => item.sequence),
    [0, 1, 2, 3, 4, 5],
  );
});

test('two senders double the throughput of a single hourly window', () => {
  const recipients = Array.from({ length: 4 }, (_, i) => `r${i}@x.io`);
  const plan = planSchedule(recipients, [sender('s1'), sender('s2')], START, 0, 2);

  const base = windowOf(START);
  // 2 per sender per hour x 2 senders = all four fit in the first window.
  assert.deepEqual(
    plan.map((item) => windowOf(item.scheduledAt) - base),
    [0, 0, 0, 0],
  );
});
