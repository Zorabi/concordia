#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { ConcordiaDatabase } from "./database.js";
import {
  asConcordiaError,
  ConcordiaException,
  TASK_STATUSES,
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
import { TaskService } from "./tasks.js";
import { WorkspaceManager } from "./workspace.js";

type Awaitable<T> = T | Promise<T>;

export interface ConcordiaService {
  createTask(spec: TaskSpec, idempotencyKey: string): Awaitable<CreateTaskResult>;
  claimTask(input: ClaimTaskInput): Awaitable<ClaimTaskResult>;
  getTask(taskId: string, recentEventLimit?: number): Awaitable<TaskDetail>;
  listTasks(input?: ListTasksInput): Awaitable<TaskRecord[]>;
  sendEvent<T>(input: SendEventInput<T>): Awaitable<TaskEvent<T>>;
  waitEvents(input: WaitEventsInput): Awaitable<TaskEvent[]>;
  submitTask(submission: TaskSubmission, expectedVersion?: number): Awaitable<TaskDetail>;
  reviewTask(input: ReviewTaskInput): Awaitable<TaskDetail>;
}

const taskSpecSchema = z.object({
  id: z.string().min(1),
  objective: z.string().min(1),
  workspace: z.string().min(1),
  baseCommit: z.string().min(1).optional(),
  ownedPaths: z.array(z.string().min(1)).min(1),
  excludedPaths: z.array(z.string().min(1)).optional(),
  constraints: z.array(z.string()),
  acceptance: z.array(z.string().min(1)).min(1),
  deliverables: z.array(z.enum(["commit", "changed_files", "checks", "risks"])),
  delegation: z.object({
    mode: z.enum(["auto", "disabled"]),
    maxConcurrency: z.number().int().positive(),
    maxDepth: z.literal(1),
  }),
  timeoutSeconds: z.number().int().positive(),
});

const findingSchema = z.object({
  path: z.string().optional(),
  line: z.number().int().positive().optional(),
  severity: z.enum(["blocking", "warning"]),
  message: z.string().min(1),
});

const checkSchema = z.object({
  commandId: z.string().min(1),
  exitCode: z.number().int(),
  summary: z.string(),
  logPath: z.string().optional(),
});

function success(value: unknown) {
  const structuredContent = value === null || Array.isArray(value) || typeof value !== "object"
    ? { result: value }
    : value as Record<string, unknown>;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent,
  };
}

async function invoke(operation: () => unknown | Promise<unknown>) {
  try {
    return success(await operation());
  } catch (error) {
    const concordiaError = asConcordiaError(error);
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ error: concordiaError.toJSON() }) }],
      structuredContent: { error: concordiaError.toJSON() },
      isError: true,
    };
  }
}

