import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { runRepoMap } from "../src/commands/repo";
import { success, failure, type CommandResult } from "../src/core/output";
import {
  toToolResult,
  TOOL_DEFS,
  listTools,
  resolvePathsForCall,
  validateToolArgs,
} from "../src/mcp-server";
import { capsuleTemplate } from "../src/core/delegation";
import { runStateSet } from "../src/commands/state";
import { readState } from "../src/core/state-store";

/**
 * Phase 4 — MCP adapter tests.
 *
 * The MCP server is a THIN adapter: its only non-trivial logic is the
 * CommandResult→MCP mapping and the tool registry that delegates to the existing
 * `run*` handlers. We unit-test that mapping/registry DIRECTLY (no socket, no live
 * transport) via the exported pure values, and we pin the SDK-boundary invariants
 * on the build outputs (cli.js stays SDK-free; mcp-server.js is built).
 */

const ROOT = path.resolve(__dirname, "..");

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

describe("REQ-MCP-MAP-001: toToolResult maps ok:true → non-error result with the data", () => {
  it("ok result with data → isError false, text from human, data + exitCode as structuredContent", () => {
    const r: CommandResult = success({ data: { tier: "T1", count: 3 }, human: "all good" });
    const mapped = toToolResult(r);
    expect(mapped.isError).toBe(false);
    expect(mapped.content).toEqual([{ type: "text", text: "all good" }]);
    // ARCH-005: data fields are merged with the numeric exitCode.
    expect(mapped.structuredContent).toEqual({ tier: "T1", count: 3, exitCode: 0 });
  });

  it("ok result without human → text falls back to JSON-stringified data", () => {
    const r: CommandResult = success({ data: { value: 42 } });
    const mapped = toToolResult(r);
    expect(mapped.isError).toBe(false);
    expect(mapped.content[0]).toMatchObject({ type: "text" });
    expect((mapped.content[0] as { text: string }).text).toContain("42");
    expect(mapped.structuredContent).toEqual({ value: 42, exitCode: 0 });
  });

  it("ok result with neither human nor data → text 'OK', structuredContent carries exitCode", () => {
    const mapped = toToolResult({ ok: true, exitCode: 0 });
    expect(mapped.isError).toBe(false);
    expect(mapped.content).toEqual([{ type: "text", text: "OK" }]);
    // ARCH-005: exitCode is always surfaced, even with no data payload.
    expect(mapped.structuredContent).toEqual({ exitCode: 0 });
  });
});

describe("ARCH-005: toToolResult carries the numeric exitCode in structuredContent", () => {
  it("preserves a non-zero exit code (e.g. repo check stale=4) alongside the data", () => {
    // Mirrors `th repo check` on a stale map: ok:false, exitCode:4, shape data.
    const r: CommandResult = { ok: false, exitCode: 4, data: { ok: false, shape: "stale" } };
    const mapped = toToolResult(r);
    expect(mapped.isError).toBe(true);
    expect((mapped.structuredContent as Record<string, unknown>).exitCode).toBe(4);
    // The data payload is still present, untouched.
    expect((mapped.structuredContent as Record<string, unknown>).shape).toBe("stale");
  });

  it("a real run* handler's exit code reaches structuredContent (th_repo_check no-map → 5)", () => {
    tp = makeTempProject();
    const def = TOOL_DEFS.find((t) => t.name === "th_repo_check")!;
    const mapped = toToolResult(def.run(tp.paths, {}));
    // No repo-map.json → REPO_NO_MAP_EXIT (5); isError stays true (ok:false).
    expect(mapped.isError).toBe(true);
    expect((mapped.structuredContent as Record<string, unknown>).exitCode).toBe(5);
  });

  // ARCH-005 / finding #6 (build plan exit-7 contract surfaces over MCP). The
  // build-plan dependency_graph_unsatisfiable failure carries exitCode 7; pin
  // that the envelope code reaches structuredContent unchanged through the
  // adapter, so a `--json`/MCP consumer can branch on the full exit-code taxonomy
  // (not just isError) for the cyclic/dangling-dep case.
  it("finding #6: a build-plan exit-7 failure surfaces exitCode:7 in structuredContent", () => {
    const r: CommandResult = failure({ exitCode: 7, data: { error: "dependency_graph_unsatisfiable" } });
    const mapped = toToolResult(r);
    expect(mapped.isError).toBe(true);
    expect((mapped.structuredContent as Record<string, unknown>).exitCode).toBe(7);
    expect((mapped.structuredContent as Record<string, unknown>).error).toBe("dependency_graph_unsatisfiable");
  });

  // Finding #5 (LATENT reserved-key guard, characterization). `exitCode` is a
  // RESERVED key in structuredContent: the envelope's CommandResult.exitCode is
  // spread LAST, so it deterministically wins over any `exitCode` a (hypothetical)
  // future command might nest inside `result.data`. No command does this today —
  // this is a forward-looking guard, not a live clobber — so we synthesize a
  // `data.exitCode` to PIN the precedence and prevent a silent regression where a
  // nested data field could shadow the real process exit code.
  it("finding #5: a nested data.exitCode never shadows the envelope exitCode (reserved-key precedence)", () => {
    const r: CommandResult = { ok: false, exitCode: 4, data: { exitCode: 99, shape: "stale" } };
    const mapped = toToolResult(r);
    const sc = mapped.structuredContent as Record<string, unknown>;
    // The ENVELOPE code (4) wins — the synthetic data.exitCode (99) is overwritten.
    expect(sc.exitCode).toBe(4);
    // Sibling data fields are still merged untouched.
    expect(sc.shape).toBe("stale");
  });
});

