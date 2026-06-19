/**
 * P7-3 / P7-4 — generate the CLI↔MCP command reference + the exhaustive MCP
 * tool-name roster from the CLI/MCP definitions (the single mechanical source of
 * truth), and splice them into USAGE.md between AUTO-GENERATED markers.
 *
 * Why generated, not hand-written: the command set + the 62-tool roster drift the
 * moment a command or tool is added. Deriving the reference from
 * `CLI_COMMAND_LEAVES` / `TOOL_DEFS` / `MCP_EXCLUDED` / `MCP_ONLY_TOOLS` means the
 * docs cannot silently lie. `tests/command-reference.test.ts` asserts USAGE.md
 * equals `renderCommandReference()` (so a stale checkout fails CI), and the doc-
 * truth/parity tests pin the counts to the registry.
 *
 * Usage:  npx tsx scripts/gen-command-reference.ts        # rewrite USAGE.md in place
 *         npx tsx scripts/gen-command-reference.ts --check # exit 1 if out of date
 *
 * The generated block lives in USAGE.md (tracked, NOT part of the prompt-surface
 * budget — agents/skills/commands are; USAGE.md/docs/README are not).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  TOOL_DEFS,
  CLI_COMMAND_LEAVES,
  MCP_EXCLUDED,
  MCP_ONLY_TOOLS,
  cliCommandToToolName,
} from "../src/mcp-server";

export const USAGE_PATH = path.resolve(__dirname, "..", "USAGE.md");
export const BEGIN_MARKER = "<!-- BEGIN AUTO-GENERATED: command-reference (scripts/gen-command-reference.ts) -->";
export const END_MARKER = "<!-- END AUTO-GENERATED: command-reference -->";

/**
 * Render the generated command-reference block (pure; no I/O). The block lists,
 * for every live CLI command leaf, whether it is mirrored by an MCP tool or
 * deliberately excluded, plus the exhaustive 62-name MCP tool roster the P7-4
 * prose-pin test diffs against `TOOL_DEFS.map(t => t.name)`.
 */
export function renderCommandReference(): string {
  const toolNames = TOOL_DEFS.map((t) => t.name);
  const toolSet = new Set(toolNames);

  // --- CLI command → MCP coverage table ---
  const rows: string[] = [];
  for (const leaf of CLI_COMMAND_LEAVES) {
    if (leaf in MCP_EXCLUDED) {
      rows.push(`| \`th ${leaf}\` | — (CLI-only) | ${MCP_EXCLUDED[leaf]} |`);
    } else {
      const tool = cliCommandToToolName(leaf);
      const present = toolSet.has(tool);
      rows.push(`| \`th ${leaf}\` | \`${tool}\`${present ? "" : " (MISSING!)"} | mirrored |`);
    }
  }

  // --- MCP-only tools (no CLI leaf) ---
  const onlyRows = Object.entries(MCP_ONLY_TOOLS).map(
    ([name, why]) => `| \`${name}\` | — (MCP-only) | ${why} |`,
  );

  // --- Exhaustive tool-name roster (P7-4 prose pin) ---
  const roster = toolNames.map((n) => `- \`${n}\``).join("\n");

  const lines: string[] = [
    BEGIN_MARKER,
    "",
    "#### Generated command reference",
    "",
    `This table is generated from the CLI dispatcher and the MCP \`TOOL_DEFS\` registry (\`scripts/gen-command-reference.ts\`); do not edit it by hand. There are **${CLI_COMMAND_LEAVES.length} CLI command leaves** and **${toolNames.length} MCP tools**.`,
    "",
    "| CLI command | MCP tool | Status |",
    "|---|---|---|",
    ...rows,
    ...onlyRows,
    "",
    `#### MCP tool roster (exhaustive — all ${toolNames.length})`,
    "",
    "Every registered MCP tool name, in registry order. The CLI↔MCP parity test pins this list against `TOOL_DEFS.map(t => t.name)`, so a tool added/removed/renamed without updating this roster fails CI.",
    "",
    roster,
    "",
    END_MARKER,
  ];
  // Substitute the two `${...}` counts manually (the template strings above are in a
  // string array, not a single template literal, so interpolate explicitly).
  return lines
    .join("\n")
    .replace("${CLI_COMMAND_LEAVES.length}", String(CLI_COMMAND_LEAVES.length))
    .replace("${toolNames.length}", String(toolNames.length))
    .replace("${toolNames.length}", String(toolNames.length));
}

/** Splice the generated block into the full USAGE.md text between the markers. */
export function spliceIntoUsage(usage: string, block: string): string {
  const begin = usage.indexOf(BEGIN_MARKER);
  const end = usage.indexOf(END_MARKER);
  if (begin === -1 || end === -1) {
    throw new Error(
      `USAGE.md is missing the AUTO-GENERATED markers. Add:\n${BEGIN_MARKER}\n${END_MARKER}\nwhere the generated command reference should live.`,
    );
  }
  const before = usage.slice(0, begin);
  const after = usage.slice(end + END_MARKER.length);
  return before + block + after;
}

/** The USAGE.md text that SHOULD be on disk (current file with the block refreshed). */
export function expectedUsage(): string {
  const usage = fs.readFileSync(USAGE_PATH, "utf8");
  return spliceIntoUsage(usage, renderCommandReference());
}

function main(): void {
  const check = process.argv.includes("--check");
  const expected = expectedUsage();
  const actual = fs.readFileSync(USAGE_PATH, "utf8");
  if (check) {
    if (expected !== actual) {
      process.stderr.write(
        "USAGE.md is out of date with the generated command reference. Run:\n  npx tsx scripts/gen-command-reference.ts\n",
      );
      process.exit(1);
    }
    process.stdout.write("USAGE.md command reference is up to date.\n");
    return;
  }
  fs.writeFileSync(USAGE_PATH, expected);
  process.stdout.write("USAGE.md command reference regenerated.\n");
}

if (require.main === module) main();
