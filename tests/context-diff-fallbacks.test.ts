/**
 * context-diff-fallbacks.test.ts — T3 (S2/D-12/D-13) unit tests.
 *
 * Coverage:
 *   AC-5:  delta reconstructs exactly (round-trip identity)
 *   Fallbacks ⇒ FULL: ratio > threshold, hunks > max, binary content,
 *                     base-not-resident flag, base-object-miss (5d),
 *                     sensitive flag, denylist locator.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  computeDelta,
  reconstruct,
  assertBaseObjectPresent,
  isDenylisted,
  DIFF_RATIO_THRESHOLD,
  DIFF_MAX_HUNKS,
  MAX_DIFF_LINES,
} from "../src/core/context-diff";
import { hashContent } from "../src/core/hash";
import { coldStorePut } from "../src/core/context-page";
import type { ProjectPaths } from "../src/core/paths";

// ---------------------------------------------------------------------------
// Test-fixture paths helper
// ---------------------------------------------------------------------------

function makePaths(tmpDir: string): ProjectPaths {
  return {
    projectRoot: tmpDir,
    stateDir: path.join(tmpDir, ".twinharness"),
    statePath: path.join(tmpDir, ".twinharness", "state.json"),
    distDir: path.join(tmpDir, "dist"),
  } as ProjectPaths;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLines(n: number, prefix = "line"): string {
  return Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join("\n");
}

// ---------------------------------------------------------------------------
// AC-5: round-trip (delta → reconstruct == currentContent)
// ---------------------------------------------------------------------------

describe("AC-5: reconstruct round-trip", () => {
  it("identical contents produce empty hunks and reconstruct correctly", () => {
    const content = "function foo() {\n  return 42;\n}\n";
    const result = computeDelta(content, content);
    expect(result).not.toHaveProperty("fallback");
    const patch = result as import("../src/core/context-diff").DeltaPatch;
    expect(patch.hunks).toHaveLength(0);
    expect(reconstruct(content, patch)).toBe(content);
  });

  it("single line change round-trips exactly", () => {
    const base = "line1\nline2\nline3";
    const current = "line1\nLINE2\nline3";
    const result = computeDelta(base, current);
    expect(result).not.toHaveProperty("fallback");
    const patch = result as import("../src/core/context-diff").DeltaPatch;
    expect(reconstruct(base, patch)).toBe(current);
  });

  it("multi-hunk change round-trips exactly", () => {
    const base = makeLines(30);
    // Change lines 2 and 25
    const currentLines = base.split("\n");
    currentLines[1] = "CHANGED LINE 2";
    currentLines[24] = "CHANGED LINE 25";
    const current = currentLines.join("\n");
    const result = computeDelta(base, current);
    expect(result).not.toHaveProperty("fallback");
    const patch = result as import("../src/core/context-diff").DeltaPatch;
    expect(reconstruct(base, patch)).toBe(current);
  });

  it("inserted lines round-trip exactly", () => {
    const base = "alpha\nbeta\ngamma";
    const current = "alpha\nINSERTED\nbeta\ngamma";
    const result = computeDelta(base, current);
    expect(result).not.toHaveProperty("fallback");
    const patch = result as import("../src/core/context-diff").DeltaPatch;
    expect(reconstruct(base, patch)).toBe(current);
  });

  it("deleted lines round-trip exactly", () => {
    const base = "alpha\nbeta\ngamma\ndelta";
    const current = "alpha\ndelta";
    const result = computeDelta(base, current);
    expect(result).not.toHaveProperty("fallback");
    const patch = result as import("../src/core/context-diff").DeltaPatch;
    expect(reconstruct(base, patch)).toBe(current);
  });

  it("patch carries correct base_hash and current_hash", () => {
    const base = "foo\nbar";
    const current = "foo\nbaz";
    const result = computeDelta(base, current);
    expect(result).not.toHaveProperty("fallback");
    const patch = result as import("../src/core/context-diff").DeltaPatch;
    expect(patch.base_hash).toBe(hashContent(base));
    expect(patch.current_hash).toBe(hashContent(current));
  });

  it("reconstruct is deterministic across calls", () => {
    const base = "a\nb\nc\nd\ne";
    const current = "a\nX\nc\nd\nY";
    const result = computeDelta(base, current);
    const patch = result as import("../src/core/context-diff").DeltaPatch;
    expect(reconstruct(base, patch)).toBe(reconstruct(base, patch));
  });
});

// ---------------------------------------------------------------------------
// Fallback: ratio > DIFF_RATIO_THRESHOLD
// ---------------------------------------------------------------------------

describe("fallback: diff ratio > threshold", () => {
  it("completely different content falls back to FULL", () => {
    const base = makeLines(10, "base");
    const current = makeLines(10, "current");
    const result = computeDelta(base, current, { ratioThreshold: 0.5 });
    expect(result).toMatchObject({ fallback: "FULL" });
    expect((result as { reason: string }).reason).toMatch(/ratio/);
  });

  it("near-identical content does NOT fall back when ratio is low", () => {
    const base = makeLines(20, "line");
    const currentLines = base.split("\n");
    currentLines[0] = "CHANGED";
    const current = currentLines.join("\n");
    const result = computeDelta(base, current);
    // ratio = 2 changed / 20 total = 0.1, well below 0.6
    expect(result).not.toHaveProperty("fallback");
  });

  it("custom ratioThreshold is respected", () => {
    const base = makeLines(10, "a");
    const currentLines = base.split("\n");
    currentLines[0] = "CHANGED";
    currentLines[1] = "CHANGED2";
    const current = currentLines.join("\n");
    // Default threshold 0.6 would pass, but threshold=0.1 forces FULL
    const result = computeDelta(base, current, { ratioThreshold: 0.1 });
    expect(result).toMatchObject({ fallback: "FULL" });
  });
});

// ---------------------------------------------------------------------------
// Fallback: hunks > DIFF_MAX_HUNKS
// ---------------------------------------------------------------------------

describe("fallback: hunk count > max", () => {
  it("many scattered single-line changes exceed hunk limit", () => {
    // Build a 100-line file where every 8th line is changed → many isolated hunks
    const baseLines = makeLines(100, "stable").split("\n");
    const currentLines = [...baseLines];
    // Change lines at intervals > 2*contextLines (3 context lines → gap must be > 6)
    // so each change forms its own hunk
    for (let i = 0; i < 100; i += 8) {
      currentLines[i] = `CHANGED-${i}`;
    }
    const base = baseLines.join("\n");
    const current = currentLines.join("\n");
    const result = computeDelta(base, current, { maxHunks: 3 });
    expect(result).toMatchObject({ fallback: "FULL" });
    expect((result as { reason: string }).reason).toMatch(/hunks/);
  });

  it("custom maxHunks=0 always falls back when any change exists", () => {
    const base = "a\nb\nc";
    const current = "a\nX\nc";
    const result = computeDelta(base, current, { maxHunks: 0 });
    expect(result).toMatchObject({ fallback: "FULL" });
  });
});

// ---------------------------------------------------------------------------
// Fallback: oversized input (size pre-check before Myers diff)
// ---------------------------------------------------------------------------

describe("fallback: oversized input (too-large)", () => {
  it("oversized dissimilar pair returns FULL/too-large WITHOUT running full Myers", () => {
    // 4000 + 4000 = 8000 combined lines, well over MAX_DIFF_LINES (5000), and
    // fully dissimilar — the worst case for myersDiff (D ≈ N+M). The pre-check
    // must short-circuit before the O(N·D) diff allocates/snapshots anything.
    const n = 4000;
    const base = makeLines(n, "base");
    const current = makeLines(n, "current");

    const start = Date.now();
    const result = computeDelta(base, current);
    const elapsedMs = Date.now() - start;

    expect(result).toMatchObject({ fallback: "FULL", reason: "too-large" });
    // If Myers ran on a 4000x4000 dissimilar pair this would take seconds and
    // allocate ~1 GB; the guard makes it effectively instant.
    expect(elapsedMs).toBeLessThan(500);
  });

  it("input at the cap (<= MAX_DIFF_LINES) still diffs normally", () => {
    // Combined line count <= MAX_DIFF_LINES must NOT trip the pre-check. Use a
    // near-identical pair so ratio/hunk fallbacks also stay clear.
    const half = Math.floor(MAX_DIFF_LINES / 2) - 1; // base + current <= cap
    const baseLines = makeLines(half, "line").split("\n");
    const currentLines = [...baseLines];
    currentLines[0] = "CHANGED";
    const base = baseLines.join("\n");
    const current = currentLines.join("\n");

    const result = computeDelta(base, current);
    expect(result).not.toHaveProperty("fallback");
  });
});

// ---------------------------------------------------------------------------
// Fallback: binary content
// ---------------------------------------------------------------------------

describe("fallback: binary content", () => {
  it("base content with NUL byte falls back to FULL", () => {
    const base = "hello\x00world";
    const current = "hello world";
    const result = computeDelta(base, current);
    expect(result).toMatchObject({ fallback: "FULL", reason: "binary" });
  });

  it("current content with NUL byte falls back to FULL", () => {
    const base = "hello world";
    const current = "hello\x00world";
    const result = computeDelta(base, current);
    expect(result).toMatchObject({ fallback: "FULL", reason: "binary" });
  });
});

// ---------------------------------------------------------------------------
// Fallback: base-not-resident flag
// ---------------------------------------------------------------------------

describe("fallback: base-not-resident", () => {
  it("returns FULL with reason base-not-resident when flag is true", () => {
    const base = "some content";
    const current = "some other content";
    const result = computeDelta(base, current, { baseNotResident: true });
    expect(result).toMatchObject({ fallback: "FULL", reason: "base-not-resident" });
  });

  it("does NOT fall back when baseNotResident is false (default)", () => {
    // Use multi-line content so that a single-line change keeps ratio well below 0.6.
    const base = "line1\nline2\nline3\nline4\nline5";
    const current = "line1\nline2\nCHANGED\nline4\nline5";
    const result = computeDelta(base, current, { baseNotResident: false });
    expect(result).not.toHaveProperty("fallback");
  });
});

// ---------------------------------------------------------------------------
// Fallback: base-object-miss (5d enforcement)
// ---------------------------------------------------------------------------

describe("5d: base-object-miss ⇒ FULL", () => {
  let tmpDir: string;
  let paths: ProjectPaths;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-diff-test-"));
    paths = makePaths(tmpDir);
  });

  it("falls back to FULL when base hash is not in cold store", () => {
    const base = "export function foo() { return 1; }";
    const current = "export function foo() { return 2; }";
    const missingHash = hashContent("something that is not in the store");

    const result = computeDelta(base, current, { paths, baseHash: missingHash });
    expect(result).toMatchObject({ fallback: "FULL", reason: "base-object-miss" });
  });

  it("does NOT fall back when base hash IS in cold store", () => {
    // Multi-line so that the single changed line keeps ratio below 0.6.
    const base = "export function bar() {\n  return 1;\n}\n";
    const current = "export function bar() {\n  return 2;\n}\n";
    const baseHashInStore = coldStorePut(paths, base, false);
    expect(baseHashInStore).not.toBeNull();

    const result = computeDelta(base, current, { paths, baseHash: baseHashInStore! });
    expect(result).not.toHaveProperty("fallback");
  });

  it("assertBaseObjectPresent returns false when hash absent", () => {
    expect(assertBaseObjectPresent(paths, "0".repeat(64))).toBe(false);
  });

  it("assertBaseObjectPresent returns true when hash present", () => {
    const content = "cold store content";
    const objref = coldStorePut(paths, content, false);
    expect(objref).not.toBeNull();
    expect(assertBaseObjectPresent(paths, objref!)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fallback: sensitive
// ---------------------------------------------------------------------------

describe("fallback: sensitive content", () => {
  it("returns FULL when sensitive=true", () => {
    const result = computeDelta("secret value", "secret value2", { sensitive: true });
    expect(result).toMatchObject({ fallback: "FULL", reason: "sensitive" });
  });
});

// ---------------------------------------------------------------------------
// Fallback: denylist locator
// ---------------------------------------------------------------------------

describe("fallback: denylist locator", () => {
  it("falls back for .env file locator", () => {
    const result = computeDelta("API_KEY=foo", "API_KEY=bar", { locator: ".env" });
    expect(result).toMatchObject({ fallback: "FULL", reason: "denylist" });
  });

  it("falls back for credentials.json locator", () => {
    const result = computeDelta("{}", "{}", { locator: "secrets/credentials.json" });
    expect(result).toMatchObject({ fallback: "FULL", reason: "denylist" });
  });

  it("falls back for .pem file locator", () => {
    const result = computeDelta("cert", "cert2", { locator: "certs/server.pem" });
    expect(result).toMatchObject({ fallback: "FULL", reason: "denylist" });
  });

  it("does NOT fall back for a normal source file locator", () => {
    // Multi-line so that the single changed line keeps ratio below 0.6.
    const base = "export const x = 1;\nexport const y = 2;\nexport const z = 3;";
    const current = "export const x = 1;\nexport const y = 2;\nexport const z = 4;";
    const result = computeDelta(base, current, { locator: "src/core/hash.ts" });
    expect(result).not.toHaveProperty("fallback");
  });

  it("isDenylisted returns true for sensitive paths", () => {
    expect(isDenylisted(".env")).toBe(true);
    expect(isDenylisted("path/to/.env.local")).toBe(true);
    expect(isDenylisted("private_key.pem")).toBe(true);
  });

  it("isDenylisted returns false for normal source files", () => {
    expect(isDenylisted("src/core/hash.ts")).toBe(false);
    expect(isDenylisted("README.md")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Hunk content correctness
// ---------------------------------------------------------------------------

describe("hunk structure", () => {
  it("hunk lines have correct +/-/space prefixes", () => {
    const base = "line1\nline2\nline3";
    const current = "line1\nCHANGED\nline3";
    const result = computeDelta(base, current);
    const patch = result as import("../src/core/context-diff").DeltaPatch;
    const allLines = patch.hunks.flatMap((h) => h.lines);
    // Every line must start with +, -, or space
    for (const line of allLines) {
      expect(line[0]).toMatch(/^[ +\-]$/);
    }
    // Should have a delete and an insert
    expect(allLines.some((l) => l.startsWith("-"))).toBe(true);
    expect(allLines.some((l) => l.startsWith("+"))).toBe(true);
  });

  it("context lines around a change are present (DIFF_CONTEXT_LINES=3)", () => {
    const baseLines = makeLines(20, "line").split("\n");
    const currentLines = [...baseLines];
    currentLines[9] = "CHANGED LINE 10";
    const base = baseLines.join("\n");
    const current = currentLines.join("\n");
    const result = computeDelta(base, current);
    const patch = result as import("../src/core/context-diff").DeltaPatch;
    expect(patch.hunks).toHaveLength(1);
    const contextCount = patch.hunks[0]!.lines.filter((l) => l.startsWith(" ")).length;
    // Should have up to 3 context lines before and 3 after the change
    expect(contextCount).toBeGreaterThanOrEqual(3);
  });

  it("baseStart and currentStart are 1-based", () => {
    const base = "a\nb\nc";
    const current = "a\nX\nc";
    const result = computeDelta(base, current);
    const patch = result as import("../src/core/context-diff").DeltaPatch;
    expect(patch.hunks[0]!.baseStart).toBeGreaterThanOrEqual(1);
    expect(patch.hunks[0]!.currentStart).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Symbol-boundary annotation (advisory)
// ---------------------------------------------------------------------------

describe("symbol-boundary annotation", () => {
  it("annotates hunks with symbol name for TS files", () => {
    const base = [
      "export function alpha() { return 1; }",
      "export function beta() { return 2; }",
    ].join("\n");
    const current = [
      "export function alpha() { return 1; }",
      "export function beta() { return 99; }",
    ].join("\n");
    const result = computeDelta(base, current, { ext: ".ts" });
    const patch = result as import("../src/core/context-diff").DeltaPatch;
    // The changed hunk should be annotated with "beta"
    const annotated = patch.hunks.filter((h) => h.symbol !== undefined);
    expect(annotated.length).toBeGreaterThan(0);
  });

  it("no annotation for unknown extension (advisory, does not fail)", () => {
    const base = "some\ncontent";
    const current = "some\nchanged";
    const result = computeDelta(base, current, { ext: ".xyz" });
    expect(result).not.toHaveProperty("fallback");
    const patch = result as import("../src/core/context-diff").DeltaPatch;
    // No symbol annotation for unknown ext — hunks still present
    expect(patch.hunks.length).toBeGreaterThan(0);
    patch.hunks.forEach((h) => expect(h.symbol).toBeUndefined());
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("determinism", () => {
  it("computeDelta is deterministic for the same input pair", () => {
    const base = "export function foo() {\n  const x = 1;\n  return x;\n}";
    const current = "export function foo() {\n  const x = 2;\n  return x;\n}";
    const r1 = computeDelta(base, current, { ext: ".ts" });
    const r2 = computeDelta(base, current, { ext: ".ts" });
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });
});
