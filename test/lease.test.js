import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Database } from '../src/db.js';
import { Backoff, Queue } from '../src/queue.js';
import { Worker } from '../src/worker.js';
import { testConfig, testEmailChannel, testPresence, testQueue, testWebhookChannel } from './helpers.js';

const silent = /** @type {any} */ ({ info() {}, warn() {}, error() {}, fatal() {}, debug() {}, trace() {}, child() { return this; } });
const payload = { channel: 'webhook', url: 'https://api.example/x', event: 'e', data: {} };

test('Queue: claim hands the whole batch one fresh owner_token', () => {
  const config = testConfig();
  const q = testQueue(config);
  q.enqueue({ apiKeyId: 'a', channel: 'webhook', payload }, 0);
  q.enqueue({ apiKeyId: 'a', channel: 'webhook', payload }, 0);
  const [r1, r2] = q.claim(2, 0);
  assert.ok(r1.owner_token && r1.owner_token === r2.owner_token, 'one token per claim call, shared by the whole batch');
});

test('Queue: markSent/markFailure are a no-op once the owner_token no longer matches (fencing)', () => {
  const config = testConfig();
  const q = testQueue(config);
  const { row } = q.enqueue({ apiKeyId: 'a', channel: 'webhook', payload }, 0);
  const [claimed] = q.claim(1, 0);
  const staleToken = /** @type {string} */ (claimed.owner_token);
  assert.equal(q.markSent(row.id, staleToken, 'msg-1', 100), true);
  assert.equal(q.markSent(row.id, staleToken, 'msg-2', 200), false, 'already sent: the same token is now stale');
  assert.equal(q.get(row.id, 'a')?.provider_id, 'msg-1');
});

test('Queue: heartbeat renews the lock only while the token still owns the row', () => {
  const config = testConfig();
  const q = testQueue(config);
  q.enqueue({ apiKeyId: 'a', channel: 'webhook', payload }, 0);
  const [claimed] = q.claim(1, 0);
  const token = /** @type {string} */ (claimed.owner_token);
  assert.equal(q.heartbeat(claimed.id, token, 10_000, 30_000), true);
  assert.equal(q.get(claimed.id, 'a')?.locked_until, 40_000);
  q.markSent(claimed.id, token, 'ok', 10_000);
  assert.equal(q.heartbeat(claimed.id, token, 10_000, 30_000), false, 'no longer processing: heartbeat after completion is rejected');
});

test('Queue: reclaimExpired is atomic against a concurrent heartbeat for the same row', () => {
  const config = testConfig();
  const q = testQueue(config);
  q.enqueue({ apiKeyId: 'a', channel: 'webhook', payload }, 0);
  const [claimed] = q.claim(1, 0);
  const token = /** @type {string} */ (claimed.owner_token);
  const reclaimed = q.reclaimExpired(config.lockTtlMs + 1);
  assert.equal(reclaimed.length, 1);
  assert.equal(q.heartbeat(claimed.id, token, config.lockTtlMs + 1, 30_000), false, 'the original owner is fenced out after the reclaim');
});

test('Worker: recover() only reclaims EXPIRED locks, not a lock still within its TTL', () => {
  const config = testConfig({ LOCK_TTL_MS: '5000', HEARTBEAT_MS: '1000' });
  const q = testQueue(config);
  const presence = testPresence();
  const { row } = q.enqueue({ apiKeyId: 'a', channel: 'webhook', payload }, 0);
  q.claim(1, 0);
  const worker = new Worker({ queue: q, presence, channels: [], log: silent, options: { concurrency: 1, pollMs: 100, retentionDays: 30, heartbeatMs: 1_000 }, now: () => 0 });
  worker.recover();
  assert.equal(q.get(row.id, 'a')?.status, 'processing', 'lock not expired yet at now=0');
  const workerLater = new Worker({ queue: q, presence, channels: [], log: silent, options: { concurrency: 1, pollMs: 100, retentionDays: 30, heartbeatMs: 1_000 }, now: () => 6_000 });
  workerLater.recover();
  assert.equal(q.get(row.id, 'a')?.status, 'queued', 'now expired, recovered as a failed attempt');
});

test('Worker: a late-returning owner cannot overwrite a message another worker already reclaimed', async () => {
  const config = testConfig({ LOCK_TTL_MS: '5000', HEARTBEAT_MS: '1000' });
  const q = testQueue(config);
  const { row } = q.enqueue({ apiKeyId: 'a', channel: 'webhook', payload }, 0);
  const [claimed] = q.claim(1, 0);
  const staleToken = /** @type {string} */ (claimed.owner_token);
  const worker2 = new Worker({ queue: q, presence: testPresence(), channels: [], log: silent, options: { concurrency: 1, pollMs: 100, retentionDays: 30, heartbeatMs: 1_000 }, now: () => 6_000 });
  worker2.recover();
  assert.equal(q.get(row.id, 'a')?.status, 'queued');
  assert.equal(q.markSent(row.id, staleToken, 'late', 6_500), false, 'rejected: the stale token no longer owns this row');
  assert.equal(q.get(row.id, 'a')?.status, 'queued', 'the reclaim outcome stands, not the late success');
});

test('Worker: heartbeat keeps a long in-flight send owned across the original lock window', async () => {
  const config = testConfig({ LOCK_TTL_MS: '5000', HEARTBEAT_MS: '1000' });
  const db = new Database(':memory:');
  const q = new Queue(db, { maxAttempts: config.maxAttempts, lockTtlMs: 120, backoff: new Backoff(100, 1000) });
  const presence = testPresence();
  const { channel: email } = testEmailChannel(config, {});
  const slowEmail = {
    name: 'email',
    deliver: async (/** @type {string} */ id, /** @type {any} */ p) => { await new Promise((r) => setTimeout(r, 260)); return email.deliver(id, p); },
    isRetryable: (/** @type {unknown} */ err) => email.isRetryable(err),
    verify: () => email.verify(),
    close: () => email.close(),
  };
  const worker = new Worker({ queue: q, presence, channels: [/** @type {any} */ (slowEmail)], log: silent, options: { concurrency: 1, pollMs: 50, retentionDays: 30, heartbeatMs: 40 } });
  q.enqueue({ apiKeyId: 'a', channel: 'email', payload: { channel: 'email', template: 'generic', to: ['a@example.com'], data: { appName: 'x', subject: 's', title: 't', paragraphs: ['p'] } } });
  await worker.tick();
  const row = q.list({ apiKeyId: 'a', limit: 1 }).items[0];
  assert.equal(row.status, 'sent', row.last_error ?? 'should have succeeded, not lost the lock to its own dead heartbeat');
  assert.equal(row.attempts, 0, 'delivered on the first attempt, never reclaimed out from under the still-heartbeating worker');
});
