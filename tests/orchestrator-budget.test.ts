/**
 * Orchestrator token-budget guard (S-E, M-6).
 *
 * agents/orchestrator.md is an ALWAYS-LOADED controller prompt; the README's
 * per-file guidance is ~500 lines / ~5k tokens. This guard pins the file under
 * that token budget (chars/4 estimate) so on-demand detail stays in
 * skills/twinharness/reference/ instead of bloating the always-loaded context.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const TOKEN_BUDGET = 5000;

describe("M-6: agents/orchestrator.md stays within the always-loaded token budget", () => {
  it(`is <= ${TOKEN_BUDGET} tokens (chars/4 estimate)`, () => {
    const content = fs.readFileSync(path.join(ROOT, "agents/orchestrator.md"), "utf8");
    const estTokens = Math.ceil(content.length / 4);
    expect(
      estTokens,
      `orchestrator.md is ~${estTokens} tokens (${content.length} chars); budget is ${TOKEN_BUDGET}. ` +
        `Move on-demand detail into skills/twinharness/reference/ rather than growing the always-loaded file.`,
    ).toBeLessThanOrEqual(TOKEN_BUDGET);
  });
});
