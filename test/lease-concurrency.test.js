import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { Database } from '../src/db.js';
import { Backoff, Queue } from '../src/queue.js';

const CLAIM_WORKER = fileURLToPath(new URL('./helpers/claim-worker.js', import.meta.url));

/** @param {object} workerData */
function run(workerData) {
  return new Promise((resolve, reject) => {
    const w = new Worker(CLAIM_WORKER, { workerData });
    w.once('message', resolve);
    w.once('error', reject);
  });
}

// The single most important claim invariant, proven with REAL cross-connection concurrency (not
// same-process Promise.all): several OS threads, each with its own SQLite connection to the same
// file, racing to claim the same small set of due messages must never both succeed for one row.
test('Concurrency: several real connections racing for the same due messages never double-claim', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notify-claim-'));
  try {
    const path = join(dir, 'notify.db');
    const db = new Database(path);
    const queue = new Queue(db, { maxAttempts: 3, lockTtlMs: 30_000, backoff: new Backoff(100, 1000) });
    const now = Date.now();
    const N = 12;
    for (let i = 0; i < N; i++) queue.enqueue({ apiKeyId: 'a', channel: 'webhook', payload: { channel: 'webhook', url: 'https://api.example/x', event: 'e', data: {} } }, now);
    db.close();

    const THREADS = 6;
    const results = await Promise.all(Array.from({ length: THREADS }, () => run({ path, now, lockTtlMs: 30_000, batch: 3, attempts: 4 })));
    const allClaimed = results.flatMap((r) => /** @type {{ claimed: string[] }} */ (r).claimed);
    assert.equal(allClaimed.length, N, 'every message claimed exactly once across all threads combined');
    assert.equal(new Set(allClaimed).size, N, 'no message id claimed twice');

    const verify = new Database(path);
    const check = new Queue(verify, { maxAttempts: 3, lockTtlMs: 30_000, backoff: new Backoff(100, 1000) });
    assert.equal(check.stats().processing, N, 'every message moved to processing exactly once');
    verify.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
