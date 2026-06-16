import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * REQ-PCO-060 — Phase 6 librarian wiring (AGENT/PROMPT content).
 *
 * The Librarian is a long-lived, standing repo-understanding / artifact-index
 * service: other agents ask it locate / summary questions and it answers with a
 * compact capsule, keeping large artifacts OUT of the main context window. It
 * works the repo-understanding surface (`th repo` / `th context pack`) and is
 * strictly read-only. This test asserts ONLY the agent/prompt wiring — any
 * deterministic core is covered by sibling source tests.
 */

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

describe("REQ-PCO-060: librarian prompt wiring", () => {
  it("REQ-PCO-060: librarian.md exists with name + description frontmatter", () => {
    const fm = frontmatter(read("agents/librarian.md"));
    expect(fm.name).toBe("librarian");
    expect(fm.description).toBeTruthy();
  });

  it("REQ-PCO-060: librarian.md uses disallowedTools (no restrictive `tools:` key)", () => {
    const fm = frontmatter(read("agents/librarian.md"));
    // A `tools:` allowlist would hard-exclude the MCP tools (see REQ-PCO-002);
    // isolation is expressed via disallowedTools instead.
    expect(fm.tools).toBeUndefined();
    expect(fm.disallowedTools).toBeTruthy();
  });

  it("REQ-PCO-060: librarian.md references the repo-understanding surface (th repo / th context pack)", () => {
    const librarian = read("agents/librarian.md");
    expect(librarian).toMatch(/th repo|th context pack/);
  });

  it("REQ-PCO-060: pipeline-stages.md documents the Librarian standing service", () => {
    const pipeline = read("skills/twinharness/reference/pipeline-stages-part1.md");
    expect(pipeline.toLowerCase()).toContain("librarian");
    expect(pipeline).toContain("REQ-PCO-060");
  });
});
