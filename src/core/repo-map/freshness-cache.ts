/**
 * P4-10 — bounded-cost freshness guard.
 *
 * `runRepoCheck` does a FULL `scanRepo` + a byte-exact SHA-256 re-hash of every
 * tracked file. That is correct but expensive, and it is now called on a HOT path
 * twice over: once per MCP repo-tool call (P4-3, `th_repo_relevant`/`th_repo_impact`)
 * and once inside the brownfield unlock gate (`checkRepoMap`, P4-5). Re-hashing the
 * whole tree on every such call is the kind of unmeasured per-call cost the plan
 * forbids (rev 2 S2/P4-10).
 *
 * This module wraps `runRepoCheck` with a cache keyed on a CHEAP signal — the
 * persisted map's mtime/size plus a stat-only signature of the working tree
 * (path + mtime + size, NO content read, NO hashing). The expensive full check
 * runs only when that cheap signal changes; an unchanged signal reuses the last
 * full outcome. Correctness is preserved: any content edit changes the file's
 * mtime+size (or, conservatively, we re-run on the tiniest doubt), and the cache is
 * per-process only (never persisted, never trusted across runs), so it can never
 * mask staleness that a fresh `th repo check` would catch.
 *
 * The cache is applied to BOTH consumers (the MCP-tool path AND the `checkRepoMap`
 * gate path) via the single `cachedFreshness` entry point, exactly as P4-10 requires.
 *
 * Determinism: this module NEVER writes to the repo-map and NEVER mutates state. It
 * is a pure in-memory memoization keyed by a stat signature; the cache miss path is
 * byte-identical to calling `runRepoCheck` directly.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectPaths } from "../paths";
import type { CommandResult } from "../output";

/**
 * Stat-only signature of one project's working tree + persisted map. Two signatures
 * compare equal iff no file's path/mtime/size changed AND the map file is unchanged.
 * A content edit changes mtimeMs (and usually size); a rename/add/delete changes the
 * path set. This is the CHEAP signal the cache keys on.
 */
interface CheapSignature {
  /** repo-map.json mtimeMs + size (a re-`th repo map` invalidates the cache). */
  mapStat: string;
  /** Sorted "relpath\0mtimeMs\0size" lines for every tracked working-tree file. */
  treeSig: string;
}

interface CacheEntry {
  sig: CheapSignature;
  /** The full `runRepoCheck` outcome captured at the last cache miss. */
  outcome: CommandResult;
}

/** Per-process cache, keyed by absolute project root. Never persisted. */
const CACHE = new Map<string, CacheEntry>();

/** Directory names never descended into for the cheap tree walk (mirror scanner scope coarsely). */
const SKIP_DIRS = new Set([".git", "node_modules", "dist", ".twinharness"]);

/**
 * Build the cheap stat signature for a project root. Pure I/O: `readdirSync` +
 * `statSync` only — NO file content is read and NOTHING is hashed. Bounded by a
 * file ceiling so a pathological tree cannot turn the "cheap" path expensive; on
 * overflow we return `null` to force a full check (fail-safe, never fail-open).
 */
function cheapSignature(paths: ProjectPaths): CheapSignature | null {
  const root = paths.root;
  const mapAbs = path.join(paths.stateDir, "repo-map.json");
  let mapStat = "absent";
  try {
    const st = fs.statSync(mapAbs);
    mapStat = `${st.mtimeMs}\0${st.size}`;
  } catch {
    mapStat = "absent";
  }

  const lines: string[] = [];
  let count = 0;
  const CEILING = 50_000; // > scanner FILE_COUNT_CAP; overflow ⇒ force full check.
  const walk = (abs: string): boolean => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return true; // unreadable dir — skip, do not abort the whole signature.
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        if (!walk(path.join(abs, e.name))) return false;
      } else if (e.isFile()) {
        if (++count > CEILING) return false;
        const p = path.join(abs, e.name);
        let st: fs.Stats;
        try {
          st = fs.statSync(p);
        } catch {
          continue;
        }
        const rel = path.relative(root, p).split(path.sep).join("/");
        lines.push(`${rel}\0${st.mtimeMs}\0${st.size}`);
      }
    }
    return true;
  };
  if (!walk(root)) return null;
  lines.sort();
  return { mapStat, treeSig: lines.join("\n") };
}

function sigEqual(a: CheapSignature, b: CheapSignature): boolean {
  return a.mapStat === b.mapStat && a.treeSig === b.treeSig;
}

/**
 * Cached freshness check. On a cache HIT (the cheap stat signature is unchanged
 * since the last full check) the prior `runRepoCheck` outcome is reused with NO
 * re-scan and NO re-hash. On a MISS (or when the cheap signal can't be computed)
 * it delegates to the supplied `fullCheck` (the real `runRepoCheck`), captures the
 * outcome, and returns it. Identical return shape to `runRepoCheck`.
 *
 * `fullCheck` is injected (rather than imported) to keep this core module free of a
 * dependency on the command layer (avoids the cycle `commands/repo` already breaks
 * via `freshness-codes`).
 */
export function cachedFreshness(
  paths: ProjectPaths,
  fullCheck: (paths: ProjectPaths) => CommandResult,
): CommandResult {
  const sig = cheapSignature(paths);
  const key = path.resolve(paths.root);
  if (sig !== null) {
    const hit = CACHE.get(key);
    if (hit && sigEqual(hit.sig, sig)) {
      return hit.outcome;
    }
  }
  const outcome = fullCheck(paths);
  if (sig !== null) {
    CACHE.set(key, { sig, outcome });
  }
  return outcome;
}

/** Test-only: clear the per-process cache so a test can exercise miss→hit ordering. */
export function clearFreshnessCache(): void {
  CACHE.clear();
}
