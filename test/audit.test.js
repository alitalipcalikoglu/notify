import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AuditClient } from '../src/net/audit-client.js';

const silent = { warn() {}, error() {} };

test('AuditClient: buffers, batches with idempotent ids, retries, drops rejected batches, no-op when off', async () => {
  /** @type {{ url: string, body: any, auth: string|undefined }[]} */ const calls = [];
  let fail = 2;
  const c = new AuditClient({ target: { url: 'http://audit.test/', apiKey: 'a'.repeat(40) }, batchSize: 2, logger: silent, sleep: async () => {}, fetch: /** @type {typeof fetch} */ (async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)), auth: /** @type {any} */ (init?.headers).authorization });
    return new Response(fail-- > 0 ? 'down' : '{}', { status: fail >= 0 ? 503 : 200 });
  }) });
  assert.equal(c.record({ action: 'x.one' }), true);
  c.record({ action: 'x.two', outcome: 'denied' });
  c.record({ action: 'x.three' });
  await c.flush();
  assert.deepEqual([calls.length, calls[0].url, calls[0].auth, calls[0].body.events.length, calls[2].body.events.length], [4, 'http://audit.test/v1/events/batch', `Bearer ${'a'.repeat(40)}`, 2, 2]);
  assert.equal(calls[0].body.events[0].id, calls[2].body.events[0].id, 'retries resend the same ids');
  assert.deepEqual([c.stats.sent, c.buffer.length, calls[3].body.events[0].action], [3, 0, 'x.three']);
  const rejecting = new AuditClient({ target: { url: 'http://audit.test', apiKey: 'a'.repeat(40) }, logger: silent, fetch: async () => new Response('bad', { status: 400 }) });
  rejecting.record({ action: 'x.bad' });
  await rejecting.flush();
  assert.deepEqual([rejecting.stats.dropped, rejecting.buffer.length], [1, 0]);
  const dead = new AuditClient({ target: { url: 'http://audit.test', apiKey: 'a'.repeat(40) }, logger: silent, sleep: async () => {}, fetch: async () => { throw new Error('ECONNREFUSED'); } });
  dead.record({ action: 'x.kept' });
  await dead.flush();
  assert.deepEqual([dead.stats.failed, dead.buffer.length], [1, 1], 'unreachable service keeps the event for the next flush');
  const off = new AuditClient({ target: null });
  assert.equal(off.record({ action: 'x' }), false);
  assert.equal(off.enabled, false);
});
