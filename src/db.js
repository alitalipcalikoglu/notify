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
  ];
}
