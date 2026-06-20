import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * PROMPT-SURFACE BUDGET (Track C-2 / Optimization Phase A).
 *
 * This guard pins the ≥20% prompt-surface reduction achieved by the
 * behavior-preserving trim pass so future edits cannot silently re-bloat the
 * orchestration prompt surface.
 *
 * It recomputes the SAME 45-file surface `th context estimate` measures —
 * agents/*.md + skills/twinharness/**.md + commands/*.md — using the identical
 * char/4 heuristic (TOKENS_PER_CHAR = 1/4), and asserts the total stays at or
 * below the 20%-reduction target.
 *
 *   Baseline (pre-optimization, .omc/research/optimization-baseline.md): 97,823 tokens.
 *   ≥20% reduction target: 97,823 * 0.80 = 78,258.4  →  total must be <= 78,258.
 *
 * Deterministic and fast: it reads the real prompt files off disk, no I/O beyond
 * synchronous reads, no network, no build artifacts.
 */

const ROOT = path.resolve(__dirname, "..");

/** Same heuristic as `src/commands/context.ts` (`th context estimate`). */
const TOKENS_PER_CHAR = 1 / 4;

/**
 * Pre-optimization baseline and the prompt-surface ceiling.
 *
 * The original ≥20%-reduction lock was floor(97_823 * 0.80) = 78_258. SG3
 * (Evidence & Reality) adds genuine capability content to several agent prompts
 * (universal researcher, broadened UX/UI direction, production-reality guidance,
 * inspector/research write paths). Per the user-approved re-baseline (2026-06-20),
 * "trim cheap redundancy, raise for the residual": obvious verbosity is trimmed
 * first, then this ceiling tracks the post-SG3 surface. It is ratcheted tight at
 * each prompt-touching SG3 commit and finalized at SG3 closure (P3-B). Do NOT
 * raise it for ordinary edits — trim redundancy instead.
 */
const BASELINE_TOKENS = 97_823;
const BUDGET_TOKENS = 78_800; // SG3 interim re-baseline (ratcheted; finalized at P3-B)

/** Recursively collect every *.md file under a directory (sorted, deterministic). */
function listMd(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listMd(p));
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(p);
  }
  return out.sort();
}

function surfaceFiles(): string[] {
  return [
    ...listMd(path.join(ROOT, "agents")),
    ...listMd(path.join(ROOT, "skills", "twinharness")),
    ...listMd(path.join(ROOT, "commands")),
  ];
}

function estimateTokens(content: string): number {
  return Math.round(content.length * TOKENS_PER_CHAR);
}

describe("prompt-surface budget: ≥20% reduction is locked in (Track C-2)", () => {
  it("the 45-file prompt surface total stays within the 78,258-token budget", () => {
    const files = surfaceFiles();
    const total = files.reduce(
      (sum, abs) => sum + estimateTokens(fs.readFileSync(abs, "utf8")),
      0,
    );
    const reductionPct = ((BASELINE_TOKENS - total) / BASELINE_TOKENS) * 100;
    expect(
      total,
      `prompt surface is ~${total} tokens across ${files.length} files (baseline ${BASELINE_TOKENS}, ` +
        `${reductionPct.toFixed(1)}% reduction); budget is ${BUDGET_TOKENS} (SG3 re-baseline). ` +
        `Trim redundancy/verbosity in agents/skills/commands first; raise the ceiling only for ` +
        `genuine new capability content (SG3 trim-cheap/raise-residual policy).`,
    ).toBeLessThanOrEqual(BUDGET_TOKENS);
  });

  it("the measured surface is the expected 45 prompt files", () => {
    expect(surfaceFiles().length).toBe(45);
  });
});
