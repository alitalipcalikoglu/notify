import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NetGuard, NetGuardError } from '../src/net-guard.js';

const { isPublicAddress, parseIPv6 } = NetGuard;
/** @param {ConstructorParameters<typeof NetGuard>[0]} opts */
const resolvePublicTarget = (/** @type {string} */ url, opts) => new NetGuard(opts).resolve(url);

test('isPublicAddress blocks every private/special IPv4 range', () => {
  for (const ip of ['0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255',
    '192.0.0.1', '192.0.2.1', '192.88.99.1', '192.168.1.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255']) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '203.0.114.1']) {
    assert.equal(isPublicAddress(ip), true, ip);
  }
});

test('isPublicAddress blocks private/special IPv6 including embedded IPv4 forms', () => {
  for (const ip of ['::', '::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:7f00:1', 'fc00::1', 'fd12::1', 'fe80::1',
    'ff02::1', '2001:db8::1', '64:ff9b::7f00:1', '64:ff9b::127.0.0.1', '2002:7f00:1::1', '2001::1', '::10.0.0.1']) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const ip of ['2606:4700:4700::1111', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::1']) {
    assert.equal(isPublicAddress(ip), true, ip);
  }
  assert.equal(isPublicAddress('not-an-ip'), false);
});

test('parseIPv6 expands compressed and mixed notation', () => {
  assert.deepEqual(parseIPv6('::1'), [0, 0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(parseIPv6('::ffff:192.168.0.1'), [0, 0, 0, 0, 0, 0xffff, 0xc0a8, 0x0001]);
  assert.deepEqual(parseIPv6('2001:db8::8a2e:370:7334'), [0x2001, 0xdb8, 0, 0, 0, 0x8a2e, 0x370, 0x7334]);
  assert.equal(parseIPv6('1::2::3'), null);
  assert.equal(parseIPv6('1:2:3'), null);
});

/** @param {Record<string, { address: string, family: number }[]>} table */
const fakeLookup = (table) => /** @type {any} */ (async (/** @type {string} */ host) => {
  if (!table[host]) throw new Error('ENOTFOUND');
  return table[host];
});

test('resolvePublicTarget rejects bad schemes, credentials, private hosts and disallowed hosts', async () => {
  const lookup = fakeLookup({
    'good.example': [{ address: '93.184.216.34', family: 4 }],
    'evil.example': [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }],
  });
  const code = (/** @type {Promise<unknown>} */ p) => p.then(() => assert.fail('expected rejection'), (/** @type {unknown} */ e) => (assert.ok(e instanceof NetGuardError), e.code));

  assert.equal(await code(resolvePublicTarget('ftp://good.example', { lookup })), 'SCHEME_NOT_ALLOWED');
  assert.equal(await code(resolvePublicTarget('http://good.example', { lookup })), 'SCHEME_NOT_ALLOWED');
  assert.equal(await code(resolvePublicTarget('https://u:p@good.example', { lookup })), 'CREDENTIALS_IN_URL');
  assert.equal(await code(resolvePublicTarget('https://127.0.0.1/x', { lookup })), 'PRIVATE_ADDRESS');
  assert.equal(await code(resolvePublicTarget('https://[::1]/x', { lookup })), 'PRIVATE_ADDRESS');
  assert.equal(await code(resolvePublicTarget('https://evil.example/x', { lookup })), 'PRIVATE_ADDRESS');
  assert.equal(await code(resolvePublicTarget('https://good.example/x', { lookup, allowedHosts: ['other.example'] })), 'HOST_NOT_ALLOWED');
  assert.equal(await code(resolvePublicTarget('not a url', { lookup })), 'INVALID_URL');

  const dns = await resolvePublicTarget('https://missing.example/x', { lookup }).catch((e) => e);
  assert.equal(dns.code, 'DNS_FAILED');
  assert.equal(dns.retryable, true);

  const ok = await resolvePublicTarget('https://api.good.example/hook', { lookup: fakeLookup({ 'api.good.example': [{ address: '93.184.216.34', family: 4 }] }), allowedHosts: ['good.example'] });
  assert.equal(ok.address, '93.184.216.34');
  assert.equal(ok.family, 4);

  const http = await resolvePublicTarget('http://good.example/x', { lookup, allowHttp: true });
  assert.equal(http.url.protocol, 'http:');
});
