import { createHmac, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { Channel } from './channel.js';

/** @typedef {import('../types.js').WebhookPayload} WebhookPayload */
/** @typedef {import('../net-guard.js').NetGuard} NetGuard */

export class WebhookError extends Error {
  /**
   * @param {string} message
   * @param {{ statusCode?: number, retryable: boolean, code?: string }} info
   */
  constructor(message, info) {
    super(message);
    this.name = 'WebhookError';
    this.statusCode = info.statusCode;
    this.retryable = info.retryable;
    this.code = info.code;
  }
}

/**
 * HMAC-SHA256 request signing. Header value is `t=<unix seconds>,v1=<hex>` where
 * `v1 = HMAC(secret, "<t>.<raw body>")`. Receivers use {@link verify}.
 */
export class WebhookSigner {
  static HEADER = 'x-notify-signature';

  /** @param {string} secret */
  constructor(secret) {
    this.#secret = secret;
  }

  /** @type {string} */
  #secret;

  /**
   * @param {string} body
   * @param {number} timestamp Unix seconds.
   * @returns {string}
   */
  sign(body, timestamp) {
    return `t=${timestamp},v1=${this.#digest(body, timestamp).toString('hex')}`;
  }

  /**
   * @param {string} body
   * @param {string} header
   * @param {{ toleranceSec?: number, now?: number }} [opts]
   * @returns {boolean}
   */
  verify(body, header, { toleranceSec = 300, now = Date.now() } = {}) {
    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header);
    if (!m) return false;
    const t = Number(m[1]);
    if (Math.abs(now / 1000 - t) > toleranceSec) return false;
    const expected = this.#digest(body, t);
    const given = Buffer.from(m[2], 'hex');
    // Buffer.prototype.equals short-circuits on the first mismatching byte — a timing side
    // channel for a receiver's own verification of an attacker-controlled header. Lengths already
    // match here (both are 64-hex/32-byte SHA-256 digests, `given` regex-anchored to that length),
    // so timingSafeEqual's equal-length requirement is always satisfied.
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  /**
   * @param {string} body
   * @param {number} t
   */
  #digest(body, t) {
    return createHmac('sha256', this.#secret).update(`${t}.${body}`).digest();
  }
}

/**
 * Signed JSON webhook delivery through the SSRF guard. Redirects are not followed.
 * @extends {Channel<WebhookPayload>}
 */
export class WebhookChannel extends Channel {
  static USER_AGENT = 'atc-notify/1.0';
  static MAX_ERROR_BODY = 1024;

  /**
   * @param {object} opts
   * @param {WebhookSigner} opts.signer
   * @param {NetGuard} opts.guard
   * @param {number} opts.timeoutMs
   * @param {() => number} [opts.now]
   */
  constructor({ signer, guard, timeoutMs, now = Date.now }) {
    super();
    this.signer = signer;
    this.guard = guard;
    this.timeoutMs = timeoutMs;
    this.now = now;
  }

  get name() {
    return /** @type {const} */ ('webhook');
  }

  /**
   * @param {string} messageId
   * @param {WebhookPayload} payload
   * @returns {Promise<string>} `http <status>`
   */
  async deliver(messageId, payload) {
    const target = await this.guard.resolve(payload.url);
    const now = this.now();
    const body = JSON.stringify({ id: messageId, event: payload.event, timestamp: new Date(now).toISOString(), data: payload.data });
    /** @type {Record<string, string>} */
    const headers = {
      ...(payload.headers ?? {}),
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
      'user-agent': WebhookChannel.USER_AGENT,
      'x-notify-id': messageId,
      'x-notify-event': payload.event,
      [WebhookSigner.HEADER]: this.signer.sign(body, Math.floor(now / 1000)),
    };
    const status = await this.#post(target, headers, body);
    return `http ${status}`;
  }

  /**
   * @param {import('../net-guard.js').VettedTarget} target
   * @param {Record<string, string>} headers
   * @param {string} body
   * @returns {Promise<number>} 2xx status code.
   */
  #post(target, headers, body) {
    const client = target.url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const req = client.request(target.url, {
        method: 'POST',
        headers,
        timeout: this.timeoutMs,
        // Pin the vetted address; TLS SNI and Host header still use the hostname.
        lookup: (_host, opts, cb) => (opts.all
          ? cb(null, [{ address: target.address, family: target.family }])
          : cb(null, target.address, target.family)),
      }, (res) => {
        const status = res.statusCode ?? 0;
        /** @type {Buffer[]} */
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          if (size < WebhookChannel.MAX_ERROR_BODY) {
            chunks.push(c);
            size += c.length;
          }
        });
        res.on('end', () => {
          if (status >= 200 && status < 300) return resolve(status);
          const snippet = Buffer.concat(chunks).toString('utf8', 0, WebhookChannel.MAX_ERROR_BODY).replace(/\s+/g, ' ').trim();
          reject(new WebhookError(`webhook responded ${status}${snippet ? `: ${snippet}` : ''}`, {
            statusCode: status,
            retryable: WebhookChannel.isRetryableStatus(status),
          }));
        });
        res.on('error', (err) => reject(new WebhookError(`response error: ${err.message}`, { retryable: true })));
      });
      req.on('timeout', () => req.destroy(new WebhookError(`webhook timed out after ${this.timeoutMs}ms`, { retryable: true, code: 'TIMEOUT' })));
      req.on('error', (err) => reject(err instanceof WebhookError
        ? err
        : new WebhookError(`request error: ${err.message}`, { retryable: true, code: /** @type {{ code?: string }} */ (err).code })));
      req.end(body);
    });
  }

  /**
   * @param {number} status
   * @returns {boolean} Whether a failed delivery with this status may succeed later.
   */
  static isRetryableStatus(status) {
    return status === 408 || status === 425 || status === 429 || status >= 500;
  }
}
