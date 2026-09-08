import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { delimiter, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";

import { ConcordiaException, type TaskSpec } from "./protocol.js";

export interface WorktreeResult {
  workspace: string;
  worktreePath: string;
  baseCommit: string;
  created: boolean;
}

export interface VerifySubmissionInput {
  workspace: string;
  worktreePath: string;
  baseCommit: string;
  commit: string;
  changedFiles: string[];
  ownedPaths: string[];
  excludedPaths?: string[];
}

function parseConfiguredRoots(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(delimiter)
    .flatMap((part) => part.split(","))
    .map((part) => part.trim())
    .filter(Boolean);
}

function isWithin(parent: string, child: string): boolean {
  const pathFromParent = relative(parent, child);
  return pathFromParent === "" || (!pathFromParent.startsWith(`..${sep}`) && pathFromParent !== ".." && !isAbsolute(pathFromParent));
}

function normalizeRelativePath(input: string, field: string): string {
  if (typeof input !== "string" || input.trim() === "" || input.includes("\0")) {
    throw new ConcordiaException("INVALID_INPUT", `${field} must be a non-empty relative path`);
  }
  if (input.includes("\\")) {
    throw new ConcordiaException("PATH_SCOPE_VIOLATION", `${field} must use unambiguous POSIX path separators`);
  }
  const portable = input;
  if (portable.startsWith("/") || /^[A-Za-z]:\//.test(portable)) {
    throw new ConcordiaException("PATH_SCOPE_VIOLATION", `${field} must be relative to the workspace`);
  }
  const segments = portable.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0 || segments.some((segment) => segment === "..")) {
    throw new ConcordiaException("PATH_SCOPE_VIOLATION", `${field} escapes the workspace`);
  }
  return segments.join("/");
}

function matchesScope(file: string, scope: string): boolean {
  return file === scope || file.startsWith(`${scope}/`);
}

export class WorkspaceManager {
  readonly allowedRoots: readonly string[];

  constructor(roots: readonly string[] = parseConfiguredRoots(process.env.CONCORDIA_ROOTS)) {
    if (roots.length === 0) {
      throw new ConcordiaException("INVALID_INPUT", "CONCORDIA_ROOTS must contain at least one allowed root");
    }
    this.allowedRoots = roots.map((root) => {
      try {
        return realpathSync(root);
      } catch {
        throw new ConcordiaException("WORKSPACE_DENIED", "An allowed workspace root does not exist");
      }
    });
  }

  resolveWorkspace(workspace: string): string {
    let canonical: string;
    try {
      canonical = realpathSync(workspace);
    } catch {
      throw new ConcordiaException("WORKSPACE_DENIED", "Workspace does not exist or cannot be accessed");
    }
    if (!this.allowedRoots.some((root) => isWithin(root, canonical))) {
      throw new ConcordiaException("WORKSPACE_DENIED", "Workspace is outside the configured roots");
    }
    const gitRoot = this.git(canonical, ["rev-parse", "--show-toplevel"], "WORKSPACE_DENIED", "Workspace is not a Git repository");
    let canonicalGitRoot: string;
    try {
      canonicalGitRoot = realpathSync(gitRoot);
    } catch {
      throw new ConcordiaException("WORKSPACE_DENIED", "Git workspace cannot be resolved");
    }
    if (canonicalGitRoot !== canonical) {
      throw new ConcordiaException("WORKSPACE_DENIED", "Workspace must be the root of a Git repository");
    }
    return canonical;
  }

  validateSpec(spec: TaskSpec): TaskSpec {
    const workspace = this.resolveWorkspace(spec.workspace);
    const ownedPaths = this.validateScopes(workspace, spec.ownedPaths, "ownedPaths");
    const excludedPaths = spec.excludedPaths === undefined
      ? undefined
      : this.validateScopes(workspace, spec.excludedPaths, "excludedPaths");
    const baseCommit = this.resolveCommit(workspace, spec.baseCommit ?? "HEAD", "BASE_COMMIT_MISMATCH");
    return { ...spec, workspace, baseCommit, ownedPaths, ...(excludedPaths === undefined ? {} : { excludedPaths }) };
  }

