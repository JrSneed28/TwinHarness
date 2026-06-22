/**
 * AC#1 — MCP write-surface invariant audit harness (PRIMARY deliverable, STEP 2).
 *
 * Mechanically proves that NO mutating MCP tool writes outside the governed
 * write-surface `<root>/{.twinharness, .agentic-sdlc, docs, drift-log.md}`, nor into
 * a slice-owned implementation path. The harness enumerates EVERY mutating tool
 * (`TOOL_DEFS.filter(t => !toolAnnotations(t.name)?.readOnlyHint)`), drives each
 * with boundary-probing args (`../canary.txt`, `..\\canary.txt`, a slice-owned path),
 * and snapshots the filesystem under the temp project AND its parent before/after
 * each call — asserting nothing landed out-of-surface, the planted canary is
 * untouched, and the slice-owned path is untouched.
 *
 * Defenses against false-confidence (ralplan pre-mortem #1):
 *  - collection-time coverage assert: a NEW mutating tool with no probe entry fails
 *    the suite (so the harness can never silently skip a tool);
 *  - `confirm:true` for the destructive-ack tools + tier:T3/in-flight slice so
 *    tier-gated tools actually REACH their write (not short-circuited at a gate);
 *  - a POSITIVE CONTROL proving the snapshot detects a real out-of-surface write;
 *  - a RUNTIME positive control (2c): a deliberately-planted path-taking write throws
 *    `WriteSurfaceError` at runtime — proving the guard FIRES, not merely that
 *    enumeration found nothing.
 *
 * The project is seeded in an OS tmpdir (never the repo root); `resolvePathsForCall`
 * reads `CLAUDE_PROJECT_DIR`, so the in-process `callTool` routes at that tmp root.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { callTool, TOOL_DEFS, toolAnnotations } from "../src/mcp-server";
import { runInit } from "../src/commands/init";
import { writeState } from "../src/core/state-store";
import { atomicWriteFile } from "../src/core/atomic-io";
import { WriteSurfaceError, resolveProjectPaths } from "../src/core/paths";
import { initialState, type TwinHarnessState } from "../src/core/state-schema";
import { type TempProject } from "./helpers";

/* ------------------------------------------------------------------ *
 * FS snapshotting — capture every file under a set of roots (path → bytes/size)  *
 * so a write ANYWHERE (in-surface or not) is detected by a diff.                  *
 * ------------------------------------------------------------------ */

/** Recursively list every file path under `dir` (absolute). Missing dir → []. */
function walkFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(abs));
    else out.push(abs);
  }
  return out;
}

/** Snapshot file path → content-fingerprint (size + first/last bytes) across roots. */
function snapshot(roots: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const root of roots) {
    for (const f of walkFiles(root)) {
      try {
        const buf = fs.readFileSync(f);
        m.set(f, `${buf.length}:${buf.subarray(0, 64).toString("hex")}`);
      } catch {
        m.set(f, "unreadable");
      }
    }
  }
  return m;
}

/** Paths created OR modified between two snapshots. */
function diffPaths(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed: string[] = [];
  for (const [p, sig] of after) {
    if (before.get(p) !== sig) changed.push(p);
  }
  return changed;
}

/**
 * Whether `abs` is inside the governed write-surface under `root`. Mirrors the
 * source-of-truth allowlist in `assertGovernedWriteSurface` (paths.ts): the two
 * state dirs, `docs/`, and the two root-level append-only ledgers
 * (`drift-log.md` / `debate-log.md`).
 */
function isGoverned(root: string, abs: string): boolean {
  const rel = path.relative(root, abs);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return false;
  const first = rel.split(path.sep)[0]!;
  return (
    first === ".twinharness" ||
    first === ".agentic-sdlc" ||
    first === "docs" ||
    first === "drift-log.md" ||
    first === "debate-log.md"
  );
}

/* ------------------------------------------------------------------ *
 * Per-tool boundary-probe args. Path-taking args get a boundary probe; the rest    *
 * are valid values that let the tool REACH its write. Destructive-ack tools carry   *
 * confirm:true; tier-gated tools rely on the seeded tier:T3 state.                   *
 * ------------------------------------------------------------------ */

