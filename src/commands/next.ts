import type { ProjectPaths } from "../core/paths";
import type { TwinHarnessState } from "../core/state-schema";
import { type CommandResult, success } from "../core/output";
import { readState } from "../core/state-store";
import { stageContract, nextStageAfterFor, canonicalizeStage, isFinalVerification } from "../core/stages";
import { sliceProgress, type ReviseEscalation } from "../core/health";
import { occupiedComponents } from "../core/leases";
import { computeWave, validateDeps, hasDepIssues } from "../core/wave";
import {
  type GateResult,
  checkBlockingDrift,
  checkReviseEscalation,
  checkVerifySuite,
  checkArtifactDrift,
  checkTierSet,
  checkInterview,
  checkRepoMap,
  checkDecisionObligations,
  checkDebate,
  checkGoverningArtifact,
  checkCoverage,
  checkFinalVerification,
  implementationRequiresSlices,
} from "../core/gate-preconditions";

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
  | "resolve-debate"
  | "classify-tier"
  | "complete-interview"
  | "refresh-repo-map"
  | "resolve-decision-obligation"
  | "re-register-artifact"
  | "produce-artifact"
  | "register-artifact"
  | "fix-coverage"
  | "investigate-failure"
  | "run-verify"
  | "dispatch-wave"
  | "await-builders"
  | "stalled-build"
  | "sync-slices"
  | "finish-slices"
  // SG3 P2-C (enforce) — production-reality rung actions (audit C-05..C-08).
  | "retire-simulation"
  | "run-tester"
  | "ledger-simulation"
  | "fix-simulation-ledger"
  // BSC-7 / Axis-B slice-3a — the human-approval completion rung action.
  | "approve-stage"
  | "human-signoff"
  | "advance-stage"
  | "done";

interface NextAction {
  kind: NextKind;
  action: string;
  /**
   * Optional WHY: why THIS obligation is the highest-priority one right now —
   * surfaced only under `th next --explain`. It explains the ordering (why this
   * kind outranks the others), not merely what the action is.
   */
  why?: string;
  data?: Record<string, unknown>;
}

export interface NextOptions {
  /** Include the WHY rationale for the chosen obligation (`th next --explain`). */
  explain?: boolean;
}

/**
 * The "open human obligations" abstraction (Phase 5 / P5-5, REQ-PCO-063).
 *
 * Three distinct mechanisms each block completion on a HUMAN reconciliation that
 * the CLI cannot perform: blocking requirement-layer drift, open blocking debates,
 * and unapproved gating decisions. Their MECHANICS are unchanged (each keeps its
 * own ledger, gate rung, and `th next` kind) — this is purely a SURFACE
 * unification: one shape that names all three as a single class of obligation so
 * `th next` can report "you owe the human N reconciliations" in one place instead
 * of three unrelated counters. Pure: it only counts on-disk signals.
 */
export interface OpenHumanObligations {
  /** Blocking requirement-layer drift entries (state.drift_open_blocking). */
  drift: number;
  /** Open blocking debates (state.debate_open_blocking). */
  debate: number;
  /** Unapproved gating decisions blocking a stage (decisions.jsonl). */
  decision: number;
  /** drift + debate + decision — the single "how many do I owe the human" number. */
  total: number;
}

/**
 * Compute the unified {@link OpenHumanObligations} summary from durable state +
 * on-disk anchors, reusing the SAME predicates the individual rungs consult (no
 * second source of truth): `checkBlockingDrift`, `checkDebate`,
 * `checkDecisionObligations`. Each `ok` rung contributes 0. The decision count is
 * 1 when a gating decision is unmet (the predicate surfaces the first blocker, the
 * unit the rung acts on), else 0 — drift/debate carry their exact open counts.
 */
export function openHumanObligations(paths: ProjectPaths, s: TwinHarnessState): OpenHumanObligations {
  const driftR = checkBlockingDrift(s);
  const drift = driftR.ok ? 0 : (s.drift_open_blocking ?? 0);

  const debateR = checkDebate(s);
  const debate = debateR.ok ? 0 : (s.debate_open_blocking ?? 0);

  const decR = checkDecisionObligations(paths, s);
  const decision = decR.ok ? 0 : 1;

  return { drift, debate, decision, total: drift + debate + decision };
}