  resolveCommit(workspace: string, revision: string, code: "BASE_COMMIT_MISMATCH" | "INVALID_INPUT" = "INVALID_INPUT"): string {
    return this.git(workspace, ["rev-parse", "--verify", `${revision}^{commit}`], code, "Git commit could not be resolved");
  }

  assertBaseCommit(workspace: string, expected: string): string {
    const actual = this.resolveCommit(workspace, expected, "BASE_COMMIT_MISMATCH");
    if (actual !== expected) {
      throw new ConcordiaException("BASE_COMMIT_MISMATCH", "The task base commit no longer resolves to the expected commit", false, {
        expected,
        actual,
      });
    }
    return actual;
  }

  ensureWorktree(
    taskId: string,
    workspaceInput: string,
    baseCommit: string,
    attempt: number,
    previousWorktreePath?: string,
  ): WorktreeResult {
    const workspace = this.resolveWorkspace(workspaceInput);
    this.assertBaseCommit(workspace, baseCommit);
    if (!Number.isInteger(attempt) || attempt < 1) {
      throw new ConcordiaException("INVALID_INPUT", "Worktree attempt must be a positive integer");
    }
    const safeTaskId = taskId.replace(/[^A-Za-z0-9._-]/g, "-");
    if (!safeTaskId) {
      throw new ConcordiaException("INVALID_INPUT", "Task ID must contain a safe path character");
    }
    const requestedWorktreesDirectory = resolve(workspace, ".worktrees");
    if (!existsSync(requestedWorktreesDirectory)) {
      try {
        mkdirSync(requestedWorktreesDirectory, { recursive: true, mode: 0o700 });
      } catch {
        throw new ConcordiaException("WORKSPACE_DENIED", "Worktree directory cannot be created safely");
      }
    }
    let worktreesDirectory: string;
    try {
      worktreesDirectory = realpathSync(requestedWorktreesDirectory);
    } catch {
      throw new ConcordiaException("WORKSPACE_DENIED", "Worktree directory cannot be resolved");
    }
    if (!isWithin(workspace, worktreesDirectory) || !lstatSync(worktreesDirectory).isDirectory()) {
      throw new ConcordiaException("WORKSPACE_DENIED", "Worktree directory resolves outside the repository");
    }
    const worktreePath = resolve(worktreesDirectory, `${safeTaskId}-zcode-a${attempt}`);
    if (!isWithin(workspace, worktreePath)) {
      throw new ConcordiaException("WORKSPACE_DENIED", "Worktree path escapes the repository");
    }

    if (existsSync(worktreePath)) {
      const canonicalWorktree = realpathSync(worktreePath);
      if (!isWithin(workspace, canonicalWorktree)) {
        throw new ConcordiaException("WORKSPACE_DENIED", "Existing worktree resolves outside the repository");
      }
      const actualRoot = this.git(canonicalWorktree, ["rev-parse", "--show-toplevel"], "WORKSPACE_DENIED", "Existing worktree is invalid");
      if (realpathSync(actualRoot) !== canonicalWorktree) {
        throw new ConcordiaException("WORKSPACE_DENIED", "Existing worktree is not the expected Git root");
      }
      this.assertAncestor(canonicalWorktree, baseCommit, "HEAD");
      return { workspace, worktreePath: canonicalWorktree, baseCommit, created: false };
    }

    const startCommit = this.recoverySnapshot(workspace, baseCommit, previousWorktreePath);
    const branch = `concordia/${safeTaskId}-zcode-a${attempt}`;
    try {
      this.git(workspace, ["worktree", "add", "-b", branch, worktreePath, startCommit], "INTERNAL_ERROR", "Unable to create task worktree");
    } catch (error) {
      // A previous interrupted run may have created the branch but not the worktree.
      if (!this.refExists(workspace, `refs/heads/${branch}`)) throw error;
      this.assertAncestor(workspace, baseCommit, branch);
      this.git(workspace, ["worktree", "add", worktreePath, branch], "INTERNAL_ERROR", "Unable to recover task worktree");
    }
    const canonicalWorktree = realpathSync(worktreePath);
    if (!isWithin(workspace, canonicalWorktree)) {
      throw new ConcordiaException("WORKSPACE_DENIED", "Created worktree resolves outside the repository");
    }
    return { workspace, worktreePath: canonicalWorktree, baseCommit, created: true };
  }

