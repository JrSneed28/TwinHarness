/**
 * Pure repo-map freshness / staleness computation + exit-code taxonomy (ARCH-002).
 *
 * `th repo check` answers one question — does the persisted repo-map still match
 * the working tree? — and maps the answer to a stable three-way-plus exit code
 * (IF-001 / REQ-203):
 *
 *   0  fresh          — tree matches the map within scope
 *   4  stale          — files added/removed/modified, OR the map carries no
 *                       fileHashes (no_hashes graceful degradation, REQ-NFR-004)
 *   5  no-map         — repo-map.json is absent
 *   1  parse-failure  — map_invalid-json | map_version | map_schema
 *
 * That decision + the exact `--json` data shape + the human text used to live
 * INSIDE the command handler (`runRepoCheck`). They are extracted here as a pure,
 * side-effect-free, dependency-free function so the taxonomy is reusable and
 * unit-testable in isolation, and the command layer only does I/O (read the map,
 * scan + hash the tree) before delegating the decision. Byte-for-byte identical
 * to the previous in-command logic: same exit codes, same `data`, same `human`.
 *
 * This module reads NOTHING from disk and runs NOTHING — the caller supplies the
 * already-loaded inputs. It cannot escape the project root because it never
 * touches paths.
 */

import { REPO_STALE_EXIT, REPO_NO_MAP_EXIT } from "./freshness-codes";

/** The shape `runRepoCheck` returns (a subset of CommandResult, kept dependency-free here). */
export interface FreshnessOutcome {
  ok: boolean;
  exitCode: number;
  data: Record<string, unknown>;
  human: string;
  /** Stable token for `structuredLog` (the command logs this verbatim). */
  log: Record<string, unknown>;
}

/**
 * Discriminated input describing the result of loading + parsing the map and
 * (when it parsed) the hash diff of the working tree against it. The caller does
 * the I/O; this function owns the taxonomy.
 *
 *   - `no-map`     → repo-map.json was absent on disk.
 *   - `parse-fail` → repo-map.json was present but did not parse/validate.
 *   - `no-hashes`  → repo-map.json parsed but carried no (or empty) fileHashes.
 *   - `diff`       → repo-map.json parsed WITH fileHashes; the caller computed
 *                    the added/removed/modified buckets.
 */
export type FreshnessInput =
  | { kind: "no-map" }
  | { kind: "parse-fail"; error: string }
  | { kind: "no-hashes" }
  | { kind: "diff"; added: string[]; removed: string[]; modified: string[] };

/**
 * Compute the freshness outcome (exit code + `--json` data + human text + the log
 * record) from already-loaded inputs. Pure — no I/O, no throws.
 */
export function computeFreshness(input: FreshnessInput): FreshnessOutcome {
  switch (input.kind) {
    case "no-map":
      return {
        ok: false,
        exitCode: REPO_NO_MAP_EXIT,
        data: { ok: false, fresh: false, shape: "no-map" },
        human: "No repo-map.json found. Run `th repo map` first.",
        log: { cmd: "repo check", outcome: "no-map" },
      };

    case "parse-fail":
      return {
        ok: false,
        exitCode: 1,
        data: { ok: false, error: input.error },
        human: `repo-map.json parse failure: ${input.error}. Run \`th repo map\` to regenerate.`,
        log: { cmd: "repo check", outcome: "parse-fail", error: input.error },
      };

    case "no-hashes":
      return {
        ok: false,
        exitCode: REPO_STALE_EXIT,
        data: {
          ok: false,
          fresh: false,
          shape: "stale",
          added: [],
          removed: [],
          modified: [],
          reason: "no_hashes",
        },
        human: "repo-map.json exists but has no fileHashes. Run `th repo map` to update it.",
        log: { cmd: "repo check", outcome: "stale", reason: "no_hashes" },
      };

    case "diff": {
      // Defensive copy + sort for determinism (REQ-NFR-002) so the outcome shape
      // is stable regardless of the order the caller built the buckets in.
      const added = [...input.added].sort();
      const removed = [...input.removed].sort();
      const modified = [...input.modified].sort();
      const fresh = added.length === 0 && removed.length === 0 && modified.length === 0;

      if (fresh) {
        return {
          ok: true,
          exitCode: 0,
          data: { ok: true, fresh: true, shape: "fresh", added: [], removed: [], modified: [] },
          human: "repo-map.json is fresh — working tree matches the persisted map.",
          log: { cmd: "repo check", outcome: "fresh" },
        };
      }

      return {
        ok: false,
        exitCode: REPO_STALE_EXIT,
        data: { ok: false, fresh: false, shape: "stale", added, removed, modified },
        human: [
          "repo-map.json is stale.",
          added.length > 0 ? `  added (${added.length}): ${added.slice(0, 5).join(", ")}${added.length > 5 ? " ..." : ""}` : null,
          removed.length > 0 ? `  removed (${removed.length}): ${removed.slice(0, 5).join(", ")}${removed.length > 5 ? " ..." : ""}` : null,
          modified.length > 0 ? `  modified (${modified.length}): ${modified.slice(0, 5).join(", ")}${modified.length > 5 ? " ..." : ""}` : null,
          "Run `th repo map` to update.",
        ].filter(Boolean).join("\n"),
        log: {
          cmd: "repo check",
          outcome: "stale",
          added: added.length,
          removed: removed.length,
          modified: modified.length,
        },
      };
    }
  }
}

/**
 * Pure hash-map diff: classify every path into added / removed / modified buckets
 * (REQ-202). `current` are the freshly-hashed working-tree files; `stored` are the
 * map's persisted fileHashes. Hash-compare only — no mtime (REQ-NFR-002). Buckets
 * are returned sorted for determinism.
 */
export function diffHashes(
  stored: Record<string, string>,
  current: Record<string, string>,
): { added: string[]; removed: string[]; modified: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  const modified: string[] = [];

  // Files in the current tree but not in the stored map → added; same path with a
  // different hash → modified.
  for (const [p, h] of Object.entries(current)) {
    if (!(p in stored)) added.push(p);
    else if (stored[p] !== h) modified.push(p);
  }
  // Files in the stored map but absent from the current tree → removed.
  for (const p of Object.keys(stored)) {
    if (!(p in current)) removed.push(p);
  }

  added.sort();
  removed.sort();
  modified.sort();
  return { added, removed, modified };
}
