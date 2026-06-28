/**
 * D-19 / AC-10 / N1 — CLI↔MCP parity for the `th context-pages` / `th_context` surface.
 *
 * AC-10 (shared pure handler): `runContextPagesCommand` is called by BOTH the CLI
 * dispatch (`th context-pages <op>`, T6) and the `th_context` MCP tool (T7).
 * This test verifies the invariant at runtime: the same (op, args, paths) triple
 * must produce deep-equal CommandResult from both paths.
 *
 * N1 (parity registration): `th_context` must appear in TOOL_DEFS with the correct
 * operation enum so the MCP registration matches the handler behavior.
 */

import { describe, it, expect, afterEach } from "vitest";
import { makeTempProject, type TempProject } from "./helpers";
import { runContextPagesCommand } from "../src/commands/context-pages";
import { TOOL_DEFS } from "../src/mcp-server";
import type { ProjectPaths } from "../src/core/paths";
import type { CommandResult } from "../src/core/output";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

/**
 * Operations exposed through the th_context MCP enum (CLI + MCP shared).
 * Human-only ops (baseline/gc/purge) are absent — they are CLI-only and
 * listed in MCP_EXCLUDED.
 */
const MCP_OPS = [
  // S0
  "page-status", "residency", "telemetry", "savings",
  // S1+ (verify/rehydrate/compare)
  "verify", "rehydrate", "compare",
] as const;
type McpOp = (typeof MCP_OPS)[number];

/**
 * Locate the th_context TOOL_DEFS entry and return a typed wrapper around its
 * `run` function — the MCP dispatch path.
 */
function mcpRun(paths: ProjectPaths, op: string, extra: Record<string, unknown> = {}): CommandResult {
  const def = TOOL_DEFS.find((t) => t.name === "th_context");
  if (!def) throw new Error("th_context not found in TOOL_DEFS — T7 registration incomplete");
  return def.run(paths, { operation: op, ...extra });
}

/**
 * CLI dispatch path: direct call to the shared pure handler, mirroring how
 * cli.ts dispatch wires `case "context-pages": runContextPagesCommand(sub, {...}, paths)`.
 */
function cliRun(paths: ProjectPaths, op: string, extra: Record<string, unknown> = {}): CommandResult {
  return runContextPagesCommand(op, extra, paths);
}

// ---------------------------------------------------------------------------
// N1: registration checks
// ---------------------------------------------------------------------------

describe("N1: th_context MCP registration", () => {
  it("th_context is present in TOOL_DEFS", () => {
    const def = TOOL_DEFS.find((t) => t.name === "th_context");
    expect(def, "th_context must be registered in TOOL_DEFS").toBeDefined();
  });

  it("th_context inputSchema has the correct operation enum", () => {
    const def = TOOL_DEFS.find((t) => t.name === "th_context")!;
    const schema = def.inputSchema as {
      type: string;
      properties: {
        operation: { type: string; enum: string[] };
        session_id?: { type: string };
        limit?: { type: string };
        page_id?: { type: string };
        logical_key?: { type: string };
        baseline_id?: { type: string };
        context_id?: { type: string };
        category?: { type: string };
      };
      required: string[];
      additionalProperties: boolean;
    };

    expect(schema.type).toBe("object");
    expect(schema.required).toContain("operation");
    expect(schema.additionalProperties).toBe(false);

    const { enum: ops } = schema.properties.operation;
    // All MCP ops must appear in the enum.
    for (const op of MCP_OPS) {
      expect(ops, `operation enum must include "${op}"`).toContain(op);
    }
    // Human-only ops must NOT appear in the MCP enum.
    for (const excluded of ["baseline", "gc", "purge"]) {
      expect(ops, `"${excluded}" must be absent from MCP enum (human-only/CLI-only)`).not.toContain(excluded);
    }
    expect(ops.length).toBe(MCP_OPS.length);
  });

  it("th_context inputSchema accepts optional filter and selector fields", () => {
    const def = TOOL_DEFS.find((t) => t.name === "th_context")!;
    const schema = def.inputSchema as { properties: Record<string, unknown>; required: string[] };
    // S0 fields
    expect(schema.properties).toHaveProperty("session_id");
    expect(schema.properties).toHaveProperty("limit");
    // S1+ rehydrate fields
    expect(schema.properties).toHaveProperty("page_id");
    expect(schema.properties).toHaveProperty("logical_key");
    // S1+ compare fields
    expect(schema.properties).toHaveProperty("baseline_id");
    expect(schema.properties).toHaveProperty("context_id");
    expect(schema.properties).toHaveProperty("category");
    // All optional — must NOT appear in required.
    for (const field of ["session_id", "limit", "page_id", "logical_key", "baseline_id", "context_id", "category"]) {
      expect(schema.required, `"${field}" must be optional`).not.toContain(field);
    }
  });
});

// ---------------------------------------------------------------------------
// AC-10: CLI↔MCP parity — each op returns deep-equal CommandResult
// ---------------------------------------------------------------------------

/**
 * Ops that succeed with no additional args on an empty store.
 * rehydrate/compare require args (page_id/baseline_id) and return ok:false
 * without them — they are tested individually below.
 */
const NO_ARG_OPS = ["page-status", "residency", "telemetry", "savings", "verify"] as const;

