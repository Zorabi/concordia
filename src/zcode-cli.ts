import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const MACOS_ZCODE_COMMAND = "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs";
const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_STDOUT_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_STDERR_LIMIT_BYTES = 64 * 1024;
const DEFAULT_CHILD_ENV_NAMES = [
  "HOME",
  "USER",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "TERM",
  "TZ",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "CONCORDIA_AGENT_ID",
  "CONCORDIA_DB",
  "CONCORDIA_ROOTS",
] as const;
export type ZCodePermissionMode = "build" | "edit" | "plan" | "yolo";

export interface ZCodeTurnResult {
  sessionId: string;
  turnId?: string;
  response: string;
}

export interface ZCodeAutomationClient {
  runTurn(
    cwd: string,
    prompt: string,
    sessionId?: string,
    signal?: AbortSignal,
    sensitiveValues?: readonly string[],
  ): Promise<ZCodeTurnResult>;
}

export interface ZCodeCliOptions {
  command?: string;
  mode?: string;
  maxTurns?: number;
  timeoutMs?: number;
  turnTimeoutMs?: number;
  stdoutLimitBytes?: number;
  stderrLimitBytes?: number;
  maxOutputBytes?: number;
  envAllowlist?: readonly string[] | string;
  onLog?: (message: string) => void;
}

export class ZCodeCliError extends Error {
  constructor(
    message: string,
    readonly exitCode?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ZCodeCliError";
  }
}

function positiveInteger(value: number | undefined, fallback: number, field: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return result;
}

function optionalPositiveInteger(value: number | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  return positiveInteger(value, value, field);
}

function permissionMode(value: string | undefined): ZCodePermissionMode {
  const result = value ?? "build";
  if (result !== "build" && result !== "edit" && result !== "plan" && result !== "yolo") {
    throw new Error("mode must be build, edit, plan, or yolo");
  }
  return result;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ZCodeCliError(`ZCode CLI result omitted ${field}`);
  }
  return value;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function sanitizeDiagnostic(
  value: string,
  prompt: string,
  sensitiveValues: readonly string[],
): string {
  let result = value;
  const escapedPrompt = JSON.stringify(prompt).slice(1, -1);
  for (const candidate of new Set([prompt, escapedPrompt])) {
    if (candidate) result = result.replaceAll(candidate, "[REDACTED_PROMPT]");
  }
  for (const name of [
    "CONCORDIA_REDIS_URL",
    "CONCORDIA_RELAY_ZCODE_TOKEN",
    "ZAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
  ]) {
    const secret = process.env[name];
    if (secret) result = result.replaceAll(secret, "[REDACTED]");
  }
  for (const secret of sensitiveValues) {
    if (secret) result = result.replaceAll(secret, "[REDACTED]");
  }
  return result.trim().slice(0, 4_000);
}

function parseResult(stdout: Buffer): ZCodeTurnResult {
  const text = stdout.toString("utf8").trim();
  if (!text) throw new ZCodeCliError("ZCode CLI returned no JSON result");

  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch (error) {
    throw new ZCodeCliError("ZCode CLI returned invalid JSON", undefined, {
      cause: error,
    });
  }

  const result = asObject(decoded);
  if (!result) throw new ZCodeCliError("ZCode CLI returned a non-object JSON result");
  const sessionId = requiredString(result.sessionId, "sessionId");
  if (!sessionId.startsWith("sess_")) {
    throw new ZCodeCliError("ZCode CLI returned an invalid sessionId");
  }
  const turnId = result.turnId;
  if (turnId !== undefined && (typeof turnId !== "string" || turnId.length === 0)) {
    throw new ZCodeCliError("ZCode CLI returned an invalid turnId");
  }
  return {
    sessionId,
    ...(turnId === undefined ? {} : { turnId }),
    response: requiredString(result.response, "response"),
  };
}

function resolveCommand(command: string | undefined): string {
  if (command) return command;
  return existsSync(MACOS_ZCODE_COMMAND) ? MACOS_ZCODE_COMMAND : "zcode";
}

function validateSessionId(sessionId: string): void {
  if (!/^sess_[A-Za-z0-9._-]+$/.test(sessionId)) {
    throw new Error("sessionId must be a persisted ZCode session ID (sess_...)");
  }
}

function childEnvironment(configured: readonly string[] | string): NodeJS.ProcessEnv {
  const names = new Set<string>(DEFAULT_CHILD_ENV_NAMES);
  const additions = typeof configured === "string" ? configured.split(",") : configured;
  for (const name of additions) {
    const normalized = name.trim();
    if (normalized) names.add(normalized);
  }
  if (process.env.CONCORDIA_TRANSPORT === "stdio") names.add("CONCORDIA_TRANSPORT");

  const result: NodeJS.ProcessEnv = {};
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) result[name] = value;
  }
  return result;
}

