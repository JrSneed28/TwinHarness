import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * REQ-PCO-050 — Phase 5 red-team wiring (AGENT/PROMPT content).
 *
 * The Red-Team is a standing adversarial agent: it runs CONCURRENTLY with the
 * downstream design/build stages and posts attacks (security/failure
 * challenges) to the shared blackboard via `th collab`, so its findings reach
 * the producers without a main-context round-trip. This test asserts ONLY the
 * agent/prompt wiring — any deterministic core is covered by sibling source
 * tests.
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

describe("REQ-PCO-050: red-team prompt wiring", () => {
  it("REQ-PCO-050: red-team.md exists with name + description frontmatter", () => {
    const fm = frontmatter(read("agents/red-team.md"));
    expect(fm.name).toBe("red-team");
    expect(fm.description).toBeTruthy();
  });

  it("REQ-PCO-050: red-team.md uses disallowedTools (no restrictive `tools:` key)", () => {
    const fm = frontmatter(read("agents/red-team.md"));
    // A `tools:` allowlist would hard-exclude the MCP tools (see REQ-PCO-002);
    // isolation is expressed via disallowedTools instead.
    expect(fm.tools).toBeUndefined();
    expect(fm.disallowedTools).toBeTruthy();
  });

  it("REQ-PCO-050: red-team.md posts attacks to the blackboard via th collab", () => {
    const redTeam = read("agents/red-team.md");
    expect(redTeam).toContain("th collab");
  });

  it("REQ-PCO-050: red-team.md notes concurrent operation with downstream stages", () => {
    const redTeam = read("agents/red-team.md").toLowerCase();
    expect(redTeam).toMatch(/concurrent|parallel|alongside|continuous/);
  });

  it("REQ-PCO-050: pipeline-stages.md wires the red-team (concurrent + blackboard)", () => {
    const pipeline = read("skills/twinharness/reference/pipeline-stages.md");
    const lower = pipeline.toLowerCase();
    expect(lower).toContain("red-team");
    expect(lower).toMatch(/concurrent|parallel|alongside|continuous/);
    expect(pipeline).toContain("th collab");
  });
});
