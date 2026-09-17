/** @typedef {import('./types.js').ApiKey} ApiKey */

export class ConfigError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Validated service configuration. Build with {@link Config.fromEnv}; the constructor takes
 * already-validated values (tests use it directly through `fromEnv` as well).
 */
export class Config {
  static MIN_SECRET_LENGTH = 32;

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
    this.retentionDays = values.retentionDays;
    this.rateLimitMax = values.rateLimitMax;
    Object.freeze(this);
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
    const lockTtlMs = r.integer('LOCK_TTL_MS', 120_000, { min: 5_000 });

    return new Config({
      port: r.integer('PORT', 3001, { min: 1, max: 65535 }),
      host: r.optional('HOST') || '0.0.0.0',
      logLevel: r.optional('LOG_LEVEL') || 'info',
      trustProxy: r.boolean('TRUST_PROXY', false),
      tls: certPath ? { certPath, keyPath } : null,
      audit: Config.#parseAudit(r),
      bodyLimit: r.integer('BODY_LIMIT', 65_536, { min: 1_024 }),
      dbPath: r.optional('DB_PATH') || './data/notify.db',
      apiKeys: Config.#parseApiKeys(r.required('NOTIFY_API_KEYS')),
      smtpUrl,
      smtpFrom,
      webhookSigningSecret,
      webhookAllowedHosts: r.csv('WEBHOOK_ALLOWED_HOSTS').map((h) => h.toLowerCase()),
      webhookAllowHttp: r.boolean('WEBHOOK_ALLOW_HTTP', false),
      webhookTimeoutMs: r.integer('WEBHOOK_TIMEOUT_MS', 10_000, { min: 1_000, max: lockTtlMs / 2 }),
      maxAttempts: r.integer('MAX_ATTEMPTS', 8, { min: 1, max: 50 }),
      backoffBaseMs,
      backoffCapMs,
      workerConcurrency: r.integer('WORKER_CONCURRENCY', 5, { min: 1, max: 100 }),
      workerPollMs: r.integer('WORKER_POLL_MS', 500, { min: 50 }),
      lockTtlMs,
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
    const keys = raw.split(',').map((s) => s.trim()).filter(Boolean).map((entry) => {
      const idx = entry.indexOf(':');
      if (idx <= 0) throw new ConfigError(`NOTIFY_API_KEYS entry "${entry.slice(0, 8)}…" must be id:secret`);
      const id = entry.slice(0, idx);
      const secret = entry.slice(idx + 1);
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new ConfigError(`NOTIFY_API_KEYS id "${id}" must match [A-Za-z0-9_-]{1,64}`);
      if (secret.length < Config.MIN_SECRET_LENGTH) {
        throw new ConfigError(`NOTIFY_API_KEYS secret for "${id}" must be at least ${Config.MIN_SECRET_LENGTH} characters`);
      }
      return { id, secret };
    });
    if (keys.length === 0) throw new ConfigError('NOTIFY_API_KEYS must contain at least one key');
    if (new Set(keys.map((k) => k.id)).size !== keys.length) throw new ConfigError('NOTIFY_API_KEYS ids must be unique');
    return keys;
  }
  /**
   * `AUDIT_URL` + `AUDIT_API_KEY`: both or neither. Empty = audit events are not forwarded.
   * @param {EnvReader} r
   */
  static #parseAudit(r) {
    const url = r.optional('AUDIT_URL').replace(/\/+$/, '');
    const apiKey = r.optional('AUDIT_API_KEY');
    if (!url && !apiKey) return null;
    if (!url || !apiKey) throw new ConfigError('AUDIT_URL and AUDIT_API_KEY must be set together');
    if (!/^https?:\/\/[^\s]+$/.test(url)) throw new ConfigError('AUDIT_URL must be an absolute http(s) URL');
    if (apiKey.length < 32) throw new ConfigError('AUDIT_API_KEY must be at least 32 characters');
    return { url, apiKey };
  }
}

/** Typed accessors over a raw environment map. */
class EnvReader {
  /** @param {NodeJS.ProcessEnv} env */
  constructor(env) {
    this.env = env;
  }

  /**
   * @param {string} name
   * @returns {string} Trimmed value or empty string.
   */
  optional(name) {
    return this.env[name]?.trim() ?? '';
  }

  /**
   * @param {string} name
   * @returns {string}
   */
  required(name) {
    const v = this.optional(name);
    if (v === '') throw new ConfigError(`${name} is required`);
    return v;
  }

  /**
   * @param {string} name
   * @param {number} fallback
   * @param {{ min?: number, max?: number }} [range]
   * @returns {number}
   */
  integer(name, fallback, range = {}) {
    const raw = this.optional(name);
    if (raw === '') return fallback;
    if (!/^-?\d+$/.test(raw)) throw new ConfigError(`${name} must be an integer, got "${raw}"`);
    const n = Number(raw);
    if (range.min !== undefined && n < range.min) throw new ConfigError(`${name} must be >= ${range.min}`);
    if (range.max !== undefined && n > range.max) throw new ConfigError(`${name} must be <= ${range.max}`);
    return n;
  }

  /**
   * @param {string} name
   * @param {boolean} fallback
   * @returns {boolean}
   */
  boolean(name, fallback) {
    const raw = this.optional(name);
    if (raw === '') return fallback;
    if (raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0') return false;
    throw new ConfigError(`${name} must be true or false, got "${raw}"`);
  }

  /**
   * @param {string} name
   * @returns {string[]}
   */
  csv(name) {
    return this.optional(name).split(',').map((s) => s.trim()).filter(Boolean);
  }
}
