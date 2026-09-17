import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { AuditClient } from '@atc-web/service-core/audit';
import { registerInfo, registerProbes } from '@atc-web/service-core/fastify';
import { ApiKeyAuth } from './auth.js';
import { DisabledChannel } from './channels/disabled.js';
import { IdempotencyConflictError, InvalidCursorError } from './queue.js';

/** @typedef {import('./config.js').Config} Config */
/** @typedef {import('./types.js').MessageRow} MessageRow */
/** @typedef {import('./types.js').MessageStatus} MessageStatus */
/** @typedef {import('./queue.js').Queue} Queue */
/** @typedef {import('./templates/registry.js').TemplateRegistry} TemplateRegistry */
/** @typedef {import('./channels/channel.js').Channel<any>} AnyChannel */
/** @typedef {{ (data: unknown): boolean, errors?: { instancePath: string, message?: string, params: object }[] | null }} DataValidator */

/** Public representation of a queue row. Template `data` is never exposed (it may hold PII). */
export class MessageView {
  /** @param {MessageRow} row */
  static from(row) {
    const payload = JSON.parse(row.payload);
    const iso = (/** @type {number|null} */ ms) => (ms === null ? null : new Date(ms).toISOString());
    return {
      id: row.id,
      channel: row.channel,
      status: row.status,
      template: payload.template ?? null,
      event: payload.event ?? null,
      to: payload.to ?? null,
      url: payload.url ?? null,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      nextAttemptAt: row.status === 'queued' ? iso(row.next_attempt_at) : null,
      lastError: row.last_error,
      providerId: row.provider_id,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      sentAt: iso(row.sent_at),
    };
  }
}

/** JSON Schemas for the HTTP surface. */
class Schemas {
  static uuid = { type: 'string', format: 'uuid' };
  static email = { type: 'string', format: 'email', maxLength: 254 };
  static idempotencyKey = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[\\x21-\\x7E]+$' };

  /** @param {number} max */
  static emailList(max) {
    return { type: 'array', minItems: 1, maxItems: max, uniqueItems: true, items: Schemas.email };
  }

  /** @param {string[]} templateNames */
  static emailBody(templateNames) {
    return {
      type: 'object',
      additionalProperties: false,
      required: ['channel', 'template', 'to', 'data'],
      properties: {
        channel: { const: 'email' },
        template: { type: 'string', enum: templateNames },
        to: Schemas.emailList(10),
        cc: Schemas.emailList(10),
        bcc: Schemas.emailList(10),
        replyTo: Schemas.email,
        data: { type: 'object' },
        idempotencyKey: Schemas.idempotencyKey,
      },
    };
  }

  static webhookBody = {
    type: 'object',
    additionalProperties: false,
    required: ['channel', 'url', 'event', 'data'],
    properties: {
      channel: { const: 'webhook' },
      url: { type: 'string', format: 'uri', maxLength: 2048 },
      event: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[a-zA-Z0-9_.:-]+$' },
      data: { type: 'object' },
      headers: {
        type: 'object',
        maxProperties: 10,
        propertyNames: { pattern: '^([Xx]-[A-Za-z0-9-]{1,60}|[Aa]uthorization)$' },
        additionalProperties: { type: 'string', maxLength: 1024, pattern: '^[\\x20-\\x7E]*$' },
      },
      idempotencyKey: Schemas.idempotencyKey,
    },
  };

  static idParams = { type: 'object', properties: { id: Schemas.uuid }, required: ['id'] };

  static listQuery = {
    type: 'object',
    additionalProperties: false,
    properties: {
      status: { type: 'string', enum: ['queued', 'processing', 'sent', 'failed'] },
      limit: { type: 'string', pattern: '^([1-9]|[1-9][0-9]|100)$' },
      cursor: { type: 'string', maxLength: 128 },
    },
  };

