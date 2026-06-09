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
 * `th stale --since <hash>` — find the registered artifact whose recorded hash is
 * `sinceHash`, recompute its current file hash, and report the downstream
 * registered artifacts that are now stale. Exit 0 (computation only); failure
 * (exit 1) when `--since` is missing, the project is not initialized, or no
 * registered artifact has that hash.
 */
export function runStale(paths: ProjectPaths, sinceHash?: string): CommandResult {
  if (!sinceHash) return failure({ human: "usage: th stale --since <hash>" });

  const r = readState(paths);
  if (!r.exists) return NOT_INIT;
  if (!r.state) {
    return failure({
      human: `state.json is invalid:\n${formatIssues(r.issues)}`,
      data: { error: "invalid_state", issues: r.issues },
    });
  }

  const artifacts = r.state.approved_artifacts;
  const upstream = artifacts.find((a) => a.hash === sinceHash);
  if (!upstream) {
    return failure({
      human: `unknown hash: no registered artifact has hash ${sinceHash}.`,
      data: { error: "unknown_hash", since: sinceHash },
    });
  }

  // Recompute the upstream file's CURRENT hash. A missing file is treated as a
  // change (its content no longer matches the recorded version).
  const abs = path.resolve(paths.root, upstream.file);
  let currentHash: string | undefined;
  if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
    currentHash = shortHash(fs.readFileSync(abs, "utf8"));
  }
  const changed = currentHash !== sinceHash;

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
