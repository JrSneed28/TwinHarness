/**
 * TwinHarness MCP server — a THIN stdio adapter over the existing `th` command
 * handlers (Phase 4).
 *
 * Why this exists: the Orchestrator coordinates the run by calling `th`. Over raw
 * Bash that means string-munging argv and parsing stdout. This server exposes a
 * TYPED subset of the same handlers as MCP tools so the Orchestrator can call
 * them structurally (typed inputs + structured results) instead.
 *
 * Boundary rules this file obeys:
 *  - It is an ADAPTER, not a re-implementation. Every tool builds `ProjectPaths`
 *    and calls the SAME pure `run*(paths, …)` function the CLI dispatches to. No
 *    command logic lives here; state mutations still serialize under the
 *    cross-process lock inside those handlers.
 *  - It does NOT modify the CLI. `dist/cli.js` stays hand-written and SDK-free;
 *    only this file (bundled into `dist/mcp-server.js` by esbuild) carries the
 *    `@modelcontextprotocol/sdk` dependency. The zero-runtime-dependency CLI
 *    guarantee is therefore intact.
 *  - It exposes a MINIMAL set: the coordination/observability commands the
 *    Orchestrator needs. Destructive `init`/`migrate` and hook gates are
 *    deliberately EXCLUDED; the safe idempotent `th_init` IS exposed (no force
 *    over MCP — destructive re-init is CLI/human-only); hook gates remain excluded.
 *
 * The project root is taken from `CLAUDE_PROJECT_DIR` (set by Claude Code for an
 * enabled plugin's MCP server) and falls back to `process.cwd()`.
 *
 * Testability: the CommandResult→MCP mapping (`toToolResult`) and the tool
 * registry (`TOOL_DEFS`) are exported pure values so the adapter can be
 * unit-tested directly, without a socket or a live transport.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import * as fs from "node:fs";
import * as path from "node:path";

import { resolveProjectPaths, isAbsoluteOrEscaping, StateLocationConflictError, type ProjectPaths } from "./core/paths";
import { type CommandResult, failure } from "./core/output";

import { runStateGet, runStateSet, applyGateMutation } from "./commands/state";
import { runDriftAdd, runDriftList, runDriftResolve } from "./commands/drift";
import { runSimAdd, runSimList, runSimRetire, runSimScan } from "./commands/sim";
import { runGateProductionReality } from "./commands/gate";
import { SIMULATION_CLASSIFICATIONS } from "./core/simulation";
import { runBuildNextWave, runBuildClaim, runBuildRelease, runBuildSubClaim, runBuildSubRelease, runBuildDispatch, runBuildPlan } from "./commands/build";
import { runCoverageCheck, runCoverageReport } from "./commands/coverage";
import { runRoute } from "./commands/route";
import { runNext } from "./commands/next";
import { runDelegatePlan, runDelegatePack, runDelegateCheck } from "./commands/delegate";
import { runRepoMap, runRepoRelevant, runRepoImpact, runRepoCheck, runRepoSearch, repoFreshnessSummary } from "./commands/repo";
import { runContextPack, runContextRead } from "./commands/context";
import { runBudgetCheck } from "./commands/budget";
import { runHandoffWrite } from "./commands/handoff";
import { runInspectorWrite } from "./commands/inspector";
import { runTesterRecord } from "./commands/tester";
import { runApprove } from "./commands/approve";
import { runDriverRecord } from "./commands/driver";
import { runRealize } from "./commands/realize";
import { runAssertionPresenceRecord } from "./commands/assertion-presence";
import { runDecisionDetect, runDecisionAdd, runDecisionCheck, runDecisionList } from "./commands/decision";
import { runTemplateGet, runTemplateList } from "./commands/template";
import { runArtifactClaim, runArtifactRelease, runArtifactLeases } from "./commands/artifact-lease";
import { runCollabInit, runCollabFragment, runCollabList, runCollabMerge } from "./commands/collab";
import { runDebateAdd, runDebateList, runDebateResolve } from "./commands/debate";
import { type AdvancedFeature, assertFeatureUnlocked } from "./commands/tier";
import { GATE_OWNED } from "./core/state-fields";
import { runInterviewStart, runInterviewRecord, runInterviewStatus } from "./commands/interview";
import { runInitMcp } from "./commands/init";

// --- Component A wiring tool handlers (16 existing handlers exposed as ToolDefs) ---
import { runArtifactRegister, runArtifactList, runArtifactSection } from "./commands/artifact";
import { runResearchWrite } from "./commands/research";
import { runVerifyAdd, runVerifyList, runVerifyClear, runVerifyRun } from "./commands/verify";
import { runStageCurrent, runStageDescribe, runStageList } from "./commands/stage";
import { runDoctor } from "./commands/doctor";
import { runScorecard } from "./commands/scorecard";
import { runSlicesSync, runSliceSetStatus } from "./commands/slices";

// --- Component B: typed gate-transition tooling (precondition helpers + locked setter) ---
import { readState, SchemaTooNewError } from "./core/state-store";
import { nextStageAfterFor, canonicalizeStage } from "./core/stages";
import {
  TIERS,
  WRITE_GATE_VALUES,
  BLAST_RADIUS_FLAGS,
  SLICE_STATUSES,
  type TwinHarnessState,
} from "./core/state-schema";
import {
  type GateResult,
  canAdvanceStage,
  canUnlockImplementation,
  validateTierTransition,
} from "./core/gate-preconditions";

/**
 * Strictness rank for the write-gate (tighten-only enforcement, AC-B-write-gate):
 * off=0 < ask=1 < deny=2 < strict=3 (verified vs hook.ts:715,720-721,735 — `strict`
 * adds the Phase-B Bash gate + fail-closed, so it outranks `deny`). An ABSENT
 * `write_gate` is treated as `ask` (the documented default), so loosening below the
 * current effective level is refused.
 */
const WRITE_GATE_RANK: Record<string, number> = { off: 0, ask: 1, deny: 2, strict: 3 };

/**
 * Read state for a typed gate tool, returning either the validated state or a
 * structured failure (not-initialized / invalid). The 5 gate tools must inspect
 * state to run their precondition helper BEFORE calling {@link applyGateMutation}.
 */
function gateState(paths: ProjectPaths): { state: TwinHarnessState } | { error: CommandResult } {
  const r = readState(paths);
  if (!r.exists) {
    return { error: failure({ human: "No TwinHarness run here. Run `th init` first.", data: { error: "not_initialized" } }) };
  }
  if (!r.state) {
    return { error: failure({ human: "state.json is invalid (`th state verify` for details).", data: { error: "invalid_state", issues: r.issues } }) };
  }
  return { state: r.state };
}

/** Map a failed {@link GateResult} to a structured tool refusal (stable data.error + detail). */
function gateRefusal(check: GateResult): CommandResult {
  return failure({ human: `Gate refused: ${check.error}`, data: { error: check.error ?? "gate_refused", ...(check.detail ?? {}) } });
}

/* ------------------------------------------------------------------ *
 * Tier-gating advanced tools (Phase 5 / P5-2, plan §B2).               *
 *                                                                      *
 * Advanced coordination tools (collab, debate, section leases, sub-    *
 * leases) STAY advertised in TOOL_DEFS — the count + name contracts     *
 * (mcp-parity.test.ts) are invariant — but their `run` closure first    *
 * consults this RUNTIME gate. When the active tier does not enable the  *
 * feature (P5-1 default: <T2 and no live parallel authorship), the tool *
 * returns a structured `tier_locked` failure instead of executing, so   *
 * the capability is OFF without ever vanishing from the registry.       *
 *                                                                      *
 * The tier is resolved via a PLAIN state read (`requireState(paths)     *
 * .state.tier` — the same read the existing gate tools do), NOT a       *
 * re-classification: cheap and already on disk. This is ONE shared      *
 * helper used by every gated closure so the gate logic can never drift  *
 * between tools.                                                        *
 * ------------------------------------------------------------------ */

/**
 * The runtime tier gate (P5-2). Returns `undefined` when `feature` is enabled for
 * the run's current state (the closure proceeds), or a structured `tier_locked`
 * {@link CommandResult} when it is locked (the closure returns it instead of
 * running). A missing/invalid state.json reads as the conservative default
 * (unclassified tier, no slices) — i.e. LOCKED — so an uninitialized project never
 * silently exposes advanced coordination over MCP.
 *
 * The refusal carries a stable `error:"tier_locked"` token, the `feature`, and a
 * human line pointing at `th tier features` / `th tier record` so a caller knows
 * exactly which capability is off and how to enable it. Never throws — a locked
 * tool is a clean refusal, not a crash (the parity-compatible contract).
 *
 * Thin delegate over {@link assertFeatureUnlocked} (tier.ts), the SINGLE gate the
 * CLI shared handlers also call — so the MCP and CLI refusals are byte-for-byte
 * identical and the two surfaces cannot drift (SG3 P1-C).
 */
function assertTierAllows(paths: ProjectPaths, feature: AdvancedFeature): CommandResult | undefined {
  // Delegate to the single shared gate (tier.ts) so the MCP refusal is byte-for-byte
  // identical to the CLI shared-handler refusal — the two surfaces cannot drift.
  return assertFeatureUnlocked(paths, feature);
}

/* ------------------------------------------------------------------ *
 * Deferred #3 — destructive-op confirmation gate.                     *
 * A SECOND, distinct gate from {@link assertTierAllows}: that one is  *
 * a feature-AVAILABILITY gate keyed on the run's tier; this one is a  *
 * data-LOSS confirmation gate keyed ONLY on the caller's explicit     *
 * `confirm:true` arg. It is tier-INDEPENDENT by construction (it      *
 * never reads state/tier), so a legitimate T0/T1 caller that passes   *
 * `confirm:true` always proceeds — the exact lock-out the PR wanted   *
 * to avoid. Applied to the `destructiveHint:true` tools (th_verify_   *
 * clear, th_interview_start, th_collab_fragment). th_collab_fragment  *
 * keeps BOTH gates (tier for availability, ack for data-loss).        *
 * ------------------------------------------------------------------ */

/**
 * Deferred #3 — the destructive-op confirmation gate. Returns `undefined` when the
 * caller passed an explicit `confirm:true` (the closure proceeds), or a structured
 * `confirmation_required` {@link CommandResult} when `confirm` is absent/falsy (the
 * closure returns it instead of running). MIRRORS the `tier_locked` refusal shape
 * (`failure({ data: { error, ... }, human })`) so adapters render it identically.
 *
 * Takes ONLY `args` — never reads state, tier, or paths — so it is tier-independent:
 * a T0/T1 caller with `confirm:true` is NEVER locked out. Never throws; a missing
 * acknowledgement is a clean refusal, not a crash (the parity-compatible contract).
 *
 * Composes with the tier gate via nullish-coalescing:
 * `run: (paths, args) => assertDestructiveAck(args) ?? <existing guards> ?? actualRun(...)`.
 */
function assertDestructiveAck(args: ToolArgs): CommandResult | undefined {
  if (optBool(args, "confirm") === true) return undefined;
  return failure({
    data: {
      error: "confirmation_required",
    },
    human:
      "This is a destructive operation that may overwrite or delete data. " +
      "Re-issue the call with `confirm:true` to acknowledge and proceed.",
  });
}

/**
 * P4-3 — attach repo-map freshness/partial status to a repo-query tool result so an
 * MCP agent sees staleness INLINE (it cannot run `th repo check` between tool calls
 * the way a human would). The freshness summary is computed via the cached check
 * (P4-10), so this is cheap to add on every `th_repo_relevant`/`th_repo_impact` call.
 * Additive: only merges a `freshness` object (and a top-level `stale` boolean) into
 * the existing `data`; the rest of the result (ok/exitCode/human) is untouched. On a
 * failure result (e.g. no map) we leave it alone — the failure already explains itself.
 */
function withFreshness(paths: ProjectPaths, result: CommandResult): CommandResult {
  if (!result.ok || !result.data) return result;
  const f = repoFreshnessSummary(paths);
  return {
    ...result,
    data: {
      ...(result.data as Record<string, unknown>),
      stale: !f.fresh || f.partial,
      freshness: {
        fresh: f.fresh,
        stale: f.stale,
        partial: f.partial,
        scanIncomplete: f.scanIncomplete,
        shape: f.shape,
        added: f.added,
        removed: f.removed,
        modified: f.modified,
        capHit: f.capHit,
      },
    },
  };
}

/**
 * P7-2 — compact-by-default rendering for the HEAVY oracle tools (`th_doctor`,
 * `th_scorecard`, `th_coverage_report`). These return a large multi-line human
 * report whose full text floods a prompt every call. By default we collapse the
 * `human` text to its HEADLINE (the first non-empty line) so the text block stays
 * one line; the FULL machine payload is always intact in `structuredContent`
 * (`result.data` is untouched), and a caller that wants the long form passes
 * `verbose:true`. This trims prompt cost without ever dropping data — the
 * structured payload is the source of truth, the text is a convenience rendering.
 *
 * Additive + lossless: on `verbose` (or when there is no multi-line human text /
 * no data to fall back to) the result is returned UNCHANGED. A failure result is
 * also returned unchanged — its message already explains itself and is short.
 */
export function compactHeavyResult(result: CommandResult, verbose: boolean): CommandResult {
  if (verbose || !result.ok || typeof result.human !== "string") return result;
  const lines = result.human.split("\n");
  if (lines.length <= 1) return result; // already compact
  const headline = lines.find((l) => l.trim().length > 0) ?? lines[0]!;
  const omitted = lines.length - 1;
  return {
    ...result,
    human: `${headline}\n(compact: ${omitted} more line(s) omitted — pass verbose:true for the full report; full data in structuredContent)`,
  };
}

/* ------------------------------------------------------------------ *
 * Project-paths resolution                                            *
 * ------------------------------------------------------------------ */

/**
 * Resolve the governed project's paths for a tool call. Claude Code exposes the
 * project root to an enabled plugin's server process via `CLAUDE_PROJECT_DIR`;
 * we fall back to the process cwd when it is absent (e.g. local invocation).
 * Read per-call (not cached) so a long-lived server always reflects the current
 * root even if the env changes between calls.
 */
