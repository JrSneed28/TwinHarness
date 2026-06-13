import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectPaths } from "../core/paths";
import { resolveWithinRoot } from "../core/paths";
import { type CommandResult, success, failure } from "../core/output";
import { readState, writeState, withStateLock } from "../core/state-store";
import { type ValidationIssue, type ApprovedArtifact } from "../core/state-schema";
import { shortHashPath } from "../core/hash";
import { structuredLog } from "../core/log";

/**
 * `th artifact` — content-hash and record an approved, versioned artifact
 * (spec §12: "each artifact is versioned with a content hash referenced by
 * state.json"; §18 `approved_artifacts`).
 *
 * Mechanical only (plan §3 boundary rule): the CLI computes a deterministic
 * content hash and records the version it is told. It never decides *whether* an
 * artifact is approved — the caller supplies the version when it approves.
 */

function formatIssues(issues: ValidationIssue[] | undefined): string {
  return (issues ?? []).map((i) => `  - ${i.path}: ${i.message}`).join("\n");
}

const NOT_INIT = failure({
  human: "No state.json found. Run `th init` first.",
  data: { error: "not_initialized" },
});

/** Normalize a root-relative path to forward slashes for cross-platform stable storage. */
function toRelKey(root: string, file: string): string {
  const abs = path.resolve(root, file);
  return path.relative(root, abs).split(path.sep).join("/");
}

/**
 * `th artifact register <path> --version <n>` — compute the content hash of a
 * file OR directory (relative to the project root) and upsert it into
 * `approved_artifacts`. Directories (e.g. the T3 ADR set `docs/05-adrs/`) are
 * hashed deterministically over their contents (§15.S; stage contract
 * `produces: docs/05-adrs/`). Re-registering the same path REPLACES its entry
 * (version bump, no duplicate).
 */
export function runArtifactRegister(
  paths: ProjectPaths,
  file?: string,
  version?: number,
): CommandResult {
  return withStateLock(paths, () => runArtifactRegisterLocked(paths, file, version));
}

function runArtifactRegisterLocked(
  paths: ProjectPaths,
  file?: string,
  version?: number,
): CommandResult {
  if (!file) return failure({ human: "usage: th artifact register <file> --version <n>" });
  if (version === undefined || !Number.isInteger(version) || version < 1) {
    return failure({ human: "usage: th artifact register <file> --version <n>" });
  }

  const abs = resolveWithinRoot(paths.root, file);
  if (abs === null) {
    return failure({ human: `Path outside project root: ${file}`, data: { error: "path_outside_root", file } });
  }
  if (!fs.existsSync(abs)) {
    return failure({ human: `File not found: ${file}`, data: { error: "file_not_found", file } });
  }
  const stat = fs.statSync(abs);
  if (!stat.isFile() && !stat.isDirectory()) {
    return failure({ human: `Not a file or directory: ${file}`, data: { error: "not_a_file_or_dir", file } });
  }

  const r = readState(paths);
  if (!r.exists) return NOT_INIT;
  if (!r.state) {
    return failure({
      human: `Existing state.json is invalid; fix it before registering:\n${formatIssues(r.issues)}`,
      data: { error: "invalid_state", issues: r.issues },
    });
  }

  const hash = shortHashPath(abs);
  const relKey = toRelKey(paths.root, file);

  const entry: ApprovedArtifact = { file: relKey, version, hash };
  const next = { ...r.state, approved_artifacts: [...r.state.approved_artifacts] };
  const idx = next.approved_artifacts.findIndex((a) => a.file === relKey);
  if (idx >= 0) next.approved_artifacts[idx] = entry;
  else next.approved_artifacts.push(entry);

  writeState(paths, next);
  structuredLog({ cmd: "artifact register", file: relKey, version, hash });
  return success({
    data: { file: relKey, version, hash },
    human: `registered ${relKey} v${version} (${hash})`,
  });
}

/** `th artifact list` — list every recorded approved artifact. */
export function runArtifactList(paths: ProjectPaths): CommandResult {
  const r = readState(paths);
  if (!r.exists) return NOT_INIT;
  if (!r.state) {
    return failure({
      human: `state.json is invalid:\n${formatIssues(r.issues)}`,
      data: { error: "invalid_state", issues: r.issues },
    });
  }
  const artifacts = r.state.approved_artifacts;
  const human = artifacts.length
    ? artifacts.map((a) => `${a.file}  v${a.version}  ${a.hash}`).join("\n")
    : "(none)";
  return success({ data: { artifacts }, human });
}
