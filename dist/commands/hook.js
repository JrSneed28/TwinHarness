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
exports.bashWriteTargetWasDropped = bashWriteTargetWasDropped;
exports.classifyOwnership = classifyOwnership;
exports.runHookPretoolGate = runHookPretoolGate;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const paths_1 = require("../core/paths");
const state_store_1 = require("../core/state-store");
const verify_1 = require("../core/verify");
const decisions_1 = require("../core/decisions");
const stages_1 = require("../core/stages");
const artifact_guard_1 = require("../core/artifact-guard");
const delegation_scope_1 = require("../core/delegation-scope");
/**
 * Decide whether the orchestrator may declare completion.
 *
 * - No state.json  → no TwinHarness run active in this project → allow.
 * - Invalid state  → block (the orchestrator must repair state first).
 * - Open BLOCKING drift (§10) → block.
 * - Open BLOCKING debate → block.
 * - Unapproved decision gating the current stage (RULE-007) → block (mirrors
 *   `th next`, which already refuses to advance past such a decision).
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
    // Anchor: REQ-PCO-042 — an open debate is a blocking reconciliation obligation,
    // exactly like a requirement-layer drift. Absent counter ⇒ 0.
    if ((r.state.debate_open_blocking ?? 0) > 0) {
        const n = r.state.debate_open_blocking ?? 0;
        return {
            block: true,
            reasons: [`${n} open BLOCKING debate${n === 1 ? "" : "s"} must be reconciled (\`th debate resolve\`) before completing.`],
        };
    }
    // RULE-007 — an unapproved decision linked to the current stage gates progress.
    // `th next` already refuses to advance past it; completion must be blocked too
    // (mirroring drift/debate). Reuses the SINGLE gating predicate so the stop-gate
    // and `th next` cannot disagree. Tolerant: missing ledger / no current_stage ⇒
    // no obligations ⇒ no block (Tier-0 and non-decision runs are unaffected).
    const obligations = (0, decisions_1.gatingObligations)((0, decisions_1.reduceDecisions)((0, decisions_1.readDecisionEvents)(paths)), r.state);
    if (obligations.length > 0) {
        const ids = obligations.map((o) => o.decisionId).join(", ");
        const n = obligations.length;
        return {
            block: true,
            reasons: [
                `${n} unapproved decision${n === 1 ? "" : "s"} gate the current stage ` +
                    `(${ids}); approve or reject via \`th decision approve\` (see \`th decision check\`) before completing.`,
            ],
        };
    }
    if ((0, stages_1.isFinalVerification)(r.state.current_stage)) {
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
        //
        // R-23: read through loadVerifyConfig (NOT readVerifyConfig) so a present-but-
        // CORRUPT verify.json fails CLOSED here too. readVerifyConfig collapses a corrupt
        // config to `{ commands: [] }`, which made this whole suite block skip (length 0)
        // and let a run STOP/complete on an unreadable config — the same fail-OPEN that
        // `runVerifyRun`/`runVerifyApprove` already refuse. A corrupt config is now a hard
        // block: the operator wired a suite, so an unreadable suite config is a stop
        // condition, not a silent "no commands".
        const loadedVerify = (0, verify_1.loadVerifyConfig)(paths);
        if (loadedVerify.status === "corrupt") {
            return {
                block: true,
                reasons: [
                    `Stop-gate (final-verification suite check): verify.json is present but unreadable/corrupt — ` +
                        `refusing to complete (fail-closed). It is NOT treated as an empty/approved set. ` +
                        `Inspect it, or run \`th verify clear\` and re-configure, then \`th verify approve\` and \`th verify run\` before completing.`,
                ],
            };
        }
        const commands = loadedVerify.config.commands;
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
    // SG3 P1-B (C-11) — a delegated subagent finishing means its allowed-files scope no
    // longer applies. DISARM the durable scope here so it cannot leak onto the
    // orchestrator's (or the next delegate's) writes. Best-effort + unconditional: it must
    // lift even when state.json is absent/invalid, and a missing scope file is a no-op.
    (0, delegation_scope_1.clearDelegationScope)(paths);
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
 * conservative heuristics. Covers redirections (> / >>), tee, dd of=, sed -i, and
 * the copy/move family (cp/mv/install/touch/rsync). Returns deduplicated non-empty
 * non-flag tokens. Never throws.
 *
 * Tokens containing a shell metacharacter (`$`, backtick, `*`, `?`, `(`, `)`,
 * `{`, `}`) are skipped: they are not literal paths (e.g. `$f`, a glob), so
 * flagging them produces false positives the gate can't reason about. This keeps
 * the matcher conservative — the honest "Bash writes are out of scope as a hard
 * guarantee" caveat in SECURITY.md still stands (python -c / node -e / awk and
 * metachar-obscured targets are intentionally not caught).
 *
 * Patterns:
 *   - `>` or `>>` followed by optional spaces then a path token.
 *   - `tee` (optionally `-a`) followed by a path token.
 *   - `dd ... of=PATH`.
 *   - `sed -i` in-place: last bareword token of the command.
 *   - cp/mv/install/rsync: the last non-flag bareword of the segment is the
 *     destination (per shell segment, split on `;`/`&`/`|`).
 *   - touch: EVERY non-flag bareword is a target (touch creates/updates all its
 *     operands, not just the last), so all of them are added.
 */
