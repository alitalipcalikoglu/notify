import { setTimeout as sleep } from 'node:timers/promises';

/** @typedef {import('./queue.js').Queue} Queue */
/** @typedef {import('./heartbeat-store.js').HeartbeatStore} HeartbeatStore */
/** @typedef {import('./types.js').MessageRow} MessageRow */
/** @typedef {import('./types.js').MinimalLogger} MinimalLogger */
/** @typedef {import('./channels/channel.js').Channel<any>} AnyChannel */

/**
 * Background delivery loop. Claims due messages into a rolling pool (up to `concurrency` in
 * flight at any time — not a fixed batch awaited all at once, so one slow send no longer idles
 * the rest of the pool until it finishes), hands each to its channel and records the outcome.
 * Also reclaims messages whose lock expired (a previous process's crash, or this process's own
 * hung send) and purges retained history.
 *
 * Lease ownership: `claim()` (`queue.js`) hands each claimed batch a fresh `owner_token`. While a
 * send is in flight, `#startHeartbeat` renews `locked_until` every `heartbeatMs` — well inside
 * `lockTtlMs`, so a normal send, however long, never loses its lock on its own. Every write that
 * ends an attempt (`markSent`/`markFailure`) is guarded by that same `owner_token`, so a worker
 * that hung long enough to be reclaimed by someone else can never overwrite the row when it
 * eventually returns — its write simply matches zero rows and is discarded (logged, not thrown).
 * See `scheduler`'s `worker.js` for the identical design, kept as an independent copy per service.
 */
export class Worker {
  static MAINTENANCE_INTERVAL_MS = 60_000;

  /**
   * @param {object} deps
   * @param {Queue} deps.queue
   * @param {HeartbeatStore} deps.presence
   * @param {AnyChannel[]} deps.channels
   * @param {MinimalLogger} deps.log
   * @param {{ concurrency: number, pollMs: number, retentionDays: number, heartbeatMs: number, drainMs: number }} deps.options
   * @param {() => number} [deps.now]
   */
  constructor({ queue, presence, channels, log, options, now = Date.now }) {
    this.queue = queue;
    this.presence = presence;
    this.channels = new Map(channels.map((c) => [c.name, c]));
    this.log = log;
    this.options = options;
    this.now = now;
    this.running = false;
    /** Guards claiming specifically, so shutdown can stop taking new work before it starts draining. Defaults true so `tick()` (no `start()` call) claims normally. */
    this.claiming = true;
    /** @type {Promise<void>|null} */
    this.loop = null;
    this.abort = new AbortController();
    /** @type {Set<Promise<void>>} */
    this.inFlight = new Set();
    this.lastMaintenance = 0;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.claiming = true;
    this.abort = new AbortController();
    this.recover();
    this.lastMaintenance = this.now();
    this.loop = this.#run();
    this.log.info({ concurrency: this.options.concurrency, pollMs: this.options.pollMs, heartbeatMs: this.options.heartbeatMs }, 'worker started');
  }

  /** Stop claiming new work; in-flight sends keep running until {@link stop} drains them. */
  stopClaiming() {
    this.claiming = false;
  }

  /**
   * Stop claiming (if not already) and wait for in-flight sends to finish, bounded by
   * `options.drainMs` (Stage 6.1) — under ordinary operation every in-flight send already has its
   * own real timeout (SMTP's hardcoded socket timeouts, `WEBHOOK_TIMEOUT_MS`), so the drain
   * finishes well within `drainMs`. If it doesn't (a call somehow bypassed its own timeout), this
   * stops waiting and logs loudly rather than hanging the whole shutdown sequence forever — the
   * abandoned send(s) may still complete in the background and their eventual `markSent`/
   * `markFailure` write can fail against an already-closed DB after this point; that is the
   * accepted cost of never blocking shutdown indefinitely, not a silent one (logged, not thrown).
   */
  async stop() {
    if (!this.running) return;
    this.running = false;
    this.claiming = false;
    this.abort.abort();
    await this.loop;
    // The losing side of this race must be cancelled explicitly: node:timers/promises' sleep()
    // otherwise keeps its timer alive for the full drainMs even after the race already settled via
    // in-flight draining first — harmless in production (process.exit() doesn't wait on pending
    // timers) but it visibly hangs anything that inspects the event loop (tests included) for up to
    // drainMs. The abort rejection is caught, not left to become an unhandled rejection.
    const drainAbort = new AbortController();
    const outcome = await Promise.race([
      Promise.allSettled(this.inFlight).then(() => /** @type {const} */ ('drained')),
      sleep(this.options.drainMs, undefined, { signal: drainAbort.signal }).then(() => /** @type {const} */ ('timed-out')).catch(() => /** @type {const} */ ('timed-out')),
    ]);
    drainAbort.abort();
    if (outcome === 'timed-out') this.log.error({ inFlight: this.inFlight.size, drainMs: this.options.drainMs }, 'drain timed out; continuing shutdown with sends still in flight');
    this.loop = null;
    this.log.info('worker stopped');
  }

