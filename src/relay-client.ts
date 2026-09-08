import { randomUUID } from "node:crypto";
import { createClient } from "@redis/client";

import type { ConcordiaService } from "./index.js";
import {
  ConcordiaException,
  type ActorRole,
  type ClaimTaskInput,
  type ClaimTaskResult,
  type CreateTaskResult,
  type ListTasksInput,
  type ReviewTaskInput,
  type SendEventInput,
  type TaskDetail,
  type TaskEvent,
  type TaskRecord,
  type TaskSpec,
  type TaskSubmission,
  type WaitEventsInput,
} from "./protocol.js";
import {
  DEFAULT_RELAY_MAX_CLOCK_SKEW_MS,
  assertFreshRelayTimestamp,
  encodeSignedRelayMessage,
  parseRelayResponse,
  requireRelayToken,
  validateRedisUrl,
  validateRelayNamespace,
  verifyRelaySignature,
  type RelayMethod,
  type RelayRequestPayload,
  type SignedRelayMessage,
} from "./relay-protocol.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 75_000;
const DEFAULT_RESPONSE_POLL_MS = 100;
const DEFAULT_MAX_MESSAGE_BYTES = 1_048_576;

export interface RedisRelayClientOptions {
  role: ActorRole;
  redisUrl: string;
  token: string;
  namespace?: string;
  requestTimeoutMs?: number;
  responsePollMs?: number;
  maxMessageBytes?: number;
  maxClockSkewMs?: number;
  allowInsecure?: boolean;
}

function positiveInteger(value: number | undefined, fallback: number, field: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) {
    throw new ConcordiaException("INVALID_INPUT", `${field} must be a positive integer`);
  }
  return result;
}

function envInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return positiveInteger(value, fallback, name);
}

function envBoolean(name: string): boolean {
  return /^(?:1|true|yes)$/i.test(process.env[name] ?? "");
}

