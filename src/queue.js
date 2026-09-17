import { randomUUID } from 'node:crypto';

/** @typedef {import('./db.js').Database} Database */
/** @typedef {import('./types.js').MessageRow} MessageRow */
/** @typedef {import('./types.js').MessageStatus} MessageStatus */

/** Exponential backoff with equal jitter: half deterministic, half random. */
export class Backoff {
  /**
   * @param {number} baseMs
   * @param {number} capMs
   * @param {() => number} [random]
   */
  constructor(baseMs, capMs, random = Math.random) {
    this.baseMs = baseMs;
    this.capMs = capMs;
    this.random = random;
  }

  /**
   * @param {number} attempt Number of failed attempts so far (1 = first failure).
   * @returns {number} Delay in milliseconds.
   */
  delay(attempt) {
    const exp = Math.min(this.capMs, this.baseMs * 2 ** Math.max(0, attempt - 1));
    const half = exp / 2;
    return Math.round(half + this.random() * half);
  }
}

export class InvalidCursorError extends Error {
  constructor() {
    super('invalid cursor');
    this.name = 'InvalidCursorError';
  }
}

/**
 * A replay of an idempotency key whose payload or channel does not match the original message.
 * The key is meant to identify one logical send, not to be reused for something else.
 */
export class IdempotencyConflictError extends Error {
  /** @param {string} idempotencyKey */
  constructor(idempotencyKey) {
    super(`idempotency key "${idempotencyKey}" was already used with a different channel or payload`);
    this.name = 'IdempotencyConflictError';
  }
}

/** Opaque pagination cursor over (created_at, id). */
class Cursor {
  /** @param {MessageRow} row */
  static encode(row) {
    return Buffer.from(`${row.created_at}:${row.id}`).toString('base64url');
  }

  /**
   * @param {string} cursor
   * @returns {{ createdAt: number, id: string }}
   */
  static decode(cursor) {
    const m = /^(\d{1,16}):([0-9a-f-]{36})$/.exec(Buffer.from(cursor, 'base64url').toString());
    if (!m) throw new InvalidCursorError();
    return { createdAt: Number(m[1]), id: m[2] };
  }
}

/**
 * Persistent delivery queue on top of SQLite. All methods are synchronous.
 *
 * Lease ownership (Stage 6): {@link claim} hands the whole claimed batch one fresh random
 * `owner_token` (the fencing token) — one per claim CALL, not per row, since every write that ends
 * an attempt ({@link markSent}, {@link markFailure}) is already scoped to one row by `id` in its
 * `WHERE` clause; adding `AND owner_token = ?` to that same clause is what makes the write
 * fencing-safe, and a batch-shared token satisfies that exactly as well as a per-row one would
 * (two different rows never compare tokens against each other). A worker that claimed a batch,
 * then hung long enough for {@link reclaimExpired} to reclaim one of its rows, can no longer
 * overwrite that row when it eventually returns — its `owner_token` no longer matches, and by then
 * `status` isn't `'processing'` under it either.
 */
export class Queue {
  static COLUMNS = `id, api_key_id, idempotency_key, channel, payload, status, attempts, max_attempts,
    next_attempt_at, locked_until, last_error, provider_id, created_at, updated_at, sent_at, owner_token,
    call_started_at`;