export function resolvePathsForCall(): ProjectPaths {
  return resolveProjectPaths(process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
}

/* ------------------------------------------------------------------ *
 * CommandResult -> MCP tool result                                    *
 * ------------------------------------------------------------------ */

/** A single JSON Schema property (kept intentionally small; mirrors a CLI flag). */
interface JsonSchemaProp {
  type: "string" | "boolean" | "number";
  description?: string;
  enum?: readonly string[];
}

/** A plain JSON Schema object for a tool's input (no zod — mirrors CLI flags). */
export interface ToolInputSchema {
  type: "object";
  properties: Record<string, JsonSchemaProp>;
  required?: string[];
  additionalProperties: false;
}

/**
 * Map a handler's {@link CommandResult} onto an MCP tool result.
 *
 *  - `result.human` (or a JSON-stringified `result.data`, or a terse OK/FAILED)
 *    becomes the single text content block — the human-readable rendering.
 *  - `result.data` (when present) plus the numeric `exitCode` are attached as
 *    `structuredContent` so a caller can consume the machine payload — including
 *    the exact CLI exit code — without re-parsing text (ARCH-005). The CLI exit
 *    code carries information `isError` (a coarse ok/not-ok boolean) loses: e.g.
 *    `th repo check`'s 0-fresh / 4-stale / 5-no-map / 1-parse-fail taxonomy.
 *  - `isError` is the inverse of `result.ok`: a failing command surfaces as a
 *    tool error rather than a silent success.
 *
 * Pure and SDK-free so it can be unit-tested in isolation.
 */
export function toToolResult(result: CommandResult): CallToolResult {
  const text =
    result.human !== undefined
      ? result.human
      : result.data !== undefined
        ? JSON.stringify(result.data, null, 2)
        : result.ok
          ? "OK"
          : "FAILED";

  const out: CallToolResult = {
    content: [{ type: "text", text }],
    isError: !result.ok,
  };
  // Surface the machine payload + the numeric exit code as structuredContent.
  // Additive: `exitCode` is always present so callers get the full CLI exit-code
  // taxonomy (not just isError); `result.data` fields are merged in when present.
  //
  // Reserved-key precedence (LATENT guard): `exitCode` is the envelope's
  // CommandResult.exitCode and is spread LAST, so it deterministically WINS over
  // any `exitCode` a future command might nest inside `result.data`. No command
  // does today (the envelope is the single source of the CLI exit code), but
  // writing the envelope value last keeps `exitCode` an unambiguous reserved key:
  // a `data.exitCode` can never silently shadow the real process exit code. The
  // mcp-adapter test pins this precedence so the invariant can't regress.
  out.structuredContent = { ...(result.data ?? {}), exitCode: result.exitCode };
  return out;
}

/* ------------------------------------------------------------------ *
 * Tool registry                                                       *
 * ------------------------------------------------------------------ */

/** Raw tool arguments as received over the wire (validated minimally per tool). */
type ToolArgs = Record<string, unknown>;

/** A registered tool: its advertised schema plus the handler invocation. */
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  /** Build paths + call the matching `run*` handler, returning its CommandResult. */
  run: (paths: ProjectPaths, args: ToolArgs) => CommandResult;
  /**
   * Async handler for tools that spawn real OS processes (th_verify_run).
   * When present, the CallTool path AWAITS this instead of
   * {@link ToolDef.run}; the synchronous `run` then serves only as the sync-contract
   * guard (never reached for these tools), so every synchronous tool keeps its exact
   * synchronous contract.
   */
  runAsync?: (paths: ProjectPaths, args: ToolArgs) => Promise<CommandResult>;
}