  static message = {
    type: 'object',
    properties: {
      id: Schemas.uuid,
      channel: { type: 'string' },
      status: { type: 'string' },
      template: { type: 'string', nullable: true },
      event: { type: 'string', nullable: true },
      to: { type: 'array', items: { type: 'string' }, nullable: true },
      url: { type: 'string', nullable: true },
      attempts: { type: 'integer' },
      maxAttempts: { type: 'integer' },
      nextAttemptAt: { type: 'string', nullable: true },
      lastError: { type: 'string', nullable: true },
      providerId: { type: 'string', nullable: true },
      createdAt: { type: 'string' },
      updatedAt: { type: 'string' },
      sentAt: { type: 'string', nullable: true },
    },
  };

  static error = {
    type: 'object',
    properties: {
      error: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          message: { type: 'string' },
          details: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
    },
  };
}

/**
 * HTTP surface of the service. `build()` returns a configured Fastify instance.
 */
export class NotifyApi {
  static READY_CACHE_MS = 30_000;
  /** A worker_heartbeat row older than this many worker heartbeat intervals is considered dead. */
  static PRESENCE_STALE_FACTOR = 4;

  /**
   * @param {object} deps
   * @param {Config} deps.config
   * @param {Queue} deps.queue
   * @param {import('./heartbeat-store.js').HeartbeatStore} deps.presence
   * @param {TemplateRegistry} deps.templates
   * @param {AnyChannel[]} deps.channels   Probed by `/ready`.
   * @param {string} deps.version
   * @param {import('./types.js').Logger} [deps.logger]
   * @param {import('@atc-web/service-core/audit').AuditClient} [deps.audit]
   */
  constructor({ config, audit, queue, presence, templates, channels, version, logger }) {
    this.config = config;
    this.audit = audit;
    this.queue = queue;
    this.presence = presence;
    this.templates = templates;
    this.channels = channels;
    this.version = version;
    this.logger = logger;
    this.auth = new ApiKeyAuth(config.apiKeys);
    /** @type {Map<string, DataValidator>} */
    this.dataValidators = new Map();
  }

  /** `'running'`/`'stopped'`, from a recent `worker_heartbeat` row — this API never had an in-process Worker to ask directly, even in the combined role (see `#registerV1`'s worker-state module doc). @param {number} [now] */
  workerStatus(now = Date.now()) {
    const seenAt = this.presence.latest();
    return seenAt !== null && now - seenAt < this.config.heartbeatMs * NotifyApi.PRESENCE_STALE_FACTOR ? 'running' : 'stopped';
  }

