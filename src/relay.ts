#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createClient } from "@redis/client";

import { ConcordiaDatabase } from "./database.js";
import type { ConcordiaService } from "./index.js";
import {
  asConcordiaError,
  ConcordiaException,
  type ActorRole,
  type ClaimTaskInput,
  type ListTasksInput,
  type ReviewTaskInput,
  type SendEventInput,
  type TaskSpec,
  type TaskSubmission,
  type WaitEventsInput,
} from "./protocol.js";
import {
  DEFAULT_RELAY_MAX_CLOCK_SKEW_MS,
  assertFreshRelayTimestamp,
  assertRelayMethodAllowed,
  encodeSignedRelayMessage,
  parseRelayRequest,
  requireRelayToken,
  validateRedisUrl,
  validateRelayNamespace,
  verifyRelaySignature,
  type RelayMethod,
  type RelayRequestPayload,
  type RelayResponsePayload,
  type SignedRelayMessage,
} from "./relay-protocol.js";
import { TaskService } from "./tasks.js";
import { WorkspaceManager } from "./workspace.js";

const DEFAULT_MAX_INFLIGHT = 16;
const DEFAULT_MAX_MESSAGE_BYTES = 1_048_576;
const DEFAULT_RESPONSE_TTL_SECONDS = 300;
const DEFAULT_NONCE_TTL_SECONDS = 300;
const DEFAULT_PENDING_IDLE_MS = 120_000;
const LOCK_TTL_MS = 30_000;
const LOCK_RENEW_MS = 10_000;
const GROUP = "coordinators";

interface RelayEntry {
  id: string;
  payload?: string;
  signature?: string;
}

export interface RelayCoordinatorOptions {
  redisUrl: string;
  codexToken: string;
  zcodeToken: string;
  namespace?: string;
  maxInflight?: number;
  maxMessageBytes?: number;
  maxClockSkewMs?: number;
  responseTtlSeconds?: number;
  nonceTtlSeconds?: number;
  pendingIdleMs?: number;
  allowInsecure?: boolean;
  service: ConcordiaService;
}

export interface RelayCoordinator {
  close(): Promise<void>;
  done: Promise<void>;
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
  return positiveInteger(raw === undefined || raw === "" ? undefined : Number(raw), fallback, name);
}

function envBoolean(name: string): boolean {
  return /^(?:1|true|yes)$/i.test(process.env[name] ?? "");
}

function objectParams(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConcordiaException("INVALID_INPUT", "Relay method params must be an object");
  }
  return value as Record<string, unknown>;
}

export async function dispatchRelayRequest(
  service: ConcordiaService,
  role: ActorRole,
  method: RelayMethod,
  params: unknown,
): Promise<unknown> {
  assertRelayMethodAllowed(role, method, params);
  const input = objectParams(params);
  switch (method) {
    case "create_task":
      return service.createTask(input.spec as TaskSpec, input.idempotencyKey as string);
    case "claim_task":
      return service.claimTask(input as unknown as ClaimTaskInput);
    case "get_task":
      return service.getTask(input.taskId as string, input.eventLimit as number | undefined);
    case "list_tasks":
      return service.listTasks(input as unknown as ListTasksInput);
    case "send_event":
      return service.sendEvent(input as unknown as SendEventInput);
    case "wait_events":
      return service.waitEvents(input as unknown as WaitEventsInput);
    case "submit_task":
      return service.submitTask(input.submission as TaskSubmission, input.expectedVersion as number | undefined);
    case "review_task":
      return service.reviewTask(input as unknown as ReviewTaskInput);
  }
}