export function runNext(paths: ProjectPaths, opts: NextOptions = {}): CommandResult {
  const explain = opts.explain === true;
  const r = readState(paths);
  if (!r.exists) {
    return emit(
      {
        kind: "init",
        action: "No TwinHarness run here. Run `th init` to scaffold the project.",
        why: "There is no `state.json` in this directory, so there is no run to advance — scaffolding is the only possible first step.",
      },
      explain,
    );
  }
  if (!r.state) {
    return emit(
      {
        kind: "fix-state",
        action: "state.json is invalid — fix it before anything else (`th state verify` for details).",
        why: "An unreadable/invalid state.json means every other signal (tier, stage, slices, drift) is untrustworthy, and the stop-gate already refuses completion — so repairing it outranks all stage work.",
        data: { issues: r.issues },
      },
      explain,
    );
  }
  const s = r.state;

  // The mechanical-obligation ladder. Each rung's PREDICATE now lives once in
  // `src/core/gate-preconditions.ts` (consumed by both this oracle and the typed
  // MCP gate tools so they can never drift); runNext renders the matching action.
  // The short-circuit ORDER below is the contract pinned by next-characterization.

  // The unified "open human obligation" view (P5-5): drift + debate + decision
  // counted once behind one abstraction. Mechanics unchanged — each obligation
  // still has its own rung below; this only attaches the unified summary to those
  // rungs' data so a consumer sees one class of obligation, not three counters.
  const obligations = openHumanObligations(paths, s);

  // 1. Blocking drift outranks stage progress — the stop-gate will refuse completion.
  const driftR = checkBlockingDrift(s);
  if (!driftR.ok) {
    return emit(
      {
        kind: "resolve-blocking-drift",
        action: `${s.drift_open_blocking} blocking drift entr${s.drift_open_blocking === 1 ? "y is" : "ies are"} open — resolve or escalate before completion (\`th drift list\` / \`th drift resolve <DRIFT-NNN>\`).${obligationSuffix(obligations)}`,
        why: "Open requirement-layer drift is a human-only escalation that the stop-gate already blocks completion on, so it outranks every stage advance — no later work can be certified while it stands.",
        data: { drift_open_blocking: s.drift_open_blocking, obligations },
      },
      explain,
    );
  }

  // 2. A revise loop at its cap owes a human decision (§18 — stop looping).
  const reviseR = checkReviseEscalation(s);
  if (!reviseR.ok) {
    const escalations = reviseR.detail!.escalations as ReviseEscalation[];
    return emit(
      {
        kind: "escalate-revise",
        action: `Revise loop at cap — escalate to the human: ${escalations.map((e) => `${e.mode} (${e.count}/${e.cap})`).join(", ")}.`,
        why: "A Critic loop at its cap (§18) means the producer↔Critic cycle is stuck with open grounded issues; continuing to loop is forbidden, so escalating to the human takes priority over starting any new stage work.",
        data: { escalations },
      },
      explain,
    );
  }

  // 2b. A failing test suite is a defect owed to the Debugger before advancing.
  const verifyR = checkVerifySuite(paths);
  if (!verifyR.ok) {
    const failed = verifyR.detail!.failed as number;
    return emit(
      {
        kind: "investigate-failure",
        action: `Test suite failing (${failed} command(s)) — assemble evidence with \`th debug pack\` and engage the Debugger before advancing.`,
        why: "The last `th verify run` is red, which is a correctness defect; advancing the pipeline on a known-failing suite would build on broken ground, so tracing the failure (Debugger) comes first.",
        data: { failed },
      },
      explain,
    );
  }

  // 3. Silent artifact drift: a governed doc changed on disk without re-registration.
  const artDriftR = checkArtifactDrift(paths, s);
  if (!artDriftR.ok) {
    const changed = artDriftR.detail!.changed as string[];
    return emit(
      {
        kind: "re-register-artifact",
        action: `Approved artifact changed on disk — run \`th stale --artifact ${changed[0]}\` then re-register: ${changed.join(", ")}.`,
        why: "A registered artifact whose on-disk hash no longer matches has silently drifted from what the run governs; re-registering (and cascading the staleness check) must happen before later stages, which would otherwise build on an out-of-date upstream.",
        data: { changed },
      },
      explain,
    );
  }

  // 4. Tier not yet classified — that gates every engaged stage.
  const tierR = checkTierSet(s);
  if (!tierR.ok) {
    return emit(
      {
        kind: "classify-tier",
        action: "Tier is unclassified — classify it (`th tier classify <brief.json>` + `th tier veto-check`), then record it with the typed gate command `th tier record <T>` (CLI fallback: `th state set tier T<n>`).",
        why: "The tier determines which stages are even engaged, so nothing downstream can be sequenced until it is set — classification gates every design stage.",
        data: { current_stage: s.current_stage },
      },
      explain,
    );
  }

  // 4-interview. Soft interview gate (audit finding #14). A REQUIRED clarity interview
  //   (interview_required, or computed true for T2/T3) that has not reached readiness
  //   must complete BEFORE advancing past `requirements`. Slots right after classify-tier
  //   to mirror canAdvanceStage's ladder (checkInterview directly after checkTierSet) so
  //   the oracle and the gate agree. Soft: it only gates the FRONT of the pipeline.
  const interviewR = checkInterview(paths, s);
  if (!interviewR.ok) {
    return emit(
      {
        kind: "complete-interview",
        action:
          "A clarity interview is required before `requirements` — run the `th:run --interview` loop until the interview reaches `ready` (the `th_interview_status` MCP tool reports it), then advance.",
        why: "This run requires a clarity interview (interview_required, or tier T2/T3) and it has not yet reached readiness; the soft gate refuses advancement past requirements until the confidence cutoff is met, so completing the interview outranks stage work.",
        data: { current_stage: interviewR.detail!.current_stage },
      },
      explain,
    );
  }

  // 4a. Brownfield repo-map freshness — a hard gate mirroring `th tier veto-check`.
  //     Only fires for a brownfield run BEFORE implementation is unlocked: once
  //     building begins, Builders writing code naturally make the map stale, so
  //     freshness is the invariant only while the map still grounds tiering and
  //     planning decisions. Reuses the single `th repo check` freshness oracle
  //     (`runRepoCheck`, via checkRepoMap) — no duplicate hashing.
  const repoR = checkRepoMap(paths, s);
  if (!repoR.ok) {
    // P4-5: a PARTIAL map (a capped/incomplete scan) blocks unlock distinctly from a
    // stale/absent one — the fix is to raise the scan caps and re-scan, not to chase a
    // drift diff. `repo_map_partial` carries `capHit` instead of `absent`.
    if (repoR.error === "repo_map_partial") {
      const capHit = repoR.detail!.capHit as string | null;
      return emit(
        {
          kind: "refresh-repo-map",
          action: `Brownfield repo-map is PARTIAL (scan cap hit: ${capHit}) — raise the scan caps (\`th repo map --max-files\`/\`--max-bytes\`) and re-run \`th repo map\` so the whole codebase is mapped before tiering or planning proceeds.`,
          why: "A partial scan means whole regions of the repo were never seen; tiering and planning on a half-mapped codebase repeats the silent-partial failure mode, so completing the scan outranks stage work.",
          data: { shape: "partial", capHit },
        },
        explain,
      );
    }
    const absent = repoR.detail!.absent as boolean;
    return emit(
      {
        kind: "refresh-repo-map",
        action: `Brownfield repo-map is ${absent ? "absent" : "stale"} — run \`th repo map\` to ${absent ? "generate" : "refresh"} it before tiering or planning proceeds.`,
        why: "In a brownfield run the repo-map grounds every tiering and planning decision; a map that is absent or has drifted from the working tree would let those decisions run on an outdated understanding, so refreshing it outranks stage work.",
        data: { shape: repoR.detail!.shape },
      },
      explain,
    );
  }

  // 4b. Decision-governance obligation: an unapproved gating decision blocks the stage
  //     (REQ-501..504). Slots after classify-tier (run-integrity already cleared above)
  //     and before produce-artifact (stage work). Uses the single gatingObligations
  //     predicate (RULE-007 / ARCH-RISK-005 — no second implementation) via
  //     checkDecisionObligations. Tolerant: a corrupt decisions.jsonl falls through cleanly.
  const decR = checkDecisionObligations(paths, s);
  if (!decR.ok) {
    const decisionId = decR.detail!.decisionId as string;
    const blockedStage = decR.detail!.blockedStage as string;
    const title = decR.detail!.title as string;
    const titlePart = title ? ` (title: "${title}")` : "";
    return emit(
      {
        kind: "resolve-decision-obligation",
        action: `Approve ${decisionId}${titlePart} — it blocks stage '${blockedStage}' from proceeding.${obligationSuffix(obligations)}`,
        why: `Decision ${decisionId} is linked to stage '${blockedStage}' and is not yet approved; no stage work can proceed while a gating decision is unmet (RULE-007).`,
        data: { decisionId, blockedStage, obligations },
      },
      explain,
    );
  }

  // 4c. Open BLOCKING debate (NEW rung — AC-B15). The stop-gate already refuses
  //     completion on an open debate (`src/commands/hook.ts:65`) but runNext()
  //     historically did NOT consult `debate_open_blocking` — a pre-existing
  //     oracle/stop-gate divergence. checkDebate closes it. This rung slots after
  //     the decision obligation and before stage-artifact work, mirroring the
  //     blocking-drift precedent (a human-only reconciliation obligation). NOTE:
  //     this intentionally changes the debate-blocked `th next` output (see the
  //     next-characterization test's debate case).
  const debateR = checkDebate(s);
  if (!debateR.ok) {
    const n = debateR.detail!.debate_open_blocking as number;
    return emit(
      {
        kind: "resolve-debate",
        action: `${n} open BLOCKING debate${n === 1 ? "" : "s"} must be reconciled before advancing — resolve or escalate (\`th debate resolve\`).${obligationSuffix(obligations)}`,
        why: "An open blocking debate is a Pattern-B reconciliation obligation that the stop-gate already refuses completion on, so it outranks stage work — the run cannot advance past an unresolved debate.",
        data: { debate_open_blocking: n, obligations },
      },
      explain,
    );
  }

  // 5. Stage-specific obligations for the current stage. Canonicalize ONCE so the
  // exact-compare branches below (and nextStageAfter) agree with the stop-gate on
  // near-miss spellings like `Final-Verification` / `10-final-verification`
  // (C-1/M-2 — without this, hook.ts and next.ts disagree).
  const current = canonicalizeStage(s.current_stage);

  // 5. The current non-final stage's governing artifact must be produced AND
  //    registered (checkGoverningArtifact excludes final-verification, which owns
  //    its own report-last ladder in step 7). validateState does NOT backstop this
  //    rung, so it is load-bearing for the stage-advance gate.
  const artR = checkGoverningArtifact(paths, s);
  if (!artR.ok) {
    const contract = stageContract(current)!;
    if (artR.error === "artifact_not_produced") {
      return emit(
        {
          kind: "produce-artifact",
          action: `Stage "${current}" must produce ${contract.produces} (Critic mode: ${contract.criticMode}${contract.humanGate ? "; human gate" : ""}). Produce it, pass the Critic, then register it.`,
          why: `The current stage "${current}" owes its artifact (${contract.produces}) and it is not yet on disk; the stage cannot be considered settled — and the run cannot advance — until that artifact exists, passes the Critic, and is registered.`,
          data: { stage: current, produces: contract.produces },
        },
        explain,
      );
    }
    const produced = artR.detail!.file as string;
    return emit(
      {
        kind: "register-artifact",
        action: `${produced} exists but is not registered — after the Critic passes${contract.humanGate ? " and the human gate clears" : ""}, run \`th artifact register ${contract.produces} --version <n>\`.`,
        why: `${produced} exists but is unregistered, so the run is not yet governing it (no recorded hash); registering it after the Critic${contract.humanGate ? " and human gate" : ""} is what lets the stage settle and the pipeline move on.`,
        data: { stage: current, file: produced },
      },
      explain,
    );
  }

  // 6. Implementation-planning: coverage is the hard gate before building.
  if (current === "implementation-planning") {
    const cov = coverageBlocker(paths);
    if (cov) return emit(cov);
  }

  // 7. Final-verification: all slices settled + coverage clean + human signs off.
  //    The full ladder (slices → verify-suite → coverage → report artifact → human
  //    sign-off) is the single predicate `checkFinalVerification`; this block only
  //    renders the matching action for whichever sub-rung is first unmet.
  if (isFinalVerification(current)) {
    const fv = checkFinalVerification(paths, s);
    if (fv.ok) {
      return emit(
        {
          kind: "human-signoff",
          action: "Coherence is gated and coverage is clean — present `th trace render` + the verification report for the human correctness sign-off (§11).",
          why: "Every mechanical gate is satisfied (slices settled, coverage clean, report registered); what remains is the one thing the CLI cannot certify — correctness — which only the human can sign off.",
        },
        explain,
      );
    }
    switch (fv.error) {
      case "slices_unsettled": {
        const open = fv.detail!.open as string[];
        return emit(
          {
            kind: "finish-slices",
            action: `Final verification is blocked while slices are unfinished — finish or block: ${open.join(", ")} (\`th slice set-status <SLICE-ID> done|blocked\`).`,
            why: "At final-verification the stop-gate mechanically refuses completion while any slice is neither done nor blocked, so settling the open slices outranks producing the verification report.",
            data: { open },
          },
          explain,
        );
      }
      case "verify_config_corrupt": {
        // R-23: verify.json is present but unreadable/corrupt — fail CLOSED. A corrupt
        // config used to read as an empty (and thus trivially "passing") suite; now it
        // is its own blocker so `th next` points at the repair rather than waving the
        // run through to the human sign-off.
        return emit(
          {
            kind: "run-verify",
            action:
              "Final verification is blocked — verify.json is present but unreadable/corrupt. " +
              "Inspect it, or run `th verify clear` and re-add the commands, then `th verify approve` and `th verify run` before sign-off.",
            why: "An unreadable verify config must fail CLOSED: treating it as an empty/approved set would let a run claim completion without ever exercising the suite the operator wired up.",
          },
          explain,
        );
      }
      case "verify_suite_never_run": {
        const commands = fv.detail!.commands as number;
        return emit(
          {
            kind: "run-verify",
            action: `Final verification needs a green suite — ${commands} verify command(s) are configured but \`th verify run\` has never been recorded. Run \`th verify run\` and confirm it is green before sign-off.`,
            why: "At final-verification the stop-gate refuses completion when verify commands are configured but the suite has never been run, so recording a green `th verify run` outranks producing the verification report or seeking the human sign-off.",
            data: { commands },
          },
          explain,
        );
      }
      case "reqs_file_missing":
      case "coverage_failing": {
        const cov = coverageBlocker(paths);
        if (cov) return emit(cov, explain);
        break;
      }
      case "report_not_registered": {
        const produced = fv.detail!.file as string;
        return emit(
          { kind: "register-artifact", action: `${produced} exists but is not registered — after the human signs off, run \`th artifact register ${produced} --version <n>\`.`, why: "Slices are settled and coverage is clean, so the only thing standing between here and a governed completion is recording the verification report's hash after the human signs off.", data: { file: produced } },
          explain,
        );
      }
      case "report_not_produced": {
        const produced = fv.detail!.produces as string;
        return emit(
          { kind: "produce-artifact", action: `Produce ${produced} separating coherence (Critic) from correctness (tests + human), then register it.`, why: "Slices are settled and coverage is clean, so the run now owes the verification report itself — the last artifact, which must separate Critic-certified coherence from test/human-certified correctness.", data: { produces: produced } },
          explain,
        );
      }
      // SG3 P2-C (enforce) — the production-reality rung (audit C-05..C-08). The same
      // stable tokens checkProductionReality returns (so `th next` and the MCP gate
      // tools agree); each maps to the action that clears it.
      case "simulation_unretired": {
        const ids = (fv.detail!.ids as string[]) ?? [];
        return emit(
          {
            kind: "retire-simulation",
            action: `Final verification is blocked — user-visible simulation still active: ${ids.join(", ")}. Replace it with the real (or sandbox) dependency and \`th sim retire <SIM-NNN>\` before sign-off (\`th sim list\`).`,
            why: "A feature must not be certified complete while its user-visible production path depends on unresolved simulated behavior — the production-reality gate refuses completion until every such simulation is retired.",
            data: { ids },
          },
          explain,
        );
      }
      case "production_verify_not_green": {
        return emit(
          {
            kind: "run-verify",
            action: "Final verification is blocked — the verify suite is not green against production-targeted commands. Run `th verify run` and confirm green before sign-off.",
            why: "Production reality requires the suite to pass against the real path; a red/never-run/corrupt verify result cannot certify completion.",
            data: { ...(fv.detail ?? {}) },
          },
          explain,
        );
      }
      case "tester_record_missing": {
        return emit(
          {
            kind: "run-tester",
            action: "Final verification is blocked — no live-QA Tester record is attached. Run the Tester against the real (or sandbox) boundary, then attach the record with `th tester record --driver <d> [--provider real|sandbox] [--evidence-ref <p>]` (and note the same evidence in the verification report's Tester Evidence section).",
            why: "At final-verification the live Tester is mandatory: a green anchored-test suite can pass on mocks, so production reality needs a recorded live run exercising the user-visible production path. `th tester record` writes the marker the gate reads.",
          },
          explain,
        );
      }
      case "unledgered_simulation_in_dist": {
        const total = (fv.detail!.total as number) ?? 0;
        return emit(
          {
            kind: "ledger-simulation",
            action: `Final verification is blocked — dist/ carries ${total} unledgered simulation pattern(s) (\`th sim scan\`). Declare each with \`th sim add\` (and retire it) or remove it before sign-off.`,
            why: "Undeclared simulation in the built artifact means a fake could pass as production; the gate refuses completion until every dist/ simulation is ledgered (and retired) or removed.",
            data: { total },
          },
          explain,
        );
      }
      case "simulation_ledger_corrupt": {
        return emit(
          {
            kind: "fix-simulation-ledger",
            action: "Final verification is blocked — .twinharness/simulation-ledger.json is corrupt/unreadable. Inspect and repair it before sign-off (it must be a JSON array of simulation entries).",
            why: "An unreadable simulation ledger must fail CLOSED: treating it as empty would let an undeclared simulation pass as production.",
          },
          explain,
        );
      }
      case "human_approval_unverified": {
        const stage = (fv.detail!.stage as string) ?? "";
        const status = (fv.detail!.status as string) ?? "";
        return emit(
          {
            kind: "approve-stage",
            action: `Final verification is blocked — the human approval for the '${stage}' stage is ${status || "missing/invalid"}. A human must approve it at the current snapshot (\`th approve ${stage}\`) before sign-off; the approval binds the stage's governing artifact, so re-approve after any change to it.`,
            why: "BSC-7: a `humanGate` stage must carry a snapshot- and artifact-bound human approval before completion. The closed required-set (engaged-and-not-future humanGate stages) is re-validated fresh at the completion gate, so an `--emergency`/`state set` jump cannot route around it.",
            data: { stage, status },
          },
          explain,
        );
      }
    }
  }

  // 7b. Implementation: dispatch build waves, await in-flight Builders, then advance.
  if (current === "implementation") {
    const prog = sliceProgress(s);
    // Empty slices: for a CODE project (default) this is an unsynced plan — emit
    // sync-slices, and `checkImplementationSettled` AGREES it is unsettled (finding #2,
    // shared `implementationRequiresSlices` predicate). For no-code/documentation-only
    // an empty set is legitimately settled, so we fall through to the stage advance.
    if (prog.total === 0 && implementationRequiresSlices(s)) {
      return emit(
        {
          kind: "sync-slices",
          action: "Implementation has no slices — run `th slices sync` to populate them from the implementation plan, then `th build next-wave`.",
          why: "The stage is `implementation` but `state.slices` is empty, so there is nothing to dispatch; syncing the plan into state is the prerequisite for any build wave.",
        },
        explain,
      );
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
      return emit(
        {
          kind: "stalled-build",
          action: `Build is stalled — no slice can be dispatched and none are in progress to unblock it. Fix the dependency/component deadlock, then \`th build next-wave\`. Blockers: ${reasons.join("; ")}.`,
          why: "No pending slice can dispatch (a dependency cycle, a dangling dep, or a component conflict) and nothing is in flight to unblock it — so the build cannot make progress until the deadlock in the plan is fixed.",
          data: { held: plan.held, cycles: deps.cycles, dangling: deps.dangling },
        },
        explain,
      );
    }
    if (plan.wave.length > 0) {
      return emit(
        {
          kind: "dispatch-wave",
          action: `Dispatch the next parallel build wave: ${plan.wave.join(", ")} — run \`th build dispatch\` for the full spawn set (per-slice model/effort in one payload), then set each \`in-progress\` and \`th build claim <ID>\` before spawning its Builder.`,
          why: "A conflict-free wave of slices is ready (deps done, components free), so dispatching it is the highest-value next step — it is the build making forward progress. `th build dispatch` emits every wave Builder's spawn descriptor in one payload (it does not mutate state, so each slice still needs in-progress + a component claim before spawning).",
          data: { wave: plan.wave, pending: prog.pending, inProgress: prog.inProgress },
        },
        explain,
      );
    }
    if (prog.inProgress > 0) {
      return emit(
        {
          kind: "await-builders",
          action: `${prog.inProgress} Builder(s) in flight — on each Critic PASS set the slice \`done\` and \`th build release <ID>\`, then re-check \`th build next-wave\`.`,
          why: "No new wave can dispatch yet (its components are held by in-flight slices), so the run owes nothing but to await the live Builders and settle each on its Critic PASS before the next wave opens.",
          data: { inProgress: prog.inProgress },
        },
        explain,
      );
    }
    // All slices settled (done/blocked) → leave the implementation stage.
  }

  // 8. Otherwise: advance to the next APPLICABLE engaged stage for this state. Uses
  //    nextStageAfterFor (finding #13) so a no-UI project (has_ui===false) advances
  //    straight past the not-applicable ux-design/ui-design stages instead of stalling.
  const next = nextStageAfterFor(current, s);
  if (next) {
    return emit(
      {
        kind: "advance-stage",
        action: `Stage "${current}" is settled — advance to "${next.stage}" (produces ${next.produces || "(no artifact)"}; Critic mode: ${next.criticMode}${next.humanGate ? "; human gate" : "; streams"}). Advance with the typed gate command \`th stage advance\` (CLI fallback: \`th state set current_stage ${next.stage}\`)${next.stage === "implementation" ? "; unlock the build with `th implementation unlock`" : ""}.`,
        why: `Stage "${current}" has met all its mechanical obligations and no higher-priority blocker is open, so the only thing left is to move the pipeline forward to the next engaged stage for tier ${s.tier}.`,
        data: { from: current, to: next.stage, contract: next },
      },
      explain,
    );
  }

  return emit(
    {
      kind: "done",
      action: "No mechanical obligation outstanding — the pipeline's last engaged stage is reached. The human owns final sign-off.",
      why: "Every mechanical gate the CLI can compute is satisfied and there is no further engaged stage for this tier, so nothing mechanical remains — final authority is the human's.",
      data: { current_stage: current },
    },
    explain,
  );
}

