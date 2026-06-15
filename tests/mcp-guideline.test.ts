import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * REQ-PCO-003: MCP Tooling Guideline integrity tests.
 *
 * The plugin ships typed `mcp__plugin_twinharness_th__*` MCP tools, but the
 * playbook historically routed everything to the `th` CLI. The fix is a single
 * guideline doc (`reference/mcp-tools.md`) that every agent points to. These
 * tests assert that doc exists, says MCP-first, documents dynamic discovery,
 * does NOT hard-code a tool total (so it never needs per-tool edits), and is
 * referenced from SKILL.md.
 */

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const GUIDELINE = "skills/twinharness/reference/mcp-tools.md";
const SKILL = "skills/twinharness/SKILL.md";

describe("REQ-PCO-003: MCP tooling guideline doc", () => {
  it("REQ-PCO-003: reference/mcp-tools.md exists and is non-empty", () => {
    const full = path.join(ROOT, GUIDELINE);
    expect(fs.existsSync(full)).toBe(true);
    const content = read(GUIDELINE);
    expect(content.trim().length).toBeGreaterThan(0);
  });

  it("REQ-PCO-003: mentions the mcp__plugin_twinharness_th__ tool namespace and a `th ` command token", () => {
    const content = read(GUIDELINE);
    expect(content).toContain("mcp__plugin_twinharness_th__");
    expect(content).toMatch(/th \w/);
  });

  it("REQ-PCO-003: documents dynamic discovery (set grows / non-exhaustive)", () => {
    const content = read(GUIDELINE);
    expect(content).toMatch(/grows|non-exhaustive|currently (advertised|available)/i);
  });

  it("REQ-PCO-003: does NOT hard-code a tool total like `23 tools`", () => {
    const content = read(GUIDELINE);
    expect(content).not.toMatch(/\b23 tools\b/);
  });
});

describe("REQ-PCO-003: SKILL.md points to the guideline", () => {
  it("REQ-PCO-003: SKILL.md references reference/mcp-tools.md", () => {
    const content = read(SKILL);
    expect(content).toContain("reference/mcp-tools.md");
  });
});
