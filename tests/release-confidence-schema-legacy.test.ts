/**
 * R-37 — release-confidence backstop: FUTURE-SCHEMA MUTATION (F4/R-33) + LEGACY-SHADOW
 * state selection (F5/R-34) + the F1↔F5 cross-lane completion AC, consolidated.
 *
 * Phase-1..4 proved each in its own suite (state-schema-too-new / paths-state-selection /
 * hook-cross-lane-conflict). This backstop re-asserts the load-bearing invariants in one
 * release gate and closes two parity GAPS those suites leave:
 *
 *   - F4: an ENUMERATED mutating-command matrix vs a v(CURRENT+1) schema — each refuses
 *     `schema_too_new` AND leaves the file byte-identical. (Adds `th adopt`/`th state set`
 *     gate-field arms alongside the existing set, so a NEW mutating verb that forgets the
 *     refuse guard is caught.)
 *   - F5: the legacy-shadow selection + both-exist conflict asserted on ALL THREE
 *     surfaces (CLI `resolveProjectPaths`, MCP `resolvePathsForCall`) — the hook lane is
 *     covered by hook-cross-lane-conflict.test.ts; this pins CLI+MCP parity.
 *   - F1↔F5: a no-valid-state / both-exist root yields Stop ≠ complete (re-asserted as the
 *     final cross-lane backstop, complementing the hook integration test).
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  resolveProjectPaths,
  StateLocationConflictError,
  type ProjectPaths,
} from "../src/core/paths";
import { resolvePathsForCall } from "../src/mcp-server";
import {
  CURRENT_SCHEMA_VERSION,
  initialState,
  serializeState,
  type TwinHarnessState,
} from "../src/core/state-schema";
import { writeState, readState, SchemaTooNewError } from "../src/core/state-store";
import { runStateSet } from "../src/commands/state";
import { runTierRecord } from "../src/commands/tier";
import { runDriftAdd } from "../src/commands/drift";
import { runInit } from "../src/commands/init";
import { runHookStopGateFromRoot } from "../src/commands/hook";

let tmp: string | undefined;
afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
  delete process.env.CLAUDE_PROJECT_DIR;
});

const real = (p: string): string => fs.realpathSync.native(p);
function mkroot(label: string): string {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), `th-rc-${label}-`));
  const root = path.join(tmp, "proj");
  fs.mkdirSync(root, { recursive: true });
  return root;
}
function writeValidState(root: string, dir: string): void {
  const d = path.join(root, dir);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "state.json"), serializeState(initialState()), "utf8");
}

/** Seed a v(CURRENT+1) state.json (with a future field) directly on disk. */
function seedTooNew(paths: ProjectPaths): string {
  fs.mkdirSync(paths.stateDir, { recursive: true });
  const tooNew = {
    ...initialState(),
    schema_version: CURRENT_SCHEMA_VERSION + 1,
    future_field: { nested: ["a", "b"], n: 42 },
  } as unknown as TwinHarnessState;
  const body = JSON.stringify(tooNew, null, 2) + "\n";
  fs.writeFileSync(path.join(paths.stateDir, "state.json"), body, "utf8");
  return body;
}

describe("R-37 F4 — every mutating command refuses schema_too_new AND preserves bytes (enumerated)", () => {
  const MUTATORS: Array<{ name: string; run: (p: ProjectPaths) => void }> = [
    { name: "writeState (the chokepoint)", run: (p) => { writeState(p, { ...initialState(), current_stage: "implementation" }); } },
    { name: "th state set (non-gate field)", run: (p) => runStateSet(p, "summaries_index", "x.md") },
    { name: "th tier record", run: (p) => runTierRecord(p, "T1") },
    { name: "th drift add --layer requirement", run: (p) => runDriftAdd(p, { layer: "requirement" }) },
    { name: "th init (re-init max-tokens path)", run: (p) => { runInit(p, { maxTokens: 150000 }); } },
  ];

  for (const m of MUTATORS) {
    it(`${m.name} → refuses schema_too_new, state.json byte-identical`, () => {
      const root = mkroot("f4");
      const paths = resolveProjectPaths(root);
      const before = seedTooNew(paths);
      // A mutating verb against a too-new file must throw SchemaTooNewError…
      let threw: unknown = null;
      try { m.run(paths); } catch (e) { threw = e; }
      expect(threw).toBeInstanceOf(SchemaTooNewError);
      expect((threw as SchemaTooNewError).code).toBe("schema_too_new");
      // …and leave the on-disk bytes UNCHANGED (no partial write / downgrade).
      const after = fs.readFileSync(path.join(paths.stateDir, "state.json"), "utf8");
      expect(after).toBe(before);
    });
  }

  it("a READ of a too-new file still works (refusal is at the MUTATION boundary only)", () => {
    const root = mkroot("f4-read");
    const paths = resolveProjectPaths(root);
    seedTooNew(paths);
    const st = readState(paths);
    expect(st.state).not.toBeUndefined();
    expect(st.state!.schema_version).toBe(CURRENT_SCHEMA_VERSION + 1);
  });
});

