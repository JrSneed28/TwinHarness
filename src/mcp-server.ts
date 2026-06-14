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

import { resolveProjectPaths, type ProjectPaths } from "./core/paths";
import type { CommandResult } from "./core/output";

import { runStateGet, runStateSet } from "./commands/state";
import { runDriftAdd } from "./commands/drift";
import { runBuildNextWave, runBuildClaim, runBuildRelease } from "./commands/build";
import { runCoverageCheck } from "./commands/coverage";
import { runRoute } from "./commands/route";
import { runNext } from "./commands/next";
import { runRepoMap, runRepoRelevant, runRepoImpact } from "./commands/repo";
import { runContextPack } from "./commands/context";

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
 *  - `result.data` (when present) is attached as `structuredContent` so a caller
 *    can consume the machine payload without re-parsing text.
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
  if (result.data !== undefined) out.structuredContent = result.data;
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

/** Coerce an arg to a finite number, or undefined. */
function optNumber(args: ToolArgs, key: string): number | undefined {
  const v = args[key];
  return typeof v === "number" && isFinite(v) ? v : undefined;
}

/**
 * The exposed tools. Each mirrors one `th` subcommand's flags as a JSON-Schema
 * input and delegates to that subcommand's existing handler. Ordered to match
 * the CLI's own grouping (state, drift, build, route, coverage, next).
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
      "Patch a single dotted key in state.json. `value` is JSON-parsed when possible, else stored as a string. Refuses unknown top-level fields, unsafe key segments, managed fields, and any write that would make state invalid.",
    inputSchema: {
      type: "object",
      properties: {
        key: stringProp("Dotted key to set (first segment must be a known state field)."),
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
      return runStateSet(paths, key, rawValue);
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
    name: "th_next",
    description:
      "Next-action oracle: the single highest-priority MECHANICAL obligation the run owes next (blocking drift, revise caps, failing suite, artifact drift, tier, stage obligations, build waves, …). Reports a mechanical obligation; it never chooses strategy. Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: (paths) => runNext(paths),
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
] as const;

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
/** Version advertised to clients; kept in sync with the plugin/package version. */
const SERVER_VERSION = "0.6.2";

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

  server.setRequestHandler(CallToolRequestSchema, (request): CallToolResult => {
    const def = TOOL_DEFS.find((t) => t.name === request.params.name);
    if (!def) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
        isError: true,
      };
    }
    const args: ToolArgs = (request.params.arguments as ToolArgs | undefined) ?? {};
    // Handlers are pure and self-contained; an unexpected throw is mapped to a
    // tool error rather than crashing the server process.
    try {
      const paths = resolvePathsForCall();
      return toToolResult(def.run(paths, args));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `Tool ${def.name} failed: ${message}` }], isError: true };
    }
  });

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
