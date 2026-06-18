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
 *    Orchestrator needs. `init`/`migrate` and the hook gates are deliberately
 *    EXCLUDED (scaffolding + the Claude Code hook protocol are not Orchestrator
 *    tools).
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

import { resolveProjectPaths, type ProjectPaths } from "./core/paths";
import { type CommandResult, failure } from "./core/output";

import { runStateGet, runStateSet, applyGateMutation } from "./commands/state";
import { runDriftAdd, runDriftList, runDriftResolve } from "./commands/drift";
import { runBuildNextWave, runBuildClaim, runBuildRelease, runBuildSubClaim, runBuildSubRelease, runBuildDispatch, runBuildPlan } from "./commands/build";
import { runCoverageCheck, runCoverageReport } from "./commands/coverage";
import { runRoute } from "./commands/route";
import { runNext } from "./commands/next";
import { runDelegatePlan, runDelegatePack, runDelegateCheck } from "./commands/delegate";
import { runRepoMap, runRepoRelevant, runRepoImpact, runRepoCheck } from "./commands/repo";
import { runContextPack } from "./commands/context";
import { runBudgetCheck } from "./commands/budget";
import { runHandoffWrite } from "./commands/handoff";
import { runDecisionDetect, runDecisionAdd, runDecisionCheck, runDecisionList } from "./commands/decision";
import { runArtifactClaim, runArtifactRelease, runArtifactLeases } from "./commands/artifact-lease";
import { runCollabInit, runCollabFragment, runCollabList, runCollabMerge } from "./commands/collab";
import { runDebateAdd, runDebateList, runDebateResolve } from "./commands/debate";
import { GATE_OWNED } from "./core/state-fields";
import { runInterviewStart, runInterviewRecord, runInterviewStatus } from "./commands/interview";
import { runInitMcp } from "./commands/init";

// --- Component A wiring tool handlers (16 existing handlers exposed as ToolDefs) ---
import { runArtifactRegister, runArtifactList } from "./commands/artifact";
import { runVerifyAdd, runVerifyList, runVerifyClear, runVerifyRun } from "./commands/verify";
import { runStageCurrent, runStageDescribe, runStageList } from "./commands/stage";
import { runDoctor } from "./commands/doctor";
import { runScorecard } from "./commands/scorecard";
import { runSlicesSync, runSliceSetStatus } from "./commands/slices";

