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
exports.evaluateStopGate = evaluateStopGate;
exports.runHookStopGate = runHookStopGate;
exports.runHookSubagentStop = runHookSubagentStop;
exports.extractBashWriteTargets = extractBashWriteTargets;
exports.runHookPretoolGate = runHookPretoolGate;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const state_store_1 = require("../core/state-store");
const verify_1 = require("../core/verify");
/**
 * Decide whether the orchestrator may declare completion.
 *
 * - No state.json  → no TwinHarness run active in this project → allow.
 * - Invalid state  → block (the orchestrator must repair state first).
 * - Open BLOCKING drift (§10) → block.
 * - At `final-verification` stage: block when any slice is not yet done or
 *   blocked (i.e. status is "pending" or "in-progress"). This catches the
 *   most intuitive false-"done" — a run that claims completion while slices
 *   are still unbuilt. The check is ONLY applied at the final-verification
 *   stage so that legitimate mid-build pauses (the Stop hook fires on every
 *   turn-end) are never interrupted.
 * - At `final-verification`, ALSO block when verify commands are configured but
 *   the last `th verify run` is missing or red. The CLI still doesn't *certify*
 *   correctness (tests + the human do), but it refuses to let a run claim
 *   completion with a known-red or never-run suite when the operator wired one
 *   up. When no verify commands are configured this check is inert (nothing to
 *   run), and the human correctness gate still applies.
 * - Otherwise → allow.
 */
function evaluateStopGate(paths) {
    const r = (0, state_store_1.readState)(paths);
    if (!r.exists) {
        return { block: false, reasons: [] };
    }
    if (!r.state) {
        return {
            block: true,
            reasons: [
                "state.json is present but does NOT validate against the schema; repair it before claiming any stage complete.",
                ...(r.issues ?? []).map((i) => `${i.path}: ${i.message}`),
            ],
        };
    }
    if (r.state.drift_open_blocking > 0) {
        const n = r.state.drift_open_blocking;
        return {
            block: true,
            reasons: [`${n} open BLOCKING drift escalation${n === 1 ? "" : "s"} (§10) must be resolved before completing.`],
        };
    }
    if (r.state.current_stage === "final-verification") {
        const incomplete = r.state.slices.filter((s) => s.status !== "done" && s.status !== "blocked");
        if (incomplete.length > 0) {
            const ids = incomplete.map((s) => s.id).join(", ");
            const n = incomplete.length;
            return {
                block: true,
                reasons: [
                    `Stop-gate (final-verification slice check): the run is at stage final-verification but ` +
                        `${n} slice${n === 1 ? "" : "s"} ${n === 1 ? "is" : "are"} not yet done/blocked ` +
                        `(${ids}). ` +
                        `Completion requires finishing or explicitly blocking all slices before the run may stop. ` +
                        `Use \`th slice set-status <SLICE-ID> done|blocked\` for each remaining slice. ` +
                        `Note: the human correctness gate on the verification report still applies after all slices are resolved.`,
                ],
            };
        }
        // Verify-suite gate: if the operator configured project test commands, the
        // run may not claim completion with a red or never-run suite.
        const commands = (0, verify_1.readVerifyConfig)(paths).commands;
        if (commands.length > 0) {
            const report = (0, verify_1.readVerifyReport)(paths);
            if (!report) {
                return {
                    block: true,
                    reasons: [
                        `Stop-gate (final-verification suite check): ${commands.length} verify command(s) are configured but ` +
                            `\`th verify run\` has never been recorded. Run \`th verify run\` and confirm the suite is green before completing.`,
                    ],
                };
            }
            if (!report.ok) {
                const failed = report.results.filter((x) => !x.ok).map((x) => x.command).join(", ");
                return {
                    block: true,
                    reasons: [
                        `Stop-gate (final-verification suite check): the last \`th verify run\` is RED — failing command(s): ${failed}. ` +
                            `Engage the Debugger (\`th debug pack\`), fix, and re-run \`th verify run\` until green before completing.`,
                    ],
                };
            }
        }
    }
    return { block: false, reasons: [] };
}
/**
 * `th hook stop-gate` — emit a Claude Code Stop-hook decision on stdout.
 * Blocks with a reason, or allows with `{}`. Always exits 0 (the JSON carries
 * the decision).
 *
 * Loop protection: the gate blocks at most once per stop sequence. If the gate
 * would block again while `stop_hook_active` is true, it allows the stop but
 * surfaces the unresolved reasons as a `systemMessage` — blocking drift needs a
 * human decision, and re-blocking forever would spin the model instead of
 * yielding the turn to that human.
 */
