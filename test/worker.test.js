import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { WebhookSigner } from '../src/channels/webhook.js';
import { Worker } from '../src/worker.js';
import { emailBody, silentLog, testConfig, testEmailChannel, testPresence, testQueue, testWebhookChannel, WEBHOOK_SECRET } from './helpers.js';

/** Local webhook receiver: behaviour chosen by path. Records every request. */
/** @type {{ url: string|undefined, headers: import('node:http').IncomingHttpHeaders, body: string }[]} */
const received = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    received.push({ url: req.url, headers: req.headers, body });
    if (req.url === '/ok') return res.writeHead(200).end('{}');
    if (req.url === '/flaky') return res.writeHead(503).end('try later');
    if (req.url === '/reject') return res.writeHead(400).end('bad payload');
    if (req.url === '/slow') return setTimeout(() => res.writeHead(200).end(), 3000);
    res.writeHead(404).end();
  });
});
/** @type {string} */
let base;
before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  const addr = /** @type {import('node:net').AddressInfo} */ (server.address());
  base = `http://127.0.0.1:${addr.port}`;
});
after(() => server.close());

/**
 * Fresh queue + worker per test.
 * @param {Record<string, string>} [overrides]
 * @param {{ allowPrivate?: boolean, emailFail?: unknown }} [opts]
 */
function setup(overrides = {}, { allowPrivate = true, emailFail } = {}) {
  const config = testConfig({ WEBHOOK_TIMEOUT_MS: '1000', LOCK_TTL_MS: '5000', HEARTBEAT_MS: '1000', ...overrides });
  const queue = testQueue(config);
  const presence = testPresence();
  const { channel: email, sent } = testEmailChannel(config, { fail: emailFail });
  const webhook = testWebhookChannel(config, { allowPrivate });
  const worker = new Worker({
    queue, presence, channels: [email, webhook], log: silentLog,
    options: { concurrency: config.workerConcurrency, pollMs: config.workerPollMs, retentionDays: config.retentionDays, heartbeatMs: config.heartbeatMs, drainMs: 5_000 },
  });
  return { config, queue, presence, worker, sent };
}

/** @param {string} path */
const webhookPayload = (path) => ({ channel: 'webhook', url: `${base}${path}`, event: 'e', data: {} });

test('webhook signature round-trips and rejects tampering or stale timestamps', () => {
  const signer = new WebhookSigner(WEBHOOK_SECRET);
  const body = '{"a":1}';
  const now = Date.now();
  const header = signer.sign(body, Math.floor(now / 1000));
  assert.ok(signer.verify(body, header, { now }));
  assert.equal(signer.verify('{"a":2}', header, { now }), false);
  assert.equal(new WebhookSigner('wrong'.repeat(8)).verify(body, header, { now }), false);
  assert.equal(signer.verify(body, header, { now: now + 600_000 }), false);
  assert.equal(signer.verify(body, 'garbage'), false);
});

test('email delivery renders the template and marks the message sent', async () => {
  const { queue, worker, sent } = setup();
  const { row } = queue.enqueue({ apiKeyId: 'a', channel: 'email', payload: { ...emailBody, cc: ['c@example.com'] } });
  await worker.tick();
  const done = queue.get(row.id, 'a');
  assert.equal(done?.status, 'sent');
  assert.equal(done?.provider_id, '<1@test>');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to, ['a@example.com']);
  assert.deepEqual(sent[0].cc, ['c@example.com']);
  assert.equal(sent[0].subject, 'Hi');
  assert.match(String(sent[0].html), /Line one/);
  assert.equal(/** @type {Record<string, string>} */ (sent[0].headers)['X-Notify-Id'], row.id);
});

