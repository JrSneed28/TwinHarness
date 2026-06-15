import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectPaths } from "./paths";
import {
  type TwinHarnessState,
  type ValidationIssue,
  serializeState,
  validateState,
} from "./state-schema";

export interface ReadStateResult {
  exists: boolean;
  raw?: string;
  /** Present only when the file parses AND validates. */
  state?: TwinHarnessState;
  /** Present when the file exists but is invalid JSON or fails schema validation. */
  issues?: ValidationIssue[];
}

/** Read + validate state.json. Distinguishes "missing" from "present but invalid". */
export function readState(paths: ProjectPaths): ReadStateResult {
  if (!fs.existsSync(paths.stateFile)) {
    return { exists: false };
  }
  const raw = fs.readFileSync(paths.stateFile, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { exists: true, raw, issues: [{ path: "$", message: `invalid JSON: ${(e as Error).message}` }] };
  }
  const result = validateState(parsed);
  if (!result.ok) {
    return { exists: true, raw, issues: result.issues };
  }
  return { exists: true, raw, state: result.state };
}

/**
 * Write state.json atomically (write temp, then rename over the target).
 *
 * The rename is atomic within the directory, so a crashed/partial write is never
 * observed and is *replaced, not duplicated* on resume (spec §18 idempotency).
 */
export function writeState(paths: ProjectPaths, state: TwinHarnessState): void {
  fs.mkdirSync(paths.stateDir, { recursive: true });
  const serialized = serializeState(state);
  const tmp = path.join(paths.stateDir, `state.json.tmp-${process.pid}`);
  fs.writeFileSync(tmp, serialized, "utf8");
  fs.renameSync(tmp, paths.stateFile);
}

/**
 * Run `fn` while holding an exclusive, cross-process advisory lock on the state
 * directory (audit finding F10).
 *
 * Each `th` invocation is a separate OS process. During a parallel build wave,
 * multiple Builders run `th drift add` / `th slice set-status` / `th artifact
 * register` concurrently — each a read-modify-write of state.json (and, for
 * drift, of drift-log.md and the next DRIFT-NNN id). Without a lock, two
 * concurrent mutations lose an update: a dropped requirement-layer `drift add`
 * would leave `drift_open_blocking` too low and let the stop-gate pass a run it
 * should block. This serializes the whole read→write span.
 *
 * The lock is an atomic `mkdir` on `<stateDir>/.state.lock`. It busy-waits
 * (the CLI is synchronous and each critical section is short), times out after
 * ~10s rather than hang forever, and steals a lock older than the stale
 * threshold so a crashed holder can't wedge the project permanently.
 *
 * Contention is recognized by THREE errno codes, not just `EEXIST`: on POSIX a
 * `mkdir` onto an existing dir throws `EEXIST`, but on Windows a concurrent
 * `mkdirSync` against a contended directory can instead throw `EPERM` (and, on
 * some filesystems / antivirus interception, `EACCES`). All three mean "the lock
 * is held — wait / steal-if-stale / retry", so treating only `EEXIST` as
 * contention rethrows the Windows codes and crashes the caller (REQ-PCO-000 /
 * REQ-STATE-LOCK-001 on windows-latest CI). This is the targeted fix only — the
 * mkdir mechanism is unchanged (no migration to flock).
 *
 * When the state directory does not yet exist there is no shared state to race
 * on, so `fn` runs directly without creating anything (preserves the behaviour
 * of commands that return "not initialized").
 */
/**
 * Classify a `mkdirSync` failure as "the lock is already held" (→ wait/steal/
 * retry) versus a genuine error (→ rethrow).
 *
 * Anchor: REQ-PCO-000 — POSIX signals contention with `EEXIST`; on Windows an
 * atomic `mkdir` on a contended directory can instead throw `EPERM` (and
 * sometimes `EACCES`). Treating only `EEXIST` as contention rethrows the Windows
 * codes and crashes the caller (REQ-STATE-LOCK-001 on windows-latest CI). Pure +
 * exported so the classification is unit-tested directly without mocking `fs`.
 */
export function isLockHeldError(code: string | undefined): boolean {
  return code === "EEXIST" || code === "EPERM" || code === "EACCES";
}

export function withStateLock<T>(paths: ProjectPaths, fn: () => T): T {
  if (!fs.existsSync(paths.stateDir)) return fn();

  const lockDir = path.join(paths.stateDir, ".state.lock");
  const STALE_MS = 30_000;
  const TIMEOUT_MS = 10_000;
  const deadline = Date.now() + TIMEOUT_MS;

  for (;;) {
    try {
      fs.mkdirSync(lockDir); // atomic test-and-set: throws EEXIST (POSIX) / EPERM|EACCES (Windows) if held
      break;
    } catch (e) {
      if (!isLockHeldError((e as NodeJS.ErrnoException).code)) throw e;
      // Held: steal if stale, else wait until the deadline.
      try {
        const age = Date.now() - fs.statSync(lockDir).mtimeMs;
        if (age > STALE_MS) {
          fs.rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue; // lock vanished between mkdir and stat — retry
      }
      if (Date.now() > deadline) {
        throw new Error(`state lock timeout: ${lockDir} is held; remove it if no \`th\` process is running.`);
      }
      const spinUntil = Date.now() + 20;
      while (Date.now() < spinUntil) {
        /* busy-wait: the CLI has no event loop to yield to */
      }
    }
  }

  try {
    return fn();
  } finally {
    try {
      fs.rmSync(lockDir, { recursive: true, force: true });
    } catch {
      // Best-effort release; a stale lock is reclaimed by the next caller.
    }
  }
}