describe("REQ-MCP-MAP-002: toToolResult maps ok:false → isError:true", () => {
  it("failure result → isError true, human as text, data + exitCode still attached", () => {
    const r: CommandResult = failure({ human: "it broke", data: { error: "boom" } });
    const mapped = toToolResult(r);
    expect(mapped.isError).toBe(true);
    expect(mapped.content).toEqual([{ type: "text", text: "it broke" }]);
    // ARCH-005: data + the default failure exit code (1).
    expect(mapped.structuredContent).toEqual({ error: "boom", exitCode: 1 });
  });

  it("failure with neither human nor data → text 'FAILED'", () => {
    const mapped = toToolResult({ ok: false, exitCode: 1 });
    expect(mapped.isError).toBe(true);
    expect(mapped.content).toEqual([{ type: "text", text: "FAILED" }]);
    expect(mapped.structuredContent).toEqual({ exitCode: 1 });
  });
});

describe("REQ-MCP-TOOLS-001: the exposed tool set is the intended minimal subset", () => {
  // The first 9 registered tools, in order. th_build_dispatch and th_build_plan
  // were inserted into the build group (after th_build_release), shifting th_route
  // et al. down — this legacy prefix pin tracks that order.
  const expected = [
    "th_state_get",
    "th_state_set",
    "th_drift_add",
    "th_build_next_wave",
    "th_build_claim",
    "th_build_release",
    "th_build_dispatch",
    "th_build_plan",
    "th_route",
  ];

  it("TOOL_DEFS exposes the intended core tools in order (pre-SLICE-4 legacy prefix pin — superseded by the full registry pin below)", () => {
    expect(TOOL_DEFS.map((t) => t.name).slice(0, 9)).toEqual(expected);
  });

  it("migrate and the hook gates are NOT exposed (th_init is now an idempotent MCP tool)", () => {
    const names = TOOL_DEFS.map((t) => t.name);
    // th_init is intentionally exposed (idempotent, non-destructive, no force) —
    // migrate and the Claude Code hook gates remain CLI/hook-only.
    for (const forbidden of ["th_migrate", "th_hook_stop_gate", "th_hook_pretool_gate"]) {
      expect(names).not.toContain(forbidden);
    }
    // th_init IS registered now.
    expect(names).toContain("th_init");
  });

  it("listTools advertises a JSON-Schema object input for every tool", () => {
    const tools = listTools();
    for (const t of tools) {
      expect(t.description).toBeTruthy();
      expect(t.inputSchema.type).toBe("object");
    }
  });

  it("required flags are reflected in the input schema (state_set, drift_add, claim/release)", () => {
    const byName = Object.fromEntries(TOOL_DEFS.map((t) => [t.name, t]));
    expect(byName["th_state_set"]!.inputSchema.required).toEqual(["key", "value"]);
    expect(byName["th_drift_add"]!.inputSchema.required).toEqual(["layer"]);
    expect(byName["th_build_claim"]!.inputSchema.required).toEqual(["sliceId"]);
    expect(byName["th_build_release"]!.inputSchema.required).toEqual(["sliceId"]);
    // Read-only / all-optional tools advertise no required block.
    expect(byName["th_next"]!.inputSchema.required).toBeUndefined();
    expect(byName["th_state_get"]!.inputSchema.required).toBeUndefined();
  });
});

// ===========================================================================
// SLICE-4 / TASK-010 — REQ-RU-044..052 test battery (MCP repo-map tools)
// ===========================================================================

