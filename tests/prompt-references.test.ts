import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * REQ-REFACTOR-001: Prompt reference integrity tests.
 * Asserts that after the F7 refactor:
 * (a) SKILL.md is under 520 lines and critic.md is under 360 lines (lean cores).
 * (b) Every reference/<name>.md path mentioned in the two lean files actually exists on disk.
 * (c) Each created reference file is non-empty and contains real content
 *     (at least one `th ` command or REQ/§ citation — not a stub).
 */

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const lineCount = (rel: string) => read(rel).split(/\r?\n/).length;

/** Extract all reference/<name>.md paths mentioned in a file. */
function extractReferencePaths(content: string): string[] {
  const matches = content.match(/reference\/[\w-]+\.md/g);
  return [...new Set(matches ?? [])];
}

describe("REQ-REFACTOR-001a: lean core file sizes", () => {
  it("skills/twinharness/SKILL.md is under 520 lines", () => {
    const count = lineCount("skills/twinharness/SKILL.md");
    expect(count).toBeLessThan(520);
  });

  it("agents/critic.md is under 360 lines", () => {
    const count = lineCount("agents/critic.md");
    expect(count).toBeLessThan(360);
  });
});

describe("REQ-REFACTOR-001b: every referenced file exists on disk", () => {
  const skillContent = read("skills/twinharness/SKILL.md");
  const criticContent = read("agents/critic.md");
  const allRefs = [
    ...extractReferencePaths(skillContent),
    ...extractReferencePaths(criticContent),
  ];
  const uniqueRefs = [...new Set(allRefs)];

  it("at least one reference file is mentioned in the lean core files", () => {
    expect(uniqueRefs.length).toBeGreaterThan(0);
  });

  it.each(uniqueRefs)(
    "skills/twinharness/%s exists on disk",
    (refPath) => {
      const fullPath = path.join(ROOT, "skills/twinharness", refPath);
      expect(fs.existsSync(fullPath)).toBe(true);
    },
  );
});

describe("REQ-REFACTOR-001c: reference files contain real moved content", () => {
  const referenceDir = path.join(ROOT, "skills/twinharness/reference");

  it("reference directory exists", () => {
    expect(fs.existsSync(referenceDir)).toBe(true);
  });

  const refFiles = fs.existsSync(referenceDir)
    ? fs.readdirSync(referenceDir)
        .filter((f) => f.endsWith(".md"))
        .map((f) => `skills/twinharness/reference/${f}`)
    : [];

  it("at least one reference file exists", () => {
    expect(refFiles.length).toBeGreaterThan(0);
  });

  it.each(refFiles)("%s is non-empty", (rel) => {
    const content = read(rel);
    expect(content.trim().length).toBeGreaterThan(0);
  });

  it.each(refFiles)(
    "%s contains real content (th command or REQ/§ citation)",
    (rel) => {
      const content = read(rel);
      const hasTh = /\bth /.test(content);
      const hasReqOrSection = /REQ-|§/.test(content);
      expect(hasTh || hasReqOrSection).toBe(true);
    },
  );
});
