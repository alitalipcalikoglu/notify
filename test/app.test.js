import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { NotifyApi } from '../src/app.js';
import { API_KEY, emailBody, OTHER_KEY, silentLog, templates, testConfig, testEmailChannel, testPresence, testQueue } from './helpers.js';

const config = testConfig({ RATE_LIMIT_MAX: '50' });
const queue = testQueue(config);
const presence = testPresence();
/** @type {import('fastify').FastifyInstance} */
let app;
const auth = { authorization: `Bearer ${API_KEY}` };

before(async () => {
  const { channel } = testEmailChannel(config);
  app = await new NotifyApi({ config, queue, presence, templates, channels: [channel], version: '1.0.0', logger: silentLog }).build();
  await app.ready();
});
after(() => app.close());

test('health and readiness are public', async () => {
  assert.equal((await app.inject('/health')).statusCode, 200);
  const ready = await app.inject('/ready');
  assert.equal(ready.statusCode, 200);
  assert.deepEqual(ready.json(), { status: 'ok', worker: 'stopped' }, 'no worker_heartbeat row: reads as stopped, Stage 6');
  presence.beat(Date.now());
  assert.deepEqual((await app.inject('/ready')).json(), { status: 'ok', worker: 'running' }, 'a recent heartbeat reads as running even with no in-process Worker');
});

test('v1 routes require a valid bearer key', async () => {
  for (const headers of [{}, { authorization: 'Bearer nope' }, { authorization: 'Basic abc' }, { authorization: `Bearer ${API_KEY}x` }]) {
    const res = await app.inject({ url: '/v1/templates', headers });
    assert.equal(res.statusCode, 401);
    assert.equal(res.headers['www-authenticate'], 'Bearer');
    assert.equal(res.json().error.code, 'UNAUTHORIZED');
  }
  assert.equal((await app.inject({ url: '/metrics' })).statusCode, 401);
  assert.equal((await app.inject({ url: '/v1/templates', headers: auth })).statusCode, 200);
});

test('GET /v1/templates lists templates with schemas', async () => {
  const res = await app.inject({ url: '/v1/templates', headers: auth });
  const names = res.json().items.map((/** @type {{ name: string }} */ t) => t.name);
  assert.deepEqual(names.sort(), ['email-verification', 'generic', 'password-reset']);
  assert.equal(res.json().items[0].schema.type, 'object');
});

test('POST /v1/messages validates the envelope per channel', async () => {
  const post = (/** @type {object} */ body) => app.inject({ method: 'POST', url: '/v1/messages', headers: auth, payload: body });

  let res = await post({ channel: 'sms', to: ['x'] });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'VALIDATION_FAILED');

  res = await post({ ...emailBody, to: ['not-an-email'] });
  assert.equal(res.statusCode, 400);
  assert.match(JSON.stringify(res.json().error.details), /email/);

  res = await post({ ...emailBody, template: 'missing' });
  assert.equal(res.statusCode, 400);

  res = await post({ ...emailBody, extra: 1 });
  assert.equal(res.statusCode, 400, 'unknown fields rejected');

  res = await post({ channel: 'webhook', url: 'https://h.example/x', event: 'bad event!', data: {} });
  assert.equal(res.statusCode, 400);

  res = await post({ channel: 'webhook', url: 'https://h.example/x', event: 'ok', data: {}, headers: { Host: 'evil' } });
  assert.equal(res.statusCode, 400, 'only X-* and Authorization headers allowed');

  res = await post({ channel: 'webhook', url: 'https://h.example/x', event: 'ok', data: {}, headers: { 'X-Token': 'a\r\nb' } });
  assert.equal(res.statusCode, 400, 'no CRLF in header values');
});

test('POST /v1/messages validates template data and reports the path', async () => {
  const res = await app.inject({
    method: 'POST', url: '/v1/messages', headers: auth,
    payload: { ...emailBody, data: { appName: 'Shop', subject: 'S', title: 'T', paragraphs: [], button: { label: 'Go', url: 'ftp://x' } } },
  });
  assert.equal(res.statusCode, 400);
  const body = res.json();
  assert.equal(body.error.code, 'VALIDATION_FAILED');
  assert.match(body.error.message, /generic/);
  assert.ok(body.error.details[0].path.startsWith('/data'), body.error.details[0].path);
});

