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
function runNext(paths) {
    const r = (0, state_store_1.readState)(paths);
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
    const escalations = (0, health_1.reviseEscalations)(s);
    if (escalations.length > 0) {
        return emit({
            kind: "escalate-revise",
            action: `Revise loop at cap — escalate to the human: ${escalations.map((e) => `${e.mode} (${e.count}/${e.cap})`).join(", ")}.`,
            data: { escalations },
        });
    }
    // 3. Silent artifact drift: a governed doc changed on disk without re-registration.
    const drifted = (0, health_1.artifactIntegrity)(paths, s).filter((i) => i.status === "changed");
    if (drifted.length > 0) {
        return emit({
            kind: "re-register-artifact",
            action: `Approved artifact changed on disk — run \`th stale --artifact ${drifted[0].file}\` then re-register: ${drifted.map((i) => i.file).join(", ")}.`,
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
                data: { open },
            });
        }
        const cov = coverageBlocker(paths);
        if (cov)
            return emit(cov);
        // Slices settled + coverage clean → the report itself is the next artifact.
        if (contract && contract.produces) {
            const produced = contract.produces.replace(/\/$/, "");
            const registered = s.approved_artifacts.some((a) => a.file === produced);
            if (!registered) {
                const exists = fs.existsSync(path.resolve(paths.root, produced));
                return emit(exists
                    ? { kind: "register-artifact", action: `${produced} exists but is not registered — after the human signs off, run \`th artifact register ${produced} --version <n>\`.`, data: { file: produced } }
                    : { kind: "produce-artifact", action: `Produce ${produced} separating coherence (Critic) from correctness (tests + human), then register it.`, data: { produces: produced } });
            }
        }
        return emit({
            kind: "human-signoff",
            action: "Coherence is gated and coverage is clean — present `th trace render` + the verification report for the human correctness sign-off (§11).",
        });
    }
    // 8. Otherwise: advance to the next engaged stage for this tier.
    const next = (0, stages_1.nextStageAfter)(current, s.tier);
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
function coverageBlocker(paths) {
    const breakdown = (0, coverage_1.computeBreakdown)(paths.root);
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
function emit(next) {
    return (0, output_1.success)({ data: { kind: next.kind, action: next.action, ...(next.data ?? {}) }, human: `next: ${next.action}` });
}
