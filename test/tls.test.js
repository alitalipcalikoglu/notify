import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Agent, request } from 'node:https';
import { NotifyApi } from '../src/app.js';
import { silentLog, templates, testConfig, testQueue } from './helpers.js';

const dir = mkdtempSync(join(tmpdir(), 'notify-tls-'));
after(() => rmSync(dir, { recursive: true, force: true }));

test('serves HTTPS when TLS_CERT_PATH and TLS_KEY_PATH are set', async () => {
  const cert = join(dir, 'cert.pem');
  const key = join(dir, 'key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  const config = testConfig({ TLS_CERT_PATH: cert, TLS_KEY_PATH: key });
  const app = await new NotifyApi({ config, queue: testQueue(config), templates, channels: [], logger: silentLog }).build();
  await app.listen({ port: 0, host: '127.0.0.1' });
  try {
    const addr = /** @type {import('node:net').AddressInfo} */ (app.server.address());
    const body = await new Promise((resolve, reject) => {
      request({ host: '127.0.0.1', port: addr.port, path: '/health', agent: new Agent({ rejectUnauthorized: false }) }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, data, tls: /** @type {import('node:tls').TLSSocket} */ (res.socket).encrypted }));
      }).on('error', reject).end();
    });
    assert.deepEqual(body, { status: 200, data: '{"status":"ok"}', tls: true });
  } finally {
    await app.close();
  }
});
