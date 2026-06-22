/**
 * T6 (integration) — the 5 typed gate-transition MCP tools end-to-end through the
 * locked+ledgered `applyGateMutation`, plus th_verify_run (AC-B11) and
 * th_artifact_register path-escape (AC-A6). Covers AC-B3, AC-B7..B12, AC-B16.
 *
 * Each gate tool is exercised via its real `ToolDef` (from TOOL_DEFS), so the
 * test drives exactly what the MCP CallTool path dispatches. We assert: the
 * resulting state, the ledger entry's hard-coded `source` (NOT spoofable from
 * args — AC-B16), a valid hash-chain, and the stable `data.error` on each refusal.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, mintRequiredApprovals, type TempProject } from "./helpers";
import { writeState, readState } from "../src/core/state-store";
import { initialState, type TwinHarnessState } from "../src/core/state-schema";
import { runArtifactRegister } from "../src/commands/artifact";
import { readLedger, verifyLedgerChain, type LedgerEntry } from "../src/core/ledger";
import { writeVerifyConfig, readVerifyReport } from "../src/core/verify";
import { runVerifyApprove } from "../src/commands/verify";
import { runTesterRecord } from "../src/commands/tester";
import { TOOL_DEFS } from "../src/mcp-server";
import type { CommandResult } from "../src/core/output";
import type { ProjectPaths } from "../src/core/paths";

/** Write an APPROVED verify config so `th_verify_run` executes it instead of
 *  refusing it as unapproved. Seals a real approval in the tamper-evident ledger
 *  via `th verify approve` (P1/R-02), injecting a TTY so the human barrier passes
 *  in this headless test. */
function writeApprovedVerifyConfig(paths: ProjectPaths, commands: string[]): void {
  writeVerifyConfig(paths, { commands });
  runVerifyApprove(paths, { as: "test", tty: { isTTY: true, stdinLine: "y" } });
}

let tp: TempProject | undefined;
afterEach(() => {
  tp?.cleanup();
  tp = undefined;
});

function toolRun(name: string, paths: ProjectPaths, args: Record<string, unknown> = {}): CommandResult {
  const def = TOOL_DEFS.find((t) => t.name === name);
  if (!def) throw new Error(`tool not found: ${name}`);
  return def.run(paths, args);
}

function toolRunAsync(name: string, paths: ProjectPaths, args: Record<string, unknown> = {}): Promise<CommandResult> {
  const def = TOOL_DEFS.find((t) => t.name === name);
  if (!def || !def.runAsync) throw new Error(`async tool not found: ${name}`);
  return def.runAsync(paths, args);
}

function writeFile(paths: ProjectPaths, rel: string, body: string): void {
  const abs = path.resolve(paths.root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, "utf8");
}

function seed(overrides: Partial<TwinHarnessState>): ProjectPaths {
  tp = makeTempProject();
  writeState(tp.paths, { ...initialState(), ...overrides });
  return tp.paths;
}

function state(paths: ProjectPaths): TwinHarnessState {
  return readState(paths).state!;
}

/** The single `gate-state-change` ledger entry for `key`, or undefined. */
function gateEntry(paths: ProjectPaths, key: string): LedgerEntry | undefined {
  return readLedger(paths).find((e) => e.event === "gate-state-change" && e.key === key);
}

/** Build a project satisfying the full unlock ladder at implementation-planning. */
function readyToUnlock(): ProjectPaths {
  tp = makeTempProject();
  const paths = tp.paths;
  writeFile(paths, "docs/01-requirements.md", "# Requirements\n\nREQ-001 the only requirement.\n");
  writeFile(paths, "docs/09-implementation-plan.md", "# Implementation plan\n\nSLICE-1 covers REQ-001.\n");
  writeFile(paths, "tests/cov.test.ts", "// REQ-001 verified here\n");
  writeState(paths, { ...initialState(), tier: "T2", current_stage: "implementation-planning" });
  expect(runArtifactRegister(paths, "docs/09-implementation-plan.md", 1).ok).toBe(true);
  return paths;
}

