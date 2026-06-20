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
 * `atomicWriteFile` retries the rename with a short escalating zero-CPU wait
 * ({@link sleepSync} — the CLI is synchronous; there is no event loop to await,
 * and the old `while`-spin pegged a core during contention, PERF-007) and, only
 * after the budget is exhausted, throws a typed {@link StateWriteContendedError} so the CLI
 * boundary can surface a clean structured failure instead of a raw crash.
 * `readFileWithRetry` retries once on a transient read error (a reader that
 * collides with a concurrent rename).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { sleepSync } from "./sleep";
import { assertGovernedWriteSurface } from "./paths";

/**
 * Injectable fsync seam (AC#2) — the durability barrier, parameterized so the
 * fsync ORDERING (temp fd before rename, dir after) and the error-propagation /
 * win32-swallow split are unit-testable WITHOUT mocking the non-configurable
 * `node:fs` module (mirrors the injectable `rename`). Production callers omit it and
 * get the real `node:fs` fsync. A test passes a recording/throwing shim to assert
 * the calls happen, in order, and that a genuine fsync failure propagates while
 * only the truly-N/A win32 directory-handle codes are swallowed.
 *
 * - `fsyncFd(fd)` — flush a single open descriptor's data+metadata to the device.
 * - `openSync`/`closeSync` — mirror `fs.openSync`/`fs.closeSync` so the shim controls
 *   the whole open→fsync→close lifecycle a test needs to drive deterministically.
 */
export interface FsyncShim {
  openSync: (p: string, flags: string) => number;
  fsyncFd: (fd: number) => void;
  closeSync: (fd: number) => void;
}

/** The production fsync shim — straight `node:fs`. */
const REAL_FSYNC: FsyncShim = {
  openSync: (p, flags) => fs.openSync(p, flags),
  fsyncFd: (fd) => fs.fsyncSync(fd),
  closeSync: (fd) => fs.closeSync(fd),
};

/**
 * Directory-fsync error codes that are genuinely NOT-APPLICABLE on win32, where
 * the OS does not expose a directory handle that can be fsync'd. ONLY these are
 * swallowed, and ONLY for the directory fsync (never the temp-fd content fsync) and
 * ONLY on win32 — a real durability failure (ENOSPC, EIO, …) on any handle still
 * propagates. Branch (a), committed: we do NOT blanket-swallow dir-fsync; the
 * barrier stays honest.
 */
const WIN32_DIR_FSYNC_NA_CODES: ReadonlySet<string> = new Set([
  "EISDIR",
  "EINVAL",
  "EPERM",
  "EACCES",
]);

/**
 * fsync the FILE at `target` (temp fd) — content+metadata to the device — BEFORE
 * the rename. Errors PROPAGATE (consistent with the non-transient throw below): a
 * real ENOSPC/EIO on the content flush is a genuine durability failure the caller
 * must see, not a swallowed surprise. Open r+ (the file exists; we only flush it).
 */
function fsyncFile(target: string, shim: FsyncShim): void {
  const fd = shim.openSync(target, "r+");
  try {
    shim.fsyncFd(fd);
  } finally {
    shim.closeSync(fd);
  }
}

/**
 * fsync the containing DIRECTORY after a successful rename so the rename itself is
 * durable (the directory entry survives a crash). Genuine failures PROPAGATE
 * (branch a). On win32 ONLY, a directory handle may not be fsync-able at all — the
 * NOT-APPLICABLE codes in {@link WIN32_DIR_FSYNC_NA_CODES} are swallowed there (and
 * only there) because they signal "this platform cannot fsync a dir handle", not a
 * lost write. A non-N/A code (ENOSPC, EIO, …) still throws on every platform.
 */
function fsyncDir(dir: string, shim: FsyncShim): void {
  let fd: number;
  try {
    fd = shim.openSync(dir, "r");
  } catch (e) {
    if (process.platform === "win32" && isWin32DirFsyncNA((e as NodeJS.ErrnoException).code)) {
      return; // win32 cannot open a dir handle for fsync — genuinely N/A, not a lost write.
    }
    throw e;
  }
  try {
    shim.fsyncFd(fd);
  } catch (e) {
    if (process.platform === "win32" && isWin32DirFsyncNA((e as NodeJS.ErrnoException).code)) {
      return; // win32 dir-handle fsync is N/A — swallow ONLY here.
    }
    throw e;
  } finally {
    shim.closeSync(fd);
  }
}

/** Whether `code` is a genuinely-N/A win32 directory-fsync error (swallow-eligible). */
function isWin32DirFsyncNA(code: string | undefined): boolean {
  return code !== undefined && WIN32_DIR_FSYNC_NA_CODES.has(code);
}