function extractBashWriteTargets(command) {
    const seen = new Set();
    const SHELL_METACHARS = /[$`*?(){}]/;
    const add = (token) => {
        const t = token.replace(/^["']|["']$/g, "");
        if (t && !t.startsWith("-") && !SHELL_METACHARS.test(t))
            seen.add(t);
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
    // Copy/move family, per shell segment (split on `;`/`&`/`|` so a chained
    // command like `build && cp x dst.ts` is handled segment-by-segment):
    //   - cp/mv/install/rsync: only the LAST non-flag argument is the write
    //     destination (the earlier operands are read sources).
    //   - touch: EVERY non-flag argument is a write target (it creates/updates all
    //     operands), so adding only the last would miss `touch a b` → leaves `a`
    //     unchecked and lets the gate pass a protected write.
    const DEST_LAST_CMDS = new Set(["cp", "mv", "install", "rsync"]);
    for (const segment of command.split(/[;&|]+/)) {
        const tokens = segment.trim().split(/\s+/).filter(Boolean);
        const head = tokens[0];
        if (!head)
            continue;
        if (head === "touch") {
            for (let i = 1; i < tokens.length; i++) {
                const tok = tokens[i];
                if (tok && !tok.startsWith("-"))
                    add(tok);
            }
        }
        else if (DEST_LAST_CMDS.has(head)) {
            for (let i = tokens.length - 1; i >= 1; i--) {
                const tok = tokens[i];
                if (tok && !tok.startsWith("-")) {
                    add(tok);
                    break;
                }
            }
        }
    }
    return Array.from(seen);
}
/**
 * P6-7 (#18) — honesty signal for a write-SHAPED Bash command whose target token
 * was DROPPED because it contained a shell metacharacter / variable (`$f`, a glob,
 * a subshell). `extractBashWriteTargets` deliberately skips such tokens (they are
 * not literal paths the gate can reason about), which means a redirection like
 * `echo x > $f` silently produces NO target and the gate stays quiet — an honest
 * but invisible blind spot.
 *
 * This predicate detects exactly that situation: the command LOOKS like a write
 * (it has a redirection / tee / dd-of / sed -i / cp-mv-touch family head) but
 * `extractBashWriteTargets` returned nothing because every candidate target was a
 * metachar/variable token. Returns true only when there IS a write shape AND the
 * target was metachar-obscured (so we don't fire on a pure read command). Under
 * `write_gate: "strict"` the caller turns this into an `ask` (surface for a human)
 * instead of a silent allow; default modes keep the historical silent allow so the
 * existing M-4 contract (`echo hi > $f` → allow) is unchanged.
 */
function bashWriteTargetWasDropped(command) {
    // If we already extracted a concrete target, nothing was (entirely) dropped.
    if (extractBashWriteTargets(command).length > 0)
        return false;
    const SHELL_METACHARS = /[$`*?(){}]/;
    // Redirection / tee / dd-of with a metachar-bearing target.
    const redirect = /(?:>>?)\s*("?)([^\s"'|;&<>]*[$`*?(){}][^\s"'|;&<>]*)\1/;
    const tee = /\btee\b\s+(?:-a\s+)?("?)([^\s"'|;&<>]*[$`*?(){}][^\s"'|;&<>]*)\1/;
    const dd = /\bof=("?)([^\s"'|;&<>]*[$`*?(){}][^\s"'|;&<>]*)\1/;
    if (redirect.test(command) || tee.test(command) || dd.test(command))
        return true;
    // sed -i / cp-mv-install-rsync-touch family with a metachar-bearing operand.
    if (/\bsed\b/.test(command) && /\s-i\b/.test(command)) {
        const lastToken = /([^\s"'|;&<>]+)\s*$/.exec(command);
        if (lastToken && lastToken[1] && SHELL_METACHARS.test(lastToken[1]))
            return true;
    }
    const WRITE_HEADS = new Set(["cp", "mv", "install", "rsync", "touch"]);
    for (const segment of command.split(/[;&|]+/)) {
        const tokens = segment.trim().split(/\s+/).filter(Boolean);
        const head = tokens[0];
        if (!head || !WRITE_HEADS.has(head))
            continue;
        if (tokens.slice(1).some((t) => !t.startsWith("-") && SHELL_METACHARS.test(t)))
            return true;
    }
    return false;
}
/**
 * Best-effort read of a top-level `write_gate: "strict"` opt-in from the RAW
 * (possibly schema-invalid) state.json bytes — used only on the invalid-state
 * fail-closed path (GOV-3). The state object failed schema validation, so we
 * cannot trust `r.state`; we ask the narrower question "did the operator declare
 * strict mode?" directly against the parsed JSON. Returns true ONLY for an exact
 * top-level string `"strict"`. Never throws: undefined raw, non-JSON, non-object,
 * or any non-strict/absent value all return false (→ historical fail-open).
 */
function rawWriteGateIsStrict(raw) {
    if (typeof raw !== "string")
        return false;
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return false; // Unparseable bytes carry no readable opt-in → fail open.
    }
    if (typeof parsed !== "object" || parsed === null)
        return false;
    return parsed["write_gate"] === "strict";
}
/**
 * Helper: convert an absolute path to a root-relative forward-slash string,
 * or null if the path is outside the project root (caller should allow it).
 */