describe("SLICE-4 / TASK-010 — MCP adapter: repo-map tool wiring (REQ-RU-044..052)", () => {
  function defFor(name: string) {
    const d = TOOL_DEFS.find((t) => t.name === name);
    if (!d) throw new Error(`missing tool ${name}`);
    return d;
  }

  // ---- REQ-RU-044: th_repo_map delegates to runRepoMap ----
  it("REQ-RU-044: th_repo_map delegates to runRepoMap (no-write dry-run, ok, compact summary)", () => {
    tp = makeTempProject();
    const res = defFor("th_repo_map").run(tp.paths, { write: false });
    // runRepoMap succeeds even on an empty project (REQ-RU-090).
    expect(res.ok).toBe(true);
    expect(typeof res.human).toBe("string");
    expect(res.human).toContain("Repo map:");
    // Compact summary: data.counts present, no full files array dump in human text.
    expect(res.data).toBeDefined();
    expect(typeof (res.data as Record<string, unknown>).counts).toBe("object");
  });

  // ---- D-CONTRACTS-001 / IF-006: th_repo_map DEFAULT (no write arg) WRITES ----
  // Regression guard. The MCP server invokes handlers with `arguments ?? {}`, so a
  // caller relying on the documented default sends NO `write` key; `optBool` then
  // yields undefined and `runRepoMap` defaults to write:true (bare invocation
  // WRITES — D-CONTRACTS-001, IF-006 schema "default true"). A prior tool
  // description wrongly advertised the MCP default as no-write/preview; this test
  // pins the real behavior AND that the description no longer claims otherwise.
  it("D-CONTRACTS-001: th_repo_map with no write arg WRITES both artifacts (IF-006 default true)", () => {
    tp = makeTempProject();
    fs.mkdirSync(path.join(tp.root, "src"), { recursive: true });
    fs.writeFileSync(path.join(tp.root, "src", "a.ts"), "export const x = 1;\n", "utf8");

    const jsonAbs = path.join(tp.paths.stateDir, "repo-map.json");
    const mdAbs = path.join(tp.paths.docsDir, "00-repo-map.md");
    expect(fs.existsSync(jsonAbs)).toBe(false);
    expect(fs.existsSync(mdAbs)).toBe(false);

    // Exactly how the MCP server calls the handler when arguments are omitted.
    const res = defFor("th_repo_map").run(tp.paths, {});
    expect(res.ok).toBe(true);
    // The default WRITES both artifacts to disk.
    expect(fs.existsSync(jsonAbs)).toBe(true);
    expect(fs.existsSync(mdAbs)).toBe(true);
    expect((res.data as Record<string, unknown>).wrote).toBe(true);
    expect((res.data as Record<string, unknown>).artifacts).toEqual([
      ".twinharness/repo-map.json",
      "docs/00-repo-map.md",
    ]);

    // The advertised description must NOT claim the default is no-write/preview.
    const desc = defFor("th_repo_map").description.toLowerCase();
    expect(desc).not.toContain("default for mcp");
    expect(desc).toContain("write");
  });

  // ---- REQ-RU-045: th_repo_relevant delegates to runRepoRelevant ----
  it("REQ-RU-045: th_repo_relevant delegates to runRepoRelevant (map_missing → clean failure)", () => {
    tp = makeTempProject();
    // No repo-map.json present → runRepoRelevant returns a clean failure (not a throw).
    const res = defFor("th_repo_relevant").run(tp.paths, { query: "auth" });
    expect(res.ok).toBe(false);
    expect((res.data as Record<string, unknown>).error).toBe("map_missing");
  });

  // ---- REQ-RU-046: th_repo_impact delegates to runRepoImpact ----
  it("REQ-RU-046: th_repo_impact delegates to runRepoImpact (map_missing → clean failure)", () => {
    tp = makeTempProject();
    const res = defFor("th_repo_impact").run(tp.paths, { component: "core" });
    expect(res.ok).toBe(false);
    expect((res.data as Record<string, unknown>).error).toBe("map_missing");
  });

  // ---- REQ-RU-047: every new inputSchema is strict-closed (additionalProperties:false) ----
  it("REQ-RU-047: mcp_schemas_strict_closed — all four new tools have additionalProperties:false", () => {
    for (const name of ["th_repo_map", "th_repo_relevant", "th_repo_impact", "th_context_pack"]) {
      expect(defFor(name).inputSchema.additionalProperties).toBe(false);
    }
  });

  it("REQ-RU-047: mcp_extra_property_rejected — extra properties are NOT in any new tool's required list and schema declares them closed", () => {
    // The JSON-Schema contract for strict closure is additionalProperties:false.
    // The MCP SDK enforces this at the wire level; here we verify the schema declaration.
    for (const name of ["th_repo_map", "th_repo_relevant", "th_repo_impact", "th_context_pack"]) {
      const schema = defFor(name).inputSchema;
      expect(schema.additionalProperties).toBe(false);
      // None of the new tools have a required array (all inputs are optional — IF-006..009).
      expect(schema.required).toBeUndefined();
    }
  });

  // ---- REQ-RU-048: results carry text + structuredContent via toToolResult ----
  it("REQ-RU-048: mcp_result_has_text_and_structured_content — th_repo_map result via toToolResult", () => {
    tp = makeTempProject();
    const cmdResult = defFor("th_repo_map").run(tp.paths, { write: false });
    const toolResult = toToolResult(cmdResult);
    expect(toolResult.content[0]).toMatchObject({ type: "text" });
    expect((toolResult.content[0] as { text: string }).text).toContain("Repo map:");
    // structuredContent carries the data payload.
    expect(toolResult.structuredContent).toBeDefined();
    expect(typeof (toolResult.structuredContent as Record<string, unknown>).counts).toBe("object");
  });

  // ---- REQ-RU-049: MCP output compact by default (no full files array in human text) ----
  it("REQ-RU-049: mcp_output_compact_by_default — th_repo_map human text is compact summary, not full dump", () => {
    tp = makeTempProject();
    const res = defFor("th_repo_map").run(tp.paths, { write: false });
    expect(res.ok).toBe(true);
    // The compact summary must be present…
    expect(res.human).toContain("files:");
    // …but must NOT dump the full files array (that would be a huge JSON blob).
    // The human text is the summary lines, not a JSON dump of the full map.
    expect(res.human).not.toContain('"schema_version"');
  });

  // ---- REQ-RU-050: no command execution via MCP path ----
  it("REQ-RU-050: mcp_no_command_execution — th_repo_map does not execute any discovered command", () => {
    tp = makeTempProject();
    const sentinel = path.join(tp.root, "EXECUTED_MCP");
    const scriptContent = JSON.stringify({
      scripts: { test: `node -e "require('fs').writeFileSync('${sentinel.replace(/\\/g, "/")}','x')"` },
    });
    fs.mkdirSync(tp.root, { recursive: true });
    fs.writeFileSync(path.join(tp.root, "package.json"), scriptContent, "utf8");
    fs.mkdirSync(path.join(tp.root, "src"), { recursive: true });
    fs.writeFileSync(path.join(tp.root, "src", "a.ts"), "const x = 1;\n", "utf8");
    const res = defFor("th_repo_map").run(tp.paths, { write: false });
    expect(res.ok).toBe(true);
    // The sentinel must NOT exist — commands are recorded as strings, never executed.
    expect(fs.existsSync(sentinel)).toBe(false);
  });

  // ---- REQ-RU-051: adapter holds no orchestration logic ----
  it("REQ-RU-051: mcp_adapter_no_orchestration_logic — each new run is a one-liner delegating to run* handler", () => {
    // Structural proof: call each new tool without a real project;
    // each must delegate cleanly (return a CommandResult, never throw).
    tp = makeTempProject();
    for (const name of ["th_repo_map", "th_repo_relevant", "th_repo_impact", "th_context_pack"]) {
      const fn = () => defFor(name).run(tp.paths, {});
      expect(fn).not.toThrow();
    }
  });

  // ---- REQ-RU-052: th_context_pack registered as a thin adapter ----
  it("REQ-RU-052: mcp_context_pack_registered — th_context_pack is in TOOL_DEFS and delegates to runContextPack", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const res = defFor("th_context_pack").run(tp.paths, {});
    // runContextPack returns ok:true with the pack (no slice → global pack).
    expect(res.ok).toBe(true);
    expect(typeof res.human).toBe("string");
    expect(res.data).toBeDefined();
  });
});