function parseEntries(reply: unknown): RelayEntry[] {
  if (!Array.isArray(reply)) return [];
  const streams = reply.length > 0 && typeof reply[0] === "string" ? [reply] : reply;
  const result: RelayEntry[] = [];
  for (const stream of streams) {
    if (!Array.isArray(stream) || !Array.isArray(stream[1])) continue;
    for (const entry of stream[1] as unknown[]) {
      if (!Array.isArray(entry) || typeof entry[0] !== "string" || !Array.isArray(entry[1])) continue;
      const fields = entry[1] as unknown[];
      const parsed: RelayEntry = { id: entry[0] };
      for (let index = 0; index + 1 < fields.length; index += 2) {
        const name = fields[index];
        const value = fields[index + 1];
        if (name === "payload" && typeof value === "string") parsed.payload = value;
        if (name === "signature" && typeof value === "string") parsed.signature = value;
      }
      result.push(parsed);
    }
  }
  return result;
}

function parseAutoClaimEntries(reply: unknown): RelayEntry[] {
  if (!Array.isArray(reply) || !Array.isArray(reply[1])) return [];
  return parseEntries(["stream", reply[1]]);
}

function byteLength(message: SignedRelayMessage): number {
  return Buffer.byteLength(message.payload) + Buffer.byteLength(message.signature);
}

function tokenForRole(role: ActorRole, codexToken: string, zcodeToken: string): string {
  return role === "codex" ? codexToken : zcodeToken;
}

