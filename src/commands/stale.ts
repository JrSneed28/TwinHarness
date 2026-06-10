import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectPaths } from "../core/paths";
import { type CommandResult, success, failure } from "../core/output";
import { readState } from "../core/state-store";
import { type ValidationIssue } from "../core/state-schema";
import { shortHash } from "../core/hash";
import { downstreamOf } from "../core/pipeline";
import { structuredLog } from "../core/log";

/**
 * `th stale --since <hash>` — diff-scoped cascade re-verification (spec §18).
 *
 * Mechanical only (plan §3 boundary rule): given the recorded hash of an upstream
 * artifact, it computes whether that artifact's file has changed on disk and which
 * REGISTERED downstream artifacts are therefore stale. It NEVER persists anything
 * and never re-verifies — cascade re-verification is orchestrator-driven; this
 * command only computes the diff-scoped downstream set so the Critic can re-run
 * "only against the diff" rather than the whole project (§18).
 */

function formatIssues(issues: ValidationIssue[] | undefined): string {
  return (issues ?? []).map((i) => `  - ${i.path}: ${i.message}`).join("\n");
}

const NOT_INIT = failure({
  human: "No state.json found. Run `th init` first.",
  data: { error: "not_initialized" },
});

/**
 * Normalize a path to a root-relative forward-slash key, matching the shape
 * stored in artifact.file (same as artifact.ts toRelKey).
 */
function toRelKey(root: string, file: string): string {
  const abs = path.resolve(root, file);
  return path.relative(root, abs).split(path.sep).join("/");
}

export interface StaleOptions {
  sinceHash?: string;
  artifactFile?: string;
}

/**
 * `th stale --since <hash> | --artifact <file>` — diff-scoped cascade
 * re-verification (spec §18). Exactly one of `--since`/`--artifact` must be
 * provided.
 *
 * `--since <hash>`: existing behavior — find the registered artifact whose
 *   recorded hash is `sinceHash` and report downstream stale registered artifacts.
 *
 * `--artifact <file>`: look up the registered artifact by its root-relative
 *   forward-slash key, compare recorded hash vs current disk hash, and report
 *   `changed` + downstream registered stale set. Safe after re-registering
 *   (which replaces the hash), unlike `--since` which would return
 *   "unknown hash" after re-registration.
 */
export function runStale(paths: ProjectPaths, sinceHash?: string, artifactFile?: string): CommandResult {
  // Validate that exactly one mode is provided.
  const hasSince = sinceHash !== undefined && sinceHash !== "";
  const hasArtifact = artifactFile !== undefined && artifactFile !== "";

  if (!hasSince && !hasArtifact) {
    return failure({ human: "usage: th stale --since <hash> | --artifact <file>" });
  }
  if (hasSince && hasArtifact) {
    return failure({ human: "--since and --artifact are mutually exclusive; use exactly one." });
  }

  const r = readState(paths);
  if (!r.exists) return NOT_INIT;
  if (!r.state) {
    return failure({
      human: `state.json is invalid:\n${formatIssues(r.issues)}`,
      data: { error: "invalid_state", issues: r.issues },
    });
  }

  const artifacts = r.state.approved_artifacts;

  // Resolve the upstream artifact entry depending on mode.
  let upstream: (typeof artifacts)[number] | undefined;

  if (hasSince) {
    upstream = artifacts.find((a) => a.hash === sinceHash);
    if (!upstream) {
      return failure({
        human: `unknown hash: no registered artifact has hash ${sinceHash}.`,
        data: { error: "unknown_hash", since: sinceHash },
      });
    }
  } else {
    // --artifact mode: look up by root-relative forward-slash file key.
    const relKey = toRelKey(paths.root, artifactFile!);
    upstream = artifacts.find((a) => a.file === relKey);
    if (!upstream) {
      return failure({
        human: `Unregistered artifact: ${relKey} is not in approved_artifacts.`,
        data: { error: "unregistered_artifact", file: relKey },
      });
    }
  }

  // Recompute the upstream file's CURRENT hash. A missing file is treated as a
  // change (its content no longer matches the recorded version).
  const abs = path.resolve(paths.root, upstream.file);
  let currentHash: string | undefined;
  if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
    currentHash = shortHash(fs.readFileSync(abs, "utf8"));
  }
  // In --since mode compare current hash against sinceHash (the recorded snapshot).
  // In --artifact mode compare current hash against the stored artifact hash.
  const recordedHash = hasSince ? sinceHash! : upstream.hash;
  const changed = currentHash !== recordedHash;

  // Downstream registered artifacts only — an unregistered downstream file has no
  // approved version to be stale against (§18).
  const registered = new Set(artifacts.map((a) => a.file));
  const stale = downstreamOf(upstream.file).filter((f) => registered.has(f));

  structuredLog({ cmd: "stale", upstream: upstream.file, changed, stale: stale.length });

  const human = changed
    ? `Upstream ${upstream.file} changed; downstream stale (re-verify against the diff): ${stale.length ? stale.join(", ") : "(none)"}`
    : `Upstream ${upstream.file} unchanged; nothing downstream is stale.`;

  return success({ data: { upstream: upstream.file, changed, stale }, human });
}
