import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ConcordiaDatabase } from "../src/database.js";
import { ConcordiaException, type TaskSpec } from "../src/protocol.js";
import { TaskService } from "../src/tasks.js";
import { WorkspaceManager } from "../src/workspace.js";

interface Fixture {
  root: string;
  repository: string;
  databasePath: string;
  database: ConcordiaDatabase;
  service: TaskService;
  close(): void;
  dispose(): void;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createFixture(t: test.TestContext): Fixture {
  const root = mkdtempSync(join(tmpdir(), "concordia-test-"));
  const repository = join(root, "repository");
  mkdirSync(join(repository, "src"), { recursive: true });
  git(root, ["init", "--initial-branch=main", repository]);
  git(repository, ["config", "user.name", "Concordia Test"]);
  git(repository, ["config", "user.email", "concordia-test@example.invalid"]);
  writeFileSync(join(repository, "src", "app.ts"), "export const value = 1;\n");
  writeFileSync(join(repository, "README.md"), "fixture\n");
  git(repository, ["add", "."]);
  git(repository, ["commit", "-m", "initial"]);

  const databasePath = join(root, "state", "concordia.db");
  const database = new ConcordiaDatabase(databasePath);
  const service = new TaskService(database, new WorkspaceManager([repository]));
  let closed = false;
  const close = () => {
    if (closed) return;
    database.close();
    closed = true;
  };
  const dispose = () => {
    close();
    rmSync(root, { recursive: true, force: true });
  };
  t.after(dispose);
  return { root, repository, databasePath, database, service, close, dispose };
}

function spec(repository: string, id: string, ownedPaths = ["src"]): TaskSpec {
  return {
    id,
    objective: `Complete ${id}`,
    workspace: repository,
    ownedPaths,
    constraints: ["Keep changes local"],
    acceptance: ["Tests pass"],
    deliverables: ["commit", "changed_files", "checks", "risks"],
    delegation: { mode: "auto", maxConcurrency: 2, maxDepth: 1 },
    timeoutSeconds: 300,
  };
}

function expectCode(operation: () => unknown, code: ConcordiaException["code"]): void {
  assert.throws(operation, (error: unknown) => error instanceof ConcordiaException && error.code === code);
}

function commitChange(worktree: string, contents: string, message: string, file = "src/app.ts"): string {
  writeFileSync(join(worktree, file), contents);
  git(worktree, ["add", file]);
  git(worktree, ["commit", "-m", message]);
  return git(worktree, ["rev-parse", "HEAD"]);
}

function submit(service: TaskService, taskId: string, leaseToken: string, commit: string, changedFiles = ["src/app.ts"]): void {
  service.submitTask({
    taskId,
    leaseToken,
    commit,
    changedFiles,
    checks: [{ commandId: "test", exitCode: 0, summary: "passed" }],
    risks: [],
    summary: "Implemented and verified",
    idempotencyKey: `${taskId}:submit:${commit}`,
  });
}

test("runs the complete task lifecycle through rework and approval", (t) => {
  const fixture = createFixture(t);
  const taskId = "lifecycle";
  fixture.service.createTask(spec(fixture.repository, taskId), `${taskId}:create`);
  const claim = fixture.service.claimTask({ agentId: "zcode" });
  assert.equal(claim.task?.status, "CLAIMED");
  assert.ok(claim.task?.worktreePath);

  fixture.service.startTask(taskId, `${taskId}:start`, claim.leaseToken!);
  const firstCommit = commitChange(claim.task!.worktreePath!, "export const value = 2;\n", "first implementation");
  submit(fixture.service, taskId, claim.leaseToken!, firstCommit);
  assert.equal(fixture.service.getTask(taskId).status, "REVIEW");

  fixture.service.reviewTask({
    taskId,
    decision: "request_changes",
    findings: [{ path: "src/app.ts", line: 1, severity: "blocking", message: "Handle the edge case" }],
    idempotencyKey: `${taskId}:changes-requested`,
  });
  assert.equal(fixture.service.getTask(taskId).status, "READY");

  const secondClaim = fixture.service.claimTask({ agentId: "zcode" });
  assert.equal(secondClaim.task?.attempt, 2);
  assert.notEqual(secondClaim.leaseToken, claim.leaseToken);
  assert.notEqual(secondClaim.task?.worktreePath, claim.task?.worktreePath);
  fixture.service.startTask(taskId, `${taskId}:restart`, secondClaim.leaseToken!);
  const secondCommit = commitChange(secondClaim.task!.worktreePath!, "export const value = 3;\n", "address review");
  expectCode(() => submit(fixture.service, taskId, claim.leaseToken!, secondCommit), "LEASE_CONFLICT");
  submit(fixture.service, taskId, secondClaim.leaseToken!, secondCommit);
  const approved = fixture.service.reviewTask({
    taskId,
    decision: "approve",
    summary: "Reviewed successfully",
    idempotencyKey: `${taskId}:approve`,
  });
  assert.equal(approved.status, "APPROVED");
  assert.deepEqual(
    approved.events.map((event) => event.type),
    [
      "TASK_CREATED", "TASK_CLAIMED", "PROGRESS", "COMPLETED", "CHANGES_REQUESTED",
      "TASK_CLAIMED", "PROGRESS", "COMPLETED", "APPROVED",
    ],
  );
});

test("only one concurrent claimant receives a ready task", async (t) => {
  const fixture = createFixture(t);
  fixture.service.createTask(spec(fixture.repository, "concurrent"), "concurrent:create");
  const secondDatabase = new ConcordiaDatabase(fixture.databasePath);
  const secondService = new TaskService(secondDatabase, new WorkspaceManager([fixture.repository]));
  t.after(() => secondDatabase.close());
  const claims = await Promise.all([
    Promise.resolve().then(() => fixture.service.claimTask({ agentId: "zcode" })),
    Promise.resolve().then(() => secondService.claimTask({ agentId: "zcode-2" })),
  ]);
  assert.equal(claims.filter((claim) => claim.task !== null).length, 1);
  assert.equal(fixture.service.getTask("concurrent").attempt, 1);
});

test("event idempotency returns the original event without a duplicate write", (t) => {
  const fixture = createFixture(t);
  fixture.service.createTask(spec(fixture.repository, "idempotency"), "idempotency:create");
  const claim = fixture.service.claimTask({ agentId: "zcode" });
  const event = fixture.service.startTask("idempotency", "idempotency:progress", claim.leaseToken!);
  const duplicate = fixture.service.startTask("idempotency", "idempotency:progress", claim.leaseToken!);
  assert.equal(duplicate.eventId, event.eventId);
  assert.equal(fixture.service.getTask("idempotency", 100).events.filter((item) => item.type === "PROGRESS").length, 1);
});

test("an expired lease can be recovered by another worker", (t) => {
  const fixture = createFixture(t);
  fixture.service.createTask(spec(fixture.repository, "lease"), "lease:create");
  fixture.service.claimTask({ agentId: "zcode", leaseSeconds: 1 });
  fixture.database.connection.prepare("UPDATE tasks SET lease_until = ? WHERE id = ?")
    .run(new Date(Date.now() - 1_000).toISOString(), "lease");
  const recovered = fixture.service.claimTask({ agentId: "zcode-2" });
  assert.equal(recovered.task?.assignee, "zcode-2");
  assert.equal(recovered.task?.attempt, 2);
});

test("an outdated optimistic version is rejected", (t) => {
  const fixture = createFixture(t);
  fixture.service.createTask(spec(fixture.repository, "version"), "version:create");
  const claim = fixture.service.claimTask({ agentId: "zcode" });
  expectCode(
    () => fixture.service.sendEvent({
      taskId: "version",
      sender: "zcode",
      recipient: "codex",
      type: "HEARTBEAT",
      payload: { phase: "working" },
      idempotencyKey: "version:stale-heartbeat",
      leaseToken: claim.leaseToken,
      expectedVersion: claim.task!.version - 1,
    }),
    "STALE_VERSION",
  );
});

test("a reopened database retains tasks and event history", (t) => {
  const fixture = createFixture(t);
  fixture.service.createTask(spec(fixture.repository, "reopen"), "reopen:create");
  const claim = fixture.service.claimTask({ agentId: "zcode" });
  fixture.service.startTask("reopen", "reopen:start", claim.leaseToken!);
  fixture.close();

  const reopened = new ConcordiaDatabase(fixture.databasePath);
  try {
    const service = new TaskService(reopened, new WorkspaceManager([fixture.repository]));
    const task = service.getTask("reopen", 100);
    assert.equal(task.status, "RUNNING");
    assert.deepEqual(task.events.map((event) => event.type), ["TASK_CREATED", "TASK_CLAIMED", "PROGRESS"]);
  } finally {
    reopened.close();
  }
});

test("task path scopes reject workspace escape attempts", (t) => {
  const fixture = createFixture(t);
  expectCode(
    () => fixture.service.createTask(spec(fixture.repository, "escape", ["../outside"]), "escape:create"),
    "PATH_SCOPE_VIOLATION",
  );
});

test("submission rejects changes outside ownedPaths", (t) => {
  const fixture = createFixture(t);
  const taskId = "scope";
  fixture.service.createTask(spec(fixture.repository, taskId, ["src"]), `${taskId}:create`);
  const claim = fixture.service.claimTask({ agentId: "zcode" });
  fixture.service.startTask(taskId, `${taskId}:start`, claim.leaseToken!);
  const commit = commitChange(claim.task!.worktreePath!, "out of scope\n", "modify readme", "README.md");
  expectCode(() => submit(fixture.service, taskId, claim.leaseToken!, commit, ["README.md"]), "PATH_SCOPE_VIOLATION");
});

test("wait_events yields a new event and returns an empty result on normal timeout", async (t) => {
  const fixture = createFixture(t);
  const taskId = "watch";
  fixture.service.createTask(spec(fixture.repository, taskId), `${taskId}:create`);
  const claim = fixture.service.claimTask({ agentId: "zcode" });
  const cursor = claim.eventId!;
  const waiting = fixture.service.waitEvents({ taskId, afterEventId: cursor, timeoutMs: 500 });
  setTimeout(() => fixture.service.startTask(taskId, `${taskId}:start`, claim.leaseToken!), 20);
  const events = await waiting;
  assert.deepEqual(events.map((event) => event.type), ["PROGRESS"]);

  const latestEventId = events.at(-1)!.eventId;
  const startedAt = Date.now();
  const timeout = await fixture.service.waitEvents({ taskId, afterEventId: latestEventId, timeoutMs: 20 });
  assert.deepEqual(timeout, []);
  assert.ok(Date.now() - startedAt >= 15);
});

test("a symlinked worktree directory cannot escape the repository", (t) => {
  const fixture = createFixture(t);
  const outside = join(fixture.root, "outside-worktrees");
  mkdirSync(outside);
  symlinkSync(outside, join(fixture.repository, ".worktrees"));
  fixture.service.createTask(spec(fixture.repository, "symlink-worktree"), "symlink-worktree:create");
  expectCode(() => fixture.service.claimTask({ agentId: "zcode" }), "WORKSPACE_DENIED");
});

test("worktree branch recovery rejects history unrelated to baseCommit", (t) => {
  const fixture = createFixture(t);
  const taskId = "branch-fallback";
  fixture.service.createTask(spec(fixture.repository, taskId), `${taskId}:create`);
  const tree = git(fixture.repository, ["rev-parse", "HEAD^{tree}"]);
  const unrelated = execFileSync("git", ["commit-tree", tree], {
    cwd: fixture.repository,
    encoding: "utf8",
    input: "unrelated root\n",
  }).trim();
  git(fixture.repository, ["branch", `concordia/${taskId}-zcode-a1`, unrelated]);
  expectCode(() => fixture.service.claimTask({ agentId: "zcode" }), "BASE_COMMIT_MISMATCH");
});

test("submission rejects an out-of-scope file touched and reverted in intermediate commits", (t) => {
  const fixture = createFixture(t);
  const taskId = "history-scope";
  fixture.service.createTask(spec(fixture.repository, taskId, ["src"]), `${taskId}:create`);
  const claim = fixture.service.claimTask({ agentId: "zcode" });
  fixture.service.startTask(taskId, `${taskId}:start`, claim.leaseToken!);
  commitChange(claim.task!.worktreePath!, "temporary out-of-scope edit\n", "touch readme", "README.md");
  commitChange(claim.task!.worktreePath!, "fixture\n", "restore readme", "README.md");
  const finalCommit = commitChange(claim.task!.worktreePath!, "export const value = 2;\n", "valid change");
  expectCode(
    () => submit(fixture.service, taskId, claim.leaseToken!, finalCommit, ["src/app.ts"]),
    "PATH_SCOPE_VIOLATION",
  );
});

test("path scopes reject ambiguous backslash names", (t) => {
  const fixture = createFixture(t);
  expectCode(
    () => fixture.service.createTask(spec(fixture.repository, "backslash", ["src\\app.ts"]), "backslash:create"),
    "PATH_SCOPE_VIOLATION",
  );
});

test("lease fencing rejects a previous claimant after recovery", (t) => {
  const fixture = createFixture(t);
  const taskId = "fencing";
  fixture.service.createTask(spec(fixture.repository, taskId), `${taskId}:create`);
  const first = fixture.service.claimTask({ agentId: "zcode", leaseSeconds: 1 });
  fixture.database.connection.prepare("UPDATE tasks SET lease_until = ? WHERE id = ?")
    .run(new Date(Date.now() - 1_000).toISOString(), taskId);
  const second = fixture.service.claimTask({ agentId: "zcode-2" });
  assert.notEqual(second.leaseToken, first.leaseToken);
  assert.notEqual(second.task?.worktreePath, first.task?.worktreePath);

  const oldCommit = commitChange(first.task!.worktreePath!, "export const value = 99;\n", "stale worker change");
  assert.equal(git(first.task!.worktreePath!, ["show", `${oldCommit}:src/app.ts`]), "export const value = 99;");
  assert.equal(git(second.task!.worktreePath!, ["show", "HEAD:src/app.ts"]), "export const value = 1;");

  expectCode(() => fixture.service.sendEvent({
    taskId,
    sender: "zcode",
    recipient: "codex",
    type: "HEARTBEAT",
    payload: { phase: "stale" },
    idempotencyKey: `${taskId}:stale-heartbeat`,
    leaseToken: first.leaseToken,
  }), "LEASE_CONFLICT");

  fixture.service.startTask(taskId, `${taskId}:restart`, second.leaseToken!);
  expectCode(
    () => submit(fixture.service, taskId, second.leaseToken!, oldCommit),
    "INVALID_INPUT",
  );
  const commit = commitChange(second.task!.worktreePath!, "export const value = 2;\n", "fenced change");
  assert.equal(git(second.task!.worktreePath!, ["show", `${commit}:src/app.ts`]), "export const value = 2;");
  expectCode(() => submit(fixture.service, taskId, first.leaseToken!, commit), "LEASE_CONFLICT");
  submit(fixture.service, taskId, second.leaseToken!, commit);
});

test("a new attempt snapshots the previous worktree HEAD into an isolated worktree", (t) => {
  const fixture = createFixture(t);
  const taskId = "attempt-snapshot";
  fixture.service.createTask(spec(fixture.repository, taskId), `${taskId}:create`);
  const first = fixture.service.claimTask({ agentId: "zcode" });
  fixture.service.startTask(taskId, `${taskId}:start`, first.leaseToken!);
  const previousHead = commitChange(first.task!.worktreePath!, "export const value = 7;\n", "recoverable progress");
  fixture.database.connection.prepare("UPDATE tasks SET lease_until = ? WHERE id = ?")
    .run(new Date(Date.now() - 1_000).toISOString(), taskId);

  const second = fixture.service.claimTask({ agentId: "zcode-2" });
  assert.notEqual(second.task!.worktreePath, first.task!.worktreePath);
  assert.equal(git(second.task!.worktreePath!, ["rev-parse", "HEAD"]), previousHead);
  assert.equal(git(second.task!.worktreePath!, ["show", "HEAD:src/app.ts"]), "export const value = 7;");
});

test("a claim recovers a worktree created before its attempt transaction committed", (t) => {
  const fixture = createFixture(t);
  const taskId = "attempt-crash";
  fixture.service.createTask(spec(fixture.repository, taskId), `${taskId}:create`);
  const task = fixture.service.getTask(taskId);
  const orphaned = fixture.service.workspace.ensureWorktree(taskId, task.workspace, task.baseCommit!, 1);

  const claimed = fixture.service.claimTask({ agentId: "zcode" });
  assert.equal(claimed.task?.attempt, 1);
  assert.equal(claimed.task?.worktreePath, orphaned.worktreePath);
});

test("recovering an expired WAITING_INPUT task preserves the question state", (t) => {
  const fixture = createFixture(t);
  const taskId = "waiting-recovery";
  fixture.service.createTask(spec(fixture.repository, taskId), `${taskId}:create`);
  const first = fixture.service.claimTask({ agentId: "zcode" });
  fixture.service.startTask(taskId, `${taskId}:start`, first.leaseToken!);
  fixture.service.sendEvent({
    taskId,
    sender: "zcode",
    recipient: "codex",
    type: "QUESTION",
    payload: { question: "Which behavior?" },
    idempotencyKey: `${taskId}:question`,
    leaseToken: first.leaseToken,
  });
  fixture.database.connection.prepare("UPDATE tasks SET lease_until = ? WHERE id = ?")
    .run(new Date(Date.now() - 1_000).toISOString(), taskId);
  const recovered = fixture.service.claimTask({ agentId: "zcode-2" });
  assert.equal(recovered.task?.status, "WAITING_INPUT");
  fixture.service.sendEvent({
    taskId,
    sender: "codex",
    recipient: "zcode",
    type: "ANSWER",
    payload: { answer: "Use the documented behavior" },
    idempotencyKey: `${taskId}:answer`,
  });
  assert.equal(fixture.service.getTask(taskId).status, "RUNNING");
});

test("submit and review idempotency keys reject changed payloads", (t) => {
  const fixture = createFixture(t);
  const taskId = "idempotent-payload";
  fixture.service.createTask(spec(fixture.repository, taskId), `${taskId}:create`);
  const claim = fixture.service.claimTask({ agentId: "zcode" });
  fixture.service.startTask(taskId, `${taskId}:start`, claim.leaseToken!);
  const commit = commitChange(claim.task!.worktreePath!, "export const value = 2;\n", "implementation");
  const submission = {
    taskId,
    leaseToken: claim.leaseToken!,
    commit,
    changedFiles: ["src/app.ts"],
    checks: [{ commandId: "test", exitCode: 0, summary: "passed" }],
    risks: [] as string[],
    summary: "original",
    idempotencyKey: `${taskId}:submit`,
  };
  fixture.service.submitTask(submission);
  expectCode(() => fixture.service.submitTask({ ...submission, summary: "changed" }), "INVALID_INPUT");
  const review = {
    taskId,
    decision: "approve" as const,
    summary: "original review",
    idempotencyKey: `${taskId}:review`,
  };
  fixture.service.reviewTask(review);
  expectCode(() => fixture.service.reviewTask({ ...review, summary: "changed review" }), "INVALID_INPUT");
});

test("multiple processes can initialize the same new database concurrently", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "concordia-db-race-"));
  const databasePath = join(root, "state", "concordia.db");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const databaseModule = new URL("../src/database.js", import.meta.url).href;
  const startAt = Date.now() + 300;
  const childScript = `
    const delay = Number(process.env.CONCORDIA_TEST_START_AT) - Date.now();
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    const { ConcordiaDatabase } = await import(process.env.CONCORDIA_TEST_DATABASE_MODULE);
    const database = new ConcordiaDatabase(process.env.CONCORDIA_TEST_DATABASE_PATH);
    database.close();
  `;
  const children = Array.from({ length: 12 }, () => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", childScript], {
      env: {
        ...process.env,
        CONCORDIA_TEST_START_AT: String(startAt),
        CONCORDIA_TEST_DATABASE_MODULE: databaseModule,
        CONCORDIA_TEST_DATABASE_PATH: databasePath,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`database initializer exited ${code}: ${stderr}`));
    });
  }));
  await Promise.all(children);

  const database = new ConcordiaDatabase(databasePath);
  try {
    const version = database.connection.prepare("PRAGMA user_version").get() as { user_version: number };
    const columns = database.connection.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    assert.equal(version.user_version, 2);
    assert.equal(columns.filter((column) => column.name === "lease_token").length, 1);
  } finally {
    database.close();
  }
});
