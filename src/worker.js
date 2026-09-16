import { setTimeout as sleep } from 'node:timers/promises';

/** @typedef {import('./queue.js').Queue} Queue */
/** @typedef {import('./types.js').MessageRow} MessageRow */
/** @typedef {import('./types.js').Logger} Logger */
/** @typedef {import('./channels/channel.js').Channel<any>} AnyChannel */

/**
 * Background delivery loop. Claims due messages in batches, hands each to its channel and
 * records the outcome. Also runs periodic maintenance: stale lock recovery and retention purge.
 */
export class Worker {
  static MAINTENANCE_INTERVAL_MS = 60_000;

  /**
   * @param {object} deps
   * @param {Queue} deps.queue
   * @param {AnyChannel[]} deps.channels
   * @param {Logger} deps.log
   * @param {{ concurrency: number, pollMs: number, retentionDays: number }} deps.options
   */
  constructor({ queue, channels, log, options }) {
    this.queue = queue;
    this.channels = new Map(channels.map((c) => [c.name, c]));
    this.log = log;
    this.options = options;
    this.running = false;
    /** @type {Promise<void>|null} */
    this.loop = null;
    this.abort = new AbortController();
    this.lastMaintenance = 0;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.abort = new AbortController();
    // Recover anything left in `processing` by a previous crash before the first claim.
    const reaped = this.queue.reapStale();
    if (reaped) this.log.warn({ reaped }, 'recovered messages left processing by a previous run');
    this.lastMaintenance = Date.now();
    this.loop = this.#run();
    this.log.info({ concurrency: this.options.concurrency, pollMs: this.options.pollMs }, 'worker started');
  }

  /** Stop claiming and wait for in-flight deliveries to finish. */
  async stop() {
    if (!this.running) return;
    this.running = false;
    this.abort.abort();
    await this.loop;
    this.loop = null;
    this.log.info('worker stopped');
  }

  /** Run exactly one maintenance + claim-and-deliver pass. Used by tests. */
  async tick() {
    this.#maintenance();
    await Promise.all(this.queue.claim(this.options.concurrency).map((row) => this.#deliver(row)));
  }

  async #run() {
    while (this.running) {
      try {
        this.#maintenance();
        const batch = this.queue.claim(this.options.concurrency);
        if (batch.length) {
          await Promise.all(batch.map((row) => this.#deliver(row)));
          if (batch.length === this.options.concurrency) continue; // more may be waiting
        }
      } catch (err) {
        this.log.error({ err }, 'worker iteration failed');
      }
      try {
        await sleep(this.options.pollMs, undefined, { signal: this.abort.signal });
      } catch {
        // aborted by stop()
      }
    }
  }

  /**
   * Deliver one claimed message and persist the result.
   * @param {MessageRow} row
   */
  async #deliver(row) {
    const started = Date.now();
    const meta = { messageId: row.id, channel: row.channel, attempt: row.attempts + 1 };
    const channel = this.channels.get(row.channel);
    try {
      if (!channel) throw Object.assign(new Error(`no channel registered for "${row.channel}"`), { retryable: false });
      const providerId = await channel.deliver(row.id, JSON.parse(row.payload));
      this.queue.markSent(row.id, providerId);
      this.log.info({ ...meta, providerId, durationMs: Date.now() - started }, 'delivered');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const retryable = channel ? channel.isRetryable(err) : false;
      const updated = this.queue.markFailure(row, message, { final: !retryable });
      const level = updated?.status === 'failed' ? 'error' : 'warn';
      this.log[level]({ ...meta, err, status: updated?.status, nextAttemptAt: updated?.next_attempt_at }, 'delivery failed');
    }
  }

  #maintenance() {
    const now = Date.now();
    if (now - this.lastMaintenance < Worker.MAINTENANCE_INTERVAL_MS) return;
    this.lastMaintenance = now;
    const reaped = this.queue.reapStale(now);
    if (reaped) this.log.warn({ reaped }, 'returned stale processing messages to queue');
    const purged = this.queue.purge(now - this.options.retentionDays * 86_400_000);
    if (purged) this.log.info({ purged }, 'purged finished messages past retention');
  }
}