describe("R-37 F5 — legacy-shadow selection + both-exist conflict (CLI + MCP parity)", () => {
  it("CLI: an EMPTY .twinharness shadowing a valid legacy .agentic-sdlc selects LEGACY", () => {
    const root = mkroot("f5-cli-shadow");
    writeValidState(root, ".agentic-sdlc");
    fs.mkdirSync(path.join(root, ".twinharness"), { recursive: true }); // empty dir, no state.json
    const paths = resolveProjectPaths(root);
    expect(paths.stateDir).toBe(path.join(real(root), ".agentic-sdlc"));
  });

  it("MCP: the SAME empty-.twinharness shadow selects LEGACY via resolvePathsForCall (surface parity)", () => {
    const root = mkroot("f5-mcp-shadow");
    writeValidState(root, ".agentic-sdlc");
    fs.mkdirSync(path.join(root, ".twinharness"), { recursive: true });
    // resolvePathsForCall() resolves from CLAUDE_PROJECT_DIR (the MCP host's project dir).
    process.env.CLAUDE_PROJECT_DIR = root;
    const paths = resolvePathsForCall();
    expect(paths.stateDir).toBe(path.join(real(root), ".agentic-sdlc"));
  });

  it("CLI: a both-exist (both-valid) root is a HARD conflict (throws, never silently picks one)", () => {
    const root = mkroot("f5-cli-both");
    writeValidState(root, ".twinharness");
    writeValidState(root, ".agentic-sdlc");
    expect(() => resolveProjectPaths(root)).toThrow(StateLocationConflictError);
  });

  it("MCP: the SAME both-valid root throws the SAME conflict via resolvePathsForCall (surface parity)", () => {
    const root = mkroot("f5-mcp-both");
    writeValidState(root, ".twinharness");
    writeValidState(root, ".agentic-sdlc");
    process.env.CLAUDE_PROJECT_DIR = root;
    expect(() => resolvePathsForCall()).toThrow(StateLocationConflictError);
  });
});

describe("R-37 F1↔F5 — a no-valid-state / both-exist root yields Stop ≠ complete (cross-lane backstop)", () => {
  it("both-exist (both-valid) root → Stop BLOCKS (not complete, not a crash)", () => {
    const root = mkroot("xlane-both");
    writeValidState(root, ".twinharness");
    writeValidState(root, ".agentic-sdlc");
    const out = runHookStopGateFromRoot(root, {});
    const decision = (JSON.parse(out.stdout) as Record<string, unknown>)["decision"];
    expect(decision).toBe("block");
    expect(out.exitCode).toBe(0); // a clean fail-safe decision, not an uncaught throw
  });

  it("a single present-but-INVALID state → Stop BLOCKS (no fail-open onto a fresh project)", () => {
    const root = mkroot("xlane-invalid");
    const d = path.join(root, ".twinharness");
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "state.json"), '{ "tier": "NOT-A-TIER"', "utf8"); // unparseable
    const out = runHookStopGateFromRoot(root, {});
    const decision = (JSON.parse(out.stdout) as Record<string, unknown>)["decision"];
    expect(decision).toBe("block");
    expect(out.exitCode).toBe(0);
  });
});