/** Coerce an arg to a trimmed non-empty string, or undefined. */
function optString(args: ToolArgs, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

const stringProp = (description: string): JsonSchemaProp => ({ type: "string", description });
const boolProp = (description: string): JsonSchemaProp => ({ type: "boolean", description });
const numberProp = (description: string): JsonSchemaProp => ({ type: "number", description });

/** Coerce an arg to a boolean, or undefined. */
function optBool(args: ToolArgs, key: string): boolean | undefined {
  const v = args[key];
  return typeof v === "boolean" ? v : undefined;
}

/** Coerce an arg to a finite number (accepts a numeric string), or undefined. */
function optNumber(args: ToolArgs, key: string): number | undefined {
  const v = args[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

/**
 * The exposed tools (62 total). Each mirrors one `th` subcommand's flags as a
 * JSON-Schema input and delegates to that subcommand's existing handler, EXCEPT the
 * 5 typed gate-transition tools (th_tier_record, th_stage_advance,
 * th_implementation_unlock, th_write_gate_set, th_blast_radius_record) which enforce
 * a shared gate-precondition ladder then route through the locked+ledgered
 * `applyGateMutation`. Breakdown: 21 prior coordination/observability tools + the 5
 * typed gate tools + 16 newly-wired existing handlers (artifact register/list, drift
 * list/resolve, verify add/list/clear/run, coverage report, stage current/describe/
 * list, doctor, scorecard, slices sync, slice set-status) + 4
 * interview/init + 2 Track A-2 context-budget tools (th_budget_check,
 * th_handoff_write) = 62. Ordered by domain grouping (state+gates, drift, build, route,
 * coverage, next, delegate, repo, decision, artifact, collab, debate, verify, stage,
 * health, slices, interview/init), with the 2 Track A-2 tools APPENDED LAST so the
 * existing tool indices/order mirrors are undisturbed. This order is the canonical source the
 * four order-sensitive name mirrors copy (see .omc/research/canonical-tool-names.md).
 */
export const TOOL_DEFS: readonly ToolDef[] = [
  {
    name: "th_state_get",
    description:
      "Read state.json, or a single value at a dotted path (e.g. `tier`, `slices.0.status`). Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        path: stringProp("Optional dotted path into state.json; omit to return the whole object."),
      },
      additionalProperties: false,
    },
    run: (paths, args) => runStateGet(paths, optString(args, "path")),
  },
  {
    name: "th_state_set",
    description:
      "Patch a single dotted key in state.json. `value` is JSON-parsed when possible, else stored as a string. Refuses gate-owned fields (implementation_allowed, tier, current_stage, write_gate, blast_radius_flags, and the gate-defining config fields delivery_mode, has_ui, interview_required, interview_cutoff) over MCP — those are changed only through the human-driven CLI flow (`th init` flags or `th state set --emergency`), never an agent tool — plus unknown top-level fields, unsafe key segments, the managed drift/debate counters, and any write that would make state invalid.",
    inputSchema: {
      type: "object",
      properties: {
        key: stringProp("Dotted key to set (first segment must be a known, non-gate-owned state field)."),
        value: stringProp("Value to set; parsed as JSON when valid, otherwise stored as a raw string."),
      },
      required: ["key", "value"],
      additionalProperties: false,
    },
    run: (paths, args) => {
      const key = optString(args, "key");
      // `value` may legitimately be the literal string "" or "0"/"false"; accept
      // any string (including empty) and only reject a truly missing value.
      const rawValue = typeof args.value === "string" ? args.value : undefined;
      if (key === undefined || rawValue === undefined) {
        return { ok: false, exitCode: 1, human: "th_state_set requires both `key` and `value` (strings)." };
      }
      // H-2 / R-04: the MCP raw setter must NOT move a gate-security field. The CLI
      // keeps these settable (the documented human unlock/advance path + `th init`
      // flags), but an agent over MCP must never flip implementation_allowed / tier /
      // current_stage / write_gate / blast_radius_flags, nor the gate-defining config
      // fields delivery_mode / has_ui / interview_required / interview_cutoff (a
      // silent gate downgrade). The full set is GATE_OWNED. Defense-in-depth: refuse
      // here before the handler.
      // Trim the segment so a whitespace-padded key (" tier", "tier ") still hits
      // the gate refusal instead of slipping through to a generic unknown-field error.
      const firstSegment = (key.split(".")[0] ?? "").trim();
      if (GATE_OWNED.has(firstSegment)) {
        return {
          ok: false,
          exitCode: 1,
          human: `Refusing to set gate-owned field "${firstSegment}" over MCP. Gate fields (${[...GATE_OWNED].sort().join(", ")}) are changed only through the human-driven CLI flow, never an agent tool.`,
          data: { error: "gate_owned_field", field: firstSegment },
        };
      }
      return runStateSet(paths, key, rawValue);
    },
  },
  // ---- Typed gate-transition tools (Component B) ----
  // Each enforces a precondition via the shared gate-precondition helpers (the SAME
  // single source of truth `th next` uses), then routes the write through the
  // locked+ledgered `applyGateMutation` with a HARD-CODED `source` = the tool name
  // (never read from args — an agent cannot spoof provenance, AC-B16). These are the
  // FIRST machine-enforced gate ladder; `th_state_set`'s H-2 refusal stays intact.
  {
    name: "th_tier_record",
    description:
      "Record (classify or re-classify) the run's tier. Calls validateTierTransition: refuses t0_blast_radius_veto (T0 with blast-radius flags), tier_locked_after_unlock (once implementation_allowed===true), and tier_downgrade_human_only (a downward re-tier over MCP — a review-dodge vector). Set-from-unclassified and upgrades are allowed. Writes via the locked+ledgered setter (source=th_tier_record).",
    inputSchema: {
      type: "object",
      properties: { tier: { type: "string", description: "Target tier.", enum: TIERS } },
      required: ["tier"],
      additionalProperties: false,
    },
    run: (paths, args) => {
      const tier = optString(args, "tier");
      if (tier === undefined) return failure({ human: "th_tier_record requires `tier`.", data: { error: "missing_tier" } });
      const gs = gateState(paths);
      if ("error" in gs) return gs.error;
      const check = validateTierTransition(gs.state, tier);
      if (!check.ok) return gateRefusal(check);
      return applyGateMutation(paths, { tier }, "th_tier_record");
    },
  },
  {
    name: "th_stage_advance",
    description:
      "Advance to the next APPLICABLE engaged stage for the run (UX/UI stages are skipped when has_ui===false — #13). Calls canAdvanceStage (the full mechanical ladder: blocking drift, revise caps, failing verify, artifact drift, tier set, brownfield repo-map, decision obligations, open debates, the current stage's governing artifact, coverage at implementation-planning, all slices settled at implementation). Refuses with the first failing rung's stable error, or no_next_stage at the terminal stage. Writes current_stage via the locked+ledgered setter (source=th_stage_advance).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: (paths) => {
      const gs = gateState(paths);
      if ("error" in gs) return gs.error;
      const state = gs.state;
      const adv = canAdvanceStage(paths, state);
      if (!adv.ok) return gateRefusal(adv);
      const current = canonicalizeStage(state.current_stage);
      const next = nextStageAfterFor(current, state);
      if (!next) {
        return failure({
          human: "Already at the terminal engaged stage for this run; there is no next stage to advance to.",
          data: { error: "no_next_stage", current_stage: current },
        });
      }
      return applyGateMutation(paths, { current_stage: next.stage }, "th_stage_advance");
    },
  },
  {
    name: "th_implementation_unlock",
    description:
      "Set implementation_allowed. allowed:true requires the FULL canUnlockImplementation ladder (canAdvanceStage's complete ladder + tail: coverage passes AND current_stage ≥ implementation-planning) and refuses with the first failing rung's stable error. allowed:false (re-lock/tighten) is always permitted. Writes via the locked+ledgered setter (source=th_implementation_unlock).",
    inputSchema: {
      type: "object",
      properties: { allowed: boolProp("true to unlock implementation (full gate ladder); false to re-lock (always allowed).") },
      required: ["allowed"],
      additionalProperties: false,
    },
    run: (paths, args) => {
      const allowed = optBool(args, "allowed");
      if (allowed === undefined) return failure({ human: "th_implementation_unlock requires boolean `allowed`.", data: { error: "missing_allowed" } });
      const gs = gateState(paths);
      if ("error" in gs) return gs.error;
      if (allowed) {
        const check = canUnlockImplementation(paths, gs.state);
        if (!check.ok) return gateRefusal(check);
      }
      return applyGateMutation(paths, { implementation_allowed: allowed }, "th_implementation_unlock");
    },
  },
  {
    name: "th_write_gate_set",
    description:
      "Set the PreToolUse write-gate level. TIGHTEN-ONLY over MCP: rank off < ask < deny < strict; any change to a strictly LOWER rank is refused (would_loosen_write_gate). An absent write_gate is treated as the default (ask). Writes via the locked+ledgered setter (source=th_write_gate_set).",
    inputSchema: {
      type: "object",
      properties: { value: { type: "string", description: "Target write-gate level.", enum: WRITE_GATE_VALUES } },
      required: ["value"],
      additionalProperties: false,
    },
    run: (paths, args) => {
      const value = optString(args, "value");
      if (value === undefined || !(WRITE_GATE_VALUES as readonly string[]).includes(value)) {
        return failure({ human: `th_write_gate_set requires \`value\` one of ${WRITE_GATE_VALUES.join(", ")}.`, data: { error: "invalid_write_gate" } });
      }
      const gs = gateState(paths);
      if ("error" in gs) return gs.error;
      const current = gs.state.write_gate ?? "ask"; // absent ⇒ ask semantics (documented default)
      if (WRITE_GATE_RANK[value]! < WRITE_GATE_RANK[current]!) {
        return failure({
          human: `Refusing to loosen write_gate from "${current}" to "${value}" over MCP (tighten-only).`,
          data: { error: "would_loosen_write_gate", from: current, to: value },
        });
      }
      return applyGateMutation(paths, { write_gate: value }, "th_write_gate_set");
    },
  },
  {
    name: "th_blast_radius_record",
    description:
      "Add or remove a §5 blast-radius flag (idempotent merge). present:true adds the flag, present:false removes it. Refuses t0_blast_radius_veto when the current tier is T0 and the result would carry any flag (re-tier above T0 first). Writes the merged, canonically-ordered blast_radius_flags via the locked+ledgered setter (source=th_blast_radius_record).",
    inputSchema: {
      type: "object",
      properties: {
        flag: { type: "string", description: "Blast-radius flag.", enum: BLAST_RADIUS_FLAGS },
        present: boolProp("true to add the flag, false to remove it."),
      },
      required: ["flag", "present"],
      additionalProperties: false,
    },
    run: (paths, args) => {
      const flag = optString(args, "flag");
      const present = optBool(args, "present");
      if (flag === undefined || !(BLAST_RADIUS_FLAGS as readonly string[]).includes(flag)) {
        return failure({ human: `th_blast_radius_record requires \`flag\` one of ${BLAST_RADIUS_FLAGS.join(", ")}.`, data: { error: "invalid_flag" } });
      }
      if (present === undefined) return failure({ human: "th_blast_radius_record requires boolean `present`.", data: { error: "missing_present" } });
      const gs = gateState(paths);
      if ("error" in gs) return gs.error;
      const state = gs.state;
      const cur = new Set<string>(state.blast_radius_flags);
      if (present) cur.add(flag);
      else cur.delete(flag);
      // Canonical schema order so the stored array is deterministic (idempotent merge).
      const merged = (BLAST_RADIUS_FLAGS as readonly string[]).filter((f) => cur.has(f));
      if (state.tier === "T0" && merged.length > 0) {
        return failure({
          human: `Refusing: Tier 0 forbids blast-radius flags (§5). Re-tier above T0 (th_tier_record) before recording "${flag}".`,
          data: { error: "t0_blast_radius_veto", flags: merged },
        });
      }
      return applyGateMutation(paths, { blast_radius_flags: merged }, "th_blast_radius_record");
    },
  },
  {
    name: "th_drift_add",
    description:
      "Append a §10 drift entry. `layer` is required: `requirement` is BLOCKING (increments the open-blocking counter the stop-gate reads); `derived` auto-applies. Optional ref/discovery/action/escalation/source mirror the CLI flags.",
    inputSchema: {
      type: "object",
      properties: {
        layer: { type: "string", description: "derived | requirement (required).", enum: ["derived", "requirement"] },
        ref: stringProp("SLICE-x / TASK-y reference for the entry."),
        discovery: stringProp("What was discovered."),
        action: stringProp("Action taken."),
        escalation: stringProp("Escalation status (defaults applied per layer when omitted)."),
        source: stringProp("Who logged the entry (default: Builder)."),
      },
      required: ["layer"],
      additionalProperties: false,
    },
    run: (paths, args) =>
      runDriftAdd(paths, {
        layer: optString(args, "layer"),
        ref: optString(args, "ref"),
        discovery: optString(args, "discovery"),
        action: optString(args, "action"),
        escalation: optString(args, "escalation"),
        source: optString(args, "source"),
      }),
  },
  {
    name: "th_drift_list",
    description:
      "List recorded §10 drift entries plus the open-blocking count the stop-gate reads. Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: (paths) => runDriftList(paths),
  },
  {
    name: "th_drift_resolve",
    description:
      "Resolve an open drift entry by id; decrements the open-blocking counter when it was a requirement-layer (blocking) entry. A requirement-layer (blocking) resolution REQUIRES `target` — a repo-relative source path that resolves in source — and records a BSC-4 terminal-transition receipt the completion gate re-validates. Errors if the id is unknown, already resolved, or (requirement-layer) the target is missing or does not resolve in source. Serialized under the state lock.",
    inputSchema: {
      type: "object",
      properties: {
        id: stringProp("The DRIFT-NNN id to resolve."),
        target: stringProp("Repo-relative source path the resolution resolves in — REQUIRED for requirement-layer (blocking) entries (the BSC-4 receipt ground)."),
      },
      required: ["id"],
      additionalProperties: false,
    },
    run: (paths, args) => runDriftResolve(paths, optString(args, "id"), { target: optString(args, "target") }),
  },
  {
    name: "th_build_next_wave",
    description:
      "Live wave oracle: the slices dispatchable IN PARALLEL right now (pending, deps done, components free of in-progress slices and live leases). Reports held slices with reasons and flags dependency cycles / dangling refs / stalls. Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: (paths) => runBuildNextWave(paths),
  },
  {
    name: "th_build_claim",
    description:
      "Take a live component lease on a slice before spawning its Builder. Refuses (error) if any of the slice's components are already leased to a different slice (collision guard for parallel Builders). Serialized under the state lock.",
    inputSchema: {
      type: "object",
      properties: { sliceId: stringProp("The SLICE-ID to claim (e.g. SLICE-3).") },
      required: ["sliceId"],
      additionalProperties: false,
    },
    run: (paths, args) => runBuildClaim(paths, optString(args, "sliceId")),
  },
  {
    name: "th_build_release",
    description: "Release a slice's component lease after it finishes or blocks.",
    inputSchema: {
      type: "object",
      properties: { sliceId: stringProp("The SLICE-ID to release (e.g. SLICE-3).") },
      required: ["sliceId"],
      additionalProperties: false,
    },
    run: (paths, args) => runBuildRelease(paths, optString(args, "sliceId")),
  },
  {
    name: "th_build_dispatch",
    description:
      "Single-payload parallel-dispatch oracle (REQ-PCO-001): the FULL spawn set for the current live wave in one payload — each dispatchable slice enriched with a {model, effort} recommendation from the §2 routing table — so every wave Builder can be launched in one message. Carries dependency-graph/stall warnings. Read-only (the Orchestrator still claims + sets in-progress before spawning).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: (paths) => runBuildDispatch(paths),
  },
  {
    name: "th_build_plan",
    description:
      "Schedule the slices into conflict-free build waves (slices sharing a component serialize across waves). By default only unfinished slices are scheduled; includeDone schedules all. advise adds a parallelism-optimizer advisory (REQ-PCO-030). Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        includeDone: boolProp("Schedule done slices too (default false)."),
        advise: boolProp("Append the parallelism-optimizer advisory (REQ-PCO-030)."),
      },
      additionalProperties: false,
    },
    run: (paths, args) =>
      runBuildPlan(paths, { includeDone: optBool(args, "includeDone"), advise: optBool(args, "advise") }),
  },
  {
    name: "th_route",
    description:
      "Advisory model+effort routing (§2): recommend {model, effort} for an agent spawn from the agent, its mode, the tier, and the blast-radius flags (sourced from state). Read-only: it COMPUTES the recommendation; the Orchestrator still applies the override at spawn.",
    inputSchema: {
      type: "object",
      properties: {
        agent: stringProp("The agent being spawned (orchestrator|spec|critic|builder|vertical-slice|…)."),
        mode: stringProp("The stage/mode (architecture|security|failure-modes|technical-design|slice|code-review|…)."),
        tier: stringProp("Override tier (T0..T3); defaults to state.tier."),
        componentBlast: boolProp("Builder only: the slice touches a blast-radius component."),
      },
      additionalProperties: false,
    },
    run: (paths, args) =>
      runRoute(paths, {
        agent: optString(args, "agent"),
        mode: optString(args, "mode"),
        tier: optString(args, "tier"),
        componentBlast: optBool(args, "componentBlast"),
      }),
  },
  {
    name: "th_coverage_check",
    description:
      "Hard coverage gate: verify every (MVP) REQ-ID maps to ≥1 slice and ≥1 test. Error (gap) lists each uncovered REQ-ID. Optional reqs/plan/tests/scope paths mirror the CLI flags (defaults: docs/01-requirements.md, docs/09-implementation-plan.md, tests, docs/02-scope.md). Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        reqsFile: stringProp("Requirements file (default docs/01-requirements.md)."),
        planFile: stringProp("Implementation-plan file (default docs/09-implementation-plan.md)."),
        testsDir: stringProp("Tests directory (default tests)."),
        scopeFile: stringProp("Scope file for MVP filtering (default docs/02-scope.md)."),
      },
      additionalProperties: false,
    },
    run: (paths, args) =>
      runCoverageCheck(paths, {
        reqsFile: optString(args, "reqsFile"),
        planFile: optString(args, "planFile"),
        testsDir: optString(args, "testsDir"),
        scopeFile: optString(args, "scopeFile"),
      }),
  },
  {
    name: "th_coverage_report",
    description:
      "Full planned/implemented/tested traceability breakdown for every checked REQ-ID (structured payload). Optional reqs/plan/tests/scope/code path overrides mirror the CLI flags. COMPACT by default — the per-REQ table is collapsed to a headline in the text block (the full breakdown stays in structuredContent); pass `verbose:true` for the full human table. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        reqsFile: stringProp("Requirements file (default docs/01-requirements.md)."),
        planFile: stringProp("Implementation-plan file (default docs/09-implementation-plan.md)."),
        testsDir: stringProp("Tests directory (default tests)."),
        scopeFile: stringProp("Scope file for MVP filtering (default docs/02-scope.md)."),
        codeDir: stringProp("Code directory scanned for the implemented dimension (default src)."),
        verbose: boolProp("Emit the full human breakdown in the text block (default false: a compact headline; full data always in structuredContent)."),
      },
      additionalProperties: false,
    },
    run: (paths, args) =>
      compactHeavyResult(
        runCoverageReport(paths, {
          reqsFile: optString(args, "reqsFile"),
          planFile: optString(args, "planFile"),
          testsDir: optString(args, "testsDir"),
          scopeFile: optString(args, "scopeFile"),
          codeDir: optString(args, "codeDir"),
        }),
        optBool(args, "verbose") === true,
      ),
  },
  {
    name: "th_next",
    description:
      "Next-action oracle: the single highest-priority MECHANICAL obligation the run owes next (blocking drift, revise caps, failing suite, artifact drift, tier, stage obligations, build waves, …). Reports a mechanical obligation; it never chooses strategy. Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: (paths) => runNext(paths),
  },
  {
    name: "th_delegate_plan",
    description:
      "Context-preservation oracle: recommend whether a task should be DELEGATED to a child agent or KEPT in the main context, from mechanical signals (intent, expected file reads, source writes, noisy output). Returns the recommendation, reasons, a suggested agent, and whether a handoff/capsule is needed. Advisory: it COMPUTES; the Orchestrator decides. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        intent: {
          type: "string",
          description: "Kind of work.",
          enum: ["read", "write", "debug", "review", "artifact", "repo-analysis"],
        },
        files: numberProp("Expected number of file reads (delegate when > 3)."),
        writes: boolProp("The task modifies source code."),
        noisy: boolProp("The task runs noisy commands / inspects logs / runs tests / scans the repo."),
        task: stringProp("Free-text task label (echoed; not parsed)."),
        slice: stringProp("Slice the task is scoped to (frames the suggested handoff)."),
      },
      additionalProperties: false,
    },
    run: (_paths, args) =>
      runDelegatePlan({
        intent: optString(args, "intent"),
        files: optNumber(args, "files"),
        writes: optBool(args, "writes"),
        noisy: optBool(args, "noisy"),
        task: optString(args, "task"),
        slice: optString(args, "slice"),
      }),
  },
  {
    name: "th_delegate_pack",
    description:
      "Assemble a BOUNDED child-agent handoff: the delegated-agent envelope (agent/task/intent/slice/allowed-scope/required-behavior) plus the required Delegation Capsule format. With a slice it reuses `th context pack` for artifact Summary blocks + component-overlap framing. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        agent: stringProp("The agent being delegated to (codebase-inspector|debugger|builder|critic|spec|…)."),
        task: stringProp("What the delegate must do."),
        intent: {
          type: "string",
          description: "Kind of work.",
          enum: ["read", "write", "debug", "review", "artifact", "repo-analysis"],
        },
        slice: stringProp("Slice to frame the handoff (reuses context pack)."),
      },
      additionalProperties: false,
    },
    run: (paths, args) =>
      runDelegatePack(paths, {
        agent: optString(args, "agent"),
        task: optString(args, "task"),
        intent: optString(args, "intent"),
        slice: optString(args, "slice"),
      }),
  },
  {
    name: "th_delegate_check",
    description:
      "Validate a returned Delegation Capsule: confirm every required section heading is present (presence only — content is not judged). Pass the capsule inline as `text`, or a `path` to a capsule file within the project root. Error lists the missing sections. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        text: stringProp("The capsule text to validate inline (preferred over path when both given)."),
        path: stringProp("Path to a capsule file within the project root."),
      },
      additionalProperties: false,
    },
    run: (paths, args) =>
      runDelegateCheck(paths, {
        text: optString(args, "text"),
        file: optString(args, "path"),
      }),
  },
  // Anchor: REQ-RU-044
  // Anchor: REQ-RU-047
  // Anchor: REQ-RU-048
  // Anchor: REQ-RU-049
  // Anchor: REQ-RU-050
  // Anchor: REQ-RU-051
  {
    name: "th_repo_map",
    description:
      "Scan the governed project and build the dual repo-map artifacts (.twinharness/repo-map.json + docs/00-repo-map.md). WRITES both artifacts by default (D-CONTRACTS-001), OVERWRITING any prior repo-map.json and docs/00-repo-map.md. This overwrite is idempotent regeneration of GENERATED_ARTIFACTS — derived content, not authored data — so it is NOT flagged destructive (destructiveHint stays false); re-running reproduces equivalent output rather than losing work. Pass write:false for a dry/preview run that returns the compact summary in memory only — nothing written.",
    inputSchema: {
      type: "object",
      properties: {
        write: boolProp("Write the artifacts (default true). false = dry/preview, no filesystem write."),
        format: { type: "string", description: "Text rendering: summary (default) | json | md.", enum: ["summary", "json", "md"] },
        force: boolProp("Overwrite a target that is registered as an approved artifact (R-14). Default false: a write that would clobber a registered docs/00-repo-map.md (or repo-map.json) is refused; force:true deliberately re-authors it."),
      },
      additionalProperties: false,
    },
    run: (paths, args) => runRepoMap(paths, { write: optBool(args, "write"), format: optString(args, "format"), force: optBool(args, "force") }),
  },
  // Anchor: REQ-RU-045
  // Anchor: REQ-RU-094
  {
    name: "th_repo_relevant",
    description:
      "Read the persisted repo-map and return the files most relevant to a given selector (slice, REQ-ID, file, or free-text query). Read-only. Run th_repo_map first to build/refresh the map.",
    inputSchema: {
      type: "object",
      properties: {
        slice: stringProp("SLICE-ID selector (e.g. SLICE-3). Resolves the slice's component set from state."),
        req: stringProp("REQ-ID selector (e.g. REQ-001). Returns files whose anchors match."),
        file: stringProp("File-path selector (relative to project root). Returns files relevant to the given file."),
        query: stringProp("Free-text query selector. Fuzzy-matches against component names, paths, and anchors."),
        maxResults: numberProp("Cap on combined emitted items (default 20; ≤0 → default)."),
      },
      additionalProperties: false,
    },
    run: (paths, args) => withFreshness(paths, runRepoRelevant(paths, { slice: optString(args, "slice"), req: optString(args, "req"), file: optString(args, "file"), query: optString(args, "query"), maxResults: optNumber(args, "maxResults") })),
  },
  // Anchor: REQ-RU-046
  {
    name: "th_repo_impact",
    description:
      "Read the persisted repo-map and return the blast-radius impact of changing a file or component. Read-only. Run th_repo_map first to build/refresh the map.",
    inputSchema: {
      type: "object",
      properties: {
        file: stringProp("File-path selector (relative to project root). Returns components impacted by changing this file."),
        component: stringProp("Component name selector. Returns files and tests impacted by changing this component."),
      },
      additionalProperties: false,
    },
    run: (paths, args) => withFreshness(paths, runRepoImpact(paths, { file: optString(args, "file"), component: optString(args, "component") })),
  },
  // Anchor: REQ-RU-052
  {
    name: "th_context_pack",
    description:
      "Assemble the §9 handoff bundle: Summary blocks of every approved artifact, plus (when slice is given) the slice record, its components, and overlap with other slices. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        slice: stringProp("SLICE-ID to frame the pack for (e.g. SLICE-3). Adds slice record and component-overlap awareness."),
      },
      additionalProperties: false,
    },
    run: (paths, args) => runContextPack(paths, { slice: optString(args, "slice") }),
  },
  // Anchor: REQ-101
  // Anchor: REQ-102
  {
    name: "th_build_sub_claim",
    description:
      "Open a sub-lease on a SUBSET of a parent slice's components for a scoped sub-Builder. The parent slice must be in-progress. Components must be a non-empty subset of the parent's declared components and disjoint from any live sibling sub-lease.",
    inputSchema: {
      type: "object",
      properties: {
        parentSlice: stringProp("The PARENT-SLICE id holding the top-level lease (e.g. SLICE-3)."),
        components: stringProp("Comma-separated subset of the parent's components to sub-lease; split/trim/drop-empties."),
      },
      required: ["parentSlice", "components"],
      additionalProperties: false,
    },
    run: (paths, args) => {
      const locked = assertTierAllows(paths, "sub-lease");
      if (locked) return locked;
      const components = (optString(args, "components") ?? "").split(",").map((c) => c.trim()).filter(Boolean);
      return runBuildSubClaim(paths, optString(args, "parentSlice"), components);
    },
  },
  // Anchor: REQ-103
  // Anchor: REQ-104
  {
    name: "th_build_sub_release",
    description:
      "Release a sub-lease after the sub-Builder finishes or blocks. Verifies the id names an active sub-lease.",
    inputSchema: {
      type: "object",
      properties: {
        subId: stringProp("The SUB-ID to release (e.g. SLICE-3#sub-1)."),
      },
      required: ["subId"],
      additionalProperties: false,
    },
    run: (paths, args) => assertTierAllows(paths, "sub-lease") ?? runBuildSubRelease(paths, optString(args, "subId")),
  },
  // Anchor: REQ-206
  {
    name: "th_repo_check",
    description:
      "Check whether the persisted repo-map.json is stale (files added/removed/modified since the last `th repo map` run). Exit 0 = fresh; exit 4 = stale; exit 5 = no map; exit 1 = parse failure. Read-only; same behavior as `th repo check`.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    run: (paths, _args) => runRepoCheck(paths),
  },
  // Anchor: REQ-408
  {
    name: "th_decision_detect",
    description:
      "Surface advisory DecisionCandidate[] from four deterministic on-disk sources (ADRs, drift-log, scope-change signals, state.json blast-radius flags). Read-only; exit 0 always; never writes any state. Same behavior as `th decision detect`.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    run: (paths, _args) => runDecisionDetect(paths),
  },
  // Anchor: REQ-408
  {
    name: "th_decision_add",
    description:
      "Record one `proposed` decision: mint the next id, set the proposer/proposedAt audit trail. `title` and `rationale` are required. `links` is a comma-separated string (split/trim/drop-empties). Never auto-approves. Same behavior as `th decision add`.",
    inputSchema: {
      type: "object",
      properties: {
        title: stringProp("Decision title (required)."),
        rationale: stringProp("Decision rationale (required)."),
        links: stringProp("Comma-separated list of links to related artifacts (optional)."),
        proposer: stringProp("Attribution for the proposing agent (default: orchestrator)."),
      },
      required: ["title", "rationale"],
      additionalProperties: false,
    },
    run: (paths, args) =>
      runDecisionAdd(paths, {
        title: optString(args, "title"),
        rationale: optString(args, "rationale"),
        links: optString(args, "links")
          ?.split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        proposer: optString(args, "proposer"),
      }),
  },
  // Anchor: REQ-408
  {
    name: "th_decision_check",
    description:
      "Fail (exit 6) when any unapproved decision gates the current stage; pass (exit 0) when all gating decisions are approved or none exist. Uses the single gatingObligations predicate (RULE-007). Same behavior as `th decision check`.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    run: (paths, _args) => runDecisionCheck(paths),
  },
  // Anchor: REQ-408
  {
    name: "th_decision_list",
    description:
      "Return the reduced decision set, sorted by numeric id suffix. Exit 0 always. Audit fields appear only when applicable to the status. Same behavior as `th decision list`.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    run: (paths, _args) => runDecisionList(paths),
  },
  // Artifact governance — content-hash + register/list approved versioned artifacts.
  {
    name: "th_artifact_register",
    description:
      "Content-hash a file or directory (project-root-relative) and upsert it into approved_artifacts at the given version (re-registering replaces the entry). Rejects absolute paths and `..`/outside-root escapes; surfaces artifact_too_large when the hash byte-budget is exceeded. Serialized under the state lock.",
    inputSchema: {
      type: "object",
      properties: {
        path: stringProp("Project-root-relative path to the file or directory to register."),
        version: numberProp("Positive integer version to record."),
      },
      required: ["path", "version"],
      additionalProperties: false,
    },
    run: (paths, args) => {
      const file = optString(args, "path");
      const version = optNumber(args, "version");
      if (file === undefined) return failure({ human: "th_artifact_register requires `path`.", data: { error: "missing_path" } });
      // AC-A6 / R-22: reject absolute or parent-escaping paths BEFORE the handler
      // (defense-in-depth; runArtifactRegister also re-checks via resolveWithinRoot).
      // Uses the shared cross-platform predicate so a `C:\…`/UNC path is rejected on
      // POSIX too (host-native `path.isAbsolute` missed those — the R-11 gap).
      if (isAbsoluteOrEscaping(file)) {
        return failure({ human: `Refusing a path that is absolute or escapes the project root: ${file}`, data: { error: "path_escape", path: file } });
      }
      return runArtifactRegister(paths, file, version);
    },
  },
  {
    name: "th_artifact_list",
    description: "List every recorded approved artifact ({file, version, hash}). Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: (paths) => runArtifactList(paths),
  },
  // Section leases — fine-grained artifact-section coordination (mirrors build leases).
  {
    name: "th_artifact_claim",
    description:
      "Take a section lease (<file>#<section>) for a holder before editing that section. Refuses (error) if the exact section is already actively leased to a DIFFERENT holder (collision guard); a re-claim by the same holder is idempotent. Serialized under the state lock.",
    inputSchema: {
      type: "object",
      properties: {
        section: stringProp("Section id of the form <file>#<section> (e.g. docs/04-architecture.md#data-model)."),
        holder: stringProp("The claiming agent/task id."),
      },
      required: ["section", "holder"],
      additionalProperties: false,
    },
    run: (paths, args) =>
      assertTierAllows(paths, "section-lease") ??
      runArtifactClaim(paths, { section: optString(args, "section"), holder: optString(args, "holder") }),
  },
  {
    name: "th_artifact_release",
    description: "Release a section lease (<file>#<section>) held by a holder.",
    inputSchema: {
      type: "object",
      properties: {
        section: stringProp("Section id of the form <file>#<section>."),
        holder: stringProp("The releasing agent/task id."),
      },
      required: ["section", "holder"],
      additionalProperties: false,
    },
    run: (paths, args) =>
      assertTierAllows(paths, "section-lease") ??
      runArtifactRelease(paths, { section: optString(args, "section"), holder: optString(args, "holder") }),
  },
  {
    name: "th_artifact_leases",
    description: "List the active section leases ({section, holder}). Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: (paths) => assertTierAllows(paths, "section-lease") ?? runArtifactLeases(paths),
  },
  // Anchor: REQ-PCO-040 — blackboard collab substrate (fragments + reconcile-merge).
  {
    name: "th_collab_init",
    description:
      "Report the resolved collab directory for a stage (path construction only — dirs are created on the first fragment write). Read-only.",
    inputSchema: {
      type: "object",
      properties: { stage: stringProp("Stage bucket name.") },
      required: ["stage"],
      additionalProperties: false,
    },
    run: (paths, args) => assertTierAllows(paths, "collab") ?? runCollabInit(paths, { stage: optString(args, "stage") }),
  },
  {
    name: "th_collab_fragment",
    description:
      "Drop a fragment file into <stage>/<round>, creating the round dir on demand. Refuses to overwrite an existing fragment unless force is set (collision guard for parallel writers).",
    inputSchema: {
      type: "object",
      properties: {
        stage: stringProp("Stage bucket name."),
        round: stringProp("Round bucket within the stage."),
        name: stringProp("Fragment file name, unique within the round (a single path component)."),
        text: stringProp("Fragment body (must carry ≥1 REQ-ID anchor to survive a merge)."),
        force: boolProp("Overwrite an existing fragment of the same name (default false)."),
        confirm: boolProp("Acknowledge this destructive write (Deferred #3 ack gate); required to proceed."),
      },
      required: ["stage", "round", "name"],
      additionalProperties: false,
    },
    run: (paths, args) =>
      // Deferred #3: ack (data-loss) gate composed with the existing tier
      // (availability) gate. Both must pass; ack checked first.
      assertDestructiveAck(args) ??
      assertTierAllows(paths, "collab") ??
      runCollabFragment(paths, {
        stage: optString(args, "stage"),
        round: optString(args, "round"),
        name: optString(args, "name"),
        text: optString(args, "text"),
        force: optBool(args, "force"),
      }),
  },
  {
    name: "th_collab_list",
    description: "List fragment descriptors for a stage (optionally one round) in deterministic sorted order. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        stage: stringProp("Stage bucket name."),
        round: stringProp("Optional round to scope the listing."),
      },
      required: ["stage"],
      additionalProperties: false,
    },
    run: (paths, args) =>
      assertTierAllows(paths, "collab") ??
      runCollabList(paths, { stage: optString(args, "stage"), round: optString(args, "round") }),
  },
  {
    name: "th_collab_merge",
    description:
      "Reconcile a round: concatenate its fragments in deterministic order (idempotent). Rejects (error) any round containing a fragment without a REQ-ID anchor (traceability §17). Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        stage: stringProp("Stage bucket name."),
        round: stringProp("Round bucket to merge."),
      },
      required: ["stage", "round"],
      additionalProperties: false,
    },
    run: (paths, args) =>
      assertTierAllows(paths, "collab") ??
      runCollabMerge(paths, { stage: optString(args, "stage"), round: optString(args, "round") }),
  },
  // Anchor: REQ-PCO-042 — append-only debate ledger (mirrors the drift ledger).
  {
    name: "th_debate_add",
    description:
      "Log a proposed (BLOCKING) debate over competing producer positions; increments debate_open_blocking so the stop-gate refuses completion until it is resolved. Serialized under the state lock.",
    inputSchema: {
      type: "object",
      properties: {
        topic: stringProp("The debate topic (required)."),
        positions: stringProp("The competing positions."),
        links: stringProp("Comma-separated REQ-IDs / ADR-ids the debate concerns."),
        source: stringProp("Who is logging the entry (default Builder)."),
      },
      required: ["topic"],
      additionalProperties: false,
    },
    run: (paths, args) =>
      assertTierAllows(paths, "debate") ??
      runDebateAdd(paths, {
        topic: optString(args, "topic"),
        positions: optString(args, "positions"),
        links: optString(args, "links"),
        source: optString(args, "source"),
      }),
  },
  {
    name: "th_debate_list",
    description: "List debate entries (collapsed to the latest per id, sorted) plus the open-blocking count. Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: (paths) => assertTierAllows(paths, "debate") ?? runDebateList(paths),
  },
  {
    name: "th_debate_resolve",
    description:
      "Mark a debate resolved and decrement debate_open_blocking. Errors if the id is unknown or already resolved. Serialized under the state lock.",
    inputSchema: {
      type: "object",
      properties: {
        id: stringProp("The DEBATE-NNN id to resolve."),
        resolution: stringProp("The resolution rationale."),
      },
      required: ["id"],
      additionalProperties: false,
    },
    run: (paths, args) =>
      assertTierAllows(paths, "debate") ??
      runDebateResolve(paths, { id: optString(args, "id"), resolution: optString(args, "resolution") }),
  },
  // ---- Verify suite config + run (verify.json + verify-report.json) ----
  {
    name: "th_verify_add",
    description:
      'Append a project verify command (e.g. "npm test") to verify.json. Commands are operator-authored and executed by th_verify_run.',
    inputSchema: {
      type: "object",
      properties: { command: stringProp("The shell command to add (required).") },
      required: ["command"],
      additionalProperties: false,
    },
    run: (paths, args) => runVerifyAdd(paths, optString(args, "command")),
  },
  {
    name: "th_verify_list",
    description: "List the configured verify commands. Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: (paths) => runVerifyList(paths),
  },
  {
    name: "th_verify_clear",
    description: "Remove all configured verify commands.",
    inputSchema: {
      type: "object",
      properties: {
        confirm: boolProp("Acknowledge this destructive op (Deferred #3 ack gate); required to proceed."),
      },
      additionalProperties: false,
    },
    // Deferred #3: data-loss ack gate (tier-independent; T0/T1 with confirm proceed).
    run: (paths, args) => assertDestructiveAck(args) ?? runVerifyClear(paths),
  },
  {
    name: "th_verify_run",
    description:
      "Execute every configured verify command in the project root and record the report — the one command that runs project tests. Commands run OUTSIDE the state lock; only the report write is persisted (AC-B11). ASYNC: spawns real OS processes (dispatched via runAsync; `run` is the sync-contract guard).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: () => asyncToolGuard("th_verify_run"),
    runAsync: async (paths) => runVerifyRun(paths),
  },
  // ---- Stage contract introspection (read-only) ----
  {
    name: "th_stage_current",
    description: "The stage contract for state.current_stage (or a plain note for a pre-pipeline stage). Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: (paths) => runStageCurrent(paths),
  },
  {
    name: "th_stage_describe",
    description: "Describe one pipeline stage's contract (produces / critic mode / human gate / tiers). Read-only.",
    inputSchema: {
      type: "object",
      properties: { stage: stringProp("The stage id to describe (e.g. architecture).") },
      required: ["stage"],
      additionalProperties: false,
    },
    run: (_paths, args) => runStageDescribe(optString(args, "stage")),
  },
  {
    name: "th_stage_list",
    description: "List every pipeline stage with its tiers, human-gate flag, and produced artifact. Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: () => runStageList(),
  },
  // ---- Run-health audit + scorecard (structured payloads) ----
  {
    name: "th_doctor",
    description:
      "Run-health audit: a structured report of artifact drift, slice progress, revise escalations, coverage, and gate posture. Optional strict raises advisories to failures. COMPACT by default — the text block is a headline (full report in structuredContent); pass `verbose:true` for the full human report. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        strict: boolProp("Treat advisories as failures (default false)."),
        verbose: boolProp("Emit the full human report in the text block (default false: a compact headline; full data always in structuredContent)."),
      },
      additionalProperties: false,
    },
    run: (paths, args) =>
      compactHeavyResult(runDoctor(paths, { strict: optBool(args, "strict") }), optBool(args, "verbose") === true),
  },
  {
    name: "th_scorecard",
    description:
      "One-glance run scorecard: tier, stage, implementation gate, coverage, slice progress, suite status, drift, revise escalations, artifact integrity, and routing summary (structured payload). COMPACT by default — the text block is a headline (full scorecard in structuredContent); pass `verbose:true` for the full human table. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        verbose: boolProp("Emit the full human scorecard in the text block (default false: a compact headline; full data always in structuredContent)."),
      },
      additionalProperties: false,
    },
    run: (paths, args) => compactHeavyResult(runScorecard(paths, {}), optBool(args, "verbose") === true),
  },
  // ---- Implementation-plan slice sync + status ----
  {
    name: "th_slices_sync",
    description:
      "Upsert implementation-plan slices into state.slices (existing ids keep their status; new ids start pending). planFile overrides the plan path; dryRun computes without writing; removeMissing drops state slices no longer in the plan. Serialized under the state lock.",
    inputSchema: {
      type: "object",
      properties: {
        planFile: stringProp("Implementation-plan file (default docs/09-implementation-plan.md)."),
        dryRun: boolProp("Compute and report without writing state."),
        removeMissing: boolProp("Remove state slices no longer present in the plan."),
      },
      additionalProperties: false,
    },
    run: (paths, args) =>
      runSlicesSync(paths, {
        planFile: optString(args, "planFile"),
        dryRun: optBool(args, "dryRun"),
        removeMissing: optBool(args, "removeMissing"),
      }),
  },
  {
    name: "th_slice_set_status",
    description:
      "Set a slice's status (pending|in-progress|done|blocked). Errors on an unknown slice id or invalid status. Serialized under the state lock.",
    inputSchema: {
      type: "object",
      properties: {
        sliceId: stringProp("The SLICE-ID to update (e.g. SLICE-3)."),
        status: { type: "string", description: "New status.", enum: SLICE_STATUSES },
      },
      required: ["sliceId", "status"],
      additionalProperties: false,
    },
    run: (paths, args) => runSliceSetStatus(paths, optString(args, "sliceId"), optString(args, "status")),
  },
  // ---- Interview + init tools ----
  // Store-only/deterministic: the interview tools RECORD agent-supplied scores and
  // PERSIST .twinharness/interview.json (no LLM in the deterministic layer); th_init
  // is idempotent and never gate-mutating. All four are containment-safe and join the
  // EXPECTED_TOOL_ALLOWLIST. th_init deliberately exposes NO `force` (R17).
  {
    name: "th_interview_start",
    description:
      "Start a scored Socratic interview: create .twinharness/interview.json with the idea + resolved confidence cutoff (default 0.80). Store-only; overwrites any prior interview. `idea` is required. (Ready when confidence ≥ cutoff.)",
    inputSchema: {
      type: "object",
      properties: {
        idea: stringProp("The initial idea/brief to interview against (required)."),
        cutoff: numberProp("Confidence-gate cutoff in [0,1] (default 0.80); ready when confidence ≥ cutoff."),
        confirm: boolProp("Acknowledge this destructive op — overwrites any prior interview (Deferred #3 ack gate); required to proceed."),
      },
      required: ["idea"],
      additionalProperties: false,
    },
    // Deferred #3: data-loss ack gate (tier-independent; T0/T1 with confirm proceed).
    run: (paths, args) =>
      assertDestructiveAck(args) ??
      runInterviewStart(paths, { idea: optString(args, "idea"), cutoff: optNumber(args, "cutoff") }),
  },
  {
    name: "th_interview_record",
    description:
      "Append one agent-supplied round to the interview store and update the latest confidence. Store-only — the agent supplies ALL judgment; the tool COMPUTES nothing but `ready = confidence >= cutoff`. `scores` is a JSON object {goal,constraints,criteria}; `entities` is a JSON array of strings (both parsed in-handler). `question`, `answer`, `scores`, and `confidence` are required.",
    inputSchema: {
      type: "object",
      properties: {
        question: stringProp("The question asked this round (required)."),
        answer: stringProp("The answer captured this round (required)."),
        scores: stringProp('JSON object of per-dimension scores, e.g. {"goal":0.2,"constraints":0.3,"criteria":0.1} (required).'),
        confidence: numberProp("Agent-computed confidence for this round, a number in [0,1] (required); ready when confidence ≥ cutoff."),
        entities: stringProp('JSON array of entity strings captured this round, e.g. ["auth","db"] (optional).'),
      },
      required: ["question", "answer", "scores", "confidence"],
      additionalProperties: false,
    },
    run: (paths, args) => {
      // Nested args exceed the scalar validator: scores/entities arrive as JSON text
      // and are parsed here (precedent: th_decision_add `links`). The handler then
      // validates their shape and stores them verbatim.
      const scoresRaw = optString(args, "scores");
      let scores: unknown;
      try {
        scores = scoresRaw === undefined ? undefined : JSON.parse(scoresRaw);
      } catch {
        return failure({ human: "`scores` must be valid JSON for { goal, constraints, criteria }.", data: { error: "invalid_scores_json" } });
      }
      const entitiesRaw = optString(args, "entities");
      let entities: unknown;
      try {
        entities = entitiesRaw === undefined ? undefined : JSON.parse(entitiesRaw);
      } catch {
        return failure({ human: "`entities` must be a valid JSON array of strings.", data: { error: "invalid_entities_json" } });
      }
      return runInterviewRecord(paths, {
        question: optString(args, "question"),
        answer: optString(args, "answer"),
        scores,
        confidence: optNumber(args, "confidence"),
        entities,
      });
    },
  },
  {
    name: "th_interview_status",
    description:
      "Report the interview gate state: { started, rounds, confidence, cutoff, ready }. Ready when confidence ≥ cutoff. A missing/corrupt store reports started:false, ready:false. Read-only; COMPUTES only `ready`.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: (paths) => runInterviewStatus(paths),
  },
  {
    name: "th_init",
    description:
      "Initialize TwinHarness scaffolding (docs/, state.json, drift-log.md). IDEMPOTENT and non-destructive: on an already-initialized project it returns { already_initialized: true, … } WITHOUT clobbering state.json. `brownfield` records project_mode:brownfield on a fresh init. There is NO force over MCP — destructive re-init is CLI/human-only.",
    inputSchema: {
      type: "object",
      properties: {
        brownfield: boolProp("Record project_mode:brownfield for adopting an existing codebase (fresh init only)."),
      },
      additionalProperties: false,
    },
    run: (paths, args) => runInitMcp(paths, { brownfield: optBool(args, "brownfield") }),
  },
  // ---- Track A-2 — context budget + handoff (appended at the end of the registry
  // so existing tool indices/order mirrors are undisturbed) ----
  {
    name: "th_budget_check",
    description:
      "Deterministic context-budget estimate (Track A-2): from agent-supplied proxy counts (filesRead, slicesBuilt, toolCalls, artifacts) compute { estTokens, pct, verdict } against the budget. The budget is `max`×1000 when given, else the persisted state.max_tokens, else the tier-aware default. verdict = ok | warn (pct≥0.75) | over (pct≥1.0). Read-only; the math is mechanical, the counts are the caller's.",
    inputSchema: {
      type: "object",
      properties: {
        max: numberProp("Budget override in THOUSANDS (k); omit to use state.max_tokens or the tier default."),
        filesRead: numberProp("Proxy count: files read so far."),
        slicesBuilt: numberProp("Proxy count: slices built so far."),
        toolCalls: numberProp("Proxy count: tool calls so far."),
        artifacts: numberProp("Proxy count: approved artifacts carried."),
      },
      additionalProperties: false,
    },
    run: (paths, args) =>
      runBudgetCheck(paths, {
        max: optNumber(args, "max"),
        filesRead: optNumber(args, "filesRead"),
        slicesBuilt: optNumber(args, "slicesBuilt"),
        toolCalls: optNumber(args, "toolCalls"),
        artifacts: optNumber(args, "artifacts"),
      }),
  },
  {
    name: "th_handoff_write",
    description:
      "Assemble .twinharness/HANDOFF.md (Track A-2): the run state (current_stage, slices), the `th next` recommended action, the approved-artifact Summary blocks (reuses th context pack), the open questions, an explicit 'do not re-read docs/, trust the summaries' directive, and a machine-readable resume snapshot consumed by `th handoff verify`. Use on a Fresh-session handoff when the budget verdict is 'over'. Writes one file under the state dir.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: (paths) => runHandoffWrite(paths),
  },
  // ---- C-10: deterministic template resolver (project-override → plugin-bundled → structured miss) ----
  {
    name: "th_template_get",
    description:
      "Resolve a TwinHarness template by bare name (e.g. `task-file` or `task-file.md`) and return its absolute path, content, and source layer. Precedence (no probing): a project override at `.twinharness/templates/<name>` (source `project-override`) wins over the plugin-bundled `templates/<name>` (source `plugin-bundled`); a miss returns the structured `template_not_found` with the paths searched. A traversal/absolute name is refused. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        name: stringProp("Bare template filename to resolve (e.g. `task-file` or `task-file.md`). A single component — no path separators, no `..`."),
      },
      required: ["name"],
      additionalProperties: false,
    },
    run: (paths, args) => runTemplateGet(paths, optString(args, "name")),
  },
  {
    name: "th_template_list",
    description:
      "List every resolvable template across both layers (project `.twinharness/templates/` overrides + plugin-bundled `templates/`), deduped with the resolver's precedence and marking any project override that shadows a same-named bundled template. Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: (paths) => runTemplateList(paths),
  },
  // SG3 P1-B (C-11) — governed, receipt-bearing repo search over the persisted map's scope.
  {
    name: "th_repo_search",
    description:
      "Search the GOVERNED repo (the file set the persisted repo-map covers) for a pattern, returning path:line citations under a cap — each backed by a SHA-256 read receipt (in data.receipts). Kinds: literal (substring) | regex | symbol (parsed export names) | req (REQ-ID anchors) | artifact (registered approved-artifact paths) | template (resolvable template names). Read-only; never executes content. Run th_repo_map first to build the search scope.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: stringProp("The pattern to search for (required)."),
        kind: { type: "string", description: "Search kind (default literal).", enum: ["literal", "regex", "symbol", "req", "artifact", "template"] },
        maxResults: numberProp("Cap on emitted citations (default 50; clamped to [1, 500])."),
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    run: (paths, args) => runRepoSearch(paths, { pattern: optString(args, "pattern"), kind: optString(args, "kind"), maxResults: optNumber(args, "maxResults") }),
  },
  // SG3 P1-B (C-11) — batch read a file list under ONE token budget with per-file receipts.
  {
    name: "th_context_read",
    description:
      "Batch-read a set of files under ONE shared token budget, with deterministic truncation and a per-file {file, hash, tokensConsumed} read receipt (in data.receipts). Files are read in order; while budget remains a file is included whole, the file that would overflow is truncated to a deterministic line-prefix, and any file after the budget is exhausted is reported omitted. A missing/escaping file is skipped (not fatal). Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        files: stringProp("Comma-separated file list (root-relative); split/trim/drop-empties."),
        maxTokens: numberProp("Single token budget shared across all files (>0; ≤0/absent ⇒ no budget)."),
      },
      required: ["files"],
      additionalProperties: false,
    },
    run: (paths, args) =>
      runContextRead(paths, {
        files: (optString(args, "files") ?? "").split(",").map((f) => f.trim()).filter(Boolean),
        maxTokens: optNumber(args, "maxTokens"),
      }),
  },
  // SG3 P1-B (C-12) — bounded named-heading extraction with a content-hash receipt.
  {
    name: "th_artifact_section",
    description:
      "Extract the BODY of a named heading from a markdown artifact under an optional token budget, with a content-hash read receipt (in data.receipts). The section is the first heading whose text equals `section` (case-insensitive); its body runs to the next same-or-higher-level heading. With maxTokens set, the body is truncated to fit by keeping a deterministic line-prefix (truncated:true). The receipt always hashes the FULL section body. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        file: stringProp("Artifact file to read (root-relative or absolute within root)."),
        section: stringProp("Heading name whose body to extract (the H1-H6 text, e.g. \"External Dependencies\")."),
        maxTokens: numberProp("Token budget for the returned body (>0 truncates; absent ⇒ full section)."),
      },
      required: ["file", "section"],
      additionalProperties: false,
    },
    run: (paths, args) =>
      runArtifactSection(paths, { file: optString(args, "file"), section: optString(args, "section"), maxTokens: optNumber(args, "maxTokens") }),
  },
  // SG3 P2-A — governed research-output writer (resolves C-01). Appended LAST per the
  // TOOL_DEFS append convention (the sub-lease tools must keep their fixed indices).
  // The Researcher agent is read/web-only and cannot author its own artifact; this twin
  // persists the markdown at the HANDLER-PINNED path docs/00-research/<topic>.md
  // (sanitized in runResearchWrite — never a caller-chosen path) and auto-registers it.
  {
    name: "th_research_write",
    description:
      "Persist a research artifact's markdown at the HANDLER-PINNED path docs/00-research/<topic>.md (the topic is sanitized to a flat slug; slashes, `..`, and absolute/drive paths are refused) and auto-register it (first write ⇒ v1). If the topic is ALREADY a registered approved artifact, the write is REFUSED unless an explicit `version` GREATER than the registered one is supplied — a governed writer never silently clobbers or downgrades an approved doc. Returns a {file, hash} receipt. Serialized under the state lock via the register step.",
    inputSchema: {
      type: "object",
      properties: {
        topic: stringProp("Research topic slug — becomes the file stem under docs/00-research/. Flat name only (no path separators, no `..`)."),
        markdown: stringProp("The full markdown body to persist."),
        version: numberProp("Artifact version to register at. Omit for a first write (v1); to re-author an already-registered topic, pass a version greater than the registered one."),
      },
      required: ["topic", "markdown"],
      additionalProperties: false,
    },
    run: (paths, args) => {
      const topic = optString(args, "topic");
      const markdown = optString(args, "markdown");
      if (topic === undefined) return failure({ human: "th_research_write requires `topic`.", data: { error: "missing_topic" } });
      if (markdown === undefined) return failure({ human: "th_research_write requires `markdown`.", data: { error: "missing_markdown" } });
      // Defense-in-depth: reject an obviously path-shaped topic BEFORE the handler
      // (runResearchWrite re-sanitizes and re-pins regardless). Mirrors the
      // th_artifact_register pre-check using the shared cross-platform predicate.
      if (isAbsoluteOrEscaping(topic)) {
        return failure({ human: `Refusing a topic that is absolute or escapes the research dir: ${topic}`, data: { error: "invalid_topic", topic } });
      }
      return runResearchWrite(paths, { topic, markdown, version: optNumber(args, "version") });
    },
  },
  // --- SG3 P2-C: simulation ledger + production-reality gate reader (appended) ---
  {
    name: "th_sim_add",
    description:
      "Append a simulation-ledger entry (.twinharness/simulation-ledger.json). `classification` is required (Real|Sandbox|Emulated|Mocked|Stubbed|Hardcoded). A user-visible SIMULATED entry (Mocked/Stubbed/Hardcoded/Emulated) BLOCKS the production-reality gate until retired. Optional replaces/introSlice/retireSlice/owner/userVisible mirror the CLI flags. Append-only; mints SIM-NNN.",
    inputSchema: {
      type: "object",
      properties: {
        classification: { type: "string", description: "Production-reality classification (required).", enum: [...SIMULATION_CLASSIFICATIONS] },
        replaces: stringProp("What real dependency this stands in for."),
        introSlice: stringProp("Slice/task that introduced the simulation."),
        retireSlice: stringProp("Slice/owner that will replace it with reality."),
        owner: stringProp("Who owns retiring the simulation."),
        userVisible: boolProp("true when a user-visible production path depends on this (the gate blocks on it)."),
      },
      required: ["classification"],
      additionalProperties: false,
    },
    run: (paths, args) =>
      runSimAdd(paths, {
        classification: optString(args, "classification"),
        replaces: optString(args, "replaces"),
        introSlice: optString(args, "introSlice"),
        retireSlice: optString(args, "retireSlice"),
        owner: optString(args, "owner"),
        userVisible: optBool(args, "userVisible"),
      }),
  },
  {
    name: "th_sim_list",
    description:
      "List simulation-ledger entries plus the ids that BLOCK the production-reality gate (non-retired, user-visible, simulated). Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: (paths) => runSimList(paths, {}),
  },
  {
    name: "th_sim_retire",
    description:
      "Mark a simulation entry retired by id (status transition active→retired; entries are never deleted). A user-visible simulation REQUIRES `target` — a repo-relative source path that resolves in source — and records a BSC-4 terminal-transition receipt; an ungrounded retirement does NOT exonerate the entry (it still blocks the production-reality gate and the dist-scan join). Optional retireSlice records who/what replaced it with reality. Errors on an unknown id, a double-retire, or (user-visible) a missing/unresolving target. Serialized under the state lock.",
    inputSchema: {
      type: "object",
      properties: {
        id: stringProp("The SIM-NNN id to retire."),
        retireSlice: stringProp("Slice/owner that replaced the simulation with reality."),
        target: stringProp("Repo-relative source path the retirement resolves in — REQUIRED for a user-visible simulation (the BSC-4 receipt ground)."),
      },
      required: ["id"],
      additionalProperties: false,
    },
    run: (paths, args) => runSimRetire(paths, optString(args, "id"), { retireSlice: optString(args, "retireSlice"), target: optString(args, "target") }),
  },
  {
    name: "th_sim_scan",
    description:
      "Two-tier scan of dist/ for simulation patterns (mock|fake|stub|fixture|placeholder|demo|TODO|canned|hardcoded): enumerate + streaming-hash EVERY dist/ path, deep-inspect within a layered budget (per-file/aggregate/watchdog), and report both unledgered dist/ hits AND `unobserved` dist/ files the scan could not deep-inspect (file_limit|aggregate_limit|watchdog|read_error) — the coverage gaps the production-reality GATE blocks on (scan_coverage_incomplete). Advisory (exit 0; the gate refuses, not scan); records an incomplete-scan receipt under the state lock when coverage is incomplete. tests/ hits stay advisory.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: (paths) => runSimScan(paths, {}),
  },
  {
    name: "th_gate_production_reality",
    description:
      "Reader: report the production-reality gate (checkProductionReality). SIX conditions, each a stable error token: simulation_unretired (a non-retired user-visible simulation), production_verify_not_green, tester_record_missing, unledgered_simulation_in_dist, scan_coverage_incomplete (a dist/ file the two-tier scan could not deep-inspect, not exonerated by a signed exception), human_approval_unverified (an engaged-and-not-future humanGate stage lacks a valid snapshot+artifact-bound human approval). The SAME predicate canAdvanceStage/canUnlockImplementation/checkFinalVerification compose, so a blocked th_stage_advance/th_implementation_unlock returns the IDENTICAL token. Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: (paths) => runGateProductionReality(paths),
  },
  // Codebase-Inspector governed write (SG3 P3-A): the read-only inspector agent's
  // single write path. Hard-pins the target to docs/00-existing-codebase-analysis.md
  // in the handler (refuses any other `file` before the governed-write chokepoint),
  // then writes + auto-registers the artifact and returns a content-hash receipt.
  {
    name: "th_inspector_write",
    description:
      "Codebase-Inspector governed write (brownfield): write `content` to docs/00-existing-codebase-analysis.md and auto-register it as an approved artifact. The target path is FIXED in the handler — an optional `file` must equal that path exactly or the write is refused (inspector_path_pinned). `version` defaults to 1. Returns a `receipts: [{file, hash}]` payload.",
    inputSchema: {
      type: "object",
      properties: {
        content: stringProp("The full markdown analysis body to write (the agent assembles it; the CLI records + hashes it)."),
        file: stringProp("Optional explicit target; must equal docs/00-existing-codebase-analysis.md or the write is refused."),
        version: numberProp("Artifact version recorded on auto-register (default 1)."),
      },
      required: ["content"],
      additionalProperties: false,
    },
    run: (paths, args) =>
      runInspectorWrite(paths, {
        content: optString(args, "content"),
        file: optString(args, "file"),
        version: optNumber(args, "version"),
      }),
  },
  // SG3 P2-C — live-QA Tester record writer (resolves audit P1: the production-reality
  // gate's 3rd condition had no writer). Attaches .twinharness/tester-record.json so the
  // gate's `tester_record_missing` rung can be cleared through the documented workflow.
  {
    name: "th_tester_record",
    description:
      "Attach the live-QA Tester run record (.twinharness/tester-record.json) that satisfies the production-reality gate's 3rd condition (tester_record_missing). `driver` is required (e.g. playwright|curl|cli-e2e). F8: pass `passed:true` to record a PASSING live run — the gate's STRICT predicate requires it (a record without `passed` is written but does NOT clear the rung). Optional provider (real|sandbox) and evidenceRef (path/URL to raw output) bind the execution receipt; the record is also bound to the repo snapshot (gitHead/dirtyTreeDigest) so a copied/stale record is rejected. Stamps ranAt. Returns a {file, hash} receipt. Mechanical: it records the verdict the live Tester supplies; it does not re-run or re-judge.",
    inputSchema: {
      type: "object",
      properties: {
        driver: stringProp("Driver/runner the live QA used (playwright | curl | cli-e2e | …). Required, non-empty."),
        passed: { type: "boolean", description: "F8 — the live run's pass verdict. true ⇒ satisfies the production-reality Tester condition; absent/false ⇒ recorded but the rung stays blocked." },
        provider: stringProp("Provider tier the live run exercised (real | sandbox)."),
        evidenceRef: stringProp("Path/URL to the raw live-run output or screenshots."),
      },
      required: ["driver"],
      additionalProperties: false,
    },
    run: (paths, args) =>
      runTesterRecord(paths, {
        driver: optString(args, "driver"),
        passed: optBool(args, "passed"),
        provider: optString(args, "provider"),
        evidenceRef: optString(args, "evidenceRef"),
      }),
  },
  // Axis-B slice-4a (BSC-3) — in-process driver-dimension receipt writer. The SENSOR
  // that records which verification dimensions verify-report.json observed, grounding the
  // production-reality verification-driver rung. Registration is ALWAYS-ON (parity with
  // the CLI `th driver record`); the TH_BSC3_ENFORCE flag governs ENFORCEMENT only.
  {
    name: "th_driver_record",
    description:
      "Axis-B/BSC-3: mint the IN-PROCESS driver-dimension receipt the production-reality verification-driver rung reads (<stateDir>/driver-receipts.jsonl, hash-chained, under the state lock). Records which seed dimensions (tests-executed, typecheck, build) `verify-report.json` actually OBSERVED. SENSOR + refuse-at-creation: optional `dimension` (comma-separated) is INTERSECTED with the observed set — a claimed dimension the report does not evidence is refused (driver_dimension_unobserved), and a missing/unresolving report is refused (driver_evidence_unresolved). Omit `dimension` to record every observed seed dimension. ATTRIBUTION-ONLY (zero trust weight): the agent can mint it, so its trust label is `valid` NEVER `valid-grounded` — independent grounding is the slice-4b external Ed25519-signed producer. Returns a {file, hash} receipt.",
    inputSchema: {
      type: "object",
      properties: {
        dimension: stringProp(
          "Comma-separated dimension name(s) to record as observed (tests-executed | typecheck | build). Intersected with what verify-report.json observes; omit to record every observed seed dimension.",
        ),
        identity: stringProp("Producer identity to record (attribution-only, zero trust weight; defaults to cli:th driver record)."),
      },
      additionalProperties: false,
    },
    run: (paths, args) => {
      const raw = optString(args, "dimension");
      const dimensionNames = raw === undefined ? undefined : raw.split(",").map((s) => s.trim()).filter(Boolean);
      return runDriverRecord(paths, { dimensionNames, producerIdentity: optString(args, "identity") });
    },
  },
  {
    name: "th_approve",
    description:
      "Axis-B/BSC-7: mint the IN-PROCESS human-approval receipt the humanGate precondition reads (<stateDir>/approval-receipts.jsonl, hash-chained, under the state lock). `stage` defaults to the run's current stage; it MUST be a humanGate stage (requirements, scope, architecture, ux-design, ui-design, contracts, security, final-verification) and its governing `produces` artifact MUST resolve in source — else refused at creation. The approval is bound to {stage, snapshot_coord, governing_artifact_digest}. ATTRIBUTION-ONLY (zero trust weight): the agent can mint it, so its validated status is `valid` NEVER `valid-grounded` — independent grounding is the slice-3b external Ed25519-signed producer. Returns a {file, hash} receipt.",
    inputSchema: {
      type: "object",
      properties: {
        stage: stringProp("The humanGate stage to approve (defaults to the run's current_stage when omitted)."),
      },
      additionalProperties: false,
    },
    run: (paths, args) => runApprove(paths, optString(args, "stage")),
  },
  // Axis-B slice-5 (BSC-1) — in-process realization receipt writer. Binds a REQ-ID to a
  // content digest of the source artifact it is realized in, grounding the production-reality
  // realization rung. Registration is ALWAYS-ON (parity with the CLI `th realize`); the
  // TH_BSC1_ENFORCE flag governs ENFORCEMENT only.
  {
    name: "th_realize",
    description:
      "Axis-B/BSC-1: mint the IN-PROCESS realization receipt the production-reality realization rung reads (<stateDir>/realization-receipts.jsonl, hash-chained, under the state lock). Binds `req_id` to a content digest of `artifact` (the source file the REQ-ID is realized in). The gate BLOCKS a `done` slice whose owned REQ-ID has no valid, reachable, digest-fresh referent. SEPARABILITY: this does NOT set slice status — the done-claim (SliceState.status===\"done\") and this referent stay separately authored (co-authoring would be self-grounding). Refuse-at-creation: `artifact` MUST resolve in source (realization_referent_unresolved). ATTRIBUTION-ONLY (zero trust weight): the agent can mint it, so its trust label is `valid` NEVER `valid-grounded` — independent (signature-provenance) grounding is the external Ed25519-signed producer. Returns a {file, hash} receipt.",
    inputSchema: {
      type: "object",
      properties: {
        req_id: stringProp("The REQ-ID being realized (required, non-empty)."),
        artifact: stringProp("The source path the REQ-ID is realized in — the referent the receipt binds a content digest of (required; must resolve in source)."),
        identity: stringProp("Producer identity to record (attribution-only, zero trust weight; defaults to cli:th realize)."),
      },
      required: ["req_id", "artifact"],
      additionalProperties: false,
    },
    run: (paths, args) =>
      runRealize(paths, {
        reqId: optString(args, "req_id"),
        artifact: optString(args, "artifact"),
        producerIdentity: optString(args, "identity"),
      }),
  },
  // Axis-B slice-6 (BSC-2 2a) — in-process assertion-PRESENCE receipt writer. The SENSOR
  // that records, per REQ-ID, whether its recognized test files carry a non-trivial assertion,
  // grounding the production-reality assertion rung. Registration is ALWAYS-ON (parity with the
  // CLI `th assertion-presence record`).
  {
    name: "th_assertion_presence_record",
    description:
      "Axis-B/BSC-2 (2a): mint the IN-PROCESS assertion-PRESENCE receipt the production-reality assertion rung reads (<stateDir>/assertion-presence-receipts.jsonl, hash-chained, under the state lock). Records, per REQ-ID, whether the recognized test files anchoring it carry a NON-TRIVIAL assertion that can fail (an empty `it()`, a smoke-only test, or a tautology like `expect(true).toBe(true)` is assertion-free). MEASURES PRESENCE / non-triviality, NOT efficacy — it does NOT prove the suite catches regressions. ATTRIBUTION-ONLY (zero trust weight): the agent can mint it, so its in-process status is `valid` NEVER `valid-grounded` — the only efficacy/independence grade is the EXTERNAL Ed25519-signed mutation-kill receipt (2b). Returns a {file, hash} receipt.",
    inputSchema: {
      type: "object",
      properties: {
        identity: stringProp("Producer identity to record (attribution-only, zero trust weight; defaults to cli:th assertion-presence record)."),
      },
      additionalProperties: false,
    },
    run: (paths, args) =>
      runAssertionPresenceRecord(paths, { producerIdentity: optString(args, "identity") }),
  },
] as const;

