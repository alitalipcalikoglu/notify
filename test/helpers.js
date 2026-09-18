import { createServer } from 'node:net';
import { EmailChannel } from '../src/channels/email.js';
import { Config } from '../src/config.js';
import { Database } from '../src/db.js';
import { HeartbeatStore } from '../src/heartbeat-store.js';
import { NetGuard } from '../src/net-guard.js';
import { Backoff, Queue } from '../src/queue.js';
import { TemplateRegistry } from '../src/templates/registry.js';
import { WebhookChannel, WebhookSigner } from '../src/channels/webhook.js';

export const API_KEY = 'k'.repeat(40);
export const OTHER_KEY = 'o'.repeat(40);
export const WEBHOOK_SECRET = 's'.repeat(40);

/**
 * An OS-assigned free TCP port, so a test that actually binds `PORT` (unlike most of this suite,
 * which never starts a real listener) never collides with whatever else happens to be running on
 * the host. `notify`'s own `PORT` validator requires >=1 (unlike a few sibling services), so `'0'`
 * itself is not a valid override here — a real, already-free port number is required instead.
 * @returns {Promise<number>}
 */
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = /** @type {import('node:net').AddressInfo} */ (srv.address()).port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

/**
 * Test configuration: in-memory DB, JSON mail transport, http webhooks allowed, tiny backoff.
 * @param {Record<string, string>} [overrides]
 */
export function testConfig(overrides = {}) {
  return Config.fromEnv({
    NOTIFY_API_KEYS: `test:${API_KEY},other:${OTHER_KEY}`,
    SMTP_URL: 'json:',
    SMTP_FROM: 'Test <no-reply@test.local>',
    WEBHOOK_SIGNING_SECRET: WEBHOOK_SECRET,
    WEBHOOK_ALLOW_HTTP: 'true',
    DB_PATH: ':memory:',
    BACKOFF_BASE_MS: '100',
    BACKOFF_CAP_MS: '1000',
    MAX_ATTEMPTS: '3',
    WORKER_POLL_MS: '50',
    LOG_LEVEL: 'silent',
    ...overrides,
  });
}

/** @param {Config} config */
export function testQueue(config) {
  return new Queue(new Database(':memory:'), {
    maxAttempts: config.maxAttempts,
    lockTtlMs: config.lockTtlMs,
    backoff: new Backoff(config.backoffBaseMs, config.backoffCapMs),
  });
}

/** Fresh worker_heartbeat store over its own in-memory database. */
export function testPresence() {
  return new HeartbeatStore(new Database(':memory:'));
}

export const templates = TemplateRegistry.withDefaults();

/**
 * Email channel with a recording transport.
 * @param {Config} config
 * @param {{ fail?: unknown }} [opts]  Throw `fail` from sendMail instead of recording.
 */
export function testEmailChannel(config, { fail } = {}) {
  /** @type {import('nodemailer').SendMailOptions[]} */
  const sent = [];
  const channel = new EmailChannel({
    templates,
    from: config.smtpFrom,
    transport: {
      async sendMail(msg) {
        if (fail) throw fail;
        sent.push(msg);
        return { messageId: `<${sent.length}@test>` };
      },
      async verify() {},
      close() {},
    },
  });
  return { channel, sent };
}

/**
 * Webhook channel; by default the guard accepts loopback so tests can hit a local receiver.
 * @param {Config} config
 * @param {{ allowPrivate?: boolean }} [opts]
 */
export function testWebhookChannel(config, { allowPrivate = true } = {}) {
  return new WebhookChannel({
    signer: new WebhookSigner(config.webhookSigningSecret),
    guard: new NetGuard({
      allowHttp: config.webhookAllowHttp,
      allowedHosts: config.webhookAllowedHosts,
      ...(allowPrivate ? { isPublic: () => true } : {}),
    }),
    timeoutMs: config.webhookTimeoutMs,
  });
}

/** Silent pino-compatible logger. */
export const silentLog = /** @type {any} */ (new Proxy({}, {
  get: (_t, prop) => (prop === 'child' ? () => silentLog : () => {}),
}));

/** Minimal email payload accepted by the `generic` template. */
export const emailBody = {
  channel: 'email',
  template: 'generic',
  to: ['a@example.com'],
  data: { appName: 'Shop', subject: 'Hi', title: 'Hello', paragraphs: ['Line one'] },
};
