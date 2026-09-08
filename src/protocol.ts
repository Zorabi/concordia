export const TASK_STATUSES = [
  "DRAFT",
  "READY",
  "CLAIMED",
  "RUNNING",
  "WAITING_INPUT",
  "REVIEW",
  "APPROVED",
  "FAILED",
  "CANCELLED",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "APPROVED",
  "FAILED",
  "CANCELLED",
]);

export const EVENT_TYPES = [
  "TASK_CREATED",
  "TASK_CLAIMED",
  "PROGRESS",
  "QUESTION",
  "ANSWER",
  "AGENT_STATUS",
  "HEARTBEAT",
  "COMPLETED",
  "CHANGES_REQUESTED",
  "APPROVED",
  "FAILED",
  "CANCELLED",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];
export type ActorRole = "codex" | "zcode";
export type DeliverableKind = "commit" | "changed_files" | "checks" | "risks";

export interface TaskSpec {
  id: string;
  objective: string;
  workspace: string;
  baseCommit?: string;
  ownedPaths: string[];
  excludedPaths?: string[];
  constraints: string[];
  acceptance: string[];
  deliverables: DeliverableKind[];
  delegation: {
    mode: "auto" | "disabled";
    maxConcurrency: number;
    maxDepth: 1;
  };
  timeoutSeconds: number;
}

export interface TaskEvent<T = unknown> {
  eventId: number;
  taskId: string;
  sender: string;
  recipient?: string;
  type: EventType;
  payload: T;
  idempotencyKey: string;
  createdAt: string;
}

export interface TaskCheck {
  commandId: string;
  exitCode: number;
  summary: string;
  logPath?: string;
}

export interface TaskSubmission {
  taskId: string;
  leaseToken: string;
  commit: string;
  changedFiles: string[];
  checks: TaskCheck[];
  risks: string[];
  summary: string;
  idempotencyKey: string;
}

export type TaskSubmissionRecord = Omit<TaskSubmission, "leaseToken">;

export type ReviewTaskInput =
  | {
      taskId: string;
      decision: "approve";
      summary: string;
      idempotencyKey: string;
      expectedVersion?: number;
    }
  | {
      taskId: string;
      decision: "request_changes";
      findings: Array<{
        path?: string;
        line?: number;
        severity: "blocking" | "warning";
        message: string;
      }>;
      idempotencyKey: string;
      expectedVersion?: number;
    };

export interface TaskLease {
  owner: string;
  until: string;
}