// ===========================================================================
// SLICE-4 / TASK-011 — REQ-RU-094 + REQ-RU-040 (MCP half)
// ===========================================================================

describe("SLICE-4 / TASK-011 — MCP tool-count 42 + schema/no-exec battery (REQ-RU-094, REQ-RU-040)", () => {
  // Full registry, in registration order. The original 23-tool battery (REQ-RU-094)
  // is extended by the 12 coordination tools added after it: th_build_dispatch and
  // th_build_plan slot into the build group (after th_build_release), and the
  // artifact-lease / collab / debate trios append at the tail — then the
  // th_proof_* trio (run/component/report) appends (35→38, PS-Q4), and finally the
  // th_interview_*/th_init tools append at the very tail (38→42).
  const expectedAll = [
    "th_state_get",
    "th_state_set",
    "th_drift_add",
    "th_build_next_wave",
    "th_build_claim",
    "th_build_release",
    "th_build_dispatch",
    "th_build_plan",
    "th_route",
    "th_coverage_check",
    "th_next",
    "th_delegate_plan",
    "th_delegate_pack",
    "th_delegate_check",
    "th_repo_map",
    "th_repo_relevant",
    "th_repo_impact",
    "th_context_pack",
    "th_build_sub_claim",
    "th_build_sub_release",
    "th_repo_check",
    "th_decision_detect",
    "th_decision_add",
    "th_decision_check",
    "th_decision_list",
    "th_artifact_claim",
    "th_artifact_release",
    "th_artifact_leases",
    "th_collab_init",
    "th_collab_fragment",
    "th_collab_list",
    "th_collab_merge",
    "th_debate_add",
    "th_debate_list",
    "th_debate_resolve",
    "th_proof_run",
    "th_proof_component",
    "th_proof_report",
    "th_interview_start",
    "th_interview_record",
    "th_interview_status",
    "th_init",
  ];

  // ---- REQ-RU-094: full registry, in order (originally 23; now 42 with the coordination + proof + interview/init tools) ----
  it("REQ-RU-094: test_REQ-RU-094_mcp_tool_count_42 — TOOL_DEFS exposes exactly 42 tools in order", () => {
    expect(TOOL_DEFS.map((t) => t.name)).toEqual(expectedAll);
  });

  // ---- REQ-RU-094: wrong-typed arg is coerced to undefined (optNumber/optString guard) ----
  it("REQ-RU-094: test_REQ-RU-094_mcp_wrong_type_rejected — wrong-typed maxResults is ignored by optNumber", () => {
    tp = makeTempProject();
    // th_repo_relevant with maxResults as a string (wrong type) should not crash.
    // optNumber will coerce it to undefined; the handler returns map_missing (no map yet).
    const d = TOOL_DEFS.find((t) => t.name === "th_repo_relevant")!;
    const res = d.run(tp.paths, { query: "auth", maxResults: "not-a-number" });
    // Must not throw; result is a clean failure (map_missing), not a type error.
    expect(res.ok).toBe(false);
    expect((res.data as Record<string, unknown>).error).toBe("map_missing");
  });

  // ---- REQ-RU-094: extra properties declared closed in schema ----
  it("REQ-RU-094: test_REQ-RU-094_mcp_extra_property_rejected — every tool schema is closed (additionalProperties:false)", () => {
    for (const def of TOOL_DEFS) {
      expect(def.inputSchema.additionalProperties).toBe(false);
    }
  });

  // ---- REQ-RU-040 (MCP half): no command execution via MCP path ----
  it("REQ-RU-040: test_REQ-RU-040_no_command_execution_mcp — MCP th_repo_map path executes no discovered command", () => {
    tp = makeTempProject();
    const sentinel = path.join(tp.root, "EXECUTED_MCP_040");
    const scriptContent = JSON.stringify({
      scripts: { build: `node -e "require('fs').writeFileSync('${sentinel.replace(/\\/g, "/")}','x')"` },
    });
    fs.writeFileSync(path.join(tp.root, "package.json"), scriptContent, "utf8");
    fs.mkdirSync(path.join(tp.root, "src"), { recursive: true });
    fs.writeFileSync(path.join(tp.root, "src", "index.ts"), "export {};\n", "utf8");
    const d = TOOL_DEFS.find((t) => t.name === "th_repo_map")!;
    const res = d.run(tp.paths, { write: false });
    expect(res.ok).toBe(true);
    expect(fs.existsSync(sentinel)).toBe(false);
  });
});

