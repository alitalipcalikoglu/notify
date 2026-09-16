import { NotifyApi } from './app.js';
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
    this.api = new NotifyApi({ config, queue: this.queue, templates: this.templates, channels: this.channels });
    /** @type {import('fastify').FastifyInstance|null} */
    this.app = null;
    /** @type {Worker|null} */
    this.worker = null;
    this.shuttingDown = false;
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
    this.#installSignalHandlers(app.log);
    await app.listen({ port: this.config.port, host: this.config.host });
    app.log.info({ tls: this.config.tls !== null }, this.config.tls ? 'serving HTTPS' : 'serving plain HTTP, terminate TLS at a reverse proxy');
    this.worker.start();
    if (process.send) process.send('ready'); // PM2 wait_ready
  }

  /**
   * Stop accepting requests, drain in-flight deliveries, release resources, exit.
   * @param {string} reason
   */
  async shutdown(reason) {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    const log = /** @type {import('./types.js').Logger} */ (this.app?.log ?? console);
    log.info({ reason }, 'shutting down');
    const forceExit = setTimeout(() => {
      log.error('shutdown timed out, exiting');
      process.exit(1);
    }, this.config.lockTtlMs).unref();
    try {
      await this.app?.close();
      await this.worker?.stop();
      for (const ch of this.channels) ch.close();
      this.db.close();
      clearTimeout(forceExit);
      log.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      log.error({ err }, 'shutdown failed');
      process.exit(1);
    }
  }

  /** @param {import('./types.js').Logger} log */
  #installSignalHandlers(log) {
    process.on('SIGTERM', () => this.shutdown('SIGTERM'));
    process.on('SIGINT', () => this.shutdown('SIGINT'));
    process.on('unhandledRejection', (reason) => {
      log.fatal({ err: reason }, 'unhandled rejection');
      this.shutdown('unhandledRejection');
    });
    process.on('uncaughtException', (err) => {
      log.fatal({ err }, 'uncaught exception');
      process.exit(1);
    });
  }
}