  verifySubmission(input: VerifySubmissionInput): string[] {
    const workspace = this.resolveWorkspace(input.workspace);
    let worktreePath: string;
    try {
      worktreePath = realpathSync(input.worktreePath);
    } catch {
      throw new ConcordiaException("WORKSPACE_DENIED", "Task worktree does not exist");
    }
    if (!isWithin(workspace, worktreePath)) {
      throw new ConcordiaException("WORKSPACE_DENIED", "Task worktree is outside its repository");
    }
    this.assertBaseCommit(workspace, input.baseCommit);
    const commit = this.resolveCommit(worktreePath, input.commit);
    if (commit !== input.commit) {
      throw new ConcordiaException("INVALID_INPUT", "Submission commit must be a full immutable commit SHA");
    }
    const currentHead = this.resolveCommit(worktreePath, "HEAD");
    if (commit !== currentHead) {
      throw new ConcordiaException("INVALID_INPUT", "Submission commit must be the current attempt worktree HEAD");
    }
    this.assertAncestor(worktreePath, input.baseCommit, commit);

    const changedFiles = this.gitRaw(worktreePath, ["diff", "--name-only", "-z", `${input.baseCommit}..${commit}`], "INTERNAL_ERROR", "Unable to inspect submission diff")
      .split("\0")
      .filter(Boolean)
      .map((file, index) => normalizeRelativePath(file, `changedFiles[${index}]`))
      .sort();
    const declared = input.changedFiles
      .map((file, index) => normalizeRelativePath(file, `changedFiles[${index}]`))
      .sort();
    if (new Set(declared).size !== declared.length || changedFiles.join("\0") !== declared.join("\0")) {
      throw new ConcordiaException("INVALID_INPUT", "Submission changedFiles does not match the Git diff", false, {
        actualChangedFiles: changedFiles,
      });
    }
    this.assertOwnedPaths(changedFiles, input.ownedPaths, input.excludedPaths);
    const touchedFiles = new Set<string>();
    const commits = this.gitRaw(
      worktreePath,
      ["rev-list", "--reverse", `${input.baseCommit}..${commit}`],
      "INTERNAL_ERROR",
      "Unable to inspect submission history",
    ).split("\n").filter(Boolean);
    for (const historyCommit of commits) {
      const touched = this.gitRaw(
        worktreePath,
        ["diff-tree", "--no-commit-id", "--name-only", "-r", "-m", "-z", historyCommit],
        "INTERNAL_ERROR",
        "Unable to inspect submission history",
      ).split("\0").filter(Boolean);
      touched.forEach((file) => touchedFiles.add(normalizeRelativePath(file, "historyFile")));
    }
    this.assertOwnedPaths([...touchedFiles], input.ownedPaths, input.excludedPaths);
    const pendingFiles = new Set<string>();
    for (const args of [
      ["diff", "--name-only", "-z"],
      ["diff", "--cached", "--name-only", "-z"],
      ["ls-files", "--others", "--exclude-standard", "-z"],
    ]) {
      for (const file of this.gitRaw(worktreePath, args, "INTERNAL_ERROR", "Unable to inspect pending worktree changes").split("\0")) {
        if (file) pendingFiles.add(normalizeRelativePath(file, "pendingFile"));
      }
    }
    this.assertOwnedPaths([...pendingFiles], input.ownedPaths, input.excludedPaths);
    return changedFiles;
  }

  assertOwnedPaths(files: readonly string[], ownedPaths: readonly string[], excludedPaths: readonly string[] = []): void {
    const owned = ownedPaths.map((path, index) => normalizeRelativePath(path, `ownedPaths[${index}]`));
    const excluded = excludedPaths.map((path, index) => normalizeRelativePath(path, `excludedPaths[${index}]`));
    const violations = files
      .map((file, index) => normalizeRelativePath(file, `files[${index}]`))
      .filter((file) => !owned.some((scope) => matchesScope(file, scope)) || excluded.some((scope) => matchesScope(file, scope)));
    if (violations.length > 0) {
      throw new ConcordiaException("PATH_SCOPE_VIOLATION", "Submission modifies files outside the task path scope", false, {
        files: violations,
      });
    }
  }

