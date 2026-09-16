import { ConcordiaDatabase } from "./database.js";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { EventService } from "./events.js";
import {
  ConcordiaException,
  TERMINAL_STATUSES,
  type ArtifactRecord,
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
  type TaskStatus,
  type TaskSubmission,
  type TaskSubmissionRecord,
  type WaitEventsInput,
  requireNonEmptyString,
  validateIdempotencyKey,
  validateTaskSpec,
} from "./protocol.js";
import { WorkspaceManager, normalizeRelativePath, type WorkspaceAuthorization } from "./workspace.js";

interface TaskRow {
  id: string;
  status: string;
  assignee: string | null;
  objective: string;
  spec_json: string;
  workspace: string;
  base_commit: string | null;
  worktree_path: string | null;
  lease_owner: string | null;
  lease_until: string | null;
  lease_token: string | null;
  attempt: number;
  version: number;
  created_at: string;
  updated_at: string;
}

interface ArtifactRow {
  artifact_id: number;
  task_id: string;
  kind: string;
  local_path: string;
  checksum: string | null;
  metadata_json: string;
  created_at: string;
}

const DEFAULT_LEASE_SECONDS = 60;
export const DEFAULT_CHECK_COMMAND_IDS: ReadonlySet<string> = new Set([
  "build",
  "format-check",
  "git-diff-check",
  "lint",
  "npm-build",
  "npm-lint",
  "npm-test",
  "npm-typecheck",
  "test",
  "typecheck",
]);

