import { NotifyApi } from './app.js';
import { AuditClient } from '@atc-web/service-core/audit';
import { Lifecycle } from '@atc-web/service-core/lifecycle';
import { EmailChannel } from './channels/email.js';
import { WebhookChannel, WebhookSigner } from './channels/webhook.js';
import { Config } from './config.js';
import { Database } from './db.js';
import { NetGuard } from './net-guard.js';
import { Backoff, Queue } from './queue.js';
import { TemplateRegistry } from './templates/registry.js';
import { Worker } from './worker.js';

/**
 * Composition root: wires configuration, storage, channels, HTTP API and worker together
 * and owns the process lifecycle (start, signals, graceful shutdown).
 */
export class Application {
  /** @param {Config} config */
  constructor(config) {
    this.config = config;
    this.audit = new AuditClient({ target: config.audit });
    this.db = new Database(config.dbPath);
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
    this.api = new NotifyApi({ config, audit: this.audit, queue: this.queue, templates: this.templates, channels: this.channels });
    /** @type {import('fastify').FastifyInstance|null} */
    this.app = null;
    /** @type {Worker|null} */
    this.worker = null;
    /** @type {(reason: string) => Promise<void>} */
    this.shutdown = async () => {};
  }

  /** Build from `process.env`; exits the process with a readable message on bad configuration. */
  static fromEnv() {
    try {
      return new Application(Config.fromEnv());
    } catch (err) {
      if (err instanceof Error && err.name === 'ConfigError') {
        console.error(`configuration error: ${err.message}`);
        process.exit(1);
      }
      throw err;
    }
  }

  async start() {
    const app = await this.api.build();
    this.app = app;
    this.worker = new Worker({
      queue: this.queue,
      channels: this.channels,
      log: app.log.child({ component: 'worker' }),
      options: { concurrency: this.config.workerConcurrency, pollMs: this.config.workerPollMs, retentionDays: this.config.retentionDays },
    });
    // Order preserved exactly as before this extraction (audit flushes before the worker drains
    // in-flight deliveries) — a known, separately tracked defect, not something to fix here.
    const { shutdown } = Lifecycle.install({
      forceExitMs: this.config.lockTtlMs,
      log: app.log,
      steps: [
        () => this.app?.close(),
        () => this.audit.close(),
        () => this.worker?.stop(),
        () => { for (const ch of this.channels) ch.close(); },
        () => this.db.close(),
      ],
    });
    this.shutdown = shutdown;
    this.audit.logger = app.log;
    this.audit.start();
    await app.listen({ port: this.config.port, host: this.config.host });
    app.log.info({ tls: this.config.tls !== null }, this.config.tls ? 'serving HTTPS' : 'serving plain HTTP, terminate TLS at a reverse proxy');
    this.worker.start();
    if (process.send) process.send('ready'); // PM2 wait_ready
  }
}