describe("REQ-MCP-DELEGATE-001: tool handlers delegate to the real run* handlers (locked, real state)", () => {
  function defFor(name: string) {
    const d = TOOL_DEFS.find((t) => t.name === name);
    if (!d) throw new Error(`missing tool ${name}`);
    return d;
  }

  it("th_state_get returns the live state value (ok)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const res = defFor("th_state_get").run(tp.paths, { path: "current_stage" });
    expect(res.ok).toBe(true);
    expect(res.data?.value).toBe("init");
  });

  it("th_state_set rejects an unknown field through the real handler (error)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const res = defFor("th_state_set").run(tp.paths, { key: "not_a_field", value: "1" });
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("unknown_field");
  });

  it("th_state_set with a missing value is rejected by the adapter guard", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const res = defFor("th_state_set").run(tp.paths, { key: "implementation_allowed" });
    expect(res.ok).toBe(false);
  });

  it("th_drift_add requirement-layer increments blocking drift (real, locked mutation)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const res = defFor("th_drift_add").run(tp.paths, { layer: "requirement", ref: "SLICE-1 / TASK-1" });
    expect(res.ok).toBe(true);
    expect(res.data?.blocking).toBe(true);
    expect(res.data?.drift_open_blocking).toBe(1);
  });

  it("th_build_claim on an unknown slice fails via the real handler", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const res = defFor("th_build_claim").run(tp.paths, { sliceId: "SLICE-NOPE" });
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("slice_not_found");
  });

  it("th_next returns a mechanical obligation (ok)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const res = defFor("th_next").run(tp.paths, {});
    expect(res.ok).toBe(true);
    expect(typeof res.data?.kind).toBe("string");
  });

  it("th_route delegates to the routing computer (ok)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const res = defFor("th_route").run(tp.paths, { agent: "builder", componentBlast: true });
    expect(res.ok).toBe(true);
    expect(res.data?.model).toBe("opus");
    expect(typeof res.data?.effort).toBe("string");
  });
});