function toRootRelative(absTarget, root) {
    // R-13 symmetry: `resolveProjectPaths` canonicalizes `paths.root` (realpath),
    // but the caller resolves `absTarget` against the payload `cwd`, which may be a
    // NON-canonical alias of the same root (macOS /var→/private/var, a Windows 8.3
    // short name like RUNNER~1, a symlinked $TMPDIR, or any junctioned checkout). A
    // lexical `path.relative(canonicalRoot, aliasedTarget)` then yields ".." and the
    // gate reads an in-root write as "outside root" → it stands down and fails OPEN.
    // Canonicalize BOTH sides through the longest-existing-prefix realpath (same
    // mechanism as the root, idempotent when already canonical) so containment never
    // depends on which alias the cwd arrived as.
    const realRoot = (0, paths_1.realpathExistingPrefix)(root);
    const realTarget = (0, paths_1.realpathExistingPrefix)(absTarget);
    const rel = path.relative(realRoot, realTarget);
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
 * SG3 P1-B (C-11) — is `relFwd` (a root-relative, forward-slash target) inside the
 * delegate's declared allowed-files scope? Each `allowed` entry is normalized to a
 * root-relative POSIX path (resolved against `root` so `./x`, backslashes, and
 * redundant segments collapse), then matched as either an EXACT file or a DIRECTORY
 * PREFIX (an entry that is a directory — or written with a trailing "/" — admits every
 * path beneath it). An entry that escapes the root is ignored (it can never match an
 * in-root target). Caller guarantees the list is non-empty before calling.
 */
function isWithinAllowedFiles(relFwd, allowed, root) {
    for (const entry of allowed) {
        const rel = toRootRelative(path.resolve(root, entry), root);
        if (rel === null || rel.length === 0)
            continue; // escapes root / empty → cannot match.
        if (relFwd === rel)
            return true; // exact file match.
        // Directory-prefix match: the entry names a dir (or was written dir-like) and the
        // target lives under it. Compare on a "/"-terminated prefix so "src/a" does not
        // admit "src/abc".
        if (relFwd.startsWith(rel.endsWith("/") ? rel : rel + "/"))
            return true;
    }
    return false;
}
/**
 * R-02 / R-19: is `relFwd` (a root-relative, forward-slash path) one of the verify
 * approval trust anchors — `verify.json` or `verify-approvals.jsonl` under the state
 * dir? These records authorize which commands `th verify run` executes, so they are
 * NEVER silently writable by a tool call. Derived from `paths.stateDir`, so it holds
 * for `.twinharness` AND the legacy `.agentic-sdlc`. This is the SINGLE source of the
 * anchor names, shared by step e2 (file_path Write/Edit) and step c1 (Bash).
 */
function isVerifyAnchorPath(relFwd, paths) {
    const stateRel = toRootRelative(paths.stateDir, paths.root);
    if (stateRel === null)
        return false;
    return relFwd === `${stateRel}/verify.json` || relFwd === `${stateRel}/verify-approvals.jsonl`;
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
 * Build a gate-firing decision payload (`ask`/`deny`) — the single source for the
 * `hookSpecificOutput` shape every gate branch emits. The in-handler `fireGate`
 * closure and the extracted phase-gate helpers all go through this so the bytes
 * are identical regardless of which branch fired.
 */
function fireGateResult(decision, reason) {
    return {
        stdout: JSON.stringify({
            hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: decision,
                permissionDecisionReason: reason,
            },
        }),
        exitCode: 0,
    };
}
/**
 * Step c2 (extracted, behavior-identical): Phase A Bash-mediated write
 * defense-in-depth (fail-open). Only fires during Phase A
 * (implementation_allowed=false). Heuristically detect shell-mediated writes into
 * in-root implementation paths; fire the gate on the FIRST offending target.
 * Returns `null` (fall through → allow) when no offending target is found. Never
 * fires in Phase B. Conditions, iteration order, reason text, and the fired
 * `gateMode` decision are identical to the prior inline block.
 */
function phaseABashGate(state, bashCommand, input, paths, gateMode) {
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
                return fireGateResult(gateMode, reason);
            }
        }
        // P6-7 (#18) — strict-only honesty signal: no concrete target was found, but the
        // command is write-SHAPED with a metachar/variable-obscured target the matcher
        // had to drop (e.g. `echo x > $f`). Under write_gate=strict we surface this as an
        // `ask` instead of a silent allow, so a human sees the blind spot rather than the
        // gate going quiet. Default modes keep the historical silent allow (M-4 contract).
        if (state.write_gate === "strict" && bashWriteTargetWasDropped(bashCommand)) {
            const reason = `TwinHarness write-gate (strict mode — honesty signal) is ASKING about a Bash-mediated write ` +
                `whose target it could not resolve (Phase A — pre-implementation). ` +
                `The command looks like a write but its target is a shell variable/metacharacter ` +
                `(e.g. \`$var\`, a glob, or a subshell), so the gate cannot confirm where it writes. ` +
                `Under write_gate=strict this is surfaced for a human decision instead of silently allowed. ` +
                `AGENT INSTRUCTION: do NOT retry blindly — confirm the resolved target with the human, ` +
                `or use \`th state set implementation_allowed true\` once Phase A gates are cleared. ` +
                `Escape hatch (emergency manual override): set env TH_DISABLE_WRITE_GATE=1.`;
            return fireGateResult("ask", reason);
        }
        // No offending target found → fall through (fail-open).
    }
    return null;
}
function classifyOwnership(relFwd, slices, root) {
    const owners = findOwningSlices(relFwd, slices, root);
    if (owners.length === 0)
        return { kind: "unowned" };
    if (owners.some((o) => o.status === "in-progress"))
        return { kind: "in-progress" };
    const ownerSummary = owners.map((o) => `${o.id} (${o.status})`).join(", ");
    return { kind: "violation", ownerSummary };
}
/**
 * Step c3 (extracted, behavior-identical): Phase B Bash-mediated write
 * enforcement — strict mode only (G4). Runs BEFORE the file_path step because a
 * Bash tool call carries `command` but no `file_path`/`notebook_path`. Under
 * `write_gate: "strict"`, with implementation allowed and a Bash command present,
 * the same conservative matcher is applied to mid-build Bash writes; fail-open
 * except a target owned solely by non-in-progress slices fires `deny`. Returns
 * `null` (fall through) otherwise. Guard condition, iteration order, the
 * per-target containment checks, reason text, and the `deny` decision are
 * identical to the prior inline block.
 */
