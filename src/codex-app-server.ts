import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";

type JsonObject = Record<string, unknown>;

interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

interface JsonRpcNotification {
  method: string;
  id?: string | number;
  params?: unknown;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
}

interface PendingTurn {
  resolve(result: CodexTurnResult): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
}

export interface CodexTurnResult {
  threadId: string;
  turnId: string;
  status: "completed" | "interrupted" | "failed";
  error?: string;
}

export interface CodexAutomationClient {
  startThread(cwd: string, name?: string): Promise<string>;
  resumeThread(threadId: string): Promise<void>;
  runTurn(threadId: string, cwd: string, prompt: string): Promise<CodexTurnResult>;
  close(): Promise<void>;
}

export interface CodexAppServerOptions {
  command?: string;
  requestTimeoutMs?: number;
  turnTimeoutMs?: number;
  model?: string;
  effort?: string;
  onLog?: (message: string) => void;
}

export class CodexAppServerError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "CodexAppServerError";
  }
}

function positiveInteger(value: number | undefined, fallback: number, field: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return result;
}

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CodexAppServerError(`Codex App Server omitted ${field}`);
  }
  return value;
}

export class CodexAppServerClient implements CodexAutomationClient {
  private readonly command: string;
  private readonly requestTimeoutMs: number;
  private readonly turnTimeoutMs: number;
  private readonly model?: string;
  private readonly effort?: string;
  private readonly onLog: (message: string) => void;
  private process?: ChildProcessWithoutNullStreams;
  private lines?: ReadlineInterface;
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private readonly pendingTurns = new Map<string, PendingTurn>();
  private readonly completedTurns = new Map<string, CodexTurnResult>();
  private readonly loadedThreads = new Set<string>();
  private starting?: Promise<void>;
  private closed = false;

  constructor(options: CodexAppServerOptions = {}) {
    this.command = options.command ?? "codex";
    this.requestTimeoutMs = positiveInteger(options.requestTimeoutMs, 30_000, "requestTimeoutMs");
    this.turnTimeoutMs = positiveInteger(options.turnTimeoutMs, 30 * 60_000, "turnTimeoutMs");
    this.model = options.model;
    this.effort = options.effort;
    this.onLog = options.onLog ?? (() => undefined);
  }

  async startThread(cwd: string, name?: string): Promise<string> {
    await this.ensureStarted();
    const result = asObject(await this.request("thread/start", {
      cwd,
      approvalPolicy: "never",
      sandbox: "read-only",
      serviceName: "concordia-waker",
      ...(this.model === undefined ? {} : { model: this.model }),
    }));
    const thread = asObject(result?.thread);
    const threadId = requiredString(thread?.id, "thread.id");
    this.loadedThreads.add(threadId);
    if (name) {
      await this.request("thread/name/set", { threadId, name });
    }
    return threadId;
  }

  async resumeThread(threadId: string): Promise<void> {
    await this.ensureStarted();
    if (this.loadedThreads.has(threadId)) return;
    await this.request("thread/resume", { threadId });
    this.loadedThreads.add(threadId);
  }