test('SMTP permanent failures fail immediately; transient ones retry', async () => {
  const perm = setup({}, { emailFail: Object.assign(new Error('550 no such user'), { responseCode: 550 }) });
  const p = perm.queue.enqueue({ apiKeyId: 'a', channel: 'email', payload: emailBody }).row;
  await perm.worker.tick();
  assert.equal(perm.queue.get(p.id, 'a')?.status, 'failed');
  assert.match(perm.queue.get(p.id, 'a')?.last_error ?? '', /550/);

  const tmp = setup({}, { emailFail: Object.assign(new Error('421 busy'), { responseCode: 421 }) });
  const t = tmp.queue.enqueue({ apiKeyId: 'a', channel: 'email', payload: emailBody }).row;
  await tmp.worker.tick();
  const row = tmp.queue.get(t.id, 'a');
  assert.equal(row?.status, 'queued');
  assert.equal(row?.attempts, 1);
  assert.ok(row && row.next_attempt_at > Date.now(), 'scheduled in the future');
});

test('webhook delivery posts a signed JSON body with the expected headers', async () => {
  const { queue, worker, config } = setup();
  received.length = 0;
  const payload = { ...webhookPayload('/ok'), event: 'order.paid', data: { orderId: 42 }, headers: { 'X-Tenant': 't1', authorization: 'Bearer abc' } };
  const { row } = queue.enqueue({ apiKeyId: 'a', channel: 'webhook', payload });
  await worker.tick();
  assert.equal(queue.get(row.id, 'a')?.status, 'sent');
  assert.equal(queue.get(row.id, 'a')?.provider_id, 'http 200');
  assert.equal(received.length, 1);
  const r = received[0];
  assert.equal(r.headers['content-type'], 'application/json');
  assert.equal(r.headers['x-notify-id'], row.id);
  assert.equal(r.headers['x-notify-event'], 'order.paid');
  assert.equal(r.headers['x-tenant'], 't1');
  assert.equal(r.headers.authorization, 'Bearer abc');
  assert.match(String(r.headers['user-agent']), /atc-notify/);
  assert.ok(new WebhookSigner(config.webhookSigningSecret).verify(r.body, String(r.headers[WebhookSigner.HEADER])));
  const parsed = JSON.parse(r.body);
  assert.equal(parsed.id, row.id);
  assert.equal(parsed.event, 'order.paid');
  assert.deepEqual(parsed.data, { orderId: 42 });
  assert.ok(Date.parse(parsed.timestamp) > 0);
});

test('webhook 5xx retries with backoff, 4xx fails permanently, timeout retries', async () => {
  const { queue, worker } = setup();
  const mk = (/** @type {string} */ path) => queue.enqueue({ apiKeyId: 'a', channel: 'webhook', payload: webhookPayload(path) }).row;
  const flaky = mk('/flaky');
  const reject = mk('/reject');
  const slow = mk('/slow');
  await worker.tick();
  const f = queue.get(flaky.id, 'a');
  assert.equal(f?.status, 'queued');
  assert.equal(f?.attempts, 1);
  assert.match(f?.last_error ?? '', /503.*try later/);
  const rj = queue.get(reject.id, 'a');
  assert.equal(rj?.status, 'failed');
  assert.match(rj?.last_error ?? '', /400.*bad payload/);
  const s = queue.get(slow.id, 'a');
  assert.equal(s?.status, 'queued');
  assert.match(s?.last_error ?? '', /timed out/);
});

test('webhook to a private or disallowed host fails permanently without connecting', async () => {
  const { queue, worker } = setup({ WEBHOOK_ALLOW_HTTP: 'false' }, { allowPrivate: false });
  received.length = 0;
  const priv = queue.enqueue({ apiKeyId: 'a', channel: 'webhook', payload: { channel: 'webhook', url: 'https://127.0.0.1:1/x', event: 'e', data: {} } }).row;
  const http = queue.enqueue({ apiKeyId: 'a', channel: 'webhook', payload: webhookPayload('/ok') }).row;
  await worker.tick();
  assert.equal(queue.get(priv.id, 'a')?.status, 'failed');
  assert.match(queue.get(priv.id, 'a')?.last_error ?? '', /non-public/);
  assert.equal(queue.get(http.id, 'a')?.status, 'failed');
  assert.match(queue.get(http.id, 'a')?.last_error ?? '', /scheme/);
  assert.equal(received.length, 0);
});

