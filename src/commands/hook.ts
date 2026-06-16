import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectPaths } from "../core/paths";
import { readState } from "../core/state-store";
import { readVerifyConfig, readVerifyReport } from "../core/verify";
import { gatingObligations, reduceDecisions, readDecisionEvents } from "../core/decisions";
import { isFinalVerification } from "../core/stages";

/**
 * Stop-gate decision (plan pre-mortem #2 mitigation): the mechanical gate that
 * blocks a premature "stage complete" claim. Logic lives in tested CLI code, not
 * in a shell hook, so the gate is verifiable.
 */
export interface StopGateDecision {
  block: boolean;
  reasons: string[];
}

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
export function evaluateStopGate(paths: ProjectPaths): StopGateDecision {
  const r = readState(paths);
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
  const obligations = gatingObligations(reduceDecisions(readDecisionEvents(paths)), r.state);
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
  if (isFinalVerification(r.state.current_stage)) {
    const incomplete = r.state.slices.filter(
      (s) => s.status !== "done" && s.status !== "blocked",
    );
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
    const commands = readVerifyConfig(paths).commands;
    if (commands.length > 0) {
      const report = readVerifyReport(paths);
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
 * The subset of the Claude Code Stop-hook stdin payload the gate cares about.
 * `stop_hook_active` is true when Claude is ALREADY continuing because a stop
 * hook blocked — the documented signal for preventing infinite stop loops.
 */
export interface StopHookInput {
  stop_hook_active?: boolean;
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
export function runHookStopGate(
  paths: ProjectPaths,
  input?: StopHookInput,
): { stdout: string; exitCode: number } {
  const decision = evaluateStopGate(paths);
  if (decision.block) {
    const reason = "TwinHarness stop-gate blocked completion: " + decision.reasons.join(" ");
    if (input?.stop_hook_active === true) {
      return {
        stdout: JSON.stringify({
          systemMessage:
            "TwinHarness stop-gate is STILL blocked, but allowed the stop to avoid an infinite loop. " +
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
 * The subset of the Claude Code SubagentStop-hook stdin payload the gate cares
 * about. `stop_hook_active` is true when a subagent is ALREADY continuing because
 * a SubagentStop hook blocked — the documented signal for preventing infinite
 * stop loops (mirrors the Stop hook's `stop_hook_active`).
 */
export interface SubagentStopHookInput {
  stop_hook_active?: boolean;
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
export function runHookSubagentStop(
  paths: ProjectPaths,
  input?: SubagentStopHookInput,
): { stdout: string; exitCode: number } {
  const r = readState(paths);

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
          systemMessage:
            "TwinHarness subagent-stop gate is STILL blocked, but allowed the stop to avoid an infinite loop. " +
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

// ---------------------------------------------------------------------------
// PreToolUse write-gate (design doc spec/write-gate-design.md)
// ---------------------------------------------------------------------------

/**
 * The subset of the Claude Code PreToolUse stdin payload the write-gate cares about.
 * `tool_name` lets the hook identify which tool is firing; `tool_input.file_path`
 * is the path being written (Write/Edit); `tool_input.notebook_path` is used by
 * NotebookEdit; `tool_input.command` is the Bash command string (Bash tool);
 * `cwd` is the session's project directory.
 */
export interface PreToolHookInput {
  tool_name?: string;
  tool_input?: { file_path?: string; notebook_path?: string; command?: string };
  cwd?: string;
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
export function extractBashWriteTargets(command: string): string[] {
  const seen = new Set<string>();
  const SHELL_METACHARS = /[$`*?(){}]/;
  const add = (token: string) => {
    const t = token.replace(/^["']|["']$/g, "");
    if (t && !t.startsWith("-") && !SHELL_METACHARS.test(t)) seen.add(t);
  };

  // Redirections: > or >> followed by optional whitespace then a path token.
  const redirectRe = /(?:>>?)\s*("?)([^\s"'|;&<>]+)\1/g;
  let m: RegExpExecArray | null;
  while ((m = redirectRe.exec(command)) !== null) {
    if (m[2]) add(m[2]);
  }

  // tee (optionally -a): `tee [-a] PATH`
  const teeRe = /\btee\b\s+(?:-a\s+)?("?)([^\s"'|;&<>]+)\1/g;
  while ((m = teeRe.exec(command)) !== null) {
    if (m[2]) add(m[2]);
  }

  // dd of=PATH
  const ddRe = /\bof=("?)([^\s"'|;&<>]+)\1/g;
  while ((m = ddRe.exec(command)) !== null) {
    if (m[2]) add(m[2]);
  }

  // sed -i in-place: capture last bareword token of the command as the file.
  if (/\bsed\b/.test(command) && /\s-i\b/.test(command)) {
    const lastToken = /([^\s"'|;&<>]+)\s*$/.exec(command);
    if (lastToken && lastToken[1]) add(lastToken[1]);
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
    if (!head) continue;
    if (head === "touch") {
      for (let i = 1; i < tokens.length; i++) {
        const tok = tokens[i];
        if (tok && !tok.startsWith("-")) add(tok);
      }
    } else if (DEST_LAST_CMDS.has(head)) {
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
 * Best-effort read of a top-level `write_gate: "strict"` opt-in from the RAW
 * (possibly schema-invalid) state.json bytes — used only on the invalid-state
 * fail-closed path (GOV-3). The state object failed schema validation, so we
 * cannot trust `r.state`; we ask the narrower question "did the operator declare
 * strict mode?" directly against the parsed JSON. Returns true ONLY for an exact
 * top-level string `"strict"`. Never throws: undefined raw, non-JSON, non-object,
 * or any non-strict/absent value all return false (→ historical fail-open).
 */
function rawWriteGateIsStrict(raw: string | undefined): boolean {
  if (typeof raw !== "string") return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false; // Unparseable bytes carry no readable opt-in → fail open.
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  return (parsed as Record<string, unknown>)["write_gate"] === "strict";
}

/**
 * Helper: convert an absolute path to a root-relative forward-slash string,
 * or null if the path is outside the project root (caller should allow it).
 */
function toRootRelative(absTarget: string, root: string): string | null {
  const rel = path.relative(root, absTarget);
  // path.relative returns a string starting with ".." when outside root.
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

/**
 * Doc/state allowlist: paths that are always allowed regardless of phase.
 * Matches the spec list: docs/, .twinharness/, .agentic-sdlc/, .claude/,
 * drift-log.md, .gitignore, and any *.md directly at the project root.
 */
function isAllowedDocOrStatePath(relFwd: string): boolean {
  if (
    relFwd === "drift-log.md" ||
    relFwd === ".gitignore" ||
    relFwd.startsWith("docs/") ||
    relFwd.startsWith(".twinharness/") ||
    relFwd.startsWith(".agentic-sdlc/") ||
    relFwd.startsWith(".claude/")
  ) {
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
function isPathLikeComponent(token: string, root: string): boolean {
  if (token.includes("/")) return true;
  return fs.existsSync(path.join(root, token));
}

/**
 * Phase B: determine which slices (by id) own a root-relative path.
 * Returns an array of { id, status } for slices that claim the path through
 * at least one path-like component token.
 */
function findOwningSlices(
  relFwd: string,
  slices: Array<{ id: string; status: string; components: string[] }>,
  root: string,
): Array<{ id: string; status: string }> {
  const owners: Array<{ id: string; status: string }> = [];
  for (const sl of slices) {
    for (const token of sl.components) {
      if (!isPathLikeComponent(token, root)) continue;
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

/** The hook's stdout+exit payload (a PreToolUse decision). */
type GateResult = { stdout: string; exitCode: number };

/**
 * Build a gate-firing decision payload (`ask`/`deny`) — the single source for the
 * `hookSpecificOutput` shape every gate branch emits. The in-handler `fireGate`
 * closure and the extracted phase-gate helpers all go through this so the bytes
 * are identical regardless of which branch fired.
 */
function fireGateResult(decision: "ask" | "deny", reason: string): GateResult {
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
function phaseABashGate(
  state: { implementation_allowed: boolean; current_stage: string },
  bashCommand: string | undefined,
  input: PreToolHookInput | undefined,
  paths: ProjectPaths,
  gateMode: "ask" | "deny",
): GateResult | null {
  if (bashCommand && !state.implementation_allowed) {
    const base0 = input?.cwd ?? paths.root;
    const targets = extractBashWriteTargets(bashCommand);
    for (const token of targets) {
      const absT = path.isAbsolute(token) ? token : path.resolve(base0, token);
      const rel0 = toRootRelative(absT, paths.root);
      if (rel0 !== null && !isAllowedDocOrStatePath(rel0)) {
        const reason =
          `TwinHarness write-gate (Bash defense-in-depth) blocked this Bash-mediated write ` +
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
    // No offending target found → fall through (fail-open).
  }
  return null;
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
function phaseBStrictBashGate(
  state: {
    write_gate?: string;
    implementation_allowed: boolean;
    slices: Array<{ id: string; status: string; components: string[] }>;
  },
  bashCommand: string | undefined,
  input: PreToolHookInput | undefined,
  paths: ProjectPaths,
): GateResult | null {
  if (
    state.write_gate === "strict" &&
    state.implementation_allowed &&
    bashCommand &&
    state.slices.length > 0
  ) {
    const baseB = input?.cwd ?? paths.root;
    const targetsB = extractBashWriteTargets(bashCommand);
    for (const token of targetsB) {
      const absT = path.isAbsolute(token) ? token : path.resolve(baseB, token);
      const relB = toRootRelative(absT, paths.root);
      if (relB === null || isAllowedDocOrStatePath(relB)) continue; // out-of-root / doc → allow.
      const owners = findOwningSlices(relB, state.slices, paths.root);
      if (owners.length === 0) continue; // unowned in-root path → allow.
      if (owners.some((o) => o.status === "in-progress")) continue; // an in-progress owner → allow.
      // Owned only by slices that are not in-progress → component-boundary violation.
      const ownerSummary = owners.map((o) => `${o.id} (${o.status})`).join(", ");
      const reason =
        `TwinHarness write-gate (strict mode — Phase-B Bash enforcement) blocked this Bash-mediated write. ` +
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
function phaseBFileGate(
  relFwd: string,
  state: { slices: Array<{ id: string; status: string; components: string[] }> },
  paths: ProjectPaths,
): GateResult | null {
  if (state.slices.length > 0) {
    const owners = findOwningSlices(relFwd, state.slices, paths.root);
    if (owners.length > 0) {
      const anyInProgress = owners.some((o) => o.status === "in-progress");
      if (anyInProgress) {
        // At least one in-progress owner → allow.
        return null;
      }
      // Owned only by slices that are not in-progress → component-boundary violation.
      const ownerSummary = owners.map((o) => `${o.id} (${o.status})`).join(", ");
      const reason =
        `TwinHarness write-gate blocked this write (Phase B — component-boundary enforcement). ` +
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
export function runHookPretoolGate(
  paths: ProjectPaths,
  input?: PreToolHookInput,
  env: NodeJS.ProcessEnv = process.env,
): { stdout: string; exitCode: number } {
  const allow = (): { stdout: string; exitCode: number } =>
    ({ stdout: JSON.stringify({}), exitCode: 0 });

  const allowWithWarning = (msg: string): { stdout: string; exitCode: number } =>
    ({ stdout: JSON.stringify({ systemMessage: msg }), exitCode: 0 });

  const fireGate = (decision: "ask" | "deny", reason: string): GateResult =>
    fireGateResult(decision, reason);

  // Step b (env check): TH_DISABLE_WRITE_GATE=1 → allow immediately, before reading state.
  if (env["TH_DISABLE_WRITE_GATE"] === "1") return allow();

  // Step a: No state.json → allow.
  const r = readState(paths);
  if (!r.exists) return allow();

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
      const reason =
        `TwinHarness write-gate (strict mode — fail-closed) DENIED this write because state.json is invalid. ` +
        `Under \`write_gate: "strict"\` an unreadable/invalid state is treated as a stop condition, not a stand-down: ` +
        `the gate refuses writes until state.json is repaired (the default modes fail open here). ` +
        `Repair state.json to restore normal gating. ` +
        `Escape hatch (emergency manual override): set env TH_DISABLE_WRITE_GATE=1. ` +
        `AGENT INSTRUCTION: do NOT retry this write — escalate to the human to repair state.json.`;
      return fireGate("deny", reason);
    }
    return allowWithWarning(
      "TwinHarness write-gate is standing down because state.json is invalid (the stop-gate still blocks completion). " +
        "Repair state.json and re-run to restore gating.",
    );
  }

  const state = r.state;

  // Step b (state check): write_gate=off → allow.
  if (state.write_gate === "off") return allow();

  // Effective gate mode: use write_gate field, defaulting to "ask" when absent.
  // "strict" carries "deny" semantics (and additionally gates Phase-B Bash writes
  // below — G4), so it maps to "deny" here.
  const gateMode: "ask" | "deny" =
    state.write_gate === "deny" || state.write_gate === "strict" ? "deny" : "ask";

  // Step c2: Phase A Bash-mediated write defense-in-depth (fail-open). Extracted
  // to phaseABashGate — fires the gate on the first offending Phase-A Bash target,
  // or returns null to fall through. Behavior identical to the prior inline block.
  const bashCommand = input?.tool_input?.command;
  const c2 = phaseABashGate(state, bashCommand, input, paths, gateMode);
  if (c2) return c2;

  // Step c3: Phase B Bash-mediated write enforcement — strict mode only (G4).
  // Extracted to phaseBStrictBashGate. Runs BEFORE step d because a Bash tool call
  // carries `command` but no `file_path`/`notebook_path`, so step d's early allow()
  // would otherwise make this branch unreachable for Bash writes. Behavior
  // identical to the prior inline block (fires `deny`, or falls through).
  const c3 = phaseBStrictBashGate(state, bashCommand, input, paths);
  if (c3) return c3;

  // Step d: No file_path (or notebook_path for NotebookEdit) → allow.
  const filePath = input?.tool_input?.file_path ?? input?.tool_input?.notebook_path;
  if (!filePath) return allow();

  // Step e: Resolve target. Relative paths are resolved against input.cwd ?? paths.root.
  const base = input?.cwd ?? paths.root;
  const absTarget = path.isAbsolute(filePath) ? filePath : path.resolve(base, filePath);
  const relFwd = toRootRelative(absTarget, paths.root);
  if (relFwd === null) return allow(); // Outside project root → not our concern.

  // Step f: Doc/state allowlist → allow.
  if (isAllowedDocOrStatePath(relFwd)) return allow();

  // Step g: Phase A — implementation not yet allowed (file_path/notebook_path path).
  if (!state.implementation_allowed) {
    const reason =
      `TwinHarness write-gate blocked this write (Phase A — pre-implementation). ` +
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
  if (h) return h;

  return allow();
}