export class ZCodeCliClient implements ZCodeAutomationClient {
  private readonly command: string;
  private readonly mode: ZCodePermissionMode;
  private readonly maxTurns?: number;
  private readonly timeoutMs: number;
  private readonly stdoutLimitBytes: number;
  private readonly stderrLimitBytes: number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly onLog: (message: string) => void;

  constructor(options: ZCodeCliOptions = {}) {
    this.command = resolveCommand(options.command);
    this.mode = permissionMode(options.mode);
    this.maxTurns = optionalPositiveInteger(options.maxTurns, "maxTurns");
    this.timeoutMs = positiveInteger(
      options.timeoutMs ?? options.turnTimeoutMs,
      DEFAULT_TIMEOUT_MS,
      "timeoutMs",
    );
    this.stdoutLimitBytes = positiveInteger(
      options.stdoutLimitBytes ?? options.maxOutputBytes,
      DEFAULT_STDOUT_LIMIT_BYTES,
      "stdoutLimitBytes",
    );
    this.stderrLimitBytes = positiveInteger(
      options.stderrLimitBytes,
      DEFAULT_STDERR_LIMIT_BYTES,
      "stderrLimitBytes",
    );
    this.env = childEnvironment(options.envAllowlist ?? []);
    this.onLog = options.onLog ?? (() => undefined);
  }

  async runTurn(
    cwd: string,
    prompt: string,
    sessionId?: string,
    signal?: AbortSignal,
    sensitiveValues: readonly string[] = [],
  ): Promise<ZCodeTurnResult> {
    if (!cwd) throw new Error("cwd must not be empty");
    if (!prompt) throw new Error("prompt must not be empty");
    if (sessionId !== undefined) validateSessionId(sessionId);
    if (signal?.aborted) throw new ZCodeCliError("ZCode CLI turn aborted");

    const args = [
      "--prompt",
      prompt,
      "--cwd",
      cwd,
      "--json",
      "--surface",
      "terminal",
      "--mode",
      this.mode,
      ...(sessionId === undefined ? [] : ["--resume", sessionId]),
      ...(this.maxTurns === undefined ? [] : ["--max-turns", String(this.maxTurns)]),
    ];

    return new Promise<ZCodeTurnResult>((resolve, reject) => {
      const child = spawn(this.command, args, {
        cwd,
        env: this.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout: Buffer = Buffer.alloc(0);
      let stderr: Buffer = Buffer.alloc(0);
      let settled = false;
      let killTimer: NodeJS.Timeout | undefined;

      const terminate = (): void => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
        killTimer.unref();
      };
      const fail = (error: Error, shouldTerminate = false): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        if (shouldTerminate) terminate();
        reject(error);
      };
      const abort = (): void => {
        fail(new ZCodeCliError("ZCode CLI turn aborted"), true);
      };
      const append = (
        current: Buffer,
        chunk: Buffer,
        limit: number,
        stream: "stdout" | "stderr",
      ): Buffer => {
        if (current.length + chunk.length > limit) {
          fail(new ZCodeCliError(`ZCode CLI ${stream} exceeded ${limit} bytes`), true);
          return current;
        }
        return Buffer.concat([current, chunk]);
      };
      const timeout = setTimeout(() => {
        fail(new ZCodeCliError(`ZCode CLI turn timed out after ${this.timeoutMs} ms`), true);
      }, this.timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });

      child.stdout.on("data", (chunk: Buffer) => {
        if (!settled) stdout = append(stdout, chunk, this.stdoutLimitBytes, "stdout");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (!settled) stderr = append(stderr, chunk, this.stderrLimitBytes, "stderr");
      });
      child.once("error", (error) => {
        fail(new ZCodeCliError(`Unable to start ZCode CLI: ${error.message}`, undefined, {
          cause: error,
        }));
      });
      child.once("close", (code, exitSignal) => {
        if (killTimer) clearTimeout(killTimer);
        if (settled) return;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        settled = true;
        const diagnostic = sanitizeDiagnostic(stderr.toString("utf8"), prompt, sensitiveValues);
        if (diagnostic) this.onLog(diagnostic);
        if (code !== 0) {
          reject(new ZCodeCliError(
            `ZCode CLI exited (${code ?? exitSignal ?? "unknown"})${diagnostic ? `: ${diagnostic}` : ""}`,
            code ?? undefined,
          ));
          return;
        }
        try {
          resolve(parseResult(stdout));
        } catch (error) {
          reject(error);
        }
      });
    });
  }
}
