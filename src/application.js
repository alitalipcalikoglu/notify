import { NotifyApi } from './app.js';
import { AuditClient } from '@atc-web/service-core/audit';
import { Lifecycle } from '@atc-web/service-core/lifecycle';
import { ConsoleLogger } from '@atc-web/service-core/log';
import { EmailChannel } from './channels/email.js';
import { WebhookChannel, WebhookSigner } from './channels/webhook.js';
import { Config } from './config.js';
import { Database } from './db.js';
import { HeartbeatStore } from './heartbeat-store.js';
import { NetGuard } from './net-guard.js';
import { Backoff, Queue } from './queue.js';
import { TemplateRegistry } from './templates/registry.js';
import { Worker } from './worker.js';

/** @typedef {'combined'|'api'|'worker'} Role */

/**
 * Composition root: wires configuration, storage, channels, HTTP API and worker together
 * and owns the process lifecycle (start, signals, graceful shutdown).
 *
 * `role` (Stage 6) picks which of the two runtimes this process actually runs — see `scheduler`'s
 * `Application` module doc for the identical reasoning (`'combined'` default, `'api'`: HTTP only
 * no `Worker`, `'worker'`: `Worker` only no HTTP listener at all). Notify's `/ready` and `/metrics`
 * were already DB-backed before this stage (never read an in-process `Worker` field), so the API
 * role needed no readiness/stats rework beyond the additive `worker_heartbeat` presence signal.
 */
export class Application {
  /**
   * @param {Config} config
   * @param {{ role?: Role }} [opts]
   */
  constructor(config, { role = 'combined' } = {}) {
    this.config = config;
    this.role = role;
    this.audit = new AuditClient({ target: config.audit });
    this.db = new Database(config.dbPath, { backupDir: config.dbBackupDir });
    this.presence = new HeartbeatStore(this.db);
    this.queue = new Queue(this.db, {
      maxAttempts: config.maxAttempts,
      lockTtlMs: config.lockTtlMs,
      backoff: new Backoff(config.backoffBaseMs, config.backoffCapMs),
    });
    this.templates = TemplateRegistry.withDefaults();
    this.channels = [
      new EmailChannel({ templates: this.templates, from: config.smtpFrom, smtpUrl: config.smtpUrl }),
      new WebhookChannel({
        signer: new WebhookSigner(config.webhookSigningSecret),
        guard: new NetGuard({ allowHttp: config.webhookAllowHttp, allowedHosts: config.webhookAllowedHosts }),
        timeoutMs: config.webhookTimeoutMs,
      }),
    ];
    /** @type {import('fastify').FastifyInstance|null} */
    this.app = null;
    /** @type {Worker|null} */
    this.worker = null;
    /** @type {(reason: string) => Promise<void>} */
    this.shutdown = async () => {};
  }

  /**
   * Build from `process.env`; exits the process with a readable message on bad configuration.
   * @param {{ role?: Role }} [opts]
   */
  static fromEnv(opts) {
    try {
      return new Application(Config.fromEnv(), opts);
    } catch (err) {
      if (err instanceof Error && err.name === 'ConfigError') {
        console.error(`configuration error: ${err.message}`);
        process.exit(1);
      }
      throw err;
    }
  }

  async start() {
    const { config, role } = this;
    const runsApi = role !== 'worker';
    const runsWorker = role !== 'api';

    /** @type {import('./types.js').MinimalLogger} */
    let log = new ConsoleLogger({ level: /** @type {any} */ (config.logLevel) });

    if (runsWorker) {
      this.worker = new Worker({
        queue: this.queue,
        presence: this.presence,
        channels: this.channels,
        log: log.child({ component: 'worker' }),
        options: { concurrency: config.workerConcurrency, pollMs: config.workerPollMs, retentionDays: config.retentionDays, heartbeatMs: config.heartbeatMs },
      });
    }

    /** @type {(() => (void|Promise<void>))[]} */
    const steps = [];

    if (runsApi) {
      const api = new NotifyApi({ config, audit: this.audit, queue: this.queue, presence: this.presence, templates: this.templates, channels: this.channels });
      const app = await api.build();
      this.app = app;
      log = app.log;
      if (this.worker) this.worker.log = app.log.child({ component: 'worker' });
    }

    // Shutdown order (Stage 6 fix): stop claiming new work first, then stop HTTP intake, THEN
    // drain whatever the worker already had in flight, THEN close the channels (only meaningful
    // once nothing is still sending through them), THEN flush audit, THEN close the DB. Audit
    // used to flush before the worker drained — see `scheduler`'s `application.js` for the full
    // reasoning (identical fix, same bug class). `worker.stop()`'s own bounded wait is
    // `forceExitMs` below — no separate per-step drain timeout.
    if (this.worker) steps.push(() => /** @type {Worker} */ (this.worker).stopClaiming());
    if (this.app) steps.push(() => this.app?.close());
    if (this.worker) steps.push(() => /** @type {Worker} */ (this.worker).stop());
    steps.push(() => { for (const ch of this.channels) ch.close(); });
    steps.push(() => this.audit.close());
    steps.push(() => this.db.close());

    const { shutdown } = Lifecycle.install({ forceExitMs: config.lockTtlMs + 10_000, log, steps });
    this.shutdown = shutdown;
    this.audit.logger = log;
    this.audit.start();

    if (this.app) {
      await this.app.listen({ port: config.port, host: config.host });
      this.app.log.info({ tls: config.tls !== null, role }, config.tls ? 'serving HTTPS' : 'serving plain HTTP, terminate TLS at a reverse proxy');
    } else {
      log.info({ role }, 'worker-only process: no HTTP listener');
    }
    if (this.worker) this.worker.start();
    if (process.send) process.send('ready'); // PM2 wait_ready
  }
}
