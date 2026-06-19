/**
 * Phase 7 / P7-1 — CLI↔MCP command-parity + MCP thinness guard (REQ-PCO-070).
 *
 * The CLI is the source of truth; the MCP server is a THIN adapter exposing a
 * SUBSET of the CLI's commands. This suite realises the never-implemented
 * EXPECTED_TOOL_ALLOWLIST as a real, mechanical partition:
 *
 *   1. Every LIVE CLI command leaf is EITHER mirrored by a `TOOL_DEFS` entry OR
 *      recorded in {@link MCP_EXCLUDED} with a reason — never silently absent.
 *   2. Every excluded leaf is genuinely NOT a tool (the divergence is real).
 *   3. Every MCP-only tool (no CLI leaf) is justified in {@link MCP_ONLY_TOOLS}.
 *   4. The CLI leaf list itself is pinned to the dispatcher's own `HELP` enumeration
 *      so it cannot drift from the CLI's source of truth.
 *   5. THINNESS: every tool closure DELEGATES to a `run*` handler / the shared
 *      locked gate-mutation setter — it must not re-implement command logic or do
 *      raw state I/O. "No orchestration logic" becomes a mechanical guard.
 *
 * A new CLI command with neither a tool nor an exclusion fails (1); the
 * permanently-forbidden `th_decision_approve` (RULE-011) stays absent.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  TOOL_DEFS,
  MCP_EXCLUDED,
  MCP_ONLY_TOOLS,
  CLI_COMMAND_LEAVES,
  cliCommandToToolName,
} from "../src/mcp-server";

const ROOT = path.resolve(__dirname, "..");
const TOOL_NAMES = new Set(TOOL_DEFS.map((t) => t.name));

describe("REQ-PCO-070: CLI↔MCP command parity (every CLI leaf covered or excluded)", () => {
  it("REQ-PCO-070: every non-excluded CLI command has a matching TOOL_DEFS entry", () => {
    const uncovered: string[] = [];
    for (const leaf of CLI_COMMAND_LEAVES) {
      if (leaf in MCP_EXCLUDED) continue;
      const tool = cliCommandToToolName(leaf);
      if (!TOOL_NAMES.has(tool)) uncovered.push(`${leaf} -> ${tool}`);
    }
    expect(
      uncovered,
      `CLI commands with no MCP tool and no exclusion (add a tool or record an MCP_EXCLUDED reason): ${uncovered.join(", ")}`,
    ).toEqual([]);
  });

  it("REQ-PCO-070: every EXCLUDED CLI leaf is genuinely NOT exposed as a tool", () => {
    const leaked: string[] = [];
    for (const leaf of Object.keys(MCP_EXCLUDED)) {
      const tool = cliCommandToToolName(leaf);
      if (TOOL_NAMES.has(tool)) leaked.push(`${leaf} -> ${tool}`);
    }
    expect(leaked, `excluded CLI leaves that ARE exposed as tools (divergence is not real): ${leaked.join(", ")}`).toEqual([]);
  });

  it("REQ-PCO-070: every excluded leaf is a real CLI command leaf (no stale exclusions)", () => {
    const stale = Object.keys(MCP_EXCLUDED).filter((leaf) => !CLI_COMMAND_LEAVES.includes(leaf));
    expect(stale, `MCP_EXCLUDED names leaves that are not live CLI commands: ${stale.join(", ")}`).toEqual([]);
  });

  it("REQ-PCO-070: the permanently-forbidden tool (RULE-011) is excluded AND absent", () => {
    expect(MCP_EXCLUDED["decision approve"]).toBeTruthy();
    expect(TOOL_NAMES.has("th_decision_approve")).toBe(false);
  });

  it("REQ-PCO-070: every TOOL_DEFS tool is EITHER a CLI-leaf mirror OR a justified MCP-only tool", () => {
    const leafTools = new Set(
      CLI_COMMAND_LEAVES.filter((l) => !(l in MCP_EXCLUDED)).map(cliCommandToToolName),
    );
    const unjustified: string[] = [];
    for (const name of TOOL_NAMES) {
      if (leafTools.has(name)) continue;
      if (name in MCP_ONLY_TOOLS) continue;
      unjustified.push(name);
    }
    expect(
      unjustified,
      `tools with no CLI leaf and no MCP_ONLY_TOOLS justification: ${unjustified.join(", ")}`,
    ).toEqual([]);
  });

  it("REQ-PCO-070: every MCP_ONLY_TOOLS entry is a real, registered tool", () => {
    const ghosts = Object.keys(MCP_ONLY_TOOLS).filter((n) => !TOOL_NAMES.has(n));
    expect(ghosts, `MCP_ONLY_TOOLS lists tools that are not registered: ${ghosts.join(", ")}`).toEqual([]);
  });

  it("REQ-PCO-070: the partition is exhaustive (covered + excluded == all leaves) and 62 tools accounted for", () => {
    const covered = CLI_COMMAND_LEAVES.filter((l) => !(l in MCP_EXCLUDED));
    const excluded = CLI_COMMAND_LEAVES.filter((l) => l in MCP_EXCLUDED);
    expect(covered.length + excluded.length).toBe(CLI_COMMAND_LEAVES.length);
    // 62 = (CLI-leaf mirrors) + (MCP-only tools).
    expect(covered.length + Object.keys(MCP_ONLY_TOOLS).length).toBe(TOOL_DEFS.length);
    expect(TOOL_DEFS.length).toBe(62);
  });
});

describe("REQ-PCO-070: CLI_COMMAND_LEAVES is pinned to the dispatcher HELP enumeration", () => {
  // The CLI HELP string enumerates every `th <group> <sub>` usage line. We extract
  // the command leaves from HELP and assert CLI_COMMAND_LEAVES covers exactly the
  // SAME set, so the parity list can never silently drift from the CLI's own help.
  const cliSrc = fs.readFileSync(path.join(ROOT, "src", "cli.ts"), "utf8");
  // The HELP usage block lists lines like:  `  th repo map [...]   Scan ...`.
  // Capture the `th <words>` head of each usage line (stop at the first flag/bracket
  // or 2+ spaces that begin the description).
  const helpMatch = /const HELP = `([\s\S]*?)`;/.exec(cliSrc);
  expect(helpMatch, "cli.ts must define a HELP template literal").toBeTruthy();
  const help = helpMatch![1]!;

  it("REQ-PCO-070: every CLI_COMMAND_LEAVES entry's `th <leaf>` appears in HELP", () => {
    const missing = CLI_COMMAND_LEAVES.filter((leaf) => {
      // The combined `th stage current|describe <s>|list` style line documents
      // multiple leaves on one row; accept either the exact `th <leaf>` token or the
      // group with the sub appearing as an alternation member.
      const exact = help.includes(`th ${leaf}`);
      const [group, sub] = leaf.split(" ");
      const grouped = sub !== undefined && new RegExp(`th ${group}\\b[^\\n]*\\b${sub}\\b`).test(help);
      return !exact && !grouped;
    });
    expect(missing, `CLI_COMMAND_LEAVES entries not found in HELP: ${missing.join(", ")}`).toEqual([]);
  });

  it("REQ-PCO-070: every command GROUP enumerated in HELP is modeled in CLI_COMMAND_LEAVES", () => {
    // Catch a NEW command group added to HELP/dispatch without a parity-list entry.
    // (Exact sub-leaf coverage is asserted in the forward direction above; here we
    // guard the coarser "a whole command family appeared and nobody modeled it".)
    const groups = new Set(CLI_COMMAND_LEAVES.map((l) => l.split(" ")[0]!));
    const helpGroups = new Set<string>();
    for (const line of help.split("\n")) {
      const m = /^\s{2}th ([a-z]+)\b/.exec(line);
      if (m) helpGroups.add(m[1]!);
    }
    const unmodeled = [...helpGroups].filter((g) => !groups.has(g));
    expect(unmodeled, `HELP enumerates command groups absent from CLI_COMMAND_LEAVES: ${unmodeled.join(", ")}`).toEqual([]);
  });
});

describe("REQ-PCO-070: MCP thinness guard (handlers delegate, never re-implement)", () => {
  // The single non-trivial logic in the MCP server is the CommandResult→MCP mapping
  // and arg coercion. Each tool's `run`/`runAsync` MUST delegate to a `run*` handler
  // or the shared locked gate-mutation setter — it must NOT re-implement command
  // logic or do raw state I/O. We assert this mechanically on the stringified
  // closures.
  // NB: the test transform may rewrite imported calls as `_import_.runFoo)(...)`,
  // so match the handler NAME, not an immediately-following `(`.
  const DELEGATION_RE = /\brun[A-Z]\w*\b|\bapplyGateMutation\b|\basyncToolGuard\b|\brepoFreshnessSummary\b/;
  // Raw state/disk I/O that would indicate re-implemented command logic in the
  // adapter (the handlers own all of this; the adapter must not).
  const REIMPL_RE = /\bwriteState\s*\(|\breadFileSync\s*\(|\bwriteFileSync\s*\(|\bmkdirSync\s*\(/;

  for (const def of TOOL_DEFS) {
    it(`REQ-PCO-070: ${def.name} delegates to a handler and does no raw state I/O`, () => {
      const body = def.run.toString() + (def.runAsync ? def.runAsync.toString() : "");
      expect(DELEGATION_RE.test(body), `${def.name} must call a run* handler / applyGateMutation`).toBe(true);
      expect(REIMPL_RE.test(body), `${def.name} must not do raw state/disk I/O (delegate to the handler)`).toBe(false);
    });
  }
});
