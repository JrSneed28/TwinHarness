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
exports.runDelegatePlan = runDelegatePlan;
exports.runDelegatePack = runDelegatePack;
exports.runDelegateCapsule = runDelegateCapsule;
exports.runDelegateCheck = runDelegateCheck;
const fs = __importStar(require("node:fs"));
const paths_1 = require("../core/paths");
const output_1 = require("../core/output");
const log_1 = require("../core/log");
const context_1 = require("./context");
const delegation_1 = require("../core/delegation");
/**
 * `th delegate` — the Context Preservation / Delegation Layer (advisory).
 *
 * The main context window is a scarce control-plane resource. This group helps the
 * Orchestrator decide WHEN to delegate high-context work to a child agent
 * (`plan`), ASSEMBLE a bounded handoff for it (`pack`), emit the strict return
 * format (`capsule`), and VALIDATE the capsule it returns (`check`). Every verb
 * COMPUTES or CHECKS; like `th route`/`th next` it never decides — the
 * Orchestrator still owns the call. Read-only: no `state.json` mutation.
 */
/** Parse/validate the `--intent` flag against the known set. */
function parseIntent(raw) {
    if (raw === undefined)
        return {};
    if (delegation_1.DELEGATION_INTENTS.includes(raw))
        return { intent: raw };
    return { error: `unknown intent "${raw}" — expected one of: ${delegation_1.DELEGATION_INTENTS.join(", ")}` };
}
function runDelegatePlan(opts) {
    const parsed = parseIntent(opts.intent);
    if (parsed.error) {
        return (0, output_1.failure)({ human: parsed.error, data: { error: "unknown_intent", intent: opts.intent } });
    }
    const signals = {
        intent: parsed.intent,
        files: opts.files,
        writes: opts.writes,
        noisy: opts.noisy,
    };
    const rec = (0, delegation_1.computeDelegation)(signals);
    // The suggested handoff references ONLY commands that exist today.
    const handoff = [];
    if (rec.recommendation === "delegate") {
        handoff.push(opts.slice ? `th context pack --slice ${opts.slice}` : "th context pack");
        handoff.push(`th delegate pack --agent ${rec.suggestedAgent}` +
            (opts.slice ? ` --slice ${opts.slice}` : "") +
            (opts.intent ? ` --intent ${opts.intent}` : ""));
        handoff.push("write long-form detail under .twinharness/delegations/DEL-###/; return only the capsule");
    }
    (0, log_1.structuredLog)({
        cmd: "delegate plan",
        recommendation: rec.recommendation,
        intent: parsed.intent ?? null,
        files: opts.files ?? null,
        suggestedAgent: rec.suggestedAgent,
    });
    const lines = [`recommendation: ${rec.recommendation}`];
    if (opts.task)
        lines.push(`task: ${opts.task}`);
    lines.push("reasons:");
    for (const r of rec.reasons)
        lines.push(`- ${r}`);
    if (rec.suggestedAgent)
        lines.push(`suggested agent: ${rec.suggestedAgent}`);
    if (handoff.length > 0) {
        lines.push("suggested handoff:");
        for (const h of handoff)
            lines.push(`- ${h}`);
    }
    lines.push(`context pack recommended: ${rec.packRecommended ? "yes" : "no"}`);
    lines.push(`capsule required: ${rec.capsuleRequired ? "yes" : "no"}`);
    return (0, output_1.success)({
        data: {
            recommendation: rec.recommendation,
            reasons: rec.reasons,
            suggestedAgent: rec.suggestedAgent,
            suggestedHandoff: handoff,
            packRecommended: rec.packRecommended,
            capsuleRequired: rec.capsuleRequired,
            task: opts.task ?? null,
            slice: opts.slice ?? null,
        },
        human: lines.join("\n"),
    });
}
function runDelegatePack(paths, opts) {
    const parsed = parseIntent(opts.intent);
    if (parsed.error) {
        return (0, output_1.failure)({ human: parsed.error, data: { error: "unknown_intent", intent: opts.intent } });
    }
    // Reuse `th context pack` for slice framing + artifact Summary blocks when a
    // slice is given. Propagate its failure (no state / unknown slice) so the
    // caller fixes the precondition instead of getting a half-built handoff.
    let contextPack = null;
    if (opts.slice) {
        const pack = (0, context_1.runContextPack)(paths, { slice: opts.slice });
        if (!pack.ok)
            return pack;
        contextPack = pack.human ?? null;
    }
    const envelope = [
        "DELEGATED AGENT HANDOFF",
        `Agent: ${opts.agent ?? "(unspecified — set --agent)"}`,
        `Task: ${opts.task ?? "(describe the task)"}`,
        `Intent: ${parsed.intent ?? "(read|write|debug|review|artifact|repo-analysis)"}`,
        `Slice: ${opts.slice ?? "(none)"}`,
        `Allowed scope: ${opts.slice ? `the components of ${opts.slice}; do not edit outside them` : "(state the file/dir/component boundary)"}`,
        "",
        "Context pack:",
        contextPack ?? "(run `th context pack` for approved-artifact Summary blocks)",
        "",
        "Required behavior:",
        "- inspect deeply inside YOUR OWN context; do not return raw scratchwork",
        "- write durable artifacts under .twinharness/delegations/DEL-###/ when detail is long",
        "- return ONLY a Delegation Capsule (format below) to the main context",
        "",
        "Required Delegation Capsule format:",
        (0, delegation_1.capsuleTemplate)(),
    ];
    (0, log_1.structuredLog)({
        cmd: "delegate pack",
        agent: opts.agent ?? null,
        slice: opts.slice ?? null,
        intent: parsed.intent ?? null,
        hasContextPack: contextPack !== null,
    });
    return (0, output_1.success)({
        data: {
            agent: opts.agent ?? null,
            task: opts.task ?? null,
            intent: parsed.intent ?? null,
            slice: opts.slice ?? null,
            capsuleSections: [...delegation_1.CAPSULE_SECTIONS],
            hasContextPack: contextPack !== null,
        },
        human: envelope.join("\n"),
    });
}
/* ------------------------------------------------------------------ *
 * th delegate capsule — print the blank capsule skeleton.            *
 * ------------------------------------------------------------------ */
