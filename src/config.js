import { ConfigError, EnvReader, parseApiKeys, parseAudit } from '@atc-web/service-core/config';

/** @typedef {import('./types.js').ApiKey} ApiKey */

export { ConfigError };

/**
 * Validated service configuration. Build with {@link Config.fromEnv}; the constructor takes
 * already-validated values (tests use it directly through `fromEnv` as well).
 */
export class Config {
  static MIN_SECRET_LENGTH = 32;

  // Stage 6.2: single source of truth for the two shutdown-timer margins, so `application.js`
  // never re-derives this arithmetic by hand (that duplication is exactly how the Stage 6.1
  // forceExitMs bug — sized off LOCK_TTL_MS instead of the real call ceiling — happened in the
  // first place). `externalCallCeiling < drainMs < forceExitMs` holds unconditionally for any
  // valid call ceiling — the margins are fixed, not operator-configurable — so there is no invalid
  // combination for config validation to reject here; `test/config.test.js` locks the ordering in.
  static DRAIN_MARGIN_MS = 5_000;
  static FORCE_EXIT_MARGIN_MS = 10_000;

  /** @param {import('./types.js').ConfigValues} values */
  constructor(values) {
    this.port = values.port;
    this.host = values.host;
    this.logLevel = values.logLevel;
    this.trustProxy = values.trustProxy;
    this.tls = values.tls;
    this.audit = values.audit;
    this.bodyLimit = values.bodyLimit;
    this.dbPath = values.dbPath;
    this.dbBackupDir = values.dbBackupDir;
    this.apiKeys = values.apiKeys;
    this.smtpUrl = values.smtpUrl;
    this.smtpFrom = values.smtpFrom;
    this.webhookSigningSecret = values.webhookSigningSecret;
    this.webhookAllowedHosts = values.webhookAllowedHosts;
    this.webhookAllowHttp = values.webhookAllowHttp;
    this.webhookTimeoutMs = values.webhookTimeoutMs;
    this.maxAttempts = values.maxAttempts;
    this.backoffBaseMs = values.backoffBaseMs;
    this.backoffCapMs = values.backoffCapMs;
    this.workerConcurrency = values.workerConcurrency;
    this.workerPollMs = values.workerPollMs;
    this.lockTtlMs = values.lockTtlMs;
    this.heartbeatMs = values.heartbeatMs;
    this.retentionDays = values.retentionDays;
    this.rateLimitMax = values.rateLimitMax;
    Object.freeze(this);
  }

  /**
   * Shutdown timers derived from the real worst-case external call duration (not `lockTtlMs` — see
   * the Stage 6.1 fix in `application.js` for why the lease TTL is the wrong basis once a heartbeat
   * decouples call duration from lease renewal). Callers pass the same `callCeilingMs`
   * (`Math.max(EmailChannel.SMTP_WORST_CASE_MS, this.webhookTimeoutMs)`) they use to size the
   * worker's own drain wait.
   * @param {number} callCeilingMs
   */
  shutdownTimers(callCeilingMs) {
    return { drainMs: callCeilingMs + Config.DRAIN_MARGIN_MS, forceExitMs: callCeilingMs + Config.FORCE_EXIT_MARGIN_MS };
  }