/* ------------------------------------------------------------------ *
 * P7-2 — machine-readable tool annotations (hints + grouping).        *
 *                                                                      *
 * Each tool carries MCP-standard behavior hints (readOnlyHint /        *
 * destructiveHint / idempotentHint) plus a TwinHarness `category` for  *
 * cheap client-side grouping. The hints follow the MCP spec semantics: *
 *  - readOnlyHint   = the tool performs NO state/disk mutation.         *
 *  - destructiveHint = a mutating tool may DESTROY/overwrite data       *
 *                      (only meaningful when readOnlyHint is false).    *
 *  - idempotentHint = re-invoking with the same args has no ADDITIONAL  *
 *                     effect (read-only tools are idempotent by         *
 *                     definition; append/ledger tools are NOT).         *
 *                                                                      *
 * This is a THIN annotation/grouping layer (plan P7-2): it adds         *
 * metadata only. It NEVER removes a tool, renames one, or changes the   *
 * count — the consolidation of overlapping oracles                      *
 * (`next`/`next_wave`/`dispatch`; `doctor`/`scorecard`) is expressed    *
 * purely as a shared `category`, so a client can group them without the *
 * registry losing a single entry. Kept in ONE table (not 62 inline      *
 * edits) so the annotations are reviewable at a glance and a missing     *
 * entry is caught by the parity test below.                            *
 * ------------------------------------------------------------------ */

