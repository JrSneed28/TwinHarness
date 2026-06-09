import * as path from "node:path";
import type { ProjectPaths } from "../core/paths";
import { type CommandResult, success, failure } from "../core/output";
import { type ValidationIssue } from "../core/state-schema";
import { loadBriefFromFile, type TaskBrief } from "../core/brief";
import { structuredLog } from "../core/log";

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

function formatIssues(issues: ValidationIssue[] | undefined): string {
  return (issues ?? []).map((i) => `  - ${i.path}: ${i.message}`).join("\n");
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
  const briefFile = path.isAbsolute(briefPath) ? briefPath : path.join(paths.root, briefPath);
  const loaded = loadBriefFromFile(briefFile);
  if (!loaded.ok || !loaded.brief) return briefLoadFailure(briefFile, loaded.issues);

  const { tier0_eligible, blocked_by_veto, reasons } = classifyBrief(loaded.brief);
  const advisory = tier0_eligible ? "T0" : "≥T1";
  structuredLog({ cmd: "tier classify", advisory, blocked_by_veto });

  const human = tier0_eligible
    ? "Advisory: T0 — all five Tier-0 conditions hold and no blast-radius flag is present."
    : `Advisory: ≥T1 — Tier 0 not eligible:\n${reasons.map((r) => `  - ${r}`).join("\n")}`;

  return success({
    data: {
      tier0_eligible,
      blocked_by_veto,
      blast_radius_flags: loaded.brief.blast_radius_flags,
      advisory,
      reasons,
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
  // Resolve the brief path against the project root (--cwd), like `th artifact register`.
  const briefFile = path.isAbsolute(briefPath) ? briefPath : path.join(paths.root, briefPath);
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
