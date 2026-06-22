/**
 * R4 (Axis-B slice-1a / BSC-4) — MCP/CLI parity guard for the new `--target`/`target`
 * argument introduced in slice-1a.
 *
 * Pins five orthogonal facts so the `target` arg cannot silently drift out of any
 * surface after this commit:
 *
 *   1. MCP schema — `th_drift_resolve` and `th_sim_retire` each expose a `target`
 *      string property in `inputSchema.properties`.
 *   2. CLI HELP — `drift resolve` and `sim retire` document `--target`.
 *   3. CLI HELP flag glossary — `--target` itself is listed in the flag table.
 *   4. TOOL_CATALOG mirror — the `th_drift_resolve` and `th_sim_retire` catalog
 *      summaries equal their `TOOL_DEFS[i].description` exactly (the SDK-free
 *      catalog keeps parity for the two edited tools).
 *   5. Tool count + leaf partition — adding the `target` arg did NOT perturb the
 *      tool count; the derived count is unchanged (re-affirm `expectedToolDefsCount`
 *      and that neither tool appeared/disappeared).
 *
 * Convention follows tests/mcp-cli-parity.test.ts (HELP-source-read pattern) and
 * tests/manifest-tools.test.ts (TOOL_CATALOG mirror pattern).  STRING_FLAGS is not
 * exported from src/cli.ts, so CLI-flag facts are asserted via the HELP string
 * (same approach as the existing parity tests for `--emergency`, `--target`, etc.).
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { TOOL_DEFS } from "../src/mcp-server";
import { TOOL_CATALOG } from "../src/core/tool-catalog";
import { expectedToolDefsCount } from "./helpers";

const ROOT = path.resolve(__dirname, "..");

// Read the CLI source once — the same technique the existing parity tests use to
// introspect HELP without importing the module (it has side-effects + no export).
const cliSrc = fs.readFileSync(path.join(ROOT, "src", "cli.ts"), "utf8");
const helpMatch = /const HELP = `([\s\S]*?)`;/.exec(cliSrc);
expect(helpMatch, "cli.ts must define a HELP template literal").toBeTruthy();
const HELP = helpMatch![1]!;

// ---------------------------------------------------------------------------
// 1. MCP schema — both tools expose `target` as a string property
// ---------------------------------------------------------------------------
describe("BSC-4 / slice-1a: MCP schema exposes `target` on the two receipt-producing tools", () => {
  it("th_drift_resolve.inputSchema.properties.target is a string property", () => {
    const def = TOOL_DEFS.find((t) => t.name === "th_drift_resolve");
    expect(def, "th_drift_resolve must be registered in TOOL_DEFS").toBeDefined();
    const props = def!.inputSchema.properties as Record<string, { type?: string; description?: string }>;
    expect(props.target, "th_drift_resolve must declare a `target` property").toBeDefined();
    expect(props.target!.type).toBe("string");
  });

  it("th_sim_retire.inputSchema.properties.target is a string property", () => {
    const def = TOOL_DEFS.find((t) => t.name === "th_sim_retire");
    expect(def, "th_sim_retire must be registered in TOOL_DEFS").toBeDefined();
    const props = def!.inputSchema.properties as Record<string, { type?: string; description?: string }>;
    expect(props.target, "th_sim_retire must declare a `target` property").toBeDefined();
    expect(props.target!.type).toBe("string");
  });

  it("target is optional in both schemas (not in required[])", () => {
    // The MCP handler enforces the requirement for blocking/user-visible entries;
    // the JSON-schema layer does not force it on every call.
    for (const name of ["th_drift_resolve", "th_sim_retire"] as const) {
      const def = TOOL_DEFS.find((t) => t.name === name)!;
      const required = (def.inputSchema.required ?? []) as string[];
      expect(
        required.includes("target"),
        `${name}: target must NOT be in required[] (handler enforces it conditionally)`,
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 2 & 3. CLI HELP — the human surface documents --target for both commands
// ---------------------------------------------------------------------------
describe("BSC-4 / slice-1a: CLI HELP documents --target on drift resolve and sim retire", () => {
  it("HELP usage line for `th drift resolve` mentions --target", () => {
    // Matches the usage line: `th drift resolve <DRIFT-NNN> [--target <path>]`
    expect(HELP, "HELP must document --target on the `th drift resolve` usage line").toMatch(
      /th drift resolve[^\n]*--target/,
    );
  });

  it("HELP usage line for `th sim retire` mentions --target", () => {
    // Matches the usage line: `th sim retire <SIM-NNN> [--retire-slice ...] [--target <path>]`
    expect(HELP, "HELP must document --target on the `th sim retire` usage line").toMatch(
      /th sim retire[^\n]*--target/,
    );
  });

  it("HELP flag table documents --target with its (drift resolve / sim retire) scope annotation", () => {
    // The flag-glossary section of HELP lists: `--target <path>   (drift resolve / sim retire) ...`
    expect(HELP, "HELP flag table must list --target").toMatch(/--target\s+<path>/);
    // And it must attribute it to both commands so a reader knows where it applies.
    expect(HELP, "HELP flag table --target entry must reference drift resolve").toMatch(
      /--target[^\n]*drift resolve/,
    );
    expect(HELP, "HELP flag table --target entry must reference sim retire").toMatch(
      /--target[^\n]*sim retire/,
    );
  });
});

// ---------------------------------------------------------------------------
// 4. TOOL_CATALOG mirror — the two edited tools stay in sync
// ---------------------------------------------------------------------------
describe("BSC-4 / slice-1a: TOOL_CATALOG mirrors TOOL_DEFS for the two edited tools", () => {
  it("th_drift_resolve catalog summary === TOOL_DEFS description", () => {
    const def = TOOL_DEFS.find((t) => t.name === "th_drift_resolve")!;
    const cat = TOOL_CATALOG.find((t) => t.name === "th_drift_resolve");
    expect(cat, "TOOL_CATALOG must have a th_drift_resolve entry").toBeDefined();
    expect(cat!.summary).toBe(def.description);
  });

  it("th_sim_retire catalog summary === TOOL_DEFS description", () => {
    const def = TOOL_DEFS.find((t) => t.name === "th_sim_retire")!;
    const cat = TOOL_CATALOG.find((t) => t.name === "th_sim_retire");
    expect(cat, "TOOL_CATALOG must have a th_sim_retire entry").toBeDefined();
    expect(cat!.summary).toBe(def.description);
  });
});

// ---------------------------------------------------------------------------
// 5. Tool count + leaf partition — adding target did not add/remove a tool
// ---------------------------------------------------------------------------
describe("BSC-4 / slice-1a: tool count and partition are unchanged (arg addition, not tool addition)", () => {
  it("TOOL_DEFS.length equals the self-derived expectedToolDefsCount()", () => {
    expect(TOOL_DEFS.length).toBe(expectedToolDefsCount());
  });

  it("th_drift_resolve and th_sim_retire are still registered (no accidental removal)", () => {
    const names = new Set(TOOL_DEFS.map((t) => t.name));
    expect(names.has("th_drift_resolve"), "th_drift_resolve must remain registered").toBe(true);
    expect(names.has("th_sim_retire"), "th_sim_retire must remain registered").toBe(true);
  });
});