  async runTurn(threadId: string, cwd: string, prompt: string): Promise<CodexTurnResult> {
    await this.resumeThread(threadId);
    const result = asObject(await this.request("turn/start", {
      threadId,
      input: [{ type: "text", text: prompt }],
      cwd,
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      summary: "concise",
      ...(this.model === undefined ? {} : { model: this.model }),
      ...(this.effort === undefined ? {} : { effort: this.effort }),
    }));
    const turn = asObject(result?.turn);
    const turnId = requiredString(turn?.id, "turn.id");
    return this.waitForTurn(threadId, turnId);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const error = new CodexAppServerError("Codex App Server client closed");
    this.rejectAll(error);
    this.lines?.close();
    const child = this.process;
    this.process = undefined;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const fallback = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 2_000);
      fallback.unref();
      child.once("exit", () => {
        clearTimeout(fallback);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }

  private async ensureStarted(): Promise<void> {
    if (this.closed) throw new CodexAppServerError("Codex App Server client is closed");
    if (this.process) return;
    if (!this.starting) this.starting = this.startProcess();
    await this.starting;
  }

  private async startProcess(): Promise<void> {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.command, ["app-server", "--stdio"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      throw new CodexAppServerError(`Unable to start Codex App Server: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.process = child;
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", (line) => this.handleLine(line));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const message = chunk.trim();
      if (message) this.onLog(message);
    });
    child.once("error", (error) => this.handleProcessEnd(
      child,
      new CodexAppServerError(`Codex App Server failed: ${error.message}`),
    ));
    child.once("exit", (code, signal) => {
      this.handleProcessEnd(
        child,
        new CodexAppServerError(`Codex App Server exited (${code ?? signal ?? "unknown"})`),
      );
    });

    try {
      await this.requestWithoutStart("initialize", {
        clientInfo: {
          name: "concordia_waker",
          title: "Concordia Waker",
          version: "0.4.0",
        },
        capabilities: {
          experimentalApi: false,
          requestAttestation: false,
          optOutNotificationMethods: ["item/agentMessage/delta", "item/reasoning/summaryTextDelta"],
        },
      });
      this.notify("initialized", {});
    } catch (error) {
      if (this.process === child) {
        this.process = undefined;
        this.starting = undefined;
        this.lines?.close();
        this.lines = undefined;
      }
      child.kill("SIGTERM");
      throw error;
    }
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    await this.ensureStarted();
    return this.requestWithoutStart(method, params);
  }

  private requestWithoutStart(method: string, params: unknown): Promise<unknown> {
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new CodexAppServerError(`Codex App Server request timed out: ${method}`));
      }, this.requestTimeoutMs);
      this.pendingRequests.set(id, { resolve, reject, timeout });
      try {
        this.write({ method, id, params });
      } catch (error) {
        clearTimeout(timeout);
        this.pendingRequests.delete(id);
        reject(error);
      }
    });
  }

  private notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  private write(message: unknown): void {
    const child = this.process;
    if (!child || child.stdin.destroyed || !child.stdin.writable) {
      throw new CodexAppServerError("Codex App Server stdin is unavailable");
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    let message: JsonRpcResponse | JsonRpcNotification;
    try {
      message = JSON.parse(line) as JsonRpcResponse | JsonRpcNotification;
    } catch {
      this.onLog("Codex App Server emitted invalid JSON");
      return;
    }
    if (
      "method" in message
      && typeof message.method === "string"
      && "id" in message
      && (typeof message.id === "number" || typeof message.id === "string")
    ) {
      this.write({
        id: message.id,
        error: { code: -32000, message: "Concordia waker cannot handle interactive server requests" },
      });
      return;
    }
    if ("id" in message && typeof message.id === "number") {
      const response = message as JsonRpcResponse;
      const pending = this.pendingRequests.get(response.id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(response.id);
        if (response.error) {
          pending.reject(new CodexAppServerError(
            response.error.message ?? "Codex App Server request failed",
            response.error.code,
            response.error.data,
          ));
        } else {
          pending.resolve(response.result);
        }
        return;
      }
      return;
    }
    if ("method" in message && message.method === "turn/completed") {
      this.handleTurnCompleted(message.params);
    }
  }

  private handleTurnCompleted(params: unknown): void {
    const object = asObject(params);
    const turn = asObject(object?.turn);
    if (!turn || typeof turn.id !== "string") return;
    const status = turn.status;
    if (status !== "completed" && status !== "interrupted" && status !== "failed") return;
    const error = asObject(turn.error);
    const result: CodexTurnResult = {
      threadId: typeof object?.threadId === "string" ? object.threadId : "",
      turnId: turn.id,
      status,
      ...(typeof error?.message === "string" ? { error: error.message } : {}),
    };
    const pending = this.pendingTurns.get(turn.id);
    if (!pending) {
      this.completedTurns.set(turn.id, result);
      return;
    }
    clearTimeout(pending.timeout);
    this.pendingTurns.delete(turn.id);
    pending.resolve(result);
  }

  private waitForTurn(threadId: string, turnId: string): Promise<CodexTurnResult> {
    const completed = this.completedTurns.get(turnId);
    if (completed) {
      this.completedTurns.delete(turnId);
      return Promise.resolve({ ...completed, threadId });
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingTurns.delete(turnId);
        reject(new CodexAppServerError(`Codex turn timed out: ${turnId}`));
      }, this.turnTimeoutMs);
      this.pendingTurns.set(turnId, {
        resolve: (result) => resolve({ ...result, threadId }),
        reject,
        timeout,
      });
    });
  }

  private handleProcessEnd(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.process !== child) return;
    this.process = undefined;
    this.lines?.close();
    this.lines = undefined;
    this.loadedThreads.clear();
    this.starting = undefined;
    if (!this.closed) this.rejectAll(error);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingRequests.clear();
    for (const pending of this.pendingTurns.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingTurns.clear();
  }
}