  private validateScopes(workspace: string, values: readonly string[], field: string): string[] {
    return values.map((value, index) => {
      const normalized = normalizeRelativePath(value, `${field}[${index}]`);
      if (
        normalized === ".git" || normalized.startsWith(".git/")
        || normalized === ".concordia" || normalized.startsWith(".concordia/")
        || normalized === ".worktrees" || normalized.startsWith(".worktrees/")
      ) {
        throw new ConcordiaException("PATH_SCOPE_VIOLATION", `${field}[${index}] targets Concordia or Git control data`);
      }
      const candidate = resolve(workspace, normalized);
      let existing = candidate;
      while (!existsSync(existing)) {
        const parent = dirname(existing);
        if (parent === existing) break;
        existing = parent;
      }
      const canonicalParent = realpathSync(existing);
      if (!isWithin(workspace, canonicalParent)) {
        throw new ConcordiaException("PATH_SCOPE_VIOLATION", `${field}[${index}] resolves outside the workspace`);
      }
      if (existsSync(candidate) && lstatSync(candidate).isSymbolicLink()) {
        const canonical = realpathSync(candidate);
        if (!isWithin(workspace, canonical)) {
          throw new ConcordiaException("PATH_SCOPE_VIOLATION", `${field}[${index}] is a symlink outside the workspace`);
        }
      }
      return normalized;
    });
  }

  private refExists(workspace: string, ref: string): boolean {
    try {
      execFileSync("git", ["show-ref", "--verify", "--quiet", ref], { cwd: workspace, stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  private recoverySnapshot(workspace: string, baseCommit: string, previousWorktreePath: string | undefined): string {
    if (previousWorktreePath === undefined || !existsSync(previousWorktreePath)) return baseCommit;
    let previousWorktree: string;
    try {
      previousWorktree = realpathSync(previousWorktreePath);
    } catch {
      throw new ConcordiaException("WORKSPACE_DENIED", "Previous task worktree cannot be resolved");
    }
    if (!isWithin(workspace, previousWorktree)) {
      throw new ConcordiaException("WORKSPACE_DENIED", "Previous task worktree resolves outside the repository");
    }
    const actualRoot = this.git(
      previousWorktree,
      ["rev-parse", "--show-toplevel"],
      "WORKSPACE_DENIED",
      "Previous task worktree is invalid",
    );
    if (realpathSync(actualRoot) !== previousWorktree) {
      throw new ConcordiaException("WORKSPACE_DENIED", "Previous task worktree is not the expected Git root");
    }
    const snapshot = this.resolveCommit(previousWorktree, "HEAD", "BASE_COMMIT_MISMATCH");
    this.assertAncestor(previousWorktree, baseCommit, snapshot);
    return snapshot;
  }

  private assertAncestor(workspace: string, ancestor: string, descendant: string): void {
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
        cwd: workspace,
        stdio: "ignore",
      });
    } catch {
      throw new ConcordiaException("BASE_COMMIT_MISMATCH", "Task history does not descend from the configured base commit");
    }
  }

  private gitRaw(
    cwd: string,
    args: readonly string[],
    code: ConstructorParameters<typeof ConcordiaException>[0],
    message: string,
  ): string {
    try {
      return execFileSync("git", [...args], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 4 * 1024 * 1024,
      });
    } catch {
      throw new ConcordiaException(code, message);
    }
  }

  private git(
    cwd: string,
    args: readonly string[],
    code: ConstructorParameters<typeof ConcordiaException>[0],
    message: string,
  ): string {
    try {
      return execFileSync("git", [...args], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 4 * 1024 * 1024,
      }).trim();
    } catch {
      throw new ConcordiaException(code, message);
    }
  }
}

export { normalizeRelativePath };
