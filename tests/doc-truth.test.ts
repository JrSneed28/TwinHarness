import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { TOOL_DEFS } from "../src/mcp-server";

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

// ---------------------------------------------------------------------------
// STALE-STRING GREP-FAIL (H-3, H-4)
// Scan README.md, CHANGELOG.md, and tracked spec/**. These are the only
// authoritative shipped docs. We deliberately EXCLUDE docs/ and drift-log.md
// because those are gitignored historical/local artifacts (docs/ holds
// per-run working files; drift-log.md is a per-project append-only ledger)
// — they are never shipped and their content is not authoritative for the
// tool/test-count claims we are guarding here.
// ---------------------------------------------------------------------------
const STALE_GREP_SOURCES: string[] = [
  "README.md",
  "CHANGELOG.md",
  ...fs
    .readdirSync(path.join(ROOT, "spec"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => `spec/${f}`),
];

// Strings that indicate stale documentation that must never appear in the
// scanned files. Each entry is a literal substring (case-sensitive).
// "26 " followed by "failures" is a special two-part pattern — see below.
const STALE_LITERALS = ["23 tools", "23-tool", "848 passing", "874 total", "271+"];
// "26 failures" is checked separately as a two-part regex to avoid false
// positives on the legitimate phrase "26 pre-existing failures" which no
// longer appears but could be re-introduced accidentally.
const STALE_26_FAILURES_RE = /\b26 failures\b/;

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

  // -------------------------------------------------------------------------
  // TOOL-COUNT ASSERTIONS (H-3): every "N tools" / "N-tool" numeric claim in
  // README.md must equal TOOL_DEFS.length (the mechanical source of truth).
  // -------------------------------------------------------------------------
  it("TOOL_DEFS.length equals 35", () => {
    expect(TOOL_DEFS.length).toBe(35);
  });

  it("README: every 'N tools' / 'N-tool' numeric claim equals TOOL_DEFS.length", () => {
    const content = read("README.md");
    // Match "35 tools", "35-tool", "exactly 35 tools", etc.
    const toolMentions = [
      ...content.matchAll(/(\d+)\s+tools?\b/gi),
      ...content.matchAll(/(\d+)-tool\b/gi),
    ];
    for (const m of toolMentions) {
      expect(
        Number(m[1]),
        `README says "${m[0].trim()}" but TOOL_DEFS.length is ${TOOL_DEFS.length}`,
      ).toBe(TOOL_DEFS.length);
    }
  });

  // -------------------------------------------------------------------------
  // GREP-FAIL: stale strings must not appear in shipped docs (H-4).
  // Scans README.md, CHANGELOG.md, and tracked spec/**. Excludes docs/ and
  // drift-log.md (gitignored — see comment above STALE_GREP_SOURCES).
  // -------------------------------------------------------------------------
  it.each(STALE_GREP_SOURCES)("%s: must not contain stale strings", (rel) => {
    const content = read(rel);
    for (const literal of STALE_LITERALS) {
      expect(
        content,
        `${rel} contains stale string "${literal}" — update to reflect current reality`,
      ).not.toContain(literal);
    }
    // Check "26 " immediately followed by "failures" as a regex pattern
    const match26 = content.match(STALE_26_FAILURES_RE);
    expect(
      match26,
      `${rel} contains stale phrase "26 failures" — update to reflect current reality`,
    ).toBeNull();
  });

  // -------------------------------------------------------------------------
  // TEST-COUNT FLOOR (soft, H-3): count it()/test() calls across tests/**
  // and assert README's test-count phrasing is not a stale literal.
  // We count live test invocations as a mechanical floor — a soft assertion
  // because adding tests must never break CI.
  // -------------------------------------------------------------------------
  it("live test declaration count is at least 1000 (soft floor — it.each expands at runtime)", () => {
    const testDir = path.join(ROOT, "tests");
    const testFiles = fs.readdirSync(testDir).filter((f) => f.endsWith(".test.ts"));
    let total = 0;
    for (const f of testFiles) {
      const src = fs.readFileSync(path.join(testDir, f), "utf8");
      // Count `it(`, `it.each(`, and `test(` call sites (literal open-paren to avoid
      // matching prose like "it's"). Note: it.each() expands at runtime — vitest reports
      // a higher total test count than this source-level count (1100+ at runtime).
      const matches = src.match(/\bit(?:\.each)?\s*\(|\btest\s*\(/g);
      total += matches ? matches.length : 0;
    }
    // 1000 is a safe floor: the suite had 1010+ declarations before this task.
    // Vitest runtime count (which expands .each) is 1100+.
    expect(total).toBeGreaterThanOrEqual(1000);
  });

  it("README does not contain stale exact test-count literals (848 passing, 874 total)", () => {
    const content = read("README.md");
    expect(content).not.toContain("848 passing");
    expect(content).not.toContain("874 total");
  });
});