/**
 * Coverage gate as a next-action, or undefined when coverage is clean. Renders the
 * shared `checkCoverage` predicate (single source of truth) into the `fix-coverage`
 * message — the data payload is preserved byte-for-byte from the prior inline logic.
 */
function coverageBlocker(paths: ProjectPaths): NextAction | undefined {
  const cov = checkCoverage(paths);
  if (cov.ok) return undefined;
  if (cov.error === "reqs_file_missing") {
    return {
      kind: "fix-coverage",
      action: "Coverage cannot be checked — author the requirements file first.",
      why: "Coverage is the hard gate before building, and it cannot even be computed without a requirements file — so authoring it precedes everything downstream.",
      data: { error: cov.detail!.error, reqsFile: cov.detail!.reqsFile },
    };
  }
  // The only remaining failure code is `coverage_failing` (gaps present).
  const gaps = cov.detail!.gaps as Array<{ req: string; inSlice: boolean; inTest: boolean }>;
  return {
    kind: "fix-coverage",
    action: `Coverage gate failing — ${gaps.length} REQ-ID(s) lack a slice and/or a test: ${gaps.map((g) => g.req).join(", ")}. Run \`th coverage check\`.`,
    why: "The coverage gate mechanically blocks the build until every MVP REQ-ID maps to ≥1 slice and ≥1 test; the listed gaps must be closed before implementation may proceed.",
    data: { gaps },
  };
}

