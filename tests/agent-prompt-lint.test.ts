/**
 * Agent-prompt lint (Track C-1) — a structural + budget guard over `agents/*.md`.
 *
 * The prompt surface is part of TwinHarness's context cost (the `th context
 * estimate` lever). This test pins two invariants for every agent prompt file so
 * future edits cannot silently bloat or hollow them out:
 *
 *   (a) TOKEN BUDGET — each file's char-estimate (TOKENS_PER_CHAR = 1/4, the same
 *       heuristic `th context estimate` uses) must stay under AGENT_TOKEN_BUDGET.
 *       The ceiling is set with headroom above the current largest file so the
 *       suite is GREEN now and catches future growth.
 *
 *   (b) REQUIRED SECTIONS — each file must carry the repo's canonical structure:
 *       YAML frontmatter with `name` (identity), `description` (role),
 *       `disallowedTools` (tool isolation), and `model` (routing), plus at least
 *       one H1 heading (the agent title). These are the conventions every agent
 *       file in the repo already follows — not invented headers.
 *
 * Read-only: it reads the real `agents/*.md` files; it asserts shape, never sizes
 * beyond the budget ceiling.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/** Same heuristic as `src/commands/context.ts` (`th context estimate`). */
const TOKENS_PER_CHAR = 1 / 4;

/**
 * Per-file token ceiling. The current largest agent prompt is the orchestrator
 * at ~5.0k tokens; 6000 leaves ~19% headroom over it so the suite is green today
 * and trips when an agent prompt grows materially. Raise deliberately (and note
 * why) — a rising ceiling is the bloat this guard exists to surface.
 */
const AGENT_TOKEN_BUDGET = 6000;

const AGENTS_DIR = path.resolve(__dirname, "..", "agents");

function estimateTokens(content: string): number {
  return Math.round(content.length * TOKENS_PER_CHAR);
}

function agentFiles(): string[] {
  return fs
    .readdirSync(AGENTS_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort();
}

/** Extract the YAML frontmatter block (text between the first two `---` fences). */
function frontmatter(content: string): string | null {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? m[1]! : null;
}

describe("agent-prompt lint: token budget", () => {
  for (const file of agentFiles()) {
    it(`${file} is within the ${AGENT_TOKEN_BUDGET}-token budget`, () => {
      const content = fs.readFileSync(path.join(AGENTS_DIR, file), "utf8");
      const tokens = estimateTokens(content);
      expect(tokens).toBeGreaterThan(0);
      expect(tokens).toBeLessThanOrEqual(AGENT_TOKEN_BUDGET);
    });
  }
});

describe("agent-prompt lint: required sections", () => {
  for (const file of agentFiles()) {
    it(`${file} has frontmatter (name/description/disallowedTools/model) + an H1`, () => {
      const content = fs.readFileSync(path.join(AGENTS_DIR, file), "utf8");
      const fm = frontmatter(content);
      expect(fm, "must open with a YAML frontmatter block").not.toBeNull();
      expect(fm!).toMatch(/^name:\s*\S+/m);
      expect(fm!).toMatch(/^description:\s*\S+/m);
      expect(fm!).toMatch(/^disallowedTools:\s*\S+/m);
      expect(fm!).toMatch(/^model:\s*\S+/m);
      // At least one H1 heading (the agent title) somewhere in the body.
      expect(content).toMatch(/^# \S+/m);
    });
  }
});

describe("agent-prompt lint: measured token counts (reporting)", () => {
  it("every agent file reports a finite, positive token estimate", () => {
    const measured = agentFiles().map((file) => {
      const content = fs.readFileSync(path.join(AGENTS_DIR, file), "utf8");
      return { file, tokens: estimateTokens(content) };
    });
    expect(measured.length).toBeGreaterThan(0);
    for (const m of measured) {
      expect(Number.isFinite(m.tokens)).toBe(true);
      expect(m.tokens).toBeGreaterThan(0);
      expect(m.tokens).toBeLessThanOrEqual(AGENT_TOKEN_BUDGET);
    }
  });
});
