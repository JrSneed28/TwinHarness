import * as fs from "node:fs";
import * as path from "node:path";

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
  if (rel === "") return abs; // the root itself
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return abs;
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
  const abs = path.resolve(root);

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
