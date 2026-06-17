import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * REQ-PCO-043 — Phase 4 debate/reconcile wiring (AGENT/PROMPT content).
 *
 * The debate flow is a prompt-level pattern: competing Spec producers emit
 * blackboard fragments, a single Reconciler agent merges/adjudicates them into
 * one coherent artifact, and the Critic gates the merge in a `debate-reconcile`
 * mode. This test asserts ONLY the agent/prompt wiring — the deterministic
 * collab/debate/lease cores (REQ-PCO-040/041/042) are covered by sibling
 * source tests.
 */

// DOC-LINT: tests in this file assert keyword/prose presence in .md agent and playbook files.
// They verify documentation completeness, not behavioral dispatch — a broken
// runtime that kept the words in the prompt would still pass.

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

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

describe("DOC-LINT: REQ-PCO-043: debate/reconcile prompt wiring", () => {
  it("DOC-LINT: REQ-PCO-043: reconciler.md exists with name + description frontmatter", () => {
    const fm = frontmatter(read("agents/reconciler.md"));
    expect(fm.name).toBe("reconciler");
    expect(fm.description).toBeTruthy();
  });

  it("DOC-LINT: REQ-PCO-043: reconciler.md uses disallowedTools (no restrictive `tools:` key)", () => {
    const fm = frontmatter(read("agents/reconciler.md"));
    // A `tools:` allowlist would hard-exclude the MCP tools (see REQ-PCO-002);
    // isolation is expressed via disallowedTools instead.
    expect(fm.tools).toBeUndefined();
    expect(fm.disallowedTools).toBeTruthy();
  });

  it("DOC-LINT: REQ-PCO-043: reconciler.md references th collab and th debate", () => {
    const reconciler = read("agents/reconciler.md");
    expect(reconciler).toContain("th collab");
    expect(reconciler).toContain("th debate");
  });

  it("DOC-LINT: REQ-PCO-043: spec.md documents a debate mode (competing producers / Pattern B)", () => {
    const spec = read("agents/spec.md");
    expect(spec.toLowerCase()).toContain("debate");
    expect(spec).toContain("Pattern B");
    // Competing producers emit blackboard fragments, not the stage artifact.
    expect(spec).toContain("th collab fragment");
  });

  it("DOC-LINT: REQ-PCO-043: critic.md documents a `debate-reconcile` mode", () => {
    const critic = read("agents/critic.md");
    expect(critic).toContain("debate-reconcile");
    expect(critic).toContain("REQ-PCO-043");
  });

  it("DOC-LINT: REQ-PCO-043: pipeline-stages.md wires the debate flow (reconciler + th debate)", () => {
    const pipeline = read("skills/twinharness/reference/pipeline-stages-part2.md");
    expect(pipeline.toLowerCase()).toContain("reconciler");
    expect(pipeline).toContain("th debate");
    expect(pipeline).toContain("REQ-PCO-043");
  });
});