/** Transient, retryable I/O errors caused by concurrent access (not real faults). */
function isTransientIoError(code: string | undefined): boolean {
  return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

/** Bounded retry budget for a contended rename OR read. ~12 tries with an
 * escalating short zero-CPU wait ({@link sleepSync}) keeps the total well under
 * ~1s while comfortably outlasting a colliding open/rename window. Shared by
 * writer and reader so the read side is no weaker than the write side. */
const MAX_IO_ATTEMPTS = 12;

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


/**
 * Write `content` to `absPath` atomically (write temp, then rename over target),
 * creating parent directories as needed. Retries the rename on a transient
 * contention error with a short escalating backoff; throws
 * {@link StateWriteContendedError} only after the budget is exhausted, and a
 * non-transient error immediately. Never leaves the temp file behind on failure.
 *
 * `rename` is injectable so the retry path is unit-testable without mocking the
 * (non-configurable) `node:fs` module; production callers omit it. `fsync` is
 * likewise injectable (the durability barrier seam — AC#2).
 *
 * AC#1 write-surface guard: when `opts.root` is supplied (the governed project
 * root, threaded by every TwinHarness writer from `ProjectPaths.root`), the target
 * is asserted to be inside the governed write-surface allowlist
 * ({@link assertGovernedWriteSurface}) BEFORE the temp write — so a write outside
 * `.twinharness`/`.agentic-sdlc`/`docs`/`drift-log.md` throws {@link WriteSurfaceError}
 * at this shared chokepoint, not by convention in each caller. The guard fires
 * before any byte hits disk (no temp leak on rejection).
 *
 * AC#2 crash-durability: after the temp write and BEFORE the rename, the temp fd is
 * fsync'd (content+metadata to the device); after a successful rename, the
 * containing directory is fsync'd (so the rename itself survives a crash). Content
 * fsync errors PROPAGATE (a real ENOSPC must surface); directory fsync propagates
 * genuine failures and swallows ONLY the genuinely-N/A win32 dir-handle codes
 * (branch a — no durability theater).
 */
export interface AtomicWriteOptions {
  /**
   * The governed project root. When present, the target is asserted to be within
   * the governed write-surface allowlist before any write (AC#1). Omitting it
   * skips the guard — used only by call sites that have already contained the path
   * by other means; every `ProjectPaths`-derived writer threads `paths.root`.
   */
  root?: string;
  /** Injectable rename (retry-path testability) — production omits it. */
  rename?: (from: string, to: string) => void;
  /** Injectable fsync seam (durability-ordering testability) — production omits it. */
  fsync?: FsyncShim;
}

/** The injectable rename type, accepted positionally for back-compat (see below). */
type RenameFn = (from: string, to: string) => void;

export function atomicWriteFile(
  absPath: string,
  content: string,
  // Back-compat: the 3rd arg historically WAS the injectable `rename` function; it
  // is now the options bag (root / rename / fsync). A bare function is still
  // accepted and normalized to `{ rename }` so existing callers/tests that inject a
  // rename positionally keep working unchanged.
  optsOrRename: AtomicWriteOptions | RenameFn = {},
): void {
  const opts: AtomicWriteOptions =
    typeof optsOrRename === "function" ? { rename: optsOrRename } : optsOrRename;
  const rename = opts.rename ?? fs.renameSync;
  const fsync = opts.fsync ?? REAL_FSYNC;
  // AC#1: assert the target is a governed write surface BEFORE creating any file —
  // a rejection must not leave a temp file behind. Only when a root is threaded.
  if (opts.root !== undefined) assertGovernedWriteSurface(opts.root, absPath);

  const dir = path.dirname(absPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${absPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tmp, content, "utf8");

  // AC#2: durably flush the temp file's bytes to the device BEFORE the rename, so a
  // crash in the rename window can never expose a zero/torn file. Errors propagate
  // (a real ENOSPC on the content flush is a genuine failure) — but first clean the
  // temp so a failed durability barrier never leaks a stray temp file.
  try {
    fsyncFile(tmp, fsync);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best-effort cleanup */
    }
    throw e;
  }

  for (let attempt = 1; ; attempt++) {
    try {
      rename(tmp, absPath);
      break; // renamed: the durable swap is done; fsync the dir below (outside the
      // rename-retry loop so a dir-fsync failure is never mistaken for rename contention).
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      const transient = isTransientIoError(code);
      if (!transient || attempt >= MAX_IO_ATTEMPTS) {
        // Give up: clean the temp file, then surface the right error shape.
        try {
          fs.rmSync(tmp, { force: true });
        } catch {
          /* best-effort cleanup */
        }
        if (transient) throw new StateWriteContendedError(absPath, attempt);
        throw e; // genuine, non-transient failure (ENOSPC, EROFS, …)
      }
      sleepSync(Math.min(4 * attempt, 40)); // ~4,8,…,40ms — total budget < ~1s (zero-CPU, PERF-007)
    }
  }

  // AC#2: fsync the containing directory so the rename (the durable swap) itself
  // survives a crash. The data is already safely renamed; a genuine dir-fsync
  // failure here PROPAGATES (branch a), and win32 N/A dir-handle codes are swallowed
  // inside fsyncDir. Outside the rename-retry loop so it is never confused with
  // rename contention (no temp file remains to clean — the rename already consumed it).
  fsyncDir(dir, fsync);
}

/**
 * Read a UTF-8 file, retrying a transient contention error (a reader that collided
 * with a concurrent atomic rename) with the SAME bounded, escalating budget as the
 * writer — so the read side is no weaker than the write side. A genuine error
 * (ENOENT, …) is not retried and propagates immediately. A single retry is not
 * enough under sustained contention: a second consecutive transient failure would
 * otherwise throw a raw EPERM/EACCES/EBUSY that escapes the CLI boundary (which
 * only maps the typed lock/write-contention codes) and crashes with a raw stack.
 * `read` is injectable for testing; production callers omit it.
 */
export function readFileWithRetry(
  absPath: string,
  read: (p: string) => string = (p) => fs.readFileSync(p, "utf8"),
): string {
  for (let attempt = 1; ; attempt++) {
    try {
      return read(absPath);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (!isTransientIoError(code) || attempt >= MAX_IO_ATTEMPTS) throw e;
      sleepSync(Math.min(4 * attempt, 40)); // zero-CPU backoff (PERF-007)
    }
  }
}