/** TwinHarness tool grouping categories (stable machine tokens for clients). */
export type ToolCategory =
  | "state"
  | "gate"
  | "simulation"
  | "drift"
  | "build"
  | "routing"
  | "coverage"
  | "oracle"
  | "delegate"
  | "repo"
  | "context"
  | "decision"
  | "artifact"
  | "collab"
  | "debate"
  | "verify"
  | "stage"
  | "health"
  | "slices"
  | "interview"
  | "lifecycle"
  | "template"
  | "tester"
  | "driver";

/** The behavior hints + category attached to a tool. */
export interface ToolAnnotation {
  category: ToolCategory;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
}

/**
 * The annotation table — one entry per tool, keyed by tool name. The parity test
 * {@link /* P7-2 *\/} asserts EVERY `TOOL_DEFS` entry has exactly one annotation here
 * (no gaps, no orphans), so this can never silently drift from the registry.
 *
 * `ro` = read-only (no mutation); `wr` = a mutating tool. The `idempotentHint` is
 * true for every read-only tool and for mutating tools whose re-invocation with the
 * same args is a no-op (set-to-value, upsert, regenerate, clear); it is FALSE for
 * append/ledger/lease tools where a second call records another event.
 */
const ro = (category: ToolCategory): ToolAnnotation => ({ category, readOnlyHint: true, destructiveHint: false, idempotentHint: true });
/** A mutating tool: idempotent set/upsert by default; pass `destructive` for data loss. */
const wr = (category: ToolCategory, opts?: { idempotent?: boolean; destructive?: boolean }): ToolAnnotation => ({
  category,
  readOnlyHint: false,
  destructiveHint: opts?.destructive === true,
  idempotentHint: opts?.idempotent !== false,
});