test('POST /v1/messages queues, exposes status, honours idempotency and key scoping', async () => {
  const payload = { ...emailBody, idempotencyKey: 'order-42' };
  const first = await app.inject({ method: 'POST', url: '/v1/messages', headers: auth, payload });
  assert.equal(first.statusCode, 202);
  const msg = first.json();
  assert.equal(msg.status, 'queued');
  assert.equal(msg.channel, 'email');
  assert.equal(msg.template, 'generic');
  assert.deepEqual(msg.to, ['a@example.com']);
  assert.equal(msg.attempts, 0);
  assert.equal(msg.maxAttempts, 3);
  assert.equal('data' in msg, false, 'template data never echoed');
  assert.equal(first.headers.location, `/v1/messages/${msg.id}`);

  const replay = await app.inject({ method: 'POST', url: '/v1/messages', headers: auth, payload });
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json().id, msg.id);

  // Stage 6: the same key with a DIFFERENT payload is a conflict, not a silent success with the
  // stale original content — the key identifies one logical send.
  const conflict = await app.inject({ method: 'POST', url: '/v1/messages', headers: auth, payload: { ...emailBody, idempotencyKey: 'order-42', to: ['different@example.com'] } });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().error.code, 'IDEMPOTENCY_CONFLICT');

  const get = await app.inject({ url: `/v1/messages/${msg.id}`, headers: auth });
  assert.equal(get.statusCode, 200);
  assert.equal(get.json().id, msg.id);

  const foreign = await app.inject({ url: `/v1/messages/${msg.id}`, headers: { authorization: `Bearer ${OTHER_KEY}` } });
  assert.equal(foreign.statusCode, 404);

  const badId = await app.inject({ url: '/v1/messages/not-a-uuid', headers: auth });
  assert.equal(badId.statusCode, 400);

  const list = await app.inject({ url: '/v1/messages?status=queued&limit=1', headers: auth });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().items.length, 1);
  assert.equal((await app.inject({ url: '/v1/messages?limit=0', headers: auth })).statusCode, 400);
  assert.equal((await app.inject({ url: '/v1/messages?cursor=zzz', headers: auth })).json().error.code, 'INVALID_CURSOR');

  const retry = await app.inject({ method: 'POST', url: `/v1/messages/${msg.id}/retry`, headers: auth });
  assert.equal(retry.statusCode, 409, 'queued messages cannot be retried');
  const retryMissing = await app.inject({ method: 'POST', url: `/v1/messages/00000000-0000-4000-8000-000000000000/retry`, headers: auth });
  assert.equal(retryMissing.statusCode, 404);
});

test('unknown routes return JSON 404; oversized bodies are rejected', async () => {
  const res = await app.inject({ url: '/nope', headers: auth });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error.code, 'NOT_FOUND');
  const big = await app.inject({
    method: 'POST', url: '/v1/messages', headers: auth,
    payload: { ...emailBody, data: { ...emailBody.data, paragraphs: ['x'.repeat(config.bodyLimit)] } },
  });
  assert.equal(big.statusCode, 413);
});

test('GET /metrics exposes Prometheus text', async () => {
  const res = await app.inject({ url: '/metrics', headers: auth });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type']), /text\/plain/);
  assert.match(res.body, /notify_messages\{status="queued"\} \d+/);
  assert.match(res.body, /notify_oldest_queued_age_seconds/);
  assert.match(res.body, /notify_worker_up \d/);
});

test('GET /v1/info reports service identity and real, currently-enabled capabilities', async () => {
  const res = await app.inject({ url: '/v1/info', headers: auth });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.service, 'notify');
  assert.equal(body.version, '1.0.0');
  assert.equal(body.apiVersion, 'v1');
  assert.deepEqual(body.capabilities, ['email', 'templates', 'idempotency'], 'only the channel actually wired into this app instance');
  assert.equal(typeof body.schemaVersion, 'number');
  assert.equal(typeof body.serviceCore, 'string');
});

test('/v1/info is public, no auth required (same as /health and /ready)', async () => {
  assert.equal((await app.inject('/v1/info')).statusCode, 200);
});

test('POST /v1/messages: NOTIFY_WEBHOOK_CHANNEL=false rejects a new webhook message deterministically, email is unaffected (Stage 7)', async () => {
  const disabledConfig = testConfig({ NOTIFY_WEBHOOK_CHANNEL: 'false' });
  const { channel } = testEmailChannel(disabledConfig);
  const disabledApp = await new NotifyApi({
    config: disabledConfig, queue: testQueue(disabledConfig), presence: testPresence(),
    templates, channels: [channel], version: '1.0.0', logger: silentLog,
  }).build();
  try {
    await disabledApp.ready();
    const webhook = await disabledApp.inject({
      method: 'POST', url: '/v1/messages', headers: auth,
      payload: { channel: 'webhook', url: 'https://h.example/x', event: 'ok', data: {} },
    });
    assert.equal(webhook.statusCode, 403);
    assert.equal(webhook.json().error.code, 'WEBHOOK_CHANNEL_DISABLED');

    const email = await disabledApp.inject({ method: 'POST', url: '/v1/messages', headers: auth, payload: emailBody });
    assert.equal(email.statusCode, 202, 'email channel unaffected by the webhook switch');
  } finally {
    await disabledApp.close();
  }
});

test('rate limit is enforced per API key', async () => {
  const other = { authorization: `Bearer ${OTHER_KEY}` };
  /** @type {import('light-my-request').Response|null} */
  let limited = null;
  for (let i = 0; i < 60; i++) {
    const res = await app.inject({ url: '/v1/templates', headers: other });
    if (res.statusCode === 429) {
      limited = /** @type {typeof res} */ (res);
      break;
    }
  }
  assert.ok(limited, 'expected a 429');
  assert.equal(limited.json().error.code, 'RATE_LIMITED');
  assert.ok(limited.headers['retry-after']);
  assert.equal((await app.inject({ url: '/v1/templates', headers: auth })).statusCode, 200, 'other key unaffected');
});
