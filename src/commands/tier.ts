import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectPaths } from "../core/paths";
import { resolveWithinRoot } from "../core/paths";
import { type CommandResult, success, failure } from "../core/output";
import { type ValidationIssue } from "../core/state-schema";
import { loadBriefFromFile, type TaskBrief } from "../core/brief";
import { structuredLog } from "../core/log";
import { formatIssues } from "../core/guards";
import { readState } from "../core/state-store";
import { runRepoCheck, REPO_NO_MAP_EXIT } from "./repo";

/**
 * `th tier` — the Tier-0 classifier (spec §5).
 *
 * Two surfaces with deliberately different contracts (build plan §3):
 * - `classify` is **advisory** — it computes the five Tier-0 conditions and the
 *   blast-radius veto but never picks T1/T2/T3 (that is judgment, plan §3
 *   boundary rule). It never hard-fails (exit 0).
 * - `veto-check` is **mechanical** — a hard exit-code gate (exit 3) when any
 *   blast-radius flag is present, forbidding Tier 0. This is a *mechanical
 *   truth* (spec §5 veto), wired into the hook alongside `th state verify`.
 *
 * The veto floor is also a schema invariant (state-schema.ts), so even a
 * hand-edited `tier: "T0"` with a flag is mechanically refused.
 */

/** Exit code for a blast-radius veto (distinct from the generic failure 1). */
export const VETO_EXIT_CODE = 3;

/**
 * Brownfield prerequisite check (REQ-301..305, IF-007).
 *
 * Returns `{ ok: true, missing: [] }` immediately for any non-brownfield run
 * (including absent/unreadable state.json). Only when `project_mode ===
 * "brownfield"` does it check for the two required artifacts.
 *
 * Short-circuit guarantee (REQ-304, REQ-305): greenfield and uninitialized
 * projects are byte-identical to pre-epic behavior — this helper changes nothing
 * for them (no side-effects, no output change, no exit-code change).
 */
function brownfieldPrerequisite(
  paths: ProjectPaths,
):
  | { ok: true; missing: []; stale: [] }
  | { ok: false; missing: string[]; stale: string[] } {
  // Anchor: REQ-305
  // Read state; tolerate absent or unreadable state.json (falls through as greenfield).
  const stateResult = readState(paths);
  if (!stateResult.state || stateResult.state.project_mode !== "brownfield") {
    // REQ-304: short-circuit — greenfield / uninitialized path, nothing changes.
    return { ok: true, missing: [], stale: [] };
  }

  // Brownfield run: both prerequisite artifacts must be PRESENT, and the repo-map
  // must additionally be FRESH (REQ-301). A map that has drifted from the working
  // tree grounds tiering/planning on an outdated understanding, so it is as
  // disqualifying as an absent one. Freshness is delegated to the single
  // `th repo check` oracle (`runRepoCheck`) — no duplicate hashing here.
  const repoMapPath = path.join(paths.stateDir, "repo-map.json");
  const repoMapRel = path.relative(paths.root, repoMapPath).replace(/\\/g, "/");
  const codebaseAnalysisPath = path.join(paths.docsDir, "00-existing-codebase-analysis.md");

  const missing: string[] = [];
  const stale: string[] = [];

  // Anchor: REQ-301 — repo-map EXISTENCE *and* FRESHNESS via runRepoCheck.
  const check = runRepoCheck(paths);
  if (check.exitCode === REPO_NO_MAP_EXIT) {
    // Absent map → unchanged outcome (canonical relative path, contract IF-007).
    missing.push(repoMapRel);
  } else if (check.exitCode !== 0) {
    // REPO_STALE_EXIT (4: drifted / no-hashes) or 1 (unparseable): the map no
    // longer reflects the tree, so it cannot ground tiering decisions.
    stale.push(repoMapRel);
  }

  if (!fs.existsSync(codebaseAnalysisPath)) {
    const rel = path.relative(paths.root, codebaseAnalysisPath).replace(/\\/g, "/");
    missing.push(rel);
  }

  if (missing.length > 0 || stale.length > 0) {
    // Anchor: REQ-302
    return { ok: false, missing, stale };
  }
  return { ok: true, missing: [], stale: [] };
}

function briefLoadFailure(briefPath: string, issues: ValidationIssue[]): CommandResult {
  return failure({
    human: `Could not load brief "${briefPath}":\n${formatIssues(issues)}`,
    data: { error: "invalid_brief", issues },
  });
}

/** The five Tier-0 conditions plus the veto, computed mechanically (spec §5). */
function classifyBrief(brief: TaskBrief): {
  tier0_eligible: boolean;
  blocked_by_veto: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  if (!brief.single_file_or_local) reasons.push("not a single file / tightly local area");
  if (brief.changes_public_interface) reasons.push("changes a public interface, schema, or contract");
  if (brief.adds_dependency) reasons.push("adds a new dependency");
  if (!brief.obvious_testable_answer) reasons.push("no obvious, testable correct answer");

  const blocked_by_veto = brief.blast_radius_flags.length > 0;
  if (blocked_by_veto) {
    reasons.push(`blast-radius flag(s) force ≥T1 (§5 veto): ${brief.blast_radius_flags.join(", ")}`);
  }

  const tier0_eligible =
    brief.single_file_or_local &&
    !brief.changes_public_interface &&
    !brief.adds_dependency &&
    brief.obvious_testable_answer &&
    brief.blast_radius_flags.length === 0;

  return { tier0_eligible, blocked_by_veto, reasons };
}

