/**
 * Axis-B slice-6 (BSC-2) — the assertion-presence SENSOR unit fixtures (Lane D, deliverable 4).
 *
 * Table-tests over temp fixtures that pin the regex/lexer-grade sensor's per-REQ classification
 * (`computeAssertionPresenceGround` — Principle 6, the binding contract). Each case writes a real
 * test file under `<root>/tests`, runs the REAL sensor, and asserts the `AssertionReqSummary`
 * (`assertionCount` / `nonTrivialAssertions` / `assertionFree` / `testFiles`). The pinned
 * trivial-assertion + literal rules are exercised directly, plus the FAIL-CLOSED unparsed-file
 * rule (Go `_test.go` / Python `test_*.py` → unobserved) and the MIXED-REQ rule (one trivial +
 * one healthy JS file ⇒ NOT assertion-free).
 *
 * No `dist/` build required — runs against `src/` via vitest. Windows-safe (path.join, no shell).
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import { computeAssertionPresenceGround, type AssertionReqSummary } from "../src/core/assertion-presence";
import type { ProjectPaths } from "../src/core/paths";

let tp: TempProject | undefined;
afterEach(() => {
  tp?.cleanup();
  tp = undefined;
});

/** Write a file under `<root>/tests/<rel>` (the sensor's default scan dir). */
function writeTestFile(paths: ProjectPaths, rel: string, body: string): void {
  const abs = path.resolve(paths.root, "tests", rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, "utf8");
}

/** Run the sensor and return the summary for one reqId (or undefined if absent). */
function summaryFor(paths: ProjectPaths, reqId: string): AssertionReqSummary | undefined {
  return computeAssertionPresenceGround(paths).find((s) => s.reqId === reqId);
}

// ---------------------------------------------------------------------------
// Single-file classification table — one REQ per file, one fixture per row.
// ---------------------------------------------------------------------------

interface SingleFileCase {
  name: string;
  body: string;
  /** Expected total `expect(...)` chains. */
  assertionCount: number;
  /** Expected non-trivial count (`assertionCount` minus trivial). */
  nonTrivial: number;
  /** Expected `assertionFree` flag (`nonTrivial === 0`). */
  assertionFree: boolean;
}

const REQ = "REQ-001";

const SINGLE_FILE_CASES: SingleFileCase[] = [
  {
    name: "zero-assertion test file (empty it body) → assertionFree, 0 assertions",
    body: `// ${REQ}\nimport { it } from "vitest";\nit("x", () => {\n  const v = 1;\n});\n`,
    assertionCount: 0,
    nonTrivial: 0,
    assertionFree: true,
  },
  {
    name: "trivial literal-vs-literal expect(true).toBe(true) → assertionFree",
    body: `// ${REQ}\nimport { it, expect } from "vitest";\nit("x", () => {\n  expect(true).toBe(true);\n});\n`,
    assertionCount: 1,
    nonTrivial: 0,
    assertionFree: true,
  },
  {
    name: "trivial literal-vs-literal expect(1).toBeGreaterThan(0) → assertionFree",
    body: `// ${REQ}\nimport { it, expect } from "vitest";\nit("x", () => {\n  expect(1).toBeGreaterThan(0);\n});\n`,
    assertionCount: 1,
    nonTrivial: 0,
    assertionFree: true,
  },
  {
    name: "trivial tautology expect(x).toBe(x) → assertionFree",
    body: `// ${REQ}\nimport { it, expect } from "vitest";\nit("x", () => {\n  const x = compute();\n  expect(x).toBe(x);\n});\n`,
    assertionCount: 1,
    nonTrivial: 0,
    assertionFree: true,
  },
  {
    name: "healthy expect(result).toBe(42) → NOT assertionFree",
    body: `// ${REQ}\nimport { it, expect } from "vitest";\nit("x", () => {\n  const result = compute();\n  expect(result).toBe(42);\n});\n`,
    assertionCount: 1,
    nonTrivial: 1,
    assertionFree: false,
  },
  {
    name: "healthy no-arg matcher expect(result).toBeDefined() → NOT assertionFree (A non-literal, B undefined)",
    body: `// ${REQ}\nimport { it, expect } from "vitest";\nit("x", () => {\n  const result = compute();\n  expect(result).toBeDefined();\n});\n`,
    assertionCount: 1,
    nonTrivial: 1,
    assertionFree: false,
  },
  {
    // A no-arg matcher's argument text is the EMPTY string "" (between the parens), NOT
    // `undefined` — `firstMatcherArg` returns `text.slice(i+1, close)`. So `isLiteral("")`
    // is false ⇒ the literal-case rule does not fire and `expect(1).toBeDefined()` counts as
    // NON-trivial. (The `B === undefined` arm of the literal rule fires only when there is no
    // matcher chain at all, e.g. a bare `expect(1);`.) This pins that exact edge.
    name: "literal A with no-arg matcher expect(1).toBeDefined() → NON-trivial (B is \"\", not undefined)",
    body: `// ${REQ}\nimport { it, expect } from "vitest";\nit("x", () => {\n  expect(1).toBeDefined();\n});\n`,
    assertionCount: 1,
    nonTrivial: 1,
    assertionFree: false,
  },
  {
    // The `B === undefined` arm: a bare `expect(literal)` with NO matcher chain → trivial.
    name: "bare expect(1) with no matcher → trivial (literal A, undefined B) → assertionFree",
    body: `// ${REQ}\nimport { it, expect } from "vitest";\nit("x", () => {\n  expect(1);\n});\n`,
    assertionCount: 1,
    nonTrivial: 0,
    assertionFree: true,
  },
  {
    name: "modifier-chain expect(result).not.toBe(7) → NOT assertionFree (real matcher after .not)",
    body: `// ${REQ}\nimport { it, expect } from "vitest";\nit("x", () => {\n  const result = compute();\n  expect(result).not.toBe(7);\n});\n`,
    assertionCount: 1,
    nonTrivial: 1,
    assertionFree: false,
  },
];