function runDelegateCapsule() {
    (0, log_1.structuredLog)({ cmd: "delegate capsule" });
    return (0, output_1.success)({
        data: { sections: [...delegation_1.CAPSULE_SECTIONS], template: (0, delegation_1.capsuleTemplate)() },
        human: (0, delegation_1.capsuleTemplate)(),
    });
}
function runDelegateCheck(paths, opts) {
    let text = opts.text;
    if (text === undefined) {
        if (!opts.file) {
            return (0, output_1.failure)({
                human: "th delegate check requires --capsule <path> (or inline text via MCP).",
                data: { error: "no_capsule" },
            });
        }
        const abs = (0, paths_1.resolveWithinRoot)(paths.root, opts.file);
        if (abs === null) {
            return (0, output_1.failure)({
                human: `Capsule path outside project root: ${opts.file}`,
                data: { error: "path_outside_root", file: opts.file },
            });
        }
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
            return (0, output_1.failure)({
                human: `Capsule file not found: ${opts.file}`,
                data: { error: "capsule_not_found", file: opts.file },
            });
        }
        text = fs.readFileSync(abs, "utf8");
    }
    const v = (0, delegation_1.validateCapsule)(text);
    (0, log_1.structuredLog)({ cmd: "delegate check", ok: v.ok, missing: v.missing.length });
    if (v.ok) {
        return (0, output_1.success)({
            data: { ok: true, present: v.present, missing: [] },
            human: `Capsule OK — all ${v.present.length} required sections present.`,
        });
    }
    return (0, output_1.failure)({
        data: { ok: false, present: v.present, missing: v.missing },
        human: `Capsule INVALID — missing ${v.missing.length} required section(s):\n${v.missing
            .map((m) => `  - ${m}`)
            .join("\n")}`,
    });
}
