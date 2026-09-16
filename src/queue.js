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
 */
export class Queue {
  static COLUMNS = `id, api_key_id, idempotency_key, channel, payload, status, attempts, max_attempts,
    next_attempt_at, locked_until, last_error, provider_id, created_at, updated_at, sent_at`;

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
        UPDATE messages SET status = 'processing', locked_until = ?, updated_at = ?
        WHERE id IN (
          SELECT id FROM messages WHERE status = 'queued' AND next_attempt_at <= ?
          ORDER BY next_attempt_at, created_at LIMIT ?
        )
        RETURNING ${C}`),
      sent: db.prepare(`
        UPDATE messages SET status = 'sent', provider_id = ?, locked_until = NULL, last_error = NULL,
          sent_at = ?, updated_at = ?
        WHERE id = ? AND status = 'processing'`),
      failure: db.prepare(`
        UPDATE messages SET attempts = attempts + 1, status = ?, next_attempt_at = ?, locked_until = NULL,
          last_error = ?, updated_at = ?
        WHERE id = ? AND status = 'processing'
        RETURNING ${C}`),
      reap: db.prepare(`
        UPDATE messages SET status = 'queued', locked_until = NULL, updated_at = ?
        WHERE status = 'processing' AND locked_until < ?`),
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
   * Insert a new message. If `idempotencyKey` was already used by this API key, the existing
   * row is returned and `created` is false.
   * @param {{ apiKeyId: string, idempotencyKey?: string|null, channel: 'email'|'webhook', payload: object }} input
   * @param {number} [now]
   * @returns {{ row: MessageRow, created: boolean }}
   */
  enqueue(input, now = Date.now()) {
    const id = randomUUID();
    const key = input.idempotencyKey ?? null;
    const result = this.stmt.insert.run(
      id, input.apiKeyId, key, input.channel, JSON.stringify(input.payload),
      this.maxAttempts, now, now, now,
    );
    if (result.changes === 1) {
      return { row: /** @type {MessageRow} */ (this.stmt.byId.get(id, input.apiKeyId)), created: true };
    }
    const existing = /** @type {MessageRow|undefined} */ (this.stmt.byIdempotency.get(input.apiKeyId, key));
    if (!existing) throw new Error('enqueue: insert ignored but no existing row found');
    return { row: existing, created: false };
  }

  /**
   * Atomically move up to `limit` due messages to `processing` and return them.
   * @param {number} limit
   * @param {number} [now]
   * @returns {MessageRow[]}
   */
  claim(limit, now = Date.now()) {
    if (limit <= 0) return [];
    return /** @type {MessageRow[]} */ (this.stmt.claim.all(now + this.lockTtlMs, now, now, limit));
  }

  /**
   * @param {string} id
   * @param {string|null} providerId
   * @param {number} [now]
   */
  markSent(id, providerId, now = Date.now()) {
    this.stmt.sent.run(providerId, now, now, id);
  }

  /**
   * Record a failed attempt. Re-queues with backoff unless attempts are exhausted or `final` is set.
   * @param {MessageRow} row  The row as returned by {@link claim}.
   * @param {string} error
   * @param {{ final?: boolean, now?: number }} [opts]
   * @returns {MessageRow|undefined}
   */
  markFailure(row, error, { final = false, now = Date.now() } = {}) {
    const attempts = row.attempts + 1;
    const exhausted = final || attempts >= row.max_attempts;
    /** @type {MessageStatus} */
    const status = exhausted ? 'failed' : 'queued';
    const nextAt = exhausted ? row.next_attempt_at : now + this.backoff.delay(attempts);
    const rows = /** @type {MessageRow[]} */ (this.stmt.failure.all(status, nextAt, error.slice(0, 2000), now, row.id));
    return rows[0];
  }

  /**
   * Return messages whose lock expired (worker crashed mid-send) to the queue.
   * @param {number} [now]
   * @returns {number} Rows affected.
   */
  reapStale(now = Date.now()) {
    return Number(this.stmt.reap.run(now, now).changes);
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