// ---------------------------------------------------------------------------
// th_tier_record
// ---------------------------------------------------------------------------
describe("th_tier_record — typed tier transition", () => {
  it("set-from-null succeeds, writes tier, and ledgers source=th_tier_record (chain valid)", () => {
    const paths = seed({ tier: null });
    const r = toolRun("th_tier_record", paths, { tier: "T2" });
    expect(r.ok).toBe(true);
    expect(state(paths).tier).toBe("T2");
    const entry = gateEntry(paths, "tier");
    expect(entry?.source).toBe("th_tier_record");
    expect(entry?.value).toBe("T2");
    expect(verifyLedgerChain(readLedger(paths))).toEqual({ ok: true });
  });

  it("refuses a downgrade (T3 → T1) with tier_downgrade_human_only and does NOT mutate state", () => {
    const paths = seed({ tier: "T3" });
    const r = toolRun("th_tier_record", paths, { tier: "T1" });
    expect(r.ok).toBe(false);
    expect(r.data?.error).toBe("tier_downgrade_human_only");
    expect(state(paths).tier).toBe("T3");
    expect(gateEntry(paths, "tier")).toBeUndefined();
  });

  it("AC-B16 — `source` is hard-coded, never read from args (cannot be spoofed)", () => {
    const paths = seed({ tier: null });
    // Even if a caller smuggles a `source` arg, the tool ignores it.
    const r = toolRun("th_tier_record", paths, { tier: "T1", source: "th state set" });
    expect(r.ok).toBe(true);
    expect(gateEntry(paths, "tier")?.source).toBe("th_tier_record");
  });
});

// ---------------------------------------------------------------------------
// th_stage_advance
// ---------------------------------------------------------------------------
describe("th_stage_advance — gated stage advance", () => {
  it("advances init → requirements when the ladder is clear (source=th_stage_advance)", () => {
    const paths = seed({ tier: "T1", current_stage: "init" });
    const r = toolRun("th_stage_advance", paths);
    expect(r.ok).toBe(true);
    expect(state(paths).current_stage).toBe("requirements");
    expect(gateEntry(paths, "current_stage")?.source).toBe("th_stage_advance");
    expect(verifyLedgerChain(readLedger(paths))).toEqual({ ok: true });
  });

  it("refuses with the first failing rung's error (blocking drift) and does NOT advance", () => {
    const paths = seed({ tier: "T1", current_stage: "init", drift_open_blocking: 2 });
    const r = toolRun("th_stage_advance", paths);
    expect(r.ok).toBe(false);
    expect(r.data?.error).toBe("blocking_drift_open");
    expect(state(paths).current_stage).toBe("init");
  });

  it("refuses no_next_stage at the terminal stage", () => {
    tp = makeTempProject();
    const paths = tp.paths;
    writeFile(paths, "docs/01-requirements.md", "REQ-001\n");
    writeFile(paths, "docs/09-implementation-plan.md", "SLICE-1 REQ-001\n");
    writeFile(paths, "tests/cov.test.ts", "// REQ-001\n");
    writeFile(paths, "docs/10-verification-report.md", "# Verification report\nREQ-001 verified.\n");
    // final-verification, no slices (slice-floor inert), no verify commands, coverage clean.
    writeState(paths, { ...initialState(), tier: "T1", current_stage: "final-verification" });
    expect(runArtifactRegister(paths, "docs/10-verification-report.md", 1).ok).toBe(true);
    // SG3 P2-C: the production-reality rung now composes into the final-verification
    // ladder, so the terminal state must also be production-reality-clean (a live-QA
    // Tester record attached; no user-visible simulation) to reach the no_next_stage
    // tail. R-31: the Tester record must be F8-BOUND (passed + receipt + repo snapshot)
    // — a bare {driver} marker no longer satisfies the strict predicate.
    expect(runTesterRecord(paths, { driver: "cli-e2e", provider: "sandbox", passed: true }).ok).toBe(true);
    // BSC-7 slice-3a C-2: the completion rung now composes into the final-verification
    // ladder too, so the closed human-approval required-set must be satisfied to reach the
    // no_next_stage tail (otherwise the advance blocks on human_approval_unverified).
    mintRequiredApprovals(paths, state(paths));
    const r = toolRun("th_stage_advance", paths);
    expect(r.ok).toBe(false);
    expect(r.data?.error).toBe("no_next_stage");
  });
});

