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
  const [claimed] = q.claim(1, 0);
  q.markCallStarted(claimed.id, /** @type {string} */ (claimed.owner_token), 0); // simulate the send having actually started
  const worker = new Worker({ queue: q, presence, channels: [], log: silent, options: { concurrency: 1, pollMs: 100, retentionDays: 30, heartbeatMs: 1_000, drainMs: 5_000 }, now: () => 0 });
  worker.recover();
  assert.equal(q.get(row.id, 'a')?.status, 'processing', 'lock not expired yet at now=0');
  const workerLater = new Worker({ queue: q, presence, channels: [], log: silent, options: { concurrency: 1, pollMs: 100, retentionDays: 30, heartbeatMs: 1_000, drainMs: 5_000 }, now: () => 6_000 });
  workerLater.recover();
  const recovered = q.get(row.id, 'a');
  assert.equal(recovered?.status, 'queued', 'now expired, recovered as a failed attempt');
  assert.equal(recovered?.attempts, 1, 'the send had started (markCallStarted), so this is a real attempt');
});

test('Worker: a late-returning owner cannot overwrite a message another worker already reclaimed', async () => {
  const config = testConfig({ LOCK_TTL_MS: '5000', HEARTBEAT_MS: '1000' });
  const q = testQueue(config);
  const { row } = q.enqueue({ apiKeyId: 'a', channel: 'webhook', payload }, 0);
  const [claimed] = q.claim(1, 0);
  const staleToken = /** @type {string} */ (claimed.owner_token);
  q.markCallStarted(claimed.id, staleToken, 0); // simulate the send having actually started before the crash
  const worker2 = new Worker({ queue: q, presence: testPresence(), channels: [], log: silent, options: { concurrency: 1, pollMs: 100, retentionDays: 30, heartbeatMs: 1_000, drainMs: 5_000 }, now: () => 6_000 });
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
  const worker = new Worker({ queue: q, presence, channels: [/** @type {any} */ (slowEmail)], log: silent, options: { concurrency: 1, pollMs: 50, retentionDays: 30, heartbeatMs: 40, drainMs: 5_000 } });
  q.enqueue({ apiKeyId: 'a', channel: 'email', payload: { channel: 'email', template: 'generic', to: ['a@example.com'], data: { appName: 'x', subject: 's', title: 't', paragraphs: ['p'] } } });
  await worker.tick();
  const row = q.list({ apiKeyId: 'a', limit: 1 }).items[0];
  assert.equal(row.status, 'sent', row.last_error ?? 'should have succeeded, not lost the lock to its own dead heartbeat');
  assert.equal(row.attempts, 0, 'delivered on the first attempt, never reclaimed out from under the still-heartbeating worker');
});

test('Queue: batch-shared owner_token — finishing message A does not affect sibling B\'s ownership or state (Stage 6.1)', () => {
  const config = testConfig();
  const q = testQueue(config);
  q.enqueue({ apiKeyId: 'a', channel: 'webhook', payload }, 0);
  q.enqueue({ apiKeyId: 'a', channel: 'webhook', payload }, 0);
  const [a, b] = q.claim(2, 0);
  assert.equal(a.owner_token, b.owner_token, 'same batch, same token');
  assert.equal(q.markSent(a.id, /** @type {string} */ (a.owner_token), 'ok-a', 10), true);
  // B is untouched: still processing, its heartbeat/finish still work with the SAME shared token.
  const stillB = q.get(b.id, 'a');
  assert.equal(stillB?.status, 'processing');
  assert.equal(stillB?.owner_token, b.owner_token);
  assert.equal(q.heartbeat(b.id, /** @type {string} */ (b.owner_token), 20, 30_000), true, 'B still heartbeats fine after A finished');
  assert.equal(q.markSent(b.id, /** @type {string} */ (b.owner_token), 'ok-b', 30), true);
  assert.equal(q.get(a.id, 'a')?.provider_id, 'ok-a', 'A unaffected by B finishing afterwards');
  assert.equal(q.get(b.id, 'a')?.provider_id, 'ok-b');
});

test('Worker: stop() is bounded by drainMs even if an in-flight send never resolves (Stage 6.1)', async () => {
  const config = testConfig();
  const q = testQueue(config);
  const presence = testPresence();
  /** @type {(v?: unknown) => void} */
  let neverResolve = () => {};
  const stuckChannel = {
    name: 'webhook',
    deliver: () => new Promise((resolve) => { neverResolve = resolve; }),
    isRetryable: () => true,
    verify: async () => {},
    close: () => {},
  };
  /** @type {[object, string][]} */
  const errors = [];
  const log = /** @type {any} */ ({
    info() {}, warn() {}, debug() {}, fatal() {}, child() { return this; },
    error(/** @type {object} */ obj, /** @type {string} */ msg) { errors.push([obj, msg]); },
  });
  const worker = new Worker({ queue: q, presence, channels: [/** @type {any} */ (stuckChannel)], log, options: { concurrency: 1, pollMs: 20, retentionDays: 30, heartbeatMs: 1_000, drainMs: 100 } });
  q.enqueue({ apiKeyId: 'a', channel: 'webhook', payload });
  worker.start();
  const deadline = Date.now() + 2_000;
  while (q.stats().processing === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  const startedStop = Date.now();
  await worker.stop();
  const elapsed = Date.now() - startedStop;
  assert.ok(elapsed < 1_000, `stop() must not hang forever; took ${elapsed}ms with drainMs=100`);
  assert.equal(errors.length, 1, 'logs exactly the drain-timeout error');
  assert.match(errors[0][1], /drain timed out/);
  neverResolve(); // let the abandoned promise settle so it doesn't leak into later tests
});
