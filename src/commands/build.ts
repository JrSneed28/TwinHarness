import type { ProjectPaths } from "../core/paths";
import { type CommandResult, success, failure } from "../core/output";
import { readState } from "../core/state-store";
import { type ValidationIssue } from "../core/state-schema";
import { scheduleWaves, conflictPairs } from "../core/schedule";
import { structuredLog } from "../core/log";

/**
 * `th build plan` — the mechanical parallel-build serializer (spec §16; build
 * plan §4 Slice 7 (b)). It computes a deterministic wave schedule over the
 * slices: disjoint-component slices share a wave (Builders may run concurrently),
 * shared-component slices are split across waves (serialized to avoid merge
 * conflicts / drift races). Pure traceability arithmetic over `state.slices` —
 * it never decides *whether* a Builder runs, only the conflict-free ordering.
 */

function formatIssues(issues: ValidationIssue[] | undefined): string {
  return (issues ?? []).map((i) => `  - ${i.path}: ${i.message}`).join("\n");
}

const NOT_INIT = failure({
  human: "No state.json found. Run `th init` first.",
  data: { error: "not_initialized" },
});

export interface BuildPlanOptions {
  /** Include slices with status `done` (default: only schedule unfinished slices). */
  includeDone?: boolean;
}

/**
 * `th build plan [--include-done]` — schedule the slices into conflict-free
 * build waves. By default only unfinished slices (pending/in-progress/blocked)
 * are scheduled; `--include-done` schedules all of them.
 */
export function runBuildPlan(paths: ProjectPaths, opts: BuildPlanOptions = {}): CommandResult {
  const r = readState(paths);
  if (!r.exists) return NOT_INIT;
  if (!r.state) {
    return failure({
      human: `state.json is invalid:\n${formatIssues(r.issues)}`,
      data: { error: "invalid_state", issues: r.issues },
    });
  }

  const selected = opts.includeDone
    ? r.state.slices
    : r.state.slices.filter((s) => s.status !== "done");

  const waves = scheduleWaves(selected);
  const conflicts = conflictPairs(selected);
  const parallelism = waves.reduce((max, w) => Math.max(max, w.length), 0);

  structuredLog({
    cmd: "build plan",
    slices: selected.length,
    waves: waves.length,
    conflicts: conflicts.length,
    parallelism,
  });

  const waveLines = waves.length
    ? waves.map((w, i) => `Wave ${i + 1} (parallel): ${w.join(", ")}`)
    : ["(no slices to schedule)"];
  const conflictLines = conflicts.length
    ? ["Serialized conflicts (shared components):", ...conflicts.map((c) => `  ${c.a} × ${c.b} (shared: ${c.shared.join(", ")})`)]
    : ["Serialized conflicts (shared components): (none)"];
  const human = [
    ...waveLines,
    "",
    ...conflictLines,
    "",
    "Within a wave Builders may run concurrently (§16); across waves they serialize.",
  ].join("\n");

  return success({ data: { waves, conflicts, parallelism }, human });
}