describe("REQ-MCP-DELEGATE-002: the delegate tools delegate to their handlers", () => {
  function defFor(name: string) {
    const d = TOOL_DEFS.find((t) => t.name === name);
    if (!d) throw new Error(`missing tool ${name}`);
    return d;
  }

  it("th_delegate_plan computes a recommendation (delegate on debug intent)", () => {
    const res = defFor("th_delegate_plan").run(resolvePathsForCall(), { intent: "debug" });
    expect(res.ok).toBe(true);
    expect(res.data?.recommendation).toBe("delegate");
    expect(res.data?.suggestedAgent).toBe("debugger");
  });

  it("th_delegate_plan coerces a numeric-string files arg (delegate over threshold)", () => {
    const res = defFor("th_delegate_plan").run(resolvePathsForCall(), { files: "5" });
    expect(res.ok).toBe(true);
    expect(res.data?.recommendation).toBe("delegate");
  });

  it("th_delegate_check validates inline capsule text (ok and missing)", () => {
    const good = defFor("th_delegate_check").run(resolvePathsForCall(), { text: capsuleTemplate() });
    expect(good.ok).toBe(true);
    const bad = defFor("th_delegate_check").run(resolvePathsForCall(), { text: "DELEGATION CAPSULE\nAgent: x\n" });
    expect(bad.ok).toBe(false);
    expect((bad.data?.missing as string[]).length).toBeGreaterThan(0);
  });

  it("th_delegate_pack emits the handoff envelope", () => {
    const res = defFor("th_delegate_pack").run(resolvePathsForCall(), { agent: "spec", intent: "artifact" });
    expect(res.ok).toBe(true);
    expect(res.data?.agent).toBe("spec");
  });

  it("the three delegate tools advertise additionalProperties:false", () => {
    for (const name of ["th_delegate_plan", "th_delegate_pack", "th_delegate_check"]) {
      expect(defFor(name).inputSchema.additionalProperties).toBe(false);
      expect(defFor(name).inputSchema.required).toBeUndefined();
    }
  });
});

// ===========================================================================
// SLICE-5 / TASK-012+013 — REQ-RU-063: Orchestrator can call repo MCP tools
// structurally (typed def.run(paths, args) calls, not shell-text parsing).
// Must be GREEN now.
// ===========================================================================

describe("SLICE-5 / TASK-012+013 — REQ-RU-063: repo MCP tools are structurally callable", () => {
  function defFor(name: string) {
    const d = TOOL_DEFS.find((t) => t.name === name);
    if (!d) throw new Error(`missing tool ${name}`);
    return d;
  }

  // Anchor: REQ-RU-063
  it("REQ-RU-063 — test_REQ-RU-063_mcp_tools_structurally_callable: th_repo_map is callable as typed def.run(paths, args)", () => {
    tp = makeTempProject();
    // Typed call — not shell text parsing.
    const res = defFor("th_repo_map").run(tp.paths, { write: false });
    expect(typeof res.ok).toBe("boolean");
    expect(res.ok).toBe(true);
    // Structured data payload (not just a string).
    expect(res.data).toBeDefined();
    expect(typeof (res.data as Record<string, unknown>).counts).toBe("object");
  });

  // Anchor: REQ-RU-063
  it("REQ-RU-063 — th_repo_relevant is callable as typed def.run(paths, args) — returns CommandResult, not throw", () => {
    tp = makeTempProject();
    // No map yet — must return a clean failure, never throw.
    const res = defFor("th_repo_relevant").run(tp.paths, { query: "context" });
    expect(typeof res.ok).toBe("boolean");
    // Structured failure (map_missing), not an exception.
    expect(res.ok).toBe(false);
    expect((res.data as Record<string, unknown>).error).toBe("map_missing");
  });

  // Anchor: REQ-RU-063
  it("REQ-RU-063 — th_repo_impact is callable as typed def.run(paths, args) — returns CommandResult, not throw", () => {
    tp = makeTempProject();
    const res = defFor("th_repo_impact").run(tp.paths, { component: "src/commands" });
    expect(typeof res.ok).toBe("boolean");
    expect(res.ok).toBe(false);
    expect((res.data as Record<string, unknown>).error).toBe("map_missing");
  });

  // Anchor: REQ-RU-063
  it("REQ-RU-063 — th_context_pack is callable as typed def.run(paths, args) on an initialized project", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const res = defFor("th_context_pack").run(tp.paths, {});
    expect(typeof res.ok).toBe("boolean");
    expect(res.ok).toBe(true);
    // Data payload matches the §9 bundle shape.
    expect(typeof (res.data as Record<string, unknown>).totalTokens).toBe("number");
    expect(Array.isArray((res.data as Record<string, unknown>).artifacts)).toBe(true);
  });

  // Anchor: REQ-RU-063
  it("REQ-RU-063 — all four repo MCP tools: none throws when called structurally on an empty project", () => {
    tp = makeTempProject();
    for (const name of ["th_repo_map", "th_repo_relevant", "th_repo_impact"]) {
      const fn = () => defFor(name).run(tp.paths, {});
      // Typed call — never throws (Critical Pattern 1 / REQ-NFR-003).
      expect(fn).not.toThrow();
      const res = fn();
      expect(typeof res.ok).toBe("boolean");
    }
  });
});

// ===========================================================================
// Coordination tools — round-trip the 12 new MCP tools through def.run(paths,
// args) exactly as the existing delegate/decision batteries do: find the ToolDef
// by name in TOOL_DEFS, call its run closure against a temp project, assert the
// CommandResult delegates to the real handler. Covers build-dispatch/plan,
// debate add/list/resolve, collab fragment/list, and the artifact section leases.
// ===========================================================================

