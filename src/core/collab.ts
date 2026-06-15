/**
 * Blackboard collab substrate (REQ-PCO-040, plan Phase 4 / Slice 5).
 *
 * A deterministic file-backed "blackboard" where parallel agents drop fragment
 * files and a Reconciler merges them. Fragments live under
 * `<stateDir>/collab/<stage>/<round>/` — one file per fragment. The merge is
 * pure concatenation in sorted (deterministic) order, so re-running it on the
 * same inputs is idempotent.
 *
 * Boundary rule (plan §3): this module is purely mechanical — it records and
 * computes against the fragment tree. It never *decides* which fragments belong,
 * who reconciles, or what the merged artifact means. The one rule it enforces is
 * traceability (§17): every fragment must carry at least one REQ-ID anchor, so
 * the merged blackboard stays attributable to requirements. Pure/synchronous,
 * mirroring the rest of `src/core`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectPaths } from "./paths";
import { extractReqIds } from "./anchors";

/** A located fragment in the blackboard tree. */
export interface Fragment {
  /** Stage bucket the fragment belongs to. */
  stage: string;
  /** Round bucket within the stage. */
  round: string;
  /** Fragment file name (e.g. `builder-a.md`). */
  name: string;
  /** Absolute path to the fragment file. */
  path: string;
}

/** Input to {@link writeFragment}. */
export interface WriteFragmentInput {
  stage: string;
  round: string;
  /** Fragment file name (unique within the round). */
  name: string;
  /** Fragment body. Must carry ≥1 REQ-ID anchor to survive a merge. */
  content: string;
}

/** Structured result of {@link mergeFragments}. */
export interface MergeResult {
  /** True when every fragment carried ≥1 REQ-ID anchor. */
  ok: boolean;
  /** Deterministic concatenation of all fragments (empty string on failure). */
  merged: string;
  /** Fragment descriptors merged, in sorted order. */
  fragments: Fragment[];
  /** Names of fragments missing a REQ-ID anchor (empty when `ok`). */
  unanchored: string[];
}

/**
 * Build the absolute collab directory for a stage (and optional round) under
 * `paths.stateDir`. Path construction only — never creates anything (dirs are
 * created on write).
 */
export function collabDir(paths: ProjectPaths, stage: string, round?: string): string {
  const base = path.join(paths.stateDir, "collab", stage);
  return round === undefined ? base : path.join(base, round);
}

/**
 * Write a fragment file under `<stateDir>/collab/<stage>/<round>/<name>`,
 * creating the round directory tree on demand. Returns the absolute path written.
 */
export function writeFragment(paths: ProjectPaths, input: WriteFragmentInput): string {
  const dir = collabDir(paths, input.stage, input.round);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, input.name);
  fs.writeFileSync(file, input.content, "utf8");
  return file;
}

/**
 * List fragment descriptors for a stage, optionally scoped to a single round.
 * Returned in deterministic (round, then name) sorted order. A missing collab
 * tree yields an empty list — listing never creates anything.
 */
export function listFragments(paths: ProjectPaths, stage: string, round?: string): Fragment[] {
  const out: Fragment[] = [];

  const readRound = (r: string): void => {
    const dir = collabDir(paths, stage, r);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return;
    const names = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .sort();
    for (const name of names) {
      out.push({ stage, round: r, name, path: path.join(dir, name) });
    }
  };

  if (round !== undefined) {
    readRound(round);
    return out;
  }

  const stageDir = collabDir(paths, stage);
  if (!fs.existsSync(stageDir) || !fs.statSync(stageDir).isDirectory()) return out;
  const rounds = fs
    .readdirSync(stageDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  for (const r of rounds) readRound(r);
  return out;
}

/**
 * Reconcile a round: concatenate every fragment in deterministic (sorted-by-name)
 * order. Before concatenating it validates that EVERY fragment carries at least
 * one REQ-ID anchor (reusing {@link extractReqIds}); when any are missing it
 * returns `ok:false` with the offending fragment names and an empty merge.
 *
 * Each fragment is separated by a blank line and the merged blob ends with a
 * trailing newline, so the output is stable: re-running the merge on unchanged
 * inputs yields byte-identical output (idempotent).
 */
export function mergeFragments(paths: ProjectPaths, stage: string, round: string): MergeResult {
  const fragments = listFragments(paths, stage, round);

  const unanchored: string[] = [];
  for (const f of fragments) {
    const content = fs.readFileSync(f.path, "utf8");
    if (extractReqIds(content).length === 0) unanchored.push(f.name);
  }
  if (unanchored.length > 0) {
    return { ok: false, merged: "", fragments, unanchored };
  }

  const parts = fragments.map((f) => {
    const content = fs.readFileSync(f.path, "utf8");
    return content.endsWith("\n") ? content : `${content}\n`;
  });
  const merged = parts.join("\n");
  return { ok: true, merged, fragments, unanchored: [] };
}
