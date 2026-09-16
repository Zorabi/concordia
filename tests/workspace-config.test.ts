import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ConcordiaException } from "../src/protocol.js";
import { WorkspaceManager } from "../src/workspace.js";
import { WorkspaceRootsConfig } from "../src/workspace-config.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createRepository(parent: string, name: string): string {
  const repository = join(parent, name);
  git(parent, ["init", "--initial-branch=main", repository]);
  git(repository, ["config", "user.name", "Concordia Test"]);
  git(repository, ["config", "user.email", "concordia-test@example.invalid"]);
  writeFileSync(join(repository, "README.md"), `${name}\n`);
  git(repository, ["add", "."]);
  git(repository, ["commit", "-m", "initial"]);
  return repository;
}

function writeConfig(path: string, allowedRoots: readonly string[]): void {
  writeFileSync(path, JSON.stringify({ version: 1, allowedRoots }));
}

function expectDenied(operation: () => unknown): void {
  assert.throws(
    operation,
    (error: unknown) => error instanceof ConcordiaException && error.code === "WORKSPACE_DENIED",
  );
}

test("shared config hot-adds and removes workspace roots", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "concordia-workspace-config-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const first = createRepository(directory, "first");
  const second = createRepository(directory, "second");
  const configFile = join(directory, "concordia.json");
  writeConfig(configFile, [first]);

  const manager = WorkspaceRootsEnvironment.with({ CONCORDIA_CONFIG_FILE: configFile }, () => new WorkspaceManager());
  assert.equal(manager.resolveWorkspace(first), realpathSync(first));
  expectDenied(() => manager.resolveWorkspace(second));

  writeConfig(configFile, [first, second]);
  assert.equal(manager.resolveWorkspace(second), realpathSync(second));

  writeConfig(configFile, [second]);
  expectDenied(() => manager.resolveWorkspace(first));
  assert.equal(manager.resolveWorkspace(second), realpathSync(second));
});

test("invalid config updates preserve the last-known-good roots", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "concordia-workspace-config-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const first = createRepository(directory, "first");
  const second = createRepository(directory, "second");
  const configFile = join(directory, "concordia.json");
  writeConfig(configFile, [first]);

  const manager = WorkspaceRootsEnvironment.with({ CONCORDIA_CONFIG_FILE: configFile }, () => new WorkspaceManager());
  const logs = captureStderr(() => {
    writeFileSync(configFile, '{"version":1,"allowedRoots":[');
    assert.equal(manager.resolveWorkspace(first), realpathSync(first));
    expectDenied(() => manager.resolveWorkspace(second));

    writeConfig(configFile, [second]);
    assert.equal(manager.resolveWorkspace(second), realpathSync(second));
    expectDenied(() => manager.resolveWorkspace(first));

    writeFileSync(configFile, '{"version":1,"allowedRoots":[');
    assert.equal(manager.resolveWorkspace(second), realpathSync(second));
  });
  assert.deepEqual(logs.map((entry) => entry.event), [
    "workspace_config.reload_failed",
    "workspace_config.reloaded",
    "workspace_config.reload_failed",
  ]);
  assert.equal(logs[0]?.level, "error");
  assert.equal(logs[1]?.level, "info");
  assert.ok(logs.every((entry) => !JSON.stringify(entry).includes(first)));
  assert.ok(logs.every((entry) => !JSON.stringify(entry).includes(second)));
  assert.ok(logs.every((entry) => !JSON.stringify(entry).includes("allowedRoots")));
});

test("reload failures fail closed after the stale grace period and recover", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "concordia-workspace-config-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repository = createRepository(directory, "repository");
  const configFile = join(directory, "concordia.json");
  writeConfig(configFile, [repository]);

  const manager = WorkspaceRootsEnvironment.with(
    { CONCORDIA_CONFIG_FILE: configFile, CONCORDIA_CONFIG_STALE_GRACE_MS: "0" },
    () => new WorkspaceManager(),
  );
  const firstFailure = captureStderr(() => {
    writeFileSync(configFile, "{");
    assert.throws(
      () => manager.assertWorkspaceAllowed(repository),
      (error: unknown) => error instanceof ConcordiaException && error.code === "INVALID_INPUT",
    );
    assert.throws(
      () => manager.assertWorkspaceAllowed(repository),
      (error: unknown) => error instanceof ConcordiaException && error.code === "INVALID_INPUT",
    );
  });
  assert.deepEqual(firstFailure.map((entry) => entry.event), ["workspace_config.reload_failed"]);

  writeConfig(configFile, [repository]);
  const recovery = captureStderr(() => {
    assert.equal(manager.assertWorkspaceAllowed(repository), realpathSync(repository));
  });
  assert.deepEqual(recovery.map((entry) => entry.event), ["workspace_config.reloaded"]);

  const secondFailure = captureStderr(() => {
    writeFileSync(configFile, "{");
    assert.throws(
      () => manager.assertWorkspaceAllowed(repository),
      (error: unknown) => error instanceof ConcordiaException && error.code === "INVALID_INPUT",
    );
  });
  assert.deepEqual(secondFailure.map((entry) => entry.event), ["workspace_config.reload_failed"]);
});

