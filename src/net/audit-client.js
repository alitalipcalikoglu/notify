import { randomUUID } from 'node:crypto';

/**
 * @typedef {{ warn: (obj: object, msg?: string) => void, error: (obj: object, msg?: string) => void }} AuditLogger
 * @typedef {{ type: string, id: string, name?: string }} AuditParty
 * @typedef {{ action: string, outcome?: 'success'|'failure'|'denied', actor?: AuditParty, target?: AuditParty, ip?: string, userAgent?: string, requestId?: string, meta?: object }} AuditEvent
 * @typedef {{ action: string, target?: (request: import('fastify').FastifyRequest, body: any) => AuditParty|null|undefined, meta?: (request: import('fastify').FastifyRequest, body: any) => object|undefined }} AuditRouteConfig
 */

/**
 * Forwards audit events to the audit service without ever slowing down or failing the business
 * request: events are buffered in memory, flushed in batches on a timer, retried with backoff and
 * idempotent ids, and dropped with a log line when the service stays unreachable or the buffer is
 * full. With no target configured every call is a no-op.
 */
export class AuditClient {
  static MAX_BUFFER = 5_000;
  static MAX_ATTEMPTS = 6;

  /**
   * @param {object} o
   * @param {{ url: string, apiKey: string }|null} o.target
   * @param {number} [o.flushMs]
   * @param {number} [o.batchSize]
   * @param {number} [o.timeoutMs]
   * @param {AuditLogger} [o.logger]
   * @param {typeof fetch} [o.fetch]
   * @param {(ms: number) => Promise<void>} [o.sleep]
   */
  constructor({ target, flushMs = 2_000, batchSize = 200, timeoutMs = 5_000, logger = console, fetch: fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
    this.target = target ? { url: target.url.replace(/\/+$/, ''), apiKey: target.apiKey } : null;
    this.flushMs = flushMs;
    this.batchSize = batchSize;
    this.timeoutMs = timeoutMs;
    this.logger = logger;
    this.fetch = fetchImpl;
    this.sleep = sleep;
    /** @type {(AuditEvent & { id: string, at: string })[]} */
    this.buffer = [];
    /** @type {NodeJS.Timeout|null} */
    this.timer = null;
    this.flushing = false;
    this.stats = { recorded: 0, sent: 0, dropped: 0, failed: 0 };
  }

  get enabled() {
    return this.target !== null;
  }

  /**
   * Route config for {@link AuditClient.hook}: `config: { audit: AuditClient.route('flags.flag.update', (r) => ({ type: 'flag', id: r.params.key })) }`.
   * @param {string} action
   * @param {AuditRouteConfig['target']} [target]
   * @param {AuditRouteConfig['meta']} [meta]
   * @returns {AuditRouteConfig}
   */
  static route(action, target, meta) {
    return { action, target, meta };
  }

  /**
   * Queue one event. Returns false when forwarding is disabled.
   * @param {AuditEvent} e
   */
  record(e) {
    if (!this.target) return false;
    if (this.buffer.length >= AuditClient.MAX_BUFFER) {
      this.buffer.shift();
      this.stats.dropped++;
      this.logger.warn({ buffered: this.buffer.length }, 'audit buffer full, dropping oldest event');
    }
    this.buffer.push({ id: randomUUID(), at: new Date().toISOString(), ...e });
    this.stats.recorded++;
    return true;
  }

  /** Periodic flushing; the timer never keeps the process alive. */
  start() {
    if (!this.target || this.timer) return;
    this.timer = setInterval(() => { this.flush().catch(() => {}); }, this.flushMs);
    this.timer.unref();
  }

  /** Send everything buffered, batch by batch. A batch that keeps failing stays for the next flush. */
  async flush() {
    if (!this.target || this.flushing || this.buffer.length === 0) return;
    this.flushing = true;
    try {
      while (this.buffer.length) {
        const events = this.buffer.slice(0, this.batchSize);
        const ok = await this.#send(events);
        if (!ok) return;
        this.buffer.splice(0, events.length);
      }
    } finally {
      this.flushing = false;
    }
  }

  /** Stop the timer and flush what is left, for graceful shutdown. */
  async close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }

  /**
   * @param {object[]} events
   * @returns {Promise<boolean>} true when accepted or dropped for good; false to retry later.
   */
  async #send(events) {
    const target = /** @type {{ url: string, apiKey: string }} */ (this.target);
    for (let attempt = 0; attempt < AuditClient.MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) await this.sleep(Math.min(30_000, 500 * 2 ** attempt));
      try {
        const res = await this.fetch(`${target.url}/v1/events/batch`, {
          method: 'POST',
          headers: { authorization: `Bearer ${target.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ events }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (res.ok) { this.stats.sent += events.length; return true; }
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          this.logger.error({ status: res.status, body: (await res.text()).slice(0, 300), events: events.length }, 'audit batch rejected, dropping');
          this.stats.dropped += events.length;
          return true;
        }
      } catch (err) {
        if (attempt === AuditClient.MAX_ATTEMPTS - 1) this.logger.warn({ err: err instanceof Error ? err.message : String(err), events: events.length }, 'audit service unreachable, keeping events for the next flush');
      }
    }
    this.stats.failed++;
    return false;
  }

  /**
   * Fastify `onSend` hook: routes with `config.audit` record one event per completed request,
   * `success` below 400, `denied` on 403; other errors are not audit events.
   * @param {AuditClient|undefined} client
   */
  static hook(client) {
    /** @type {import('fastify').onSendAsyncHookHandler} */
    return async (request, reply, payload) => {
      const cfg = /** @type {AuditRouteConfig|undefined} */ (/** @type {any} */ (request.routeOptions?.config)?.audit);
      if (!cfg || !client?.enabled) return payload;
      const status = reply.statusCode;
      if (status >= 400 && status !== 403) return payload;
      let body = null;
      if (status < 400 && typeof payload === 'string' && payload.startsWith('{')) { try { body = JSON.parse(payload); } catch { body = null; } }
      const r = /** @type {any} */ (request);
      const keyId = r.apiKey?.id ?? r.apiKeyId;
      let target;
      try { target = cfg.target?.(request, body) ?? undefined; } catch { target = undefined; }
      try {
        client.record({
          action: cfg.action,
          outcome: status === 403 ? 'denied' : 'success',
          actor: keyId ? { type: 'apikey', id: String(keyId) } : undefined,
          target,
          ip: request.ip,
          userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'].slice(0, 512) : undefined,
          requestId: String(request.id),
          meta: status < 400 ? cfg.meta?.(request, body) : undefined,
        });
      } catch (err) {
        request.log.warn({ err, action: cfg.action }, 'audit event not recorded');
      }
      return payload;
    };
  }
}
