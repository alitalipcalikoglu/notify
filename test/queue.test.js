import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Backoff, IdempotencyConflictError, InvalidCursorError } from '../src/queue.js';

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
  assert.ok(claimed[0].owner_token, 'claim hands out a fencing token');
  assert.deepEqual(q.claim(5, 1000), [], 'already claimed');

  assert.equal(q.markSent(row.id, claimed[0].owner_token, 'msg-1', 1100), true);
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

test('enqueue: reusing an idempotency key with a different channel or payload is a conflict, not a silent success', () => {
  const q = testQueue(config);
  q.enqueue({ apiKeyId: 'a', idempotencyKey: 'k1', channel: 'webhook', payload }, 0);
  assert.throws(() => q.enqueue({ apiKeyId: 'a', idempotencyKey: 'k1', channel: 'webhook', payload: { ...payload, url: 'https://other.example' } }, 0), IdempotencyConflictError);
  assert.throws(() => q.enqueue({ apiKeyId: 'a', idempotencyKey: 'k1', channel: 'email', payload: { channel: 'email', template: 'generic', to: ['x@example.com'], data: {} } }, 0), IdempotencyConflictError);
  // The exact same channel + payload replays cleanly (already covered above); a byte-identical
  // re-send of an otherwise-equal object also replays cleanly.
  const replay = q.enqueue({ apiKeyId: 'a', idempotencyKey: 'k1', channel: 'webhook', payload: { ...payload } }, 0);
  assert.equal(replay.created, false);
});

test('markFailure re-queues with backoff, fails after max attempts or when final', () => {
  const q = testQueue(config);
  const { row } = q.enqueue({ apiKeyId: 'a', channel: 'webhook', payload }, 0);
  let [c] = q.claim(1, 0);
  let u = q.markFailure(c, /** @type {string} */ (c.owner_token), 'boom', { now: 0 });
  assert.equal(u?.status, 'queued');
  assert.equal(u?.attempts, 1);
  assert.ok(u && u.next_attempt_at >= 50 && u.next_attempt_at <= 100, `backoff ${u?.next_attempt_at}`);
  assert.equal(u?.last_error, 'boom');
  assert.equal(q.markFailure(c, /** @type {string} */ (c.owner_token), 'stale', { now: 0 }), undefined, 'the same claim cannot fail twice: owner_token/status guard rejects the second write');

  [c] = q.claim(1, 1000);
  u = q.markFailure(c, /** @type {string} */ (c.owner_token), 'boom2', { now: 1000 });
  assert.equal(u?.status, 'queued');
  assert.equal(u?.attempts, 2);

  [c] = q.claim(1, 5000);
  u = q.markFailure(c, /** @type {string} */ (c.owner_token), 'boom3', { now: 5000 });
  assert.equal(u?.status, 'failed', 'third failure exhausts max_attempts=3');
  assert.equal(q.claim(1, 999_999).length, 0);

  const { row: r2 } = q.enqueue({ apiKeyId: 'a', channel: 'webhook', payload }, 0);
  [c] = q.claim(1, 0);
  u = q.markFailure(c, /** @type {string} */ (c.owner_token), 'permanent', { final: true, now: 0 });
  assert.equal(u?.status, 'failed');
  assert.equal(u?.attempts, 1);

  const retried = q.retry(r2.id, 'a', 10);
  assert.equal(retried?.status, 'queued');
  assert.equal(retried?.attempts, 0);
  assert.equal(q.retry(row.id, 'wrong-key', 10), undefined);
  assert.equal(q.retry(retried.id, 'a', 10), undefined, 'only failed rows can be retried');
});

test('reclaimExpired settles expired locks as a failed attempt (Stage 6: costs an attempt, not a free reset); purge removes old finished rows', () => {
  const q = testQueue(config);
  const { row } = q.enqueue({ apiKeyId: 'a', channel: 'webhook', payload }, 0);
  const [claimed] = q.claim(1, 0);
  assert.deepEqual(q.reclaimExpired(config.lockTtlMs - 1), [], 'lock not expired yet');
  const reclaimed = q.reclaimExpired(config.lockTtlMs + 1);
  assert.equal(reclaimed.length, 1);
  assert.equal(reclaimed[0].status, 'queued', 'first failed attempt: back to queued with backoff, not exhausted');
  assert.equal(reclaimed[0].attempts, 1, 'unlike the pre-Stage-6 free reap, this cost an attempt');
  assert.equal(reclaimed[0].last_error, 'lease expired');
  assert.equal(q.get(row.id, 'a')?.status, 'queued');
  // The original claim's owner_token no longer owns the row after reclaim — a late finish() from
  // that same claim must not overwrite the reclaimed outcome.
  assert.equal(q.markSent(row.id, /** @type {string} */ (claimed.owner_token), 'late', config.lockTtlMs + 2), false);

  const [c] = q.claim(1, 200_000);
  q.markSent(c.id, /** @type {string} */ (c.owner_token), null, 200_000);
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
  q.markSent(c.id, /** @type {string} */ (c.owner_token), null, 5000);

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