export const TOOL_ANNOTATIONS: Readonly<Record<string, ToolAnnotation>> = {
  // state
  th_state_get: ro("state"),
  th_state_set: wr("state", { idempotent: true }),
  // gate-transition (record/advance/unlock/set) — set-to-value, so idempotent
  th_tier_record: wr("gate", { idempotent: true }),
  th_stage_advance: wr("gate", { idempotent: false }),
  th_implementation_unlock: wr("gate", { idempotent: true }),
  th_write_gate_set: wr("gate", { idempotent: true }),
  th_blast_radius_record: wr("gate", { idempotent: true }),
  // drift ledger (append) + read
  th_drift_add: wr("drift", { idempotent: false }),
  th_drift_list: ro("drift"),
  th_drift_resolve: wr("drift", { idempotent: false }),
  // SG3 P2-C — simulation ledger (append/transition) + read/scan + production-reality reader
  th_sim_add: wr("simulation", { idempotent: false }),
  th_sim_list: ro("simulation"),
  th_sim_retire: wr("simulation", { idempotent: false }),
  // th_sim_scan now APPENDS an incomplete-scan receipt under the state lock when dist/
  // coverage is incomplete (BSC-6), so its honest hint is NOT read-only; append-per-call
  // ⇒ not idempotent (mirrors the other append/ledger tools).
  th_sim_scan: wr("simulation", { idempotent: false }),
  th_gate_production_reality: ro("gate"),
  // build oracles (read-only) + leases (mutating)
  th_build_next_wave: ro("oracle"),
  th_build_claim: wr("build", { idempotent: false }),
  th_build_release: wr("build", { idempotent: false }),
  th_build_dispatch: ro("oracle"),
  th_build_plan: ro("oracle"),
  th_build_sub_claim: wr("build", { idempotent: false }),
  th_build_sub_release: wr("build", { idempotent: false }),
  // routing — writes an opt-in telemetry.jsonl line per call when telemetry is ON
  // (one event per call ⇒ non-idempotent), so it is NOT read-only (R-09).
  th_route: wr("routing", { idempotent: false }),
  // coverage
  th_coverage_check: ro("coverage"),
  th_coverage_report: ro("coverage"),
  // next-action oracle
  th_next: ro("oracle"),
  // delegate (all read-only / advisory; pack writes nothing to state)
  th_delegate_plan: ro("delegate"),
  th_delegate_pack: ro("delegate"),
  th_delegate_check: ro("delegate"),
  // repo: map regenerates (idempotent overwrite); the queries are read-only
  th_repo_map: wr("repo", { idempotent: true }),
  th_repo_relevant: ro("repo"),
  th_repo_impact: ro("repo"),
  th_repo_check: ro("repo"),
  // SG3 P1-B — governed search is a pure read over the persisted map's scope.
  th_repo_search: ro("repo"),
  // context
  th_context_pack: ro("context"),
  // SG3 P1-B — batch read under one budget; pure read with receipts.
  th_context_read: ro("context"),
  // decision ledger (append) + read
  th_decision_detect: ro("decision"),
  th_decision_add: wr("decision", { idempotent: false }),
  th_decision_check: ro("decision"),
  th_decision_list: ro("decision"),
  // artifacts: register (content-hash record, idempotent) + leases + read
  th_artifact_register: wr("artifact", { idempotent: true }),
  th_artifact_list: ro("artifact"),
  // SG3 P1-B — bounded named-heading extraction with a content-hash receipt; pure read.
  th_artifact_section: ro("artifact"),
  th_artifact_claim: wr("artifact", { idempotent: false }),
  th_artifact_release: wr("artifact", { idempotent: false }),
  th_artifact_leases: ro("artifact"),
  // SG3 P2-A — governed research writer: persists + registers docs/00-research/<topic>.md
  // (a re-write of the same topic replaces the file + its register entry → idempotent).
  th_research_write: wr("artifact", { idempotent: true }),
  // collab blackboard
  th_collab_init: wr("collab", { idempotent: true }),
  th_collab_fragment: wr("collab", { idempotent: false, destructive: true }),
  th_collab_list: ro("collab"),
  th_collab_merge: ro("collab"),
  // debate ledger (append) + read
  th_debate_add: wr("debate", { idempotent: false }),
  th_debate_list: ro("debate"),
  th_debate_resolve: wr("debate", { idempotent: false }),
  // verify config + run
  th_verify_add: wr("verify", { idempotent: false }),
  th_verify_list: ro("verify"),
  th_verify_clear: wr("verify", { idempotent: true, destructive: true }),
  th_verify_run: wr("verify", { idempotent: true }),
  // stage contract introspection (read-only)
  th_stage_current: ro("stage"),
  th_stage_describe: ro("stage"),
  th_stage_list: ro("stage"),
  // run-health oracles
  th_doctor: ro("health"),
  // th_scorecard appends an opt-in telemetry.jsonl line per call when telemetry is ON
  // (one event per call ⇒ non-idempotent), so it is NOT read-only (R-09).
  th_scorecard: wr("health", { idempotent: false }),
  // slices
  th_slices_sync: wr("slices", { idempotent: true }),
  th_slice_set_status: wr("slices", { idempotent: true }),
  // interview
  th_interview_start: wr("interview", { idempotent: true, destructive: true }),
  th_interview_record: wr("interview", { idempotent: false }),
  th_interview_status: ro("interview"),
  // lifecycle
  th_init: wr("lifecycle", { idempotent: true }),
  // context budget + handoff
  th_budget_check: ro("context"),
  th_handoff_write: wr("context", { idempotent: true }),
  // template resolver (read-only; resolves bundled/overridden templates, never writes)
  th_template_get: ro("template"),
  th_template_list: ro("template"),
  // codebase-inspector governed write (writes + registers a fixed artifact;
  // re-writing the same analysis is an idempotent overwrite + upsert)
  th_inspector_write: wr("artifact", { idempotent: true }),
  // SG3 P2-C — live-QA Tester record writer (overwriting the marker with a fresh run is
  // an idempotent overwrite of the single tester-record.json under the state dir).
  th_tester_record: wr("tester", { idempotent: true }),
  // Axis-B/BSC-3 — in-process driver-dimension producer. NOT idempotent: each call appends a
  // fresh hash-chained driver receipt to driver-receipts.jsonl under the state dir.
  th_driver_record: wr("driver", { idempotent: false }),
  // Axis-B/BSC-7 — in-process human-approval producer. NOT idempotent: each call appends a
  // fresh hash-chained approval record to approval-receipts.jsonl under the state dir.
  th_approve: wr("stage", { idempotent: false }),
  // Axis-B/BSC-1 — in-process realization producer. NOT idempotent: each call appends a
  // fresh hash-chained realization receipt to realization-receipts.jsonl under the state dir.
  th_realize: wr("slices", { idempotent: false }),
  // Axis-B/BSC-2 (2a) — in-process assertion-presence producer. NOT idempotent: each call appends
  // a fresh hash-chained receipt to assertion-presence-receipts.jsonl under the state dir.
  th_assertion_presence_record: wr("coverage", { idempotent: false }),
};

