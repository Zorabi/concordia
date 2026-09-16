import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

test("ZCode plugin uses user-level shared state instead of project-bound MCP settings", () => {
  const config = JSON.parse(
    readFileSync(resolve(process.cwd(), "zcode-plugin/.mcp.json"), "utf8"),
  ) as {
    mcpServers: {
      concordia: {
        cwd?: string;
        env: Record<string, string>;
      };
    };
  };
  const server = config.mcpServers.concordia;

  assert.equal(server.cwd, undefined);
  assert.equal(server.env.CONCORDIA_DB, undefined);
  assert.equal(server.env.CONCORDIA_HOME, undefined);
  assert.equal(server.env.CONCORDIA_CONFIG_FILE, undefined);
  assert.equal(server.env.CONCORDIA_ROOTS, undefined);
  assert.equal(server.env.CONCORDIA_AGENT_ID, "zcode");
});

test("ZCode plugin ships a Desktop-native persistent worker command", () => {
  const command = readFileSync(
    resolve(process.cwd(), "zcode-plugin/commands/worker.md"),
    "utf8",
  );

  assert.match(command, /current visible Desktop task/);
  assert.match(command, /never launch or resume ZCode through the CLI/);
  assert.match(command, /Create a session goal/);
  assert.match(command, /wait_events/);
  assert.match(command, /submit_task/);
});