describe("MCP coordination tools delegate to their handlers (locked, real state)", () => {
  function defFor(name: string) {
    const d = TOOL_DEFS.find((t) => t.name === name);
    if (!d) throw new Error(`missing tool ${name}`);
    return d;
  }

  it("th_build_dispatch on an initialized project returns the live wave payload (ok)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const res = defFor("th_build_dispatch").run(tp.paths, {});
    expect(res.ok).toBe(true);
    // Structured payload from runBuildDispatch: a wave array (empty on a fresh init).
    expect(Array.isArray((res.data as Record<string, unknown>).wave)).toBe(true);
  });

  it("th_build_plan schedules conflict-free waves on an initialized project (ok)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const res = defFor("th_build_plan").run(tp.paths, { advise: true });
    expect(res.ok).toBe(true);
    expect(res.data).toBeDefined();
  });

  it("th_debate_add increments open_blocking, th_debate_list reflects it, th_debate_resolve clears it", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});

    const added = defFor("th_debate_add").run(tp.paths, {
      topic: "queue vs. stream",
      positions: "A: queue; B: stream",
      links: "REQ-001",
    });
    expect(added.ok).toBe(true);
    expect(added.data?.status).toBe("open");
    expect(added.data?.debate_open_blocking).toBe(1);
    const id = added.data?.id as string;
    expect(id).toMatch(/^DEBATE-/);

    // The open debate appears in the list with the live open_blocking count.
    const listed = defFor("th_debate_list").run(tp.paths, {});
    expect(listed.ok).toBe(true);
    expect((listed.data as Record<string, unknown>).open_blocking).toBe(1);
    const entries = (listed.data as Record<string, { id: string }[]>).entries;
    expect(entries.some((e) => e.id === id)).toBe(true);

    // Resolving the debate decrements the blocking counter back to 0.
    const resolved = defFor("th_debate_resolve").run(tp.paths, { id, resolution: "chose stream" });
    expect(resolved.ok).toBe(true);
    expect(resolved.data?.status).toBe("resolved");
    expect(resolved.data?.debate_open_blocking).toBe(0);
  });

  it("th_collab_fragment writes an anchored fragment, th_collab_list returns it", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});

    const frag = defFor("th_collab_fragment").run(tp.paths, {
      stage: "architecture",
      round: "r1",
      name: "builder-a.md",
      // The fragment carries a REQ-ID anchor so it would survive a merge (§17).
      text: "## REQ-001\nProposal: bound the queue depth.\n",
    });
    expect(frag.ok).toBe(true);
    expect(frag.data?.name).toBe("builder-a.md");

    const listed = defFor("th_collab_list").run(tp.paths, { stage: "architecture" });
    expect(listed.ok).toBe(true);
    const fragments = (listed.data as Record<string, { name: string }[]>).fragments;
    expect(fragments.some((f) => f.name === "builder-a.md")).toBe(true);
  });

  it("th_artifact_leases is empty (ok) on a fresh project; claim then leases lists the lease", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});

    // Empty list on a fresh project.
    const empty = defFor("th_artifact_leases").run(tp.paths, {});
    expect(empty.ok).toBe(true);
    expect((empty.data as Record<string, unknown[]>).leases).toEqual([]);

    // Claim a section, then the active-leases list reflects it.
    const section = "docs/04-architecture.md#data-model";
    const claim = defFor("th_artifact_claim").run(tp.paths, { section, holder: "builder-a" });
    expect(claim.ok).toBe(true);

    const after = defFor("th_artifact_leases").run(tp.paths, {});
    expect(after.ok).toBe(true);
    const leases = (after.data as Record<string, { section: string; holder: string }[]>).leases;
    expect(leases.some((l) => l.section === section && l.holder === "builder-a")).toBe(true);
  });
});

describe("REQ-MCP-PATHS-001: project root resolution prefers CLAUDE_PROJECT_DIR", () => {
  it("resolvePathsForCall honors CLAUDE_PROJECT_DIR, falling back to cwd", () => {
    const saved = process.env.CLAUDE_PROJECT_DIR;
    try {
      // Normalize through realpath up front: on macOS os.tmpdir() is a symlink
      // (/var -> /private/var) and resolveProjectPaths uses path.resolve (not
      // realpath), so the dir must already be real for the equality to hold on
      // every OS (Linux/Windows tmpdirs aren't symlinked, so this is a no-op there).
      const dir = fs.realpathSync(fs.mkdtempSync(path.join(require("node:os").tmpdir(), "th-mcp-root-")));
      process.env.CLAUDE_PROJECT_DIR = dir;
      expect(resolvePathsForCall().root).toBe(dir);
      fs.rmSync(dir, { recursive: true, force: true });
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = saved;
    }
  });
});

