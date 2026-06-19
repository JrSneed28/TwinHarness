/**
 * Phase 7 / P7-3 + P7-4 — generated command reference + MCP tool-name prose pin
 * (REQ-PCO-072, REQ-PCO-073).
 *
 * P7-3: the command reference in USAGE.md is GENERATED from the CLI dispatcher +
 * MCP registry (`scripts/gen-command-reference.ts`). This suite asserts:
 *   - USAGE.md is in sync with the generator (a stale checkout fails CI);
 *   - the generated reference is EXHAUSTIVE over the CLI dispatcher (every CLI
 *     command leaf appears) and over the MCP registry (every tool name appears).
 *
 * P7-4: the enumerated MCP tool-name roster in USAGE.md exactly equals
 *   `TOOL_DEFS.map(t => t.name)` — no tool documented that doesn't exist, none
 *   missing. A tool added/renamed without regenerating fails here.
 *
 * Counts are DERIVED (TOOL_DEFS.length, CLI_COMMAND_LEAVES.length), never hardcoded.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import { TOOL_DEFS, CLI_COMMAND_LEAVES } from "../src/mcp-server";
import {
  renderCommandReference,
  expectedUsage,
  USAGE_PATH,
  BEGIN_MARKER,
  END_MARKER,
} from "../scripts/gen-command-reference";

const usage = (): string => fs.readFileSync(USAGE_PATH, "utf8");

/** Extract the AUTO-GENERATED block from USAGE.md. */
function generatedBlock(): string {
  const text = usage();
  const begin = text.indexOf(BEGIN_MARKER);
  const end = text.indexOf(END_MARKER);
  expect(begin, "USAGE.md must contain the BEGIN marker").toBeGreaterThanOrEqual(0);
  expect(end, "USAGE.md must contain the END marker").toBeGreaterThan(begin);
  return text.slice(begin, end + END_MARKER.length);
}

describe("REQ-PCO-072: USAGE.md command reference is generated and in sync", () => {
  it("REQ-PCO-072: USAGE.md equals the generator output (regenerate with `npx tsx scripts/gen-command-reference.ts`)", () => {
    expect(
      usage(),
      "USAGE.md is stale — run `npx tsx scripts/gen-command-reference.ts` and commit",
    ).toBe(expectedUsage());
  });

  it("REQ-PCO-072: the generated block carries the derived counts (not hardcoded)", () => {
    const block = renderCommandReference();
    expect(block).toContain(`**${CLI_COMMAND_LEAVES.length} CLI command leaves**`);
    expect(block).toContain(`**${TOOL_DEFS.length} MCP tools**`);
  });
});

describe("REQ-PCO-072: the generated reference is EXHAUSTIVE over the dispatcher + registry", () => {
  it("REQ-PCO-072: every CLI command leaf appears in the generated reference", () => {
    const block = generatedBlock();
    const missing = CLI_COMMAND_LEAVES.filter((leaf) => !block.includes(`\`th ${leaf}\``));
    expect(missing, `CLI leaves missing from the generated reference: ${missing.join(", ")}`).toEqual([]);
  });

  it("REQ-PCO-072: every MCP tool name appears in the generated reference", () => {
    const block = generatedBlock();
    const missing = TOOL_DEFS.map((t) => t.name).filter((n) => !block.includes(`\`${n}\``));
    expect(missing, `tool names missing from the generated reference: ${missing.join(", ")}`).toEqual([]);
  });
});

describe("REQ-PCO-073: USAGE tool-name roster diffs exactly against TOOL_DEFS", () => {
  // Pull every `th_*` token enumerated in the AUTO-GENERATED block's roster and
  // assert the SET equals TOOL_DEFS.map(t => t.name) — neither a documented tool
  // that doesn't exist, nor a real tool the docs forgot.
  it("REQ-PCO-073: the enumerated tool-name set equals the registry's names", () => {
    const block = generatedBlock();
    // The roster lines look like:  - `th_state_get`
    const enumerated = new Set(
      [...block.matchAll(/`(th_[a-z_]+)`/g)].map((m) => m[1]!),
    );
    const registry = new Set(TOOL_DEFS.map((t) => t.name));

    const documentedButAbsent = [...enumerated].filter((n) => !registry.has(n));
    const realButUndocumented = [...registry].filter((n) => !enumerated.has(n));

    expect(documentedButAbsent, `USAGE documents non-existent tools: ${documentedButAbsent.join(", ")}`).toEqual([]);
    expect(realButUndocumented, `USAGE omits real tools: ${realButUndocumented.join(", ")}`).toEqual([]);
    expect(enumerated.size).toBe(registry.size);
  });

  it("REQ-PCO-073: the permanently-absent th_decision_approve is NOT enumerated (RULE-011)", () => {
    expect(generatedBlock()).not.toContain("`th_decision_approve`");
  });
});
