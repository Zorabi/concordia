import assert from "node:assert/strict";
import test from "node:test";

import {
  concordiaHome,
  defaultCodexWakerDatabasePath,
  defaultStateDatabasePath,
  defaultZCodeWakerDatabasePath,
} from "../src/paths.js";
import { ConcordiaException } from "../src/protocol.js";

test("local state defaults to one user-level Concordia home", () => {
  assert.equal(concordiaHome(undefined, "/Users/example"), "/Users/example/.concordia");
  assert.equal(defaultStateDatabasePath(undefined, "/Users/example"), "/Users/example/.concordia/state.db");
  assert.equal(defaultCodexWakerDatabasePath(undefined, "/Users/example"), "/Users/example/.concordia/codex-waker.db");
  assert.equal(defaultZCodeWakerDatabasePath(undefined, "/Users/example"), "/Users/example/.concordia/zcode-waker.db");
});

test("CONCORDIA_HOME overrides every local state path", () => {
  assert.equal(defaultStateDatabasePath("/var/lib/concordia", "/ignored"), "/var/lib/concordia/state.db");
  assert.equal(defaultCodexWakerDatabasePath("/var/lib/concordia", "/ignored"), "/var/lib/concordia/codex-waker.db");
  assert.equal(defaultZCodeWakerDatabasePath("/var/lib/concordia", "/ignored"), "/var/lib/concordia/zcode-waker.db");
});

test("CONCORDIA_HOME rejects relative paths", () => {
  assert.throws(
    () => concordiaHome("relative/path", "/Users/example"),
    (error: unknown) => error instanceof ConcordiaException
      && error.code === "INVALID_INPUT"
      && error.message.includes("absolute path"),
  );
});
