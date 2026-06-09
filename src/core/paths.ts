import * as path from "node:path";

/**
 * Resolved filesystem locations for a TwinHarness-governed project.
 *
 * The CLI only ever *records and computes* against these paths; it never decides
 * which stage/agent/tier runs (see plan §3 boundary rule).
 */
export interface ProjectPaths {
  /** Absolute project root (where `.agentic-sdlc/` and `docs/` live). */
  root: string;
  /** `<root>/.agentic-sdlc` */
  agenticDir: string;
  /** `<root>/.agentic-sdlc/state.json` */
  stateFile: string;
  /** `<root>/docs` */
  docsDir: string;
  /** `<root>/drift-log.md` */
  driftLog: string;
}

/** Resolve all project paths from a root directory (defaults are caller-supplied). */
export function resolveProjectPaths(root: string): ProjectPaths {
  const abs = path.resolve(root);
  return {
    root: abs,
    agenticDir: path.join(abs, ".agentic-sdlc"),
    stateFile: path.join(abs, ".agentic-sdlc", "state.json"),
    docsDir: path.join(abs, "docs"),
    driftLog: path.join(abs, "drift-log.md"),
  };
}
