import * as fs from "node:fs";
import * as path from "node:path";
import {
  realpathExistingPrefix,
  resolveProjectPaths,
  StateLocationConflictError,
  type ProjectPaths,
} from "../core/paths";
import { readState } from "../core/state-store";
import { matchApprovedArtifact } from "../core/artifact-guard";
import {
  readActiveDelegationScopes,
  clearDelegationScope,
  type ActiveDelegationScope,
} from "../core/delegation-scope";
import { canCompleteRun } from "../core/gate-preconditions";
import { renderStopReason } from "./next";
import { hashContent, shortHash } from "../core/hash";
import {
  computePageId,
  normalizeLocator,
  classifySensitive,
  coldStorePut,
  contextPagesRoot,
  rawColdStoreEnabled,
  coldStoreCaps,
  maybeEnforceColdStoreRetention,
  CONTEXT_PAGE_SCHEMA_VERSION,
  type SourceKind,
  type ReductionKind,
} from "../core/context-page";
import type { LedgerScope, LedgerRecord } from "../core/context-ledger";
import { appendLedgerRecord, readShardRecordsTail } from "../core/context-ledger";
import {
  deriveResidency,
  currentEpoch,
  bumpEpoch,
  maybeCheckEpoch,
  RESIDENCY_TTL_TURNS,
} from "../core/context-residency";
import { capsuleFromState } from "../core/context-capsule";
import {
  recordTelemetry,
  estimateTokens,
  probeAgentIdPresentOnToolHook,
  probeSubagentStartFired,
  TELEMETRY_SCHEMA_VERSION,
} from "../core/context-telemetry";
import { classify } from "../core/savings-classify";

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
 * Decide whether the orchestrator may declare completion (R-29 — now the COMPLETION
 * predicate `canCompleteRun`, the single source of truth shared with `th next` and
 * the MCP gate tools).
 *
 * This is the BINARY projection (no loop-escape awareness — that lives in
 * `decideStopGate`/`runHookStopGate`): `block` is true iff `canCompleteRun` refuses
 * completion for the current state. `canCompleteRun` blocks at ANY stage on the
 * always-run human-reconciliation obligations (drift, revise-escalation, decisions,
 * debate) and, at `final-verification`, on the STRICT completion ladder — slices
 * settled → verify_config_corrupt → verify_suite_never_run → coverage → report
 * produced/registered → production-reality (the verify AUTHORITY at completion is
 * `checkFinalVerification`, NOT the weaker `checkVerifySuite`). Forward-only rungs at
 * a non-final stage do not gate a mid-build turn-end.
 *
 * `reasons[0]` is the token-derived sentence `renderStopReason` emits — identical to
 * what `th next` prints for the same rung (the Stop↔next parity contract).
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
  const verdict = canCompleteRun(paths, r.state);
  if (verdict.ok) return { block: false, reasons: [] };
  return { block: true, reasons: [renderStopReason(verdict.error ?? "blocked", verdict.detail)] };
}

/**
 * The three-state Stop-gate verdict (R-29, Item b). The old `StopGateDecision`
 * carried a binary `block` plus reason strings; the verdict distinguishes the
 * loop-escape from a clean pass so the caller never conflates "STILL blocked but
 * yielding to a human to avoid a loop" with "actually complete":
 *
 *   - `block`       — a completion-relevant rung is unmet and there is no loop-escape;
 *                     the Stop hook refuses the turn-end.
 *   - `complete`    — every completion-relevant rung passes; the run may stop.
 *   - `human-yield` — a rung is STILL unmet but `stop_hook_active` is true, so the
 *                     gate yields the turn to a human instead of re-blocking forever
 *                     (a human decision is required). This is NOT the empty `complete`
 *                     payload — the unresolved reason is surfaced.
 *
 * `reason` is the human-facing token-derived sentence (renderStopReason parity);
 * `token` is the stable canonical token of the first unmet rung (absent on complete).
 */
export type StopGateVerdictKind = "block" | "complete" | "human-yield";

export interface StopGateVerdict {
  kind: StopGateVerdictKind;
  /** Stable canonical token of the first unmet completion rung (absent on complete). */
  token?: string;
  /** The human sentence for the unmet rung (parity with `th next`); absent on complete. */
  reason?: string;
}

/**
 * Decide the three-state Stop-gate verdict from the COMPLETION predicate
 * (`canCompleteRun`) — the re-selection that blocks completion at any stage on the
 * human-reconciliation obligations and, at final-verification, on the strict
 * completion ladder (R-29, Item b).
 *
 * Wired ADVISORY in Commit 1: `runHookStopGate` still consumes the historical
 * `evaluateStopGate` so the Stop snapshots stay green; the ENFORCE commit switches
 * `runHookStopGate` to this verdict. The mapping is the load-bearing contract the F1
 * property test pins:
 *   - `canCompleteRun.ok === true`                         → `complete`.
 *   - unmet rung AND `stop_hook_active === true`           → `human-yield`.
 *   - unmet rung AND not looping                           → `block`.
 *
 * `renderStopReason` projects the rung's canonical token to the SAME human sentence
 * `th next` emits (Stop and `th next` print identically), so a blocked Stop and a
 * blocked `th next` never disagree on wording.
 */
export function decideStopGate(paths: ProjectPaths, input?: StopHookInput): StopGateVerdict {
  const r = readState(paths);
  // No state.json → no run here → completion is unconstrained (allow).
  if (!r.exists) return { kind: "complete" };
  // Present-but-invalid state is a completion blocker (repair first) — surfaced with a
  // stable token so the verdict is uniform with the rung tokens below.
  if (!r.state) {
    const reason =
      "state.json is present but does NOT validate against the schema; repair it before claiming any stage complete. " +
      (r.issues ?? []).map((i) => `${i.path}: ${i.message}`).join(" ");
    if (input?.stop_hook_active === true) return { kind: "human-yield", token: "invalid_state", reason };
    return { kind: "block", token: "invalid_state", reason };
  }
  const verdict = canCompleteRun(paths, r.state);
  if (verdict.ok) return { kind: "complete" };
  const token = verdict.error ?? "blocked";
  const reason = renderStopReason(token, verdict.detail);
  if (input?.stop_hook_active === true) return { kind: "human-yield", token, reason };
  return { kind: "block", token, reason };
}

/**
 * The subset of the Claude Code Stop-hook stdin payload the gate cares about.
 * `stop_hook_active` is true when Claude is ALREADY continuing because a stop
 * hook blocked — the documented signal for preventing infinite stop loops.
 */
export interface StopHookInput {
  stop_hook_active?: boolean;
  /**
   * The session's project directory, as Claude Code passes it on the hook stdin
   * payload. Used (with the same precedence as PreToolUse) to resolve the SAME
   * project root the write-gate resolves — see {@link resolveHookCwd}. Absent in
   * older payloads; the resolver falls back to `--cwd`/process cwd.
   */
  cwd?: string;
}

/**
 * `th hook stop-gate` — emit a Claude Code Stop-hook decision on stdout from the
 * three-state {@link decideStopGate} verdict (R-29). Always exits 0 (the JSON carries
 * the decision):
 *
 *   - `complete`    → allow ({}).
 *   - `block`       → `{ decision: "block", reason }` — refuse the turn-end. `reason`
 *                     is the token-derived sentence (renderStopReason — identical to
 *                     what `th next` prints for the same rung).
 *   - `human-yield` → allow the stop but surface the unresolved reason as a DISTINCT
 *                     `systemMessage`: the loop-escape (`stop_hook_active === true`)
 *                     means re-blocking forever would spin the model, so the gate
 *                     yields the turn to a human. This is NOT the empty `complete`
 *                     payload — the reason is named so the human sees what is unresolved.
 */