test('start/stop loop drains the queue and recovers stale processing rows', async () => {
  const { queue, worker } = setup();
  const stale = queue.enqueue({ apiKeyId: 'a', channel: 'webhook', payload: webhookPayload('/ok') }, 0).row;
  queue.claim(1, 0); // simulate a crash long ago, BEFORE the external call ever started
  assert.equal(queue.get(stale.id, 'a')?.status, 'processing');
  worker.start();
  const deadline = Date.now() + 2000;
  while (queue.get(stale.id, 'a')?.status !== 'sent' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  await worker.stop();
  const row = queue.get(stale.id, 'a');
  assert.equal(row?.status, 'sent');
  // Stage 6.1: the call never started before the crash, so recovery released it for free — the
  // eventual successful send is still attempt 0 in the sense that no failed attempt was recorded.
  assert.equal(row?.attempts, 0, 'the crash-before-send recovery did not cost an attempt');
});

test('Worker: a rolling pool refills a freed slot instead of waiting for the whole batch (Stage 6 fix)', async (t) => {
  // Self-contained receiver: /slow blocks for the whole test, /fast answers immediately. With the
  // pre-Stage-6 Promise.all(batch) loop and concurrency=2, claiming [slow, fast1] together would
  // keep fast1's slot occupied (awaiting the whole batch) until /slow finally answers, so fast2
  // could not even be claimed in the meantime. The rolling pool claims a replacement as soon as
  // fast1's own promise resolves, regardless of slow's still being in flight.
  let releaseSlow = /** @type {() => void} */ (() => {});
  const rx = createServer((req, res) => {
    if (req.url === '/slow') { releaseSlow = () => res.writeHead(200).end('{}'); return; }
    res.writeHead(200).end('{}');
  });
  await new Promise((r) => rx.listen(0, '127.0.0.1', () => r(undefined)));
  const addr = /** @type {import('node:net').AddressInfo} */ (rx.address());
  const rxUrl = `http://127.0.0.1:${addr.port}`;
  t.after(() => rx.close());

  const { queue, worker } = setup({ WORKER_CONCURRENCY: '2' });
  // Distinct next_attempt_at (via distinct enqueue `now`s) makes claim order deterministic:
  // slow and fast1 are due first and claimed together, fast2 only becomes claimable once a slot frees.
  const slow = queue.enqueue({ apiKeyId: 'a', channel: 'webhook', payload: { channel: 'webhook', url: `${rxUrl}/slow`, event: 'e', data: {} } }, 0).row;
  const fast1 = queue.enqueue({ apiKeyId: 'a', channel: 'webhook', payload: { channel: 'webhook', url: `${rxUrl}/fast`, event: 'e', data: {} } }, 1).row;
  const fast2 = queue.enqueue({ apiKeyId: 'a', channel: 'webhook', payload: { channel: 'webhook', url: `${rxUrl}/fast`, event: 'e', data: {} } }, 2).row;

  worker.start();
  const deadline = Date.now() + 2000;
  while (queue.get(fast2.id, 'a')?.status !== 'sent' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  assert.equal(queue.get(fast2.id, 'a')?.status, 'sent', 'fast2 was claimed and delivered while slow was still outstanding');
  assert.equal(queue.get(fast1.id, 'a')?.status, 'sent');
  assert.equal(queue.get(slow.id, 'a')?.status, 'processing', 'slow has still not been answered');
  releaseSlow();
  const slowDeadline = Date.now() + 2000;
  while (queue.get(slow.id, 'a')?.status !== 'sent' && Date.now() < slowDeadline) await new Promise((r) => setTimeout(r, 10));
  await worker.stop();
  assert.equal(queue.get(slow.id, 'a')?.status, 'sent');
});