// --- Component B: typed gate-transition tooling (precondition helpers + locked setter) ---
import { readState } from "./core/state-store";
import { nextStageAfter, canonicalizeStage } from "./core/stages";
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
      "Patch a single dotted key in state.json. `value` is JSON-parsed when possible, else stored as a string. Refuses gate-owned fields (implementation_allowed, tier, current_stage, write_gate) over MCP — those are changed only through the human-driven CLI flow, never an agent tool — plus unknown top-level fields, unsafe key segments, the managed drift/debate counters, and any write that would make state invalid.",
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
      // H-2: the MCP raw setter must NOT move a gate-security field. The CLI keeps
      // these settable (the documented human unlock/advance path), but an agent
      // over MCP must never flip implementation_allowed / tier / current_stage /
      // write_gate. Defense-in-depth: refuse here before the handler.
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
      "Advance to the next engaged stage for the current tier. Calls canAdvanceStage (the full mechanical ladder: blocking drift, revise caps, failing verify, artifact drift, tier set, brownfield repo-map, decision obligations, open debates, the current stage's governing artifact, coverage at implementation-planning, all slices settled at implementation). Refuses with the first failing rung's stable error, or no_next_stage at the terminal stage. Writes current_stage via the locked+ledgered setter (source=th_stage_advance).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: (paths) => {
      const gs = gateState(paths);
      if ("error" in gs) return gs.error;
      const state = gs.state;
      const adv = canAdvanceStage(paths, state);
      if (!adv.ok) return gateRefusal(adv);
      const current = canonicalizeStage(state.current_stage);
      const next = nextStageAfter(current, state.tier);
      if (!next) {
        return failure({
          human: "Already at the terminal engaged stage for this tier; there is no next stage to advance to.",
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
      "Resolve an open drift entry by id; decrements the open-blocking counter when it was a requirement-layer (blocking) entry. Errors if the id is unknown or already resolved. Serialized under the state lock.",
    inputSchema: {
      type: "object",
      properties: { id: stringProp("The DRIFT-NNN id to resolve.") },
      required: ["id"],
      additionalProperties: false,
    },
    run: (paths, args) => runDriftResolve(paths, optString(args, "id")),
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
      "Full planned/implemented/tested traceability breakdown for every checked REQ-ID (structured payload). Optional reqs/plan/tests/scope/code path overrides mirror the CLI flags. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        reqsFile: stringProp("Requirements file (default docs/01-requirements.md)."),
        planFile: stringProp("Implementation-plan file (default docs/09-implementation-plan.md)."),
        testsDir: stringProp("Tests directory (default tests)."),
        scopeFile: stringProp("Scope file for MVP filtering (default docs/02-scope.md)."),
        codeDir: stringProp("Code directory scanned for the implemented dimension (default src)."),
      },
      additionalProperties: false,
    },
    run: (paths, args) =>
      runCoverageReport(paths, {
        reqsFile: optString(args, "reqsFile"),
        planFile: optString(args, "planFile"),
        testsDir: optString(args, "testsDir"),
        scopeFile: optString(args, "scopeFile"),
        codeDir: optString(args, "codeDir"),
      }),
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
      "Scan the governed project and build the dual repo-map artifacts (.twinharness/repo-map.json + docs/00-repo-map.md). WRITES both artifacts by default (D-CONTRACTS-001). Pass write:false for a dry/preview run that returns the compact summary in memory only — nothing written.",
    inputSchema: {
      type: "object",
      properties: {
        write: boolProp("Write the artifacts (default true). false = dry/preview, no filesystem write."),
        format: { type: "string", description: "Text rendering: summary (default) | json | md.", enum: ["summary", "json", "md"] },
      },
      additionalProperties: false,
    },
    run: (paths, args) => runRepoMap(paths, { write: optBool(args, "write"), format: optString(args, "format") }),
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
    run: (paths, args) => runRepoRelevant(paths, { slice: optString(args, "slice"), req: optString(args, "req"), file: optString(args, "file"), query: optString(args, "query"), maxResults: optNumber(args, "maxResults") }),
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
    run: (paths, args) => runRepoImpact(paths, { file: optString(args, "file"), component: optString(args, "component") }),
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
    run: (paths, args) => runBuildSubRelease(paths, optString(args, "subId")),
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
      // AC-A6: reject absolute or parent-escaping paths BEFORE the handler
      // (defense-in-depth; runArtifactRegister also re-checks via resolveWithinRoot).
      if (path.isAbsolute(file) || file.split(/[\\/]/).includes("..")) {
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
    run: (paths, args) => runArtifactClaim(paths, { section: optString(args, "section"), holder: optString(args, "holder") }),
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
    run: (paths, args) => runArtifactRelease(paths, { section: optString(args, "section"), holder: optString(args, "holder") }),
  },
  {
    name: "th_artifact_leases",
    description: "List the active section leases ({section, holder}). Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: (paths) => runArtifactLeases(paths),
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
    run: (paths, args) => runCollabInit(paths, { stage: optString(args, "stage") }),
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
      },
      required: ["stage", "round", "name"],
      additionalProperties: false,
    },
    run: (paths, args) =>
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
    run: (paths, args) => runCollabList(paths, { stage: optString(args, "stage"), round: optString(args, "round") }),
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
    run: (paths, args) => runCollabMerge(paths, { stage: optString(args, "stage"), round: optString(args, "round") }),
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
    run: (paths) => runDebateList(paths),
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
    run: (paths, args) => runDebateResolve(paths, { id: optString(args, "id"), resolution: optString(args, "resolution") }),
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
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: (paths) => runVerifyClear(paths),
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
      "Run-health audit: a structured report of artifact drift, slice progress, revise escalations, coverage, and gate posture. Optional strict raises advisories to failures. Read-only.",
    inputSchema: {
      type: "object",
      properties: { strict: boolProp("Treat advisories as failures (default false).") },
      additionalProperties: false,
    },
    run: (paths, args) => runDoctor(paths, { strict: optBool(args, "strict") }),
  },
  {
    name: "th_scorecard",
    description:
      "One-glance run scorecard: tier, stage, implementation gate, coverage, slice progress, suite status, drift, revise escalations, artifact integrity, and routing summary (structured payload). Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: (paths) => runScorecard(paths, {}),
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
      },
      required: ["idea"],
      additionalProperties: false,
    },
    run: (paths, args) =>
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
] as const;

/**
 * The sync-contract guard for the async-only tools (th_verify_run).
 * The CallTool path dispatches them via {@link ToolDef.runAsync}, so this is never
 * reached in practice; it exists only to satisfy the required synchronous `run`
 * contract that the synchronous tools rely on.
 */
function asyncToolGuard(name: string): CommandResult {
  return failure({ human: `${name} runs asynchronously; dispatch via the awaiting CallTool path.`, data: { error: "async_tool" } });
}

/** The advertised `Tool` list (name + description + JSON-Schema input). */
export function listTools(): Tool[] {
  return TOOL_DEFS.map((t) => ({
    name: t.name,
    description: t.description,
    // `ToolInputSchema` is a closed, strict shape; the SDK's `Tool.inputSchema`
    // carries an open index signature. They are structurally identical at
    // runtime — widen to the SDK type for the advertised list.
    inputSchema: t.inputSchema as unknown as Tool["inputSchema"],
  }));
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
