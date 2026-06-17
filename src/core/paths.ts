import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Thrown when a caller attempts to operate on a path that escapes the project
 * root (an absolute path, a `..` segment, or a separator-bearing component where
 * a single component is required). Lives here, beside {@link resolveWithinRoot},
 * because root-relative containment is the invariant this whole module enforces.
 *
 * A DISTINCT, typed error (with a stable `code`) so the single CLI boundary
 * (cli.ts) can map it to a structured `failure(...)` — and therefore a valid
 * `--json` envelope plus a sensible exit code — instead of letting a raw Node
 * stack escape (ARCH-003). The `code` mirrors the convention the state-store
 * uses for its lock/contention errors so the boundary can switch on it uniformly.
 */
export class PathContainmentError extends Error {
  /** Stable machine token surfaced in the `--json` failure envelope. */
  readonly code = "path_containment";
  constructor(
    message: string,
    /** The offending path/segment, echoed into the structured failure data. */
    public readonly segment: string,
  ) {
    super(message);
    this.name = "PathContainmentError";
  }
}

/**
 * Resolved filesystem locations for a TwinHarness-governed project.
 *
 * The CLI only ever *records and computes* against these paths; it never decides
 * which stage/agent/tier runs (see plan §3 boundary rule).
 */
export interface ProjectPaths {
  /** Absolute project root (where `.twinharness/` and `docs/` live). */
  root: string;
  /**
   * `<root>/.twinharness` (new default) or `<root>/.agentic-sdlc` (legacy
   * fallback — kept so existing projects whose state lives in `.agentic-sdlc`
   * continue to work without migration). The selection is performed once by
   * {@link resolveProjectPaths} and recorded here; all consumers reference
   * `stateDir` rather than hard-coding either name.
   */
  stateDir: string;
  /** `<stateDir>/state.json` */
  stateFile: string;
  /** `<root>/docs` */
  docsDir: string;
  /** `<root>/drift-log.md` */
  driftLog: string;
}

/**
 * Resolve `p` (absolute, or relative to `root`) to an absolute path, but ONLY
 * if it stays within `root`. Returns null when the path escapes the project
 * root (callers reject these — TwinHarness commands never operate outside the
 * project they govern). Mirrors the write-gate's root-containment check.
 */
export function resolveWithinRoot(root: string, p: string): string | null {
  const absRoot = path.resolve(root);
  const abs = path.isAbsolute(p) ? p : path.resolve(absRoot, p);
  const rel = path.relative(absRoot, abs);
  // 1. Lexical containment (cheap reject; rel === "" is the root itself).
  if (rel !== "" && (rel.startsWith("..") || path.isAbsolute(rel))) return null;
  // 2. Symlink/junction defense (H-5): a lexical check is fooled by a symlink or
  //    NTFS junction inside the root that points outside it. NTFS junctions are
  //    NOT symlinks (lstat().isSymbolicLink() is false for them), so a
  //    per-component symlink check misses the proven vector. Instead re-check
  //    containment after resolving REAL paths: realpath the root and the longest
  //    existing prefix of `abs` (tolerating a not-yet-created tail), symmetrically
  //    so a symlinked tmpdir (e.g. macOS /var -> /private/var) never false-rejects.
  // Resolve BOTH sides through `realpathExistingPrefix` so the symmetry holds even
  // when the root itself does not exist yet (a fresh `th init`, or a test tmpdir):
  // `realpathSafe` falls back to the LITERAL path on ENOENT, so realpath-ing the
  // root directly would leave it unresolved (e.g. `/var/...`) while `abs` resolves
  // its existing ancestor through a symlink (e.g. `/private/var/...`) — that
  // asymmetry false-rejects valid in-root paths on macOS/CI. `realpathExistingPrefix`
  // resolves each one's longest existing prefix identically.
  const realRoot = realpathExistingPrefix(absRoot);
  const realAbs = realpathExistingPrefix(abs);
  const realRel = path.relative(realRoot, realAbs);
  if (realRel === "") return abs; // resolves to the root itself
  if (realRel.startsWith("..") || path.isAbsolute(realRel)) return null;
  return abs; // success: return the lexical in-root path (contract unchanged)
}

/** realpath `p`, preferring the native resolver; fall back to `p` if it errors. */
function realpathSafe(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    try {
      return fs.realpathSync(p);
    } catch {
      return p;
    }
  }
}

/**
 * realpath the longest EXISTING prefix of `abs`, re-appending any not-yet-created
 * tail literally (a tail that does not exist on disk cannot contain a symlink or
 * junction). This lets us resolve real locations for paths that point at files
 * about to be written, without throwing ENOENT.
 */
function realpathExistingPrefix(abs: string): string {
  let existing = abs;
  const tail: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break; // reached the filesystem root
    tail.unshift(path.basename(existing));
    existing = parent;
  }
  const real = realpathSafe(existing);
  return tail.length === 0 ? real : path.join(real, ...tail);
}

/**
 * Resolve all project paths from a root directory.
 *
 * Directory selection for the state directory (cheap fs existence checks —
 * acceptable because this is called once per CLI invocation):
 * 1. If `<root>/.twinharness` exists → use it.
 * 2. Else if `<root>/.agentic-sdlc/state.json` exists → legacy fallback, keep
 *    using `.agentic-sdlc` so the existing project is not broken.
 * 3. Otherwise → default to `.twinharness` (fresh projects).
 */
export function resolveProjectPaths(root: string): ProjectPaths {
  const startAbs = path.resolve(root);

  // M-7: walk UP from the start dir to the nearest ancestor that already holds a
  // TwinHarness state dir. A session whose cwd is a subdirectory of the project
  // must still find the project's gates instead of failing OPEN (treating the
  // subdir as an untracked project and allowing the run). If no ancestor has
  // state, fall back to treating the start dir as the root (fresh-project path
  // through the selection logic below).
  let abs = startAbs;
  let cursor = startAbs;
  while (true) {
    if (
      fs.existsSync(path.join(cursor, ".twinharness")) ||
      fs.existsSync(path.join(cursor, ".agentic-sdlc", "state.json"))
    ) {
      abs = cursor;
      break;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break; // reached the filesystem root: keep startAbs
    cursor = parent;
  }

  let stateDir: string;
  const newDir = path.join(abs, ".twinharness");
  const legacyStateFile = path.join(abs, ".agentic-sdlc", "state.json");

  if (fs.existsSync(newDir)) {
    stateDir = newDir;
  } else if (fs.existsSync(legacyStateFile)) {
    // Legacy project: `.agentic-sdlc/state.json` present — stay in legacy dir.
    stateDir = path.join(abs, ".agentic-sdlc");
  } else {
    stateDir = newDir;
  }

  return {
    root: abs,
    stateDir,
    stateFile: path.join(stateDir, "state.json"),
    docsDir: path.join(abs, "docs"),
    driftLog: path.join(abs, "drift-log.md"),
  };
}