describe("BSC-2 sensor — single-file per-REQ classification (pinned trivial rule)", () => {
  for (const c of SINGLE_FILE_CASES) {
    it(c.name, () => {
      tp = makeTempProject();
      writeTestFile(tp.paths, "x.test.ts", c.body);
      const s = summaryFor(tp.paths, REQ);
      expect(s, `summary for ${REQ} should exist`).toBeDefined();
      expect(s!.assertionCount).toBe(c.assertionCount);
      expect(s!.nonTrivialAssertions).toBe(c.nonTrivial);
      expect(s!.assertionFree).toBe(c.assertionFree);
      // The math invariant: nonTrivial = count - trivial, and assertionFree iff nonTrivial===0.
      expect(s!.nonTrivialAssertions).toBeLessThanOrEqual(s!.assertionCount);
      expect(s!.assertionFree).toBe(s!.nonTrivialAssertions === 0);
      // testFiles records exactly the one recognized, POSIX-normalized test file.
      expect(s!.testFiles).toEqual(["x.test.ts"]);
    });
  }
});

// ---------------------------------------------------------------------------
// FAIL-CLOSED: a REQ whose ONLY recognized test file is UNPARSED (Go/Python) →
// assertionFree=true ("unobserved ≠ asserted"). The file is still recognized (so the REQ
// has a summary) but its assertions are never counted.
// ---------------------------------------------------------------------------