/** The MCP-standard annotation object for a tool (or undefined if unknown). */
export function toolAnnotations(name: string): ToolAnnotation | undefined {
  return TOOL_ANNOTATIONS[name];
}

/* ------------------------------------------------------------------ *
 * P7-1 — CLI↔MCP command parity (realises the never-implemented        *
 * EXPECTED_TOOL_ALLOWLIST). The CLI is the source of truth; MCP is a    *
 * thin adapter exposing a SUBSET. This makes the intended divergence    *
 * EXPLICIT and mechanical: every live CLI command leaf either has a     *
 * matching `TOOL_DEFS` entry, or appears in {@link MCP_EXCLUDED} with a  *
 * recorded reason. A new CLI command with neither fails the parity test.*
 * ------------------------------------------------------------------ */

/**
 * Map a CLI command leaf (e.g. `repo map`, `state get`, `next`) to the MCP tool
 * name that mirrors it (`th_repo_map`, `th_state_get`, `th_next`): prefix `th_`,
 * collapse spaces and hyphens to underscores. This is the EXACT naming convention
 * the registry follows, so a tool's presence can be checked mechanically.
 */
export function cliCommandToToolName(commandLeaf: string): string {
  return "th_" + commandLeaf.trim().replace(/[ -]+/g, "_");
}

/**
 * The DELIBERATE CLI↔MCP divergence set (P7-1): CLI command leaves that are
 * intentionally NOT exposed as MCP tools, each with a recorded reason. An MCP
 * agent must never reach these — they are emergency/force, gate-owned human-only,
 * Claude Code hook-protocol, CLI-meta, or local-only surfaces. The parity test
 * asserts every non-excluded CLI command HAS a tool and every excluded one does
 * NOT, so this list is the single source of the intended boundary.
 */
export const MCP_EXCLUDED: Readonly<Record<string, string>> = {
  // --- Claude Code hook protocol (speak the hook JSON contract on stdout, not a
  // tool result; never an agent-callable tool). ---
  "hook stop-gate": "Claude Code Stop-hook protocol; not an agent tool.",
  "hook pretool-gate": "Claude Code PreToolUse write-gate protocol; not an agent tool.",
  "hook subagent-stop": "Claude Code SubagentStop-hook protocol; not an agent tool.",
  // --- CLI meta (no run state to mutate; the MCP server advertises its own
  // version/help via the protocol). ---
  version: "CLI meta; the MCP server advertises version via the protocol.",
  help: "CLI meta; MCP clients read tool descriptions, not `th help`.",
  // --- Destructive / lifecycle: migrate rewrites state.json in place; the safe
  // idempotent `th_init` IS exposed (no force over MCP). ---
  migrate: "Destructive state schema rewrite; CLI/human-only (th_init is the safe idempotent MCP entry).",
  // --- Gate-owned HUMAN-ONLY: decision approval is a TTY-gated human transition
  // (RULE-011 / INV-005) — th_decision_approve must NEVER exist as a tool. ---
  "decision approve": "HUMAN-ONLY TTY-gated transition (RULE-011); permanently absent from MCP.",
  // --- Local-only operator surface (telemetry never leaves the machine; an MCP
  // agent has no reason to toggle the operator's local opt-in). ---
  "telemetry on": "Local-only operator opt-in; not an agent capability.",
  "telemetry off": "Local-only operator opt-in; not an agent capability.",
  "telemetry status": "Local-only operator opt-in; not an agent capability.",
  // --- Advisory/standalone CLI surfaces deliberately kept off MCP to hold the
  // adapter to the coordination/observability subset (plan boundary rule). ---
  "state status": "Human-readable snapshot; agents read th_state_get / th_scorecard structurally.",
  "state verify": "CLI/CI exit-code gate; agents read th_doctor for validity posture.",
  "state unlock": "Local lock-recovery operator surface; destructive (removes the .state.lock dir), not agent-reachable (R-21; mirrors migrate / state status).",
  "revise bump": "Revise-loop counter is Critic-loop CLI machinery; not an MCP coordination surface.",
  "revise status": "Revise-loop counter is Critic-loop CLI machinery; not an MCP coordination surface.",
  "revise reset": "Revise-loop counter is Critic-loop CLI machinery; not an MCP coordination surface.",
  "tier classify": "Advisory brief classifier (reads a brief.json file); the gated th_tier_record is the MCP write path.",
  "tier veto-check": "CLI/CI exit-code veto gate; the gated th_tier_record enforces the veto on the MCP write path.",
  "tier features": "Operator inspection of the feature-activation layer; the MCP gate enforces it inline (tier_locked).",
  "verify approve": "Human-confirms a verify command SET for execution (provenance gate); CLI/human-only.",
  "build leases": "Lease inspection convenience; agents read th_build_dispatch / th_build_next_wave.",
  "debug pack": "Debugger evidence-bundle CLI surface (read-first orientation); not an MCP coordination tool.",
  "debug log add": "Debugger evidence ledger; not an MCP coordination tool.",
  "debug log list": "Debugger evidence ledger; not an MCP coordination tool.",
  "anchors scan": "REQ-anchor/CI exit-code surface; not an MCP coordination tool.",
  "trace render": "On-demand traceability render; not an MCP coordination tool.",
  stale: "Diff-scoped staleness CLI surface; not an MCP coordination tool.",
  "context estimate": "Prompt-surface estimator (operator sizing); th_context_pack/th_budget_check are the MCP context surfaces.",
  "handoff verify": "Resume-integrity CLI check; th_handoff_write is the MCP handoff surface.",
  resume: "Resume detector (prints th next); agents call th_next directly.",
  "delegate capsule": "Prints a blank capsule skeleton; a static template, not a coordination tool.",
  "manifest export": "Deterministic run-snapshot CLI surface; agents read th_scorecard / th_state_get.",
  "manifest tools": "MCP advertises tools natively via ListTools; this is the CLI mirror.",
  preview: "Pre-run pipeline preview (operator orientation); the MCP th_stage_* tools expose stage contracts.",
};