function phaseBStrictBashGate(state, bashCommand, input, paths) {
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
            const verdict = classifyOwnership(relB, state.slices, paths.root);
            if (verdict.kind !== "violation")
                continue; // unowned in-root path / in-progress owner → allow.
            // Owned only by slices that are not in-progress → component-boundary violation.
            const ownerSummary = verdict.ownerSummary;
            const reason = `TwinHarness write-gate (strict mode — Phase-B Bash enforcement) blocked this Bash-mediated write. ` +
                `Target path: ${relB}. ` +
                `This path is owned by slice(s): ${ownerSummary}, none of which are currently in-progress. ` +
                `Under write_gate=strict, Bash-mediated writes (e.g. echo/sed/tee redirections) are held to the same ` +
                `§16 component-boundary rule as Write/Edit: another slice owns this path. ` +
                `AGENT INSTRUCTION: do NOT retry this write — escalate to the human for a decision. ` +
                `To allow this write, set the owning slice to in-progress: ` +
                `\`th slice set-status <SLICE-ID> in-progress\`. ` +
                `Escape hatch (emergency manual override): set env TH_DISABLE_WRITE_GATE=1.`;
            return fireGateResult("deny", reason);
        }
        // No offending target found → fall through (fail-open).
    }
    return null;
}
/**
 * Step h (extracted, behavior-identical): Phase B component-boundary enforcement
 * for a Write/Edit/NotebookEdit `file_path`. Implementation is allowed and slices
 * exist: a path owned by at least one in-progress slice is allowed (→ `null`); a
 * path owned ONLY by non-in-progress slices is an `ask` component-boundary
 * violation; an unowned path is allowed (→ `null`). Owner lookup, the
 * any/all-in-progress decision, reason text, and the `ask` decision are identical
 * to the prior inline block.
 */