export function runHookStopGate(
  paths: ProjectPaths,
  input?: StopHookInput,
): { stdout: string; exitCode: number } {
  const verdict = decideStopGate(paths, input);
  if (verdict.kind === "complete") {
    return { stdout: JSON.stringify({}), exitCode: 0 };
  }
  const reason = "TwinHarness stop-gate blocked completion: " + (verdict.reason ?? "");
  if (verdict.kind === "human-yield") {
    return {
      stdout: JSON.stringify({
        systemMessage:
          "TwinHarness stop-gate is STILL blocked, but allowed the stop to avoid an infinite loop; " +
          "a human decision is required. " + reason,
      }),
      exitCode: 0,
    };
  }
  // kind === "block"
  return {
    stdout: JSON.stringify({ decision: "block", reason }),
    exitCode: 0,
  };
}

// ---------------------------------------------------------------------------
// CROSS-LANE (F1<->F5) — resolve-from-root hook entry points that CATCH the
// StateLocationConflictError that `resolveProjectPaths` (R-34/F5) throws on a
// both-valid / both-present-but-invalid (no-safe-location) root.
// ---------------------------------------------------------------------------

/**
 * The F1<->F5 fail-open closure. With Phase-1's `canCompleteRun` and Phase-3-F5's
 * valid-state-FILE selection both in-tree, a root with NO valid state must yield a
 * NON-completing verdict — and a root where the state LOCATION is ambiguous (both
 * `.twinharness` and legacy hold valid state, OR both are present-but-invalid) makes
 * `resolveProjectPaths` THROW before any decision function runs. The Stop / SubagentStop
 * hooks resolve paths at their entry, so that throw would otherwise escape as an UNCAUGHT
 * crash (non-zero exit, NO JSON decision) — which a strict hook consumer treats as a
 * fail-OPEN (no block emitted). These wrappers resolve from the root and translate the
 * conflict into the correct fail-safe DECISION instead of crashing:
 *   - Stop / SubagentStop → a `block` (non-completing) — the run may not claim completion
 *     while its state location is unresolvable.
 *   - PreToolUse          → a `deny` (fail-closed) — a write must not slip through while
 *     the governed state location is ambiguous.
 * A non-conflict resolve still succeeds normally; only the typed F5 conflict is mapped.
 */
function resolveOrConflict(
  root: string,
): { paths: ProjectPaths } | { conflict: StateLocationConflictError } {
  try {
    return { paths: resolveProjectPaths(root) };
  } catch (e) {
    if (e instanceof StateLocationConflictError) return { conflict: e };
    throw e; // any other resolve error is a genuine fault — let it surface.
  }
}

/**
 * `th hook stop-gate`, resolving from `root` and CATCHING the F5 location conflict as a
 * BLOCK (cross-lane AC). On a clean resolve it defers to {@link runHookStopGate}.
 */
export function runHookStopGateFromRoot(
  root: string,
  payload?: StopHookInput,
): { stdout: string; exitCode: number } {
  const r = resolveOrConflict(root);
  if ("conflict" in r) {
    return {
      stdout: JSON.stringify({
        decision: "block",
        reason:
          "TwinHarness stop-gate blocked completion: the state LOCATION is ambiguous/unsafe — " +
          r.conflict.message,
      }),
      exitCode: 0,
    };
  }
  return runHookStopGate(r.paths, payload);
}

/**
 * `th hook subagent-stop`, resolving from `root` and CATCHING the F5 location conflict as
 * a BLOCK (cross-lane AC). On a clean resolve it defers to {@link runHookSubagentStop}.
 */
export function runHookSubagentStopFromRoot(
  root: string,
  payload?: SubagentStopHookInput,
): { stdout: string; exitCode: number } {
  const r = resolveOrConflict(root);
  if ("conflict" in r) {
    return {
      stdout: JSON.stringify({
        decision: "block",
        reason:
          "TwinHarness subagent-stop gate blocked: the state LOCATION is ambiguous/unsafe — " +
          r.conflict.message,
      }),
      exitCode: 0,
    };
  }
  return runHookSubagentStop(r.paths, payload);
}

/**
 * `th hook pretool-gate`, resolving from `root` and CATCHING the F5 location conflict as a
 * DENY (fail-closed — a write must not slip through an unresolvable state location). On a
 * clean resolve it defers to {@link runHookPretoolGate}.
 */
export function runHookPretoolGateFromRoot(
  root: string,
  payload?: PreToolHookInput,
  env: NodeJS.ProcessEnv = process.env,
): { stdout: string; exitCode: number } {
  const r = resolveOrConflict(root);
  if ("conflict" in r) {
    // Honor the same global disable hatch the gate itself honors, so the conflict
    // fail-closed never traps an operator who has deliberately disabled the gate.
    if (env["TH_DISABLE_WRITE_GATE"] === "1") {
      return { stdout: JSON.stringify({}), exitCode: 0 };
    }
    return fireGateResult(
      "deny",
      "TwinHarness write-gate (F5 — fail-closed) DENIED this write: the state LOCATION is " +
        "ambiguous/unsafe, so the gate cannot determine which project governs it. " +
        r.conflict.message +
        " Escape hatch (emergency manual override): set env TH_DISABLE_WRITE_GATE=1.",
    );
  }
  return runHookPretoolGate(r.paths, payload, env);
}

/**
 * The subset of the Claude Code SubagentStop-hook stdin payload the gate cares
 * about. `stop_hook_active` is true when a subagent is ALREADY continuing because
 * a SubagentStop hook blocked — the documented signal for preventing infinite
 * stop loops (mirrors the Stop hook's `stop_hook_active`).
 */
