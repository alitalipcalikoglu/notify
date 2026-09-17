import { randomUUID } from 'node:crypto';

/** @typedef {import('./db.js').Database} Database */

/**
 * Cross-process worker liveness (`worker_heartbeat`, one row per process running a `Worker` loop).
 * Not to be confused with a message's own lock heartbeat (`Queue.heartbeat`) — this one answers
 * "is any worker currently alive at all", for an API-only process's `/ready` and `/metrics`, which
 * have no in-process `Worker` object of their own to ask.
 */
export class HeartbeatStore {
  /** @param {Database} db */
  constructor(db) {
    this.instance = randomUUID();
    this.stmt = {
      upsert: db.prepare(`INSERT INTO worker_heartbeat (instance, seen_at) VALUES (?, ?) ON CONFLICT (instance) DO UPDATE SET seen_at = excluded.seen_at`),
      latest: db.prepare(`SELECT MAX(seen_at) AS seen_at FROM worker_heartbeat`),
      purgeOthers: db.prepare(`DELETE FROM worker_heartbeat WHERE instance != ? AND seen_at < ?`),
    };
  }

  /** @param {number} now */
  beat(now) {
    this.stmt.upsert.run(this.instance, now);
  }

  /** Most recent heartbeat across every worker instance that has ever written one, or null. */
  latest() {
    const r = /** @type {{ seen_at: number|null }} */ (this.stmt.latest.get());
    return r.seen_at === null ? null : Number(r.seen_at);
  }

  /** Drop other instances' rows once stale; never removes this instance's own row. @param {number} now @param {number} staleAfterMs */
  purgeStale(now, staleAfterMs) {
    return Number(this.stmt.purgeOthers.run(this.instance, now - staleAfterMs).changes);
  }
}
