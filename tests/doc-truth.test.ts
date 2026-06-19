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
  it("TOOL_DEFS.length equals 62", () => {
    expect(TOOL_DEFS.length).toBe(62);
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

  // -------------------------------------------------------------------------
  // EXACT TEST-COUNT BAN (P0-1): the test suite grows constantly, so any exact
  // 4-digit "NNNN tests" literal in the shipped marketing docs (README/CHANGELOG)
  // is stale the moment it is written. Enforce the soft-floor phrasing ("1000+
  // tests", "1100+ tests" — the trailing "+" breaks the `\d{4} tests` pattern)
  // instead. Scoped to README + CHANGELOG; the spec/ plan deliberately discusses
  // the old "1672 tests" literal as the thing being removed, so it is not scanned.
  // -------------------------------------------------------------------------
  it.each(["README.md", "CHANGELOG.md"])(
    "%s: contains no exact 4-digit 'NNNN tests' literal (use the soft '1000+' floor)",
    (rel) => {
      const m = read(rel).match(/\b\d{4} tests\b/);
      expect(
        m,
        `${rel} contains an exact test-count literal "${m?.[0]}" — replace with the soft-floor phrasing (e.g. "1000+ tests")`,
      ).toBeNull();
    },
  );

  // -------------------------------------------------------------------------
  // DERIVED FILE-COUNT GUARD (P1-2 / TEST-001): any "N test files" literal in
  // README must equal the mechanical *.test.ts count. Defensive — README
  // currently states "1100+ tests" (no exact file-count literal, by design, so
  // adding a test never breaks CI), but a future stale literal like
  // "81 test files" must fail this guard.
  // -------------------------------------------------------------------------
  it("README: every 'N test files' literal equals the real test-file count", () => {
    const content = read("README.md");
    const fileCount = fs
      .readdirSync(path.join(ROOT, "tests"))
      .filter((f) => f.endsWith(".test.ts")).length;
    for (const m of content.matchAll(/(\d+)\s+test files\b/gi)) {
      expect(
        Number(m[1]),
        `README says "${m[0].trim()}" but there are ${fileCount} *.test.ts files in tests/`,
      ).toBe(fileCount);
    }
  });

  // -------------------------------------------------------------------------
  // CONTRIBUTING AGENT-COUNT GUARD (P1-5 / DOC-001): both the invariants-table
  // cell ("| Agent count | N |") and the layout note ("Agent prompt files
  // (N total)") must equal the real agents/*.md count. The base AGENT_MENTION
  // regex only catches the "N agents" prose form (number BEFORE the word), so
  // these label-first / parenthesised forms need their own patterns.
  // -------------------------------------------------------------------------
  it("CONTRIBUTING.md: stated agent counts equal the real agent count", () => {
    const content = read("CONTRIBUTING.md");
    const patterns = [/Agent count\s*\|\s*(\d+)/gi, /Agent prompt files\s*\((\d+)\s+total\)/gi];
    let matched = 0;
    for (const re of patterns) {
      for (const m of content.matchAll(re)) {
        matched++;
        expect(
          Number(m[1]),
          `CONTRIBUTING says "${m[0].trim()}" but there are ${agentCount} agent files in agents/`,
        ).toBe(agentCount);
      }
    }
    expect(matched, "CONTRIBUTING must state at least one guarded agent count").toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // USAGE TOOL-COUNT GUARD (P1-6 / DOC-002): USAGE's MCP "registered count N"
  // must equal TOOL_DEFS.length, and any numeric "N tools"/"N-tool" claim in
  // USAGE must too (mirrors the README assertion at the test above). The
  // word-form "four MCP tools" describing the repo-understanding *layer*
  // (USAGE.md ~:842) is intentionally a word, not a digit, and is not matched.
  // -------------------------------------------------------------------------
  it("USAGE.md: MCP 'registered count N' equals TOOL_DEFS.length", () => {
    const content = read("USAGE.md");
    const matches = [...content.matchAll(/registered count (\d+)/gi)];
    expect(matches.length, "USAGE must state the MCP registered count").toBeGreaterThan(0);
    for (const m of matches) {
      expect(
        Number(m[1]),
        `USAGE says "registered count ${m[1]}" but TOOL_DEFS.length is ${TOOL_DEFS.length}`,
      ).toBe(TOOL_DEFS.length);
    }
  });

  it("USAGE.md: every 'N tools' / 'N-tool' numeric claim equals TOOL_DEFS.length", () => {
    const content = read("USAGE.md");
    const toolMentions = [
      ...content.matchAll(/(\d+)\s+tools?\b/gi),
      ...content.matchAll(/(\d+)-tool\b/gi),
    ];
    for (const m of toolMentions) {
      expect(
        Number(m[1]),
        `USAGE says "${m[0].trim()}" but TOOL_DEFS.length is ${TOOL_DEFS.length}`,
      ).toBe(TOOL_DEFS.length);
    }
  });

  // -------------------------------------------------------------------------
  // SKIP-COUNT TRUTH (P1-3 / DOC-003≡TEST-002): the suite has exactly ONE
  // platform-conditional skip (tests/concurrency.test.ts — skipIf win32||root).
  // verify/coverage-report no longer use POSIX-only commands, so the old
  // "6 Windows-only platform skips in verify/coverage-report" claim is false
  // and must never reappear in shipped docs.
  //
  // Note: build-artifact guards (skipIf(!existsSync(CLI))) are a separate
  // category from platform-conditional skips; this test counts only the latter
  // (patterns referencing process.platform or process.getuid) so that adding
  // build-guard skips (TEST-008/009) doesn't alter the platform-skip count.
  // -------------------------------------------------------------------------
  it("docs describe the single platform-conditional skip, not the stale '6 Windows skips'", () => {
    const skipDeclCount = fs
      .readdirSync(path.join(ROOT, "tests"))
      .filter((f) => f.endsWith(".test.ts"))
      .reduce((n, f) => {
        const src = fs.readFileSync(path.join(ROOT, "tests", f), "utf8");
        // Count only platform-conditional skips (process.platform / process.getuid),
        // not build-artifact guards (skipIf(!existsSync(...))).
        const m = src.match(/\.skipIf\s*\([^)]*process\.(?:platform|getuid)/g);
        return n + (m ? m.length : 0);
      }, 0);
    expect(skipDeclCount, "expected exactly one platform-conditional skip declaration in tests/").toBe(1);
    for (const rel of ["README.md", "CHANGELOG.md"]) {
      const content = read(rel);
      expect(content, `${rel} still claims the stale 'N Windows-only platform skips'`).not.toMatch(
        /\d+\s+Windows-only platform skips/i,
      );
      expect(content, `${rel} must reference the real skip site (concurrency.test.ts)`).toContain(
        "concurrency.test.ts",
      );
    }
  });
});
