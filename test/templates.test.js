import assert from 'node:assert/strict';
import { test } from 'node:test';
import { templates } from './helpers.js';

const renderEmail = (/** @type {string} */ name, /** @type {Record<string, unknown>} */ data) => templates.render(name, data);

test('every template renders subject, html and text in both locales', () => {
  /** @type {Record<string, Record<string, unknown>>} */
  const samples = {
    'email-verification': { appName: 'Shop', verifyUrl: 'https://shop.example/v?t=1', expiresInMinutes: 30, name: 'Ali' },
    'password-reset': { appName: 'Shop', resetUrl: 'https://shop.example/r?t=1', expiresInMinutes: 15, requestIp: '1.2.3.4' },
    generic: { appName: 'Shop', subject: 'Subj', title: 'T', paragraphs: ['P1', 'P2'], button: { label: 'Go', url: 'https://shop.example' }, footnote: 'F' },
  };
  for (const name of templates.names()) {
    for (const locale of ['tr', 'en']) {
      const out = renderEmail(name, { ...samples[name], locale });
      assert.ok(out.subject.length > 3, `${name} ${locale} subject`);
      assert.match(out.html, /^<!doctype html>/);
      assert.ok(out.html.includes(`lang="${locale}"`));
      assert.ok(out.text.includes('Shop'));
      assert.ok(out.html.includes('https://shop.example'));
      assert.ok(out.text.includes('https://shop.example'));
    }
  }
  assert.equal(renderEmail('generic', samples.generic).html.includes('lang="tr"'), true, 'locale defaults to tr');
});

test('user data is escaped and unsafe button URLs are dropped', () => {
  const out = renderEmail('generic', {
    appName: '<script>alert(1)</script>',
    subject: 'Sub\r\nBcc: x@y.z',
    title: 'T & "Q"',
    paragraphs: ['<img src=x onerror=alert(1)>'],
    button: { label: 'Go', url: 'javascript:alert(1)' },
  });
  assert.ok(!out.html.includes('<script>'));
  assert.ok(out.html.includes('&lt;script&gt;'));
  assert.ok(out.html.includes('T &amp; &quot;Q&quot;'));
  assert.ok(!out.html.includes('<img'));
  assert.ok(!out.html.includes('javascript:'));
  assert.ok(!out.text.includes('javascript:'));
  assert.equal(out.subject, 'Sub Bcc: x@y.z');
});

test('unknown template throws', () => {
  assert.throws(() => renderEmail('nope', {}), /unknown template/);
});
