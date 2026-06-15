import type { ProjectPaths } from "../core/paths";
import { type CommandResult, success, failure } from "../core/output";
import {
  type Fragment,
  FragmentExistsError,
  collabDir,
  writeFragment,
  listFragments,
  mergeFragments,
} from "../core/collab";
import { structuredLog } from "../core/log";

/**
 * `th collab` — the blackboard collab core (REQ-PCO-040, plan Phase 4 / Slice 5).
 *
 * A deterministic substrate where parallel agents drop fragment files into
 * `<stateDir>/collab/<stage>/<round>/` and a Reconciler merges them. Mechanical
 * only (plan §3 boundary rule): these handlers record fragments and concatenate
 * them in sorted order; they never decide which fragments belong or what the
 * merged result means. The one rule enforced is traceability (§17) — a merge
 * rejects any round containing a fragment without a REQ-ID anchor.
 *
 * Fragment writes are confined to the collab subtree and touch no shared state,
 * so they need no `withStateLock` (drift.ts locks only because it mutates
 * state.json + drift-log.md). The merge is read-only.
 */

export interface CollabInitOptions {
  stage?: string;
}

export interface CollabFragmentOptions {
  stage?: string;
  round?: string;
  name?: string;
  text?: string;
  /** Overwrite an existing fragment of the same name (collision guard; default off). */
  force?: boolean;
}

export interface CollabListOptions {
  stage?: string;
  round?: string;
}

export interface CollabMergeOptions {
  stage?: string;
  round?: string;
}

/**
 * `th collab init --stage <stage>` — report the resolved collab directory for a
 * stage. Path construction only (dirs are created on the first fragment write),
 * so callers can confirm where fragments will land without side effects.
 */
export function runCollabInit(paths: ProjectPaths, opts: CollabInitOptions): CommandResult {
  if (!opts.stage) {
    return failure({
      human: "usage: th collab init --stage <stage>",
      data: { error: "missing_stage" },
    });
  }
  const dir = collabDir(paths, opts.stage);
  structuredLog({ cmd: "collab init", stage: opts.stage });
  return success({
    data: { stage: opts.stage, dir },
    human: `collab stage '${opts.stage}' → ${dir}`,
  });
}

/**
 * `th collab fragment --stage <stage> --round <round> --name <name> --text <text>`
 * Drop a fragment file into the round, creating the round directory on demand.
 * Returns the absolute path written.
 */
export function runCollabFragment(paths: ProjectPaths, opts: CollabFragmentOptions): CommandResult {
  if (!opts.stage || !opts.round || !opts.name) {
    return failure({
      human: "usage: th collab fragment --stage <stage> --round <round> --name <name> [--text <text>] [--force]",
      data: { error: "missing_args" },
    });
  }
  // writeFragment throws a FragmentExistsError on a collision (existing fragment,
  // no --force) — convert ONLY that to a structured failure. Path-validation errors
  // (absolute / ".." / separator segments) are a distinct, security-relevant failure
  // mode and must keep propagating as throws (preserved behavior), so they are
  // re-thrown rather than mislabeled as a collision.
  let file: string;
  try {
    file = writeFragment(paths, {
      stage: opts.stage,
      round: opts.round,
      name: opts.name,
      content: opts.text ?? "",
      force: opts.force ?? false,
    });
  } catch (e) {
    if (!(e instanceof FragmentExistsError)) throw e;
    structuredLog({ cmd: "collab fragment", stage: opts.stage, round: opts.round, name: opts.name, error: "fragment_exists" });
    return failure({
      human: e.message,
      data: { error: "fragment_exists", stage: opts.stage, round: opts.round, name: opts.name },
    });
  }
  structuredLog({ cmd: "collab fragment", stage: opts.stage, round: opts.round, name: opts.name, force: opts.force === true });
  return success({
    data: { stage: opts.stage, round: opts.round, name: opts.name, path: file },
    human: `fragment written: ${file}`,
  });
}

/**
 * `th collab list --stage <stage> [--round <round>]` — list fragment descriptors
 * for a stage (optionally scoped to one round) in deterministic sorted order.
 */
export function runCollabList(paths: ProjectPaths, opts: CollabListOptions): CommandResult {
  if (!opts.stage) {
    return failure({
      human: "usage: th collab list --stage <stage> [--round <round>]",
      data: { error: "missing_stage" },
    });
  }
  const fragments: Fragment[] = listFragments(paths, opts.stage, opts.round);
  const human = fragments.length
    ? fragments.map((f) => `${f.round}/${f.name}`).join("\n")
    : "(no fragments)";
  structuredLog({ cmd: "collab list", stage: opts.stage, round: opts.round, count: fragments.length });
  return success({ data: { stage: opts.stage, round: opts.round, fragments }, human });
}

/**
 * `th collab merge --stage <stage> --round <round>` — reconcile a round by
 * concatenating its fragments in deterministic order. Surfaces the anchor
 * validation failure as `ok:false` with the missing fragment names in `data`
 * (traceability §17: every fragment must carry ≥1 REQ-ID anchor). Idempotent.
 */
export function runCollabMerge(paths: ProjectPaths, opts: CollabMergeOptions): CommandResult {
  if (!opts.stage || !opts.round) {
    return failure({
      human: "usage: th collab merge --stage <stage> --round <round>",
      data: { error: "missing_args" },
    });
  }
  const result = mergeFragments(paths, opts.stage, opts.round);
  if (!result.ok) {
    structuredLog({
      cmd: "collab merge",
      stage: opts.stage,
      round: opts.round,
      ok: false,
      unanchored: result.unanchored,
    });
    return failure({
      human: `merge rejected: fragments missing a REQ-ID anchor: ${result.unanchored.join(", ")}`,
      data: { error: "unanchored_fragments", stage: opts.stage, round: opts.round, unanchored: result.unanchored },
    });
  }
  structuredLog({
    cmd: "collab merge",
    stage: opts.stage,
    round: opts.round,
    ok: true,
    count: result.fragments.length,
  });
  return success({
    data: {
      stage: opts.stage,
      round: opts.round,
      merged: result.merged,
      fragments: result.fragments,
    },
    human: result.merged,
  });
}
