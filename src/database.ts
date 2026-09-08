import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { ConcordiaException } from "./protocol.js";

const SCHEMA_VERSION = 2;
const INITIALIZATION_RETRIES = 12;

export interface DatabaseOptions {
  path?: string;
}

export class ConcordiaDatabase {
  readonly path: string;
  readonly connection: DatabaseSync;
  private transactionDepth = 0;

  constructor(options: DatabaseOptions | string = {}) {
    const requestedPath = typeof options === "string" ? options : options.path;
    const configuredPath = requestedPath ?? process.env.CONCORDIA_DB ?? resolve(process.cwd(), ".concordia/state.db");
    this.path = configuredPath === ":memory:"
      ? ":memory:"
      : resolve(configuredPath);

    if (this.path !== ":memory:") {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    }

    this.connection = new DatabaseSync(this.path);
    try {
      this.connection.exec("PRAGMA foreign_keys = ON");
      // Keep each initialization attempt bounded; the explicit retry loop handles
      // startup contention. Runtime operations use the documented five seconds.
      this.connection.exec("PRAGMA busy_timeout = 250");
      if (this.path !== ":memory:") {
        this.retryLocked(() => this.connection.exec("PRAGMA journal_mode = WAL"));
      }
      this.migrate();
      this.connection.exec("PRAGMA busy_timeout = 5000");

      if (this.path !== ":memory:") chmodSync(this.path, 0o600);
    } catch (error) {
      this.connection.close();
      throw error;
    }
  }

  close(): void {
    this.connection.close();
  }

  transaction<T>(operation: () => T): T {
    if (this.transactionDepth > 0) return operation();

    this.connection.exec("BEGIN IMMEDIATE");
    this.transactionDepth += 1;
    try {
      const result = operation();
      this.connection.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.connection.exec("ROLLBACK");
      } catch {
        // Preserve the error which caused the rollback.
      }
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  private migrate(): void {
    this.retryLocked(() => this.transaction(() => {
      // The version must be read after BEGIN IMMEDIATE. Another process may have
      // completed the same migration while this connection was waiting for the lock.
      const versionRow = this.connection.prepare("PRAGMA user_version").get() as
        | { user_version: number }
        | undefined;
      const version = Number(versionRow?.user_version ?? 0);
      if (version > SCHEMA_VERSION) {
        throw new ConcordiaException(
          "INTERNAL_ERROR",
          `Database schema version ${version} is newer than supported version ${SCHEMA_VERSION}`,
        );
      }
      if (version === SCHEMA_VERSION) return;

      this.connection.exec(`
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          assignee TEXT,
          objective TEXT NOT NULL,
          spec_json TEXT NOT NULL,
          workspace TEXT NOT NULL,
          base_commit TEXT,
          worktree_path TEXT,
          lease_owner TEXT,
          lease_until TEXT,
          attempt INTEGER NOT NULL DEFAULT 0,
          version INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS events (
          event_id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT NOT NULL REFERENCES tasks(id),
          sender TEXT NOT NULL,
          recipient TEXT,
          type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          idempotency_key TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS events_task_cursor ON events(task_id, event_id);
        CREATE INDEX IF NOT EXISTS events_recipient_cursor ON events(recipient, event_id);
        CREATE INDEX IF NOT EXISTS tasks_claim_order ON tasks(status, created_at);

        CREATE TABLE IF NOT EXISTS artifacts (
          artifact_id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT NOT NULL REFERENCES tasks(id),
          kind TEXT NOT NULL,
          local_path TEXT NOT NULL,
          checksum TEXT,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL
        );
      `);
      if (version < 2) {
        this.connection.exec("ALTER TABLE tasks ADD COLUMN lease_token TEXT");
      }
      this.connection.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }));
  }

  private retryLocked<T>(operation: () => T): T {
    for (let attempt = 0; attempt < INITIALIZATION_RETRIES; attempt += 1) {
      try {
        return operation();
      } catch (error) {
        if (!this.isLockError(error)) throw error;
        if (attempt + 1 < INITIALIZATION_RETRIES) {
          const delayMs = Math.min(100, 10 * (attempt + 1));
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
        }
      }
    }
    throw new ConcordiaException(
      "INTERNAL_ERROR",
      "SQLite remained locked during database initialization",
      true,
      { attempts: INITIALIZATION_RETRIES },
    );
  }

  private isLockError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const candidate = error as Error & { code?: string; errcode?: number };
    return candidate.code?.startsWith("SQLITE_BUSY") === true
      || candidate.code?.startsWith("SQLITE_LOCKED") === true
      || candidate.errcode === 5
      || candidate.errcode === 6
      || /\b(?:database|table|schema).*\b(?:busy|locked)\b/i.test(candidate.message);
  }
}

export function openDatabase(options: DatabaseOptions | string = {}): ConcordiaDatabase {
  return new ConcordiaDatabase(options);
}

export const Database = ConcordiaDatabase;
