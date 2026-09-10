import { chmodSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { TaskEvent } from "./protocol.js";

export type DeliveryStatus = "running" | "completed" | "failed";

export interface WakerThreadRecord {
  taskId: string;
  threadId: string;
  cwd: string;
}

export interface WakerSessionRecord {
  taskId: string;
  sessionId: string;
  cwd: string;
}

export interface DeliveryRecord {
  eventId: number;
  taskId: string;
  eventType: string;
  status: DeliveryStatus;
  attempts: number;
  turnId?: string;
  lastError?: string;
}

interface MetaRow {
  value: string;
}

interface InstanceRecord {
  ownerId: string;
  pid: number;
}

interface ThreadRow {
  task_id: string;
  thread_id: string;
  cwd: string;
}

interface DeliveryRow {
  event_id: number;
  task_id: string;
  event_type: string;
  status: DeliveryStatus;
  attempts: number;
  turn_id: string | null;
  last_error: string | null;
}

export interface WakerState {
  getCursor(): number;
  advanceCursor(eventId: number): void;
  getThread(taskId: string): WakerThreadRecord | undefined;
  saveThread(record: WakerThreadRecord): void;
  getSession(taskId: string): WakerSessionRecord | undefined;
  saveSession(record: WakerSessionRecord): void;
  getDelivery(eventId: number): DeliveryRecord | undefined;
  beginDelivery(event: TaskEvent): DeliveryRecord;
  markDeliveryRunning(eventId: number, turnId: string): void;
  completeDelivery(eventId: number): void;
  failDelivery(eventId: number, error: string): void;
  close(): void;
}

function parseNonNegativeInteger(value: string | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function parseDelivery(row: DeliveryRow): DeliveryRecord {
  return {
    eventId: Number(row.event_id),
    taskId: row.task_id,
    eventType: row.event_type,
    status: row.status,
    attempts: Number(row.attempts),
    ...(row.turn_id === null ? {} : { turnId: row.turn_id }),
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
  };
}

export class WakerStateDatabase implements WakerState {
  readonly path: string;
  readonly connection: DatabaseSync;
  private readonly ownerId: string;
  private closed = false;

  constructor(path = process.env.CONCORDIA_WAKER_DB ?? resolve(process.cwd(), ".concordia/waker.db")) {
    this.path = path === ":memory:" ? path : resolve(path);
    this.ownerId = `${process.pid}:${randomUUID()}`;
    if (this.path !== ":memory:") {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    }
    this.connection = new DatabaseSync(this.path);
    try {
      this.connection.exec("PRAGMA busy_timeout = 5000");
      this.connection.exec("PRAGMA journal_mode = WAL");
      this.connection.exec(`
        CREATE TABLE IF NOT EXISTS waker_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS waker_threads (
          task_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          cwd TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS waker_deliveries (
          event_id INTEGER PRIMARY KEY,
          task_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
          attempts INTEGER NOT NULL DEFAULT 0,
          turn_id TEXT,
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      if (this.path !== ":memory:") {
        this.acquireInstanceLock();
        chmodSync(this.path, 0o600);
      }
    } catch (error) {
      this.connection.close();
      throw error;
    }
  }

  getCursor(): number {
    const row = this.connection.prepare("SELECT value FROM waker_meta WHERE key = 'event_cursor'").get() as
      | MetaRow
      | undefined;
    return parseNonNegativeInteger(row?.value);
  }

  advanceCursor(eventId: number): void {
    if (!Number.isSafeInteger(eventId) || eventId < 0) throw new Error("eventId must be a non-negative integer");
    const cursor = Math.max(this.getCursor(), eventId);
    this.connection.prepare(`
      INSERT INTO waker_meta (key, value) VALUES ('event_cursor', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(cursor));
  }

  getThread(taskId: string): WakerThreadRecord | undefined {
    const row = this.connection.prepare("SELECT task_id, thread_id, cwd FROM waker_threads WHERE task_id = ?").get(taskId) as
      | ThreadRow
      | undefined;
    return row ? { taskId: row.task_id, threadId: row.thread_id, cwd: row.cwd } : undefined;
  }

  saveThread(record: WakerThreadRecord): void {
    const now = new Date().toISOString();
    this.connection.prepare(`
      INSERT INTO waker_threads (task_id, thread_id, cwd, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        thread_id = excluded.thread_id,
        cwd = excluded.cwd,
        updated_at = excluded.updated_at
    `).run(record.taskId, record.threadId, record.cwd, now, now);
  }

  getSession(taskId: string): WakerSessionRecord | undefined {
    const record = this.getThread(taskId);
    return record === undefined
      ? undefined
      : { taskId: record.taskId, sessionId: record.threadId, cwd: record.cwd };
  }

  saveSession(record: WakerSessionRecord): void {
    this.saveThread({ taskId: record.taskId, threadId: record.sessionId, cwd: record.cwd });
  }

  getDelivery(eventId: number): DeliveryRecord | undefined {
    const row = this.connection.prepare("SELECT * FROM waker_deliveries WHERE event_id = ?").get(eventId) as
      | DeliveryRow
      | undefined;
    return row ? parseDelivery(row) : undefined;
  }

  beginDelivery(event: TaskEvent): DeliveryRecord {
    const now = new Date().toISOString();
    this.connection.prepare(`
      INSERT INTO waker_deliveries (
        event_id, task_id, event_type, status, attempts, created_at, updated_at
      ) VALUES (?, ?, ?, 'running', 1, ?, ?)
      ON CONFLICT(event_id) DO UPDATE SET
        status = 'running',
        attempts = attempts + 1,
        turn_id = NULL,
        last_error = NULL,
        updated_at = excluded.updated_at
    `).run(event.eventId, event.taskId, event.type, now, now);
    return this.getDelivery(event.eventId)!;
  }

  markDeliveryRunning(eventId: number, turnId: string): void {
    this.connection.prepare(`
      UPDATE waker_deliveries
      SET status = 'running', turn_id = ?, updated_at = ?
      WHERE event_id = ?
    `).run(turnId, new Date().toISOString(), eventId);
  }

  completeDelivery(eventId: number): void {
    this.connection.prepare(`
      UPDATE waker_deliveries
      SET status = 'completed', last_error = NULL, updated_at = ?
      WHERE event_id = ?
    `).run(new Date().toISOString(), eventId);
  }

  failDelivery(eventId: number, error: string): void {
    this.connection.prepare(`
      UPDATE waker_deliveries
      SET status = 'failed', last_error = ?, updated_at = ?
      WHERE event_id = ?
    `).run(error.slice(0, 4_000), new Date().toISOString(), eventId);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.path !== ":memory:") {
      this.connection.prepare(
        "DELETE FROM waker_meta WHERE key = 'active_instance' AND value = ?",
      ).run(JSON.stringify({ ownerId: this.ownerId, pid: process.pid }));
    }
    this.connection.close();
  }

  private acquireInstanceLock(): void {
    const record: InstanceRecord = { ownerId: this.ownerId, pid: process.pid };
    this.connection.exec("BEGIN IMMEDIATE");
    try {
      const row = this.connection.prepare(
        "SELECT value FROM waker_meta WHERE key = 'active_instance'",
      ).get() as MetaRow | undefined;
      const active = parseInstanceRecord(row?.value);
      if (active && pidIsAlive(active.pid)) {
        throw new WakerInstanceActiveError(this.path, active.pid);
      }
      this.connection.prepare(`
        INSERT INTO waker_meta (key, value) VALUES ('active_instance', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(JSON.stringify(record));
      this.connection.exec("COMMIT");
    } catch (error) {
      try {
        this.connection.exec("ROLLBACK");
      } catch {
        // Preserve the lock acquisition error.
      }
      throw error;
    }
  }
}

function parseInstanceRecord(value: string | undefined): InstanceRecord | undefined {
  if (!value) return undefined;
  try {
    const record = JSON.parse(value) as Partial<InstanceRecord>;
    return typeof record.ownerId === "string"
      && Number.isSafeInteger(record.pid)
      && Number(record.pid) > 0
      ? { ownerId: record.ownerId, pid: Number(record.pid) }
      : undefined;
  } catch {
    return undefined;
  }
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

export class WakerInstanceActiveError extends Error {
  constructor(readonly databasePath: string, readonly pid: number) {
    super(`Another waker instance (pid ${pid}) is already using ${databasePath}`);
    this.name = "WakerInstanceActiveError";
  }
}