/**
 * Render a NextAction as a command result. When `explain` is set, the WHY
 * rationale (why this obligation is the highest-priority one) is included in
 * both the JSON `data.why` and the human line; otherwise it is omitted entirely
 * so the default output is unchanged.
 */
/**
 * The unified "open human obligation" suffix (P5-5): when MORE THAN ONE class of
 * obligation is open at once (e.g. blocking drift AND an open debate), append a
 * single line naming the full set so the operator sees the whole human-owed
 * backlog from any one rung — instead of discovering each only after clearing the
 * last. Empty when ≤1 class is open, so the common single-obligation output is
 * unchanged. Mechanics are untouched; this is surface only.
 */
function obligationSuffix(o: OpenHumanObligations): string {
  const open = [
    o.drift > 0 ? `${o.drift} blocking drift` : null,
    o.debate > 0 ? `${o.debate} open debate${o.debate === 1 ? "" : "s"}` : null,
    o.decision > 0 ? `${o.decision} unapproved gating decision` : null,
  ].filter((x): x is string => x !== null);
  if (open.length <= 1) return "";
  return ` (open human obligations: ${o.total} total — ${open.join(", ")}; clear all before completion).`;
}

function emit(next: NextAction, explain = false): CommandResult {
  const data: Record<string, unknown> = { kind: next.kind, action: next.action, ...(next.data ?? {}) };
  if (explain && next.why) data.why = next.why;
  const human = explain && next.why ? `next: ${next.action}\nwhy: ${next.why}` : `next: ${next.action}`;
  return success({ data, human });
}

