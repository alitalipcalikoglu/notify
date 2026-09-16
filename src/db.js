import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * SQLite connection with schema migrations applied on open.
 */
export class Database {
  /**
   * Ordered, append-only migrations. `PRAGMA user_version` tracks the applied count.
   * @type {readonly string[]}
   */
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

  /** @param {string} path File path, or ":memory:". */
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    /** @readonly */
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA journal_mode = WAL');
    this.raw.exec('PRAGMA synchronous = NORMAL');
    this.raw.exec('PRAGMA busy_timeout = 5000');
    this.raw.exec('PRAGMA foreign_keys = ON');
    this.#migrate();
  }

  #migrate() {
    const { user_version: current } = /** @type {{ user_version: number }} */ (this.raw.prepare('PRAGMA user_version').get());
    for (let v = current; v < Database.MIGRATIONS.length; v++) {
      this.raw.exec('BEGIN');
      try {
        this.raw.exec(Database.MIGRATIONS[v]);
        this.raw.exec(`PRAGMA user_version = ${v + 1}`);
        this.raw.exec('COMMIT');
      } catch (err) {
        this.raw.exec('ROLLBACK');
        throw err;
      }
    }
  }

  /** @param {string} sql */
  prepare(sql) {
    return this.raw.prepare(sql);
  }

  /** Cheap liveness probe; throws if the connection is unusable. */
  ping() {
    this.raw.prepare('SELECT 1').get();
  }

  close() {
    this.raw.close();
  }
}