function phaseBFileGate(relFwd, state, paths) {
    if (state.slices.length > 0) {
        const verdict = classifyOwnership(relFwd, state.slices, paths.root);
        if (verdict.kind === "violation") {
            // Owned only by slices that are not in-progress → component-boundary violation.
            const ownerSummary = verdict.ownerSummary;
            const reason = `TwinHarness write-gate blocked this write (Phase B — component-boundary enforcement). ` +
                `Target path: ${relFwd}. ` +
                `This path is owned by slice(s): ${ownerSummary}, none of which are currently in-progress. ` +
                `This looks like a component-boundary violation (§16): another slice owns this path. ` +
                `AGENT INSTRUCTION: do NOT retry this write — escalate to the human for a decision. ` +
                `To allow this write, set the owning slice to in-progress: ` +
                `\`th slice set-status <SLICE-ID> in-progress\`.`;
            return fireGateResult("ask", reason);
        }
        // Unowned path → allow (new files appear constantly during a build).
    }
    return null;
}
/**
 * `th hook pretool-gate` — emit a Claude Code PreToolUse hook decision on stdout.
 *
 * Implements the decision ladder from spec/write-gate-design.md §Decision ladder:
 * a. No state.json → allow ({}).
 * b. TH_DISABLE_WRITE_GATE=1 or write_gate=off → allow.
 * c. state.json invalid → allow + systemMessage warning (fail-open), UNLESS the
 *    raw bytes carry a top-level `write_gate: "strict"` opt-in, in which case the
 *    invalid state is fail-CLOSED: deny the write until state.json is repaired
 *    (GOV-3). Default/absent/other modes keep the historical fail-open behaviour.
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
    const fireGate = (decision, reason) => fireGateResult(decision, reason);
    // Step b (env check): TH_DISABLE_WRITE_GATE=1 → allow immediately, before reading state.
    if (env["TH_DISABLE_WRITE_GATE"] === "1")
        return allow();
    // Step a: No state.json → allow.
    const r = (0, state_store_1.readState)(paths);
    if (!r.exists)
        return allow();
    // Step c: Invalid state.
    //
    // Default (and historical) behaviour is fail-OPEN: an invalid state.json makes
    // the write-gate stand down and ALLOW the write (with a warning), because a
    // false block on every write in a project whose state merely drifted would be
    // worse than the gate going quiet — the stop-gate still blocks completion.
    //
    // GOV-3 opt-in (`write_gate: "strict"`): a strict operator has declared that an
    // invalid/corrupt state is itself a stop condition — a mid-session corruption
    // must NOT silently disarm the gate. So when the (otherwise-invalid) state.json
    // still carries a top-level `write_gate: "strict"`, we fail-CLOSED and DENY the
    // write instead of allowing it. We read the mode from the raw bytes because
    // there is no validated `state` object here; only an exact top-level
    // `"strict"` opt-in trips the fail-closed path. Bytes that do not parse at all,
    // or that carry any non-strict / absent mode, keep the historical fail-open
    // behaviour (we cannot read a strict opt-in we cannot see — staying honest
    // rather than denying on unprovable intent).
    if (!r.state) {
        if (rawWriteGateIsStrict(r.raw)) {
            const reason = `TwinHarness write-gate (strict mode — fail-closed) DENIED this write because state.json is invalid. ` +
                `Under \`write_gate: "strict"\` an unreadable/invalid state is treated as a stop condition, not a stand-down: ` +
                `the gate refuses writes until state.json is repaired (the default modes fail open here). ` +
                `Repair state.json to restore normal gating. ` +
                `Escape hatch (emergency manual override): set env TH_DISABLE_WRITE_GATE=1. ` +
                `AGENT INSTRUCTION: do NOT retry this write — escalate to the human to repair state.json.`;
            return fireGate("deny", reason);
        }
        return allowWithWarning("TwinHarness write-gate is standing down because state.json is invalid (the stop-gate still blocks completion). " +
            "Repair state.json and re-run to restore gating.");
    }
    const state = r.state;
    // SG3 P1-B (C-11) — the EFFECTIVE delegate allowed-files scope is the UNION of any
    // stdin-provided `allowed_files` (forward-compat: a future host that injects them) and
    // the DURABLE scope armed by `th delegate pack --allowed-files`
    // (.twinharness/delegation-scope.json). The installed hook receives only host stdin,
    // which carries NO allowed_files, so WITHOUT the persisted scope the delegate-scope
    // enforcement below could never activate (audit P1). An empty union is a no-op (the
    // historical gating is untouched). Read once here, used by steps c1c (Bash) and e1
    // (file_path) below.
    const stdinScope = Array.isArray(input?.allowed_files)
        ? input.allowed_files.filter((x) => typeof x === "string")
        : [];
    const persistedScope = (0, delegation_scope_1.readDelegationScope)(paths).allowedFiles;
    const effectiveAllowedFiles = [...new Set([...stdinScope, ...persistedScope])];
    // Step b (state check): write_gate=off → allow.
    if (state.write_gate === "off")
        return allow();
    // Effective gate mode: use write_gate field, defaulting to "ask" when absent.
    // "strict" carries "deny" semantics (and additionally gates Phase-B Bash writes
    // below — G4), so it maps to "deny" here.
    const gateMode = state.write_gate === "deny" || state.write_gate === "strict" ? "deny" : "ask";
    // Step c2: Phase A Bash-mediated write defense-in-depth (fail-open). Extracted
    // to phaseABashGate — fires the gate on the first offending Phase-A Bash target,
    // or returns null to fall through. Behavior identical to the prior inline block.
    const bashCommand = input?.tool_input?.command;
    // Step c1 (R-19): the verify approval trust anchors (verify.json /
    // verify-approvals.jsonl) are NEVER writable by a Bash-mediated tool call — in ANY
    // phase and ANY write_gate mode. (The sole bypass is step b's `write_gate==="off"`
    // above — a deliberate full disable, A1.) Step e2 below closes the SAME forge vector
    // for file_path Write/Edit, but a Bash tool call carries `command` and no `file_path`,
    // so it would short-circuit at step d (`!filePath → allow`) before ever reaching e2 —
    // and the doc/state allowlist otherwise blanket-allows the whole `.twinharness/` dir
    // for Bash (phaseABashGate / phaseBStrictBashGate). There is NO legitimate Bash writer
    // of these anchors (the `th verify` data layer writes via atomicWriteFile, not a shell),
    // so this is a HARD `deny` regardless of gateMode — there is nothing to "ask" about.
    // This runs UNCONDITIONALLY (not nested in phaseA/phaseBStrictBashGate, which are
    // phase/strict-gated) so the deny truly holds across all phases and modes.
    // Closure scope: this catches PARSEABLE write targets; an obfuscated target (heredoc,
    // `> $var`, `python -c`, process substitution) is dropped by extractBashWriteTargets
    // and remains a tracked follow-up — a green test here is NOT total Bash-forge closure.
    if (bashCommand) {
        const baseC1 = input?.cwd ?? paths.root;
        for (const token of extractBashWriteTargets(bashCommand)) {
            const absC1 = path.isAbsolute(token) ? token : path.resolve(baseC1, token);
            const relC1 = toRootRelative(absC1, paths.root);
            if (relC1 !== null && isVerifyAnchorPath(relC1, paths)) {
                const reason = `TwinHarness write-gate (R-19) hard-blocked a Bash-mediated write to a verify approval anchor (${relC1}). ` +
                    `This file authorizes which commands \`th verify run\` will execute; a shell redirection (echo/tee/sed >) could forge an approval around the gate. ` +
                    `There is NO legitimate Bash writer of this file — use \`th verify add\` / \`th verify approve\` (approve requires an interactive human TTY) instead. ` +
                    `Escape hatch (emergency manual override): set env TH_DISABLE_WRITE_GATE=1. ` +
                    `AGENT INSTRUCTION: do NOT retry this write — escalate to the human for a decision.`;
                return fireGate("deny", reason);
            }
        }
    }
    // Step c1b (R-24): a Bash-mediated write that would OVERWRITE a REGISTERED approved
    // artifact is held for human confirmation — mirroring step e3 (R-14) for Write/Edit.
    // A Bash tool call carries `command` and no `file_path`, so it short-circuits at step
    // d (`!filePath → allow`) BEFORE ever reaching the step-e3 R-14 guard, and the
    // doc/state allowlist otherwise blanket-allows the whole `docs/` surface for Bash —
    // so `echo x > docs/01-requirements.md` silently clobbered a reviewed artifact. We
    // close that with the SAME conservative target extraction + matcher and the SAME
    // `ask` disposition as Write/Edit (NOT a deny — a deliberate re-author must still be
    // approvable interactively). Runs in EVERY phase/mode (like e3), ahead of the
    // phase/strict-gated Bash gates below. Reuses extractBashWriteTargets +
    // matchApprovedArtifact — no reimplementation. Honest caveat (shared with R-19/M-4):
    // a metachar/variable-obscured target (`> $f`, heredoc, `python -c`) is dropped by
    // extractBashWriteTargets and is NOT caught here — this is the parseable-target guard.
    if (bashCommand) {
        const baseC1b = input?.cwd ?? paths.root;
        for (const token of extractBashWriteTargets(bashCommand)) {
            const absC1b = path.isAbsolute(token) ? token : path.resolve(baseC1b, token);
            const relC1b = toRootRelative(absC1b, paths.root);
            if (relC1b === null)
                continue; // outside root → not our concern
            const matched = (0, artifact_guard_1.matchApprovedArtifact)(state.approved_artifacts, paths.root, absC1b);
            if (matched) {
                const reason = `TwinHarness write-gate held this write for confirmation (R-24 — approved-artifact overwrite via Bash). ` +
                    `Target path: ${relC1b}. ` +
                    `This path is a REGISTERED approved artifact (${matched.file} v${matched.version}, hash ${matched.hash}); ` +
                    `a Bash-mediated write (e.g. echo/sed/tee redirection) must not silently overwrite reviewed/human-edited content ` +
                    `any more than a Write/Edit can (R-14). ` +
                    `If this re-author is intended, APPROVE the write, then record the new content with ` +
                    `\`th artifact register ${matched.file} --version ${matched.version + 1}\` (a version bump). ` +
                    `Escape hatch (emergency manual override): set env TH_DISABLE_WRITE_GATE=1. ` +
                    `AGENT INSTRUCTION: do NOT blindly retry — confirm the overwrite is intended before proceeding.`;
                return fireGate("ask", reason);
            }
        }
    }
    // Step c1c (SG3 P1-B / C-11): delegate allowed-files scope for a parseable Bash
    // write target. A Bash tool call carries `command` and no `file_path`, so it would
    // short-circuit at step d before the step-e1 allowed-files check; mirror that check
    // here for the conservative parseable targets (extractBashWriteTargets) so a shell
    // redirection cannot escape the delegate's scope. Same HARD deny + caveat as the
    // R-19/R-24 Bash guards (metachar/heredoc-obscured targets are out of scope). Only
    // fires when a non-empty allowed_files set was declared (additive; no-op otherwise).
    const allowedFilesC1c = effectiveAllowedFiles;
    if (bashCommand && allowedFilesC1c.length > 0) {
        const baseC1c = input?.cwd ?? paths.root;
        for (const token of extractBashWriteTargets(bashCommand)) {
            const absC1c = path.isAbsolute(token) ? token : path.resolve(baseC1c, token);
            const relC1c = toRootRelative(absC1c, paths.root);
            if (relC1c === null)
                continue; // outside root → not in scope to deny here.
            if (!isWithinAllowedFiles(relC1c, allowedFilesC1c, paths.root)) {
                const reason = `TwinHarness write-gate (C-11 — delegate scope) DENIED a Bash-mediated write: ${relC1c} is OUTSIDE the delegated agent's allowed-files scope. ` +
                    `This delegate was packed with an explicit allowed-files set (${allowedFilesC1c.join(", ")}); a shell redirection cannot escape it any more than a Write/Edit can. ` +
                    `AGENT INSTRUCTION: do NOT retry — write only within your allowed scope, or escalate to widen the delegation. ` +
                    `Escape hatch (emergency manual override): set env TH_DISABLE_WRITE_GATE=1.`;
                return fireGate("deny", reason);
            }
        }
    }
    const c2 = phaseABashGate(state, bashCommand, input, paths, gateMode);
    if (c2)
        return c2;
    // Step c3: Phase B Bash-mediated write enforcement — strict mode only (G4).
    // Extracted to phaseBStrictBashGate. Runs BEFORE step d because a Bash tool call
    // carries `command` but no `file_path`/`notebook_path`, so step d's early allow()
    // would otherwise make this branch unreachable for Bash writes. Behavior
    // identical to the prior inline block (fires `deny`, or falls through).
    const c3 = phaseBStrictBashGate(state, bashCommand, input, paths);
    if (c3)
        return c3;
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
    // Step e1 (SG3 P1-B / C-11): delegate allowed-files read-scoping. When the stdin
    // payload declares a non-empty `allowed_files` set (emitted by `th delegate pack`),
    // a write to an in-root target OUTSIDE that set is DENIED — ahead of the doc/state
    // allowlist and the phase gates, because the scope is TIGHTER than those (a delegate
    // confined to `src/auth/*` must not write a `docs/` file outside its scope either).
    // An ABSENT/empty list is a no-op, so the historical gating is untouched (additive
    // injection point). HARD deny: there is nothing to "ask" about — the delegate was
    // explicitly scoped, so an out-of-scope write is a boundary violation to escalate.
    const allowedFiles = effectiveAllowedFiles;
    if (allowedFiles.length > 0 && !isWithinAllowedFiles(relFwd, allowedFiles, paths.root)) {
        const reason = `TwinHarness write-gate (C-11 — delegate scope) DENIED this write: ${relFwd} is OUTSIDE the delegated agent's allowed-files scope. ` +
            `This delegate was packed with an explicit allowed-files set (${allowedFiles.join(", ")}); writes outside it are refused. ` +
            `AGENT INSTRUCTION: do NOT retry — write only within your allowed scope, or escalate to the human to widen the delegation (\`th delegate pack ... --allowed-files <list>\`). ` +
            `Escape hatch (emergency manual override): set env TH_DISABLE_WRITE_GATE=1.`;
        return fireGate("deny", reason);
    }
    // Step e2 (R-02): the verify approval trust anchors are NEVER silently writable by
    // a tool call. A direct Write/Edit to verify.json or verify-approvals.jsonl is the
    // "forge an approval around the gate" vector — those records authorize which
    // commands `th verify run` executes. Gate it in BOTH phases (ask by default, deny
    // under deny/strict), ahead of the doc/state allowlist that otherwise blanket-allows
    // the whole state dir. Derived from paths.stateDir so it holds for `.twinharness`
    // and the legacy `.agentic-sdlc`. The CLI/MCP `th verify` data layer writes these
    // through atomicWriteFile (not a tool call), so legitimate flows are unaffected —
    // the only path to an approval is `th verify approve`, which itself requires a TTY.
    // Shares isVerifyAnchorPath with step c1 (R-19) — the single source of the anchor names.
    if (isVerifyAnchorPath(relFwd, paths)) {
        const reason = `TwinHarness write-gate gated a direct write to a verify approval anchor (${relFwd}). ` +
            `This file authorizes which commands \`th verify run\` will execute; a direct tool write could forge an approval. ` +
            `Use \`th verify add\` / \`th verify approve\` (approve requires an interactive human TTY) instead of editing the file. ` +
            `Escape hatch (emergency manual override): set env TH_DISABLE_WRITE_GATE=1.`;
        return fireGate(gateMode, reason);
    }
    // Step e3 (R-14 / DR-04a): a write that would OVERWRITE a registered approved
    // artifact is held for human confirmation, even inside the otherwise-whitelisted
    // `docs/` surface. `approved_artifacts` is the mechanical record of "reviewed /
    // approved" content; a stage re-run that re-authors such a doc must not SILENTLY
    // clobber a human-edited version. We fire `ask` (not `deny`) so the deliberate
    // re-author still works — the human approves the overwrite interactively, which IS
    // the escape for a tool write (the CLI/MCP `th repo map` direct-write path wires an
    // explicit `--force`). This runs AHEAD of the doc/state allowlist (step f), which
    // would otherwise blanket-allow every `docs/` write; a NEVER-registered `docs/` path
    // is unaffected (falls through to step f). Keyed strictly on registration, so
    // non-artifact state/ledger writes never reach here.
    const matched = (0, artifact_guard_1.matchApprovedArtifact)(state.approved_artifacts, paths.root, absTarget);
    if (matched) {
        const reason = `TwinHarness write-gate held this write for confirmation (R-14 — approved-artifact overwrite). ` +
            `Target path: ${relFwd}. ` +
            `This path is a REGISTERED approved artifact (${matched.file} v${matched.version}, hash ${matched.hash}); ` +
            `re-running a stage must not silently overwrite reviewed/human-edited content. ` +
            `If this re-author is intended, APPROVE the write, then record the new content with ` +
            `\`th artifact register ${matched.file} --version ${matched.version + 1}\` (a version bump). ` +
            `Escape hatch (emergency manual override): set env TH_DISABLE_WRITE_GATE=1. ` +
            `AGENT INSTRUCTION: do NOT blindly retry — confirm the overwrite is intended before proceeding.`;
        return fireGate("ask", reason);
    }
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
    // Step h: Phase B — implementation allowed, slices exist. Extracted to
    // phaseBFileGate: fires `ask` on a component-boundary violation, or returns null
    // (in-progress owner / unowned / no slices) → fall through to the final allow().
    // Behavior identical to the prior inline block.
    const h = phaseBFileGate(relFwd, state, paths);
    if (h)
        return h;
    return allow();
}