function runHookStopGate(paths, input) {
    const decision = evaluateStopGate(paths);
    if (decision.block) {
        const reason = "TwinHarness stop-gate blocked completion: " + decision.reasons.join(" ");
        if (input?.stop_hook_active === true) {
            return {
                stdout: JSON.stringify({
                    systemMessage: "TwinHarness stop-gate is STILL blocked, but allowed the stop to avoid an infinite loop. " +
                        "A human decision is required. " + reason,
                }),
                exitCode: 0,
            };
        }
        return {
            stdout: JSON.stringify({ decision: "block", reason }),
            exitCode: 0,
        };
    }
    return { stdout: JSON.stringify({}), exitCode: 0 };
}
/**
 * `th hook subagent-stop` — emit a Claude Code SubagentStop-hook decision on
 * stdout when a delegated subagent (Spec, Critic, Builder, …) finishes a turn.
 *
 * Scope: this is a narrow STATE-VALIDITY guard, not the full completion gate.
 * A subagent stopping is not the run claiming "done" (that is the top-level Stop
 * hook's job via `evaluateStopGate`/the final-verification checks). What this
 * hook catches is the one mechanically-decidable failure that matters at every
 * subagent boundary: a `state.json` that exists but no longer validates against
 * the schema. If a subagent corrupted state, every downstream delegation would
 * silently operate on garbage — so we block here and force a repair.
 *
 * Decision ladder (fail-open by design):
 * - No state.json → ALLOW ({}). Non-TwinHarness projects (and Tier-0 bypass runs
 *   that never scaffold state) must be completely unaffected.
 * - state.json present-but-invalid → BLOCK with a repair instruction, UNLESS
 *   `stop_hook_active` is already true (then downgrade to a `systemMessage` so a
 *   wedged subagent is not spun forever — a human must repair state).
 * - Otherwise (valid state) → ALLOW.
 *
 * Always exits 0 (the JSON on stdout carries the decision). Reuses `readState`
 * so the present-but-invalid detection is identical to the Stop-gate's.
 */
function runHookSubagentStop(paths, input) {
    const r = (0, state_store_1.readState)(paths);
    // No state.json → not a TwinHarness run (or a Tier-0 bypass) → allow.
    if (!r.exists) {
        return { stdout: JSON.stringify({}), exitCode: 0 };
    }
    // Present-but-invalid state → block (or downgrade if already looping).
    if (!r.state) {
        const reasons = [
            "state.json is present but does NOT validate against the schema; repair it before this subagent's work is accepted.",
            ...(r.issues ?? []).map((i) => `${i.path}: ${i.message}`),
        ];
        const reason = "TwinHarness subagent-stop gate blocked: " + reasons.join(" ");
        if (input?.stop_hook_active === true) {
            return {
                stdout: JSON.stringify({
                    systemMessage: "TwinHarness subagent-stop gate is STILL blocked, but allowed the stop to avoid an infinite loop. " +
                        "A human must repair state.json. " +
                        reason,
                }),
                exitCode: 0,
            };
        }
        return {
            stdout: JSON.stringify({ decision: "block", reason }),
            exitCode: 0,
        };
    }
    // Valid state → allow.
    return { stdout: JSON.stringify({}), exitCode: 0 };
}
/**
 * Extract candidate write-target path tokens from a Bash command string using
 * conservative heuristics. Covers redirections (> / >>), tee, dd of=, and
 * sed -i. Returns deduplicated non-empty non-flag tokens. Never throws.
 *
 * Patterns:
 *   - `>` or `>>` followed by optional spaces then a path token.
 *   - `tee` (optionally `-a`) followed by a path token.
 *   - `dd ... of=PATH`.
 *   - `sed -i` in-place: last bareword token of the command.
 */
