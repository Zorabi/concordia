import assert from "node:assert/strict";
import test from "node:test";

import type { ConcordiaService } from "../src/index.js";
import { ConcordiaException } from "../src/protocol.js";
import {
  dispatchRelayRequest,
  startRelayCoordinator,
} from "../src/relay.js";
import { RedisRelayService } from "../src/relay-client.js";
import {
  assertFreshRelayTimestamp,
  encodeSignedRelayMessage,
  parseRelayRequest,
  validateRedisUrl,
  verifyRelaySignature,
  type RelayRequestPayload,
} from "../src/relay-protocol.js";

const TOKEN = "a".repeat(64);

function request(role: "codex" | "zcode", method: RelayRequestPayload["method"], params: unknown): RelayRequestPayload {
  return {
    version: 1,
    requestId: "request_123456789",
    clientId: "client_1234567890",
    role,
    method,
    params,
    issuedAt: Date.now(),
    nonce: "nonce_12345678901",
  };
}

test("relay envelopes are signed and reject tampering", () => {
  const encoded = encodeSignedRelayMessage(request("codex", "list_tasks", {}), TOKEN);
  assert.equal(verifyRelaySignature(encoded.payload, encoded.signature, TOKEN), true);
  assert.equal(verifyRelaySignature(`${encoded.payload} `, encoded.signature, TOKEN), false);
  assert.equal(verifyRelaySignature(encoded.payload, encoded.signature, "b".repeat(64)), false);
  assert.equal(parseRelayRequest(encoded.payload).role, "codex");
});

test("remote Redis requires TLS unless explicitly allowed", () => {
  assert.equal(validateRedisUrl("rediss://redis.example.com:6379", false), "rediss://redis.example.com:6379");
  assert.equal(validateRedisUrl("redis://127.0.0.1:6379", false), "redis://127.0.0.1:6379");
  assert.throws(
    () => validateRedisUrl("redis://redis.example.com:6379", false),
    (error: unknown) => error instanceof ConcordiaException && error.code === "INVALID_INPUT",
  );
  assert.equal(validateRedisUrl("redis://redis.example.com:6379", true), "redis://redis.example.com:6379");
});

test("relay timestamps reject expired or future messages", () => {
  const now = Date.now();
  assert.doesNotThrow(() => assertFreshRelayTimestamp(now - 999, now, 1_000));
  assert.throws(() => assertFreshRelayTimestamp(now - 1_001, now, 1_000));
  assert.throws(() => assertFreshRelayTimestamp(now + 1_001, now, 1_000));
});

test("coordinator enforces authenticated role before dispatch", async () => {
  let called = false;
  const service = new Proxy({}, {
    get: () => () => {
      called = true;
      return {};
    },
  }) as ConcordiaService;

  await assert.rejects(
    dispatchRelayRequest(service, "zcode", "create_task", { spec: {}, idempotencyKey: "key" }),
    (error: unknown) => error instanceof ConcordiaException && error.code === "INVALID_INPUT",
  );
  await assert.rejects(
    dispatchRelayRequest(service, "codex", "send_event", { sender: "zcode" }),
    (error: unknown) => error instanceof ConcordiaException && error.code === "INVALID_INPUT",
  );
  assert.equal(called, false);
});

test("coordinator dispatch maps relay params to the service API", async () => {
  const calls: unknown[] = [];
  const service = {
    listTasks(input: unknown) {
      calls.push(input);
      return [];
    },
  } as unknown as ConcordiaService;
  const result = await dispatchRelayRequest(service, "codex", "list_tasks", { limit: 5 });
  assert.deepEqual(result, []);
  assert.deepEqual(calls, [{ limit: 5 }]);
});

test("Redis client and coordinator complete a live round trip", {
  skip: process.env.CONCORDIA_TEST_REDIS_URL ? false : "set CONCORDIA_TEST_REDIS_URL to run",
}, async () => {
  const service = {
    listTasks() {
      return [];
    },
  } as unknown as ConcordiaService;
  const namespace = `concordia-test-${Date.now()}`;
  const coordinator = await startRelayCoordinator({
    redisUrl: process.env.CONCORDIA_TEST_REDIS_URL!,
    codexToken: TOKEN,
    zcodeToken: "b".repeat(64),
    namespace,
    allowInsecure: true,
    service,
  });
  const client = new RedisRelayService({
    role: "codex",
    redisUrl: process.env.CONCORDIA_TEST_REDIS_URL!,
    token: TOKEN,
    namespace,
    requestTimeoutMs: 5_000,
    allowInsecure: true,
  });
  try {
    assert.deepEqual(await client.listTasks({ limit: 5 }), []);
  } finally {
    await client.close();
    await coordinator.close();
  }
});