describe("REQ-MCP-BOUNDARY-001: the zero-dependency CLI stays SDK-free; the MCP bundle ships", () => {
  it("dist/cli.js does NOT contain the string '@modelcontextprotocol' (CLI stays SDK-free)", () => {
    const cli = fs.readFileSync(path.join(ROOT, "dist/cli.js"), "utf8");
    expect(cli.includes("@modelcontextprotocol")).toBe(false);
  });

  it("dist/mcp-server.js exists (the bundled adapter is built)", () => {
    expect(fs.existsSync(path.join(ROOT, "dist/mcp-server.js"))).toBe(true);
  });

  it("dist/mcp-server.js is bundled (the SDK is inlined, not an external require)", () => {
    const bundle = fs.readFileSync(path.join(ROOT, "dist/mcp-server.js"), "utf8");
    // The SDK source is present (bundled in)…
    expect(bundle.includes("modelcontextprotocol")).toBe(true);
    // …and there is no leftover external require of the package (would need node_modules at runtime).
    expect(/require\(["']@modelcontextprotocol/.test(bundle)).toBe(false);
  });
});

// ===========================================================================
// Interview + init tools (38→42) — th_interview_*/th_init wiring + invariants.
// ===========================================================================

describe("Interview/init MCP tools: th_interview_* + th_init (store-only, idempotent, no force)", () => {
  function defFor(name: string) {
    const d = TOOL_DEFS.find((t) => t.name === name);
    if (!d) throw new Error(`missing tool ${name}`);
    return d;
  }

  it("th_interview_start → record → status round-trips and flips ready once ambiguity ≤ threshold", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});

    const start = defFor("th_interview_start").run(tp.paths, { idea: "build a CLI", threshold: 0.2 });
    expect(start.ok).toBe(true);

    // A high-ambiguity round: not yet ready.
    const r1 = defFor("th_interview_record").run(tp.paths, {
      question: "What is the goal?",
      answer: "Ship a deterministic CLI.",
      scores: JSON.stringify({ goal: 0.5, constraints: 0.4, criteria: 0.3 }),
      ambiguity: 0.5,
      entities: JSON.stringify(["cli", "harness"]),
    });
    expect(r1.ok).toBe(true);
    expect(r1.data?.ready).toBe(false);

    // A low-ambiguity round at/below the threshold: ready flips true.
    const r2 = defFor("th_interview_record").run(tp.paths, {
      question: "Any constraints?",
      answer: "Zero runtime deps.",
      scores: JSON.stringify({ goal: 0.1, constraints: 0.1, criteria: 0.1 }),
      ambiguity: 0.1,
    });
    expect(r2.ok).toBe(true);
    expect(r2.data?.ready).toBe(true);

    const status = defFor("th_interview_status").run(tp.paths, {});
    expect(status.ok).toBe(true);
    expect(status.data?.rounds).toBe(2);
    expect(status.data?.ambiguity).toBe(0.1);
    expect(status.data?.threshold).toBe(0.2);
    expect(status.data?.ready).toBe(true);
  });

  it("th_init is idempotent on an already-initialized project (returns already_initialized, does not clobber state.json)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    // Mutate the live state so we can detect a clobber.
    runStateSet(tp.paths, "summaries_index", "custom-summary.md");
    const before = fs.readFileSync(tp.paths.stateFile, "utf8");

    const res = defFor("th_init").run(tp.paths, { brownfield: true });
    expect(res.ok).toBe(true);
    expect(res.data?.already_initialized).toBe(true);

    // state.json is untouched (no clobber).
    const after = fs.readFileSync(tp.paths.stateFile, "utf8");
    expect(after).toBe(before);
    expect(readState(tp.paths).state?.summaries_index).toBe("custom-summary.md");
  });

  it("th_init never accepts a force property (additionalProperties:false; no force in schema)", () => {
    const schema = defFor("th_init").inputSchema;
    expect(schema.additionalProperties).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(schema.properties, "force")).toBe(false);
    // The validator rejects a force arg.
    expect(validateToolArgs("th_init", { force: true }).ok).toBe(false);
  });

  it("validateToolArgs rejects th_interview_start without the required idea", () => {
    const res = validateToolArgs("th_interview_start", {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors).toContain("idea");
  });

  // INVERSE of the GATE_OWNED refusal battery: interview_threshold is NOT gate-owned,
  // so runStateSet / th_state_set ALLOWS it (it is a free policy value, not a gate).
  it("runStateSet ALLOWS interview_threshold (not gate-owned) and th_state_set does not refuse it", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});

    const res = runStateSet(tp.paths, "interview_threshold", "0.3");
    expect(res.ok).toBe(true);
    expect(readState(tp.paths).state?.interview_threshold).toBe(0.3);

    // Via the MCP th_state_set wrapper too: not a gate_owned_field refusal.
    const viaMcp = defFor("th_state_set").run(tp.paths, { key: "interview_threshold", value: "0.15" });
    expect(viaMcp.ok).toBe(true);
    expect(readState(tp.paths).state?.interview_threshold).toBe(0.15);
  });
});
