import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { ZCodeCliClient } from "../src/zcode-cli.js";

function fakeZCode(t: TestContext, source: string): string {
  const directory = mkdtempSync(join(tmpdir(), "concordia-zcode-cli-"));
  const executable = join(directory, "fake-zcode");
  writeFileSync(executable, `#!/usr/bin/env node\n${source}\n`);
  chmodSync(executable, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return executable;
}

function argvReporter(t: TestContext): string {
  return fakeZCode(t, `
const args = process.argv.slice(2);
process.stdout.write(JSON.stringify({
  type: "result",
  sessionId: args.includes("--resume") ? args[args.indexOf("--resume") + 1] : "sess_new",
  turnId: "turn_1",
  response: JSON.stringify(args),
}));
`);
}

test("ZCode CLI starts a headless terminal turn without choosing agent tools", async (t) => {
  const client = new ZCodeCliClient({ command: argvReporter(t) });
  const result = await client.runTurn(process.cwd(), "Review the task");
  const args = JSON.parse(result.response) as string[];

  assert.equal(result.sessionId, "sess_new");
  assert.equal(result.turnId, "turn_1");
  assert.deepEqual(args.slice(0, 4), ["--prompt", "Review the task", "--cwd", process.cwd()]);
  assert.ok(args.includes("--json"));
  assert.deepEqual(args.slice(args.indexOf("--surface"), args.indexOf("--surface") + 2), [
    "--surface",
    "terminal",
  ]);
  assert.deepEqual(args.slice(args.indexOf("--mode"), args.indexOf("--mode") + 2), [
    "--mode",
    "build",
  ]);
  assert.equal(args.includes("--disallowed-tools"), false);
  assert.equal(args.includes("--allowed-tools"), false);
  assert.equal(args.includes("--browser-use"), false);
});

test("ZCode CLI resumes a session with configured turn limits", async (t) => {
  const client = new ZCodeCliClient({
    command: argvReporter(t),
    mode: "plan",
    maxTurns: 7,
  });
  const result = await client.runTurn(process.cwd(), "Continue", "sess_existing-1");
  const args = JSON.parse(result.response) as string[];

  assert.equal(result.sessionId, "sess_existing-1");
  assert.deepEqual(args.slice(args.indexOf("--resume"), args.indexOf("--resume") + 2), [
    "--resume",
    "sess_existing-1",
  ]);
  assert.deepEqual(args.slice(args.indexOf("--max-turns"), args.indexOf("--max-turns") + 2), [
    "--max-turns",
    "7",
  ]);
  assert.deepEqual(args.slice(args.indexOf("--mode"), args.indexOf("--mode") + 2), [
    "--mode",
    "plan",
  ]);
});

test("ZCode CLI reports non-zero exits without leaking the prompt", async (t) => {
  const command = fakeZCode(t, `
const prompt = process.argv[process.argv.indexOf("--prompt") + 1];
process.stderr.write("provider failed while handling " + prompt);
  process.exit(23);
`);
  const logs: string[] = [];
  const client = new ZCodeCliClient({ command, onLog: (message) => logs.push(message) });
  const secretPrompt = "review token sk-secret-value";

  await assert.rejects(
    client.runTurn(process.cwd(), secretPrompt),
    (error: Error) => {
      assert.match(error.message, /exited \(23\)/);
      assert.match(error.message, /provider failed/);
      assert.doesNotMatch(error.message, /sk-secret-value/);
      assert.match(error.message, /\[REDACTED_PROMPT\]/);
      return true;
    },
  );
  assert.equal(logs.length, 1);
  assert.doesNotMatch(logs[0]!, /sk-secret-value/);
});

test("ZCode CLI diagnostics redact configured credentials", async (t) => {
  const command = fakeZCode(t, `
process.stderr.write("zcode-secret-for-redaction-test");
process.exit(2);
`);
  const previous = process.env.CONCORDIA_RELAY_ZCODE_TOKEN;
  process.env.CONCORDIA_RELAY_ZCODE_TOKEN = "zcode-secret-for-redaction-test";
  t.after(() => {
    if (previous === undefined) delete process.env.CONCORDIA_RELAY_ZCODE_TOKEN;
    else process.env.CONCORDIA_RELAY_ZCODE_TOKEN = previous;
  });
  const client = new ZCodeCliClient({ command });

  await assert.rejects(
    client.runTurn(process.cwd(), "Review"),
    (error: Error) => {
      assert.match(error.message, /\[REDACTED\]/);
      assert.doesNotMatch(error.message, /zcode-secret-for-redaction-test/);
      return true;
    },
  );
});

test("ZCode CLI child does not inherit relay or API credentials", async (t) => {
  const command = fakeZCode(t, `
process.stdout.write(JSON.stringify({
  sessionId: "sess_clean_env",
  response: [
    process.env.CONCORDIA_REDIS_URL,
    process.env.CONCORDIA_RELAY_ZCODE_TOKEN,
    process.env.OPENAI_API_KEY,
  ].map((value) => value ?? "missing").join(","),
}));
`);
  const previous = {
    redis: process.env.CONCORDIA_REDIS_URL,
    token: process.env.CONCORDIA_RELAY_ZCODE_TOKEN,
    api: process.env.OPENAI_API_KEY,
  };
  process.env.CONCORDIA_REDIS_URL = "rediss://secret@example.test";
  process.env.CONCORDIA_RELAY_ZCODE_TOKEN = "relay-secret";
  process.env.OPENAI_API_KEY = "api-secret";
  t.after(() => {
    if (previous.redis === undefined) delete process.env.CONCORDIA_REDIS_URL;
    else process.env.CONCORDIA_REDIS_URL = previous.redis;
    if (previous.token === undefined) delete process.env.CONCORDIA_RELAY_ZCODE_TOKEN;
    else process.env.CONCORDIA_RELAY_ZCODE_TOKEN = previous.token;
    if (previous.api === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous.api;
  });

  const result = await new ZCodeCliClient({ command }).runTurn(process.cwd(), "Review");
  assert.equal(result.response, "missing,missing,missing");
});

test("ZCode CLI rejects malformed JSON output", async (t) => {
  const command = fakeZCode(t, 'process.stdout.write("not-json");');
  const client = new ZCodeCliClient({ command });

  await assert.rejects(client.runTurn(process.cwd(), "Review"), /invalid JSON/);
});

test("ZCode CLI terminates an active turn when shutdown is requested", async (t) => {
  const command = fakeZCode(t, `
process.on("SIGTERM", () => process.exit(0));
setInterval(() => undefined, 1_000);
`);
  const client = new ZCodeCliClient({ command, timeoutMs: 30_000 });
  const controller = new AbortController();
  const turn = client.runTurn(process.cwd(), "Review", undefined, controller.signal);
  controller.abort();

  await assert.rejects(turn, /aborted/);
});
