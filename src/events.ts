import type { StatementSync } from "node:sqlite";

import { ConcordiaDatabase } from "./database.js";
import {
  ConcordiaException,
  EVENT_TYPES,
  type EventType,
  type SendEventInput,
  type TaskEvent,
  type WaitEventsInput,
  validateIdempotencyKey,
} from "./protocol.js";

interface EventRow {
  event_id: number;
  task_id: string;
  sender: string;
  recipient: string | null;
  type: string;
  payload_json: string;
  idempotency_key: string;
  created_at: string;
}

export interface ListEventsInput {
  taskId?: string;
  recipient?: string;
  afterEventId?: number;
  limit?: number;
  descending?: boolean;
}

function serializePayload(payload: unknown): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    throw new ConcordiaException("INVALID_INPUT", "Event payload must be JSON serializable");
  }
  if (serialized === undefined) {
    throw new ConcordiaException("INVALID_INPUT", "Event payload must be JSON serializable");
  }
  if (Buffer.byteLength(serialized, "utf8") > 1024 * 1024) {
    throw new ConcordiaException("INVALID_INPUT", "Event payload must not exceed 1 MiB");
  }
  return serialized;
}

function parseEvent(row: EventRow): TaskEvent {
  return {
    eventId: Number(row.event_id),
    taskId: row.task_id,
    sender: row.sender,
    ...(row.recipient === null ? {} : { recipient: row.recipient }),
    type: row.type as EventType,
    payload: JSON.parse(row.payload_json) as unknown,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
  };
}

export class EventService {
  constructor(private readonly database: ConcordiaDatabase) {}

  appendEvent<T>(input: SendEventInput<T>, createdAt = new Date().toISOString()): TaskEvent<T> {
    validateIdempotencyKey(input.idempotencyKey);
    if (!EVENT_TYPES.includes(input.type)) {
      throw new ConcordiaException("INVALID_INPUT", "Unsupported event type");
    }
    if (!input.sender || typeof input.sender !== "string") {
      throw new ConcordiaException("INVALID_INPUT", "Event sender must be a non-empty string");
    }
    const payloadJson = serializePayload(input.payload);

    return this.database.transaction(() => {
      const existing = this.getByIdempotencyKey(input.idempotencyKey);
      if (existing) {
        const sameOperation = existing.taskId === input.taskId
          && existing.sender === input.sender
          && existing.recipient === input.recipient
          && existing.type === input.type
          && serializePayload(existing.payload) === payloadJson;
        if (!sameOperation) {
          throw new ConcordiaException("INVALID_INPUT", "idempotencyKey was already used for a different event");
        }
        return existing as TaskEvent<T>;
      }

      const task = this.database.connection.prepare("SELECT 1 FROM tasks WHERE id = ?").get(input.taskId);
      if (!task) throw new ConcordiaException("TASK_NOT_FOUND", "Task was not found");
      const result = this.database.connection.prepare(`
        INSERT INTO events (task_id, sender, recipient, type, payload_json, idempotency_key, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.taskId,
        input.sender,
        input.recipient ?? null,
        input.type,
        payloadJson,
        input.idempotencyKey,
        createdAt,
      );
      return {
        eventId: Number(result.lastInsertRowid),
        taskId: input.taskId,
        sender: input.sender,
        ...(input.recipient === undefined ? {} : { recipient: input.recipient }),
        type: input.type,
        payload: input.payload,
        idempotencyKey: input.idempotencyKey,
        createdAt,
      };
    });
  }

  getByIdempotencyKey(key: string): TaskEvent | undefined {
    const row = this.database.connection.prepare("SELECT * FROM events WHERE idempotency_key = ?").get(key) as
      | EventRow
      | undefined;
    return row ? parseEvent(row) : undefined;
  }

  listEvents(input: ListEventsInput = {}): TaskEvent[] {
    const limit = input.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new ConcordiaException("INVALID_INPUT", "Event limit must be an integer from 1 to 100");
    }
    const afterEventId = input.afterEventId ?? 0;
    if (!Number.isInteger(afterEventId) || afterEventId < 0) {
      throw new ConcordiaException("INVALID_INPUT", "afterEventId must be a non-negative integer");
    }
    const clauses = ["event_id > ?"];
    const parameters: Array<string | number> = [afterEventId];
    if (input.taskId !== undefined) {
      clauses.push("task_id = ?");
      parameters.push(input.taskId);
    }
    if (input.recipient !== undefined) {
      clauses.push("recipient = ?");
      parameters.push(input.recipient);
    }
    parameters.push(limit);
    const direction = input.descending ? "DESC" : "ASC";
    const statement = this.database.connection.prepare(`
      SELECT * FROM events
      WHERE ${clauses.join(" AND ")}
      ORDER BY event_id ${direction}
      LIMIT ?
    `) as StatementSync;
    return (statement.all(...parameters) as unknown as EventRow[]).map(parseEvent);
  }

  async waitEvents(input: WaitEventsInput): Promise<TaskEvent[]> {
    const timeoutMs = input.timeoutMs ?? 30_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000) {
      throw new ConcordiaException("INVALID_INPUT", "timeoutMs must be an integer from 0 to 60000");
    }
    const deadline = Date.now() + timeoutMs;
    do {
      const events = this.listEvents({
        taskId: input.taskId,
        recipient: input.recipient,
        afterEventId: input.afterEventId,
        limit: input.limit,
      });
      if (events.length > 0 || Date.now() >= deadline) return events;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(500, deadline - Date.now())));
    } while (true);
  }
}

export function appendEvent<T>(service: EventService, input: SendEventInput<T>): TaskEvent<T> {
  return service.appendEvent(input);
}
