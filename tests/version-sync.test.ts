/**
 * Version single-source guard (ARCH-006 / CQ-004 / PKG-007).
 *
 * The MCP server previously advertised a HARDCODED `SERVER_VERSION = "0.6.2"`
 * literal that silently desynced from package.json on every version bump. It now
 * reads the version at runtime via `readServerVersion()` (mirroring cli.ts's
 * `readCliVersion()`), so the served version must always equal the authoritative
 * package.json version. This test is the regression lock: if someone reintroduces
 * a literal (or the read breaks), the served version stops matching package.json
 * and this fails.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { SERVER_VERSION, readServerVersion } from "../src/mcp-server";

/** The authoritative version straight from the repo's package.json. */
function packageJsonVersion(): string {
  // tests/ → repo root is one level up; read the SAME file the server resolves.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pkgPath = path.join(here, "..", "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: unknown };
  expect(typeof pkg.version).toBe("string");
  return pkg.version as string;
}

describe("ARCH-006: MCP SERVER_VERSION is single-sourced from package.json", () => {
  it("the advertised SERVER_VERSION equals package.json's version", () => {
    expect(SERVER_VERSION).toBe(packageJsonVersion());
  });

  it("SERVER_VERSION is a resolved version string, never the 'unknown' fallback", () => {
    // A real version was found (the bundle is shipped alongside package.json); the
    // fallback would mean the read silently failed.
    expect(SERVER_VERSION).not.toBe("unknown");
    expect(SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("readServerVersion() reads the same version dynamically (no hardcoded literal)", () => {
    expect(readServerVersion()).toBe(packageJsonVersion());
    // And it agrees with the module-load-time constant.
    expect(readServerVersion()).toBe(SERVER_VERSION);
  });
});
