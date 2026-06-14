import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * DOC-TRUTH (on-thesis): TwinHarness's whole premise is "mechanical truths are
 * CODE, not prose." This suite turns that premise on the project's own docs —
 * the un-checked prose that previously drifted (a stale test count, a stale
 * version badge, a stale agent count). Exact assertions for the things that have
 * a single mechanical source of truth (version, component counts); a soft,
 * non-churning floor for the raw test count (so adding a test never breaks CI).
 */

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");
const readJson = (rel: string): any => JSON.parse(read(rel));

const pkg = readJson("package.json");
const agentCount = fs.readdirSync(path.join(ROOT, "agents")).filter((f) => f.endsWith(".md")).length;
const commandCount = fs.readdirSync(path.join(ROOT, "commands")).filter((f) => f.endsWith(".md")).length;

// "10 agents", "10 specialized agents", "10 agent prompt files" → captures 10.
const AGENT_MENTION = /(\d+)\s+(?:[a-z]+\s+)?agents?\b/gi;
const DOC_FILES_WITH_AGENT_COUNTS = ["README.md", "USAGE.md", "package.json", ".claude-plugin/plugin.json"];

describe("DOC-TRUTH: docs match mechanical reality", () => {
  it("README version badge equals package.json version", () => {
    const m = read("README.md").match(/version-(\d+\.\d+\.\d+)-/);
    expect(m, "README must carry a `version-X.Y.Z-` badge").toBeTruthy();
    expect(m![1]).toBe(pkg.version);
  });

  it(".claude-plugin/plugin.json version equals package.json version", () => {
    expect(readJson(".claude-plugin/plugin.json").version).toBe(pkg.version);
  });

  it.each(DOC_FILES_WITH_AGENT_COUNTS)("%s: every stated agent count equals the real count", (rel) => {
    const mentions = [...read(rel).matchAll(AGENT_MENTION)];
    for (const m of mentions) {
      expect(
        Number(m[1]),
        `${rel} says "${m[0].trim()}" but there are ${agentCount} agent files in agents/`,
      ).toBe(agentCount);
    }
  });

  it("README test-count mentions are mutually consistent and ≥ the component floor (soft)", () => {
    const counts = [...read("README.md").matchAll(/(\d+)\s+passing\s+tests\b/gi)].map((m) => Number(m[1]));
    expect(counts.length, "README should mention a passing-test count").toBeGreaterThan(0);
    // No hardcoded exact number (would churn on every added test); just internal
    // consistency + a floor that can never legitimately regress below.
    for (const c of counts) expect(c).toBe(counts[0]);
    expect(counts[0]).toBeGreaterThanOrEqual(agentCount + commandCount);
  });
});
