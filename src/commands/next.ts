import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectPaths } from "../core/paths";
import { type CommandResult, success } from "../core/output";
import { readState } from "../core/state-store";
import { stageContract, nextStageAfter } from "../core/stages";
import { artifactIntegrity, sliceProgress, reviseEscalations } from "../core/health";
import { computeBreakdown } from "../core/coverage";
import { readVerifyReport } from "../core/verify";
import { occupiedComponents } from "../core/leases";
import { computeWave, validateDeps, hasDepIssues } from "../core/wave";

/**
 * `th next` — the next-action ORACLE (audit F7 — the playbook can fall out of the
 * post-compaction context window). Given durable state + on-disk anchors it
 * computes the single highest-priority MECHANICAL obligation the run owes next.
 *
 * It composes signals the CLI already owns — stage contract, coverage, revise
 * caps, blocking drift, slice statuses — into one answer. Like `th stage
 * current`, it reports a mechanical obligation; it never chooses strategy or
 * decides which stage runs (plan §3 boundary rule). The Orchestrator still
 * decides; this is the oracle it can always consult.
 *
 * `kind` is a stable machine token; `action` is the human instruction.
 */

export type NextKind =
  | "init"
  | "fix-state"
  | "resolve-blocking-drift"
  | "escalate-revise"
  | "classify-tier"
  | "re-register-artifact"
  | "produce-artifact"
  | "register-artifact"
  | "fix-coverage"
  | "investigate-failure"
  | "dispatch-wave"
  | "await-builders"
  | "stalled-build"
  | "sync-slices"
  | "finish-slices"
  | "human-signoff"
  | "advance-stage"
  | "done";

interface NextAction {
  kind: NextKind;
  action: string;
  data?: Record<string, unknown>;
}

