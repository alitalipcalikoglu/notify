import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Application } from '../src/application.js';
import { freePort, testConfig } from './helpers.js';

/**
 * `Application.start()` end to end for each role, without going through `Lifecycle`'s `shutdown()`
 * (which calls `process.exit()` on success). See `scheduler`'s identical test for why.
 */
async function cleanup(/** @type {Application} */ app) {
  await app.worker?.stop();
  for (const ch of app.channels) ch.close();
  await app.audit.close();
  app.app?.close();
  app.db.close();
}

test('Runtime: api-only role builds no Worker; the process never claims a message', async () => {
  const app = new Application(testConfig({ PORT: String(await freePort()) }), { role: 'api' });
  await app.start();
  try {
    assert.equal(app.worker, null);
    assert.ok(app.app, 'HTTP listener is built');
    const { row } = app.queue.enqueue({ apiKeyId: 'test', channel: 'webhook', payload: { channel: 'webhook', url: 'https://api.example/x', event: 'e', data: {} } });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(app.queue.get(row.id, 'test')?.status, 'queued', 'nothing in this process ever claims it');
  } finally {
    await cleanup(app);
  }
});

test('Runtime: worker-only role builds no HTTP listener but still processes messages', async () => {
  const app = new Application(testConfig({ PORT: String(await freePort()) }), { role: 'worker' });
  await app.start();
  try {
    assert.equal(app.app, null, 'no Fastify instance at all');
    assert.ok(app.worker?.running);
    const { row } = app.queue.enqueue({ apiKeyId: 'test', channel: 'email', payload: { channel: 'email', template: 'generic', to: ['a@example.com'], data: { appName: 'x', subject: 's', title: 't', paragraphs: ['p'] } } });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(app.queue.get(row.id, 'test')?.status, 'sent');
  } finally {
    await cleanup(app);
  }
});

test('Runtime: shutdown order — stop claiming, then HTTP intake, then drain in-flight, then close channels, then audit flush, then DB close', async () => {
  const app = new Application(testConfig({ PORT: String(await freePort()) }), { role: 'combined' });
  await app.start();
  /** @type {string[]} */
  const order = [];
  const worker = /** @type {import('../src/worker.js').Worker} */ (app.worker);
  const http = /** @type {import('fastify').FastifyInstance} */ (app.app);
  const wrap = (/** @type {object} */ obj, /** @type {string} */ method, /** @type {string} */ label) => {
    const orig = /** @type {(...a: unknown[]) => unknown} */ (/** @type {any} */ (obj)[method]).bind(obj);
    /** @type {any} */ (obj)[method] = async (/** @type {unknown[]} */ ...a) => { order.push(label); return orig(...a); };
  };
  wrap(worker, 'stopClaiming', 'stopClaiming');
  wrap(http, 'close', 'app.close');
  wrap(worker, 'stop', 'worker.stop');
  wrap(app.audit, 'close', 'audit.close');
  wrap(app.db, 'close', 'db.close');
  for (const ch of app.channels) wrap(ch, 'close', 'channel.close');

  app.queue.enqueue({ apiKeyId: 'test', channel: 'webhook', payload: { channel: 'webhook', url: 'https://api.example/x', event: 'e', data: {} } });
  await new Promise((r) => setTimeout(r, 20)); // let the worker claim it before shutdown begins

  const realExit = process.exit;
  let exitCode;
  process.exit = /** @type {any} */ ((/** @type {number} */ code) => { exitCode = code; });
  try {
    await app.shutdown('test');
  } finally {
    process.exit = realExit;
  }
  assert.deepEqual(order, ['stopClaiming', 'app.close', 'worker.stop', 'channel.close', 'channel.close', 'audit.close', 'db.close']);
  assert.equal(exitCode, 0, 'a clean shutdown, not the force-exit/error path');
});