  /** @returns {Promise<import('fastify').FastifyInstance>} */
  async build() {
    const { config } = this;
    const app = Fastify({
      ...(config.tls ? { https: { cert: readFileSync(config.tls.certPath), key: readFileSync(config.tls.keyPath), minVersion: 'TLSv1.2' } } : {}),
      loggerInstance: this.logger,
      logger: this.logger ? undefined : { level: config.logLevel, redact: ['req.headers.authorization'] },
      trustProxy: config.trustProxy,
      bodyLimit: config.bodyLimit,
      requestIdHeader: 'x-request-id',
      genReqId: () => randomUUID(),
      ajv: { customOptions: { removeAdditional: false, coerceTypes: false, discriminator: true } },
    });
    app.decorateRequest('apiKeyId', '');
    app.setErrorHandler(this.#errorHandler);
    app.addHook('onSend', AuditClient.hook(this.audit));
    app.setNotFoundHandler((_request, reply) => {
      reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'route not found' } });
    });
    registerProbes(app, async () => {
      this.queue.db.ping();
      for (const ch of this.channels) await ch.verify();
    }, { cacheMs: NotifyApi.READY_CACHE_MS, extra: () => ({ worker: this.workerStatus() }) });
    registerInfo(app, {
      service: 'notify',
      version: this.version,
      // Real, currently-enabled channels only — a DisabledChannel stand-in (Stage 7,
      // NOTIFY_WEBHOOK_CHANNEL=false) is not a supported capability, so it's excluded here even
      // though it's still present in `this.channels` for lookup/settlement purposes.
      capabilities: [...this.channels.filter((ch) => !(ch instanceof DisabledChannel)).map((ch) => ch.name), 'templates', 'idempotency'],
      schemaVersion: this.queue.db.schemaVersion,
    });
    await app.register((api) => this.#registerV1(api), { prefix: '/v1' });
    await app.register((ops) => this.#registerMetrics(ops));
    return app;
  }

  /** @type {import('fastify').FastifyInstance['errorHandler']} */
  #errorHandler = (rawErr, request, reply) => {
    const err = /** @type {import('fastify').FastifyError & { validation?: { instancePath: string, message?: string, params: object }[] }} */ (rawErr);
    if (err.validation) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: err.message,
          details: err.validation.map((v) => ({ path: v.instancePath, message: v.message, params: v.params })),
        },
      });
    }
    if (err instanceof InvalidCursorError) {
      return reply.code(400).send({ error: { code: 'INVALID_CURSOR', message: err.message } });
    }
    if (err instanceof IdempotencyConflictError) {
      return reply.code(409).send({ error: { code: 'IDEMPOTENCY_CONFLICT', message: err.message } });
    }
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    if (status >= 500) {
      request.log.error({ err }, 'unhandled error');
      return reply.code(status).send({ error: { code: 'INTERNAL_ERROR', message: 'internal error' } });
    }
    return reply.code(status).send({ error: { code: err.code ?? 'REQUEST_ERROR', message: err.message } });
  };

  /** @param {import('fastify').FastifyInstance} api */
  async #registerV1(api) {
    api.addHook('onRequest', this.auth.hook);
    await api.register(rateLimit, {
      max: this.config.rateLimitMax,
      timeWindow: '1 minute',
      keyGenerator: (request) => request.apiKeyId,
      errorResponseBuilder: (_request, context) => Object.assign(
        new Error(`rate limit exceeded, retry in ${context.after}`),
        { statusCode: 429, code: 'RATE_LIMITED' },
      ),
    });
    api.addHook('onReady', async () => this.#compileDataValidators(api));

    api.post('/messages', { config: { audit: AuditClient.route('notify.message.create', (_r, b) => ({ type: 'message', id: b.id }), (_r, b) => ({ channel: b?.channel, status: b?.status })) },
      schema: {
        body: {
          type: 'object',
          required: ['channel'],
          discriminator: { propertyName: 'channel' },
          oneOf: [Schemas.emailBody(this.templates.names()), Schemas.webhookBody],
        },
        response: { 200: Schemas.message, 202: Schemas.message, 400: Schemas.error },
      },
    }, this.#createMessage);

    api.get('/messages', { schema: { querystring: Schemas.listQuery } }, this.#listMessages);
    api.get('/messages/:id', { schema: { params: Schemas.idParams, response: { 200: Schemas.message, 404: Schemas.error } } }, this.#getMessage);
    api.post('/messages/:id/retry', { config: { audit: AuditClient.route('notify.message.retry', (r) => ({ type: 'message', id: /** @type {any} */ (r.params).id })) },
      schema: { params: Schemas.idParams, response: { 200: Schemas.message, 404: Schemas.error, 409: Schemas.error } },
    }, this.#retryMessage);
    api.get('/templates', async () => ({ items: this.templates.describe() }));
  }

  /**
   * Per-template validators for the `data` field, compiled with Fastify's own Ajv once it exists.
   * @param {import('fastify').FastifyInstance} api
   */
  #compileDataValidators(api) {
    const compiler = api.validatorCompiler;
    if (!compiler) throw new Error('validator compiler not initialised');
    for (const t of this.templates.describe()) {
      const compiled = compiler({ schema: t.schema, method: 'POST', url: '/v1/messages', httpPart: 'body' });
      this.dataValidators.set(t.name, /** @type {DataValidator} */ (compiled));
    }
  }

  /** @type {import('fastify').RouteHandlerMethod} */
  #createMessage = async (request, reply) => {
    const { idempotencyKey, ...payload } = /** @type {any} */ (request.body);
    if (payload.channel === 'webhook' && !this.config.webhookChannelEnabled) {
      throw Object.assign(new Error('the webhook channel is disabled on this instance (NOTIFY_WEBHOOK_CHANNEL=false)'), { statusCode: 403, code: 'WEBHOOK_CHANNEL_DISABLED' });
    }
    if (payload.channel === 'email') {
      const validate = this.dataValidators.get(payload.template);
      if (!validate) throw Object.assign(new Error(`unknown template "${payload.template}"`), { statusCode: 400, code: 'UNKNOWN_TEMPLATE' });
      if (!validate(payload.data)) {
        return reply.code(400).send({
          error: {
            code: 'VALIDATION_FAILED',
            message: `data does not match template "${payload.template}"`,
            details: (validate.errors ?? []).map((v) => ({ path: `/data${v.instancePath}`, message: v.message, params: v.params })),
          },
        });
      }
    }
    const { row, created } = this.queue.enqueue({ apiKeyId: request.apiKeyId, idempotencyKey, channel: payload.channel, payload });
    request.log.info({ messageId: row.id, channel: row.channel, created }, created ? 'message queued' : 'idempotent replay');
    reply.header('location', `/v1/messages/${row.id}`);
    return reply.code(created ? 202 : 200).send(MessageView.from(row));
  };

  /** @type {import('fastify').RouteHandlerMethod} */
  #listMessages = async (request) => {
    const q = /** @type {{ status?: MessageStatus, limit?: string, cursor?: string }} */ (request.query);
    const { items, nextCursor } = this.queue.list({
      apiKeyId: request.apiKeyId, status: q.status, limit: q.limit ? Number(q.limit) : 20, cursor: q.cursor,
    });
    return { items: items.map(MessageView.from), nextCursor };
  };

  /** @type {import('fastify').RouteHandlerMethod} */
  #getMessage = async (request, reply) => {
    const row = this.queue.get(/** @type {{ id: string }} */ (request.params).id, request.apiKeyId);
    if (!row) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'message not found' } });
    return MessageView.from(row);
  };

  /** @type {import('fastify').RouteHandlerMethod} */
  #retryMessage = async (request, reply) => {
    const { id } = /** @type {{ id: string }} */ (request.params);
    const row = this.queue.retry(id, request.apiKeyId);
    if (row) {
      request.log.info({ messageId: id }, 'message manually re-queued');
      return MessageView.from(row);
    }
    const existing = this.queue.get(id, request.apiKeyId);
    if (!existing) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'message not found' } });
    return reply.code(409).send({ error: { code: 'NOT_RETRYABLE', message: `message is ${existing.status}, only failed messages can be retried` } });
  };

  /**
   * Prometheus text exposition, same API-key auth as /v1.
   * @param {import('fastify').FastifyInstance} ops
   */
  #registerMetrics(ops) {
    ops.addHook('onRequest', this.auth.hook);
    ops.get('/metrics', { logLevel: 'warn' }, async (_request, reply) => {
      const s = this.queue.stats();
      const statuses = /** @type {const} */ (['queued', 'processing', 'sent', 'failed']);
      reply.type('text/plain; version=0.0.4; charset=utf-8');
      return [
        '# HELP notify_messages Messages by status.',
        '# TYPE notify_messages gauge',
        ...statuses.map((st) => `notify_messages{status="${st}"} ${s[st]}`),
        '# HELP notify_oldest_queued_age_seconds Age of the oldest due-or-waiting queued message.',
        '# TYPE notify_oldest_queued_age_seconds gauge',
        `notify_oldest_queued_age_seconds ${(s.oldestQueuedAgeMs / 1000).toFixed(3)}`,
        '# HELP notify_worker_up 1 if a worker process is currently alive (this process itself, or another one reporting through worker_heartbeat), else 0.',
        '# TYPE notify_worker_up gauge',
        `notify_worker_up ${this.workerStatus() === 'running' ? 1 : 0}`,
        '# HELP notify_process_uptime_seconds Process uptime.',
        '# TYPE notify_process_uptime_seconds gauge',
        `notify_process_uptime_seconds ${process.uptime().toFixed(0)}`,
        '',
      ].join('\n');
    });
  }
}
