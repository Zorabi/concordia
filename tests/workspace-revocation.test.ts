import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ConcordiaDatabase } from "../src/database.js";
import { ConcordiaException, type TaskSpec } from "../src/protocol.js";
import { TaskService } from "../src/tasks.js";
import { WorkspaceManager } from "../src/workspace.js";

interface Fixture {
  root: string;
  revokedRepository: string;
  allowedRepository: string;
  configFile: string;
  database: ConcordiaDatabase;
  service: TaskService;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createRepository(parent: string, name: string): string {
  const repository = join(parent, name);
  mkdirSync(join(repository, "src"), { recursive: true });
  git(parent, ["init", "--initial-branch=main", repository]);
  git(repository, ["config", "user.name", "Concordia Test"]);
  git(repository, ["config", "user.email", "concordia-test@example.invalid"]);
  writeFileSync(join(repository, "src", "app.ts"), "export const value = 1;\n");
  git(repository, ["add", "."]);
  git(repository, ["commit", "-m", "initial"]);
  return repository;
}

function writeConfig(path: string, allowedRoots: readonly string[]): void {
  writeFileSync(path, JSON.stringify({ version: 1, allowedRoots }));
}

function createFixture(t: test.TestContext): Fixture {
  const root = mkdtempSync(join(tmpdir(), "concordia-revocation-"));
  const revokedRepository = createRepository(root, "revoked");
  const allowedRepository = createRepository(root, "allowed");
  const configFile = join(root, "concordia.json");
  writeConfig(configFile, [revokedRepository, allowedRepository]);
  const previousConfigFile = process.env.CONCORDIA_CONFIG_FILE;
  const previousGrace = process.env.CONCORDIA_CONFIG_STALE_GRACE_MS;
  process.env.CONCORDIA_CONFIG_FILE = configFile;
  process.env.CONCORDIA_CONFIG_STALE_GRACE_MS = "0";
  let manager: WorkspaceManager;
  try {
    manager = new WorkspaceManager();
  } finally {
    if (previousConfigFile === undefined) delete process.env.CONCORDIA_CONFIG_FILE;
    else process.env.CONCORDIA_CONFIG_FILE = previousConfigFile;
    if (previousGrace === undefined) delete process.env.CONCORDIA_CONFIG_STALE_GRACE_MS;
    else process.env.CONCORDIA_CONFIG_STALE_GRACE_MS = previousGrace;
  }
  const database = new ConcordiaDatabase(join(root, "state", "concordia.db"));
  const service = new TaskService(database, manager);
  t.after(() => {
    database.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, revokedRepository, allowedRepository, configFile, database, service };
}

function spec(repository: string, id: string): TaskSpec {
  return {
    id,
    objective: `Complete ${id}`,
    workspace: repository,
    ownedPaths: ["src"],
    constraints: ["Keep changes local"],
    acceptance: ["Tests pass"],
    deliverables: ["commit", "changed_files", "checks", "risks"],
    delegation: { mode: "auto", maxConcurrency: 1, maxDepth: 1 },
    timeoutSeconds: 300,
  };
}

function expectDenied(operation: () => unknown): void {
  assert.throws(
    operation,
    (error: unknown) => error instanceof ConcordiaException && error.code === "WORKSPACE_DENIED",
  );
}

function revoke(fixture: Fixture): void {
  writeConfig(fixture.configFile, [fixture.allowedRepository]);
}

test("revoking a root denies direct task access and every task mutation path", (t) => {
  const fixture = createFixture(t);
  const taskId = "revoked-direct";
  fixture.service.createTask(spec(fixture.revokedRepository, taskId), `${taskId}:create`);
  const claim = fixture.service.claimTask({ agentId: "zcode", taskId });
  fixture.service.startTask(taskId, `${taskId}:start`, claim.leaseToken!);
  revoke(fixture);

  expectDenied(() => fixture.service.getTask(taskId));
  expectDenied(() => fixture.service.claimTask({ agentId: "zcode", taskId }));
  expectDenied(() => fixture.service.sendEvent({
    taskId,
    sender: "zcode",
    recipient: "codex",
    type: "HEARTBEAT",
    payload: { phase: "working" },
    idempotencyKey: `${taskId}:heartbeat`,
    leaseToken: claim.leaseToken,
  }));
  expectDenied(() => fixture.service.submitTask({
    taskId,
    leaseToken: claim.leaseToken!,
    commit: "not-inspected-after-revocation",
    changedFiles: [],
    checks: [],
    risks: [],
    summary: "must be denied",
    idempotencyKey: `${taskId}:submit`,
  }));

  fixture.database.connection.prepare("UPDATE tasks SET status = 'REVIEW' WHERE id = ?").run(taskId);
  expectDenied(() => fixture.service.reviewTask({
    taskId,
    decision: "approve",
    summary: "must be denied",
    idempotencyKey: `${taskId}:review`,
  }));
});

test("idempotent retries cannot disclose a task after its root is revoked", (t) => {
  const fixture = createFixture(t);
  const taskId = "revoked-duplicates";
  const createInput = spec(fixture.revokedRepository, taskId);
  fixture.service.createTask(createInput, `${taskId}:create`);
  const claim = fixture.service.claimTask({ agentId: "zcode", taskId });
  fixture.service.startTask(taskId, `${taskId}:start`, claim.leaseToken!);
  revoke(fixture);

  expectDenied(() => fixture.service.createTask(createInput, `${taskId}:create`));
  expectDenied(() => fixture.service.startTask(taskId, `${taskId}:start`, claim.leaseToken!));
});

test("unfiltered list and claim skip revoked tasks without starving allowed tasks", (t) => {
  const fixture = createFixture(t);
  fixture.service.createTask(spec(fixture.revokedRepository, "revoked-first"), "revoked-first:create");
  fixture.service.createTask(spec(fixture.allowedRepository, "allowed-second"), "allowed-second:create");
  fixture.database.connection.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?")
    .run("2099-01-01T00:00:00.000Z", "revoked-first");
  revoke(fixture);

  assert.deepEqual(fixture.service.listTasks({ limit: 1 }).map((task) => task.id), ["allowed-second"]);
  expectDenied(() => fixture.service.listTasks({ workspace: fixture.revokedRepository }));

  const claim = fixture.service.claimTask({ agentId: "zcode" });
  assert.equal(claim.task?.id, "allowed-second");
  assert.equal(
    fixture.database.connection.prepare("SELECT status FROM tasks WHERE id = ?").get("revoked-first")?.status,
    "READY",
  );
});

test("unfiltered waits skip revoked events and still deliver later allowed events", async (t) => {
  const fixture = createFixture(t);
  fixture.service.createTask(spec(fixture.revokedRepository, "revoked-event"), "revoked-event:create");
  for (let index = 0; index < 105; index += 1) {
    fixture.service.events.appendEvent({
      taskId: "revoked-event",
      sender: "codex",
      recipient: "zcode",
      type: "TASK_CREATED",
      payload: { index },
      idempotencyKey: `revoked-event:extra:${index}`,
    });
  }
  fixture.service.createTask(spec(fixture.allowedRepository, "allowed-event"), "allowed-event:create");
  revoke(fixture);

  const events = await fixture.service.waitEvents({
    recipient: "zcode",
    afterEventId: 0,
    timeoutMs: 0,
    limit: 1,
  });
  assert.deepEqual(events.map((event) => event.taskId), ["allowed-event"]);
  await assert.rejects(
    fixture.service.waitEvents({ taskId: "revoked-event", afterEventId: 0, timeoutMs: 0 }),
    (error: unknown) => error instanceof ConcordiaException && error.code === "WORKSPACE_DENIED",
  );
});

test("an active targeted wait notices workspace revocation", async (t) => {
  const fixture = createFixture(t);
  fixture.service.createTask(spec(fixture.revokedRepository, "revoked-during-wait"), "revoked-during-wait:create");

  const waiting = fixture.service.waitEvents({
    taskId: "revoked-during-wait",
    afterEventId: 1,
    timeoutMs: 1_000,
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  revoke(fixture);

  await assert.rejects(
    waiting,
    (error: unknown) => error instanceof ConcordiaException && error.code === "WORKSPACE_DENIED",
  );
});
