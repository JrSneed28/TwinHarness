/**
 * Atomic, retrying file writer + retrying reader (C-2 / M-3).
 *
 * The state store writes JSON by writing a temp file then `rename`-ing it over
 * the target — atomic within a directory, so a crashed/partial write is never
 * observed. The hazard the original code ignored: on Windows, `rename` over a
 * file that a CONCURRENT READER holds open throws `EPERM` (and, under some
 * filesystems / antivirus interception, `EACCES`/`EBUSY`). Writers hold the state
 * lock but readers do not (`readState` is used by hooks, MCP, and `state get`),
 * so an unguarded rename loses the write — leaving e.g. `drift_open_blocking` too
 * low and letting the Stop hook pass a run it should block.
 *
 * `atomicWriteFile` retries the rename with a short escalating busy-wait
 * (the CLI is synchronous; there is no event loop to await) and, only after the
 * budget is exhausted, throws a typed {@link StateWriteContendedError} so the CLI
 * boundary can surface a clean structured failure instead of a raw crash.
 * `readFileWithRetry` retries once on a transient read error (a reader that
 * collides with a concurrent rename).
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Transient, retryable I/O errors caused by concurrent access (not real faults). */
function isTransientIoError(code: string | undefined): boolean {
  return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

/** Bounded retry budget for the rename. ~12 tries with an escalating short
 * busy-wait keeps the total well under ~1s while comfortably outlasting a
 * reader's microsecond-scale open window. */
const MAX_RENAME_ATTEMPTS = 12;

/**
 * Thrown by {@link atomicWriteFile} when the rename could not complete within the
 * retry budget (sustained contention). Carries a stable `code` so the CLI
 * boundary maps it to `failure({ error: "state_write_contended" })` rather than
 * letting an uncaught throw reproduce the original C-2 crash with a new name.
 */
export class StateWriteContendedError extends Error {
  readonly code = "state_write_contended";
  constructor(absPath: string, attempts: number) {
    super(
      `could not atomically write ${absPath} after ${attempts} attempts: the file is contended ` +
        `by concurrent readers/writers. This is transient — retry the command.`,
    );
    this.name = "StateWriteContendedError";
  }
}

function busyWait(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    /* synchronous CLI: no event loop to yield to */
  }
}

/**
 * Write `content` to `absPath` atomically (write temp, then rename over target),
 * creating parent directories as needed. Retries the rename on a transient
 * contention error with a short escalating backoff; throws
 * {@link StateWriteContendedError} only after the budget is exhausted, and a
 * non-transient error immediately. Never leaves the temp file behind on failure.
 *
 * `rename` is injectable so the retry path is unit-testable without mocking the
 * (non-configurable) `node:fs` module; production callers omit it.
 */
export function atomicWriteFile(
  absPath: string,
  content: string,
  rename: (from: string, to: string) => void = fs.renameSync,
): void {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const tmp = `${absPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tmp, content, "utf8");

  for (let attempt = 1; ; attempt++) {
    try {
      rename(tmp, absPath);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      const transient = isTransientIoError(code);
      if (!transient || attempt >= MAX_RENAME_ATTEMPTS) {
        // Give up: clean the temp file, then surface the right error shape.
        try {
          fs.rmSync(tmp, { force: true });
        } catch {
          /* best-effort cleanup */
        }
        if (transient) throw new StateWriteContendedError(absPath, attempt);
        throw e; // genuine, non-transient failure (ENOSPC, EROFS, …)
      }
      busyWait(Math.min(4 * attempt, 40)); // ~4,8,…,40ms — total budget < ~1s
    }
  }
}

/**
 * Read a UTF-8 file, retrying ONCE on a transient contention error (a reader that
 * collided with a concurrent atomic rename). A genuine error (ENOENT, …) is not
 * retried and propagates immediately. `read` is injectable for testing; production
 * callers omit it.
 */
export function readFileWithRetry(
  absPath: string,
  read: (p: string) => string = (p) => fs.readFileSync(p, "utf8"),
): string {
  try {
    return read(absPath);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (!isTransientIoError(code)) throw e;
    busyWait(10);
    return read(absPath);
  }
}
