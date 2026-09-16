import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Html } from '../src/html.js';

const { escape: escapeHtml, safeHttpUrl, singleLine } = Html;

test('escapeHtml neutralises markup and quotes', () => {
  assert.equal(escapeHtml(`<a href="x" onclick='y'>&</a>`), '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(42), '42');
});

test('safeHttpUrl only accepts absolute http(s)', () => {
  assert.equal(safeHttpUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(safeHttpUrl('http://example.com'), 'http://example.com/');
  assert.equal(safeHttpUrl('javascript:alert(1)'), null);
  assert.equal(safeHttpUrl('data:text/html,hi'), null);
  assert.equal(safeHttpUrl('/relative'), null);
  assert.equal(safeHttpUrl(undefined), null);
});

test('singleLine strips header-injection newlines', () => {
  assert.equal(singleLine('Subject\r\nBcc: evil@example.com'), 'Subject Bcc: evil@example.com');
});
