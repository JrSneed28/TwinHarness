/**
 * context-equivalence-harness.test.ts — T9m (S7/D-21/AC-11) unit tests.
 *
 * Coverage:
 *   AC-11: run-twice zero divergence on all 7 dimensions when outcomes match
 *          divergence correctly detected when any dimension differs
 *          reduction reported when token_usage present on both runs
 *   Corpus: writeCorpusEntry / readCorpusEntry / listCorpusEntries
 *   Promotion gate: isPromotionReady at N=10
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  runEquivalence,
  isPromotionReady,
  writeCorpusEntry,
  readCorpusEntry,
  listCorpusEntries,
  corpusCategoryDir,
  WORKLOAD_CATEGORIES,
  EQUIVALENCE_DIMENSIONS,
  PROMOTION_CLEAN_RUNS,
  type RunArtifact,
  type EquivalenceVerdict,
} from "../src/core/context-equivalence";
import type { ProjectPaths } from "../src/core/paths";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePaths(tmpDir: string): ProjectPaths {
  return {
    projectRoot: tmpDir,
    stateDir: path.join(tmpDir, ".twinharness"),
    statePath: path.join(tmpDir, ".twinharness", "state.json"),
    distDir: path.join(tmpDir, "dist"),
  } as ProjectPaths;
}

let tmpDir: string;
let paths: ProjectPaths;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-equiv-test-"));
  paths = makePaths(tmpDir);
});

/** Build a minimal RunArtifact with all 7 dimensions populated identically. */
function makeArtifact(sessionId: string, overrides: Partial<RunArtifact> = {}): RunArtifact {
  return {
    session_id: sessionId,
    workload_category: "test",
    ts: new Date().toISOString(),
    test: { passed: 10, failed: 0, skipped: 1, failedNames: [] },
    types: { errorCount: 0 },
    build: { success: true, artifactHashes: { "dist/index.js": "abc123" } },
    gate: {
      gatesPassed: ["gate-alpha", "gate-beta"],
      gatesFailed: [],
      approvalsGranted: ["approval-1"],
    },
    requirements: { covered: ["REQ-001", "REQ-002"], uncovered: [] },
    side_effects: [],
    blast_radius: { flags: ["data-integrity"], affectedPaths: ["src/core/hash.ts"] },
    token_usage: { origTokens: 5000, returnedTokens: 4000 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// AC-11: zero divergence when outcomes match
// ---------------------------------------------------------------------------

describe("AC-11: zero divergence on all 7 dimensions", () => {
  it("run-twice with identical artifacts ⇒ clean verdict", () => {
    const baseline = makeArtifact("sess-baseline");
    const context = makeArtifact("sess-context");
    const verdict = runEquivalence(baseline, context);
    expect(verdict.clean).toBe(true);
    expect(verdict.dimensions).toHaveLength(7);
    expect(verdict.dimensions.every((d) => !d.diverged)).toBe(true);
  });

  it("verdict covers exactly the 7 expected dimension names", () => {
    const baseline = makeArtifact("sess-b");
    const context = makeArtifact("sess-c");
    const verdict = runEquivalence(baseline, context);
    const names = verdict.dimensions.map((d) => d.dimension).sort();
    expect(names).toEqual([...EQUIVALENCE_DIMENSIONS].sort());
  });

  it("is deterministic: same inputs ⇒ same clean flag", () => {
    const baseline = makeArtifact("b1");
    const context = makeArtifact("c1");
    const v1 = runEquivalence(baseline, context);
    const v2 = runEquivalence(baseline, context);
    expect(v1.clean).toBe(v2.clean);
    expect(v1.dimensions.map((d) => d.diverged)).toEqual(v2.dimensions.map((d) => d.diverged));
  });
});

// ---------------------------------------------------------------------------
// Divergence detection per dimension
// ---------------------------------------------------------------------------

describe("divergence: tests dimension", () => {
  it("detects passed count mismatch", () => {
    const b = makeArtifact("b", { test: { passed: 10, failed: 0, skipped: 0 } });
    const c = makeArtifact("c", { test: { passed: 9, failed: 1, skipped: 0 } });
    const v = runEquivalence(b, c);
    expect(v.clean).toBe(false);
    const dim = v.dimensions.find((d) => d.dimension === "tests")!;
    expect(dim.diverged).toBe(true);
  });

  it("detects failed test name mismatch", () => {
    const b = makeArtifact("b", { test: { passed: 9, failed: 1, skipped: 0, failedNames: ["test-a"] } });
    const c = makeArtifact("c", { test: { passed: 9, failed: 1, skipped: 0, failedNames: ["test-b"] } });
    const v = runEquivalence(b, c);
    const dim = v.dimensions.find((d) => d.dimension === "tests")!;
    expect(dim.diverged).toBe(true);
  });

  it("passes when counts and names match", () => {
    const b = makeArtifact("b");
    const c = makeArtifact("c");
    const v = runEquivalence(b, c);
    const dim = v.dimensions.find((d) => d.dimension === "tests")!;
    expect(dim.diverged).toBe(false);
  });
});

describe("divergence: types dimension", () => {
  it("detects errorCount mismatch", () => {
    const b = makeArtifact("b", { types: { errorCount: 0 } });
    const c = makeArtifact("c", { types: { errorCount: 2 } });
    const v = runEquivalence(b, c);
    const dim = v.dimensions.find((d) => d.dimension === "types")!;
    expect(dim.diverged).toBe(true);
  });

  it("passes when both have 0 errors", () => {
    const b = makeArtifact("b", { types: { errorCount: 0 } });
    const c = makeArtifact("c", { types: { errorCount: 0 } });
    const v = runEquivalence(b, c);
    const dim = v.dimensions.find((d) => d.dimension === "types")!;
    expect(dim.diverged).toBe(false);
  });
});

describe("divergence: build dimension", () => {
  it("detects success flag mismatch", () => {
    const b = makeArtifact("b", { build: { success: true } });
    const c = makeArtifact("c", { build: { success: false } });
    const v = runEquivalence(b, c);
    const dim = v.dimensions.find((d) => d.dimension === "build")!;
    expect(dim.diverged).toBe(true);
  });

  it("detects artifact hash mismatch", () => {
    const b = makeArtifact("b", { build: { success: true, artifactHashes: { "out.js": "hash1" } } });
    const c = makeArtifact("c", { build: { success: true, artifactHashes: { "out.js": "hash2" } } });
    const v = runEquivalence(b, c);
    const dim = v.dimensions.find((d) => d.dimension === "build")!;
    expect(dim.diverged).toBe(true);
  });
});

describe("divergence: gate+approval dimension", () => {
  it("detects gate status mismatch", () => {
    const b = makeArtifact("b", { gate: { gatesPassed: ["g1"], gatesFailed: [], approvalsGranted: [] } });
    const c = makeArtifact("c", { gate: { gatesPassed: [], gatesFailed: ["g1"], approvalsGranted: [] } });
    const v = runEquivalence(b, c);
    const dim = v.dimensions.find((d) => d.dimension === "gate+approval")!;
    expect(dim.diverged).toBe(true);
  });

  it("order-independent comparison: sorted gates match regardless of list order", () => {
    const b = makeArtifact("b", { gate: { gatesPassed: ["g2", "g1"], gatesFailed: [], approvalsGranted: [] } });
    const c = makeArtifact("c", { gate: { gatesPassed: ["g1", "g2"], gatesFailed: [], approvalsGranted: [] } });
    const v = runEquivalence(b, c);
    const dim = v.dimensions.find((d) => d.dimension === "gate+approval")!;
    expect(dim.diverged).toBe(false);
  });
});

describe("divergence: requirement-coverage dimension", () => {
  it("detects covered-set mismatch", () => {
    const b = makeArtifact("b", { requirements: { covered: ["REQ-001"], uncovered: ["REQ-002"] } });
    const c = makeArtifact("c", { requirements: { covered: ["REQ-001", "REQ-002"], uncovered: [] } });
    const v = runEquivalence(b, c);
    const dim = v.dimensions.find((d) => d.dimension === "requirement-coverage")!;
    expect(dim.diverged).toBe(true);
  });
});

describe("divergence: side-effects dimension", () => {
  it("detects unexpected side effect in context run", () => {
    const b = makeArtifact("b", { side_effects: [] });
    const c = makeArtifact("c", { side_effects: [{ kind: "file-write", description: "wrote state.json" }] });
    const v = runEquivalence(b, c);
    const dim = v.dimensions.find((d) => d.dimension === "side-effects")!;
    expect(dim.diverged).toBe(true);
  });

  it("passes when both have no side effects", () => {
    const b = makeArtifact("b", { side_effects: [] });
    const c = makeArtifact("c", { side_effects: [] });
    const v = runEquivalence(b, c);
    const dim = v.dimensions.find((d) => d.dimension === "side-effects")!;
    expect(dim.diverged).toBe(false);
  });
});

describe("divergence: blast-radius dimension", () => {
  it("detects flag mismatch", () => {
    const b = makeArtifact("b", { blast_radius: { flags: ["authentication"], affectedPaths: [] } });
    const c = makeArtifact("c", { blast_radius: { flags: ["authentication", "money"], affectedPaths: [] } });
    const v = runEquivalence(b, c);
    const dim = v.dimensions.find((d) => d.dimension === "blast-radius")!;
    expect(dim.diverged).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-11: reduction reported
// ---------------------------------------------------------------------------

describe("AC-11: reduction reported", () => {
  it("includes reduction when both runs have token_usage", () => {
    const b = makeArtifact("b", { token_usage: { origTokens: 5000, returnedTokens: 4000 } });
    const c = makeArtifact("c", { token_usage: { origTokens: 5000, returnedTokens: 3000 } });
    const v = runEquivalence(b, c);
    expect(v.reduction).toBeDefined();
    expect(v.reduction!.savedTokens).toBe(1000);
    expect(v.reduction!.savingsPercent).toBeCloseTo(25, 0);
  });

  it("omits reduction when either run lacks token_usage", () => {
    const b = makeArtifact("b", { token_usage: undefined });
    const c = makeArtifact("c");
    const v = runEquivalence(b, c);
    expect(v.reduction).toBeUndefined();
  });

  it("reports zero savings when context returns same tokens as baseline", () => {
    const b = makeArtifact("b", { token_usage: { origTokens: 5000, returnedTokens: 4000 } });
    const c = makeArtifact("c", { token_usage: { origTokens: 5000, returnedTokens: 4000 } });
    const v = runEquivalence(b, c);
    expect(v.reduction!.savedTokens).toBe(0);
    expect(v.reduction!.savingsPercent).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Missing dimension: not measured ⇒ not diverged
// ---------------------------------------------------------------------------

describe("missing dimension fields", () => {
  it("missing test fields on both sides ⇒ not diverged", () => {
    const b = makeArtifact("b", { test: undefined });
    const c = makeArtifact("c", { test: undefined });
    const v = runEquivalence(b, c);
    const dim = v.dimensions.find((d) => d.dimension === "tests")!;
    expect(dim.diverged).toBe(false);
  });

  it("test field missing on one side ⇒ diverged", () => {
    const b = makeArtifact("b", { test: undefined });
    const c = makeArtifact("c"); // has test
    const v = runEquivalence(b, c);
    const dim = v.dimensions.find((d) => d.dimension === "tests")!;
    expect(dim.diverged).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Promotion gate
// ---------------------------------------------------------------------------

describe("isPromotionReady", () => {
  const makeVerdict = (clean: boolean): EquivalenceVerdict => ({
    clean,
    dimensions: [],
    ts: new Date().toISOString(),
  });

  it(`returns false when fewer than ${PROMOTION_CLEAN_RUNS} verdicts`, () => {
    const verdicts = Array.from({ length: PROMOTION_CLEAN_RUNS - 1 }, () => makeVerdict(true));
    expect(isPromotionReady(verdicts)).toBe(false);
  });

  it(`returns true when last ${PROMOTION_CLEAN_RUNS} are all clean`, () => {
    const verdicts = Array.from({ length: PROMOTION_CLEAN_RUNS }, () => makeVerdict(true));
    expect(isPromotionReady(verdicts)).toBe(true);
  });

  it("returns false when any of the last N verdicts is not clean", () => {
    const verdicts = [
      ...Array.from({ length: PROMOTION_CLEAN_RUNS - 1 }, () => makeVerdict(true)),
      makeVerdict(false),
    ];
    expect(isPromotionReady(verdicts)).toBe(false);
  });

  it("ignores earlier non-clean verdicts when tail is clean", () => {
    const verdicts = [
      makeVerdict(false), // old failure, should be ignored
      ...Array.from({ length: PROMOTION_CLEAN_RUNS }, () => makeVerdict(true)),
    ];
    expect(isPromotionReady(verdicts)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Corpus read / write / list
// ---------------------------------------------------------------------------

describe("corpus: writeCorpusEntry / readCorpusEntry", () => {
  it("writes and reads back an artifact for each workload category", () => {
    for (const category of WORKLOAD_CATEGORIES) {
      const artifact = makeArtifact(`sess-${category}`, { workload_category: category });
      const ok = writeCorpusEntry(paths, artifact);
      expect(ok).toBe(true);
      const retrieved = readCorpusEntry(paths, category, `sess-${category}`);
      expect(retrieved).toBeDefined();
      expect(retrieved!.session_id).toBe(`sess-${category}`);
      expect(retrieved!.workload_category).toBe(category);
    }
  });

  it("returns undefined for absent entry", () => {
    expect(readCorpusEntry(paths, "test", "no-such-session")).toBeUndefined();
  });

  it("creates category directory on first write", () => {
    const artifact = makeArtifact("sess-dir-test", { workload_category: "read" });
    writeCorpusEntry(paths, artifact);
    const dir = corpusCategoryDir(paths, "read");
    expect(fs.existsSync(dir)).toBe(true);
  });
});

describe("corpus: listCorpusEntries", () => {
  it("returns entries sorted by ts ascending", () => {
    const earlier = makeArtifact("sess-old", {
      workload_category: "bash",
      ts: "2024-01-01T00:00:00Z",
    });
    const later = makeArtifact("sess-new", {
      workload_category: "bash",
      ts: "2024-06-01T00:00:00Z",
    });
    writeCorpusEntry(paths, later);   // write later first
    writeCorpusEntry(paths, earlier);
    const list = listCorpusEntries(paths, "bash");
    expect(list[0]!.session_id).toBe("sess-old");
    expect(list[1]!.session_id).toBe("sess-new");
  });

  it("returns [] for an empty / absent category", () => {
    expect(listCorpusEntries(paths, "mcp")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Workload category enumeration
// ---------------------------------------------------------------------------

describe("WORKLOAD_CATEGORIES", () => {
  it("has exactly 5 categories", () => {
    expect(WORKLOAD_CATEGORIES).toHaveLength(5);
  });

  it("includes all expected category names", () => {
    expect(WORKLOAD_CATEGORIES).toContain("read");
    expect(WORKLOAD_CATEGORIES).toContain("bash");
    expect(WORKLOAD_CATEGORIES).toContain("test");
    expect(WORKLOAD_CATEGORIES).toContain("mcp");
    expect(WORKLOAD_CATEGORIES).toContain("planning");
  });
});
