import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";

import { ConcordiaException } from "./protocol.js";

interface WorkspaceConfig {
  version: 1;
  allowedRoots: string[];
}

const DEFAULT_STALE_GRACE_MS = 5_000;
const MAX_STALE_GRACE_MS = 60_000;

export function parseWorkspaceConfigStaleGraceMs(value: string | undefined): number {
  if (value === undefined) return DEFAULT_STALE_GRACE_MS;
  if (!/^\d+$/.test(value)) {
    throw staleGraceError();
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_STALE_GRACE_MS) {
    throw staleGraceError();
  }
  return parsed;
}

function staleGraceError(): ConcordiaException {
  return new ConcordiaException(
    "INVALID_INPUT",
    `CONCORDIA_CONFIG_STALE_GRACE_MS must be an integer between 0 and ${MAX_STALE_GRACE_MS}`,
  );
}

function configError(message: string): ConcordiaException {
  return new ConcordiaException("INVALID_INPUT", `CONCORDIA_CONFIG_FILE ${message}`);
}

function parseConfig(contents: string): WorkspaceConfig {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw configError("must contain valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw configError("must contain a JSON object");
  }
  const config = value as Record<string, unknown>;
  if (config.version !== 1) {
    throw configError("must specify version 1");
  }
  if (!Array.isArray(config.allowedRoots) || config.allowedRoots.length === 0) {
    throw configError("must contain at least one allowed root");
  }
  if (config.allowedRoots.some((root) => typeof root !== "string" || root.trim() === "" || !isAbsolute(root))) {
    throw configError("allowedRoots must contain only non-empty absolute paths");
  }
  return { version: 1, allowedRoots: config.allowedRoots as string[] };
}

function canonicalizeRoots(roots: readonly string[], source: "config" | "environment"): readonly string[] {
  const canonical = roots.map((root) => {
    try {
      return realpathSync(root);
    } catch {
      if (source === "config") throw configError("contains an allowed root that does not exist");
      throw new ConcordiaException("WORKSPACE_DENIED", "An allowed workspace root does not exist");
    }
  });
  return [...new Set(canonical)];
}

export class WorkspaceRootsConfig {
  private lastKnownGood: readonly string[];
  private lastLoadedAt: number;
  private reloadFailure: ConcordiaException | undefined;

  private constructor(
    private readonly configFile: string | undefined,
    initialRoots: readonly string[],
    private readonly staleGraceMs = DEFAULT_STALE_GRACE_MS,
    private readonly monotonicNow: () => number = () => performance.now(),
  ) {
    this.lastKnownGood = initialRoots;
    this.lastLoadedAt = this.monotonicNow();
  }

  static fromFile(
    configFile: string,
    staleGraceMs = DEFAULT_STALE_GRACE_MS,
    monotonicNow: () => number = () => performance.now(),
  ): WorkspaceRootsConfig {
    if (configFile === "" || !isAbsolute(configFile)) {
      throw configError("must be a non-empty absolute path");
    }
    if (!Number.isInteger(staleGraceMs) || staleGraceMs < 0 || staleGraceMs > MAX_STALE_GRACE_MS) {
      throw staleGraceError();
    }
    const roots = WorkspaceRootsConfig.readFile(configFile);
    return new WorkspaceRootsConfig(configFile, roots, staleGraceMs, monotonicNow);
  }

  static fromRoots(roots: readonly string[]): WorkspaceRootsConfig {
    if (roots.length === 0) {
      throw new ConcordiaException("INVALID_INPUT", "CONCORDIA_ROOTS must contain at least one allowed root");
    }
    return new WorkspaceRootsConfig(undefined, canonicalizeRoots(roots, "environment"));
  }

  getAllowedRoots(): readonly string[] {
    if (this.configFile === undefined) return this.lastKnownGood;
    try {
      this.lastKnownGood = WorkspaceRootsConfig.readFile(this.configFile);
      this.lastLoadedAt = this.monotonicNow();
      if (this.reloadFailure !== undefined) {
        this.reloadFailure = undefined;
        WorkspaceRootsConfig.log("info", "workspace_config.reloaded");
      }
    } catch (error) {
      // Config files are commonly replaced atomically. Keep serving with the last
      // complete, validated snapshot only for a bounded grace period.
      if (this.reloadFailure === undefined) {
        const failure = error instanceof ConcordiaException
          ? error
          : configError("could not be reloaded");
        this.reloadFailure = failure;
        WorkspaceRootsConfig.log("error", "workspace_config.reload_failed", failure);
      }
      if (this.staleGraceMs === 0 || this.monotonicNow() - this.lastLoadedAt > this.staleGraceMs) {
        throw this.reloadFailure;
      }
    }
    return this.lastKnownGood;
  }

  private static log(level: "info" | "error", event: string, error?: unknown): void {
    const diagnostic = error instanceof ConcordiaException
      ? { code: error.code, message: error.message }
      : { code: "INVALID_INPUT", message: "CONCORDIA_CONFIG_FILE could not be reloaded" };
    console.error(JSON.stringify({
      level,
      event,
      ...(error === undefined ? {} : { error: diagnostic }),
      timestamp: new Date().toISOString(),
    }));
  }

  private static readFile(configFile: string): readonly string[] {
    let contents: string;
    try {
      contents = readFileSync(configFile, "utf8");
    } catch {
      throw configError("does not exist or cannot be read");
    }
    return canonicalizeRoots(parseConfig(contents).allowedRoots, "config");
  }
}