export interface TaskRecord {
  id: string;
  status: TaskStatus;
  assignee?: string;
  spec: TaskSpec;
  workspace: string;
  baseCommit?: string;
  worktreePath?: string;
  lease?: TaskLease;
  attempt: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactRecord {
  artifactId: number;
  taskId: string;
  kind: string;
  localPath: string;
  checksum?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface TaskDetail extends TaskRecord {
  events: TaskEvent[];
  artifacts: ArtifactRecord[];
  submission?: TaskSubmissionRecord;
}

export interface CreateTaskResult {
  taskId: string;
  status: "READY";
  eventId: number;
  created: boolean;
}

export interface ClaimTaskInput {
  agentId: string;
  workspace?: string;
  leaseSeconds?: number;
}

export interface ClaimTaskResult {
  task: TaskRecord | null;
  eventId?: number;
  leaseToken?: string;
}

export interface ListTasksInput {
  status?: TaskStatus[];
  assignee?: string;
  workspace?: string;
  updatedAfter?: string;
  limit?: number;
}

export interface SendEventInput<T = unknown> {
  taskId: string;
  sender: string;
  recipient?: string;
  type: EventType;
  payload: T;
  idempotencyKey: string;
  leaseToken?: string;
  expectedVersion?: number;
  leaseSeconds?: number;
}

export interface WaitEventsInput {
  taskId?: string;
  recipient?: string;
  afterEventId: number;
  timeoutMs?: number;
  limit?: number;
}

export interface ConcordiaErrorShape {
  code:
    | "INVALID_INPUT"
    | "TASK_NOT_FOUND"
    | "INVALID_TRANSITION"
    | "LEASE_CONFLICT"
    | "STALE_VERSION"
    | "WORKSPACE_DENIED"
    | "BASE_COMMIT_MISMATCH"
    | "PATH_SCOPE_VIOLATION"
    | "INTERNAL_ERROR";
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export class ConcordiaException extends Error implements ConcordiaErrorShape {
  readonly code: ConcordiaErrorShape["code"];
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ConcordiaErrorShape["code"],
    message: string,
    retryable = false,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ConcordiaException";
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }

  toJSON(): ConcordiaErrorShape {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConcordiaException("INVALID_INPUT", `${field} must be a non-empty string`);
  }
  return value;
}

export function validateIdempotencyKey(value: unknown): string {
  const key = requireNonEmptyString(value, "idempotencyKey");
  if (key.length > 256) {
    throw new ConcordiaException("INVALID_INPUT", "idempotencyKey must not exceed 256 characters");
  }
  return key;
}

export function validateTaskSpec(spec: TaskSpec): TaskSpec {
  if (spec === null || typeof spec !== "object") {
    throw new ConcordiaException("INVALID_INPUT", "spec must be an object");
  }
  requireNonEmptyString(spec.id, "spec.id");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(spec.id)) {
    throw new ConcordiaException("INVALID_INPUT", "spec.id must be a safe identifier of at most 128 characters");
  }
  requireNonEmptyString(spec.objective, "spec.objective");
  requireNonEmptyString(spec.workspace, "spec.workspace");
  if (!Array.isArray(spec.ownedPaths) || spec.ownedPaths.length === 0) {
    throw new ConcordiaException("INVALID_INPUT", "spec.ownedPaths must contain at least one path");
  }
  spec.ownedPaths.forEach((value, index) => requireNonEmptyString(value, `spec.ownedPaths[${index}]`));
  if (!Array.isArray(spec.acceptance) || spec.acceptance.length === 0) {
    throw new ConcordiaException("INVALID_INPUT", "spec.acceptance must contain at least one condition");
  }
  spec.acceptance.forEach((value, index) => requireNonEmptyString(value, `spec.acceptance[${index}]`));
  if (!Array.isArray(spec.constraints) || !Array.isArray(spec.deliverables)) {
    throw new ConcordiaException("INVALID_INPUT", "spec.constraints and spec.deliverables must be arrays");
  }
  spec.constraints.forEach((value, index) => requireNonEmptyString(value, `spec.constraints[${index}]`));
  if (spec.excludedPaths !== undefined && !Array.isArray(spec.excludedPaths)) {
    throw new ConcordiaException("INVALID_INPUT", "spec.excludedPaths must be an array when provided");
  }
  const deliverables = new Set<DeliverableKind>(["commit", "changed_files", "checks", "risks"]);
  if (spec.deliverables.some((value) => !deliverables.has(value))) {
    throw new ConcordiaException("INVALID_INPUT", "spec.deliverables contains an unsupported value");
  }
  if (
    !spec.delegation ||
    !["auto", "disabled"].includes(spec.delegation.mode) ||
    !Number.isInteger(spec.delegation.maxConcurrency) ||
    spec.delegation.maxConcurrency < 1 ||
    spec.delegation.maxDepth !== 1
  ) {
    throw new ConcordiaException("INVALID_INPUT", "spec.delegation is invalid; maxDepth must equal 1");
  }
  if (!Number.isInteger(spec.timeoutSeconds) || spec.timeoutSeconds < 1) {
    throw new ConcordiaException("INVALID_INPUT", "spec.timeoutSeconds must be a positive integer");
  }
  return spec;
}

export function asConcordiaError(error: unknown): ConcordiaException {
  if (error instanceof ConcordiaException) return error;
  return new ConcordiaException("INTERNAL_ERROR", "An internal Concordia error occurred", false);
}
