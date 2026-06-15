"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.runNext = runNext;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const output_1 = require("../core/output");
const state_store_1 = require("../core/state-store");
const stages_1 = require("../core/stages");
const health_1 = require("../core/health");
const coverage_1 = require("../core/coverage");
const verify_1 = require("../core/verify");
const leases_1 = require("../core/leases");
const wave_1 = require("../core/wave");
const decisions_1 = require("../core/decisions");
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
    // 1. Blocking drift outranks stage progress — the stop-gate will refuse completion.
    if (s.drift_open_blocking > 0) {
        return emit({
            kind: "resolve-blocking-drift",
            action: `${s.drift_open_blocking} blocking drift entr${s.drift_open_blocking === 1 ? "y is" : "ies are"} open — resolve or escalate before completion (\`th drift list\` / \`th drift resolve <DRIFT-NNN>\`).`,
            why: "Open requirement-layer drift is a human-only escalation that the stop-gate already blocks completion on, so it outranks every stage advance — no later work can be certified while it stands.",
            data: { drift_open_blocking: s.drift_open_blocking },
        }, explain);
    }
    // 2. A revise loop at its cap owes a human decision (§18 — stop looping).
    const escalations = (0, health_1.reviseEscalations)(s);
    if (escalations.length > 0) {
        return emit({
            kind: "escalate-revise",
            action: `Revise loop at cap — escalate to the human: ${escalations.map((e) => `${e.mode} (${e.count}/${e.cap})`).join(", ")}.`,
            why: "A Critic loop at its cap (§18) means the producer↔Critic cycle is stuck with open grounded issues; continuing to loop is forbidden, so escalating to the human takes priority over starting any new stage work.",
            data: { escalations },
        }, explain);
    }
    // 2b. A failing test suite is a defect owed to the Debugger before advancing.
    const verifyReport = (0, verify_1.readVerifyReport)(paths);
    if (verifyReport && !verifyReport.ok) {
        const failed = verifyReport.results.filter((x) => !x.ok).length;
        return emit({
            kind: "investigate-failure",
            action: `Test suite failing (${failed} command(s)) — assemble evidence with \`th debug pack\` and engage the Debugger before advancing.`,
            why: "The last `th verify run` is red, which is a correctness defect; advancing the pipeline on a known-failing suite would build on broken ground, so tracing the failure (Debugger) comes first.",
            data: { failed },
        }, explain);
    }
    // 3. Silent artifact drift: a governed doc changed on disk without re-registration.
    const drifted = (0, health_1.artifactIntegrity)(paths, s).filter((i) => i.status === "changed");
    if (drifted.length > 0) {
        return emit({
            kind: "re-register-artifact",
            action: `Approved artifact changed on disk — run \`th stale --artifact ${drifted[0].file}\` then re-register: ${drifted.map((i) => i.file).join(", ")}.`,
            why: "A registered artifact whose on-disk hash no longer matches has silently drifted from what the run governs; re-registering (and cascading the staleness check) must happen before later stages, which would otherwise build on an out-of-date upstream.",
            data: { changed: drifted.map((i) => i.file) },
        }, explain);
    }
    // 4. Tier not yet classified — that gates every engaged stage.
    if (s.tier === null) {
        return emit({
            kind: "classify-tier",
            action: "Tier is unclassified — classify it (`th tier classify <brief.json>` + `th tier veto-check`) and record `th state set tier T<n>`.",
            why: "The tier determines which stages are even engaged, so nothing downstream can be sequenced until it is set — classification gates every design stage.",
            data: { current_stage: s.current_stage },
        }, explain);
    }
    // 4b. Decision-governance obligation: an unapproved gating decision blocks the stage
    //     (REQ-501..504). Slots after classify-tier (run-integrity already cleared above)
    //     and before produce-artifact (stage work). Uses the single gatingObligations
    //     predicate (RULE-007 / ARCH-RISK-005 — no second implementation). Tolerant
    //     reader: a corrupt decisions.jsonl skips bad lines and falls through cleanly.
    {
        const obligations = (0, decisions_1.gatingObligations)((0, decisions_1.reduceDecisions)((0, decisions_1.readDecisionEvents)(paths)), s);
        if (obligations.length > 0) {
            const first = obligations[0];
            const title = (0, decisions_1.reduceDecisions)((0, decisions_1.readDecisionEvents)(paths)).find((d) => d.id === first.decisionId)?.title ?? "";
            const titlePart = title ? ` (title: "${title}")` : "";
            return emit({
                kind: "resolve-decision-obligation",
                action: `Approve ${first.decisionId}${titlePart} — it blocks stage '${first.blockedStage}' from proceeding.`,
                why: `Decision ${first.decisionId} is linked to stage '${first.blockedStage}' and is not yet approved; no stage work can proceed while a gating decision is unmet (RULE-007).`,
                data: { decisionId: first.decisionId, blockedStage: first.blockedStage },
            }, explain);
        }
    }
    // 5. Stage-specific obligations for the current stage.
    const current = s.current_stage;
    const contract = (0, stages_1.stageContract)(current);
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
                    why: `The current stage "${current}" owes its artifact (${contract.produces}) and it is not yet on disk; the stage cannot be considered settled — and the run cannot advance — until that artifact exists, passes the Critic, and is registered.`,
                    data: { stage: current, produces: contract.produces },
                }, explain);
            }
            return emit({
                kind: "register-artifact",
                action: `${produced} exists but is not registered — after the Critic passes${contract.humanGate ? " and the human gate clears" : ""}, run \`th artifact register ${contract.produces} --version <n>\`.`,
                why: `${produced} exists but is unregistered, so the run is not yet governing it (no recorded hash); registering it after the Critic${contract.humanGate ? " and human gate" : ""} is what lets the stage settle and the pipeline move on.`,
                data: { stage: current, file: produced },
            }, explain);
        }
    }
    // 6. Implementation-planning: coverage is the hard gate before building.
    if (current === "implementation-planning") {
        const cov = coverageBlocker(paths);
        if (cov)
            return emit(cov);
    }
    // 7. Final-verification: all slices settled + coverage clean + human signs off.
    if (current === "final-verification") {
        const prog = (0, health_1.sliceProgress)(s);
        if (!prog.allSettled && prog.total > 0) {
            const open = s.slices.filter((sl) => sl.status !== "done" && sl.status !== "blocked").map((sl) => sl.id);
            return emit({
                kind: "finish-slices",
                action: `Final verification is blocked while slices are unfinished — finish or block: ${open.join(", ")} (\`th slice set-status <SLICE-ID> done|blocked\`).`,
                why: "At final-verification the stop-gate mechanically refuses completion while any slice is neither done nor blocked, so settling the open slices outranks producing the verification report.",
                data: { open },
            }, explain);
        }
        // Verify-suite gate — mirror the Stop-gate (core hook.ts evaluateStopGate):
        // at final-verification, a configured-but-never-run suite blocks completion.
        // (A RED suite is already surfaced globally as investigate-failure in step 2b,
        // so only the never-run case needs handling here.)
        const verifyCfg = (0, verify_1.readVerifyConfig)(paths);
        if (verifyCfg.commands.length > 0 && !(0, verify_1.readVerifyReport)(paths)) {
            return emit({
                kind: "run-verify",
                action: `Final verification needs a green suite — ${verifyCfg.commands.length} verify command(s) are configured but \`th verify run\` has never been recorded. Run \`th verify run\` and confirm it is green before sign-off.`,
                why: "At final-verification the stop-gate refuses completion when verify commands are configured but the suite has never been run, so recording a green `th verify run` outranks producing the verification report or seeking the human sign-off.",
                data: { commands: verifyCfg.commands.length },
            }, explain);
        }
        const cov = coverageBlocker(paths);
        if (cov)
            return emit(cov, explain);
        // Slices settled + coverage clean → the report itself is the next artifact.
        if (contract && contract.produces) {
            const produced = contract.produces.replace(/\/$/, "");
            const registered = s.approved_artifacts.some((a) => a.file === produced);
            if (!registered) {
                const exists = fs.existsSync(path.resolve(paths.root, produced));
                return emit(exists
                    ? { kind: "register-artifact", action: `${produced} exists but is not registered — after the human signs off, run \`th artifact register ${produced} --version <n>\`.`, why: "Slices are settled and coverage is clean, so the only thing standing between here and a governed completion is recording the verification report's hash after the human signs off.", data: { file: produced } }
                    : { kind: "produce-artifact", action: `Produce ${produced} separating coherence (Critic) from correctness (tests + human), then register it.`, why: "Slices are settled and coverage is clean, so the run now owes the verification report itself — the last artifact, which must separate Critic-certified coherence from test/human-certified correctness.", data: { produces: produced } }, explain);
            }
        }
        return emit({
            kind: "human-signoff",
            action: "Coherence is gated and coverage is clean — present `th trace render` + the verification report for the human correctness sign-off (§11).",
            why: "Every mechanical gate is satisfied (slices settled, coverage clean, report registered); what remains is the one thing the CLI cannot certify — correctness — which only the human can sign off.",
        }, explain);
    }
    // 7b. Implementation: dispatch build waves, await in-flight Builders, then advance.
    if (current === "implementation") {
        const prog = (0, health_1.sliceProgress)(s);
        if (prog.total === 0) {
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
                action: `Dispatch the next parallel build wave: ${plan.wave.join(", ")} — set each \`in-progress\` and \`th build claim <ID>\` before spawning its Builder (\`th build next-wave\`).`,
                why: "A conflict-free wave of slices is ready (deps done, components free), so dispatching it is the highest-value next step — it is the build making forward progress.",
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
    // 8. Otherwise: advance to the next engaged stage for this tier.
    const next = (0, stages_1.nextStageAfter)(current, s.tier);
    if (next) {
        return emit({
            kind: "advance-stage",
            action: `Stage "${current}" is settled — advance to "${next.stage}" (produces ${next.produces || "(no artifact)"}; Critic mode: ${next.criticMode}${next.humanGate ? "; human gate" : "; streams"}). Set it with \`th state set current_stage ${next.stage}\`.`,
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
/** Coverage gate as a next-action, or undefined when coverage is clean. */
function coverageBlocker(paths) {
    const breakdown = (0, coverage_1.computeBreakdown)(paths.root);
    if ("error" in breakdown) {
        return {
            kind: "fix-coverage",
            action: "Coverage cannot be checked — author the requirements file first.",
            why: "Coverage is the hard gate before building, and it cannot even be computed without a requirements file — so authoring it precedes everything downstream.",
            data: { error: breakdown.error, reqsFile: breakdown.reqsFile },
        };
    }
    const gaps = breakdown.rows.filter((row) => !row.planned || !row.tested);
    if (gaps.length > 0) {
        return {
            kind: "fix-coverage",
            action: `Coverage gate failing — ${gaps.length} REQ-ID(s) lack a slice and/or a test: ${gaps.map((g) => g.req).join(", ")}. Run \`th coverage check\`.`,
            why: "The coverage gate mechanically blocks the build until every MVP REQ-ID maps to ≥1 slice and ≥1 test; the listed gaps must be closed before implementation may proceed.",
            data: { gaps: gaps.map((g) => ({ req: g.req, inSlice: g.planned, inTest: g.tested })) },
        };
    }
    return undefined;
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