// ---------------------------------------------------------------------------
// th_implementation_unlock
// ---------------------------------------------------------------------------
describe("th_implementation_unlock", () => {
  it("allowed:true unlocks only when the FULL ladder + tail passes (source=th_implementation_unlock)", () => {
    const paths = readyToUnlock();
    const r = toolRun("th_implementation_unlock", paths, { allowed: true });
    expect(r.ok).toBe(true);
    expect(state(paths).implementation_allowed).toBe(true);
    expect(gateEntry(paths, "implementation_allowed")?.source).toBe("th_implementation_unlock");
    expect(verifyLedgerChain(readLedger(paths))).toEqual({ ok: true });
  });

  it("allowed:true refuses when the ladder fails (tier unclassified)", () => {
    const paths = seed({ tier: null, current_stage: "init" });
    const r = toolRun("th_implementation_unlock", paths, { allowed: true });
    expect(r.ok).toBe(false);
    expect(r.data?.error).toBe("tier_unclassified");
    expect(state(paths).implementation_allowed).toBe(false);
  });

  it("allowed:false (re-lock/tighten) is always permitted, even from an unready state", () => {
    const paths = seed({ tier: null, current_stage: "init", implementation_allowed: true });
    const r = toolRun("th_implementation_unlock", paths, { allowed: false });
    expect(r.ok).toBe(true);
    expect(state(paths).implementation_allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// th_write_gate_set — tighten-only across ALL 16 ordered (from,to) pairs
// ---------------------------------------------------------------------------
describe("th_write_gate_set — tighten-only over all 16 ordered pairs", () => {
  const VALUES = ["off", "ask", "deny", "strict"] as const;
  const RANK: Record<string, number> = { off: 0, ask: 1, deny: 2, strict: 3 };

  for (const from of VALUES) {
    for (const to of VALUES) {
      const loosen = RANK[to]! < RANK[from]!;
      it(`${from} → ${to} ${loosen ? "REFUSED (would_loosen_write_gate)" : "allowed"}`, () => {
        const paths = seed({ write_gate: from });
        const r = toolRun("th_write_gate_set", paths, { value: to });
        if (loosen) {
          expect(r.ok).toBe(false);
          expect(r.data?.error).toBe("would_loosen_write_gate");
          expect(state(paths).write_gate).toBe(from); // unchanged
        } else {
          expect(r.ok).toBe(true);
          expect(state(paths).write_gate).toBe(to);
        }
      });
    }
  }

  it("tightening ledgers source=th_write_gate_set (chain valid)", () => {
    const paths = seed({ write_gate: "ask" });
    expect(toolRun("th_write_gate_set", paths, { value: "strict" }).ok).toBe(true);
    expect(gateEntry(paths, "write_gate")?.source).toBe("th_write_gate_set");
    expect(verifyLedgerChain(readLedger(paths))).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// th_blast_radius_record — idempotent merge + T0 veto
// ---------------------------------------------------------------------------
describe("th_blast_radius_record", () => {
  it("adds a flag (source=th_blast_radius_record) and is idempotent on re-add", () => {
    const paths = seed({ tier: "T2" });
    expect(toolRun("th_blast_radius_record", paths, { flag: "money", present: true }).ok).toBe(true);
    expect(state(paths).blast_radius_flags).toEqual(["money"]);
    expect(gateEntry(paths, "blast_radius_flags")?.source).toBe("th_blast_radius_record");
    // Idempotent: re-adding the same flag keeps a single canonical entry.
    expect(toolRun("th_blast_radius_record", paths, { flag: "money", present: true }).ok).toBe(true);
    expect(state(paths).blast_radius_flags).toEqual(["money"]);
    expect(verifyLedgerChain(readLedger(paths))).toEqual({ ok: true });
  });

  it("removes a flag with present:false", () => {
    const paths = seed({ tier: "T2", blast_radius_flags: ["money", "authentication"] });
    expect(toolRun("th_blast_radius_record", paths, { flag: "money", present: false }).ok).toBe(true);
    expect(state(paths).blast_radius_flags).toEqual(["authentication"]);
  });

  it("refuses t0_blast_radius_veto when adding a flag under Tier 0 (no state mutation)", () => {
    const paths = seed({ tier: "T0", blast_radius_flags: [] });
    const r = toolRun("th_blast_radius_record", paths, { flag: "money", present: true });
    expect(r.ok).toBe(false);
    expect(r.data?.error).toBe("t0_blast_radius_veto");
    expect(state(paths).blast_radius_flags).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// th_artifact_register — path-escape rejection (AC-A6)
// ---------------------------------------------------------------------------
describe("th_artifact_register — path containment (AC-A6)", () => {
  it("rejects an absolute path with path_escape before touching state", () => {
    const paths = seed({});
    const abs = process.platform === "win32" ? "C:\\Windows\\System32\\drivers\\etc\\hosts" : "/etc/hosts";
    const r = toolRun("th_artifact_register", paths, { path: abs, version: 1 });
    expect(r.ok).toBe(false);
    expect(r.data?.error).toBe("path_escape");
  });

  it("rejects a `..` parent escape with path_escape", () => {
    const paths = seed({});
    const r = toolRun("th_artifact_register", paths, { path: "../../etc/passwd", version: 1 });
    expect(r.ok).toBe(false);
    expect(r.data?.error).toBe("path_escape");
  });

  it("registers an in-root artifact (happy path)", () => {
    const paths = seed({});
    writeFile(paths, "docs/01-requirements.md", "REQ-001\n");
    const r = toolRun("th_artifact_register", paths, { path: "docs/01-requirements.md", version: 1 });
    expect(r.ok).toBe(true);
    expect(state(paths).approved_artifacts.some((a) => a.file === "docs/01-requirements.md")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// th_verify_run — runs commands + writes report WITHOUT a long state-lock (AC-B11)
// ---------------------------------------------------------------------------
describe("th_verify_run (AC-B11)", () => {
  it("runs the configured command, writes the report, and never holds the state lock", async () => {
    const paths = seed({ tier: "T1", current_stage: "implementation" });
    writeApprovedVerifyConfig(paths, ["exit 0"]);
    const stateBefore = fs.readFileSync(paths.stateFile, "utf8");
    const r = await toolRunAsync("th_verify_run", paths);
    expect(r.ok).toBe(true);
    const report = readVerifyReport(paths);
    expect(report?.ok).toBe(true);
    // AC-B11: the verify path never acquires withStateLock — no lock dir lingers,
    // and state.json is untouched (only the report is written).
    expect(fs.existsSync(path.join(paths.stateDir, ".state.lock"))).toBe(false);
    expect(fs.readFileSync(paths.stateFile, "utf8")).toBe(stateBefore);
  });

  it("surfaces a failing command as a non-ok report", async () => {
    const paths = seed({ tier: "T1", current_stage: "implementation" });
    writeApprovedVerifyConfig(paths, ["exit 1"]);
    const r = await toolRunAsync("th_verify_run", paths);
    expect(r.ok).toBe(false);
    expect(readVerifyReport(paths)?.ok).toBe(false);
  });
});
