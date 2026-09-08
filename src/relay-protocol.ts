import { createHmac, timingSafeEqual } from "node:crypto";

import { ConcordiaException, type ActorRole, type ConcordiaErrorShape } from "./protocol.js";

export const RELAY_METHODS = [
  "create_task",
  "claim_task",
  "get_task",
  "list_tasks",
  "send_event",
  "wait_events",
  "submit_task",
  "review_task",
] as const;

export type RelayMethod = (typeof RELAY_METHODS)[number];

export interface RelayRequestPayload {
  version: 1;
  requestId: string;
  clientId: string;
  role: ActorRole;
  method: RelayMethod;
  params: unknown;
  issuedAt: number;
  nonce: string;
}

export interface RelayResponsePayload {
  version: 1;
  requestId: string;
  issuedAt: number;
  ok: boolean;
  result?: unknown;
  error?: ConcordiaErrorShape;
}

export interface SignedRelayMessage {
  payload: string;
  signature: string;
}

export const MIN_RELAY_TOKEN_LENGTH = 32;
export const DEFAULT_RELAY_NAMESPACE = "concordia";
export const DEFAULT_RELAY_MAX_CLOCK_SKEW_MS = 60_000;

export function requireRelayToken(value: string | undefined, field: string): string {
  if (!value || value.length < MIN_RELAY_TOKEN_LENGTH) {
    throw new ConcordiaException(
      "INVALID_INPUT",
      `${field} must contain at least ${MIN_RELAY_TOKEN_LENGTH} characters`,
    );
  }
  return value;
}

export function validateRelayNamespace(value: string | undefined): string {
  const namespace = value ?? DEFAULT_RELAY_NAMESPACE;
  if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$/.test(namespace)) {
    throw new ConcordiaException(
      "INVALID_INPUT",
      "CONCORDIA_RELAY_NAMESPACE must contain 1-64 letters, digits, colons, underscores, or hyphens",
    );
  }
  return namespace;
}

export function signRelayPayload(payload: string, token: string): string {
  return createHmac("sha256", token).update(payload).digest("base64url");
}

export function verifyRelaySignature(payload: string, signature: string, token: string): boolean {
  const expected = Buffer.from(signRelayPayload(payload, token), "utf8");
  const actual = Buffer.from(signature, "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function encodeSignedRelayMessage(value: RelayRequestPayload | RelayResponsePayload, token: string): SignedRelayMessage {
  const payload = JSON.stringify(value);
  return { payload, signature: signRelayPayload(payload, token) };
}

export function isRelayMethod(value: unknown): value is RelayMethod {
  return typeof value === "string" && (RELAY_METHODS as readonly string[]).includes(value);
}

export function assertRelayMethodAllowed(role: ActorRole, method: RelayMethod, params: unknown): void {
  if ((method === "create_task" || method === "review_task") && role !== "codex") {
    throw new ConcordiaException("INVALID_INPUT", `The authenticated ${role} client cannot call this codex tool`);
  }
  if ((method === "claim_task" || method === "submit_task") && role !== "zcode") {
    throw new ConcordiaException("INVALID_INPUT", `The authenticated ${role} client cannot call this zcode tool`);
  }
  if (method === "send_event") {
    if (!params || typeof params !== "object" || (params as { sender?: unknown }).sender !== role) {
      throw new ConcordiaException("INVALID_INPUT", "Event sender does not match the authenticated relay role");
    }
  }
}

export function assertFreshRelayTimestamp(issuedAt: number, now: number, maxClockSkewMs: number): void {
  if (!Number.isSafeInteger(issuedAt) || Math.abs(now - issuedAt) > maxClockSkewMs) {
    throw new ConcordiaException("INVALID_INPUT", "Relay message timestamp is outside the accepted clock-skew window");
  }
}

export function assertSafeRelayIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(value)) {
    throw new ConcordiaException("INVALID_INPUT", `${field} is invalid`);
  }
  return value;
}

export function parseRelayRequest(payload: string): RelayRequestPayload {
  let value: unknown;
  try {
    value = JSON.parse(payload) as unknown;
  } catch {
    throw new ConcordiaException("INVALID_INPUT", "Relay request payload is not valid JSON");
  }
  if (!value || typeof value !== "object") {
    throw new ConcordiaException("INVALID_INPUT", "Relay request payload must be an object");
  }
  const candidate = value as Partial<RelayRequestPayload>;
  if (candidate.version !== 1 || (candidate.role !== "codex" && candidate.role !== "zcode") || !isRelayMethod(candidate.method)) {
    throw new ConcordiaException("INVALID_INPUT", "Relay request version, role, or method is invalid");
  }
  assertSafeRelayIdentifier(candidate.requestId, "requestId");
  assertSafeRelayIdentifier(candidate.clientId, "clientId");
  assertSafeRelayIdentifier(candidate.nonce, "nonce");
  if (!Number.isSafeInteger(candidate.issuedAt)) {
    throw new ConcordiaException("INVALID_INPUT", "Relay request issuedAt is invalid");
  }
  return candidate as RelayRequestPayload;
}

export function parseRelayResponse(payload: string): RelayResponsePayload {
  let value: unknown;
  try {
    value = JSON.parse(payload) as unknown;
  } catch {
    throw new ConcordiaException("INTERNAL_ERROR", "Relay response payload is not valid JSON", true);
  }
  if (!value || typeof value !== "object") {
    throw new ConcordiaException("INTERNAL_ERROR", "Relay response payload must be an object", true);
  }
  const candidate = value as Partial<RelayResponsePayload>;
  if (candidate.version !== 1 || typeof candidate.ok !== "boolean" || !Number.isSafeInteger(candidate.issuedAt)) {
    throw new ConcordiaException("INTERNAL_ERROR", "Relay response envelope is invalid", true);
  }
  assertSafeRelayIdentifier(candidate.requestId, "requestId");
  return candidate as RelayResponsePayload;
}

export function validateRedisUrl(value: string | undefined, allowInsecure: boolean): string {
  if (!value) throw new ConcordiaException("INVALID_INPUT", "CONCORDIA_REDIS_URL is required for Redis transport");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConcordiaException("INVALID_INPUT", "CONCORDIA_REDIS_URL must be a valid Redis URL");
  }
  if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") {
    throw new ConcordiaException("INVALID_INPUT", "CONCORDIA_REDIS_URL must use redis:// or rediss://");
  }
  const loopback = parsed.hostname === "localhost" || parsed.hostname === "::1" || parsed.hostname.startsWith("127.");
  if (parsed.protocol !== "rediss:" && !loopback && !allowInsecure) {
    throw new ConcordiaException(
      "INVALID_INPUT",
      "Remote Redis must use TLS (rediss://); set CONCORDIA_RELAY_ALLOW_INSECURE=true only for a trusted development network",
    );
  }
  return value;
}
