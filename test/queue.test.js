import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Backoff, InvalidCursorError } from '../src/queue.js';

/** @type {(attempt: number, base: number, cap: number, random: () => number) => number} */
const backoffMs = (attempt, base, cap, random) => new Backoff(base, cap, random).delay(attempt);
import { testConfig, testQueue } from './helpers.js';

const config = testConfig();
const payload = { channel: 'webhook', url: 'https://x.example', event: 'e', data: {} };

test('backoffMs grows exponentially with equal jitter and respects the cap', () => {
  assert.equal(backoffMs(1, 100, 10_000, () => 0), 50);
  assert.equal(backoffMs(1, 100, 10_000, () => 1), 100);
  assert.equal(backoffMs(4, 100, 10_000, () => 0), 400);
  assert.equal(backoffMs(20, 100, 10_000, () => 1), 10_000);
});

test('enqueue + claim + markSent lifecycle', () => {
  const q = testQueue(config);
  const { row, created } = q.enqueue({ apiKeyId: 'a', channel: 'webhook', payload }, 1000);
  assert.equal(created, true);
  assert.equal(row.status, 'queued');
  assert.equal(row.max_attempts, 3);

  assert.deepEqual(q.claim(5, 999), [], 'not due yet');
  const claimed = q.claim(5, 1000);
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].status, 'processing');
  assert.equal(claimed[0].locked_until, 1000 + config.lockTtlMs);
  assert.deepEqual(q.claim(5, 1000), [], 'already claimed');

  q.markSent(row.id, 'msg-1', 1100);
  const after = q.get(row.id, 'a');
  assert.equal(after?.status, 'sent');
  assert.equal(after?.provider_id, 'msg-1');
  assert.equal(after?.sent_at, 1100);
  assert.equal(q.get(row.id, 'b'), undefined, 'scoped by api key');
});

test('idempotency key returns the existing row per api key', () => {
  const q = testQueue(config);
  const first = q.enqueue({ apiKeyId: 'a', idempotencyKey: 'k1', channel: 'webhook', payload });
  const replay = q.enqueue({ apiKeyId: 'a', idempotencyKey: 'k1', channel: 'webhook', payload });
  const otherKey = q.enqueue({ apiKeyId: 'b', idempotencyKey: 'k1', channel: 'webhook', payload });
  assert.equal(replay.created, false);
  assert.equal(replay.row.id, first.row.id);
  assert.equal(otherKey.created, true);
  assert.notEqual(otherKey.row.id, first.row.id);
  const noKey1 = q.enqueue({ apiKeyId: 'a', channel: 'webhook', payload });
  const noKey2 = q.enqueue({ apiKeyId: 'a', channel: 'webhook', payload });
  assert.notEqual(noKey1.row.id, noKey2.row.id);
});

test('markFailure re-queues with backoff, fails after max attempts or when final', () => {
  const q = testQueue(config);
  const { row } = q.enqueue({ apiKeyId: 'a', channel: 'webhook', payload }, 0);
  let [c] = q.claim(1, 0);
  let u = q.markFailure(c, 'boom', { now: 0 });
  assert.equal(u?.status, 'queued');
  assert.equal(u?.attempts, 1);
  assert.ok(u && u.next_attempt_at >= 50 && u.next_attempt_at <= 100, `backoff ${u?.next_attempt_at}`);
  assert.equal(u?.last_error, 'boom');

  [c] = q.claim(1, 1000);
  u = q.markFailure(c, 'boom2', { now: 1000 });
  assert.equal(u?.status, 'queued');
  assert.equal(u?.attempts, 2);

  [c] = q.claim(1, 5000);
  u = q.markFailure(c, 'boom3', { now: 5000 });
  assert.equal(u?.status, 'failed', 'third failure exhausts max_attempts=3');
  assert.equal(q.claim(1, 999_999).length, 0);

  const { row: r2 } = q.enqueue({ apiKeyId: 'a', channel: 'webhook', payload }, 0);
  [c] = q.claim(1, 0);
  u = q.markFailure(c, 'permanent', { final: true, now: 0 });
  assert.equal(u?.status, 'failed');
  assert.equal(u?.attempts, 1);

  const retried = q.retry(r2.id, 'a', 10);
  assert.equal(retried?.status, 'queued');
  assert.equal(retried?.attempts, 0);
  assert.equal(q.retry(row.id, 'wrong-key', 10), undefined);
  assert.equal(q.retry(retried.id, 'a', 10), undefined, 'only failed rows can be retried');
});

test('reapStale recovers expired locks; purge removes old finished rows', () => {
  const q = testQueue(config);
  const { row } = q.enqueue({ apiKeyId: 'a', channel: 'webhook', payload }, 0);
  q.claim(1, 0);
  assert.equal(q.reapStale(config.lockTtlMs - 1), 0);
  assert.equal(q.reapStale(config.lockTtlMs + 1), 1);
  assert.equal(q.get(row.id, 'a')?.status, 'queued');

  const [c] = q.claim(1, 200_000);
  q.markSent(c.id, null, 200_000);
  assert.equal(q.purge(200_000), 0, 'not strictly older');
  assert.equal(q.purge(200_001), 1);
  assert.equal(q.get(row.id, 'a'), undefined);
});

test('list paginates newest first with an opaque cursor and filters by status', () => {
  const q = testQueue(config);
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push(q.enqueue({ apiKeyId: 'a', channel: 'webhook', payload }, 1000 + i).row.id);
  q.enqueue({ apiKeyId: 'b', channel: 'webhook', payload }, 2000);
  const [c] = q.claim(1, 5000);
  q.markSent(c.id, null, 5000);

  const page1 = q.list({ apiKeyId: 'a', limit: 2 });
  assert.equal(page1.items.length, 2);
  assert.deepEqual(page1.items.map((r) => r.id), [ids[4], ids[3]]);
  assert.ok(page1.nextCursor);
  const page2 = q.list({ apiKeyId: 'a', limit: 2, cursor: page1.nextCursor ?? undefined });
  assert.deepEqual(page2.items.map((r) => r.id), [ids[2], ids[1]]);
  const page3 = q.list({ apiKeyId: 'a', limit: 2, cursor: page2.nextCursor ?? undefined });
  assert.deepEqual(page3.items.map((r) => r.id), [ids[0]]);
  assert.equal(page3.nextCursor, null);

  assert.equal(q.list({ apiKeyId: 'a', limit: 10, status: 'sent' }).items.length, 1);
  assert.equal(q.list({ apiKeyId: 'a', limit: 10, status: 'queued' }).items.length, 4);
  assert.throws(() => q.list({ apiKeyId: 'a', limit: 10, cursor: 'garbage' }), InvalidCursorError);

  const s = q.stats(6000);
  assert.equal(s.queued, 5);
  assert.equal(s.sent, 1);
  assert.equal(s.oldestQueuedAgeMs, 4999, 'oldest remaining queued row was enqueued at 1001');
});
