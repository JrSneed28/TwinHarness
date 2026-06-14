import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Phase 4 — MCP server PLUGIN WIRING.
 *
 * Kept in its own file (not the shared plugin-manifest.test.ts) so this phase
 * does not touch a test file another phase may also edit. It pins the mechanical
 * truth that the plugin declares the `th` MCP server pointing at the built,
 * bundled adapter via `${CLAUDE_PLUGIN_ROOT}`.
 */

const ROOT = path.resolve(__dirname, "..");
const readJson = (rel: string) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8")) as Record<string, unknown>;

describe("REQ-MCP-PLUGIN-001: plugin.json declares the `th` MCP server", () => {
  it("mcpServers.th is a stdio node server invoking the bundled adapter via ${CLAUDE_PLUGIN_ROOT}", () => {
    const manifest = readJson(".claude-plugin/plugin.json");
    const servers = manifest.mcpServers as Record<string, { command?: string; args?: string[] }> | undefined;
    expect(servers).toBeDefined();
    const th = servers!.th;
    expect(th).toBeDefined();
    expect(th.command).toBe("node");
    expect(Array.isArray(th.args)).toBe(true);
    expect(th.args).toEqual(["${CLAUDE_PLUGIN_ROOT}/dist/mcp-server.js"]);
  });

  it("the declared server entrypoint exists in dist/", () => {
    // The arg path is plugin-root-relative; assert the concrete built file ships.
    expect(fs.existsSync(path.join(ROOT, "dist/mcp-server.js"))).toBe(true);
  });
});

describe("REQ-MCP-PLUGIN-002: the MCP boundary keeps the CLI zero-dependency", () => {
  it("@modelcontextprotocol/sdk and esbuild are devDependencies only (not runtime deps)", () => {
    const pkg = readJson("package.json");
    const deps = (pkg.dependencies ?? {}) as Record<string, string>;
    const devDeps = (pkg.devDependencies ?? {}) as Record<string, string>;
    // No runtime dependencies at all — the CLI's zero-runtime-dependency guarantee.
    expect(Object.keys(deps)).toHaveLength(0);
    expect(devDeps["@modelcontextprotocol/sdk"]).toBeTruthy();
    expect(devDeps["esbuild"]).toBeTruthy();
  });

  it("the build script runs tsc THEN the esbuild bundle step", () => {
    const pkg = readJson("package.json");
    const scripts = pkg.scripts as Record<string, string>;
    expect(scripts.build).toContain("tsc");
    expect(scripts.build).toContain("build:mcp");
    // build:mcp bundles mcp-server.ts into dist/mcp-server.js (cjs, node platform).
    expect(scripts["build:mcp"]).toContain("esbuild");
    expect(scripts["build:mcp"]).toContain("--bundle");
    expect(scripts["build:mcp"]).toContain("--format=cjs");
    expect(scripts["build:mcp"]).toContain("dist/mcp-server.js");
  });
});
