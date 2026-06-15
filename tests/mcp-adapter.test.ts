import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
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
    "th_delegate_plan",
    "th_delegate_pack",
    "th_delegate_check",
  ];

  it("TOOL_DEFS exposes exactly the 12 intended tools", () => {
    expect(TOOL_DEFS.map((t) => t.name)).toEqual(expected);
  });

  it("init/migrate and the hook gates are NOT exposed", () => {
    const names = TOOL_DEFS.map((t) => t.name);
    for (const forbidden of ["th_init", "th_migrate", "th_hook_stop_gate", "th_hook_pretool_gate"]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("listTools advertises a JSON-Schema object input for every tool", () => {
    const tools = listTools();
    expect(tools.map((t) => t.name)).toEqual(expected);
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
