import { parentPort, workerData } from 'node:worker_threads';
import { Database } from '../../src/db.js';
import { Backoff, Queue } from '../../src/queue.js';

/**
 * Runs inside its own OS thread with its own SQLite connection to the SAME database file every
 * sibling thread points at — real cross-connection concurrency for `test/lease-concurrency.test.js`.
 * @type {{ path: string, now: number, lockTtlMs: number, batch: number, attempts: number }}
 */
const { path, now, lockTtlMs, batch, attempts } = workerData;

/** See scheduler's identical helper: absorbs a transient SQLITE_LOCKED from many threads opening their first connection to the same file at once. @returns {Database} */
function openWithRetry() {
  for (let attempt = 0; ; attempt++) {
    try {
      return new Database(path);
    } catch (err) {
      if (attempt >= 20 || !/locked|busy/i.test(/** @type {Error} */ (err).message)) throw err;
      const until = Date.now() + 10;
      while (Date.now() < until);
    }
  }
}

const db = openWithRetry();
const queue = new Queue(db, { maxAttempts: 3, lockTtlMs, backoff: new Backoff(100, 1000) });
/** @type {string[]} */
const claimed = [];
for (let i = 0; i < attempts; i++) {
  for (const r of queue.claim(batch, now)) claimed.push(r.id);
}
db.close();
parentPort?.postMessage({ claimed });
