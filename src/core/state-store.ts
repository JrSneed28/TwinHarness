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
  fs.mkdirSync(paths.agenticDir, { recursive: true });
  const serialized = serializeState(state);
  const tmp = path.join(paths.agenticDir, `state.json.tmp-${process.pid}`);
  fs.writeFileSync(tmp, serialized, "utf8");
  fs.renameSync(tmp, paths.stateFile);
}
