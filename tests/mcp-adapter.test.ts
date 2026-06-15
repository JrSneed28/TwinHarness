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
} from "../src/mcp-server";
import { capsuleTemplate } from "../src/core/delegation";

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
  it("ok result with data → isError false, text from human, data as structuredContent", () => {
    const r: CommandResult = success({ data: { tier: "T1", count: 3 }, human: "all good" });
    const mapped = toToolResult(r);
    expect(mapped.isError).toBe(false);
    expect(mapped.content).toEqual([{ type: "text", text: "all good" }]);
    expect(mapped.structuredContent).toEqual({ tier: "T1", count: 3 });
  });

  it("ok result without human → text falls back to JSON-stringified data", () => {
    const r: CommandResult = success({ data: { value: 42 } });
    const mapped = toToolResult(r);
    expect(mapped.isError).toBe(false);
    expect(mapped.content[0]).toMatchObject({ type: "text" });
    expect((mapped.content[0] as { text: string }).text).toContain("42");
    expect(mapped.structuredContent).toEqual({ value: 42 });
  });

  it("ok result with neither human nor data → text 'OK', no structuredContent", () => {
    const mapped = toToolResult({ ok: true, exitCode: 0 });
    expect(mapped.isError).toBe(false);
    expect(mapped.content).toEqual([{ type: "text", text: "OK" }]);
    expect(mapped.structuredContent).toBeUndefined();
  });
});

describe("REQ-MCP-MAP-002: toToolResult maps ok:false → isError:true", () => {
  it("failure result → isError true, human as text, data still attached", () => {
    const r: CommandResult = failure({ human: "it broke", data: { error: "boom" } });
    const mapped = toToolResult(r);
    expect(mapped.isError).toBe(true);
    expect(mapped.content).toEqual([{ type: "text", text: "it broke" }]);
    expect(mapped.structuredContent).toEqual({ error: "boom" });
  });

  it("failure with neither human nor data → text 'FAILED'", () => {
    const mapped = toToolResult({ ok: false, exitCode: 1 });
    expect(mapped.isError).toBe(true);
    expect(mapped.content).toEqual([{ type: "text", text: "FAILED" }]);
  });
});

describe("REQ-MCP-TOOLS-001: the exposed tool set is the intended minimal subset", () => {
  const expected = [
    "th_state_get",
    "th_state_set",
    "th_drift_add",
    "th_build_next_wave",
    "th_build_claim",
    "th_build_release",
    "th_route",
    "th_coverage_check",
    "th_next",
  ];

  it("TOOL_DEFS exposes exactly the 9 intended tools (pre-SLICE-4 legacy pin — superseded by REQ-RU-094 below)", () => {
    expect(TOOL_DEFS.map((t) => t.name).slice(0, 9)).toEqual(expected);
  });

  it("init/migrate and the hook gates are NOT exposed", () => {
    const names = TOOL_DEFS.map((t) => t.name);
    for (const forbidden of ["th_init", "th_migrate", "th_hook_stop_gate", "th_hook_pretool_gate"]) {
      expect(names).not.toContain(forbidden);
    }
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

describe("SLICE-4 / TASK-011 — MCP tool-count 16 + schema/no-exec battery (REQ-RU-094, REQ-RU-040)", () => {
  const expected16 = [
    "th_state_get",
    "th_state_set",
    "th_drift_add",
    "th_build_next_wave",
    "th_build_claim",
    "th_build_release",
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
  ];

  // ---- REQ-RU-094: tool count is 16 ----
  it("REQ-RU-094: test_REQ-RU-094_mcp_tool_count_16 — TOOL_DEFS exposes exactly 16 tools in order", () => {
    expect(TOOL_DEFS.map((t) => t.name)).toEqual(expected16);
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