describe("AC-10/D-19: CLI↔MCP parity — shared pure handler contract", () => {
  for (const op of NO_ARG_OPS) {
    it(`operation "${op}": CLI and MCP produce deep-equal CommandResult (empty store)`, () => {
      tp = makeTempProject();
      const cli = cliRun(tp.paths, op);
      const mcp = mcpRun(tp.paths, op);

      // Both must succeed on an empty (no-data) store.
      expect(cli.ok, `CLI "${op}" must succeed`).toBe(true);
      expect(mcp.ok, `MCP "${op}" must succeed`).toBe(true);

      // Exit codes must match.
      expect(cli.exitCode).toBe(mcp.exitCode);

      // data payloads must be deep-equal — the parity guarantee (AC-10).
      expect(cli.data, `data must be deep-equal for op="${op}"`).toEqual(mcp.data);
    });
  }

  it("unknown operation: both paths return ok:false with matching exit codes", () => {
    tp = makeTempProject();
    const cli = cliRun(tp.paths, "not-a-real-op");
    const mcp = mcpRun(tp.paths, "not-a-real-op");
    expect(cli.ok).toBe(false);
    expect(mcp.ok).toBe(false);
    expect(cli.exitCode).toBe(mcp.exitCode);
  });

  it('residency with session_id filter: CLI and MCP apply identical filter', () => {
    tp = makeTempProject();
    const extra = { session_id: "test-session-xyz" };
    const cli = cliRun(tp.paths, "residency", extra);
    const mcp = mcpRun(tp.paths, "residency", extra);
    expect(cli.ok).toBe(true);
    expect(mcp.ok).toBe(true);
    expect(cli.data).toEqual(mcp.data);
  });

  it("telemetry with numeric limit: CLI and MCP apply identical limit", () => {
    tp = makeTempProject();
    const extra = { limit: 5 };
    const cli = cliRun(tp.paths, "telemetry", extra);
    const mcp = mcpRun(tp.paths, "telemetry", extra);
    expect(cli.ok).toBe(true);
    expect(mcp.ok).toBe(true);
    expect(cli.data).toEqual(mcp.data);
  });

  it("baseline: CLI succeeds with correct S0 data (human-only — absent from MCP enum)", () => {
    // N.B. The schema enum enforcement (baseline absent from th_context enum) is tested
    // in the N1 block above. The run() handler itself accepts all ops — the enum
    // restriction is enforced at the MCP protocol / schema-validation layer, not here.
    tp = makeTempProject();
    const cli = cliRun(tp.paths, "baseline");
    expect(cli.ok).toBe(true);
    const cliData = cli.data as { tier?: string; baseline_tokens?: number };
    expect(cliData.tier).toBe("s0");
    expect(cliData.baseline_tokens).toBe(0);
  });

  it("verify: CLI and MCP agree on chain result (empty store → PASS)", () => {
    tp = makeTempProject();
    const cli = cliRun(tp.paths, "verify");
    const mcp = mcpRun(tp.paths, "verify");
    expect(cli.ok).toBe(true);
    expect(mcp.ok).toBe(true);
    expect(cli.data).toEqual(mcp.data);
    const cliData = cli.data as { ok: boolean; record_count: number };
    expect(cliData.ok).toBe(true);
    expect(cliData.record_count).toBe(0);
  });

  it("rehydrate: missing args → CLI and MCP both return ok:false", () => {
    tp = makeTempProject();
    const cli = cliRun(tp.paths, "rehydrate"); // no page_id or logical_key
    const mcp = mcpRun(tp.paths, "rehydrate");
    expect(cli.ok).toBe(false);
    expect(mcp.ok).toBe(false);
    expect(cli.exitCode).toBe(mcp.exitCode);
  });

  it("rehydrate: page_id not found → CLI and MCP both succeed with found:false", () => {
    tp = makeTempProject();
    const extra = { page_id: "abc123def456" };
    const cli = cliRun(tp.paths, "rehydrate", extra);
    const mcp = mcpRun(tp.paths, "rehydrate", extra);
    expect(cli.ok).toBe(true);
    expect(mcp.ok).toBe(true);
    expect(cli.data).toEqual(mcp.data);
    const cliData = cli.data as { found: boolean };
    expect(cliData.found).toBe(false);
  });

  it("compare: missing args → CLI and MCP both return ok:false", () => {
    tp = makeTempProject();
    const cli = cliRun(tp.paths, "compare"); // no baseline_id or context_id
    const mcp = mcpRun(tp.paths, "compare");
    expect(cli.ok).toBe(false);
    expect(mcp.ok).toBe(false);
    expect(cli.exitCode).toBe(mcp.exitCode);
  });

  it("savings S0 data: savings_pct=0 in both paths", () => {
    tp = makeTempProject();
    const cli = cliRun(tp.paths, "savings");
    const mcp = mcpRun(tp.paths, "savings");
    expect(cli.ok).toBe(true);
    expect(mcp.ok).toBe(true);
    const cliData = cli.data as { savings_pct?: number };
    const mcpData = mcp.data as { savings_pct?: number };
    expect(cliData.savings_pct).toBe(0); // S0: no suppression → 0% savings
    expect(mcpData.savings_pct).toBe(0);
    expect(cli.data).toEqual(mcp.data);
  });

  it("page-status S0 data: empty store → 0 shards, 0 records in both paths", () => {
    tp = makeTempProject();
    const cli = cliRun(tp.paths, "page-status");
    const mcp = mcpRun(tp.paths, "page-status");
    expect(cli.ok).toBe(true);
    expect(mcp.ok).toBe(true);
    const cliData = cli.data as { total_records?: number; unique_pages?: number; shards?: unknown[] };
    expect(cliData.total_records).toBe(0);
    expect(cliData.unique_pages).toBe(0);
    expect(cliData.shards).toHaveLength(0);
    expect(cli.data).toEqual(mcp.data);
  });
});