/**
 * `th tier classify <brief.json>` — ADVISORY (build plan §3). Computes the five
 * Tier-0 conditions and the blast-radius veto; reports a T0/≥T1 advisory and the
 * reasons any condition failed. Never hard-fails (exit 0); does NOT pick the
 * tier number.
 */
export function runTierClassify(paths: ProjectPaths, briefPath?: string): CommandResult {
  if (!briefPath) return failure({ human: "usage: th tier classify <brief.json>" });
  // Resolve the brief path against the project root (--cwd), like `th artifact register`.
  const briefFile = resolveWithinRoot(paths.root, briefPath);
  if (briefFile === null) {
    return failure({ human: `Brief path outside project root: ${briefPath}`, data: { error: "path_outside_root", file: briefPath } });
  }
  const loaded = loadBriefFromFile(briefFile);
  if (!loaded.ok || !loaded.brief) return briefLoadFailure(briefFile, loaded.issues);

  const { tier0_eligible, blocked_by_veto, reasons } = classifyBrief(loaded.brief);
  const advisory = tier0_eligible ? "T0" : "≥T1";
  structuredLog({ cmd: "tier classify", advisory, blocked_by_veto });

  const human = tier0_eligible
    ? "Advisory: T0 — all five Tier-0 conditions hold and no blast-radius flag is present."
    : `Advisory: ≥T1 — Tier 0 not eligible:\n${reasons.map((r) => `  - ${r}`).join("\n")}`;

  // Anchor: REQ-303 — brownfield advisory (exit 0, surfaced in data only).
  const prereq = brownfieldPrerequisite(paths);
  const extraData: Record<string, unknown> = {};
  if (!prereq.ok) {
    if (prereq.missing.length > 0) extraData.brownfield_prerequisite_missing = prereq.missing;
    if (prereq.stale.length > 0) extraData.brownfield_prerequisite_stale = prereq.stale;
  }

  return success({
    data: {
      tier0_eligible,
      blocked_by_veto,
      blast_radius_flags: loaded.brief.blast_radius_flags,
      advisory,
      reasons,
      ...extraData,
    },
    human,
  });
}

/**
 * `th tier veto-check <brief.json>` — MECHANICAL exit-code gate (build plan §3).
 * Hard-fails with exit 3 when any blast-radius flag is present, forbidding Tier
 * 0. Never advisory — this enforces the §5 veto floor.
 */
export function runTierVetoCheck(paths: ProjectPaths, briefPath?: string): CommandResult {
  if (!briefPath) return failure({ human: "usage: th tier veto-check <brief.json>" });

  // Anchor: REQ-301, REQ-302 — brownfield hard refusal BEFORE brief-load logic.
  // Covers a MISSING artifact (absent repo-map / codebase-analysis) and a STALE
  // repo-map (drifted from the tree) — both forbid Tier 0 until resolved.
  const prereq = brownfieldPrerequisite(paths);
  if (!prereq.ok) {
    const error = prereq.missing.length > 0 ? "brownfield_prerequisite_missing" : "brownfield_repo_map_stale";
    structuredLog({ cmd: "tier veto-check", error, missing: prereq.missing, stale: prereq.stale });
    const lines: string[] = ["BLOCKED: brownfield prerequisite(s) unmet — Tier 0 forbidden until resolved:"];
    for (const m of prereq.missing) lines.push(`  - missing: ${m}`);
    for (const s of prereq.stale) lines.push(`  - stale: ${s} (re-run \`th repo map\` to refresh it)`);
    lines.push("Run `th repo map` and provide docs/00-existing-codebase-analysis.md, then retry.");
    return failure({
      exitCode: VETO_EXIT_CODE,
      data: { error, missing: prereq.missing, stale: prereq.stale },
      human: lines.join("\n"),
    });
  }

  // Resolve the brief path against the project root (--cwd), like `th artifact register`.
  const briefFile = resolveWithinRoot(paths.root, briefPath);
  if (briefFile === null) {
    return failure({ human: `Brief path outside project root: ${briefPath}`, data: { error: "path_outside_root", file: briefPath } });
  }
  const loaded = loadBriefFromFile(briefFile);
  if (!loaded.ok || !loaded.brief) return briefLoadFailure(briefFile, loaded.issues);

  const flags = loaded.brief.blast_radius_flags;
  const blocked = flags.length > 0;
  structuredLog({ cmd: "tier veto-check", blocked, flags });

  if (blocked) {
    return failure({
      exitCode: VETO_EXIT_CODE,
      data: { blocked: true, flags },
      human: `BLOCKED: blast-radius flag(s) present — Tier 0 forbidden (§5): ${flags.join(", ")}`,
    });
  }
  return success({
    data: { blocked: false, flags: [] },
    human: "OK: no blast-radius flag; Tier 0 not vetoed.",
  });
}