  /**
   * Messages left `processing` by a crash count as a failed attempt and follow the backoff
   * schedule. Called once at startup — every `processing` row at that point is necessarily from a
   * previous life of this process — and again, differently labeled, from the in-loop sweep.
   */
  recover() {
    const recovered = this.queue.reclaimExpired(this.now(), 'interrupted by restart');
    if (recovered.length) this.log.warn({ n: recovered.length }, 'recovered messages interrupted by a previous process');
  }

  /** Run exactly one maintenance + claim-and-deliver pass, awaiting everything claimed. Used by tests. */
  async tick() {
    this.#pass(this.now());
    await Promise.allSettled([...this.inFlight]);
  }

  /** @param {number} now */
  #pass(now) {
    this.presence.beat(now);
    this.#reclaimStale();
    this.#maintenance(now);
    if (!this.claiming) return;
    const free = this.options.concurrency - this.inFlight.size;
    if (free <= 0) return;
    for (const row of this.queue.claim(free, now)) {
      const p = this.#deliver(row).finally(() => this.inFlight.delete(p));
      this.inFlight.add(p);
    }
  }

  async #run() {
    while (this.running) {
      try {
        this.#pass(this.now());
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
    const started = this.now();
    const ownerToken = /** @type {string} */ (row.owner_token);
    const meta = { messageId: row.id, channel: row.channel, attempt: row.attempts + 1 };
    const heartbeat = setInterval(() => {
      const ok = this.queue.heartbeat(row.id, ownerToken, this.now());
      if (!ok) this.log.warn(meta, 'heartbeat found the lock already reassigned; ownership lost mid-send');
    }, this.options.heartbeatMs).unref();
    const channel = this.channels.get(row.channel);
    try {
      if (!channel) throw Object.assign(new Error(`no channel registered for "${row.channel}"`), { retryable: false });
      // Stage 6.1: the line between "claimed" and "attempted" — see Queue#reclaimExpired. If the
      // lease is already gone by this point (extremely rare: reclaimed between claim and here),
      // don't start the external call at all — a concurrent reclaim may already be retrying this
      // same message, and starting our own send too would risk a genuinely duplicate delivery for
      // no benefit, since our own result could never be recorded anyway.
      if (!this.queue.markCallStarted(row.id, ownerToken, this.now())) {
        this.log.warn(meta, 'lock lost before the external call could start; not sending, another worker already reclaimed it');
        return;
      }
      const providerId = await channel.deliver(row.id, JSON.parse(row.payload));
      const ok = this.queue.markSent(row.id, ownerToken, providerId, this.now());
      if (!ok) { this.log.warn(meta, 'lock lost before this delivery could be recorded; result discarded, another worker already reclaimed it'); return; }
      this.log.info({ ...meta, providerId, durationMs: this.now() - started }, 'delivered');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const retryable = channel ? channel.isRetryable(err) : false;
      const updated = this.queue.markFailure(row, ownerToken, message, { final: !retryable, now: this.now() });
      if (!updated) { this.log.warn(meta, 'lock lost before this failure could be recorded; result discarded, another worker already reclaimed it'); return; }
      const level = updated.status === 'failed' ? 'error' : 'warn';
      this.log[level]({ ...meta, err, status: updated.status, nextAttemptAt: updated.next_attempt_at }, 'delivery failed');
    } finally {
      clearInterval(heartbeat);
    }
  }

  /** In-loop counterpart to {@link recover}: catches a message whose lock expired without a heartbeat, without waiting for a restart. */
  #reclaimStale() {
    const recovered = this.queue.reclaimExpired(this.now(), 'lease expired');
    if (recovered.length) this.log.warn({ n: recovered.length }, 'reclaimed messages whose lock expired without a heartbeat');
  }

  /** @param {number} now */
  #maintenance(now) {
    if (now - this.lastMaintenance < Worker.MAINTENANCE_INTERVAL_MS) return;
    this.lastMaintenance = now;
    const purged = this.queue.purge(now - this.options.retentionDays * 86_400_000);
    if (purged) this.log.info({ purged }, 'purged finished messages past retention');
    const staleHeartbeats = this.presence.purgeStale(now, Worker.MAINTENANCE_INTERVAL_MS * 5);
    if (staleHeartbeats) this.log.debug({ staleHeartbeats }, 'purged stale worker_heartbeat rows');
  }
}