  /**
   * Parse and validate environment variables. Throws {@link ConfigError} on the first problem.
   * @param {NodeJS.ProcessEnv} [env]
   * @returns {Config}
   */
  static fromEnv(env = process.env) {
    const r = new EnvReader(env);

    const smtpUrl = r.required('SMTP_URL');
    if (smtpUrl !== 'json:' && !/^smtps?:\/\//.test(smtpUrl)) {
      throw new ConfigError('SMTP_URL must start with smtp://, smtps:// or be "json:"');
    }
    const smtpFrom = r.required('SMTP_FROM');
    if (/[\r\n]/.test(smtpFrom)) throw new ConfigError('SMTP_FROM must be a single line');

    const webhookSigningSecret = r.required('WEBHOOK_SIGNING_SECRET');
    if (webhookSigningSecret.length < Config.MIN_SECRET_LENGTH) {
      throw new ConfigError(`WEBHOOK_SIGNING_SECRET must be at least ${Config.MIN_SECRET_LENGTH} characters`);
    }

    const certPath = r.optional('TLS_CERT_PATH');
    const keyPath = r.optional('TLS_KEY_PATH');
    if (Boolean(certPath) !== Boolean(keyPath)) throw new ConfigError('TLS_CERT_PATH and TLS_KEY_PATH must be set together');

    const backoffBaseMs = r.integer('BACKOFF_BASE_MS', 5_000, { min: 100 });
    const backoffCapMs = r.integer('BACKOFF_CAP_MS', 3_600_000, { min: backoffBaseMs });
    // Bounded (Stage 6): ecosystem.config.cjs's kill_timeout is a static value derived from this
    // ceiling — see its comment for why an unbounded LOCK_TTL_MS would defeat that derivation.
    const lockTtlMs = r.integer('LOCK_TTL_MS', 120_000, { min: 5_000, max: 600_000 });
    // Stage 6: lease ownership. heartbeatMs must stay well under lockTtlMs — a single missed
    // heartbeat (event loop stall, DB busy) must not itself be enough to lose the lock. The
    // heartbeat is what actually protects a long SMTP/webhook send now (it renews the lock every
    // heartbeatMs regardless of how long the call takes), which is why WEBHOOK_TIMEOUT_MS below no
    // longer needs to be capped relative to lockTtlMs — see README's "Clock model".
    const heartbeatMs = r.integer('HEARTBEAT_MS', 10_000, { min: 250 });
    if (heartbeatMs >= lockTtlMs) throw new ConfigError('HEARTBEAT_MS must be less than LOCK_TTL_MS');

    return new Config({
      port: r.integer('PORT', 3001, { min: 1, max: 65535 }),
      host: r.optional('HOST') || '0.0.0.0',
      logLevel: r.optional('LOG_LEVEL') || 'info',
      trustProxy: r.boolean('TRUST_PROXY', false),
      tls: certPath ? { certPath, keyPath } : null,
      audit: parseAudit(r),
      bodyLimit: r.integer('BODY_LIMIT', 65_536, { min: 1_024 }),
      dbPath: r.optional('DB_PATH') || './data/notify.db',
      dbBackupDir: r.optional('DB_BACKUP_DIR') || undefined,
      apiKeys: Config.#parseApiKeys(r.required('NOTIFY_API_KEYS')),
      smtpUrl,
      smtpFrom,
      webhookSigningSecret,
      webhookAllowedHosts: r.list('WEBHOOK_ALLOWED_HOSTS').map((h) => h.toLowerCase()),
      webhookAllowHttp: r.boolean('WEBHOOK_ALLOW_HTTP', false),
      webhookTimeoutMs: r.integer('WEBHOOK_TIMEOUT_MS', 10_000, { min: 1_000, max: 120_000 }),
      maxAttempts: r.integer('MAX_ATTEMPTS', 8, { min: 1, max: 50 }),
      backoffBaseMs,
      backoffCapMs,
      workerConcurrency: r.integer('WORKER_CONCURRENCY', 5, { min: 1, max: 100 }),
      workerPollMs: r.integer('WORKER_POLL_MS', 500, { min: 50 }),
      lockTtlMs,
      heartbeatMs,
      retentionDays: r.integer('RETENTION_DAYS', 30, { min: 1 }),
      rateLimitMax: r.integer('RATE_LIMIT_MAX', 600, { min: 1 }),
    });
  }

  /**
   * Parse `id:secret,id2:secret2`.
   * @param {string} raw
   * @returns {ApiKey[]}
   */
  static #parseApiKeys(raw) {
    return parseApiKeys(raw, 'NOTIFY_API_KEYS', { minSecretLength: Config.MIN_SECRET_LENGTH });
  }
}