export function createMcpServer(
  service: ConcordiaService,
  configuredRole: ActorRole,
): McpServer {
  const server = new McpServer({ name: "concordia", version: "0.4.0" });

  const requireRole = (role: ActorRole) => {
    if (configuredRole !== role) {
      throw new ConcordiaException("INVALID_INPUT", `The configured ${configuredRole} client cannot call this ${role} tool`);
    }
  };

  server.registerTool("create_task", {
    description: "Create and publish a structured Concordia task.",
    inputSchema: { spec: taskSpecSchema, idempotencyKey: z.string().min(1).max(256) },
  }, ({ spec, idempotencyKey }) => invoke(() => {
    requireRole("codex");
    return service.createTask(spec, idempotencyKey);
  }));

  server.registerTool("claim_task", {
    description: "Atomically claim a specific task or the oldest matching READY task. Preserve the returned leaseToken for every executor write.",
    inputSchema: {
      agentId: z.string().min(1),
      taskId: z.string().min(1).optional(),
      workspace: z.string().min(1).optional(),
      leaseSeconds: z.number().int().positive().max(3600).optional(),
    },
  }, (input) => invoke(() => {
    requireRole("zcode");
    return service.claimTask(input);
  }));

  server.registerTool("get_task", {
    description: "Get a task contract, state, delivery evidence, and recent events.",
    inputSchema: {
      taskId: z.string().min(1),
      eventLimit: z.number().int().min(1).max(100).optional(),
    },
  }, ({ taskId, eventLimit }) => invoke(() => service.getTask(taskId, eventLimit)));

  server.registerTool("list_tasks", {
    description: "List tasks using status, assignee, workspace, and time filters.",
    inputSchema: {
      status: z.array(z.enum(TASK_STATUSES)).optional(),
      assignee: z.string().min(1).optional(),
      workspace: z.string().min(1).optional(),
      updatedAfter: z.string().datetime().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
  }, (input) => invoke(() => service.listTasks(input)));

  server.registerTool("send_event", {
    description: "Append an authorized task progress, question, answer, heartbeat, failure, or cancellation event.",
    inputSchema: {
      taskId: z.string().min(1),
      sender: z.string().min(1),
      recipient: z.string().min(1).optional(),
      type: z.enum([
        "PROGRESS", "QUESTION", "ANSWER", "AGENT_STATUS", "HEARTBEAT", "FAILED", "CANCELLED",
      ]),
      payload: z.unknown(),
      idempotencyKey: z.string().min(1).max(256),
      leaseToken: z.string().min(1).optional().describe("Required for events sent by zcode; use the token returned by claim_task."),
      expectedVersion: z.number().int().positive().optional(),
      leaseSeconds: z.number().int().positive().max(3600).optional(),
    },
  }, (input) => invoke(() => {
    if (input.sender !== configuredRole) {
      throw new ConcordiaException("INVALID_INPUT", "Event sender does not match the configured client role");
    }
    return service.sendEvent(input);
  }));

  server.registerTool("wait_events", {
    description: "Wait up to 60 seconds for events after a durable event cursor.",
    inputSchema: {
      taskId: z.string().min(1).optional(),
      recipient: z.string().min(1).optional(),
      afterEventId: z.number().int().nonnegative(),
      timeoutMs: z.number().int().min(0).max(60_000).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
  }, (input) => invoke(async () => ({ events: await service.waitEvents(input) })));

  server.registerTool("submit_task", {
    description: "Submit a task commit and its verification evidence for Codex review.",
    inputSchema: {
      taskId: z.string().min(1),
      commit: z.string().min(1),
      changedFiles: z.array(z.string().min(1)),
      checks: z.array(checkSchema),
      risks: z.array(z.string()),
      summary: z.string(),
      idempotencyKey: z.string().min(1).max(256),
      leaseToken: z.string().min(1).describe("Fencing token returned by claim_task."),
    },
  }, (input) => invoke(() => {
    requireRole("zcode");
    return service.submitTask(input);
  }));

  server.registerTool("review_task", {
    description: "Approve a submitted task or request changes as Codex.",
    inputSchema: {
      taskId: z.string().min(1),
      decision: z.enum(["approve", "request_changes"]),
      summary: z.string().optional(),
      findings: z.array(findingSchema).optional(),
      idempotencyKey: z.string().min(1).max(256),
      expectedVersion: z.number().int().positive().optional(),
    },
  }, (input) => invoke(() => {
    requireRole("codex");
    if (input.decision === "approve") {
      return service.reviewTask({
        taskId: input.taskId,
        decision: "approve",
        summary: input.summary ?? "Approved",
        idempotencyKey: input.idempotencyKey,
        ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }),
      });
    }
    return service.reviewTask({
      taskId: input.taskId,
      decision: "request_changes",
      findings: input.findings ?? [],
      idempotencyKey: input.idempotencyKey,
      ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }),
    });
  }));

  return server;
}

export async function run(): Promise<void> {
  const configuredRole = process.env.CONCORDIA_AGENT_ID;
  if (configuredRole !== "codex" && configuredRole !== "zcode") {
    throw new ConcordiaException("INVALID_INPUT", "CONCORDIA_AGENT_ID is required and must be codex or zcode");
  }
  const transport = process.env.CONCORDIA_TRANSPORT ?? "stdio";
  let database: ConcordiaDatabase | undefined;
  let relay: (ConcordiaService & { connect(): Promise<void>; close(): Promise<void> }) | undefined;
  let service: ConcordiaService;
  if (transport === "stdio") {
    database = new ConcordiaDatabase();
    service = new TaskService(database, new WorkspaceManager());
  } else if (transport === "redis") {
    const { createRedisRelayServiceFromEnv } = await import("./relay-client.js");
    relay = createRedisRelayServiceFromEnv(configuredRole);
    await relay.connect();
    service = relay;
  } else {
    throw new ConcordiaException("INVALID_INPUT", "CONCORDIA_TRANSPORT must be stdio or redis");
  }
  const server = createMcpServer(service, configuredRole);

  const close = async () => {
    await server.close();
    await relay?.close();
    database?.close();
  };
  process.once("SIGINT", () => void close().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void close().finally(() => process.exit(0)));

  await server.connect(new StdioServerTransport());
  console.error(JSON.stringify({ level: "info", event: "server.started", transport }));
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  run().catch((error: unknown) => {
    const concordiaError = asConcordiaError(error);
    console.error(JSON.stringify({ level: "error", event: "server.failed", error: concordiaError.toJSON() }));
    process.exitCode = 1;
  });
}
