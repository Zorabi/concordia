import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

import { ConcordiaException } from "./protocol.js";

export function concordiaHome(
  configured = process.env.CONCORDIA_HOME,
  userHome = homedir(),
): string {
  if (configured === undefined || configured.trim() === "") {
    return resolve(userHome, ".concordia");
  }
  if (!isAbsolute(configured)) {
    throw new ConcordiaException("INVALID_INPUT", "CONCORDIA_HOME must be an absolute path");
  }
  return resolve(configured);
}

export function defaultStateDatabasePath(
  configured = process.env.CONCORDIA_HOME,
  userHome = homedir(),
): string {
  return resolve(concordiaHome(configured, userHome), "state.db");
}

export function defaultCodexWakerDatabasePath(
  configured = process.env.CONCORDIA_HOME,
  userHome = homedir(),
): string {
  return resolve(concordiaHome(configured, userHome), "codex-waker.db");
}

export function defaultZCodeWakerDatabasePath(
  configured = process.env.CONCORDIA_HOME,
  userHome = homedir(),
): string {
  return resolve(concordiaHome(configured, userHome), "zcode-waker.db");
}
