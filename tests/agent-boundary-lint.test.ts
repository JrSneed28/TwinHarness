/**
 * Phase 5 / P5-6 — agent-boundary lint (REQ-PCO-064).
 *
 * Several agents are READ-ONLY by role: they read source, analyse, and coordinate,
 * but never author files or spawn sub-agents. That boundary is stated in prose in
 * each prompt's "What you do NOT do" section — which is not mechanically enforced.
 * This test makes the boundary MECHANICAL: every read-only agent's frontmatter MUST
 * deny Write, Edit, AND Agent via `disallowedTools`, so a future edit that quietly
 * grants one of those tools fails CI instead of silently widening the role.
 *
 * Read-only here means "does not author source/artifacts and does not spawn":
 *   - codebase-inspector / critic / red-team — analysis only.
 *   - librarian — repo-intelligence answers only.
 *   - merge-coordinator — coordinates git + th; does not author source.
 *   - researcher — read-only research (also denies Bash).
 *
 * Deliberately EXCLUDED (and why), so the boundary is a stated contract:
 *   - orchestrator: denies Write/Edit but MUST keep Agent (it is the spawner).
 *   - builder / doc-writer / spec / ux-ui-designer / vertical-slice / test-author /
 *     tester / debugger / reconciler: each legitimately authors files or runs the
 *     suite, so they are not read-only.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const AGENTS_DIR = path.resolve(__dirname, "..", "agents");

/** The read-only agents whose role forbids authoring and spawning. */
const READ_ONLY_AGENTS = [
  "codebase-inspector",
  "critic",
  "librarian",
  "merge-coordinator",
  "red-team",
  "researcher",
] as const;

/** The tools a read-only agent must deny. */
const FORBIDDEN_FOR_READ_ONLY = ["Write", "Edit", "Agent"] as const;

/** Read an agent prompt file by its `name`. */
function readAgent(name: string): string {
  return fs.readFileSync(path.join(AGENTS_DIR, `${name}.md`), "utf8");
}

/** Extract the YAML frontmatter block (between the first two `---` fences). */
function frontmatter(content: string): string {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  expect(m, "agent must open with a YAML frontmatter block").not.toBeNull();
  return m![1]!;
}

/** Parse the `disallowedTools:` CSV line into a trimmed set. */
function disallowedTools(fm: string): Set<string> {
  const line = fm.split(/\r?\n/).find((l) => /^disallowedTools:/.test(l));
  expect(line, "agent must declare a disallowedTools line").toBeTruthy();
  const csv = line!.replace(/^disallowedTools:\s*/, "");
  return new Set(csv.split(",").map((t) => t.trim()).filter(Boolean));
}

describe("REQ-PCO-064: read-only agents deny Write/Edit/Agent (mechanical role boundary)", () => {
  for (const name of READ_ONLY_AGENTS) {
    it(`REQ-PCO-064: ${name} denies Write, Edit, and Agent`, () => {
      const denied = disallowedTools(frontmatter(readAgent(name)));
      for (const tool of FORBIDDEN_FOR_READ_ONLY) {
        expect(denied.has(tool), `${name} must list ${tool} in disallowedTools`).toBe(true);
      }
    });
  }

  it("REQ-PCO-064: the orchestrator denies Write/Edit but KEEPS Agent (it is the spawner)", () => {
    const denied = disallowedTools(frontmatter(readAgent("orchestrator")));
    expect(denied.has("Write")).toBe(true);
    expect(denied.has("Edit")).toBe(true);
    // The Orchestrator must be able to spawn — Agent is intentionally NOT denied.
    expect(denied.has("Agent")).toBe(false);
  });

  it("REQ-PCO-064: every read-only agent's prompt file exists and is non-empty", () => {
    for (const name of READ_ONLY_AGENTS) {
      const content = readAgent(name);
      expect(content.length).toBeGreaterThan(0);
    }
  });
});