test("stale grace is measured with a monotonic clock from the last successful load", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "concordia-workspace-config-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repository = createRepository(directory, "repository");
  const configFile = join(directory, "concordia.json");
  writeConfig(configFile, [repository]);

  let monotonicNow = 10_000;
  const roots = WorkspaceRootsConfig.fromFile(configFile, 5_000, () => monotonicNow);
  writeFileSync(configFile, "{");
  const logs = captureStderr(() => {
    monotonicNow = 15_001;
    assert.throws(
      () => roots.getAllowedRoots(),
      (error: unknown) => error instanceof ConcordiaException && error.code === "INVALID_INPUT",
    );
  });
  assert.deepEqual(logs.map((entry) => entry.event), ["workspace_config.reload_failed"]);
});

test("invalid config fails clearly on first load", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "concordia-workspace-config-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const configFile = join(directory, "concordia.json");
  writeFileSync(configFile, "{");

  assert.throws(
    () => WorkspaceRootsEnvironment.with({ CONCORDIA_CONFIG_FILE: configFile }, () => new WorkspaceManager()),
    (error: unknown) => error instanceof ConcordiaException
      && error.code === "INVALID_INPUT"
      && error.message.includes("CONCORDIA_CONFIG_FILE"),
  );
});

test("CONCORDIA_CONFIG_FILE must be a non-empty absolute path", () => {
  for (const configFile of ["", "relative/concordia.json"]) {
    assert.throws(
      () => WorkspaceRootsEnvironment.with({ CONCORDIA_CONFIG_FILE: configFile }, () => new WorkspaceManager()),
      (error: unknown) => error instanceof ConcordiaException
        && error.code === "INVALID_INPUT"
        && error.message.includes("non-empty absolute path"),
    );
  }
});

test("CONCORDIA_CONFIG_STALE_GRACE_MS must be an integer from 0 through 60000", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "concordia-workspace-config-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repository = createRepository(directory, "repository");
  const configFile = join(directory, "concordia.json");
  writeConfig(configFile, [repository]);

  for (const grace of ["-1", "1.5", "60001", "invalid"]) {
    assert.throws(
      () => WorkspaceRootsEnvironment.with(
        { CONCORDIA_CONFIG_FILE: configFile, CONCORDIA_CONFIG_STALE_GRACE_MS: grace },
        () => new WorkspaceManager(),
      ),
      (error: unknown) => error instanceof ConcordiaException
        && error.code === "INVALID_INPUT"
        && error.message.includes("CONCORDIA_CONFIG_STALE_GRACE_MS"),
    );
  }
});

test("assertWorkspaceAllowed checks roots without requiring a Git repository", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "concordia-workspace-config-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const plainDirectory = join(directory, "plain-directory");
  const outside = mkdtempSync(join(tmpdir(), "concordia-workspace-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  mkdirSync(plainDirectory);

  const manager = new WorkspaceManager([directory]);
  assert.equal(manager.assertWorkspaceAllowed(plainDirectory), realpathSync(plainDirectory));
  expectDenied(() => manager.assertWorkspaceAllowed(outside));
  expectDenied(() => manager.resolveWorkspace(plainDirectory));
});

test("CONCORDIA_ROOTS remains the fallback when no config file is set", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "concordia-workspace-config-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repository = createRepository(directory, "fallback");

  const manager = WorkspaceRootsEnvironment.with(
    { CONCORDIA_CONFIG_FILE: undefined, CONCORDIA_ROOTS: repository },
    () => new WorkspaceManager(),
  );
  assert.equal(manager.resolveWorkspace(repository), realpathSync(repository));
});

test("local mode accepts any accessible Git root when no roots restriction is configured", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "concordia-workspace-unrestricted-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const first = createRepository(directory, "first");
  const second = createRepository(directory, "second");

  const manager = WorkspaceRootsEnvironment.with(
    { CONCORDIA_CONFIG_FILE: undefined, CONCORDIA_ROOTS: undefined },
    () => new WorkspaceManager(),
  );

  assert.deepEqual(manager.allowedRoots, []);
  assert.equal(manager.resolveWorkspace(first), realpathSync(first));
  assert.equal(manager.resolveWorkspace(second), realpathSync(second));
});

test("shared config takes precedence over CONCORDIA_ROOTS", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "concordia-workspace-config-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const configured = createRepository(directory, "configured");
  const fallback = createRepository(directory, "fallback");
  const configFile = join(directory, "concordia.json");
  writeConfig(configFile, [configured]);

  const manager = WorkspaceRootsEnvironment.with(
    { CONCORDIA_CONFIG_FILE: configFile, CONCORDIA_ROOTS: fallback },
    () => new WorkspaceManager(),
  );
  assert.equal(manager.resolveWorkspace(configured), realpathSync(configured));
  expectDenied(() => manager.resolveWorkspace(fallback));
});

class WorkspaceRootsEnvironment {
  static with<T>(
    values: Partial<Record<
      "CONCORDIA_CONFIG_FILE" | "CONCORDIA_CONFIG_STALE_GRACE_MS" | "CONCORDIA_ROOTS",
      string | undefined
    >>,
    operation: () => T,
  ): T {
    const previous = new Map<string, string | undefined>();
    for (const [name, value] of Object.entries(values)) {
      previous.set(name, process.env[name]);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    try {
      return operation();
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }
}

interface StructuredLog {
  level?: unknown;
  event?: unknown;
  [key: string]: unknown;
}

function captureStderr(operation: () => void): StructuredLog[] {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...values: unknown[]) => { lines.push(values.map(String).join(" ")); };
  try {
    operation();
  } finally {
    console.error = original;
  }
  return lines.map((line) => JSON.parse(line) as StructuredLog);
}
