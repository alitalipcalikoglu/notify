import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Config, ConfigError } from '../src/config.js';
import { EmailChannel } from '../src/channels/email.js';

const loadConfig = Config.fromEnv;
import { testConfig } from './helpers.js';

test('defaults apply and required values are enforced', () => {
  const c = testConfig();
  assert.equal(c.port, 3001);
  assert.equal(c.tls, null);
  assert.equal(c.maxAttempts, 3);
  assert.deepEqual(c.apiKeys.map((k) => k.id), ['test', 'other']);
  for (const missing of ['NOTIFY_API_KEYS', 'SMTP_URL', 'SMTP_FROM', 'WEBHOOK_SIGNING_SECRET']) {
    assert.throws(() => loadConfig({ ...fullEnv(), [missing]: '' }), ConfigError, missing);
  }
});

test('rejects malformed values', () => {
  const bad = [
    { NOTIFY_API_KEYS: 'nocolon' }, { NOTIFY_API_KEYS: 'a:short' }, { NOTIFY_API_KEYS: `a:${'x'.repeat(40)},a:${'y'.repeat(40)}` },
    { SMTP_URL: 'http://x' }, { WEBHOOK_SIGNING_SECRET: 'short' }, { PORT: '70000' }, { PORT: 'abc' },
    { TRUST_PROXY: 'yes' }, { TLS_CERT_PATH: '/c.pem' }, { WEBHOOK_TIMEOUT_MS: '999' }, { MAX_ATTEMPTS: '0' },
  ];
  for (const override of bad) assert.throws(() => loadConfig({ ...fullEnv(), ...override }), ConfigError, JSON.stringify(override));
});

test('TLS paths are read as a pair', () => {
  const c = loadConfig({ ...fullEnv(), TLS_CERT_PATH: '/c.pem', TLS_KEY_PATH: '/k.pem' });
  assert.deepEqual(c.tls, { certPath: '/c.pem', keyPath: '/k.pem' });
});

test('Config: 0 < HEARTBEAT_MS < LOCK_TTL_MS invariant (Stage 6.2)', () => {
  const bad = (/** @type {Record<string,string>} */ o, /** @type {RegExp} */ re) => assert.throws(() => loadConfig({ ...fullEnv(), ...o }), (e) => e instanceof ConfigError && re.test(e.message));
  bad({ HEARTBEAT_MS: '5000', LOCK_TTL_MS: '5000' }, /HEARTBEAT_MS must be less than LOCK_TTL_MS/);
  bad({ HEARTBEAT_MS: '6000', LOCK_TTL_MS: '5000' }, /HEARTBEAT_MS must be less than LOCK_TTL_MS/);
  bad({ HEARTBEAT_MS: '0' }, /HEARTBEAT_MS must be >= 250/);
  bad({ LOCK_TTL_MS: '0' }, /LOCK_TTL_MS must be >= 5000/);
  const c = loadConfig({ ...fullEnv(), HEARTBEAT_MS: '1000', LOCK_TTL_MS: '5000' });
  assert.equal(c.heartbeatMs, 1_000);
  assert.equal(c.lockTtlMs, 5_000);
});

test('Config: externalCallCeiling < drainMs < forceExitMs across the whole WEBHOOK_TIMEOUT_MS range (Stage 6.2)', () => {
  for (const webhookTimeoutMs of [1_000, 10_000, 120_000]) {
    const c = loadConfig({ ...fullEnv(), WEBHOOK_TIMEOUT_MS: String(webhookTimeoutMs) });
    const callCeilingMs = Math.max(EmailChannel.SMTP_WORST_CASE_MS, c.webhookTimeoutMs);
    const { drainMs, forceExitMs } = c.shutdownTimers(callCeilingMs);
    assert.equal(drainMs, callCeilingMs + 5_000);
    assert.equal(forceExitMs, callCeilingMs + 10_000);
    assert.ok(callCeilingMs < drainMs && drainMs < forceExitMs);
  }
});

test('Config: NOTIFY_WEBHOOK_CHANNEL defaults true (backward compatible), parses explicit true/false (Stage 7)', () => {
  assert.equal(loadConfig(fullEnv()).webhookChannelEnabled, true);
  assert.equal(loadConfig({ ...fullEnv(), NOTIFY_WEBHOOK_CHANNEL: 'true' }).webhookChannelEnabled, true);
  assert.equal(loadConfig({ ...fullEnv(), NOTIFY_WEBHOOK_CHANNEL: 'false' }).webhookChannelEnabled, false);
});

function fullEnv() {
  return {
    NOTIFY_API_KEYS: `a:${'x'.repeat(40)}`, SMTP_URL: 'json:', SMTP_FROM: 'x@y.z', WEBHOOK_SIGNING_SECRET: 'w'.repeat(40),
  };
}
