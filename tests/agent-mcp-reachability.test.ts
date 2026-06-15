import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * REQ-PCO-002 — Agent MCP reachability.
 *
 * Per the Claude Code subagent spec, a `tools:` frontmatter key is a RESTRICTIVE
 * allowlist that HARD-EXCLUDES all MCP tools (subagents inherit MCP tools only
 * when `tools:` is OMITTED; there is no wildcard for the allowlist). So for the
 * `mcp__plugin_twinharness_th__*` tools to be reachable, no agent may declare a
 * `tools:` allowlist — isolation is re-expressed via a `disallowedTools:` denylist
 * instead. These are mechanical truths, so they are asserted by code.
 */

const ROOT = path.resolve(__dirname, "..");
const AGENTS_DIR = path.join(ROOT, "agents");

const read = (rel: string) => fs.readFileSync(path.join(AGENTS_DIR, rel), "utf8");

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

const agentFiles = fs
  .readdirSync(AGENTS_DIR)
  .filter((f) => f.endsWith(".md"));

const READ_ONLY_AGENTS = ["critic", "codebase-inspector", "researcher"];

describe("REQ-PCO-002: agents can reach the th MCP tools", () => {
  it("REQ-PCO-002: discovers all ten agent files", () => {
    expect(agentFiles.length).toBe(10);
  });

  it.each(agentFiles)(
    "REQ-PCO-002: %s frontmatter declares NO `tools:` allowlist (would exclude MCP)",
    (rel) => {
      const fm = frontmatter(read(rel));
      expect(fm.tools).toBeUndefined();
    },
  );

  it.each(READ_ONLY_AGENTS)(
    "REQ-PCO-002: read-only agent %s denies Write and Edit via disallowedTools",
    (name) => {
      const fm = frontmatter(read(`${name}.md`));
      const denied = fm.disallowedTools ?? "";
      expect(denied).toContain("Write");
      expect(denied).toContain("Edit");
    },
  );

  it("REQ-PCO-002: orchestrator's disallowedTools does NOT deny Agent (it must spawn)", () => {
    const fm = frontmatter(read("orchestrator.md"));
    const denied = (fm.disallowedTools ?? "")
      .split(",")
      .map((t) => t.trim());
    expect(denied).not.toContain("Agent");
  });

  it.each(agentFiles)(
    "REQ-PCO-002: %s body contains the mcp__plugin_twinharness_th__ pointer",
    (rel) => {
      expect(read(rel)).toContain("mcp__plugin_twinharness_th__");
    },
  );
});