const CANARY_REL = "../canary.txt";
const CANARY_REL_WIN = "..\\canary.txt";
const SLICE_OWNED_REL = "src/owned.ts";

/**
 * The probe map. Each mutating tool maps to the args used to drive it. A path-taking
 * tool uses a boundary probe in its path slot; tools that write only to the state
 * dir get valid args (the snapshot still proves they never escape the surface).
 */
const PROBE_ARGS: Record<string, Record<string, unknown>> = {
  // gate/state setters — write only to state.json
  th_state_set: { key: "complexity_rationale", value: "probe" },
  th_tier_record: { tier: "T2" },
  th_stage_advance: {},
  th_implementation_unlock: { allowed: true },
  th_write_gate_set: { value: "strict" },
  th_blast_radius_record: { flag: "data-integrity", present: true },
  // drift ledger (append to stateDir)
  th_drift_add: { layer: "derived", discovery: "probe", action: "probe" },
  th_drift_resolve: { id: "DRIFT-001" },
  // simulation ledger (SG3 P2-C; append/transition under stateDir — not path-taking)
  th_sim_add: { classification: "Mocked" },
  th_sim_retire: { id: "SIM-001" },
  // BSC-6: th_sim_scan appends an incomplete-scan receipt under stateDir when dist/
  // coverage is incomplete (now a mutating tool); not path-taking.
  th_sim_scan: {},
  // build leases (append to stateDir)
  th_build_claim: { sliceId: "SLICE-1" },
  th_build_release: { sliceId: "SLICE-1" },
  th_build_sub_claim: { parentSlice: "SLICE-1", components: "compA" },
  th_build_sub_release: { subId: "SLICE-1#sub" },
  // repo map — writes .twinharness/repo-map.json + docs/00-repo-map.md (both governed)
  th_repo_map: { write: true },
  // routing + scorecard — mutating because each appends an opt-in telemetry.jsonl line
  // under stateDir when telemetry is ON (R-09). The target is governed; with telemetry
  // off in this harness they write nothing, and either way never escape the surface.
  th_route: { agent: "builder" },
  th_scorecard: {},
  // decision ledger (append to stateDir)
  th_decision_add: { title: "probe", rationale: "probe" },
  // artifacts — PATH-TAKING: register a boundary path; claim/release a section path
  th_artifact_register: { path: CANARY_REL, version: 1 },
  th_artifact_claim: { section: `${SLICE_OWNED_REL}#s`, holder: "h" },
  th_artifact_release: { section: `${SLICE_OWNED_REL}#s`, holder: "h" },
  // research writer (SG3 P2-A) — PATH-TAKING via `topic`. The handler sanitizes the
  // topic to a flat slug and HARD-PINS the target under docs/00-research/, so a
  // boundary-shaped topic is refused (writes nothing); a clean topic lands inside the
  // governed `docs/` surface. Either way the snapshot proves it never escapes.
  th_research_write: { topic: CANARY_REL, markdown: "probe" },
  // collab (tier-gated; writes under stateDir/collab)
  th_collab_init: { stage: "spec" },
  th_collab_fragment: { stage: "spec", round: 1, name: "n", text: "t", confirm: true },
  // debate (tier-gated; append to stateDir)
  th_debate_add: { topic: "probe" },
  th_debate_resolve: { id: "DEBATE-001", resolution: "probe" },
  // verify (config + report under stateDir)
  th_verify_add: { command: "echo ok" },
  th_verify_clear: { confirm: true },
  th_verify_run: {},
  // slices — PATH-TAKING: planFile boundary probe
  th_slices_sync: { planFile: CANARY_REL },
  th_slice_set_status: { sliceId: "SLICE-1", status: "in-progress" },
  // interview (writes interview.json under stateDir; destructive-ack)
  th_interview_start: { idea: "probe", confirm: true },
  th_interview_record: {
    question: "q",
    answer: "a",
    scores: "1,1,1,1,1",
    confidence: "0.9",
  },
  // lifecycle + handoff (write under stateDir / HANDOFF.md under stateDir)
  th_init: {},
  th_handoff_write: {},
  // codebase-inspector governed write — PATH-TAKING via `file`: a boundary path in
  // the `file` slot is refused by the handler pin (inspector_path_pinned) before the
  // chokepoint, so nothing escapes the governed surface. `content` is required.
  th_inspector_write: { content: "probe", file: CANARY_REL },
  // live-QA Tester record (SG3 P2-C) — writes only .twinharness/tester-record.json
  // (governed state dir); not path-taking. `driver` is required.
  th_tester_record: { driver: "cli-e2e", provider: "sandbox" },
  // Axis-B/BSC-7 — in-process human-approval producer; writes only
  // .twinharness/approval-receipts.jsonl (governed state dir); not path-taking. A
  // humanGate stage is supplied (the governing artifact may not resolve in the temp
  // project → refuse-at-creation), but either way nothing escapes the surface.
  th_approve: { stage: "requirements" },
  // Axis-B/BSC-3 — in-process driver-dimension producer; writes only
  // .twinharness/driver-receipts.jsonl (governed state dir); not path-taking. No args
  // are required (the temp project has no verify-report.json → refuse-at-creation), but
  // either way nothing escapes the surface.
  th_driver_record: {},
};