export async function startRelayCoordinator(options: RelayCoordinatorOptions): Promise<RelayCoordinator> {
  const redisUrl = validateRedisUrl(options.redisUrl, options.allowInsecure ?? false);
  const codexToken = requireRelayToken(options.codexToken, "CONCORDIA_RELAY_CODEX_TOKEN");
  const zcodeToken = requireRelayToken(options.zcodeToken, "CONCORDIA_RELAY_ZCODE_TOKEN");
  if (codexToken === zcodeToken) {
    throw new ConcordiaException("INVALID_INPUT", "Codex and ZCode relay tokens must be different");
  }
  const namespace = validateRelayNamespace(options.namespace);
  const maxInflight = positiveInteger(options.maxInflight, DEFAULT_MAX_INFLIGHT, "maxInflight");
  const maxMessageBytes = positiveInteger(options.maxMessageBytes, DEFAULT_MAX_MESSAGE_BYTES, "maxMessageBytes");
  const maxClockSkewMs = positiveInteger(options.maxClockSkewMs, DEFAULT_RELAY_MAX_CLOCK_SKEW_MS, "maxClockSkewMs");
  const responseTtlSeconds = positiveInteger(options.responseTtlSeconds, DEFAULT_RESPONSE_TTL_SECONDS, "responseTtlSeconds");
  const nonceTtlSeconds = positiveInteger(options.nonceTtlSeconds, DEFAULT_NONCE_TTL_SECONDS, "nonceTtlSeconds");
  const pendingIdleMs = positiveInteger(options.pendingIdleMs, DEFAULT_PENDING_IDLE_MS, "pendingIdleMs");

  const command = createClient({ url: redisUrl });
  const reader = command.duplicate();
  command.on("error", () => undefined);
  reader.on("error", () => undefined);
  await command.connect();
  try {
    await reader.connect();
  } catch (error) {
    command.destroy();
    throw error;
  }

  const instanceId = randomUUID();
  const stream = `${namespace}:requests`;
  const lockKey = `${namespace}:coordinator:lock`;
  const lock = await command.sendCommand(["SET", lockKey, instanceId, "NX", "PX", String(LOCK_TTL_MS)]);
  if (String(lock) !== "OK") {
    command.destroy();
    reader.destroy();
    throw new ConcordiaException("INTERNAL_ERROR", "Another relay coordinator already holds this namespace", true);
  }
  try {
    await command.sendCommand(["XGROUP", "CREATE", stream, GROUP, "0", "MKSTREAM"]);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("BUSYGROUP")) {
      command.destroy();
      reader.destroy();
      throw error;
    }
  }

  let stopping = false;
  let lockLost = false;
  const inflight = new Set<Promise<void>>();
  const inflightEntryIds = new Set<string>();
  const renewTimer = setInterval(() => {
    void command.sendCommand([
      "EVAL",
      "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('pexpire',KEYS[1],ARGV[2]) else return 0 end",
      "1", lockKey, instanceId, String(LOCK_TTL_MS),
    ]).then((value) => {
      if (Number(value) !== 1) {
        lockLost = true;
        stopping = true;
        reader.destroy();
      }
    }).catch(() => {
      lockLost = true;
      stopping = true;
      reader.destroy();
    });
  }, LOCK_RENEW_MS);
  renewTimer.unref();

  const acknowledge = async (entryId: string): Promise<void> => {
    await command.sendCommand(["XACK", stream, GROUP, entryId]);
  };

  const storeResponse = async (request: RelayRequestPayload, response: RelayResponsePayload): Promise<void> => {
    const token = tokenForRole(request.role, codexToken, zcodeToken);
    const signed = encodeSignedRelayMessage(response, token);
    if (byteLength(signed) > maxMessageBytes) {
      const fallback = encodeSignedRelayMessage({
        version: 1,
        requestId: request.requestId,
        issuedAt: Date.now(),
        ok: false,
        error: new ConcordiaException("INTERNAL_ERROR", "Relay response exceeds the configured message-size limit").toJSON(),
      }, token);
      await command.set(`${namespace}:response:${request.clientId}:${request.requestId}`, JSON.stringify(fallback), { EX: responseTtlSeconds });
      return;
    }
    await command.set(`${namespace}:response:${request.clientId}:${request.requestId}`, JSON.stringify(signed), { EX: responseTtlSeconds });
  };

  const handleEntry = async (entry: RelayEntry): Promise<void> => {
    let request: RelayRequestPayload | undefined;
    try {
      if (!entry.payload || !entry.signature) {
        throw new ConcordiaException("INVALID_INPUT", "Relay stream entry is incomplete");
      }
      if (byteLength({ payload: entry.payload, signature: entry.signature }) > maxMessageBytes) {
        throw new ConcordiaException("INVALID_INPUT", "Relay request exceeds the configured message-size limit");
      }
      request = parseRelayRequest(entry.payload);
      const token = tokenForRole(request.role, codexToken, zcodeToken);
      if (!verifyRelaySignature(entry.payload, entry.signature, token)) {
        throw new ConcordiaException("INVALID_INPUT", "Relay request signature is invalid");
      }
      const responseKey = `${namespace}:response:${request.clientId}:${request.requestId}`;
      if (await command.get(responseKey) !== null) return;
      assertFreshRelayTimestamp(request.issuedAt, Date.now(), maxClockSkewMs);
      const nonceKey = `${namespace}:nonce:${request.role}:${request.nonce}`;
      const reserved = await command.sendCommand(["SET", nonceKey, "1", "NX", "EX", String(nonceTtlSeconds)]);
      if (String(reserved) !== "OK") throw new ConcordiaException("INVALID_INPUT", "Relay request nonce was already used");
      const result = await dispatchRelayRequest(options.service, request.role, request.method, request.params);
      await storeResponse(request, { version: 1, requestId: request.requestId, issuedAt: Date.now(), ok: true, result });
    } catch (error) {
      if (request) {
        const safeError = asConcordiaError(error);
        await storeResponse(request, {
          version: 1,
          requestId: request.requestId,
          issuedAt: Date.now(),
          ok: false,
          error: safeError.toJSON(),
        }).catch(() => undefined);
      }
    } finally {
      await acknowledge(entry.id).catch(() => undefined);
    }
  };

  const schedule = (entries: RelayEntry[]): void => {
    for (const entry of entries) {
      if (inflightEntryIds.has(entry.id)) continue;
      inflightEntryIds.add(entry.id);
      const operation = handleEntry(entry).finally(() => {
        inflight.delete(operation);
        inflightEntryIds.delete(entry.id);
      });
      inflight.add(operation);
    }
  };

  const loop = async (): Promise<void> => {
    while (!stopping) {
      try {
        if (inflight.size >= maxInflight) {
          await Promise.race(inflight);
          continue;
        }
        const capacity = maxInflight - inflight.size;
        const claimed = await command.sendCommand([
          "XAUTOCLAIM", stream, GROUP, instanceId, String(pendingIdleMs), "0-0", "COUNT", String(capacity),
        ]);
        const claimedEntries = parseAutoClaimEntries(claimed);
        if (claimedEntries.length > 0) {
          schedule(claimedEntries);
          continue;
        }
        const reply = await reader.sendCommand([
          "XREADGROUP", "GROUP", GROUP, instanceId, "COUNT", String(capacity), "BLOCK", "1000", "STREAMS", stream, ">",
        ]);
        schedule(parseEntries(reply));
      } catch {
        if (stopping) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    await Promise.allSettled(inflight);
    if (lockLost) throw new ConcordiaException("INTERNAL_ERROR", "Relay coordinator lock was lost", true);
  };

  const done = loop();
  const close = async (): Promise<void> => {
    if (stopping && !lockLost) return done.catch(() => undefined);
    stopping = true;
    clearInterval(renewTimer);
    reader.destroy();
    await done.catch(() => undefined);
    await command.sendCommand([
      "EVAL",
      "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end",
      "1", lockKey, instanceId,
    ]).catch(() => undefined);
    await command.quit().catch(() => command.destroy());
  };
  return { close, done };
}

export async function runRelayCoordinator(): Promise<void> {
  const allowInsecure = envBoolean("CONCORDIA_RELAY_ALLOW_INSECURE");
  const redisUrl = validateRedisUrl(process.env.CONCORDIA_REDIS_URL, allowInsecure);
  const codexToken = requireRelayToken(process.env.CONCORDIA_RELAY_CODEX_TOKEN, "CONCORDIA_RELAY_CODEX_TOKEN");
  const zcodeToken = requireRelayToken(process.env.CONCORDIA_RELAY_ZCODE_TOKEN, "CONCORDIA_RELAY_ZCODE_TOKEN");
  const database = new ConcordiaDatabase();
  let coordinator: RelayCoordinator | undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await coordinator?.close();
    database.close();
  };
  try {
    const service = new TaskService(database, new WorkspaceManager());
    coordinator = await startRelayCoordinator({
      redisUrl,
      codexToken,
      zcodeToken,
      namespace: process.env.CONCORDIA_RELAY_NAMESPACE,
      maxInflight: envInteger("CONCORDIA_RELAY_MAX_INFLIGHT", DEFAULT_MAX_INFLIGHT),
      maxMessageBytes: envInteger("CONCORDIA_RELAY_MAX_MESSAGE_BYTES", DEFAULT_MAX_MESSAGE_BYTES),
      maxClockSkewMs: envInteger("CONCORDIA_RELAY_CLOCK_SKEW_MS", DEFAULT_RELAY_MAX_CLOCK_SKEW_MS),
      responseTtlSeconds: envInteger("CONCORDIA_RELAY_RESPONSE_TTL_SECONDS", DEFAULT_RESPONSE_TTL_SECONDS),
      nonceTtlSeconds: envInteger("CONCORDIA_RELAY_NONCE_TTL_SECONDS", DEFAULT_NONCE_TTL_SECONDS),
      pendingIdleMs: envInteger("CONCORDIA_RELAY_PENDING_IDLE_MS", DEFAULT_PENDING_IDLE_MS),
      allowInsecure,
      service,
    });
  } catch (error) {
    await close();
    throw error;
  }
  process.once("SIGINT", () => void close().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
  console.error(JSON.stringify({ level: "info", event: "relay.started", namespace: validateRelayNamespace(process.env.CONCORDIA_RELAY_NAMESPACE) }));
  try {
    await coordinator.done;
  } finally {
    await close();
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  runRelayCoordinator().catch((error: unknown) => {
    const concordiaError = asConcordiaError(error);
    console.error(JSON.stringify({ level: "error", event: "relay.failed", error: concordiaError.toJSON() }));
    process.exitCode = 1;
  });
}