export interface SubagentStopHookInput {
  stop_hook_active?: boolean;
  /**
   * The session's project directory (see {@link StopHookInput.cwd}). Resolved
   * with the identical stdin-cwd precedence so PreToolUse / Stop / SubagentStop
   * agree on one project root. Absent in older payloads.
   */
  cwd?: string;
  /**
   * R-36 (F7) — `delegation_id` is the ONLY scope key: the minted `DEL-*` id (`th delegate
   * pack`) the orchestrator threads, so the SubagentStop clears ONLY the stopping
   * delegation's OWN scope (not a peer's). `session_id` / `tool_use_id` are host-supplied
   * provenance the payload may carry; they are NOT scope keys (a scope is filed under the
   * minted id, never a host id) and are NEVER used to clear a scope. When no `delegation_id`
   * is present the clear is a NO-OP (we will NOT clear a peer's scope on an unidentified
   * stop — the crashed/unthreaded-delegate case is covered by TTL recovery instead).
   */
  delegation_id?: string;
  session_id?: string;
  tool_use_id?: string;
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
  // SG3 P1-B (C-11) + R-36 (F7) — a delegated subagent finishing means ITS OWN
  // allowed-files scope no longer applies. Clear ONLY the stopping delegation's scope, and
  // ONLY by its actual key: the minted `DEL-*` `delegation_id` the orchestrator threads.
  // The host `session_id` / `tool_use_id` are NOT scope keys — scopes are filed under the
  // minted id — so using them would `rm` a nonexistent `<session-id>.json` (a clear that
  // clears nothing) while the REAL completed scope lingered, AND could lift an unrelated
  // scope if a host id ever coincided with one. When no `delegation_id` is present (today's
  // installed hook) we DO NOT clear anything (clearing a peer on an unidentified stop is
  // exactly the bug); a crashed/unthreaded delegate's scope self-expires via TTL on the
  // read path instead. Best-effort + ahead of the state read so it lifts even when
  // state.json is absent/invalid.
  const stoppingId = input?.delegation_id;
  if (stoppingId) clearDelegationScope(paths, stoppingId);

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
  /**
   * SG3 P1-B (C-11) — the delegated agent's allowed-files write SCOPE, as emitted by
   * `th delegate pack` (`data.allowedFiles`). When present and non-empty, the gate
   * RESTRICTS writes to this set: a Write/Edit/NotebookEdit (or a parseable Bash write)
   * whose target is in-root but OUTSIDE the set is DENIED before the doc/state allowlist
   * and the phase gates. This is read-scoping (a new injection point), not write-policy:
   * an ABSENT/empty list leaves the historical gating untouched. Paths are root-relative
   * (as `th delegate pack` emitted them); the gate resolves + compares them.
   */
  allowed_files?: string[];
  /**
   * R-36 (F7) — `delegation_id` is the ONLY id the gate keys scope on: the minted
   * per-delegation `DEL-*` key the orchestrator threads onto the subagent's tool calls.
   * When it matches an active per-delegation scope, the gate enforces THAT scope alone
   * (Tier 2). `session_id` / `tool_use_id` are host-supplied provenance the payload may
   * carry; they are NOT scope keys (no scope is filed under a host id) and are NEVER used
   * to select the per-id branch — doing so suppressed the union fail-open this closes. When
   * no `delegation_id` is present (today's installed hook — Tier 1) the gate falls back to
   * the no-id XOR partition: {0 active scopes ⇒ no-op} XOR {>=1 active scope ⇒ UNION
   * enforcement (fail-tighter)}.
   */
  delegation_id?: string;
  session_id?: string;
  tool_use_id?: string;
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
export function bashWriteTargetWasDropped(command: string): boolean {
  // If we already extracted a concrete target, nothing was (entirely) dropped.
  if (extractBashWriteTargets(command).length > 0) return false;
  const SHELL_METACHARS = /[$`*?(){}]/;
  // Redirection / tee / dd-of with a metachar-bearing target.
  const redirect = /(?:>>?)\s*("?)([^\s"'|;&<>]*[$`*?(){}][^\s"'|;&<>]*)\1/;
  const tee = /\btee\b\s+(?:-a\s+)?("?)([^\s"'|;&<>]*[$`*?(){}][^\s"'|;&<>]*)\1/;
  const dd = /\bof=("?)([^\s"'|;&<>]*[$`*?(){}][^\s"'|;&<>]*)\1/;
  if (redirect.test(command) || tee.test(command) || dd.test(command)) return true;
  // sed -i / cp-mv-install-rsync-touch family with a metachar-bearing operand.
  if (/\bsed\b/.test(command) && /\s-i\b/.test(command)) {
    const lastToken = /([^\s"'|;&<>]+)\s*$/.exec(command);
    if (lastToken && lastToken[1] && SHELL_METACHARS.test(lastToken[1])) return true;
  }
  const WRITE_HEADS = new Set(["cp", "mv", "install", "rsync", "touch"]);
  for (const segment of command.split(/[;&|]+/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    const head = tokens[0];
    if (!head || !WRITE_HEADS.has(head)) continue;
    if (tokens.slice(1).some((t) => !t.startsWith("-") && SHELL_METACHARS.test(t))) return true;
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
  // R-13 symmetry: `resolveProjectPaths` canonicalizes `paths.root` (realpath),
  // but the caller resolves `absTarget` against the payload `cwd`, which may be a
  // NON-canonical alias of the same root (macOS /var→/private/var, a Windows 8.3
  // short name like RUNNER~1, a symlinked $TMPDIR, or any junctioned checkout). A
  // lexical `path.relative(canonicalRoot, aliasedTarget)` then yields ".." and the
  // gate reads an in-root write as "outside root" → it stands down and fails OPEN.
  // Canonicalize BOTH sides through the longest-existing-prefix realpath (same
  // mechanism as the root, idempotent when already canonical) so containment never
  // depends on which alias the cwd arrived as.
  const realRoot = realpathExistingPrefix(root);
  const realTarget = realpathExistingPrefix(absTarget);
  const rel = path.relative(realRoot, realTarget);
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
 * SG3 P1-B (C-11) — is `relFwd` (a root-relative, forward-slash target) inside the
 * delegate's declared allowed-files scope? Each `allowed` entry is normalized to a
 * root-relative POSIX path (resolved against `root` so `./x`, backslashes, and
 * redundant segments collapse), then matched as either an EXACT file or a DIRECTORY
 * PREFIX (an entry that is a directory — or written with a trailing "/" — admits every
 * path beneath it). An entry that escapes the root is ignored (it can never match an
 * in-root target). Caller guarantees the list is non-empty before calling.
 */
function isWithinAllowedFiles(relFwd: string, allowed: string[], root: string): boolean {
  for (const entry of allowed) {
    const rel = toRootRelative(path.resolve(root, entry), root);
    if (rel === null || rel.length === 0) continue; // escapes root / empty → cannot match.
    if (relFwd === rel) return true; // exact file match.
    // Directory-prefix match: the entry names a dir (or was written dir-like) and the
    // target lives under it. Compare on a "/"-terminated prefix so "src/a" does not
    // admit "src/abc".
    if (relFwd.startsWith(rel.endsWith("/") ? rel : rel + "/")) return true;
  }
  return false;
}

/**
 * R-02 / R-19 / R-31: is `relFwd` (a root-relative, forward-slash path) one of the
 * EVIDENCE trust anchors under the state dir — the files whose content the completion
 * gate trusts as evidence, so a tool call must NEVER silently forge them:
 *
 *   - `verify.json` / `verify-approvals.jsonl` — authorize which commands
 *     `th verify run` executes (a forged approval would run an injected command).
 *   - `verify-report.json` — the bound verify result the gate reads as "green" (a
 *     forged report would certify a suite that never ran / is red). F2/R-30.
 *   - `tester-record.json` — the live-QA evidence the production-reality gate's 3rd
 *     condition reads (a forged record would fake the mandatory live run). F8/R-31.
 *
 * Renamed from `isVerifyAnchorPath` (R-29): the anchor set now covers the report +
 * tester record, not only the approval config — they are all completion EVIDENCE.
 * Derived from `paths.stateDir`, so it holds for `.twinharness` AND the legacy
 * `.agentic-sdlc`. The SINGLE source of the anchor names, shared by step e2 (file_path
 * Write/Edit) and step c1 (Bash). The legitimate writers are the `th verify` /
 * `th tester record` data layers (atomicWriteFile), never a tool-mediated write.
 */
function isEvidenceAnchorPath(relFwd: string, paths: ProjectPaths): boolean {
  const stateRel = toRootRelative(paths.stateDir, paths.root);
  if (stateRel === null) return false;
  return (
    relFwd === `${stateRel}/verify.json` ||
    relFwd === `${stateRel}/verify-approvals.jsonl` ||
    relFwd === `${stateRel}/verify-report.json` ||
    relFwd === `${stateRel}/tester-record.json`
  );
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
  state: { implementation_allowed: boolean; current_stage: string; write_gate?: string },
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
    // P6-7 (#18) — strict-only honesty signal: no concrete target was found, but the
    // command is write-SHAPED with a metachar/variable-obscured target the matcher
    // had to drop (e.g. `echo x > $f`). Under write_gate=strict we surface this as an
    // `ask` instead of a silent allow, so a human sees the blind spot rather than the
    // gate going quiet. Default modes keep the historical silent allow (M-4 contract).
    if (state.write_gate === "strict" && bashWriteTargetWasDropped(bashCommand)) {
      const reason =
        `TwinHarness write-gate (strict mode — honesty signal) is ASKING about a Bash-mediated write ` +
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

/**
 * §16 ownership classification (#15) — the SINGLE owner-violation predicate shared
 * by both Phase-B gates (the Bash-strict gate and the file_path gate). Given a
 * root-relative path, the slices, and the root, it returns one of:
 *   - `unowned`     — no slice's path-like component owns the path → allow.
 *   - `in-progress` — at least one OWNING slice is in-progress → allow.
 *   - `violation`   — owned ONLY by non-in-progress slices → a §16 component-boundary
 *                     violation to block; carries `ownerSummary` for the reason text.
 * Both gates previously inlined this identical owners→verdict logic; only the
 * `deny` vs `ask` decision and the reason wording stay with each caller.
 */
export type OwnershipVerdict =
  | { kind: "unowned" }
  | { kind: "in-progress" }
  | { kind: "violation"; ownerSummary: string };

export function classifyOwnership(
  relFwd: string,
  slices: Array<{ id: string; status: string; components: string[] }>,
  root: string,
): OwnershipVerdict {
  const owners = findOwningSlices(relFwd, slices, root);
  if (owners.length === 0) return { kind: "unowned" };
  if (owners.some((o) => o.status === "in-progress")) return { kind: "in-progress" };
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
      const verdict = classifyOwnership(relB, state.slices, paths.root);
      if (verdict.kind !== "violation") continue; // unowned in-root path / in-progress owner → allow.
      // Owned only by slices that are not in-progress → component-boundary violation.
      const ownerSummary = verdict.ownerSummary;
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
    const verdict = classifyOwnership(relFwd, state.slices, paths.root);
    if (verdict.kind === "violation") {
      // Owned only by slices that are not in-progress → component-boundary violation.
      const ownerSummary = verdict.ownerSummary;
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

  // SG3 P1-B (C-11) + R-36 (F7) — resolve the EFFECTIVE delegate allowed-files scope this
  // write is constrained to. The installed hook receives only host stdin (no allowed_files),
  // so the persisted per-delegation scopes (`.twinharness/delegation-scopes/<id>.json`, armed
  // by `th delegate pack --allowed-files`) are the actual enforcement source (audit P1). The
  // read GCs any TTL-expired scope (crash recovery). Steps c1c (Bash) and e1 (file_path)
  // below consume `effectiveAllowedFiles`; an EMPTY result is a NO-OP (historical gating
  // untouched).
  //
  // F7 no-id XOR PARTITION (the DECISION — Item 2):
  //   ARM 1: {0 active scopes ⇒ NO-OP, write never gated} — preserves the historical
  //          "An empty union is a no-op (the historical gating is untouched)" verbatim.
  //   ARM 2: {>=1 active scope + no per-delegation id on the payload ⇒ UNION enforcement
  //          (fail-tighter)} — the write is constrained to the union of ALL active scopes,
  //          NOT a no-op (the REJECTED alternative "no-id ⇒ no-op even with active scopes"
  //          would ship F7 as an installed no-op, re-opening the fail-open).
  // When a `delegation_id` DOES match an active scope, the gate enforces THAT scope alone
  // (precise per-id enforcement), which is TIGHTER than the union and is the Tier-2 path a
  // host id unlocks.
  const stdinScope = Array.isArray(input?.allowed_files)
    ? input!.allowed_files.filter((x): x is string => typeof x === "string")
    : [];
  const { active: activeScopes } = readActiveDelegationScopes(paths);
  // The per-WRITER delegation key. ONLY an explicit `delegation_id` (the minted `DEL-*`
  // key the orchestrator threads) counts — NOT the host `session_id` / `tool_use_id`,
  // which every real PreToolUse payload carries and which bear NO relation to a minted
  // scope id. Treating a host id as the writer id was a fail-OPEN: it made `writerId`
  // truthy on every real call, so `ownScope` was always undefined (no scope is keyed by a
  // host id) and the Tier-2 branch returned an EMPTY (unfettered) scope — silently
  // SUPPRESSING the active-scope union for the very delegated writes F7 must constrain.
  // Keying strictly on `delegation_id` restores the no-id XOR: a real payload (no
  // delegation_id) correctly falls to the Tier-1 union (fail-tighter).
  const writerId = input?.delegation_id;
  const ownScope: ActiveDelegationScope | undefined = writerId
    ? activeScopes.find((s) => s.delegationId === writerId)
    : undefined;
  // The base scope this write is constrained to:
  //   • writerId PRESENT (Tier 2 / per-id — an explicit delegation_id): enforce ONLY that
  //     id's scope. A matching id → its allowed-files; an id with NO armed scope → [] (no
  //     constraint). We do NOT fall back to the union here — supplying a delegation_id is
  //     the host asserting "this is the delegation I am", so a non-delegated writer that
  //     names its own (scope-less) id is correctly unfettered (the Tier-2 path that
  //     eliminates the orchestrator-write false-block).
  //   • writerId ABSENT (Tier 1 / no-id XOR — the installed hook, which gets only host ids):
  //     ARM 2 — >=1 active scope ⇒ UNION of ALL active scopes (fail-tighter); ARM 1 — 0
  //     active scopes ⇒ [] (the historical no-op, verbatim).
  // stdin allowed_files (a host directly declaring THIS call's scope) always unions in.
  const baseScope = writerId
    ? (ownScope?.allowedFiles ?? []) // Tier 2: this id's own scope only (empty ⇒ unfettered).
    : activeScopes.flatMap((s) => s.allowedFiles); // Tier 1: [] (ARM 1) or union (ARM 2).
  const effectiveAllowedFiles = [...new Set([...stdinScope, ...baseScope])];

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
      if (relC1 !== null && isEvidenceAnchorPath(relC1, paths)) {
        const reason =
          `TwinHarness write-gate (R-19/R-31) hard-blocked a Bash-mediated write to a completion-evidence anchor (${relC1}). ` +
          `This file is evidence the completion gate trusts (verify approval/config, the verify report, or the live-QA Tester record); a shell redirection (echo/tee/sed >) could forge it around the gate. ` +
          `There is NO legitimate Bash writer of this file — use \`th verify add\`/\`th verify approve\`/\`th verify run\` or \`th tester record\` (the governed writers) instead. ` +
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
      if (relC1b === null) continue; // outside root → not our concern
      const matched = matchApprovedArtifact(state.approved_artifacts, paths.root, absC1b);
      if (matched) {
        const reason =
          `TwinHarness write-gate held this write for confirmation (R-24 — approved-artifact overwrite via Bash). ` +
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
      if (relC1c === null) continue; // outside root → not in scope to deny here.
      if (!isWithinAllowedFiles(relC1c, allowedFilesC1c, paths.root)) {
        const reason =
          `TwinHarness write-gate (C-11 — delegate scope) DENIED a Bash-mediated write: ${relC1c} is OUTSIDE the delegated agent's allowed-files scope. ` +
          `This delegate was packed with an explicit allowed-files set (${allowedFilesC1c.join(", ")}); a shell redirection cannot escape it any more than a Write/Edit can. ` +
          `AGENT INSTRUCTION: do NOT retry — write only within your allowed scope, or escalate to widen the delegation. ` +
          `Escape hatch (emergency manual override): set env TH_DISABLE_WRITE_GATE=1.`;
        return fireGate("deny", reason);
      }
    }
  }

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
    const reason =
      `TwinHarness write-gate (C-11 — delegate scope) DENIED this write: ${relFwd} is OUTSIDE the delegated agent's allowed-files scope. ` +
      `This delegate was packed with an explicit allowed-files set (${allowedFiles.join(", ")}); writes outside it are refused. ` +
      `AGENT INSTRUCTION: do NOT retry — write only within your allowed scope, or escalate to the human to widen the delegation (\`th delegate pack ... --allowed-files <list>\`). ` +
      `Escape hatch (emergency manual override): set env TH_DISABLE_WRITE_GATE=1.`;
    return fireGate("deny", reason);
  }

  // Step e2 (R-02/R-31): the completion-EVIDENCE trust anchors are NEVER silently
  // writable by a tool call. A direct Write/Edit to verify.json, verify-approvals.jsonl,
  // verify-report.json, or tester-record.json is the "forge the evidence around the
  // gate" vector — those records authorize which commands `th verify run` executes, or
  // ARE the green report / live-QA record the completion gate reads. Gate it in BOTH
  // phases (ask by default, deny under deny/strict), ahead of the doc/state allowlist
  // that otherwise blanket-allows the whole state dir. Derived from paths.stateDir so it
  // holds for `.twinharness` and the legacy `.agentic-sdlc`. The CLI/MCP `th verify` /
  // `th tester record` data layers write these through atomicWriteFile (not a tool
  // call), so legitimate flows are unaffected. Shares isEvidenceAnchorPath with step c1
  // (R-19) — the single source of the anchor names.
  if (isEvidenceAnchorPath(relFwd, paths)) {
    const reason =
      `TwinHarness write-gate gated a direct write to a completion-evidence anchor (${relFwd}). ` +
      `This file is evidence the completion gate trusts (verify approval/config, the verify report, or the live-QA Tester record); a direct tool write could forge it. ` +
      `Use the governed writers (\`th verify add\`/\`th verify approve\`/\`th verify run\`, or \`th tester record\`) instead of editing the file. ` +
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
  const matched = matchApprovedArtifact(state.approved_artifacts, paths.root, absTarget);
  if (matched) {
    const reason =
      `TwinHarness write-gate held this write for confirmation (R-14 — approved-artifact overwrite). ` +
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

// ---------------------------------------------------------------------------
// Context-pages OBSERVE-only hook handlers (S0)
//
// S0 = record everything, suppress nothing, change no externally visible
// behavior.  Every handler here MUST:
//   1. Check TH_DISABLE_CONTEXT_PAGES=1 → pure passthrough.
//   2. Wrap its body in a fail-safe try/catch → passthrough on any error.
//   3. Return the original tool output unchanged (exit 0).
// ---------------------------------------------------------------------------

/** Passthrough result emitted by all new OBSERVE handlers: `{}` + exit 0. */
function contextPassthrough(): { stdout: string; exitCode: number } {
  return { stdout: JSON.stringify({}), exitCode: 0 };
}

// ---------------------------------------------------------------------------
// S1 — reduction footer (PF-iii)
// ---------------------------------------------------------------------------

/**
 * Options for building a context-reduction footer (PF-iii).
 * The footer must appear at the END of reduced or large-FULL content so it
 * lands on the model-visible (last) chunk when output is split at ~10 K chars.
 */
export interface FooterOpts {
  kind: "exact" | "normalized" | "lossy";
  page_id: string;
  base_hash?: string;
  current_hash: string;
  omitted_tokens: number;
  raw_objref?: string | null;
}

/**
 * Build the reduction footer block.  Appended to the END of every reduced
 * or large-FULL delivery so it always survives 10 K chunking (PF-iii).
 *
 * The block is delimited with `--- th-context-reduction ---` so the model and
 * future tooling can locate it deterministically.  The `rehydrate:` line
 * provides the literal CLI command that restores full content.
 */
export function reductionFooter(opts: FooterOpts): string {
  const short = (h: string | undefined | null): string => (h ? h.slice(0, 12) : "");
  const lines: string[] = [
    "--- th-context-reduction ---",
    `kind: ${opts.kind}`,
    `page_id: ${opts.page_id}`,
    ...(opts.base_hash ? [`base: ${short(opts.base_hash)}`] : []),
    `current: ${short(opts.current_hash)}`,
    `omitted_tokens: ${opts.omitted_tokens}`,
    ...(opts.raw_objref ? [`raw_objref: ${short(opts.raw_objref)}`] : []),
    `rehydrate: th context rehydrate ${opts.page_id}`,
    "---",
  ];
  return "\n" + lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// S1 — capability probe (5b / D-18)
// ---------------------------------------------------------------------------

interface CapabilityRecord {
  /** "A" = updatedToolOutput (transcript-confirmed); "B" = systemMessage (default). */
  mode: "A" | "B";
  /** session_id when Mode A was confirmed — re-confirm when the session changes. */
  session_id: string;
  confirmed_at: string;
  confirmed_tool_use_id?: string;
}

function capabilityFilePath(paths: ProjectPaths): string {
  return path.join(contextPagesRoot(paths), "capability.json");
}

/**
 * Read the cached delivery-mode choice.  Returns "B" (systemMessage, default)
 * when capability.json is absent, malformed, or the session_id has changed
 * (re-confirm once per session before the first Mode-A ATTEST — 5b/D-18).
 */
function readCapabilityMode(paths: ProjectPaths, currentSessionId?: string): "A" | "B" {
  try {
    const p = capabilityFilePath(paths);
    if (!fs.existsSync(p)) return "B";
    const rec = JSON.parse(fs.readFileSync(p, "utf8")) as CapabilityRecord;
    if (rec.mode !== "A") return "B";
    // Re-confirm required when the session has changed.
    if (currentSessionId && rec.session_id && rec.session_id !== currentSessionId) return "B";
    return "A";
  } catch {
    return "B";
  }
}

/**
 * Persist a capability mode confirmation.  Mode A (updatedToolOutput) requires a
 * transcript-confirmed no-op rewrite before it is cached.  Exported so the surfaces
 * layer (`th context probe`) can write the confirmation after verification.
 */
export function writeCapabilityMode(
  paths: ProjectPaths,
  mode: "A" | "B",
  sessionId: string,
  confirmedToolUseId?: string,
): void {
  try {
    const rec: CapabilityRecord = {
      mode,
      session_id: sessionId,
      confirmed_at: new Date().toISOString(),
      ...(confirmedToolUseId ? { confirmed_tool_use_id: confirmedToolUseId } : {}),
    };
    const p = capabilityFilePath(paths);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(rec), "utf8");
  } catch {
    // fail-safe: capability.json write errors never propagate
  }
}

// ---------------------------------------------------------------------------
// S1 — PF-i ledger-append seam (test-only injection)
// ---------------------------------------------------------------------------

type LedgerAppendFn = typeof appendLedgerRecord;

/**
 * Module-level override for appendLedgerRecord, used ONLY in PF-i tests to
 * simulate ATTEST write failures without OS-level file tricks.  Never set in
 * production — the default is null (real implementation).
 */
let _appendOverride: LedgerAppendFn | null = null;

/**
 * Test-only: inject a custom appendLedgerRecord implementation and return a
 * teardown function that restores the real one.
 * @internal
 */
export function _setAppendLedgerOverride(fn: LedgerAppendFn | null): () => void {
  _appendOverride = fn;
  return () => { _appendOverride = null; };
}

/** Dispatch to the real or injected ledger append. */
function doAppendLedger(
  ...args: Parameters<LedgerAppendFn>
): ReturnType<LedgerAppendFn> {
  return (_appendOverride ?? appendLedgerRecord)(...args);
}

// ---------------------------------------------------------------------------
// resolveScope — POSITIVE-only scope attribution (B3 / M4)
// ---------------------------------------------------------------------------

/**
 * Discriminated union returned by {@link resolveScope}.  Only `agent` and
 * `root` carry a usable {@link LedgerScope}; `indeterminate` must never be
 * attributed to the root shard.
 */
export type ScopeResolution =
  | { kind: "agent"; scope: LedgerScope }
  | { kind: "root"; scope: LedgerScope }
  | { kind: "indeterminate" };

/**
 * Resolve the ledger scope for a hook input payload.  POSITIVE-only: we only
 * claim a scope when the evidence is unambiguous.
 *
 *   agent_id present              → `agent` scope (agentOrRoot = agent_id).
 *   session_id only, no agent_id  → `root` scope  (agentOrRoot = "root").
 *   neither present               → `indeterminate` (no shard written).
 *
 * SubagentStart/Stop depth is for epoch/probe purposes ONLY — it is NOT used
 * for per-tool scope attribution here (brief B3/M4).
 */
export function resolveScope(input: {
  session_id?: string;
  agent_id?: string;
}): ScopeResolution {
  if (input.agent_id) {
    const session_id = input.session_id ?? "unknown";
    return { kind: "agent", scope: { session_id, agentOrRoot: input.agent_id } };
  }
  // IMPORTANT — B3/P2 "Phantom Root" gate.
  // A bare session_id with no agent_id is mapped to `root` so the event is still
  // recorded for OBSERVE (the default, suppression-free mode). This attribution
  // is NOT positive proof of root identity: a subagent tool result that arrived
  // without an agent_id (possibly sharing the root session_id) would land in the
  // root shard too. To prevent that phantom record from ever omitting real root
  // output, the S1 suppression path hard-requires `kind === "agent"` (see the
  // suppression gate in runHookPostToolContext) — so `root` scope is recorded but
  // NEVER suppressed. Promoting `root` to a suppressible scope requires
  // positively establishing root identity first (a CONFIRMED-distinct root
  // session_id verified against epoch.json / SubagentStart probe counters); until
  // that probe-gate is wired, root suppression stays off by construction. Do NOT
  // relax the agent-only suppression gate before that work lands.
  if (input.session_id) {
    return { kind: "root", scope: { session_id: input.session_id, agentOrRoot: "root" } };
  }
  return { kind: "indeterminate" };
}

// ---------------------------------------------------------------------------
// PostToolUse OBSERVE handler (D-08)
// ---------------------------------------------------------------------------

/**
 * Subset of the Claude Code PostToolUse stdin payload we observe.
 * `tool_response` is tool-specific: some built-ins return strings, while Bash
 * and newer Claude Code tool events return structured objects.
 */
export interface PostToolContextInput {
  session_id?: string;
  agent_id?: string;
  agent_type?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  cwd?: string;
}

function canonicalResponseJson(value: unknown): string {
  if (value === undefined) return "";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalResponseJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalResponseJson(record[k])}`)
    .join(",")}}`;
}

function contentBlockText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const chunks: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      chunks.push(item);
      continue;
    }
    if (typeof item === "object" && item !== null) {
      const rec = item as Record<string, unknown>;
      if (typeof rec.text === "string") chunks.push(rec.text);
    }
  }
  return chunks.length > 0 ? chunks.join("\n") : undefined;
}

function extractToolResponseText(tool_name: string, tool_response: unknown): string {
  if (typeof tool_response === "string") return tool_response;
  if (tool_response === undefined || tool_response === null) return "";
  if (typeof tool_response !== "object") return String(tool_response);

  const rec = tool_response as Record<string, unknown>;
  if (tool_name.toLowerCase() === "bash") {
    const stdout = typeof rec.stdout === "string" ? rec.stdout : "";
    const stderr = typeof rec.stderr === "string" ? rec.stderr : "";
    return [stdout, stderr].filter((s) => s.length > 0).join("\n");
  }

  const blockText = contentBlockText(rec.content);
  if (blockText !== undefined) return blockText;

  for (const key of ["text", "content", "output", "result", "message", "stdout", "stderr"]) {
    const value = rec[key];
    if (typeof value === "string") return value;
  }

  return canonicalResponseJson(tool_response);
}

/** Map a Claude Code tool name to a ContextPage SourceKind + locator parts. */
function resolveToolPage(
  tool_name: string,
  tool_input: Record<string, unknown>,
): { source_kind: SourceKind; parts: Record<string, unknown>; source_locator: string } | null {
  const tn = tool_name.toLowerCase();
  if (tn === "read") {
    const p = String(tool_input.file_path ?? "");
    return { source_kind: "file", parts: { path: p }, source_locator: p };
  }
  if (tn === "glob") {
    const pattern = String(tool_input.pattern ?? "");
    const dir = String(tool_input.path ?? "");
    return {
      source_kind: "search",
      parts: { tool: "Glob", query: pattern, cwd: dir },
      source_locator: `Glob|${pattern}`,
    };
  }
  if (tn === "grep") {
    const pattern = String(tool_input.pattern ?? "");
    const dir = String(tool_input.path ?? "");
    return {
      source_kind: "search",
      parts: { tool: "Grep", query: pattern, cwd: dir },
      source_locator: `Grep|${pattern}`,
    };
  }
  if (tn === "bash") {
    const cmd = String(tool_input.command ?? "");
    return {
      source_kind: "bash",
      parts: { argv: cmd },
      source_locator: cmd,
    };
  }
  if (tn === "webfetch") {
    const url = String(tool_input.url ?? "");
    return {
      source_kind: "search",
      parts: { tool: "WebFetch", query: url },
      source_locator: `WebFetch|${url}`,
    };
  }
  if (tool_name.includes("__")) {
    // mcp__<server>__<op> pattern
    // The params land in `logical_key` (via normalizeLocator), so they MUST be
    // reachable by the secret scan, which only inspects `source_locator` and the
    // response. Serialize them into the locator so an inline secret in tool_input
    // (e.g. an api_key arg) is detected and the page is classified sensitive —
    // otherwise the raw key would be written into ledger-*.jsonl. (#2 / AC-7 / R2)
    let paramsRepr = "";
    try {
      paramsRepr = JSON.stringify(tool_input ?? {});
    } catch {
      paramsRepr = "";
    }
    return {
      source_kind: "mcp",
      parts: { tool: tool_name, params: tool_input },
      source_locator: `${tool_name}|${paramsRepr}`,
    };
  }
  return null;
}

/**
 * `th hook posttool-context` — OBSERVE the PostToolUse payload, record a
 * deliver ledger entry + telemetry, then return the original output unchanged.
 *
 * Fail-safe: any error → passthrough (exit 0, original output preserved).
 * Kill-switch: `TH_DISABLE_CONTEXT_PAGES=1` → pure passthrough, no I/O.
 */
export function runHookPostToolContext(
  root: string,
  input?: PostToolContextInput,
  env: NodeJS.ProcessEnv = process.env,
): { stdout: string; exitCode: number } {
  if (env["TH_DISABLE_CONTEXT_PAGES"] === "1") return contextPassthrough();
  try {
    const toolName = input?.tool_name ?? "";
    const toolInput = input?.tool_input ?? {};
    const toolResponse = extractToolResponseText(toolName, input?.tool_response);

    if (!toolName || !toolResponse) return contextPassthrough();

    if (input?.agent_id) probeAgentIdPresentOnToolHook();

    const resolved = resolveToolPage(toolName, toolInput);
    if (!resolved) return contextPassthrough();

    const r = resolveOrConflict(root);
    if ("conflict" in r) return contextPassthrough();
    const { paths } = r;

    const { source_kind, parts, source_locator } = resolved;
    const logical_key = normalizeLocator(source_kind, parts);
    const content_hash = hashContent(toolResponse);
    const now = new Date().toISOString();
    const scopeRes = resolveScope(input ?? {});

    const pageBase = {
      schema_version: CONTEXT_PAGE_SCHEMA_VERSION,
      source_kind,
      logical_key,
      content_hash,
    };
    const page_id = computePageId(pageBase);

    const pageLike = { source_locator, source_kind };
    const sensitive = classifySensitive(pageLike, paths, toolResponse);

    // #4: privacy-by-default. The on-by-default OBSERVE hook does NOT persist raw
    // tool output to the plaintext cold store — only the content hash is kept (in
    // the ledger). Raw bytes are written only when a consumer needs them: exact
    // suppression (to rehydrate) or an explicit TH_CONTEXT_RAW_STORE opt-in.
    const persistRaw = rawColdStoreEnabled(env);
    const raw_objref = coldStorePut(paths, toolResponse, sensitive, { persistRaw });

    // #5: when raw storage is active the cold store grows, so opportunistically
    // enforce the size/age caps here. Throttled to ≤ once/hour via a marker, and
    // skipped entirely on the default (metadata-only) path, so the common case
    // adds no filesystem work beyond the (skipped) cold-store write.
    if (persistRaw && !sensitive) {
      maybeEnforceColdStoreRetention(paths, coldStoreCaps(env));
    }

    const reduction_kind: ReductionKind = sensitive ? "hash-only" : "FULL";
    const session_id = input?.session_id ?? "";
    const agent_id = input?.agent_id ?? "";
    const agent_type = input?.agent_type ?? "";
    const est = estimateTokens(toolResponse);

    // A4 (Savings UI): classify the workload ONCE at write time, threading the
    // raw Bash command (in scope only here) into the classifier and then
    // discarding it — the command text is NEVER persisted onto a telemetry
    // record (privacy by construction). Only the resulting 8-value category is
    // stored, alongside `source_kind`/`content_hash`/`schema_version`, so the
    // read-time savings calc can attribute savings without the command. No
    // `lossy` marker is set here: these posttool deliveries are FULL/hash-only,
    // never a disclosed lossy reduction.
    const command = source_kind === "bash" ? String(toolInput.command ?? "") : undefined;
    const workload_category = classify({
      tool_type: toolName,
      source_kind,
      reduction_kind,
      command,
    });

    // M2b (AC-7 / R2): for sensitive pages, never write the raw logical_key
    // into ledger-*.jsonl — substitute its short hash.  Sensitive pages are
    // always FULL (never used for residency matching), so the redacted form
    // carries no cost to correctness; it keeps inline secrets off disk.
    const ledger_logical_key = sensitive ? shortHash(logical_key) : logical_key;

    // S1 — residency check BEFORE writing any ledger record (non-sensitive only).
    // Sensitive pages are always FULL and are never resident-matched for suppression.
    const epochRec = currentEpoch(paths);
    const exactSuppressOn = env["TH_EXACT_SUPPRESS"] === "1";
    let isResident = false;

    if (scopeRes.kind !== "indeterminate" && !sensitive) {
      try {
        // F1: bounded tail read instead of a full O(N) shard read on every
        // PostToolUse. deriveResidency only matches records within the
        // RESIDENCY_TTL_TURNS window, so reading the recent tail cannot change
        // residency outcomes for any realistic shard. The limit is set well
        // above the TTL window (×8, floored at 256) to absorb interleaved
        // non-eligible ops and concurrent-agent records within the window.
        const RESIDENCY_TAIL_LIMIT = Math.max(RESIDENCY_TTL_TURNS * 8, 256);
        const shardRecs = readShardRecordsTail(paths, scopeRes.scope, RESIDENCY_TAIL_LIMIT);
        // nowTurn MUST be the ABSOLUTE ledger sequence of the most recent record
        // — NOT the tail length. The tail reader returns at most
        // RESIDENCY_TAIL_LIMIT records, so on a large shard `shardRecs.length`
        // (≤256) can sit far below the real seq values (e.g. seq≈1000). Using the
        // length yields `nowTurn - record.seq = 256 - 1000 = -744`, a negative age
        // that is never greater than RESIDENCY_TTL_TURNS, so an expired page would
        // incorrectly remain resident. deriveResidency computes
        // `age = nowTurn - record.seq`, so nowTurn has to live in the same
        // absolute-seq space as record.seq. Records are returned in append order
        // (ascending seq) and the tail always includes the newest record, so the
        // last element carries the max seq. (#1)
        const nowTurn =
          shardRecs.length > 0 ? shardRecs[shardRecs.length - 1]!.seq : 0;
        const residency = deriveResidency(
          shardRecs,
          scopeRes.scope,
          ledger_logical_key,
          content_hash,
          epochRec.epoch,
          nowTurn,
        );
        isResident = residency.resident;
      } catch {
        isResident = false; // fail-safe: check error → treat as not resident
      }
    }

    // PF-i: suppress path — exact_suppress ON and page is resident.
    // Record ATTEST first; on write failure → return original output, NO attest written.
    //
    // B3/P2 "Phantom Root" gate: suppression is restricted to a POSITIVELY
    // attributed `agent` scope (one that carried an explicit agent_id). A bare
    // session_id maps to `root` for OBSERVE recording, but the root shard can be
    // contaminated by a subagent tool result that arrived without an agent_id
    // (and may even share the root session_id). Such a phantom record could make
    // the real root "resident" and omit content the root never actually saw.
    // Agent shards are keyed by an explicit agent_id, so they can ONLY contain
    // that agent's own deliveries and are immune to phantom contamination —
    // making `agent`-scoped suppression provably free of cross-agent omission.
    // Root suppression stays disabled until root identity can be positively
    // established by the probe-gate (see resolveScope). (#2)
    if (exactSuppressOn && isResident && scopeRes.kind === "agent") {
      let attestOk = false;
      try {
        doAppendLedger(paths, scopeRes.scope, {
          seq: 0,
          ts: now,
          session_id,
          agent_id,
          agent_type,
          epoch: epochRec.epoch,
          op: "attest" as const,
          page_id,
          logical_key: ledger_logical_key,
          content_hash,
          base_hash: undefined,
          complete: true,
          est_tokens: est,
          reduction_kind,
        });
        attestOk = true;
      } catch {
        attestOk = false;
      }

      if (!attestOk) {
        // PF-i: write failed → return original output (no suppression occurred)
        recordTelemetry(paths, {
          schema_version: TELEMETRY_SCHEMA_VERSION,
          ts: now,
          session_id,
          agent_id: input?.agent_id,
          epoch: epochRec.epoch,
          tool_type: toolName,
          workload_category,
          source_kind,
          content_hash,
          tier: "s1",
          stage: "attest",
          page_id,
          orig_tokens: est,
          returned_tokens: est,
          dup_detected: true,
          dup_avoided: false,
          delta_tokens: 0,
          verification_outcome: "attest_fail",
          reduction_kind,
        });
        void raw_objref;
        return contextPassthrough();
      }

      // Attest succeeded → emit reduced replacement (Mode A or Mode B).
      const mode = readCapabilityMode(paths, session_id);
      const footer = reductionFooter({
        kind: "exact",
        page_id,
        current_hash: content_hash,
        omitted_tokens: est,
        raw_objref,
      });
      const reduced = `[th-context: exact match — content omitted]${footer}`;

      recordTelemetry(paths, {
        schema_version: TELEMETRY_SCHEMA_VERSION,
        ts: now,
        session_id,
        agent_id: input?.agent_id,
        epoch: epochRec.epoch,
        tool_type: toolName,
        workload_category,
        source_kind,
        content_hash,
        tier: "s1",
        stage: "attest",
        page_id,
        orig_tokens: est,
        returned_tokens: estimateTokens(reduced),
        dup_detected: true,
        dup_avoided: true,
        delta_tokens: est - estimateTokens(reduced),
        verification_outcome: "ok",
        reduction_kind: "hash-only",
      });

      void raw_objref;
      if (mode === "A") {
        return { stdout: JSON.stringify({ updatedToolOutput: reduced }), exitCode: 0 };
      }
      // Mode B default: systemMessage route (D-18 — until transcript-confirmed)
      return {
        stdout: JSON.stringify({ systemMessage: `[th-context] ${reduced}` }),
        exitCode: 0,
      };
    }

    // Shadow mode OR not resident: deliver as normal (S0 behavior preserved).
    // In shadow mode with a resident page: log would-suppress telemetry but deliver FULL.
    // Mirror the real suppression gate above (agent-scope only): a resident root
    // page would NOT be suppressed even with the flag on, so it is not a
    // would-suppress candidate either. (#2)
    const wouldSuppress = !exactSuppressOn && isResident && scopeRes.kind === "agent";

    if (scopeRes.kind !== "indeterminate") {
      doAppendLedger(paths, scopeRes.scope, {
        seq: 0,
        ts: now,
        session_id,
        agent_id,
        agent_type,
        epoch: epochRec.epoch,
        op: "deliver" as const,
        page_id,
        logical_key: ledger_logical_key,
        content_hash,
        base_hash: undefined,
        complete: true,
        est_tokens: est,
        reduction_kind,
      });
    }

    recordTelemetry(paths, {
      schema_version: TELEMETRY_SCHEMA_VERSION,
      ts: now,
      session_id,
      agent_id: input?.agent_id,
      epoch: epochRec.epoch,
      tool_type: toolName,
      workload_category,
      source_kind,
      content_hash,
      tier: "s0",
      stage: "deliver",
      slice: "s0",
      page_id,
      orig_tokens: est,
      returned_tokens: est,
      dup_detected: isResident,
      dup_avoided: false,
      delta_tokens: 0,
      full_rehydrations: 0,
      compaction_resets: 0,
      parent_pages: 0,
      child_pages: 0,
      assumed_resident_misses: 0,
      verification_outcome: wouldSuppress ? "would_suppress" : "ok",
      turns: 0,
      retries: 0,
      runtime_ms: 0,
      reduction_kind,
    });

    void raw_objref; // acknowledged: used in the page record (future slices)
    return contextPassthrough();
  } catch {
    // Fail-safe: any error → passthrough, exit 0
    return contextPassthrough();
  }
}

// ---------------------------------------------------------------------------
// SessionStart OBSERVE handler (D-15)
// ---------------------------------------------------------------------------

/**
 * Subset of the Claude Code SessionStart stdin payload we observe.
 */
export interface SessionContextInput {
  session_id?: string;
  agent_id?: string;
  agent_type?: string;
  cwd?: string;
}

/**
 * `th hook session-context` — S0 OBSERVE entry for SessionStart.
 *
 * At S0: records the SubagentStart probe counter when agent_id is present;
 * epoch read/reconcile is a no-op stub (epoch tracking begins in S1+).
 * Returns `{}` (no capsule injection at S0 — minimal/empty per brief D-15).
 *
 * Fail-safe: any error → passthrough (exit 0).
 * Kill-switch: `TH_DISABLE_CONTEXT_PAGES=1` → pure passthrough.
 */
export function runHookSessionContext(
  root: string,
  input?: SessionContextInput,
  env: NodeJS.ProcessEnv = process.env,
): { stdout: string; exitCode: number } {
  if (env["TH_DISABLE_CONTEXT_PAGES"] === "1") return contextPassthrough();
  try {
    // Probe: SubagentStart fired (agent_id is present in a session-context payload)
    if (input?.agent_id) {
      probeSubagentStartFired();
    }

    // S1: Session epoch reconcile — detect new session_id, bump epoch if changed.
    const session_id = input?.session_id ?? "";
    if (root && session_id) {
      const r = resolveOrConflict(root);
      if (!("conflict" in r)) {
        const { paths } = r;
        maybeCheckEpoch(paths, "session_start", { session_id });

        // R7: Post-compact eager rehydrate — inject capsule when the epoch reason
        // is "SessionStart{compact}" (set by runHookPrecompactSeal).
        // Default OFF (shadow); only fires when TH_EXACT_SUPPRESS=1.
        const exactSuppressOn = env["TH_EXACT_SUPPRESS"] === "1";
        if (exactSuppressOn) {
          const epochRec = currentEpoch(paths);
          if (epochRec.reason === "SessionStart{compact}") {
            try {
              const stateResult = readState(paths);
              if (stateResult.state) {
                const tier = String(
                  (stateResult.state as unknown as Record<string, unknown>)["tier"] ?? "unclassified",
                );
                const stage = stateResult.state.current_stage;
                const capsule = capsuleFromState(stateResult.state, tier, stage, {
                  epoch: epochRec.epoch,
                });
                const msg =
                  `[th-context post-compact rehydrate epoch=${epochRec.epoch}]\n` +
                  JSON.stringify(capsule, null, 2);

                // A2 (Savings UI): this R7 host path is the AUTHORITATIVE
                // rehydration-payback emitter — it actually re-serves full tokens
                // back into context post-compact, offsetting earlier suppression
                // credit. The dispatcher `handleRehydrate` stays a pure query and
                // does NOT emit (avoids the parity-test double-write). Idempotency
                // is on (page_id, epoch, content_hash); `content_hash` of the
                // re-served capsule lets the consumer subtract a repeated
                // post-compact rehydrate of the same epoch only once. Fail-safe:
                // wrapped in the surrounding try/catch (recordTelemetry also
                // swallows its own I/O errors).
                recordTelemetry(paths, {
                  schema_version: TELEMETRY_SCHEMA_VERSION,
                  ts: new Date().toISOString(),
                  session_id,
                  epoch: epochRec.epoch,
                  workload_category: "rehydration",
                  content_hash: hashContent(msg),
                  rehydrated_full_tokens: estimateTokens(msg),
                });
                return { stdout: JSON.stringify({ systemMessage: msg }), exitCode: 0 };
              }
            } catch {
              // fail-safe: capsule build errors → passthrough
            }
          }
        }
      }
    }

    return contextPassthrough();
  } catch {
    return contextPassthrough();
  }
}

// ---------------------------------------------------------------------------
// PrecompactSeal handler (S6 — bump epoch before context-window compaction)
// ---------------------------------------------------------------------------

/**
 * Subset of the PreCompact hook stdin payload this handler observes.
 */
export interface PrecompactSealInput {
  session_id?: string;
  cwd?: string;
}

/**
 * `th hook precompact-seal` — fired when Claude Code is about to auto-compact
 * the context window.
 *
 * Bumps the epoch (reason = "SessionStart{compact}") so that all prior-epoch
 * residency claims are invalidated on the next SessionStart (AC-4).  The next
 * call to `runHookSessionContext` detects that reason and injects the post-
 * compact eager-rehydrate capsule (R7).
 *
 * S6 TODO: also seal the active stage manifest when T6 integration lands.
 *
 * Fail-safe: any error → passthrough (D-16).
 * Kill-switch: TH_DISABLE_CONTEXT_PAGES=1 → pure passthrough.
 */
export function runHookPrecompactSeal(
  root: string,
  input?: PrecompactSealInput,
  env: NodeJS.ProcessEnv = process.env,
): { stdout: string; exitCode: number } {
  if (env["TH_DISABLE_CONTEXT_PAGES"] === "1") return contextPassthrough();
  try {
    const r = resolveOrConflict(root);
    if ("conflict" in r) return contextPassthrough();
    const { paths } = r;

    // Bump epoch — invalidates all prior residency claims (AC-4 / R7).
    // The reason "SessionStart{compact}" signals runHookSessionContext to inject
    // an eager-rehydrate capsule on the subsequent SessionStart.
    const compactedEpoch = bumpEpoch(paths, "SessionStart{compact}");

    // A3 (Savings UI): emit ONE compaction record (stop relying on the literal
    // `compaction_resets: 0` written at the deliver site). Idempotency key is
    // (session_id, epoch): `bumpEpoch` makes the epoch unique per compaction, so
    // this path emits at most one record per distinct (session_id, epoch). The
    // pending S1+ runtime promotion OWNS the increment when active — it will emit
    // the canonical compaction record for that key, and the read-time consumer
    // dedups on (session_id, epoch), so this A3 emit is effectively a no-op once
    // the promotion path is live. Fail-safe: recordTelemetry swallows I/O errors.
    recordTelemetry(paths, {
      schema_version: TELEMETRY_SCHEMA_VERSION,
      ts: new Date().toISOString(),
      session_id: input?.session_id ?? "",
      epoch: compactedEpoch,
      workload_category: "compaction",
      compaction_resets: 1,
    });

    // S6 TODO: sealActiveManifest(paths, input?.session_id);
    void input;

    return contextPassthrough();
  } catch {
    // Fail-safe: bump failure never blocks the compact (D-16).
    return contextPassthrough();
  }
}