  /**
   * @param {Database} db
   * @param {{ maxAttempts: number, lockTtlMs: number, backoff: Backoff }} opts
   */
  constructor(db, opts) {
    this.db = db;
    this.maxAttempts = opts.maxAttempts;
    this.lockTtlMs = opts.lockTtlMs;
    this.backoff = opts.backoff;
    const C = Queue.COLUMNS;
    this.stmt = {
      insert: db.prepare(`
        INSERT INTO messages (id, api_key_id, idempotency_key, channel, payload, status, attempts,
          max_attempts, next_attempt_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?)
        ON CONFLICT (api_key_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`),
      byIdempotency: db.prepare(`SELECT ${C} FROM messages WHERE api_key_id = ? AND idempotency_key = ?`),
      byId: db.prepare(`SELECT ${C} FROM messages WHERE id = ? AND api_key_id = ?`),
      claim: db.prepare(`
        UPDATE messages SET status = 'processing', locked_until = ?, owner_token = ?, updated_at = ?
        WHERE id IN (
          SELECT id FROM messages WHERE status = 'queued' AND next_attempt_at <= ?
          ORDER BY next_attempt_at, created_at LIMIT ?
        )
        RETURNING ${C}`),
      sent: db.prepare(`
        UPDATE messages SET status = 'sent', provider_id = ?, locked_until = NULL, owner_token = NULL, last_error = NULL,
          sent_at = ?, updated_at = ?
        WHERE id = ? AND status = 'processing' AND owner_token = ?`),
      failure: db.prepare(`
        UPDATE messages SET attempts = attempts + 1, status = ?, next_attempt_at = ?, locked_until = NULL, owner_token = NULL,
          last_error = ?, updated_at = ?
        WHERE id = ? AND status = 'processing' AND owner_token = ?
        RETURNING ${C}`),
      heartbeat: db.prepare(`UPDATE messages SET locked_until = ? WHERE id = ? AND owner_token = ? AND status = 'processing'`),
      callStarted: db.prepare(`UPDATE messages SET call_started_at = ? WHERE id = ? AND owner_token = ? AND status = 'processing'`),
      expiredLocks: db.prepare(`SELECT ${C} FROM messages WHERE status = 'processing' AND (locked_until IS NULL OR locked_until < ?)`),
      release: db.prepare(`
        UPDATE messages SET status = 'queued', next_attempt_at = ?, locked_until = NULL, owner_token = NULL,
          call_started_at = NULL, last_error = ?, updated_at = ?
        WHERE id = ? AND status = 'processing' AND owner_token = ?
        RETURNING ${C}`),
      processingCount: db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE status = 'processing'`),
      purge: db.prepare(`DELETE FROM messages WHERE status IN ('sent', 'failed') AND updated_at < ?`),
      retry: db.prepare(`
        UPDATE messages SET status = 'queued', attempts = 0, next_attempt_at = ?, last_error = NULL, updated_at = ?
        WHERE id = ? AND api_key_id = ? AND status = 'failed'
        RETURNING ${C}`),
      counts: db.prepare(`SELECT status, COUNT(*) AS n FROM messages GROUP BY status`),
      oldestQueued: db.prepare(`SELECT MIN(next_attempt_at) AS t FROM messages WHERE status = 'queued'`),
    };
  }

  /**
   * Insert a new message. If `idempotencyKey` was already used by this API key with the SAME
   * channel and payload, the existing row is returned and `created` is false. Reused with a
   * DIFFERENT channel or payload, it's a conflict — the key identifies one logical send, not a
   * slot to overwrite — and throws {@link IdempotencyConflictError} rather than silently
   * succeeding with the original (stale) content.
   * @param {{ apiKeyId: string, idempotencyKey?: string|null, channel: 'email'|'webhook', payload: object }} input
   * @param {number} [now]
   * @returns {{ row: MessageRow, created: boolean }}
   */
  enqueue(input, now = Date.now()) {
    const id = randomUUID();
    const key = input.idempotencyKey ?? null;
    const payloadJson = JSON.stringify(input.payload);
    const result = this.stmt.insert.run(
      id, input.apiKeyId, key, input.channel, payloadJson, this.maxAttempts, now, now, now,
    );
    if (result.changes === 1) {
      return { row: /** @type {MessageRow} */ (this.stmt.byId.get(id, input.apiKeyId)), created: true };
    }
    const existing = /** @type {MessageRow|undefined} */ (this.stmt.byIdempotency.get(input.apiKeyId, key));
    if (!existing) throw new Error('enqueue: insert ignored but no existing row found');
    if (existing.channel !== input.channel || existing.payload !== payloadJson) throw new IdempotencyConflictError(/** @type {string} */ (key));
    return { row: existing, created: false };
  }

  /**
   * Atomically move up to `limit` due messages to `processing`, all under one fresh `owner_token`,
   * and return them.
   * @param {number} limit
   * @param {number} [now]
   * @returns {MessageRow[]}
   */
  claim(limit, now = Date.now()) {
    if (limit <= 0) return [];
    return /** @type {MessageRow[]} */ (this.stmt.claim.all(now + this.lockTtlMs, randomUUID(), now, now, limit));
  }

  /**
   * @param {string} id
   * @param {string} ownerToken
   * @param {string|null} providerId
   * @param {number} [now]
   * @returns {boolean} Whether `ownerToken` still held the lease (`false` = discard the result, see {@link reclaimExpired}).
   */
  markSent(id, ownerToken, providerId, now = Date.now()) {
    return Number(this.stmt.sent.run(providerId, now, now, id, ownerToken).changes) > 0;
  }

  /**
   * Record a failed attempt, but only while `ownerToken` still holds the lease. Re-queues with
   * backoff unless attempts are exhausted or `final` is set.
   * @param {MessageRow} row  The row as returned by {@link claim}.
   * @param {string} ownerToken
   * @param {string} error
   * @param {{ final?: boolean, now?: number }} [opts]
   * @returns {MessageRow|undefined} Undefined both when the schedule allows no more attempts
   *   without a written row (never happens: see status logic) and, meaningfully, when the lease
   *   had already moved on — the caller must not treat that as a normal completion.
   */
  markFailure(row, ownerToken, error, { final = false, now = Date.now() } = {}) {
    const attempts = row.attempts + 1;
    const exhausted = final || attempts >= row.max_attempts;
    /** @type {MessageStatus} */
    const status = exhausted ? 'failed' : 'queued';
    const nextAt = exhausted ? row.next_attempt_at : now + this.backoff.delay(attempts);
    const rows = /** @type {MessageRow[]} */ (this.stmt.failure.all(status, nextAt, error.slice(0, 2000), now, row.id, ownerToken));
    return rows[0];
  }

  /**
   * Renew the lock while a send is still in flight. Returns whether `ownerToken` still holds it —
   * `false` means another process already reclaimed this message.
   * @param {string} id @param {string} ownerToken @param {number} now @param {number} [lockTtlMs]
   */
  heartbeat(id, ownerToken, now, lockTtlMs = this.lockTtlMs) {
    return Number(this.stmt.heartbeat.run(now + lockTtlMs, id, ownerToken).changes) > 0;
  }

  /**
   * Mark that the external call (SMTP send / webhook POST) is actually about to start — the line
   * between "claimed" and "attempted." Stage 6.1: this is what lets {@link reclaimExpired} tell an
   * infra-only crash (worker died between claim and this call, message never actually attempted)
   * from a real failed attempt (the external call started; its outcome is unknown). Returns
   * whether `ownerToken` still held the lease — `false` means the lease was already reclaimed
   * before the call could even begin; the caller must not proceed to call the channel in that case
   * (see `Worker#execute`), since a concurrent reclaim may already be retrying this same message.
   * @param {string} id @param {string} ownerToken @param {number} now
   */
  markCallStarted(id, ownerToken, now) {
    return Number(this.stmt.callStarted.run(now, id, ownerToken).changes) > 0;
  }

  /**
   * Release a claimed message back to `queued` for an immediate, free retry — no attempt cost, no
   * backoff. Used only for a message whose external call never started (see
   * {@link markCallStarted}); guarded the same way as every other completion write.
   * @param {string} id @param {string} ownerToken @param {string} error @param {number} now
   * @returns {MessageRow|undefined}
   */
  #release(id, ownerToken, error, now) {
    const rows = /** @type {MessageRow[]} */ (this.stmt.release.all(now, error.slice(0, 2000), now, id, ownerToken));
    return rows[0];
  }

  /**
   * Atomically find every message whose lock has expired (or predates leases) and, in the SAME
   * transaction, settle each one — as a free release (see {@link markCallStarted}) if its external
   * call never started, or as a failed attempt labeled `error` (costs an attempt, follows the
   * normal backoff/exhaustion rule) if it did. Before Stage 6.1 every reclaim went through
   * `markFailure` unconditionally, which meant a worker crashing repeatedly right after claim —
   * before ever calling out to SMTP or a webhook — could exhaust `max_attempts` on infrastructure
   * failures alone, without the message ever actually being attempted once. Running the read and
   * every write inside one transaction is what makes this race-free against a concurrent
   * {@link heartbeat} or {@link markCallStarted}: either commits entirely before this call (the row
   * is no longer expired, so it's simply not selected) or is attempted entirely after (its own
   * guarded `UPDATE` then matches zero rows, because this transaction already moved the row off
   * `'processing'`).
   * @param {number} [now]
   * @param {string} [error]
   * @returns {MessageRow[]}
   */
  reclaimExpired(now = Date.now(), error = 'lease expired') {
    return this.db.transaction(() => {
      const stale = /** @type {MessageRow[]} */ (this.stmt.expiredLocks.all(now));
      return stale.map((row) => {
        const ownerToken = /** @type {string} */ (row.owner_token);
        return row.call_started_at === null
          ? /** @type {MessageRow} */ (this.#release(row.id, ownerToken, `${error} (before the external call started; not counted as an attempt)`, now))
          : /** @type {MessageRow} */ (this.markFailure(row, ownerToken, error, { now }));
      });
    });
  }

  /** Live in-flight count, for an API-only process that has no in-process Worker to ask. */
  processingCount() {
    return Number(/** @type {{ n: number }} */ (this.stmt.processingCount.get()).n);
  }

  /**
   * Delete finished messages last updated before `before`.
   * @param {number} before Epoch ms.
   * @returns {number} Rows deleted.
   */
  purge(before) {
    return Number(this.stmt.purge.run(before).changes);
  }

  /**
   * @param {string} id
   * @param {string} apiKeyId
   * @returns {MessageRow|undefined}
   */
  get(id, apiKeyId) {
    return /** @type {MessageRow|undefined} */ (this.stmt.byId.get(id, apiKeyId));
  }

  /**
   * Cursor-paginated listing, newest first.
   * @param {{ apiKeyId: string, status?: MessageStatus, limit: number, cursor?: string }} q
   * @returns {{ items: MessageRow[], nextCursor: string|null }}
   */
  list(q) {
    const where = ['api_key_id = ?'];
    /** @type {(string|number)[]} */
    const params = [q.apiKeyId];
    if (q.status) {
      where.push('status = ?');
      params.push(q.status);
    }
    if (q.cursor) {
      const c = Cursor.decode(q.cursor);
      where.push('(created_at < ? OR (created_at = ? AND id < ?))');
      params.push(c.createdAt, c.createdAt, c.id);
    }
    params.push(q.limit + 1);
    const rows = /** @type {MessageRow[]} */ (this.db.prepare(
      `SELECT ${Queue.COLUMNS} FROM messages WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).all(...params));
    const hasMore = rows.length > q.limit;
    const items = hasMore ? rows.slice(0, q.limit) : rows;
    const last = items.at(-1);
    return { items, nextCursor: hasMore && last ? Cursor.encode(last) : null };
  }

  /**
   * Re-queue a failed message for a fresh round of attempts.
   * @param {string} id
   * @param {string} apiKeyId
   * @param {number} [now]
   * @returns {MessageRow|undefined} Undefined if not found or not in `failed` state.
   */
  retry(id, apiKeyId, now = Date.now()) {
    return /** @type {MessageRow[]} */ (this.stmt.retry.all(now, now, id, apiKeyId))[0];
  }

  /** @returns {Record<MessageStatus, number> & { oldestQueuedAgeMs: number }} */
  stats(now = Date.now()) {
    const counts = { queued: 0, processing: 0, sent: 0, failed: 0 };
    for (const r of /** @type {{ status: MessageStatus, n: number }[]} */ (this.stmt.counts.all())) counts[r.status] = r.n;
    const oldest = /** @type {{ t: number|null }} */ (this.stmt.oldestQueued.get());
    return { ...counts, oldestQueuedAgeMs: oldest.t === null ? 0 : Math.max(0, now - oldest.t) };
  }
}