function byteLength(message: SignedRelayMessage): number {
  return Buffer.byteLength(message.payload) + Buffer.byteLength(message.signature);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class RedisRelayService implements ConcordiaService {
  readonly role: ActorRole;
  readonly clientId = randomUUID();
  readonly namespace: string;
  readonly requestTimeoutMs: number;
  readonly responsePollMs: number;
  readonly maxMessageBytes: number;
  readonly maxClockSkewMs: number;
  private readonly token: string;
  private readonly client;
  private connected = false;

  constructor(options: RedisRelayClientOptions) {
    this.role = options.role;
    const redisUrl = validateRedisUrl(options.redisUrl, options.allowInsecure ?? false);
    this.token = requireRelayToken(options.token, `CONCORDIA_RELAY_${this.role.toUpperCase()}_TOKEN`);
    this.namespace = validateRelayNamespace(options.namespace);
    this.requestTimeoutMs = positiveInteger(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, "requestTimeoutMs");
    this.responsePollMs = positiveInteger(options.responsePollMs, DEFAULT_RESPONSE_POLL_MS, "responsePollMs");
    this.maxMessageBytes = positiveInteger(options.maxMessageBytes, DEFAULT_MAX_MESSAGE_BYTES, "maxMessageBytes");
    this.maxClockSkewMs = positiveInteger(options.maxClockSkewMs, DEFAULT_RELAY_MAX_CLOCK_SKEW_MS, "maxClockSkewMs");
    this.client = createClient({ url: redisUrl });
    this.client.on("error", () => {
      // Requests surface connection failures. Never log the Redis URL or credentials here.
    });
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.client.connect();
    this.connected = true;
  }

  async close(): Promise<void> {
    if (!this.connected) return;
    this.connected = false;
    await this.client.quit().catch(() => this.client.destroy());
  }

  async createTask(spec: TaskSpec, idempotencyKey: string): Promise<CreateTaskResult> {
    return this.request("create_task", { spec, idempotencyKey }) as Promise<CreateTaskResult>;
  }

  async claimTask(input: ClaimTaskInput): Promise<ClaimTaskResult> {
    return this.request("claim_task", input) as Promise<ClaimTaskResult>;
  }

  async getTask(taskId: string, recentEventLimit?: number): Promise<TaskDetail> {
    return this.request("get_task", { taskId, eventLimit: recentEventLimit }) as Promise<TaskDetail>;
  }

  async listTasks(input: ListTasksInput = {}): Promise<TaskRecord[]> {
    return this.request("list_tasks", input) as Promise<TaskRecord[]>;
  }

  async sendEvent<T>(input: SendEventInput<T>): Promise<TaskEvent<T>> {
    return this.request("send_event", input) as Promise<TaskEvent<T>>;
  }

  async waitEvents(input: WaitEventsInput): Promise<TaskEvent[]> {
    return this.request("wait_events", input) as Promise<TaskEvent[]>;
  }

  async submitTask(submission: TaskSubmission, expectedVersion?: number): Promise<TaskDetail> {
    return this.request("submit_task", { submission, expectedVersion }) as Promise<TaskDetail>;
  }

  async reviewTask(input: ReviewTaskInput): Promise<TaskDetail> {
    return this.request("review_task", input) as Promise<TaskDetail>;
  }

  private async request(method: RelayMethod, params: unknown): Promise<unknown> {
    await this.connect();
    const requestId = randomUUID();
    const request: RelayRequestPayload = {
      version: 1,
      requestId,
      clientId: this.clientId,
      role: this.role,
      method,
      params,
      issuedAt: Date.now(),
      nonce: randomUUID(),
    };
    const message = encodeSignedRelayMessage(request, this.token);
    if (byteLength(message) > this.maxMessageBytes) {
      throw new ConcordiaException("INVALID_INPUT", "Relay request exceeds the configured message-size limit");
    }

    const requestStream = `${this.namespace}:requests`;
    const responseKey = `${this.namespace}:response:${this.clientId}:${requestId}`;
    try {
      await this.client.sendCommand([
        "XADD", requestStream, "MAXLEN", "~", "10000", "*",
        "payload", message.payload, "signature", message.signature,
      ]);
    } catch {
      throw new ConcordiaException("INTERNAL_ERROR", "Unable to publish the Redis relay request", true);
    }

    const deadline = Date.now() + this.requestTimeoutMs;
    while (Date.now() < deadline) {
      let raw: string | null;
      try {
        raw = await this.client.get(responseKey);
      } catch {
        throw new ConcordiaException("INTERNAL_ERROR", "Unable to read the Redis relay response", true);
      }
      if (raw !== null) {
        void this.client.del(responseKey).catch(() => undefined);
        return this.decodeResponse(raw, requestId);
      }
      await delay(Math.min(this.responsePollMs, Math.max(1, deadline - Date.now())));
    }
    throw new ConcordiaException("INTERNAL_ERROR", "Redis relay request timed out", true, { method });
  }

  private decodeResponse(raw: string, requestId: string): unknown {
    let message: Partial<SignedRelayMessage>;
    try {
      message = JSON.parse(raw) as Partial<SignedRelayMessage>;
    } catch {
      throw new ConcordiaException("INTERNAL_ERROR", "Redis relay returned an invalid response", true);
    }
    if (typeof message.payload !== "string" || typeof message.signature !== "string") {
      throw new ConcordiaException("INTERNAL_ERROR", "Redis relay returned an invalid signed response", true);
    }
    if (byteLength(message as SignedRelayMessage) > this.maxMessageBytes) {
      throw new ConcordiaException("INTERNAL_ERROR", "Redis relay response exceeds the configured message-size limit");
    }
    if (!verifyRelaySignature(message.payload, message.signature, this.token)) {
      throw new ConcordiaException("INTERNAL_ERROR", "Redis relay response signature is invalid");
    }
    const response = parseRelayResponse(message.payload);
    if (response.requestId !== requestId) {
      throw new ConcordiaException("INTERNAL_ERROR", "Redis relay response does not match the request");
    }
    assertFreshRelayTimestamp(response.issuedAt, Date.now(), this.maxClockSkewMs);
    if (response.ok) return response.result;
    const error = response.error;
    if (!error) throw new ConcordiaException("INTERNAL_ERROR", "Redis relay response omitted its error");
    throw new ConcordiaException(error.code, error.message, error.retryable, error.details);
  }
}

export function createRedisRelayServiceFromEnv(role: ActorRole): RedisRelayService {
  const tokenName = role === "codex" ? "CONCORDIA_RELAY_CODEX_TOKEN" : "CONCORDIA_RELAY_ZCODE_TOKEN";
  return new RedisRelayService({
    role,
    redisUrl: validateRedisUrl(process.env.CONCORDIA_REDIS_URL, envBoolean("CONCORDIA_RELAY_ALLOW_INSECURE")),
    token: requireRelayToken(process.env[tokenName], tokenName),
    namespace: process.env.CONCORDIA_RELAY_NAMESPACE,
    requestTimeoutMs: envInteger("CONCORDIA_RELAY_REQUEST_TIMEOUT_MS", DEFAULT_REQUEST_TIMEOUT_MS),
    responsePollMs: envInteger("CONCORDIA_RELAY_RESPONSE_POLL_MS", DEFAULT_RESPONSE_POLL_MS),
    maxMessageBytes: envInteger("CONCORDIA_RELAY_MAX_MESSAGE_BYTES", DEFAULT_MAX_MESSAGE_BYTES),
    maxClockSkewMs: envInteger("CONCORDIA_RELAY_CLOCK_SKEW_MS", DEFAULT_RELAY_MAX_CLOCK_SKEW_MS),
    allowInsecure: envBoolean("CONCORDIA_RELAY_ALLOW_INSECURE"),
  });
}