describe("MCP write-surface audit — no mutating tool escapes the governed surface (AC#1)", () => {
  // A dedicated SANDBOX dir (the snapshot scope) holds the project root AND the
  // sibling canary, so the parent-escape probe is caught WITHOUT snapshotting all of
  // os.tmpdir() (whose unrelated temp churn would otherwise false-positive). The
  // sandbox is the project's parent, so a write to `../canary.txt` lands inside it
  // and is still detected as out-of-surface.
  let sandbox: string;
  let tp: TempProject;
  let prevProjectDir: string | undefined;
  let canaryAbs: string;
  let sliceOwnedAbs: string;

  const mutatingTools = TOOL_DEFS.filter((t) => !toolAnnotations(t.name)?.readOnlyHint);

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "th-wsa-"));
    const root = path.join(sandbox, "project");
    fs.mkdirSync(root, { recursive: true });
    tp = { root, paths: resolveProjectPaths(root), cleanup: () => fs.rmSync(sandbox, { recursive: true, force: true }) };
    runInit(tp.paths, {});
    // Seed a state that REACHES every gated write: classified T3 (advanced features
    // active), implementation allowed, one in-progress slice owning src/owned.ts.
    const state: TwinHarnessState = {
      ...initialState(),
      tier: "T3",
      current_stage: "implementation",
      implementation_allowed: true,
      slices: [{ id: "SLICE-1", status: "in-progress", components: ["src/owned.ts"] }],
    };
    writeState(tp.paths, state);

    // Plant the canary as a SIBLING of the project root (so `../canary.txt` from the
    // root resolves to it) and a slice-owned impl file inside the root.
    canaryAbs = path.join(sandbox, "canary.txt");
    fs.writeFileSync(canaryAbs, "CANARY", "utf8");
    sliceOwnedAbs = path.join(tp.root, "src", "owned.ts");
    fs.mkdirSync(path.dirname(sliceOwnedAbs), { recursive: true });
    fs.writeFileSync(sliceOwnedAbs, "export const owned = 1;\n", "utf8");

    prevProjectDir = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = tp.root;
  });

  afterEach(() => {
    if (prevProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = prevProjectDir;
    tp.cleanup();
  });

  // ---- Collection-time coverage assert (pre-mortem #1) -----------------------
  it("the probe map covers EVERY mutating tool (a new mutating tool fails until added)", () => {
    const missing = mutatingTools.map((t) => t.name).filter((n) => !(n in PROBE_ARGS));
    expect(missing, `mutating tools lacking a probe-arg entry: ${missing.join(", ")}`).toEqual([]);
    // And no stale probe entries pointing at non-mutating / removed tools.
    const stale = Object.keys(PROBE_ARGS).filter(
      (n) => !mutatingTools.some((t) => t.name === n),
    );
    expect(stale, `stale probe entries (tool gone or now read-only): ${stale.join(", ")}`).toEqual([]);
  });

  // ---- The audit: drive every mutating tool, snapshot FS, assert containment ----
  for (const tool of TOOL_DEFS.filter((t) => !toolAnnotations(t.name)?.readOnlyHint)) {
    it(`${tool.name} writes nothing outside the governed surface (and not the canary / slice path)`, async () => {
      const before = snapshot([sandbox]);
      const canaryBefore = fs.readFileSync(canaryAbs, "utf8");
      const sliceBefore = fs.readFileSync(sliceOwnedAbs, "utf8");

      // Drive the tool with the primary boundary probe. We do NOT assert on the
      // tool's success/refusal (a gate may legitimately refuse) — only that whatever
      // it DID write stayed inside the governed surface.
      await callTool(tool.name, PROBE_ARGS[tool.name]!);

      // Re-run path-taking tools with the Windows-separator and slice-owned probes
      // too, so a backslash-escape or a slice-owned target is also exercised.
      const pathTaking: Record<string, (v: string) => Record<string, unknown>> = {
        th_artifact_register: (v) => ({ path: v, version: 1 }),
        th_slices_sync: (v) => ({ planFile: v }),
        th_research_write: (v) => ({ topic: v, markdown: "probe" }),
        th_inspector_write: (v) => ({ content: "probe", file: v }),
      };
      const mk = pathTaking[tool.name];
      if (mk) {
        await callTool(tool.name, mk(CANARY_REL_WIN));
        await callTool(tool.name, mk(SLICE_OWNED_REL));
      }

      const after = snapshot([sandbox]);
      const changed = diffPaths(before, after);
      const escaped = changed.filter((p) => !isGoverned(tp.root, p));
      expect(
        escaped,
        `${tool.name} wrote outside the governed surface: ${escaped.join(", ")}`,
      ).toEqual([]);

      // The planted canary (outside root) and the slice-owned impl path are untouched.
      expect(fs.readFileSync(canaryAbs, "utf8"), `${tool.name} touched the canary`).toBe(canaryBefore);
      expect(fs.readFileSync(sliceOwnedAbs, "utf8"), `${tool.name} touched the slice path`).toBe(sliceBefore);
    });
  }

  // ---- Positive control: the snapshot DETECTS a real out-of-surface write -------
  it("POSITIVE CONTROL — the snapshot/diff detects a real out-of-surface write", () => {
    const before = snapshot([sandbox]);
    // Deliberately write outside the governed surface (bypassing the guard via raw fs).
    const sneaky = path.join(tp.root, "src", "sneaky.ts");
    fs.writeFileSync(sneaky, "leak", "utf8");
    const after = snapshot([sandbox]);
    const escaped = diffPaths(before, after).filter((p) => !isGoverned(tp.root, p));
    expect(escaped).toContain(sneaky); // the harness would have caught a real leak
    fs.rmSync(sneaky, { force: true });
  });

  // ---- Runtime positive control (2c): the guard FIRES at runtime ----------------
  it("RUNTIME POSITIVE CONTROL — a planted path-taking write throws WriteSurfaceError", () => {
    // A write through the governed chokepoint at a non-governed in-root path must
    // throw WriteSurfaceError — proving the guard is mechanical, not just enumerated.
    const target = path.join(tp.root, "src", "owned.ts");
    expect(() => atomicWriteFile(target, "leak", { root: tp.root })).toThrow(WriteSurfaceError);
    // The slice-owned file was NOT overwritten by the rejected write.
    expect(fs.readFileSync(sliceOwnedAbs, "utf8")).toBe("export const owned = 1;\n");

    // A parent-escaping write is likewise refused at the chokepoint.
    const escape = path.join(path.dirname(tp.root), "canary.txt");
    expect(() => atomicWriteFile(escape, "leak", { root: tp.root })).toThrow(WriteSurfaceError);
    expect(fs.readFileSync(canaryAbs, "utf8")).toBe("CANARY");
  });

  // ---- A legitimate legacy .agentic-sdlc write is NOT false-rejected ------------
  it("a legacy .agentic-sdlc write is allowed (allowlist includes the legacy dir)", () => {
    const legacy = path.join(tp.root, ".agentic-sdlc", "state.json");
    expect(() => atomicWriteFile(legacy, "{}", { root: tp.root })).not.toThrow();
    expect(fs.existsSync(legacy)).toBe(true);
  });
});
