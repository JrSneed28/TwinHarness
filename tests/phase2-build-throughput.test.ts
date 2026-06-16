import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * REQ-PCO-020 / REQ-PCO-021 — Phase 2 build-throughput agents.
 *
 * Phase 2 adds two agents that raise parallel-build throughput while preserving
 * the single-deterministic-writer invariant:
 *
 *  - REQ-PCO-020 Merge-Coordinator — the SINGLE top-level controller that merges
 *    parallel Builders' worktree branches back into main in WAVE ORDER. On a
 *    clean merge it runs `th build release`; on a conflict between plan-disjoint
 *    slices it opens BLOCKING `th drift add --layer requirement` instead of
 *    hand-resolving.
 *  - REQ-PCO-021 Test-Author — the third corner of the per-slice triad
 *    (Builder + Test-Author + Verifier, Pattern C). Authors REQ-anchored tests
 *    concurrently with the Builder in the same worktree, routing gaps over the
 *    `delegations/` blackboard.
 *
 * Both must follow the MCP-reachability contract (REQ-PCO-002): a `disallowedTools:`
 * denylist, never a `tools:` allowlist (which would hard-exclude MCP tools). These
 * are mechanical / prose-coordination truths, so they are asserted by code.
 */

// DOC-LINT: tests in this file assert keyword/prose presence in .md agent and playbook files.
// They verify documentation completeness, not behavioral dispatch — a broken
// runtime that kept the words in the prompt would still pass.

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");
const exists = (rel: string): boolean => fs.existsSync(path.join(ROOT, rel));

/** Minimal frontmatter block parser — enough to assert key presence/values. */
function frontmatter(md: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!m || !m[1]) return {};
  const out: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (kv && kv[1] && kv[2] !== undefined) out[kv[1]] = kv[2];
  }
  return out;
}

const MERGE_COORDINATOR = "agents/merge-coordinator.md";
const TEST_AUTHOR = "agents/test-author.md";
const BUILDER = "agents/builder.md";
const BUILD_VERIFY = "skills/twinharness/reference/build-and-verify.md";

describe("DOC-LINT: REQ-PCO-020: Merge-Coordinator agent", () => {
  it("DOC-LINT: REQ-PCO-020: agents/merge-coordinator.md exists", () => {
    expect(exists(MERGE_COORDINATOR)).toBe(true);
  });

  it("DOC-LINT: REQ-PCO-020: has name: merge-coordinator + a description", () => {
    const fm = frontmatter(read(MERGE_COORDINATOR));
    expect(fm.name).toBe("merge-coordinator");
    expect(fm.description).toBeTruthy();
  });

  it("DOC-LINT: REQ-PCO-020: declares a disallowedTools denylist and NO tools allowlist (MCP reachability)", () => {
    const fm = frontmatter(read(MERGE_COORDINATOR));
    expect(fm.tools).toBeUndefined();
    expect(fm.disallowedTools).toBeTruthy();
  });

  it("DOC-LINT: REQ-PCO-020: references `th build release` for clean wave-order merges", () => {
    expect(read(MERGE_COORDINATOR)).toContain("th build release");
  });

  it("DOC-LINT: REQ-PCO-020: opens BLOCKING requirement-layer drift on a plan-disjoint conflict", () => {
    const content = read(MERGE_COORDINATOR);
    expect(content).toContain("th drift add");
    expect(content).toMatch(/--layer\s+requirement/);
    expect(content).toMatch(/BLOCKING/);
  });
});

describe("DOC-LINT: REQ-PCO-021: Test-Author agent", () => {
  it("DOC-LINT: REQ-PCO-021: agents/test-author.md exists", () => {
    expect(exists(TEST_AUTHOR)).toBe(true);
  });

  it("DOC-LINT: REQ-PCO-021: has name: test-author + a description", () => {
    const fm = frontmatter(read(TEST_AUTHOR));
    expect(fm.name).toBe("test-author");
    expect(fm.description).toBeTruthy();
  });

  it("DOC-LINT: REQ-PCO-021: declares a disallowedTools denylist and NO tools allowlist (MCP reachability)", () => {
    const fm = frontmatter(read(TEST_AUTHOR));
    expect(fm.tools).toBeUndefined();
    expect(fm.disallowedTools).toBeTruthy();
  });

  it("DOC-LINT: REQ-PCO-021: mentions the triad, concurrent REQ-anchored test authoring, and the blackboard", () => {
    const content = read(TEST_AUTHOR);
    expect(content).toMatch(/triad/i);
    expect(content).toMatch(/REQ-ID/);
    expect(content).toMatch(/concurrent|concurrently|parallel/i);
    expect(content).toContain("delegations");
  });
});

describe("DOC-LINT: REQ-PCO-021: Builder advertises the triad partnership", () => {
  it("DOC-LINT: REQ-PCO-021: builder.md references the triad and the test-author", () => {
    const content = read(BUILDER);
    expect(content).toMatch(/triad/i);
    expect(content).toContain("test-author");
  });
});

describe("DOC-LINT: REQ-PCO-020 / REQ-PCO-021: build-and-verify playbook names the new agents", () => {
  it("DOC-LINT: REQ-PCO-020: build-and-verify.md names merge-coordinator", () => {
    expect(read(BUILD_VERIFY)).toContain("merge-coordinator");
  });

  it("DOC-LINT: REQ-PCO-021: build-and-verify.md names test-author", () => {
    expect(read(BUILD_VERIFY)).toContain("test-author");
  });
});
