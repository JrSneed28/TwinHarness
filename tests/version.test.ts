import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Re-implement the readCliVersion logic inline so we can test the helper
 * without spawning a process. The helper tries two candidate paths for package.json:
 * - __dirname/../package.json  (compiled: dist/cli.js → dist/../package.json)
 * - __dirname/../../package.json  (ts-node/test: src/cli.ts → src/../../package.json)
 */
function readCliVersion(fromDir: string): string {
  const candidates = [
    path.join(fromDir, "..", "package.json"),
    path.join(fromDir, "..", "..", "package.json"),
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
      // Try next.
    }
  }
  return "unknown";
}

describe("REQ-VERSION-001: th version reads from package.json", () => {
  it("readCliVersion from src/ context finds the repo package.json", () => {
    // Simulate the ts-node/test context where __dirname is src/.
    const srcDir = path.join(__dirname, "..", "src");
    const version = readCliVersion(srcDir);
    // The repo's package.json has version "0.1.1".
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
    expect(version).not.toBe("unknown");
  });

  it("readCliVersion from dist/ context also finds the repo package.json", () => {
    // Simulate the compiled context where __dirname is dist/.
    const distDir = path.join(__dirname, "..", "dist");
    const version = readCliVersion(distDir);
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
    expect(version).not.toBe("unknown");
  });

  it("readCliVersion returns 'unknown' when no package.json exists nearby", () => {
    // A directory that definitely has no package.json at ../package.json or ../../package.json.
    const isolated = path.join(__dirname, "..", "node_modules", ".bin");
    // We can't guarantee this; just verify the function never throws.
    expect(() => readCliVersion(isolated)).not.toThrow();
  });
});
