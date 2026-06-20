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
import { type ProjectPaths, PathContainmentError } from "./paths";
import { extractReqIds } from "./anchors";

/**
 * Validate that `segment` is a safe single path component: rejects absolute
 * paths, `..`, and any value containing a path separator (`/` or `\`). Throws a
 * typed {@link PathContainmentError} (a security-relevant containment violation)
 * so the CLI boundary maps it to a structured `--json` failure with a stable
 * `path_containment` code instead of letting a raw Node stack escape (ARCH-003) —
 * while still preventing the path traversal it always did.
 */
function validatePathSegment(segment: string, label: string): void {
  if (path.isAbsolute(segment)) {
    throw new PathContainmentError(`collab: ${label} must not be an absolute path: "${segment}"`, segment);
  }
  if (segment === ".." || segment.includes("/") || segment.includes("\\")) {
    throw new PathContainmentError(
      `collab: ${label} must be a single path component with no separators or "..": "${segment}"`,
      segment,
    );
  }
}

/**
 * Thrown by {@link writeFragment} when a fragment of the same name already exists
 * and `force` is not set. A DISTINCT type so the command layer can convert only a
 * collision into a structured failure while letting path-validation errors (a
 * different, security-relevant failure mode) keep propagating as throws.
 */
export class FragmentExistsError extends Error {
  constructor(public readonly file: string) {
    super(`collab: fragment already exists: ${file}. Pass --force to overwrite it.`);
    this.name = "FragmentExistsError";
  }
}

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
  /**
   * Overwrite an existing fragment of the same name. Default (false/undefined)
   * REFUSES to clobber a fragment another writer already dropped — a collision
   * guard for parallel agents sharing a round.
   */
  force?: boolean;
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
  validatePathSegment(stage, "stage");
  if (round !== undefined) validatePathSegment(round, "round");
  const base = path.join(paths.stateDir, "collab", stage);
  return round === undefined ? base : path.join(base, round);
}

/**
 * Write a fragment file under `<stateDir>/collab/<stage>/<round>/<name>`,
 * creating the round directory tree on demand. Returns the absolute path written.
 *
 * Collision guard: refuses to overwrite an existing fragment of the same name
 * unless `input.force` is set, so two parallel agents dropping the same name into
 * a round cannot silently clobber each other. Throws a descriptive `Error` on a
 * collision (the command layer converts it to a structured failure).
 */
export function writeFragment(paths: ProjectPaths, input: WriteFragmentInput): string {
  validatePathSegment(input.name, "name");
  const dir = collabDir(paths, input.stage, input.round);
  const file = path.join(dir, input.name);
  fs.mkdirSync(dir, { recursive: true });
  // R-16: ATOMIC create-or-fail. The old `existsSync`-then-`writeFileSync` guard was
  // a check-then-write TOCTOU — two parallel writers could both see `!existsSync` and
  // both write, the second silently clobbering with NO FragmentExistsError. The `wx`
  // open flag (write, fail if the path exists) lets the OS arbitrate the race: exactly
  // one create wins, the loser gets EEXIST → FragmentExistsError. `--force` keeps the
  // overwrite semantics via the plain `w` flag.
  try {
    fs.writeFileSync(file, input.content, { encoding: "utf8", flag: input.force ? "w" : "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new FragmentExistsError(file);
    throw e;
  }
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

/* ------------------------------------------------------------------ *
 * Fragment GC / TTL stale-recovery (Phase 5 / P5-3).                   *
 *                                                                      *
 * Blackboard fragments are dropped by parallel writers and consumed by *
 * a Reconciler. A writer that crashed (or a round abandoned after a     *
 * re-plan) leaves orphaned fragments on disk that no Reconciler will     *
 * ever merge — clutter that can also confuse a later merge of the same  *
 * round. This is the fragment analogue of the section-lease dead-holder *
 * bug. The recovery is a TTL sweep keyed on each fragment file's mtime: *
 * a fragment untouched for longer than the TTL is considered stale and  *
 * recoverable. {@link staleFragments} is a pure predicate (lists them); *
 * {@link sweepStaleFragments} performs the GC (deletes them and reports  *
 * what it removed). The caller decides WHEN to sweep — listing never     *
 * deletes anything.                                                     *
 * ------------------------------------------------------------------ */

/** Default fragment TTL: 24 hours in ms. A fragment untouched longer than this is stale. */
export const FRAGMENT_TTL_MS = 24 * 60 * 60 * 1000;

/** A stale fragment: the located fragment plus its last-modified epoch ms. */
export interface StaleFragment extends Fragment {
  /** File mtime in epoch milliseconds (the basis of the staleness decision). */
  mtimeMs: number;
}

/**
 * List the STALE fragments for a stage (optionally one round): every fragment whose
 * file mtime is older than `ttlMs` relative to `now`. Pure — it reads the tree and
 * decides nothing; it never deletes. Mirrors {@link staleSectionLeases} on the
 * lease side. Clock-injectable for deterministic tests.
 */
export function staleFragments(
  paths: ProjectPaths,
  stage: string,
  round?: string,
  ttlMs: number = FRAGMENT_TTL_MS,
  now: () => Date = () => new Date(),
): StaleFragment[] {
  const cutoff = now().getTime() - ttlMs;
  const out: StaleFragment[] = [];
  for (const f of listFragments(paths, stage, round)) {
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(f.path).mtimeMs;
    } catch {
      continue; // raced deletion — skip
    }
    if (mtimeMs < cutoff) out.push({ ...f, mtimeMs });
  }
  return out;
}

/**
 * GC the stale fragments for a stage (optionally one round): delete every fragment
 * older than `ttlMs` and return the {@link StaleFragment} descriptors that were
 * removed. Idempotent (a second sweep finds none) and bounded to the collab tree
 * (it only ever touches files {@link listFragments} returned). Clock-injectable.
 */
export function sweepStaleFragments(
  paths: ProjectPaths,
  stage: string,
  round?: string,
  ttlMs: number = FRAGMENT_TTL_MS,
  now: () => Date = () => new Date(),
): StaleFragment[] {
  const stale = staleFragments(paths, stage, round, ttlMs, now);
  for (const f of stale) {
    try {
      fs.rmSync(f.path);
    } catch {
      // Best-effort GC: a fragment already gone (raced) is fine.
    }
  }
  return stale;
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