export function runNext(paths: ProjectPaths): CommandResult {
  const r = readState(paths);
  if (!r.exists) {
    return emit({ kind: "init", action: "No TwinHarness run here. Run `th init` to scaffold the project." });
  }
  if (!r.state) {
    return emit({
      kind: "fix-state",
      action: "state.json is invalid — fix it before anything else (`th state verify` for details).",
      data: { issues: r.issues },
    });
  }
  const s = r.state;

  // 1. Blocking drift outranks stage progress — the stop-gate will refuse completion.
  if (s.drift_open_blocking > 0) {
    return emit({
      kind: "resolve-blocking-drift",
      action: `${s.drift_open_blocking} blocking drift entr${s.drift_open_blocking === 1 ? "y is" : "ies are"} open — resolve or escalate before completion (\`th drift list\` / \`th drift resolve <DRIFT-NNN>\`).`,
      data: { drift_open_blocking: s.drift_open_blocking },
    });
  }

  // 2. A revise loop at its cap owes a human decision (§18 — stop looping).
  const escalations = reviseEscalations(s);
  if (escalations.length > 0) {
    return emit({
      kind: "escalate-revise",
      action: `Revise loop at cap — escalate to the human: ${escalations.map((e) => `${e.mode} (${e.count}/${e.cap})`).join(", ")}.`,
      data: { escalations },
    });
  }

  // 2b. A failing test suite is a defect owed to the Debugger before advancing.
  const verifyReport = readVerifyReport(paths);
  if (verifyReport && !verifyReport.ok) {
    const failed = verifyReport.results.filter((x) => !x.ok).length;
    return emit({
      kind: "investigate-failure",
      action: `Test suite failing (${failed} command(s)) — assemble evidence with \`th debug pack\` and engage the Debugger before advancing.`,
      data: { failed },
    });
  }

  // 3. Silent artifact drift: a governed doc changed on disk without re-registration.
  const drifted = artifactIntegrity(paths, s).filter((i) => i.status === "changed");
  if (drifted.length > 0) {
    return emit({
      kind: "re-register-artifact",
      action: `Approved artifact changed on disk — run \`th stale --artifact ${drifted[0]!.file}\` then re-register: ${drifted.map((i) => i.file).join(", ")}.`,
      data: { changed: drifted.map((i) => i.file) },
    });
  }

  // 4. Tier not yet classified — that gates every engaged stage.
  if (s.tier === null) {
    return emit({
      kind: "classify-tier",
      action: "Tier is unclassified — classify it (`th tier classify <brief.json>` + `th tier veto-check`) and record `th state set tier T<n>`.",
      data: { current_stage: s.current_stage },
    });
  }

  // 5. Stage-specific obligations for the current stage.
  const current = s.current_stage;
  const contract = stageContract(current);

  // final-verification produces its report LAST — after slices settle and
  // coverage is clean — so it owns its full obligation order below (step 7),
  // not the generic produce/register check here.
  if (contract && contract.produces && current !== "final-verification") {
    const produced = contract.produces.replace(/\/$/, "");
    const abs = path.resolve(paths.root, produced);
    const registered = s.approved_artifacts.some((a) => a.file === produced);
    const exists = fs.existsSync(abs);
    if (!registered) {
      if (!exists) {
        return emit({
          kind: "produce-artifact",
          action: `Stage "${current}" must produce ${contract.produces} (Critic mode: ${contract.criticMode}${contract.humanGate ? "; human gate" : ""}). Produce it, pass the Critic, then register it.`,
          data: { stage: current, produces: contract.produces },
        });
      }
      return emit({
        kind: "register-artifact",
        action: `${produced} exists but is not registered — after the Critic passes${contract.humanGate ? " and the human gate clears" : ""}, run \`th artifact register ${contract.produces} --version <n>\`.`,
        data: { stage: current, file: produced },
      });
    }
  }

  // 6. Implementation-planning: coverage is the hard gate before building.
  if (current === "implementation-planning") {
    const cov = coverageBlocker(paths);
    if (cov) return emit(cov);
  }

  // 7. Final-verification: all slices settled + coverage clean + human signs off.
  if (current === "final-verification") {
    const prog = sliceProgress(s);
    if (!prog.allSettled && prog.total > 0) {
      const open = s.slices.filter((sl) => sl.status !== "done" && sl.status !== "blocked").map((sl) => sl.id);
      return emit({
        kind: "finish-slices",
        action: `Final verification is blocked while slices are unfinished — finish or block: ${open.join(", ")} (\`th slice set-status <SLICE-ID> done|blocked\`).`,
        data: { open },
      });
    }
    const cov = coverageBlocker(paths);
    if (cov) return emit(cov);

    // Slices settled + coverage clean → the report itself is the next artifact.
    if (contract && contract.produces) {
      const produced = contract.produces.replace(/\/$/, "");
      const registered = s.approved_artifacts.some((a) => a.file === produced);
      if (!registered) {
        const exists = fs.existsSync(path.resolve(paths.root, produced));
        return emit(
          exists
            ? { kind: "register-artifact", action: `${produced} exists but is not registered — after the human signs off, run \`th artifact register ${produced} --version <n>\`.`, data: { file: produced } }
            : { kind: "produce-artifact", action: `Produce ${produced} separating coherence (Critic) from correctness (tests + human), then register it.`, data: { produces: produced } },
        );
      }
    }

    return emit({
      kind: "human-signoff",
      action: "Coherence is gated and coverage is clean — present `th trace render` + the verification report for the human correctness sign-off (§11).",
    });
  }

  // 7b. Implementation: dispatch build waves, await in-flight Builders, then advance.
  if (current === "implementation") {
    const prog = sliceProgress(s);
    if (prog.total === 0) {
      return emit({
        kind: "sync-slices",
        action: "Implementation has no slices — run `th slices sync` to populate them from the implementation plan, then `th build next-wave`.",
      });
    }
    // Compute the LIVE wave so a deadlock (dependency cycle / dangling ref / a
    // dep on a blocked slice) surfaces as a stall instead of looping forever on
    // "dispatch the next wave" while nothing can actually dispatch.
    const deps = validateDeps(s.slices);
    const occupied = occupiedComponents(paths, s.slices);
    const plan = computeWave(s.slices, occupied, prog.inProgress > 0);
    if (plan.stalled || hasDepIssues(deps)) {
      const reasons = [
        ...deps.cycles.map((c) => `cycle ${c.join("→")}`),
        ...deps.dangling.map((d) => `${d.slice}→unknown ${d.missing.join(",")}`),
        ...plan.held.map((h) => `${h.id} (${h.reason}: ${h.detail.join(",")})`),
      ];
      return emit({
        kind: "stalled-build",
        action: `Build is stalled — no slice can be dispatched and none are in progress to unblock it. Fix the dependency/component deadlock, then \`th build next-wave\`. Blockers: ${reasons.join("; ")}.`,
        data: { held: plan.held, cycles: deps.cycles, dangling: deps.dangling },
      });
    }
    if (plan.wave.length > 0) {
      return emit({
        kind: "dispatch-wave",
        action: `Dispatch the next parallel build wave: ${plan.wave.join(", ")} — set each \`in-progress\` and \`th build claim <ID>\` before spawning its Builder (\`th build next-wave\`).`,
        data: { wave: plan.wave, pending: prog.pending, inProgress: prog.inProgress },
      });
    }
    if (prog.inProgress > 0) {
      return emit({
        kind: "await-builders",
        action: `${prog.inProgress} Builder(s) in flight — on each Critic PASS set the slice \`done\` and \`th build release <ID>\`, then re-check \`th build next-wave\`.`,
        data: { inProgress: prog.inProgress },
      });
    }
    // All slices settled (done/blocked) → leave the implementation stage.
  }

  // 8. Otherwise: advance to the next engaged stage for this tier.
  const next = nextStageAfter(current, s.tier);
  if (next) {
    return emit({
      kind: "advance-stage",
      action: `Stage "${current}" is settled — advance to "${next.stage}" (produces ${next.produces || "(no artifact)"}; Critic mode: ${next.criticMode}${next.humanGate ? "; human gate" : "; streams"}). Set it with \`th state set current_stage ${next.stage}\`.`,
      data: { from: current, to: next.stage, contract: next },
    });
  }

  return emit({
    kind: "done",
    action: "No mechanical obligation outstanding — the pipeline's last engaged stage is reached. The human owns final sign-off.",
    data: { current_stage: current },
  });
}

/** Coverage gate as a next-action, or undefined when coverage is clean. */
function coverageBlocker(paths: ProjectPaths): NextAction | undefined {
  const breakdown = computeBreakdown(paths.root);
  if ("error" in breakdown) {
    return { kind: "fix-coverage", action: "Coverage cannot be checked — author the requirements file first.", data: { error: breakdown.error, reqsFile: breakdown.reqsFile } };
  }
  const gaps = breakdown.rows.filter((row) => !row.planned || !row.tested);
  if (gaps.length > 0) {
    return {
      kind: "fix-coverage",
      action: `Coverage gate failing — ${gaps.length} REQ-ID(s) lack a slice and/or a test: ${gaps.map((g) => g.req).join(", ")}. Run \`th coverage check\`.`,
      data: { gaps: gaps.map((g) => ({ req: g.req, inSlice: g.planned, inTest: g.tested })) },
    };
  }
  return undefined;
}

function emit(next: NextAction): CommandResult {
  return success({ data: { kind: next.kind, action: next.action, ...(next.data ?? {}) }, human: `next: ${next.action}` });
}