describe("BSC-2 sensor — unparsed recognized test file fails closed (unobserved)", () => {
  it("a REQ tested ONLY by a Go `_test.go` file → assertionFree (unparsed, 0 counted)", () => {
    tp = makeTempProject();
    // A Go test with a real-looking (but unparseable-to-this-sensor) assertion.
    writeTestFile(
      tp.paths,
      "feature_test.go",
      `// ${REQ}\npackage feature\nimport "testing"\nfunc TestX(t *testing.T) {\n  if got := compute(); got != 42 {\n    t.Fatalf("want 42 got %d", got)\n  }\n}\n`,
    );
    const s = summaryFor(tp.paths, REQ);
    expect(s, "the Go file is recognized so the REQ has a summary").toBeDefined();
    expect(s!.testFiles).toEqual(["feature_test.go"]);
    expect(s!.assertionCount).toBe(0); // unparsed → never scanned
    expect(s!.nonTrivialAssertions).toBe(0);
    expect(s!.assertionFree).toBe(true); // fail-closed unobserved
  });

  it("a REQ tested ONLY by a Python `test_*.py` file → assertionFree (unparsed, 0 counted)", () => {
    tp = makeTempProject();
    writeTestFile(
      tp.paths,
      "test_feature.py",
      `# ${REQ}\ndef test_x():\n    assert compute() == 42\n`,
    );
    const s = summaryFor(tp.paths, REQ);
    expect(s, "the Python file is recognized so the REQ has a summary").toBeDefined();
    expect(s!.testFiles).toEqual(["test_feature.py"]);
    expect(s!.assertionCount).toBe(0);
    expect(s!.nonTrivialAssertions).toBe(0);
    expect(s!.assertionFree).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// MIXED REQ — one trivial JS file + one healthy JS file → counts only the parseable
// assertions across BOTH; the healthy one rescues the REQ ⇒ NOT assertion-free.
// ---------------------------------------------------------------------------

describe("BSC-2 sensor — a MIXED REQ counts assertions across all its parseable files", () => {
  it("trivial file + healthy file anchoring the SAME REQ → NOT assertionFree", () => {
    tp = makeTempProject();
    writeTestFile(
      tp.paths,
      "trivial.test.ts",
      `// ${REQ}\nimport { it, expect } from "vitest";\nit("trivial", () => {\n  expect(true).toBe(true);\n});\n`,
    );
    writeTestFile(
      tp.paths,
      "healthy.test.ts",
      `// ${REQ}\nimport { it, expect } from "vitest";\nit("healthy", () => {\n  const result = compute();\n  expect(result).toBe(42);\n});\n`,
    );
    const s = summaryFor(tp.paths, REQ);
    expect(s).toBeDefined();
    // testFiles is the union of both recognized files, lexically sorted.
    expect(s!.testFiles).toEqual(["healthy.test.ts", "trivial.test.ts"]);
    // 2 total expect() chains (one per file); 1 trivial, 1 non-trivial.
    expect(s!.assertionCount).toBe(2);
    expect(s!.nonTrivialAssertions).toBe(1);
    expect(s!.assertionFree).toBe(false); // the healthy file rescues the REQ
  });

  it("a MIXED REQ with a TRIVIAL JS file + an UNPARSED Go file counts only the JS (trivial) ⇒ assertionFree", () => {
    tp = makeTempProject();
    writeTestFile(
      tp.paths,
      "trivial.test.ts",
      `// ${REQ}\nimport { it, expect } from "vitest";\nit("trivial", () => {\n  expect(true).toBe(true);\n});\n`,
    );
    writeTestFile(
      tp.paths,
      "feature_test.go",
      `// ${REQ}\npackage f\nfunc TestX(t *testing.T) { if compute() != 42 { t.Fail() } }\n`,
    );
    const s = summaryFor(tp.paths, REQ);
    expect(s).toBeDefined();
    expect(s!.testFiles).toEqual(["feature_test.go", "trivial.test.ts"]);
    // Only the JS file is parsed: 1 trivial assertion. The Go file contributes 0 (fail-closed).
    expect(s!.assertionCount).toBe(1);
    expect(s!.nonTrivialAssertions).toBe(0);
    expect(s!.assertionFree).toBe(true); // the unparsed file cannot rescue it
  });

  it("multiple healthy assertions in one file sum correctly (count/non-trivial math)", () => {
    tp = makeTempProject();
    writeTestFile(
      tp.paths,
      "multi.test.ts",
      `// ${REQ}\nimport { it, expect } from "vitest";\nit("multi", () => {\n` +
        `  expect(true).toBe(true);\n` + // trivial
        `  expect(compute()).toBe(42);\n` + // non-trivial
        `  expect(other()).toEqual({ a: 1 });\n` + // non-trivial
        `});\n`,
    );
    const s = summaryFor(tp.paths, REQ);
    expect(s).toBeDefined();
    expect(s!.assertionCount).toBe(3);
    expect(s!.nonTrivialAssertions).toBe(2);
    expect(s!.assertionFree).toBe(false);
  });
});
