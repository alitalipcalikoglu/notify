import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Config, ConfigError } from '../src/config.js';

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

function fullEnv() {
  return {
    NOTIFY_API_KEYS: `a:${'x'.repeat(40)}`, SMTP_URL: 'json:', SMTP_FROM: 'x@y.z', WEBHOOK_SIGNING_SECRET: 'w'.repeat(40),
  };
}