function extractBashWriteTargets(command) {
    const seen = new Set();
    const add = (token) => {
        if (token && !token.startsWith("-"))
            seen.add(token);
    };
    // Redirections: > or >> followed by optional whitespace then a path token.
    const redirectRe = /(?:>>?)\s*("?)([^\s"'|;&<>]+)\1/g;
    let m;
    while ((m = redirectRe.exec(command)) !== null) {
        if (m[2])
            add(m[2]);
    }
    // tee (optionally -a): `tee [-a] PATH`
    const teeRe = /\btee\b\s+(?:-a\s+)?("?)([^\s"'|;&<>]+)\1/g;
    while ((m = teeRe.exec(command)) !== null) {
        if (m[2])
            add(m[2]);
    }
    // dd of=PATH
    const ddRe = /\bof=("?)([^\s"'|;&<>]+)\1/g;
    while ((m = ddRe.exec(command)) !== null) {
        if (m[2])
            add(m[2]);
    }
    // sed -i in-place: capture last bareword token of the command as the file.
    if (/\bsed\b/.test(command) && /\s-i\b/.test(command)) {
        const lastToken = /([^\s"'|;&<>]+)\s*$/.exec(command);
        if (lastToken && lastToken[1])
            add(lastToken[1]);
    }
    return Array.from(seen);
}
/**
 * Helper: convert an absolute path to a root-relative forward-slash string,
 * or null if the path is outside the project root (caller should allow it).
 */
function toRootRelative(absTarget, root) {
    const rel = path.relative(root, absTarget);
    // path.relative returns a string starting with ".." when outside root.
    if (rel.startsWith("..") || path.isAbsolute(rel))
        return null;
    return rel.split(path.sep).join("/");
}
/**
 * Doc/state allowlist: paths that are always allowed regardless of phase.
 * Matches the spec list: docs/, .twinharness/, .agentic-sdlc/, .claude/,
 * drift-log.md, .gitignore, and any *.md directly at the project root.
 */
function isAllowedDocOrStatePath(relFwd) {
    if (relFwd === "drift-log.md" ||
        relFwd === ".gitignore" ||
        relFwd.startsWith("docs/") ||
        relFwd.startsWith(".twinharness/") ||
        relFwd.startsWith(".agentic-sdlc/") ||
        relFwd.startsWith(".claude/")) {
        return true;
    }
    // Root-level *.md (no directory separator).
    if (!relFwd.includes("/") && relFwd.endsWith(".md")) {
        return true;
    }
    return false;
}
/**
 * Phase B ownership: a component token is path-like if it contains "/" OR it
 * exists on disk relative to the project root. Abstract tokens are ignored.
 */
function isPathLikeComponent(token, root) {
    if (token.includes("/"))
        return true;
    return fs.existsSync(path.join(root, token));
}
/**
 * Phase B: determine which slices (by id) own a root-relative path.
 * Returns an array of { id, status } for slices that claim the path through
 * at least one path-like component token.
 */
function findOwningSlices(relFwd, slices, root) {
    const owners = [];
    for (const sl of slices) {
        for (const token of sl.components) {
            if (!isPathLikeComponent(token, root))
                continue;
            // Normalise the token: strip trailing slash, convert to forward slashes.
            const normToken = token.replace(/\/$/, "").split(path.sep).join("/");
            if (relFwd === normToken || relFwd.startsWith(normToken + "/")) {
                owners.push({ id: sl.id, status: sl.status });
                break; // One match per slice is enough.
            }
        }
    }
    return owners;
}
/**
 * `th hook pretool-gate` — emit a Claude Code PreToolUse hook decision on stdout.
 *
 * Implements the decision ladder from spec/write-gate-design.md §Decision ladder:
 * a. No state.json → allow ({}).
 * b. TH_DISABLE_WRITE_GATE=1 or write_gate=off → allow.
 * c. state.json invalid → allow + systemMessage warning.
 * c2. Phase A + Bash tool: heuristically detect shell-mediated writes into in-root
 *     implementation paths and fire the gate on the first offending target (fail-open:
 *     if no offending target is found, fall through). NOT applied in Phase B.
 * c3. Phase B + write_gate="strict" + Bash command: apply the same conservative Bash
 *     matcher used in Phase A to mid-build Bash writes, firing `deny` on a target owned
 *     solely by non-in-progress slices (fail-open otherwise). Runs before step d
 *     because a Bash tool call has no file_path (step d would otherwise short-circuit).
 *     Only active in strict mode; default modes leave Phase-B Bash writes ungated
 *     (original behaviour).
 * d. No tool_input.file_path (or notebook_path for NotebookEdit) → allow.
 * e. Target outside project root → allow.
 * f. Doc/state allowlist path → allow.
 * g. Phase A (implementation_allowed=false) → ask|deny per write_gate (default ask).
 * h. Phase B (implementation_allowed=true, slices non-empty):
 *    - owned only by non-in-progress slices → ask (component-boundary violation).
 *    - owned by any in-progress slice, or unowned → allow.
 *
 * Always exits 0 (the JSON carries the decision). Env is injectable for testing.
 */
function runHookPretoolGate(paths, input, env = process.env) {
    const allow = () => ({ stdout: JSON.stringify({}), exitCode: 0 });
    const allowWithWarning = (msg) => ({ stdout: JSON.stringify({ systemMessage: msg }), exitCode: 0 });
    const fireGate = (decision, reason) => ({
        stdout: JSON.stringify({
            hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: decision,
                permissionDecisionReason: reason,
            },
        }),
        exitCode: 0,
    });
    // Step b (env check): TH_DISABLE_WRITE_GATE=1 → allow immediately, before reading state.
    if (env["TH_DISABLE_WRITE_GATE"] === "1")
        return allow();
    // Step a: No state.json → allow.
    const r = (0, state_store_1.readState)(paths);
    if (!r.exists)
        return allow();
    // Step c: Invalid state → allow + warning.
    if (!r.state) {
        return allowWithWarning("TwinHarness write-gate is standing down because state.json is invalid (the stop-gate still blocks completion). " +
            "Repair state.json and re-run to restore gating.");
    }
    const state = r.state;
    // Step b (state check): write_gate=off → allow.
    if (state.write_gate === "off")
        return allow();
    // Effective gate mode: use write_gate field, defaulting to "ask" when absent.
    // "strict" carries "deny" semantics (and additionally gates Phase-B Bash writes
    // below — G4), so it maps to "deny" here.
    const gateMode = state.write_gate === "deny" || state.write_gate === "strict" ? "deny" : "ask";
    // Step c2: Phase A Bash-mediated write defense-in-depth (fail-open).
    // Only fires during Phase A (implementation_allowed=false). Heuristically detect
    // shell-mediated writes into in-root implementation paths. If no offending target
    // is found, fall through (allow). Never fires in Phase B to avoid false-positives.
    const bashCommand = input?.tool_input?.command;
    if (bashCommand && !state.implementation_allowed) {
        const base0 = input?.cwd ?? paths.root;
        const targets = extractBashWriteTargets(bashCommand);
        for (const token of targets) {
            const absT = path.isAbsolute(token) ? token : path.resolve(base0, token);
            const rel0 = toRootRelative(absT, paths.root);
            if (rel0 !== null && !isAllowedDocOrStatePath(rel0)) {
                const reason = `TwinHarness write-gate (Bash defense-in-depth) blocked this Bash-mediated write ` +
                    `(Phase A — pre-implementation). ` +
                    `Target path: ${rel0}. ` +
                    `Current stage: ${state.current_stage}. ` +
                    `Bash-mediated writes (e.g. echo/sed/tee redirections) are not permitted during Phase A ` +
                    `because implementation_allowed is false. ` +
                    `Legitimate unlock: clear all upstream gates, then set ` +
                    `implementation_allowed true via \`th state set implementation_allowed true\`. ` +
                    `Escape hatch (emergency manual override): set env TH_DISABLE_WRITE_GATE=1. ` +
                    `AGENT INSTRUCTION: do NOT retry this write — escalate to the human for a decision.`;
                return fireGate(gateMode, reason);
            }
        }
        // No offending target found → fall through (fail-open).
    }
    // Step c3: Phase B Bash-mediated write enforcement — strict mode only (G4).
    // Runs BEFORE step d because a Bash tool call carries `command` but no
    // `file_path`/`notebook_path`, so step d's early allow() would otherwise make
    // this branch unreachable for Bash writes. Default modes (ask/deny/off) leave
    // Phase-B Bash writes ungated (the original behaviour: Bash gating was Phase A
    // only). Under `write_gate: "strict"`, with implementation allowed and a Bash
    // command present, the same conservative matcher used in Phase A is applied to
    // mid-build Bash writes so that a Bash redirection cannot sidestep the §16
    // component-boundary rule. Fail-open: only a target owned solely by slices that
    // are NOT in-progress fires the gate; anything unparseable, out-of-root,
    // doc-allowlisted, unowned, or owned by an in-progress slice falls through.
    if (state.write_gate === "strict" &&
        state.implementation_allowed &&
        bashCommand &&
        state.slices.length > 0) {
        const baseB = input?.cwd ?? paths.root;
        const targetsB = extractBashWriteTargets(bashCommand);
        for (const token of targetsB) {
            const absT = path.isAbsolute(token) ? token : path.resolve(baseB, token);
            const relB = toRootRelative(absT, paths.root);
            if (relB === null || isAllowedDocOrStatePath(relB))
                continue; // out-of-root / doc → allow.
            const owners = findOwningSlices(relB, state.slices, paths.root);
            if (owners.length === 0)
                continue; // unowned in-root path → allow.
            if (owners.some((o) => o.status === "in-progress"))
                continue; // an in-progress owner → allow.
            // Owned only by slices that are not in-progress → component-boundary violation.
            const ownerSummary = owners.map((o) => `${o.id} (${o.status})`).join(", ");
            const reason = `TwinHarness write-gate (strict mode — Phase-B Bash enforcement) blocked this Bash-mediated write. ` +
                `Target path: ${relB}. ` +
                `This path is owned by slice(s): ${ownerSummary}, none of which are currently in-progress. ` +
                `Under write_gate=strict, Bash-mediated writes (e.g. echo/sed/tee redirections) are held to the same ` +
                `§16 component-boundary rule as Write/Edit: another slice owns this path. ` +
                `AGENT INSTRUCTION: do NOT retry this write — escalate to the human for a decision. ` +
                `To allow this write, set the owning slice to in-progress: ` +
                `\`th slice set-status <SLICE-ID> in-progress\`. ` +
                `Escape hatch (emergency manual override): set env TH_DISABLE_WRITE_GATE=1.`;
            return fireGate("deny", reason);
        }
        // No offending target found → fall through (fail-open).
    }
    // Step d: No file_path (or notebook_path for NotebookEdit) → allow.
    const filePath = input?.tool_input?.file_path ?? input?.tool_input?.notebook_path;
    if (!filePath)
        return allow();
    // Step e: Resolve target. Relative paths are resolved against input.cwd ?? paths.root.
    const base = input?.cwd ?? paths.root;
    const absTarget = path.isAbsolute(filePath) ? filePath : path.resolve(base, filePath);
    const relFwd = toRootRelative(absTarget, paths.root);
    if (relFwd === null)
        return allow(); // Outside project root → not our concern.
    // Step f: Doc/state allowlist → allow.
    if (isAllowedDocOrStatePath(relFwd))
        return allow();
    // Step g: Phase A — implementation not yet allowed (file_path/notebook_path path).
    if (!state.implementation_allowed) {
        const reason = `TwinHarness write-gate blocked this write (Phase A — pre-implementation). ` +
            `Current stage: ${state.current_stage}. ` +
            `Target path: ${relFwd}. ` +
            `Implementation writes are not yet permitted: implementation_allowed is false. ` +
            `Legitimate unlock: complete all upstream gates so the orchestrator can set ` +
            `implementation_allowed true via \`th state set implementation_allowed true\`. ` +
            `Escape hatch (emergency manual override): set env TH_DISABLE_WRITE_GATE=1. ` +
            `AGENT INSTRUCTION: do NOT retry this write — escalate to the human for a decision.`;
        return fireGate(gateMode, reason);
    }
    // Step h: Phase B — implementation allowed, slices exist.
    if (state.slices.length > 0) {
        const owners = findOwningSlices(relFwd, state.slices, paths.root);
        if (owners.length > 0) {
            const allInProgress = owners.every((o) => o.status === "in-progress");
            const anyInProgress = owners.some((o) => o.status === "in-progress");
            if (anyInProgress || allInProgress) {
                // At least one in-progress owner → allow.
                return allow();
            }
            // Owned only by slices that are not in-progress → component-boundary violation.
            const ownerSummary = owners.map((o) => `${o.id} (${o.status})`).join(", ");
            const reason = `TwinHarness write-gate blocked this write (Phase B — component-boundary enforcement). ` +
                `Target path: ${relFwd}. ` +
                `This path is owned by slice(s): ${ownerSummary}, none of which are currently in-progress. ` +
                `This looks like a component-boundary violation (§16): another slice owns this path. ` +
                `AGENT INSTRUCTION: do NOT retry this write — escalate to the human for a decision. ` +
                `To allow this write, set the owning slice to in-progress: ` +
                `\`th slice set-status <SLICE-ID> in-progress\`.`;
            return fireGate("ask", reason);
        }
        // Unowned path → allow (new files appear constantly during a build).
    }
    return allow();
}