function parseTask(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    status: row.status as TaskStatus,
    ...(row.assignee === null ? {} : { assignee: row.assignee }),
    spec: JSON.parse(row.spec_json) as TaskSpec,
    workspace: row.workspace,
    ...(row.base_commit === null ? {} : { baseCommit: row.base_commit }),
    ...(row.worktree_path === null ? {} : { worktreePath: row.worktree_path }),
    ...(row.lease_owner === null || row.lease_until === null
      ? {}
      : { lease: { owner: row.lease_owner, until: row.lease_until } }),
    attempt: Number(row.attempt),
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseArtifact(row: ArtifactRow): ArtifactRecord {
  return {
    artifactId: Number(row.artifact_id),
    taskId: row.task_id,
    kind: row.kind,
    localPath: row.local_path,
    ...(row.checksum === null ? {} : { checksum: row.checksum }),
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    createdAt: row.created_at,
  };
}

function leaseUntil(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function validateLeaseSeconds(value = DEFAULT_LEASE_SECONDS): number {
  if (!Number.isInteger(value) || value < 1 || value > 3600) {
    throw new ConcordiaException("INVALID_INPUT", "leaseSeconds must be an integer from 1 to 3600");
  }
  return value;
}

function newLeaseToken(): string {
  return randomBytes(32).toString("base64url");
}

function withoutLeaseToken(submission: TaskSubmission): TaskSubmissionRecord {
  const { leaseToken: _leaseToken, ...record } = submission;
  return record;
}

export interface TaskServiceOptions {
  workspace?: WorkspaceManager;
  allowedRoots?: readonly string[];
  allowedCheckCommandIds?: readonly string[];
}

export class TaskService {
  readonly events: EventService;
  readonly workspace: WorkspaceManager;
  readonly allowedCheckCommandIds: ReadonlySet<string>;

  constructor(
    readonly database: ConcordiaDatabase,
    options: TaskServiceOptions | WorkspaceManager = {},
  ) {
    this.workspace = options instanceof WorkspaceManager
      ? options
      : options.workspace ?? new WorkspaceManager(options.allowedRoots);
    this.allowedCheckCommandIds = options instanceof WorkspaceManager || options.allowedCheckCommandIds === undefined
      ? DEFAULT_CHECK_COMMAND_IDS
      : new Set(options.allowedCheckCommandIds);
    this.events = new EventService(database);
  }

  createTask(specInput: TaskSpec, idempotencyKey: string): CreateTaskResult {
    validateIdempotencyKey(idempotencyKey);
    const duplicate = this.events.getByIdempotencyKey(idempotencyKey);
    if (duplicate) {
      this.assertTaskAllowed(duplicate.taskId);
      if (duplicate.type !== "TASK_CREATED") {
        throw new ConcordiaException("INVALID_INPUT", "idempotencyKey was already used for another operation");
      }
      return { taskId: duplicate.taskId, status: "READY", eventId: duplicate.eventId, created: false };
    }

    const spec = this.workspace.validateSpec(validateTaskSpec(specInput));
    const now = new Date().toISOString();
    return this.database.transaction(() => {
      const authorization = this.workspace.authorizationSnapshot();
      const duplicateInTransaction = this.events.getByIdempotencyKey(idempotencyKey);
      if (duplicateInTransaction) {
        this.assertTaskAllowed(duplicateInTransaction.taskId, authorization);
        if (duplicateInTransaction.type !== "TASK_CREATED") {
          throw new ConcordiaException("INVALID_INPUT", "idempotencyKey was already used for another operation");
        }
        return {
          taskId: duplicateInTransaction.taskId,
          status: "READY" as const,
          eventId: duplicateInTransaction.eventId,
          created: false,
        };
      }
      authorization.assertWorkspaceAllowed(spec.workspace);
      const existingTask = this.getTaskRow(spec.id);
      if (existingTask) throw new ConcordiaException("INVALID_INPUT", "Task ID already exists");
      this.database.connection.prepare(`
        INSERT INTO tasks (
          id, status, objective, spec_json, workspace, base_commit,
          attempt, version, created_at, updated_at
        ) VALUES (?, 'READY', ?, ?, ?, ?, 0, 1, ?, ?)
      `).run(spec.id, spec.objective, JSON.stringify(spec), spec.workspace, spec.baseCommit ?? null, now, now);
      const event = this.events.appendEvent({
        taskId: spec.id,
        sender: "codex",
        recipient: "zcode",
        type: "TASK_CREATED",
        payload: { spec },
        idempotencyKey,
      }, now);
      return { taskId: spec.id, status: "READY", eventId: event.eventId, created: true };
    });
  }

  claimTask(input: ClaimTaskInput): ClaimTaskResult {
    const initialAuthorization = this.workspace.authorizationSnapshot();
    const agentId = requireNonEmptyString(input.agentId, "agentId");
    const taskId = input.taskId === undefined ? undefined : requireNonEmptyString(input.taskId, "taskId");
    const seconds = validateLeaseSeconds(input.leaseSeconds);
    const workspaceFilter = input.workspace === undefined ? undefined : initialAuthorization.resolveWorkspace(input.workspace);
    const now = new Date().toISOString();

    return this.database.transaction(() => {
      const authorization = this.workspace.authorizationSnapshot();
      if (workspaceFilter !== undefined) authorization.assertWorkspaceAllowed(workspaceFilter);
      if (taskId !== undefined) {
        const targetedRow = this.getTaskRow(taskId);
        if (targetedRow !== undefined) {
          this.assertTaskRowAllowed(targetedRow, authorization);
          const ownsActiveLease = targetedRow.assignee === agentId
            && targetedRow.lease_owner === agentId
            && targetedRow.lease_token !== null
            && targetedRow.lease_until !== null
            && targetedRow.lease_until > now
            && (targetedRow.status === "CLAIMED"
              || targetedRow.status === "RUNNING"
              || targetedRow.status === "WAITING_INPUT")
            && (workspaceFilter === undefined || targetedRow.workspace === workspaceFilter);
          if (ownsActiveLease) {
            return {
              task: this.requireTask(targetedRow.id),
              leaseToken: targetedRow.lease_token!,
            };
          }
        }
      }
      const clauses = [
        "(status = 'READY' OR (status IN ('CLAIMED', 'RUNNING', 'WAITING_INPUT') AND lease_until <= ?))",
      ];
      const parameters: Array<string> = [now];
      if (taskId !== undefined) {
        clauses.push("id = ?");
        parameters.push(taskId);
      }
      if (workspaceFilter !== undefined) {
        clauses.push("workspace = ?");
        parameters.push(workspaceFilter);
      }
      const statement = this.database.connection.prepare(`
        SELECT * FROM tasks
        WHERE ${clauses.join(" AND ")}
        ORDER BY CASE WHEN status = 'READY' THEN 0 ELSE 1 END, created_at ASC
        LIMIT ? OFFSET ?
      `);
      const batchSize = 100;
      let offset = 0;
      let row: TaskRow | undefined;
      do {
        const rows = statement.all(...parameters, batchSize, offset) as unknown as TaskRow[];
        row = rows.find((candidate) => this.isTaskRowAllowed(candidate, authorization));
        if (row !== undefined || rows.length < batchSize) break;
        offset += rows.length;
      } while (true);
      if (!row) return { task: null };
      if (!row.base_commit) {
        throw new ConcordiaException("BASE_COMMIT_MISMATCH", "Task has no resolved base commit");
      }

      const attempt = row.attempt + 1;
      const worktree = this.workspace.ensureWorktree(
        row.id,
        row.workspace,
        row.base_commit,
        attempt,
        row.worktree_path ?? undefined,
        authorization,
      );
      this.workspace.assertWorkspaceAllowed(row.workspace);
      const until = leaseUntil(seconds);
      const token = newLeaseToken();
      const result = this.database.connection.prepare(`
        UPDATE tasks
        SET status = CASE WHEN status = 'WAITING_INPUT' THEN 'WAITING_INPUT' ELSE 'CLAIMED' END,
            assignee = ?, worktree_path = ?, lease_owner = ?, lease_until = ?, lease_token = ?,
            attempt = attempt + 1, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?
          AND (status = 'READY' OR (status IN ('CLAIMED', 'RUNNING', 'WAITING_INPUT') AND lease_until <= ?))
      `).run(agentId, worktree.worktreePath, agentId, until, token, now, row.id, row.version, now);
      if (Number(result.changes) !== 1) {
        throw new ConcordiaException("LEASE_CONFLICT", "Task was claimed by another agent", true);
      }
      const event = this.events.appendEvent({
        taskId: row.id,
        sender: agentId,
        recipient: "codex",
        type: "TASK_CLAIMED",
        payload: { attempt, leaseUntil: until, worktreePath: worktree.worktreePath },
        idempotencyKey: `${row.id}:claim:${attempt}`,
      }, now);
      return { task: this.requireTask(row.id), eventId: event.eventId, leaseToken: token };
    });
  }

  getTask(taskId: string, recentEventLimit = 20): TaskDetail {
    const task = this.requireTask(taskId);
    const events = this.events.listEvents({ taskId, limit: recentEventLimit, descending: true }).reverse();
    const artifactRows = this.database.connection.prepare(
      "SELECT * FROM artifacts WHERE task_id = ? ORDER BY artifact_id ASC",
    ).all(taskId) as unknown as ArtifactRow[];
    const completedRow = this.database.connection.prepare(
      "SELECT * FROM events WHERE task_id = ? AND type = 'COMPLETED' ORDER BY event_id DESC LIMIT 1",
    ).get(taskId) as unknown as { payload_json: string } | undefined;
    const submission = completedRow === undefined
      ? undefined
      : JSON.parse(completedRow.payload_json) as TaskSubmissionRecord;
    return {
      ...task,
      events,
      artifacts: artifactRows.map(parseArtifact),
      ...(submission === undefined ? {} : { submission }),
    };
  }

  listTasks(input: ListTasksInput = {}): TaskRecord[] {
    const authorization = this.workspace.authorizationSnapshot();
    const limit = input.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new ConcordiaException("INVALID_INPUT", "Task limit must be an integer from 1 to 100");
    }
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    if (input.status && input.status.length > 0) {
      clauses.push(`status IN (${input.status.map(() => "?").join(", ")})`);
      parameters.push(...input.status);
    }
    if (input.assignee !== undefined) {
      clauses.push("assignee = ?");
      parameters.push(input.assignee);
    }
    if (input.workspace !== undefined) {
      clauses.push("workspace = ?");
      parameters.push(authorization.resolveWorkspace(input.workspace));
    }
    if (input.updatedAfter !== undefined) {
      if (!Number.isFinite(Date.parse(input.updatedAfter))) {
        throw new ConcordiaException("INVALID_INPUT", "updatedAfter must be an ISO date-time");
      }
      clauses.push("updated_at > ?");
      parameters.push(input.updatedAfter);
    }
    const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
    return this.database.readTransaction(() => {
      const statement = this.database.connection.prepare(`
        SELECT * FROM tasks ${where} ORDER BY updated_at DESC, created_at ASC, id ASC LIMIT ? OFFSET ?
      `);
      const tasks: TaskRecord[] = [];
      const batchSize = 100;
      let offset = 0;
      do {
        const rows = statement.all(...parameters, batchSize, offset) as unknown as TaskRow[];
        for (const row of rows) {
          if (!this.isTaskRowAllowed(row, authorization)) continue;
          tasks.push(parseTask(row));
          if (tasks.length === limit) return tasks;
        }
        if (rows.length < batchSize) break;
        offset += rows.length;
      } while (true);
      return tasks;
    });
  }

  sendEvent<T>(input: SendEventInput<T>): TaskEvent<T> {
    validateIdempotencyKey(input.idempotencyKey);
    this.assertTaskAllowed(input.taskId);
    const duplicate = this.events.getByIdempotencyKey(input.idempotencyKey);
    if (duplicate) return this.validateDuplicateEvent(duplicate, input) as TaskEvent<T>;

    const allowed = input.sender === "codex"
      ? new Set(["ANSWER", "CANCELLED"])
      : input.sender === "zcode"
        ? new Set(["PROGRESS", "QUESTION", "AGENT_STATUS", "HEARTBEAT", "FAILED"])
        : new Set<string>();
    if (!allowed.has(input.type)) {
      throw new ConcordiaException("INVALID_INPUT", `${input.sender || "Unknown sender"} cannot send ${input.type}`);
    }

    return this.database.transaction(() => {
      const duplicateInTransaction = this.events.getByIdempotencyKey(input.idempotencyKey);
      if (duplicateInTransaction) return this.validateDuplicateEvent(duplicateInTransaction, input) as TaskEvent<T>;
      const row = this.requireTaskRow(input.taskId);
      this.assertExpectedVersion(row, input.expectedVersion);
      const now = new Date().toISOString();
      let nextStatus = row.status as TaskStatus;
      let nextLease = row.lease_until;
      let clearLease = false;

      switch (input.type) {
        case "PROGRESS":
          if (row.status === "CLAIMED") nextStatus = "RUNNING";
          else this.assertStatus(row, ["RUNNING"]);
          this.assertActiveLease(row, now, input.leaseToken);
          break;
        case "QUESTION":
          this.assertStatus(row, ["RUNNING"]);
          this.assertActiveLease(row, now, input.leaseToken);
          nextStatus = "WAITING_INPUT";
          break;
        case "ANSWER":
          this.assertStatus(row, ["WAITING_INPUT"]);
          nextStatus = "RUNNING";
          break;
        case "HEARTBEAT":
          this.assertStatus(row, ["CLAIMED", "RUNNING", "WAITING_INPUT"]);
          this.assertActiveLease(row, now, input.leaseToken);
          nextLease = leaseUntil(validateLeaseSeconds(input.leaseSeconds));
          break;
        case "FAILED":
          this.assertStatus(row, ["CLAIMED", "RUNNING", "WAITING_INPUT"]);
          this.assertActiveLease(row, now, input.leaseToken);
          nextStatus = "FAILED";
          clearLease = true;
          break;
        case "AGENT_STATUS":
          this.assertStatus(row, ["CLAIMED", "RUNNING", "WAITING_INPUT"]);
          this.assertActiveLease(row, now, input.leaseToken);
          break;
        case "CANCELLED":
          if (TERMINAL_STATUSES.has(row.status as TaskStatus)) {
            throw new ConcordiaException("INVALID_TRANSITION", `Cannot cancel a task in ${row.status}`);
          }
          nextStatus = "CANCELLED";
          clearLease = true;
          break;
      }

      this.updateTask(row, {
        status: nextStatus,
        leaseUntil: clearLease ? null : nextLease,
        leaseOwner: clearLease ? null : row.lease_owner,
        leaseToken: clearLease ? null : row.lease_token,
        updatedAt: now,
      });
      return this.events.appendEvent(input, now);
    });
  }

  startTask(taskId: string, idempotencyKey: string, leaseToken: string, expectedVersion?: number): TaskEvent {
    return this.sendEvent({
      taskId,
      sender: "zcode",
      recipient: "codex",
      type: "PROGRESS",
      payload: { phase: "started", summary: "Task execution started" },
      idempotencyKey,
      leaseToken,
      expectedVersion,
    });
  }

  async waitEvents(input: WaitEventsInput): Promise<TaskEvent[]> {
    if (input.taskId !== undefined) {
      const row = this.getTaskRow(input.taskId);
      if (row !== undefined) this.assertTaskRowAllowed(row);
    }
    const timeoutMs = input.timeoutMs ?? 30_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000) {
      throw new ConcordiaException("INVALID_INPUT", "timeoutMs must be an integer from 0 to 60000");
    }
    const limit = input.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new ConcordiaException("INVALID_INPUT", "Event limit must be an integer from 1 to 100");
    }
    if (!Number.isInteger(input.afterEventId) || input.afterEventId < 0) {
      throw new ConcordiaException("INVALID_INPUT", "afterEventId must be a non-negative integer");
    }

    const deadline = Date.now() + timeoutMs;
    let scanAfterEventId = input.afterEventId;
    let authorizationFingerprint: string | undefined;
    do {
      // Re-check the shared configuration on every poll. This makes an active
      // long poll fail closed when the config becomes unavailable, and makes a
      // targeted wait reject as soon as that task's workspace is revoked.
      const authorization = this.workspace.authorizationSnapshot();
      if (authorizationFingerprint !== authorization.fingerprint) {
        authorizationFingerprint = authorization.fingerprint;
        scanAfterEventId = input.afterEventId;
      }
      if (input.taskId !== undefined) {
        const row = this.getTaskRow(input.taskId);
        if (row !== undefined) this.assertTaskRowAllowed(row, authorization);
      }
      const scan = this.listAllowedEvents(input, limit, authorization, scanAfterEventId);
      scanAfterEventId = scan.scannedThroughEventId;
      if (scan.events.length > 0 || Date.now() >= deadline) return scan.events;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(500, deadline - Date.now())));
    } while (true);
  }

  submitTask(submission: TaskSubmission, expectedVersion?: number): TaskDetail {
    validateIdempotencyKey(submission.idempotencyKey);
    this.assertTaskAllowed(submission.taskId);
    const duplicate = this.events.getByIdempotencyKey(submission.idempotencyKey);
    if (duplicate) {
      this.assertDuplicateSubmission(duplicate, submission);
      return this.getTask(submission.taskId);
    }
    requireNonEmptyString(submission.commit, "commit");
    requireNonEmptyString(submission.summary, "summary");
    if (!Array.isArray(submission.changedFiles) || !Array.isArray(submission.checks) || !Array.isArray(submission.risks)) {
      throw new ConcordiaException("INVALID_INPUT", "Submission changedFiles, checks, and risks must be arrays");
    }

    const beforeVerification = this.requireTaskRow(submission.taskId);
    this.assertExpectedVersion(beforeVerification, expectedVersion);
    this.assertStatus(beforeVerification, ["RUNNING"]);
    this.assertLease(beforeVerification, beforeVerification.assignee ?? "zcode", new Date().toISOString(), submission.leaseToken);
    if (!beforeVerification.worktree_path || !beforeVerification.base_commit) {
      throw new ConcordiaException("WORKSPACE_DENIED", "Task has no active worktree or base commit");
    }
    const spec = JSON.parse(beforeVerification.spec_json) as TaskSpec;
    this.workspace.verifySubmission({
      workspace: beforeVerification.workspace,
      worktreePath: beforeVerification.worktree_path,
      baseCommit: beforeVerification.base_commit,
      commit: submission.commit,
      changedFiles: submission.changedFiles,
      ownedPaths: spec.ownedPaths,
      excludedPaths: spec.excludedPaths,
    });

    return this.database.transaction(() => {
      const duplicateInTransaction = this.events.getByIdempotencyKey(submission.idempotencyKey);
      if (duplicateInTransaction) {
        this.assertDuplicateSubmission(duplicateInTransaction, submission);
        return this.getTask(submission.taskId);
      }
      const row = this.requireTaskRow(submission.taskId);
      this.assertExpectedVersion(row, expectedVersion ?? beforeVerification.version);
      this.assertStatus(row, ["RUNNING"]);
      this.assertLease(row, row.assignee ?? "zcode", new Date().toISOString(), submission.leaseToken);
      const now = new Date().toISOString();
      this.updateTask(row, {
        status: "REVIEW",
        leaseOwner: null,
        leaseUntil: null,
        leaseToken: null,
        updatedAt: now,
      });
      this.events.appendEvent({
        taskId: submission.taskId,
        sender: "zcode",
        recipient: "codex",
        type: "COMPLETED",
        payload: withoutLeaseToken(submission),
        idempotencyKey: submission.idempotencyKey,
      }, now);
      this.database.connection.prepare(`
        INSERT INTO artifacts (task_id, kind, local_path, checksum, metadata_json, created_at)
        VALUES (?, 'commit', ?, ?, ?, ?)
      `).run(submission.taskId, row.worktree_path, submission.commit, JSON.stringify({ changedFiles: submission.changedFiles }), now);
      for (const check of submission.checks) {
        if (!check || typeof check.commandId !== "string" || !Number.isInteger(check.exitCode) || typeof check.summary !== "string") {
          throw new ConcordiaException("INVALID_INPUT", "Submission contains an invalid check result");
        }
        if (!this.allowedCheckCommandIds.has(check.commandId)) {
          throw new ConcordiaException("INVALID_INPUT", "Submission contains a check command ID outside the server whitelist", false, {
            commandId: check.commandId,
          });
        }
        if (check.logPath) {
          const logPath = normalizeRelativePath(check.logPath, "check.logPath");
          this.database.connection.prepare(`
            INSERT INTO artifacts (task_id, kind, local_path, metadata_json, created_at)
            VALUES (?, 'check_log', ?, ?, ?)
          `).run(submission.taskId, logPath, JSON.stringify({ commandId: check.commandId, exitCode: check.exitCode }), now);
        }
      }
      return this.getTask(submission.taskId);
    });
  }

  reviewTask(input: ReviewTaskInput): TaskDetail {
    validateIdempotencyKey(input.idempotencyKey);
    this.assertTaskAllowed(input.taskId);
    const duplicate = this.events.getByIdempotencyKey(input.idempotencyKey);
    if (duplicate) {
      this.assertDuplicateReview(duplicate, input);
      return this.getTask(input.taskId);
    }
    if (input.decision === "approve") requireNonEmptyString(input.summary, "summary");
    else if (!Array.isArray(input.findings) || input.findings.length === 0) {
      throw new ConcordiaException("INVALID_INPUT", "request_changes requires at least one finding");
    }

    return this.database.transaction(() => {
      const duplicateInTransaction = this.events.getByIdempotencyKey(input.idempotencyKey);
      if (duplicateInTransaction) {
        this.assertDuplicateReview(duplicateInTransaction, input);
        return this.getTask(input.taskId);
      }
      const row = this.requireTaskRow(input.taskId);
      this.assertExpectedVersion(row, input.expectedVersion);
      this.assertStatus(row, ["REVIEW"]);
      const now = new Date().toISOString();
      if (input.decision === "approve") {
        this.updateTask(row, {
          status: "APPROVED",
          leaseOwner: null,
          leaseUntil: null,
          leaseToken: null,
          updatedAt: now,
        });
        this.events.appendEvent({
          taskId: input.taskId,
          sender: "codex",
          recipient: "zcode",
          type: "APPROVED",
          payload: { summary: input.summary },
          idempotencyKey: input.idempotencyKey,
        }, now);
      } else {
        this.updateTask(row, {
          status: "READY",
          leaseOwner: null,
          leaseUntil: null,
          leaseToken: null,
          updatedAt: now,
        });
        this.events.appendEvent({
          taskId: input.taskId,
          sender: "codex",
          recipient: "zcode",
          type: "CHANGES_REQUESTED",
          payload: { findings: input.findings },
          idempotencyKey: input.idempotencyKey,
        }, now);
      }
      return this.getTask(input.taskId);
    });
  }

  private validateDuplicateEvent(existing: TaskEvent, input: SendEventInput): TaskEvent {
    let samePayload = false;
    try {
      samePayload = JSON.stringify(existing.payload) === JSON.stringify(input.payload);
    } catch {
      throw new ConcordiaException("INVALID_INPUT", "Event payload must be JSON serializable");
    }
    if (
      existing.taskId !== input.taskId
      || existing.sender !== input.sender
      || existing.recipient !== input.recipient
      || existing.type !== input.type
      || !samePayload
    ) {
      throw new ConcordiaException("INVALID_INPUT", "idempotencyKey was already used for another operation");
    }
    return existing;
  }

  private assertDuplicateSubmission(existing: TaskEvent, submission: TaskSubmission): void {
    const samePayload = JSON.stringify(existing.payload) === JSON.stringify(withoutLeaseToken(submission));
    if (existing.type !== "COMPLETED" || existing.taskId !== submission.taskId || !samePayload) {
      throw new ConcordiaException("INVALID_INPUT", "idempotencyKey was already used for another operation");
    }
  }

  private assertDuplicateReview(existing: TaskEvent, input: ReviewTaskInput): void {
    const expectedType = input.decision === "approve" ? "APPROVED" : "CHANGES_REQUESTED";
    const expectedPayload = input.decision === "approve"
      ? { summary: input.summary }
      : { findings: input.findings };
    if (
      existing.taskId !== input.taskId
      || existing.type !== expectedType
      || JSON.stringify(existing.payload) !== JSON.stringify(expectedPayload)
    ) {
      throw new ConcordiaException("INVALID_INPUT", "idempotencyKey was already used for another operation");
    }
  }

  private assertStatus(row: TaskRow, allowed: readonly TaskStatus[]): void {
    if (!allowed.includes(row.status as TaskStatus)) {
      throw new ConcordiaException("INVALID_TRANSITION", `Task cannot transition from ${row.status}`, false, {
        status: row.status,
        allowed,
      });
    }
  }

  private assertLease(row: TaskRow, owner: string, now: string, token: string | undefined): void {
    if (
      row.lease_owner !== owner
      || !row.lease_until
      || row.lease_until <= now
      || !this.matchesLeaseToken(row.lease_token, token)
    ) {
      throw new ConcordiaException("LEASE_CONFLICT", "Task lease is missing, expired, or held by another agent", true);
    }
  }

  private assertActiveLease(row: TaskRow, now: string, token: string | undefined): void {
    if (
      !row.lease_owner
      || row.lease_owner !== row.assignee
      || !row.lease_until
      || row.lease_until <= now
      || !this.matchesLeaseToken(row.lease_token, token)
    ) {
      throw new ConcordiaException("LEASE_CONFLICT", "Task lease is missing, expired, or inconsistent with its assignee", true);
    }
  }

  private matchesLeaseToken(expected: string | null, actual: string | undefined): boolean {
    if (!expected || !actual) return false;
    const expectedBytes = Buffer.from(expected);
    const actualBytes = Buffer.from(actual);
    return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
  }

  private assertExpectedVersion(row: TaskRow, expected: number | undefined): void {
    if (expected !== undefined && row.version !== expected) {
      throw new ConcordiaException("STALE_VERSION", "Task version is stale", true, {
        expected,
        actual: row.version,
      });
    }
  }

  private updateTask(
    row: TaskRow,
    update: {
      status: TaskStatus;
      leaseOwner: string | null;
      leaseUntil: string | null;
      leaseToken: string | null;
      updatedAt: string;
    },
  ): void {
    const result = this.database.connection.prepare(`
      UPDATE tasks
      SET status = ?, lease_owner = ?, lease_until = ?, lease_token = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND version = ?
    `).run(update.status, update.leaseOwner, update.leaseUntil, update.leaseToken, update.updatedAt, row.id, row.version);
    if (Number(result.changes) !== 1) {
      throw new ConcordiaException("STALE_VERSION", "Task was modified concurrently", true);
    }
  }

  private getTaskRow(taskId: string): TaskRow | undefined {
    return this.database.connection.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as unknown as TaskRow | undefined;
  }

  private requireTaskRow(taskId: string): TaskRow {
    const row = this.getTaskRow(taskId);
    if (!row) throw new ConcordiaException("TASK_NOT_FOUND", "Task was not found");
    this.assertTaskRowAllowed(row);
    return row;
  }

  private assertTaskAllowed(
    taskId: string,
    authorization: WorkspaceAuthorization = this.workspace.authorizationSnapshot(),
  ): void {
    this.assertTaskRowAllowed(this.requireExistingTaskRow(taskId), authorization);
  }

  private requireExistingTaskRow(taskId: string): TaskRow {
    const row = this.getTaskRow(taskId);
    if (!row) throw new ConcordiaException("TASK_NOT_FOUND", "Task was not found");
    return row;
  }

  private assertTaskRowAllowed(
    row: TaskRow,
    authorization: WorkspaceAuthorization = this.workspace.authorizationSnapshot(),
  ): void {
    authorization.assertWorkspaceAllowed(row.workspace);
  }

  private isTaskRowAllowed(row: TaskRow, authorization: WorkspaceAuthorization): boolean {
    try {
      this.assertTaskRowAllowed(row, authorization);
      return true;
    } catch (error) {
      if (error instanceof ConcordiaException && error.code === "WORKSPACE_DENIED") return false;
      throw error;
    }
  }

  private listAllowedEvents(
    input: WaitEventsInput,
    limit: number,
    authorization: WorkspaceAuthorization,
    initialAfterEventId: number,
  ): { events: TaskEvent[]; scannedThroughEventId: number } {
    const events: TaskEvent[] = [];
    let afterEventId = initialAfterEventId;
    do {
      const batch = this.events.listEvents({
        taskId: input.taskId,
        recipient: input.recipient,
        afterEventId,
        limit: 100,
      });
      if (batch.length === 0) return { events, scannedThroughEventId: afterEventId };
      const rowsByTaskId = this.getTaskRows(batch.map((event) => event.taskId));
      for (const event of batch) {
        const row = rowsByTaskId.get(event.taskId);
        if (row !== undefined && this.isTaskRowAllowed(row, authorization)) {
          events.push(event);
          if (events.length === limit) {
            return { events, scannedThroughEventId: event.eventId };
          }
        }
      }
      afterEventId = batch.at(-1)!.eventId;
      if (batch.length < 100) return { events, scannedThroughEventId: afterEventId };
    } while (true);
  }

  private getTaskRows(taskIds: readonly string[]): ReadonlyMap<string, TaskRow> {
    const uniqueTaskIds = [...new Set(taskIds)];
    if (uniqueTaskIds.length === 0) return new Map();
    const rows = this.database.connection.prepare(`
      SELECT * FROM tasks WHERE id IN (${uniqueTaskIds.map(() => "?").join(", ")})
    `).all(...uniqueTaskIds) as unknown as TaskRow[];
    return new Map(rows.map((row) => [row.id, row]));
  }

  private requireTask(taskId: string): TaskRecord {
    return parseTask(this.requireTaskRow(taskId));
  }
}

export function createTask(service: TaskService, spec: TaskSpec, idempotencyKey: string): CreateTaskResult {
  return service.createTask(spec, idempotencyKey);
}

export function claimTask(service: TaskService, input: ClaimTaskInput): ClaimTaskResult {
  return service.claimTask(input);
}