/**
 * Project a canonical gate token (the stable `error` a gate-precondition rung
 * returns) to the SAME human sentence `th next` emits for that rung (R-29,
 * observability). The Stop gate renders its block reason through THIS function so a
 * blocked Stop and a `th next` pointed at the identical rung print the same wording
 * — the Stop↔next token-parity contract (the enum-iterated parity matrix test pins
 * it). `detail` is the rung's structured payload (ids, counts) the sentence
 * interpolates; an absent/partial detail degrades to the bare sentence.
 *
 * The mapping is exhaustive over the COMPLETION-relevant tokens (the always-run
 * human-reconciliation obligations + every `checkFinalVerification` sub-rung token,
 * including the production-reality tokens). An UNKNOWN token (a rung added without a
 * sentence) returns a generic but honest fallback naming the token, so the gate is
 * never silent — the parity test asserts no completion token hits that fallback.
 */
export function renderStopReason(token: string, detail?: Record<string, unknown>): string {
  const d = detail ?? {};
  const num = (k: string): number => (typeof d[k] === "number" ? (d[k] as number) : 0);
  const ids = (k: string): string[] => (Array.isArray(d[k]) ? (d[k] as string[]) : []);
  switch (token) {
    // --- always-run human-reconciliation obligations (block at ANY stage) ----------
    case "blocking_drift_open": {
      const n = num("drift_open_blocking");
      return `${n} blocking drift entr${n === 1 ? "y is" : "ies are"} open — resolve or escalate before completion (\`th drift list\` / \`th drift resolve <DRIFT-NNN>\`).`;
    }
    case "revise_escalation_open":
      return "A revise loop is at its cap — escalate to the human (\`th drift\`/Critic loop §18) before completing.";
    case "decision_obligation_open": {
      const id = typeof d.decisionId === "string" ? d.decisionId : "";
      const stage = typeof d.blockedStage === "string" ? d.blockedStage : "";
      return `An unapproved decision${id ? ` (${id})` : ""} gates the current stage${stage ? ` '${stage}'` : ""}; approve or reject via \`th decision approve\` (see \`th decision check\`) before completing.`;
    }
    case "debate_open_blocking": {
      const n = num("debate_open_blocking");
      return `${n} open BLOCKING debate${n === 1 ? "" : "s"} must be reconciled (\`th debate resolve\`) before completing.`;
    }
    // --- present-but-invalid state -------------------------------------------------
    case "invalid_state":
      return "state.json is present but does NOT validate against the schema; repair it before claiming any stage complete.";
    // --- final-verification ladder (the strict completion gate) --------------------
    case "slices_unsettled": {
      const open = ids("open");
      return `Final verification is blocked while slices are unfinished — finish or block${open.length ? `: ${open.join(", ")}` : ""} (\`th slice set-status <SLICE-ID> done|blocked\`).`;
    }
    case "verify_config_corrupt":
      return "Final verification is blocked — verify.json is present but unreadable/corrupt. Inspect it, or run \`th verify clear\` and re-add the commands, then \`th verify approve\` and \`th verify run\` before sign-off.";
    case "verify_suite_never_run": {
      const n = num("commands");
      return `Final verification needs a green suite — ${n} verify command(s) are configured but \`th verify run\` has never been recorded. Run \`th verify run\` and confirm it is green before sign-off.`;
    }
    case "reqs_file_missing":
      return "Coverage cannot be checked — author the requirements file first.";
    case "coverage_failing": {
      const gaps = Array.isArray(d.gaps) ? (d.gaps as Array<{ req: string }>) : [];
      return `Coverage gate failing — ${gaps.length} REQ-ID(s) lack a slice and/or a test${gaps.length ? `: ${gaps.map((g) => g.req).join(", ")}` : ""}. Run \`th coverage check\`.`;
    }
    case "report_not_registered": {
      const file = typeof d.file === "string" ? d.file : "the verification report";
      return `${file} exists but is not registered — after the human signs off, run \`th artifact register ${file} --version <n>\`.`;
    }
    case "report_not_produced": {
      const produced = typeof d.produces === "string" ? d.produces : "the verification report";
      return `Produce ${produced} separating coherence (Critic) from correctness (tests + human), then register it.`;
    }
    // --- production-reality rung tokens (audit C-05..C-08) -------------------------
    case "simulation_unretired": {
      const list = ids("ids");
      return `Final verification is blocked — user-visible simulation still active${list.length ? `: ${list.join(", ")}` : ""}. Replace it with the real (or sandbox) dependency and \`th sim retire <SIM-NNN>\` before sign-off (\`th sim list\`).`;
    }
    case "production_verify_not_green":
      return "Final verification is blocked — the verify suite is not green against production-targeted commands. Run \`th verify run\` and confirm green before sign-off.";
    case "tester_record_missing":
      return "Final verification is blocked — no live-QA Tester record is attached. Run the Tester against the real (or sandbox) boundary, then attach the record with \`th tester record --driver <d> [--provider real|sandbox] [--evidence-ref <p>]\` (and note the same evidence in the verification report's Tester Evidence section).";
    case "unledgered_simulation_in_dist": {
      const n = num("total");
      return `Final verification is blocked — dist/ carries ${n} unledgered simulation pattern(s) (\`th sim scan\`). Declare each with \`th sim add\` (and retire it) or remove it before sign-off.`;
    }
    case "simulation_ledger_corrupt":
      return "Final verification is blocked — .twinharness/simulation-ledger.json is corrupt/unreadable. Inspect and repair it before sign-off (it must be a JSON array of simulation entries).";
    // --- human-approval completion rung (BSC-7 / Axis-B slice-3a) ------------------
    case "human_approval_unverified": {
      const stage = typeof d.stage === "string" ? d.stage : "";
      const status = typeof d.status === "string" ? d.status : "";
      return `Final verification is blocked — the human approval for the '${stage}' stage is ${status || "missing/invalid"}. A human must approve it at the current snapshot (\`th approve ${stage}\`) before sign-off; the approval binds the stage's governing artifact, so re-approve after any change to it.`;
    }
    default:
      // Honest fallback: never silent. The Stop↔next parity test asserts no
      // completion-relevant token reaches here (every such token has a sentence above).
      return `Completion is blocked by an unmet gate (${token}). Run \`th next\` for the specific obligation.`;
  }
}