/**
 * The REVERSE divergence (P7-1): MCP tools that have NO 1:1 CLI command leaf, each
 * with a recorded reason. These are the deliberate MCP-only additions — the typed
 * gate setters the CLI reaches only via `th state set <field> --emergency`, and the
 * MCP-driven interview surface (there is no `th interview` CLI group). Pinned so a
 * NEW MCP-only tool must be justified here, and so the parity test's CLI→MCP
 * partition can account for every tool.
 */
export const MCP_ONLY_TOOLS: Readonly<Record<string, string>> = {
  th_blast_radius_record: "Typed gate setter; the CLI reaches blast_radius only via `th state set ... --emergency`.",
  th_write_gate_set: "Typed gate setter; the CLI reaches write_gate only via `th state set write_gate ... --emergency`.",
  th_interview_start: "MCP-driven scored interview (no `th interview` CLI group; the agent supplies all judgment).",
  th_interview_record: "MCP-driven scored interview (no `th interview` CLI group; the agent supplies all judgment).",
  th_interview_status: "MCP-driven scored interview (no `th interview` CLI group; the agent supplies all judgment).",
};

/**
 * The canonical list of LIVE `th` command leaves (group + sub, e.g. `repo map`,
 * `state get`, single-word `next`/`doctor`/`resume`/`migrate`/`stale`). This is the
 * CLI command SET the parity test partitions into {covered, excluded}. A companion
 * test pins this list against the enumerated commands in the CLI `HELP` string, so
 * it can never silently drift from the dispatcher's own help.
 *
 * Derived from the `dispatch` switch in cli.ts (every reachable leaf). Hook leaves
 * are handled in `main()` before dispatch but are real commands, so they are listed
 * here (and excluded above).
 */
export const CLI_COMMAND_LEAVES: readonly string[] = [
  "init",
  "state get", "state set", "state status", "state verify", "state unlock",
  "revise bump", "revise status", "revise reset",
  "tier classify", "tier veto-check", "tier record", "tier features",
  "stage advance", "stage current", "stage describe", "stage list",
  "implementation unlock",
  "artifact register", "artifact list", "artifact section", "artifact claim", "artifact release", "artifact leases",
  "research write",
  "coverage check", "coverage report",
  "verify add", "verify list", "verify approve", "verify clear", "verify run",
  "build plan", "build next-wave", "build dispatch", "build claim", "build release",
  "build sub-claim", "build sub-release", "build leases",
  "debug pack", "debug log add", "debug log list",
  "anchors scan",
  "trace render",
  "stale",
  "slices sync", "slice set-status",
  "drift add", "drift list", "drift resolve",
  "sim add", "sim list", "sim retire", "sim scan",
  "tester record",
  "driver record",
  "approve",
  "realize",
  "assertion-presence record",
  "gate production-reality",
  "collab init", "collab fragment", "collab list", "collab merge",
  "debate add", "debate list", "debate resolve",
  "hook stop-gate", "hook pretool-gate", "hook subagent-stop",
  "migrate", "doctor", "next", "preview", "scorecard", "route",
  "telemetry on", "telemetry off", "telemetry status",
  "context estimate", "context pack", "context read",
  "budget check",
  "handoff write", "handoff verify", "resume",
  "inspector write",
  "delegate plan", "delegate pack", "delegate capsule", "delegate check",
  "repo map", "repo check", "repo relevant", "repo impact", "repo search",
  "decision detect", "decision add", "decision approve", "decision check", "decision list",
  "manifest export", "manifest tools",
  "template get", "template list",
  "version", "help",
];

/**
 * The sync-contract guard for the async-only tools (th_verify_run).
 * The CallTool path dispatches them via {@link ToolDef.runAsync}, so this is never
 * reached in practice; it exists only to satisfy the required synchronous `run`
 * contract that the synchronous tools rely on.
 */
function asyncToolGuard(name: string): CommandResult {
  return failure({ human: `${name} runs asynchronously; dispatch via the awaiting CallTool path.`, data: { error: "async_tool" } });
}

/** The advertised `Tool` list (name + description + JSON-Schema input + P7-2 annotations). */
export function listTools(): Tool[] {
  return TOOL_DEFS.map((t) => {
    const ann = TOOL_ANNOTATIONS[t.name];
    return {
      name: t.name,
      description: t.description,
      // `ToolInputSchema` is a closed, strict shape; the SDK's `Tool.inputSchema`
      // carries an open index signature. They are structurally identical at
      // runtime — widen to the SDK type for the advertised list.
      inputSchema: t.inputSchema as unknown as Tool["inputSchema"],
      // P7-2: MCP-standard behavior hints (readOnlyHint/destructiveHint/
      // idempotentHint). The TwinHarness `category` is carried in `_meta` (the
      // standard `annotations` object has no `category` field) so a client can
      // group tools without a non-standard key on `annotations`.
      ...(ann
        ? {
            annotations: {
              readOnlyHint: ann.readOnlyHint,
              destructiveHint: ann.destructiveHint,
              idempotentHint: ann.idempotentHint,
            },
            _meta: { "twinharness.dev/category": ann.category },
          }
        : {}),
    };
  });
}

/* ------------------------------------------------------------------ *
 * Server wiring                                                       *
 * ------------------------------------------------------------------ */

const SERVER_NAME = "twinharness-th";

/**
 * Read the server version from package.json at runtime — MIRRORS cli.ts's
 * `readCliVersion()` exactly so the MCP server and the CLI always advertise the
 * SAME version (ARCH-006 / CQ-004 / PKG-007: a hardcoded literal silently
 * desynced on every version bump). Tries `__dirname/../package.json`
 * (dist/mcp-server.js → root package.json) then `__dirname/../../package.json`
 * (src/mcp-server.ts in a ts-node/test context). Returns "unknown" if neither is
 * found or parsing fails. Read via `fs` (NOT `import`): package.json is outside
 * `src/` (a tsc rootDir error) and importing it would inline the whole file into
 * the esbuild bundle — keeping the read here preserves the zero-runtime-dep MCP
 * bundle boundary this file documents above.
 */
export function readServerVersion(): string {
  const candidates = [
    path.join(__dirname, "..", "package.json"),
    path.join(__dirname, "..", "..", "package.json"),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        const json = JSON.parse(fs.readFileSync(candidate, "utf8")) as unknown;
        if (typeof json === "object" && json !== null && "version" in json) {
          const v = (json as Record<string, unknown>).version;
          if (typeof v === "string") return v;
        }
      }
    } catch {
      // Try next candidate.
    }
  }
  return "unknown";
}

/** Version advertised to clients — read from package.json so it never desyncs. */
export const SERVER_VERSION = readServerVersion();

/* ------------------------------------------------------------------ *
 * Runtime argument validation (H-1)                                   *
 * ------------------------------------------------------------------ */

/** Does `v` satisfy the declared JSON-Schema scalar type? `number` also accepts a
 *  finite numeric string, mirroring the CLI's own coercion (optNumber). */
function valueMatchesType(v: unknown, type: JsonSchemaProp["type"]): boolean {
  if (type === "string") return typeof v === "string";
  if (type === "boolean") return typeof v === "boolean";
  if (typeof v === "number") return Number.isFinite(v);
  return typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v));
}

/**
 * Validate a tool call's `arguments` against the tool's CLOSED, typed
 * `inputSchema` BEFORE dispatch (H-1). The advertised `additionalProperties:false`
 * schemas were previously decorative — the handler called `def.run` with raw
 * arguments, so extra/wrong-typed properties were silently accepted. A hand-rolled
 * validator (the schemas are tiny: type/enum/required/additionalProperties) keeps
 * the MCP bundle dependency-free (no ajv codegen). Exported so it is unit-testable
 * without driving the SDK handler.
 */
export function validateToolArgs(name: string, args: unknown): { ok: true } | { ok: false; errors: string } {
  const def = TOOL_DEFS.find((t) => t.name === name);
  if (!def) return { ok: false, errors: `unknown tool: ${name}` };
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return { ok: false, errors: "arguments must be a JSON object" };
  }
  const a = args as Record<string, unknown>;
  const schema = def.inputSchema;
  const errors: string[] = [];

  // additionalProperties:false — reject any property not in the schema.
  for (const key of Object.keys(a)) {
    if (!Object.prototype.hasOwnProperty.call(schema.properties, key)) {
      errors.push(`unknown property: ${key}`);
    }
  }
  // required — every required property must be present (and not undefined).
  for (const req of schema.required ?? []) {
    if (a[req] === undefined) errors.push(`missing required property: ${req}`);
  }
  // typed + enum — validate each PRESENT property against its schema.
  for (const [key, prop] of Object.entries(schema.properties)) {
    const v = a[key];
    if (v === undefined) continue; // optional & absent
    if (!valueMatchesType(v, prop.type)) {
      errors.push(`property "${key}" must be ${prop.type}`);
      continue;
    }
    if (prop.enum && !prop.enum.includes(String(v))) {
      errors.push(`property "${key}" must be one of: ${prop.enum.join(", ")}`);
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors: errors.join("; ") };
}

/**
 * Execute a single MCP tool call end-to-end: look up the tool, enforce the closed
 * typed inputSchema, dispatch to the pure `run*` handler, and map the CommandResult
 * to an MCP result.
 *
 * Exported so the adapter is unit-testable directly, without a socket or a live
 * transport (the same testability boundary as the exported `toToolResult`/
 * `TOOL_DEFS`). The CallTool request handler is a thin wrapper over this.
 */
export async function callTool(name: string, args: ToolArgs = {}): Promise<CallToolResult> {
  const def = TOOL_DEFS.find((t) => t.name === name);
  if (!def) {
    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
  // Enforce the closed, typed inputSchema BEFORE dispatch (H-1): extra,
  // wrong-typed, or missing-required arguments are rejected as a tool error
  // instead of being silently passed to the handler.
  const valid = validateToolArgs(def.name, args);
  if (!valid.ok) {
    return {
      content: [{ type: "text", text: `Invalid arguments for ${def.name}: ${valid.errors}` }],
      isError: true,
    };
  }
  // Handlers are pure and self-contained; an unexpected throw is mapped to a
  // tool error rather than crashing the server process.
  try {
    const paths = resolvePathsForCall();
    // Async tools (th_verify_run) spawn real OS processes — await runAsync
    // when present; otherwise call the synchronous handler.
    const cmd = def.runAsync ? await def.runAsync(paths, args) : def.run(paths, args);
    return toToolResult(cmd);
  } catch (err) {
    // R-33 / F4 — the mutation-boundary seam refused a too-new / corrupt on-disk
    // state. Map it to a STRUCTURED tool failure (parity with the CLI's
    // `mapDispatchError`): surface the stable `schema_too_new` token + the
    // on-disk/current versions in structuredContent so an MCP caller can react,
    // instead of an opaque "Tool failed" string.
    if (err instanceof SchemaTooNewError) {
      return toToolResult(
        failure({
          human: err.message,
          data: { error: err.code, onDisk: err.onDisk, current: err.current },
        }),
      );
    }
    // R-34 / F5 — the SHARED resolver refused an ambiguous/unsafe state LOCATION.
    // Map it to a structured tool failure (parity with the CLI's mapDispatchError)
    // so the MCP surface agrees with the CLI surface on the same input.
    if (err instanceof StateLocationConflictError) {
      return toToolResult(
        failure({
          human: err.message,
          data: { error: err.code, kind: err.kind, candidates: err.candidates },
          // Preserve the CLI/MCP exit-code taxonomy: `mapDispatchError` maps this
          // client-correctable conflict to exit 2, so `structuredContent.exitCode`
          // must read 2 here too — not the `failure()` default of 1.
          exitCode: 2,
        }),
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Tool ${def.name} failed: ${message}` }], isError: true };
  }
}

/**
 * Build the MCP {@link Server} with the tools/list + tools/call handlers wired
 * to {@link TOOL_DEFS}. Pulled out of `main` so it is independently testable and
 * so the transport choice (stdio) stays in `main`.
 */
export function buildServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: listTools() }));

  server.setRequestHandler(CallToolRequestSchema, (request): Promise<CallToolResult> =>
    callTool(request.params.name, (request.params.arguments as ToolArgs | undefined) ?? {}),
  );

  return server;
}

async function main(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // The server now serves over stdio until the transport closes (stdin EOF).
}

// Only start the stdio transport when run as a script — importing this module
// (e.g. from tests) must NOT open stdio or block.
if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`twinharness-th MCP server failed to start: ${String(err)}\n`);
    process.exit(1);
  });
}
