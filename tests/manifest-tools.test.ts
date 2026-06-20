/**
 * P1-D (C-09 / C-16) — `th manifest tools` runtime tool discovery + the SDK-free
 * tool-catalog drift guard.
 *
 * `th manifest tools` is the CLI MIRROR of the MCP server's `ListTools`: it lets an
 * agent (or operator) shelling the CLI enumerate the LIVE advertised tool set
 * instead of relying on a hard-coded list. Because `dist/cli.js` must stay
 * zero-runtime-dependency and SDK-free (mcp-server.ts:15-18), the CLI cannot import
 * `TOOL_DEFS` (which lives in the `@modelcontextprotocol/sdk`-laden mcp-server
 * module). It reads `TOOL_CATALOG` — a plain-data {name, summary} projection — instead.
 *
 * These tests pin the two invariants that make that safe:
 *   1. CATALOG PARITY — `TOOL_CATALOG` mirrors `TOOL_DEFS` (name + description),
 *      in registry order, EXACTLY. A tool added/removed/renamed in `TOOL_DEFS`
 *      without updating `src/core/tool-catalog.ts` fails here (the same drift-guard
 *      idiom the order-sensitive tool-name mirrors use).
 *   2. DISCOVERY OUTPUT — `runManifestTools()` emits one entry per advertised tool
 *      (count === TOOL_DEFS.length) with the name + summary in the `--json` payload.
 *
 * `manifest tools` is a CLI-only mirror (MCP advertises tools natively), so it is
 * intentionally in BOTH `CLI_COMMAND_LEAVES` and `MCP_EXCLUDED` — the derived tool
 * count is therefore unchanged (it adds no twin). That partition invariant is
 * asserted in mcp-cli-parity.test.ts; here we pin the catalog↔registry contract.
 */

import { describe, it, expect } from "vitest";
import { TOOL_DEFS, MCP_EXCLUDED, CLI_COMMAND_LEAVES } from "../src/mcp-server";
import { TOOL_CATALOG } from "../src/core/tool-catalog";
import { runManifestTools } from "../src/commands/manifest";

describe("P1-D: TOOL_CATALOG mirrors TOOL_DEFS exactly (SDK-free drift guard)", () => {
  it("has one catalog entry per registered tool, in registry order", () => {
    const fromDefs = TOOL_DEFS.map((t) => ({ name: t.name, summary: t.description }));
    const fromCatalog = TOOL_CATALOG.map((t) => ({ name: t.name, summary: t.summary }));
    expect(
      fromCatalog,
      "src/core/tool-catalog.ts is out of sync with TOOL_DEFS — update TOOL_CATALOG (name + description, in registry order)",
    ).toEqual(fromDefs);
  });

  it("catalog length === TOOL_DEFS.length", () => {
    expect(TOOL_CATALOG.length).toBe(TOOL_DEFS.length);
  });
});

describe("P1-D: th manifest tools enumerates the advertised tool set", () => {
  it("returns one entry per tool with name + summary (count === TOOL_DEFS.length)", () => {
    const result = runManifestTools();
    expect(result.ok).toBe(true);
    const tools = result.data?.tools as Array<{ name: string; summary: string }>;
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBe(TOOL_DEFS.length);
    expect(result.data?.count).toBe(TOOL_DEFS.length);
    // Names + summaries match the registry, in order.
    expect(tools.map((t) => t.name)).toEqual(TOOL_DEFS.map((t) => t.name));
    for (const t of tools) {
      expect(typeof t.name).toBe("string");
      expect(t.name.length).toBeGreaterThan(0);
      expect(typeof t.summary).toBe("string");
      expect(t.summary.length).toBeGreaterThan(0);
    }
  });

  it("the human rendering names every tool", () => {
    const result = runManifestTools();
    for (const t of TOOL_DEFS) {
      expect(result.human).toContain(t.name);
    }
  });
});

describe("P1-D: `manifest tools` is a CLI-only mirror (no MCP twin, count unchanged)", () => {
  it("is recorded as both a live CLI leaf AND an MCP exclusion", () => {
    expect(CLI_COMMAND_LEAVES).toContain("manifest tools");
    expect(MCP_EXCLUDED["manifest tools"]).toBeTruthy();
    // Excluded → no twin tool exists for it.
    expect(TOOL_DEFS.some((t) => t.name === "th_manifest_tools")).toBe(false);
  });
});
