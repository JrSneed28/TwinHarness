/**
 * Build-ordering guard (F-8, M-1).
 *
 * `npm run build` = `tsc -p tsconfig.json && npm run build:mcp` over the SAME
 * dist/mcp-server.js. A bare `tsc` (someone "just compiling") would otherwise
 * overwrite the esbuild bundle with CJS that fails the bundle-purity guard and
 * ships an MCP server crashing ERR_MODULE_NOT_FOUND. The mandated fix is
 * structural: tsc must NOT emit dist/mcp-server.js (esbuild is the sole producer),
 * while typecheck still covers it. This test locks that configuration plus the
 * resulting bundle purity (the runtime backstop also lives in mcp-adapter.test.ts).
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "..");

function readJsonc(file: string): Record<string, unknown> {
  // tsconfig files here contain only string `//` keys, not comment syntax, so
  // plain JSON.parse is sufficient.
  return JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8")) as Record<string, unknown>;
}

describe("F-8/M-1: tsc never emits the MCP bundle (esbuild is the sole producer)", () => {
  it("tsconfig.json EXCLUDES src/mcp-server.ts from emit", () => {
    const cfg = readJsonc("tsconfig.json");
    expect(cfg.exclude).toContain("src/mcp-server.ts");
  });

  it("tsconfig.typecheck.json still TYPE-CHECKS src/mcp-server.ts (not excluded) and does not emit", () => {
    const cfg = readJsonc("tsconfig.typecheck.json");
    expect(cfg.exclude).not.toContain("src/mcp-server.ts");
    expect((cfg.compilerOptions as Record<string, unknown>).noEmit).toBe(true);
    expect(cfg.extends).toBe("./tsconfig.json");
  });

  it("the typecheck script uses the typecheck config (so the hook/verify still cover the MCP server)", () => {
    const pkg = readJsonc("package.json");
    const scripts = pkg.scripts as Record<string, string>;
    expect(scripts.typecheck).toContain("tsconfig.typecheck.json");
    expect(scripts.build).toContain("npm run build:mcp");
  });

  it("dist/mcp-server.js is the esbuild bundle (SDK inlined, no external require)", () => {
    const bundle = fs.readFileSync(path.join(ROOT, "dist/mcp-server.js"), "utf8");
    expect(bundle.includes("modelcontextprotocol")).toBe(true);
    expect(/require\(["']@modelcontextprotocol/.test(bundle)).toBe(false);
  });

  it("dist/cli.js stays SDK-free", () => {
    const cli = fs.readFileSync(path.join(ROOT, "dist/cli.js"), "utf8");
    expect(cli.includes("@modelcontextprotocol")).toBe(false);
  });
});
