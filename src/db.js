import { Database as CoreDatabase } from '@atc-web/service-core/db';

/** SQLite connection with schema migrations applied on open. */
export class Database extends CoreDatabase {
  static MIGRATIONS = [
    `
    CREATE TABLE messages (
      id              TEXT PRIMARY KEY,
      api_key_id      TEXT NOT NULL,
      idempotency_key TEXT,
      channel         TEXT NOT NULL CHECK (channel IN ('email', 'webhook')),
      payload         TEXT NOT NULL,
      status          TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'sent', 'failed')),
      attempts        INTEGER NOT NULL DEFAULT 0,
      max_attempts    INTEGER NOT NULL,
      next_attempt_at INTEGER NOT NULL,
      locked_until    INTEGER,
      last_error      TEXT,
      provider_id     TEXT,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL,
      sent_at         INTEGER
    );
    CREATE UNIQUE INDEX messages_idempotency
      ON messages (api_key_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE INDEX messages_due ON messages (status, next_attempt_at);
    CREATE INDEX messages_list ON messages (api_key_id, created_at DESC, id DESC);
    CREATE INDEX messages_retention ON messages (status, updated_at);
    `,
    `
    -- Stage 6: lease ownership. owner_token is the fencing token — a fresh random value per claim
    -- batch, never reused, so a write guarded by "WHERE owner_token = ?" can only ever succeed for
    -- whoever currently holds the lease. NULL for every pre-migration 'processing' row (no legacy
    -- lease to compare against, so the reclaim query treats a NULL token as already reclaimable).
    ALTER TABLE messages ADD COLUMN owner_token TEXT;

    -- One row per live worker process (API-only processes have none of their own). Written on a
    -- timer by any process running a Worker loop; read by an API-only process's /ready and
    -- /metrics in place of the in-process Worker object it doesn't have (notify's readiness/stats
    -- were already DB-backed before this stage; this table adds the one signal that wasn't: is a
    -- worker alive at all).
    CREATE TABLE worker_heartbeat (
      instance TEXT PRIMARY KEY,
      seen_at  INTEGER NOT NULL
    );
    `,
    `
    -- Stage 6.1: distinguishes "claimed, never reached the delivery-attempt boundary" (an
    -- infra-only crash — release for a free retry, no attempt cost) from "crossed the boundary,
    -- external outcome unknown" (treated as a real attempt — reclaim costs one, same as any other
    -- failure). NULL means the boundary was never reached. Set once, right before the channel's
    -- deliver() call; cleared on every write that leaves 'processing' (finish or release). NOTE
    -- (Stage 6.2): a non-NULL value proves the process reached this write, NOT that the external
    -- SMTP/webhook call itself ever ran — the process can still crash in the gap between this
    -- write committing and deliver() actually being invoked. Counting that gap as a real attempt is
    -- a deliberate, conservative choice, not a claim that delivery definitely started.
    ALTER TABLE messages ADD COLUMN call_started_at INTEGER;
    `,
  ];
}
