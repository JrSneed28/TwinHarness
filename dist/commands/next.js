"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runNext = runNext;
const output_1 = require("../core/output");
const state_store_1 = require("../core/state-store");
const stages_1 = require("../core/stages");
const health_1 = require("../core/health");
const leases_1 = require("../core/leases");
const wave_1 = require("../core/wave");
const gate_preconditions_1 = require("../core/gate-preconditions");
function runNext(paths, opts = {}) {
    const explain = opts.explain === true;
    const r = (0, state_store_1.readState)(paths);
    if (!r.exists) {
        return emit({
            kind: "init",
            action: "No TwinHarness run here. Run `th init` to scaffold the project.",
            why: "There is no `state.json` in this directory, so there is no run to advance — scaffolding is the only possible first step.",
        }, explain);
    }
    if (!r.state) {
        return emit({
            kind: "fix-state",
            action: "state.json is invalid — fix it before anything else (`th state verify` for details).",
            why: "An unreadable/invalid state.json means every other signal (tier, stage, slices, drift) is untrustworthy, and the stop-gate already refuses completion — so repairing it outranks all stage work.",
            data: { issues: r.issues },
        }, explain);
    }
    const s = r.state;
    // The mechanical-obligation ladder. Each rung's PREDICATE now lives once in
    // `src/core/gate-preconditions.ts` (consumed by both this oracle and the typed
    // MCP gate tools so they can never drift); runNext renders the matching action.
    // The short-circuit ORDER below is the contract pinned by next-characterization.
    // 1. Blocking drift outranks stage progress — the stop-gate will refuse completion.
    const driftR = (0, gate_preconditions_1.checkBlockingDrift)(s);
    if (!driftR.ok) {
        return emit({
            kind: "resolve-blocking-drift",
            action: `${s.drift_open_blocking} blocking drift entr${s.drift_open_blocking === 1 ? "y is" : "ies are"} open — resolve or escalate before completion (\`th drift list\` / \`th drift resolve <DRIFT-NNN>\`).`,
            why: "Open requirement-layer drift is a human-only escalation that the stop-gate already blocks completion on, so it outranks every stage advance — no later work can be certified while it stands.",
            data: { drift_open_blocking: s.drift_open_blocking },
        }, explain);
    }
    // 2. A revise loop at its cap owes a human decision (§18 — stop looping).
    const reviseR = (0, gate_preconditions_1.checkReviseEscalation)(s);
    if (!reviseR.ok) {
        const escalations = reviseR.detail.escalations;
        return emit({
            kind: "escalate-revise",
            action: `Revise loop at cap — escalate to the human: ${escalations.map((e) => `${e.mode} (${e.count}/${e.cap})`).join(", ")}.`,
            why: "A Critic loop at its cap (§18) means the producer↔Critic cycle is stuck with open grounded issues; continuing to loop is forbidden, so escalating to the human takes priority over starting any new stage work.",
            data: { escalations },
        }, explain);
    }
    // 2b. A failing test suite is a defect owed to the Debugger before advancing.
    const verifyR = (0, gate_preconditions_1.checkVerifySuite)(paths);
    if (!verifyR.ok) {
        const failed = verifyR.detail.failed;
        return emit({
            kind: "investigate-failure",
            action: `Test suite failing (${failed} command(s)) — assemble evidence with \`th debug pack\` and engage the Debugger before advancing.`,
            why: "The last `th verify run` is red, which is a correctness defect; advancing the pipeline on a known-failing suite would build on broken ground, so tracing the failure (Debugger) comes first.",
            data: { failed },
        }, explain);
    }
    // 3. Silent artifact drift: a governed doc changed on disk without re-registration.
    const artDriftR = (0, gate_preconditions_1.checkArtifactDrift)(paths, s);
    if (!artDriftR.ok) {
        const changed = artDriftR.detail.changed;
        return emit({
            kind: "re-register-artifact",
            action: `Approved artifact changed on disk — run \`th stale --artifact ${changed[0]}\` then re-register: ${changed.join(", ")}.`,
            why: "A registered artifact whose on-disk hash no longer matches has silently drifted from what the run governs; re-registering (and cascading the staleness check) must happen before later stages, which would otherwise build on an out-of-date upstream.",
            data: { changed },
        }, explain);
    }
    // 4. Tier not yet classified — that gates every engaged stage.
    const tierR = (0, gate_preconditions_1.checkTierSet)(s);
    if (!tierR.ok) {
        return emit({
            kind: "classify-tier",
            action: "Tier is unclassified — classify it (`th tier classify <brief.json>` + `th tier veto-check`), then record it with the typed gate command `th tier record <T>` (CLI fallback: `th state set tier T<n>`).",
            why: "The tier determines which stages are even engaged, so nothing downstream can be sequenced until it is set — classification gates every design stage.",
            data: { current_stage: s.current_stage },
        }, explain);
    }
    // 4-interview. Soft interview gate (audit finding #14). A REQUIRED clarity interview
    //   (interview_required, or computed true for T2/T3) that has not reached readiness
    //   must complete BEFORE advancing past `requirements`. Slots right after classify-tier
    //   to mirror canAdvanceStage's ladder (checkInterview directly after checkTierSet) so
    //   the oracle and the gate agree. Soft: it only gates the FRONT of the pipeline.
    const interviewR = (0, gate_preconditions_1.checkInterview)(paths, s);
    if (!interviewR.ok) {
        return emit({
            kind: "complete-interview",
            action: "A clarity interview is required before `requirements` — run the `th:run --interview` loop until the interview reaches `ready` (the `th_interview_status` MCP tool reports it), then advance.",
            why: "This run requires a clarity interview (interview_required, or tier T2/T3) and it has not yet reached readiness; the soft gate refuses advancement past requirements until the ambiguity threshold is met, so completing the interview outranks stage work.",
            data: { current_stage: interviewR.detail.current_stage },
        }, explain);
    }
    // 4a. Brownfield repo-map freshness — a hard gate mirroring `th tier veto-check`.
    //     Only fires for a brownfield run BEFORE implementation is unlocked: once
    //     building begins, Builders writing code naturally make the map stale, so
    //     freshness is the invariant only while the map still grounds tiering and
    //     planning decisions. Reuses the single `th repo check` freshness oracle
    //     (`runRepoCheck`, via checkRepoMap) — no duplicate hashing.
    const repoR = (0, gate_preconditions_1.checkRepoMap)(paths, s);
    if (!repoR.ok) {
        const absent = repoR.detail.absent;
        return emit({
            kind: "refresh-repo-map",
            action: `Brownfield repo-map is ${absent ? "absent" : "stale"} — run \`th repo map\` to ${absent ? "generate" : "refresh"} it before tiering or planning proceeds.`,
            why: "In a brownfield run the repo-map grounds every tiering and planning decision; a map that is absent or has drifted from the working tree would let those decisions run on an outdated understanding, so refreshing it outranks stage work.",
            data: { shape: repoR.detail.shape },
        }, explain);
    }
    // 4b. Decision-governance obligation: an unapproved gating decision blocks the stage
    //     (REQ-501..504). Slots after classify-tier (run-integrity already cleared above)
    //     and before produce-artifact (stage work). Uses the single gatingObligations
    //     predicate (RULE-007 / ARCH-RISK-005 — no second implementation) via
    //     checkDecisionObligations. Tolerant: a corrupt decisions.jsonl falls through cleanly.
    const decR = (0, gate_preconditions_1.checkDecisionObligations)(paths, s);
    if (!decR.ok) {
        const decisionId = decR.detail.decisionId;
        const blockedStage = decR.detail.blockedStage;
        const title = decR.detail.title;
        const titlePart = title ? ` (title: "${title}")` : "";
        return emit({
            kind: "resolve-decision-obligation",
            action: `Approve ${decisionId}${titlePart} — it blocks stage '${blockedStage}' from proceeding.`,
            why: `Decision ${decisionId} is linked to stage '${blockedStage}' and is not yet approved; no stage work can proceed while a gating decision is unmet (RULE-007).`,
            data: { decisionId, blockedStage },
        }, explain);
    }
    // 4c. Open BLOCKING debate (NEW rung — AC-B15). The stop-gate already refuses
    //     completion on an open debate (`src/commands/hook.ts:65`) but runNext()
    //     historically did NOT consult `debate_open_blocking` — a pre-existing
    //     oracle/stop-gate divergence. checkDebate closes it. This rung slots after
    //     the decision obligation and before stage-artifact work, mirroring the
    //     blocking-drift precedent (a human-only reconciliation obligation). NOTE:
    //     this intentionally changes the debate-blocked `th next` output (see the
    //     next-characterization test's debate case).
    const debateR = (0, gate_preconditions_1.checkDebate)(s);
    if (!debateR.ok) {
        const n = debateR.detail.debate_open_blocking;
        return emit({
            kind: "resolve-debate",
            action: `${n} open BLOCKING debate${n === 1 ? "" : "s"} must be reconciled before advancing — resolve or escalate (\`th debate resolve\`).`,
            why: "An open blocking debate is a Pattern-B reconciliation obligation that the stop-gate already refuses completion on, so it outranks stage work — the run cannot advance past an unresolved debate.",
            data: { debate_open_blocking: n },
        }, explain);
    }
    // 5. Stage-specific obligations for the current stage. Canonicalize ONCE so the
    // exact-compare branches below (and nextStageAfter) agree with the stop-gate on
    // near-miss spellings like `Final-Verification` / `10-final-verification`
    // (C-1/M-2 — without this, hook.ts and next.ts disagree).
    const current = (0, stages_1.canonicalizeStage)(s.current_stage);
    // 5. The current non-final stage's governing artifact must be produced AND
    //    registered (checkGoverningArtifact excludes final-verification, which owns
    //    its own report-last ladder in step 7). validateState does NOT backstop this
    //    rung, so it is load-bearing for the stage-advance gate.
    const artR = (0, gate_preconditions_1.checkGoverningArtifact)(paths, s);
    if (!artR.ok) {
        const contract = (0, stages_1.stageContract)(current);
        if (artR.error === "artifact_not_produced") {
            return emit({
                kind: "produce-artifact",
                action: `Stage "${current}" must produce ${contract.produces} (Critic mode: ${contract.criticMode}${contract.humanGate ? "; human gate" : ""}). Produce it, pass the Critic, then register it.`,
                why: `The current stage "${current}" owes its artifact (${contract.produces}) and it is not yet on disk; the stage cannot be considered settled — and the run cannot advance — until that artifact exists, passes the Critic, and is registered.`,
                data: { stage: current, produces: contract.produces },
            }, explain);
        }
        const produced = artR.detail.file;
        return emit({
            kind: "register-artifact",
            action: `${produced} exists but is not registered — after the Critic passes${contract.humanGate ? " and the human gate clears" : ""}, run \`th artifact register ${contract.produces} --version <n>\`.`,
            why: `${produced} exists but is unregistered, so the run is not yet governing it (no recorded hash); registering it after the Critic${contract.humanGate ? " and human gate" : ""} is what lets the stage settle and the pipeline move on.`,
            data: { stage: current, file: produced },
        }, explain);
    }
    // 6. Implementation-planning: coverage is the hard gate before building.
    if (current === "implementation-planning") {
        const cov = coverageBlocker(paths);
        if (cov)
            return emit(cov);
    }
    // 7. Final-verification: all slices settled + coverage clean + human signs off.
    //    The full ladder (slices → verify-suite → coverage → report artifact → human
    //    sign-off) is the single predicate `checkFinalVerification`; this block only
    //    renders the matching action for whichever sub-rung is first unmet.
    if ((0, stages_1.isFinalVerification)(current)) {
        const fv = (0, gate_preconditions_1.checkFinalVerification)(paths, s);
        if (fv.ok) {
            return emit({
                kind: "human-signoff",
                action: "Coherence is gated and coverage is clean — present `th trace render` + the verification report for the human correctness sign-off (§11).",
                why: "Every mechanical gate is satisfied (slices settled, coverage clean, report registered); what remains is the one thing the CLI cannot certify — correctness — which only the human can sign off.",
            }, explain);
        }
        switch (fv.error) {
            case "slices_unsettled": {
                const open = fv.detail.open;
                return emit({
                    kind: "finish-slices",
                    action: `Final verification is blocked while slices are unfinished — finish or block: ${open.join(", ")} (\`th slice set-status <SLICE-ID> done|blocked\`).`,
                    why: "At final-verification the stop-gate mechanically refuses completion while any slice is neither done nor blocked, so settling the open slices outranks producing the verification report.",
                    data: { open },
                }, explain);
            }
            case "verify_suite_never_run": {
                const commands = fv.detail.commands;
                return emit({
                    kind: "run-verify",
                    action: `Final verification needs a green suite — ${commands} verify command(s) are configured but \`th verify run\` has never been recorded. Run \`th verify run\` and confirm it is green before sign-off.`,
                    why: "At final-verification the stop-gate refuses completion when verify commands are configured but the suite has never been run, so recording a green `th verify run` outranks producing the verification report or seeking the human sign-off.",
                    data: { commands },
                }, explain);
            }
            case "reqs_file_missing":
            case "coverage_failing": {
                const cov = coverageBlocker(paths);
                if (cov)
                    return emit(cov, explain);
                break;
            }
            case "report_not_registered": {
                const produced = fv.detail.file;
                return emit({ kind: "register-artifact", action: `${produced} exists but is not registered — after the human signs off, run \`th artifact register ${produced} --version <n>\`.`, why: "Slices are settled and coverage is clean, so the only thing standing between here and a governed completion is recording the verification report's hash after the human signs off.", data: { file: produced } }, explain);
            }
            case "report_not_produced": {
                const produced = fv.detail.produces;
                return emit({ kind: "produce-artifact", action: `Produce ${produced} separating coherence (Critic) from correctness (tests + human), then register it.`, why: "Slices are settled and coverage is clean, so the run now owes the verification report itself — the last artifact, which must separate Critic-certified coherence from test/human-certified correctness.", data: { produces: produced } }, explain);
            }
        }
    }
    // 7b. Implementation: dispatch build waves, await in-flight Builders, then advance.
    if (current === "implementation") {
        const prog = (0, health_1.sliceProgress)(s);
        // Empty slices: for a CODE project (default) this is an unsynced plan — emit
        // sync-slices, and `checkImplementationSettled` AGREES it is unsettled (finding #2,
        // shared `implementationRequiresSlices` predicate). For no-code/documentation-only
        // an empty set is legitimately settled, so we fall through to the stage advance.
        if (prog.total === 0 && (0, gate_preconditions_1.implementationRequiresSlices)(s)) {
            return emit({
                kind: "sync-slices",
                action: "Implementation has no slices — run `th slices sync` to populate them from the implementation plan, then `th build next-wave`.",
                why: "The stage is `implementation` but `state.slices` is empty, so there is nothing to dispatch; syncing the plan into state is the prerequisite for any build wave.",
            }, explain);
        }
        // Compute the LIVE wave so a deadlock (dependency cycle / dangling ref / a
        // dep on a blocked slice) surfaces as a stall instead of looping forever on
        // "dispatch the next wave" while nothing can actually dispatch.
        const deps = (0, wave_1.validateDeps)(s.slices);
        const occupied = (0, leases_1.occupiedComponents)(paths, s.slices);
        const plan = (0, wave_1.computeWave)(s.slices, occupied, prog.inProgress > 0);
        if (plan.stalled || (0, wave_1.hasDepIssues)(deps)) {
            const reasons = [
                ...deps.cycles.map((c) => `cycle ${c.join("→")}`),
                ...deps.dangling.map((d) => `${d.slice}→unknown ${d.missing.join(",")}`),
                ...plan.held.map((h) => `${h.id} (${h.reason}: ${h.detail.join(",")})`),
            ];
            return emit({
                kind: "stalled-build",
                action: `Build is stalled — no slice can be dispatched and none are in progress to unblock it. Fix the dependency/component deadlock, then \`th build next-wave\`. Blockers: ${reasons.join("; ")}.`,
                why: "No pending slice can dispatch (a dependency cycle, a dangling dep, or a component conflict) and nothing is in flight to unblock it — so the build cannot make progress until the deadlock in the plan is fixed.",
                data: { held: plan.held, cycles: deps.cycles, dangling: deps.dangling },
            }, explain);
        }
        if (plan.wave.length > 0) {
            return emit({
                kind: "dispatch-wave",
                action: `Dispatch the next parallel build wave: ${plan.wave.join(", ")} — run \`th build dispatch\` for the full spawn set (per-slice model/effort in one payload), then set each \`in-progress\` and \`th build claim <ID>\` before spawning its Builder.`,
                why: "A conflict-free wave of slices is ready (deps done, components free), so dispatching it is the highest-value next step — it is the build making forward progress. `th build dispatch` emits every wave Builder's spawn descriptor in one payload (it does not mutate state, so each slice still needs in-progress + a component claim before spawning).",
                data: { wave: plan.wave, pending: prog.pending, inProgress: prog.inProgress },
            }, explain);
        }
        if (prog.inProgress > 0) {
            return emit({
                kind: "await-builders",
                action: `${prog.inProgress} Builder(s) in flight — on each Critic PASS set the slice \`done\` and \`th build release <ID>\`, then re-check \`th build next-wave\`.`,
                why: "No new wave can dispatch yet (its components are held by in-flight slices), so the run owes nothing but to await the live Builders and settle each on its Critic PASS before the next wave opens.",
                data: { inProgress: prog.inProgress },
            }, explain);
        }
        // All slices settled (done/blocked) → leave the implementation stage.
    }
    // 8. Otherwise: advance to the next APPLICABLE engaged stage for this state. Uses
    //    nextStageAfterFor (finding #13) so a no-UI project (has_ui===false) advances
    //    straight past the not-applicable ux-design/ui-design stages instead of stalling.
    const next = (0, stages_1.nextStageAfterFor)(current, s);
    if (next) {
        return emit({
            kind: "advance-stage",
            action: `Stage "${current}" is settled — advance to "${next.stage}" (produces ${next.produces || "(no artifact)"}; Critic mode: ${next.criticMode}${next.humanGate ? "; human gate" : "; streams"}). Advance with the typed gate command \`th stage advance\` (CLI fallback: \`th state set current_stage ${next.stage}\`)${next.stage === "implementation" ? "; unlock the build with `th implementation unlock`" : ""}.`,
            why: `Stage "${current}" has met all its mechanical obligations and no higher-priority blocker is open, so the only thing left is to move the pipeline forward to the next engaged stage for tier ${s.tier}.`,
            data: { from: current, to: next.stage, contract: next },
        }, explain);
    }
    return emit({
        kind: "done",
        action: "No mechanical obligation outstanding — the pipeline's last engaged stage is reached. The human owns final sign-off.",
        why: "Every mechanical gate the CLI can compute is satisfied and there is no further engaged stage for this tier, so nothing mechanical remains — final authority is the human's.",
        data: { current_stage: current },
    }, explain);
}
/**
 * Coverage gate as a next-action, or undefined when coverage is clean. Renders the
 * shared `checkCoverage` predicate (single source of truth) into the `fix-coverage`
 * message — the data payload is preserved byte-for-byte from the prior inline logic.
 */
function coverageBlocker(paths) {
    const cov = (0, gate_preconditions_1.checkCoverage)(paths);
    if (cov.ok)
        return undefined;
    if (cov.error === "reqs_file_missing") {
        return {
            kind: "fix-coverage",
            action: "Coverage cannot be checked — author the requirements file first.",
            why: "Coverage is the hard gate before building, and it cannot even be computed without a requirements file — so authoring it precedes everything downstream.",
            data: { error: cov.detail.error, reqsFile: cov.detail.reqsFile },
        };
    }
    // The only remaining failure code is `coverage_failing` (gaps present).
    const gaps = cov.detail.gaps;
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
function emit(next, explain = false) {
    const data = { kind: next.kind, action: next.action, ...(next.data ?? {}) };
    if (explain && next.why)
        data.why = next.why;
    const human = explain && next.why ? `next: ${next.action}\nwhy: ${next.why}` : `next: ${next.action}`;
    return (0, output_1.success)({ data, human });
}
