/**
 * Shared JSDoc typedefs for the notify service.
 * This module has no runtime exports; import it for types only.
 */

/**
 * @typedef {object} ApiKey
 * @property {string} id      Short identifier used for scoping and rate limiting.
 * @property {string} secret  Bearer secret presented by the caller.
 */

/**
 * Plain values accepted by the `Config` constructor.
 * @typedef {object} ConfigValues
 * @property {number} port
 * @property {string} host
 * @property {string} logLevel
 * @property {boolean} trustProxy
 * @property {{ certPath: string, keyPath: string }|null} tls
 * @property {{ url: string, apiKey: string }|null} audit   Audit service to forward events to; null = off.  Serve HTTPS directly when set.
 * @property {number} bodyLimit
 * @property {string} dbPath
 * @property {string} [dbBackupDir]
 * @property {ApiKey[]} apiKeys
 * @property {string} smtpUrl              nodemailer connection URL, or "json:" for the dev transport.
 * @property {string} smtpFrom             Default From header.
 * @property {string} webhookSigningSecret HMAC key for outgoing webhook signatures.
 * @property {string[]} webhookAllowedHosts Empty = any public host.
 * @property {boolean} webhookAllowHttp
 * @property {number} webhookTimeoutMs
 * @property {number} maxAttempts
 * @property {number} backoffBaseMs
 * @property {number} backoffCapMs
 * @property {number} workerConcurrency
 * @property {number} workerPollMs
 * @property {number} lockTtlMs
 * @property {number} heartbeatMs          How often an in-flight delivery's lock is renewed; must be < lockTtlMs.
 * @property {number} retentionDays
 * @property {number} rateLimitMax         Requests per minute per API key.
 * @property {boolean} webhookChannelEnabled `NOTIFY_WEBHOOK_CHANNEL`, default true; see README "Boundaries".
 */

/** @typedef {import('./config.js').Config} Config */

/** @typedef {'queued'|'processing'|'sent'|'failed'} MessageStatus */

/**
 * Row shape of the `messages` table.
 * @typedef {object} MessageRow
 * @property {string} id
 * @property {string} api_key_id
 * @property {string|null} idempotency_key
 * @property {'email'|'webhook'} channel
 * @property {string} payload            JSON-encoded {@link EmailPayload} or {@link WebhookPayload}.
 * @property {MessageStatus} status
 * @property {number} attempts
 * @property {number} max_attempts
 * @property {number} next_attempt_at    Epoch ms.
 * @property {number|null} locked_until  Epoch ms.
 * @property {string|null} last_error
 * @property {string|null} provider_id
 * @property {number} created_at
 * @property {number} updated_at
 * @property {number|null} sent_at
 * @property {string|null} owner_token    The fencing token of whoever currently holds the lock; null when not `processing`.
 * @property {number|null} call_started_at  ms since epoch; set right before `channel.deliver()` is invoked, null when that boundary was never reached or the row is not `processing`. NOT proof the external call itself ran — see `Queue#reclaimExpired`.
 */

/**
 * @typedef {object} EmailPayload
 * @property {'email'} channel
 * @property {string} template
 * @property {string[]} to
 * @property {string[]} [cc]
 * @property {string[]} [bcc]
 * @property {string} [replyTo]
 * @property {Record<string, unknown>} data
 */

/**
 * @typedef {object} WebhookPayload
 * @property {'webhook'} channel
 * @property {string} url
 * @property {string} event
 * @property {Record<string, unknown>} data
 * @property {Record<string, string>} [headers]
 */

/**
 * @typedef {object} RenderedEmail
 * @property {string} subject
 * @property {string} html
 * @property {string} text
 */

/**
 * Minimal mail transport contract implemented by `EmailChannel` and by test doubles.
 * @typedef {object} MailTransport
 * @property {(msg: import('nodemailer').SendMailOptions) => Promise<{ messageId: string }>} sendMail
 * @property {() => Promise<void>} verify
 * @property {() => void} close
 */

/** Minimal pino-compatible logger contract. @typedef {import('fastify').FastifyBaseLogger} Logger */

/**
 * The subset of a logger every non-HTTP consumer (`Worker`, `Lifecycle`) actually needs —
 * satisfied both by a real Fastify/pino logger and by `ConsoleLogger` (used when there is no
 * Fastify instance to log through, i.e. the worker-only role).
 * @typedef {object} MinimalLogger
 * @property {(o: object|string, m?: string) => void} info
 * @property {(o: object|string, m?: string) => void} warn
 * @property {(o: object|string, m?: string) => void} error
 * @property {(o: object|string, m?: string) => void} fatal
 * @property {(o: object|string, m?: string) => void} debug
 * @property {(o: object|string, m?: string) => void} trace
 * @property {(bindings: object) => MinimalLogger} child
 */

export {};
