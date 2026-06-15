/**
 * SLICE-3 — Brownfield tiering prerequisite gate (REQ-301..305).
 *
 * Anchored acceptance tests (spec §16). Test names are the exact anchors from
 * docs/08-test-strategy.md and the SLICE-3 block of docs/09-implementation-plan.md.
 *
 * Anchors covered: REQ-301, REQ-302, REQ-303, REQ-304, REQ-305.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import { runTierClassify, runTierVetoCheck, VETO_EXIT_CODE } from "../src/commands/tier";
import { runRepoMap } from "../src/commands/repo";
import { serializeRepoMap, emptyRepoMap } from "../src/core/repo-map/schema";
import { writeState } from "../src/core/state-store";
import { initialState } from "../src/core/state-schema";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

/** Write a brief.json into the temp project root and return its absolute path. */
function writeBrief(t: TempProject, brief: Record<string, unknown>): string {
  const file = path.join(t.root, "brief.json");
  fs.writeFileSync(file, JSON.stringify(brief), "utf8");
  return file;
}

/** Initialise state.json as brownfield in a temp project. */
function initBrownfield(t: TempProject): void {
  fs.mkdirSync(t.paths.stateDir, { recursive: true });
  writeState(t.paths, { ...initialState(), project_mode: "brownfield" });
}

/**
 * Snapshot the CURRENT working tree into a FRESH repo-map.json via the real
 * `th repo map`. MUST be called AFTER every other file (brief, codebase-analysis)
 * is written, so nothing is "added" afterward and `th repo check` reads the map as
 * fresh at veto/classify time. The temp project always has at least brief.json to
 * scan, so fileHashes is non-empty (an empty-hashes map would itself read stale).
 */
function writeFreshRepoMap(t: TempProject): void {
  const res = runRepoMap(t.paths, { write: true });
  if (!res.ok) throw new Error("writeFreshRepoMap: runRepoMap failed");
}

/**
 * Write a repo-map.json that is PRESENT but STALE: a valid map with no
 * `fileHashes` (REQ-NFR-004 → `th repo check` returns no_hashes/exit 4). Models a
 * map that has drifted from the working tree.
 */
function writeStaleRepoMap(t: TempProject): void {
  fs.mkdirSync(t.paths.stateDir, { recursive: true });
  const map = emptyRepoMap(t.root); // valid map, but no fileHashes ⇒ stale.
  fs.writeFileSync(path.join(t.paths.stateDir, "repo-map.json"), serializeRepoMap(map), "utf8");
}

/** Create a minimal docs/00-existing-codebase-analysis.md. */
function writeCodebaseAnalysis(t: TempProject): void {
  fs.mkdirSync(t.paths.docsDir, { recursive: true });
  fs.writeFileSync(
    path.join(t.paths.docsDir, "00-existing-codebase-analysis.md"),
    "# Codebase Analysis\n",
    "utf8",
  );
}

/** A clean trivial brief (T0-eligible). */
const TRIVIAL_BRIEF = {
  description: "add a log line",
  single_file_or_local: true,
  changes_public_interface: false,
  adds_dependency: false,
  obvious_testable_answer: true,
  blast_radius_flags: [],
};

describe("SLICE-3 — Brownfield tiering prerequisite gate", () => {
  // -------------------------------------------------------------------------
  // REQ-301: veto-check refuses before brief-load when brownfield + missing prereqs
  // -------------------------------------------------------------------------
  it(
    "REQ-301: test_REQ301_brownfield_missing_prereq_vetoes_exit3 — brownfield run missing prerequisites → runTierVetoCheck refuses (exit 3) before brief-load logic",
    () => {
      tp = makeTempProject();
      initBrownfield(tp);
      // Neither repo-map.json nor 00-existing-codebase-analysis.md exist.
      const briefPath = writeBrief(tp, TRIVIAL_BRIEF);

      const res = runTierVetoCheck(tp.paths, briefPath);

      // Hard refusal: exit 3, ok false.
      expect(res.ok).toBe(false);
      expect(res.exitCode).toBe(VETO_EXIT_CODE);
      expect(res.exitCode).toBe(3);
      // Must happen before brief-load; data carries the brownfield error, not blast_radius flags.
      expect(res.data?.error).toBe("brownfield_prerequisite_missing");
    },
  );

  // -------------------------------------------------------------------------
  // REQ-302: refusal shape — error field + missing[] + exit 3
  // -------------------------------------------------------------------------
  it(
    "REQ-302: test_REQ302_brownfield_missing_prereq_vetoes_exit3 — refusal shape error:'brownfield_prerequisite_missing', missing[] lists both absent paths, exit 3",
    () => {
      tp = makeTempProject();
      initBrownfield(tp);
      // Neither artifact present — missing[] should contain both.
      const briefPath = writeBrief(tp, TRIVIAL_BRIEF);

      const res = runTierVetoCheck(tp.paths, briefPath);

      expect(res.ok).toBe(false);
      expect(res.exitCode).toBe(3);
      expect(res.data?.error).toBe("brownfield_prerequisite_missing");

      const missing = res.data?.missing as string[];
      expect(Array.isArray(missing)).toBe(true);
      // Both canonical paths relative to project root, forward-slashes.
      expect(missing).toContain(".twinharness/repo-map.json");
      expect(missing).toContain("docs/00-existing-codebase-analysis.md");
      expect(missing.length).toBe(2);
    },
  );

  it(
    "REQ-302: veto-check — only one artifact missing → missing[] contains exactly the absent one",
    () => {
      tp = makeTempProject();
      initBrownfield(tp);
      // Provide a FRESH repo-map but not codebase-analysis. Generate the map LAST
      // (after the brief) so it is fresh at check time — only the analysis is missing.
      const briefPath = writeBrief(tp, TRIVIAL_BRIEF);
      writeFreshRepoMap(tp);
      const res = runTierVetoCheck(tp.paths, briefPath);

      expect(res.ok).toBe(false);
      expect(res.exitCode).toBe(3);
      expect(res.data?.error).toBe("brownfield_prerequisite_missing");
      const missing = res.data?.missing as string[];
      expect(missing).toEqual(["docs/00-existing-codebase-analysis.md"]);
    },
  );

  it(
    "REQ-302: veto-check — both artifacts present on brownfield run → proceeds to normal blast-radius logic (no brownfield refusal)",
    () => {
      tp = makeTempProject();
      initBrownfield(tp);
      writeCodebaseAnalysis(tp);
      const briefPath = writeBrief(tp, TRIVIAL_BRIEF);
      // Fresh map generated LAST so `th repo check` reads it as fresh.
      writeFreshRepoMap(tp);
      const res = runTierVetoCheck(tp.paths, briefPath);

      // Should succeed — clean brief, no blast-radius flags, fresh map.
      expect(res.ok).toBe(true);
      expect(res.exitCode).toBe(0);
      expect(res.data?.blocked).toBe(false);
    },
  );

  // -------------------------------------------------------------------------
  // REQ-303: classify — advisory (exit 0) even when brownfield prereqs missing
  // -------------------------------------------------------------------------
  it(
    "REQ-303: test_REQ303_brownfield_classify_advisory_exit0 — same missing state → runTierClassify exit 0, data.brownfield_prerequisite_missing non-empty (advisory)",
    () => {
      tp = makeTempProject();
      initBrownfield(tp);
      // Neither artifact present.
      const briefPath = writeBrief(tp, TRIVIAL_BRIEF);

      const res = runTierClassify(tp.paths, briefPath);

      // Advisory: must be exit 0 and ok true (soft classify / hard veto split preserved).
      expect(res.ok).toBe(true);
      expect(res.exitCode).toBe(0);

      // Advisory signal in data.
      const bpMissing = res.data?.brownfield_prerequisite_missing as string[];
      expect(Array.isArray(bpMissing)).toBe(true);
      expect(bpMissing.length).toBeGreaterThan(0);
      expect(bpMissing).toContain(".twinharness/repo-map.json");
      expect(bpMissing).toContain("docs/00-existing-codebase-analysis.md");

      // Standard classify fields still present.
      expect(res.data).toHaveProperty("tier0_eligible");
      expect(res.data).toHaveProperty("advisory");
    },
  );

  it(
    "REQ-303: classify — brownfield + both artifacts present → no brownfield_prerequisite_missing key in data",
    () => {
      tp = makeTempProject();
      initBrownfield(tp);
      writeCodebaseAnalysis(tp);
      const briefPath = writeBrief(tp, TRIVIAL_BRIEF);
      // Fresh map generated LAST so `th repo check` reads it as fresh.
      writeFreshRepoMap(tp);
      const res = runTierClassify(tp.paths, briefPath);

      expect(res.ok).toBe(true);
      expect(res.exitCode).toBe(0);
      // When both artifacts are present AND the map is fresh, no advisory signal.
      expect(res.data?.brownfield_prerequisite_missing).toBeUndefined();
      expect(res.data?.brownfield_prerequisite_stale).toBeUndefined();
    },
  );

  // -------------------------------------------------------------------------
  // REQ-301: repo-map FRESHNESS is a hard gate (not just existence)
  // -------------------------------------------------------------------------
  it(
    "REQ-301: veto-check — brownfield with a PRESENT but STALE repo-map (analysis present) → refuses (exit 3, error 'brownfield_repo_map_stale', stale[] lists the map)",
    () => {
      tp = makeTempProject();
      initBrownfield(tp);
      writeCodebaseAnalysis(tp);
      const briefPath = writeBrief(tp, TRIVIAL_BRIEF);
      // Map present but stale (no fileHashes) — drifted from the tree.
      writeStaleRepoMap(tp);

      const res = runTierVetoCheck(tp.paths, briefPath);

      expect(res.ok).toBe(false);
      expect(res.exitCode).toBe(VETO_EXIT_CODE);
      expect(res.exitCode).toBe(3);
      // Only the map is stale; nothing is missing.
      expect(res.data?.error).toBe("brownfield_repo_map_stale");
      const stale = res.data?.stale as string[];
      expect(stale).toEqual([".twinharness/repo-map.json"]);
      expect(res.data?.missing).toEqual([]);
    },
  );

  it(
    "REQ-301: veto-check — stale repo-map AND missing analysis → missing[] reported, error stays 'brownfield_prerequisite_missing', stale[] still lists the map (exit 3)",
    () => {
      tp = makeTempProject();
      initBrownfield(tp);
      const briefPath = writeBrief(tp, TRIVIAL_BRIEF);
      writeStaleRepoMap(tp); // present-but-stale; analysis absent.

      const res = runTierVetoCheck(tp.paths, briefPath);

      expect(res.ok).toBe(false);
      expect(res.exitCode).toBe(3);
      // A missing artifact takes the error label; staleness is still surfaced.
      expect(res.data?.error).toBe("brownfield_prerequisite_missing");
      expect(res.data?.missing).toEqual(["docs/00-existing-codebase-analysis.md"]);
      expect(res.data?.stale).toEqual([".twinharness/repo-map.json"]);
    },
  );

  it(
    "REQ-303: classify — brownfield with a stale repo-map → advisory (exit 0) surfaces data.brownfield_prerequisite_stale (not _missing)",
    () => {
      tp = makeTempProject();
      initBrownfield(tp);
      writeCodebaseAnalysis(tp);
      const briefPath = writeBrief(tp, TRIVIAL_BRIEF);
      writeStaleRepoMap(tp);

      const res = runTierClassify(tp.paths, briefPath);

      // Classify stays advisory (exit 0) even when the map is stale.
      expect(res.ok).toBe(true);
      expect(res.exitCode).toBe(0);
      const staleAdvisory = res.data?.brownfield_prerequisite_stale as string[];
      expect(Array.isArray(staleAdvisory)).toBe(true);
      expect(staleAdvisory).toContain(".twinharness/repo-map.json");
      // Nothing missing → no missing advisory key.
      expect(res.data?.brownfield_prerequisite_missing).toBeUndefined();
    },
  );

  // -------------------------------------------------------------------------
  // REQ-304: greenfield byte-identical sentinel (non-negotiable)
  // -------------------------------------------------------------------------
  it(
    "REQ-304: test_REQ304_greenfield_tiering_byte_identical — greenfield (no project_mode) → classify and veto-check byte-identical to pre-epic baseline (non-negotiable sentinel)",
    () => {
      // Pre-epic baseline: greenfield classify on TRIVIAL_BRIEF yields:
      //   { ok:true, exitCode:0, data:{ tier0_eligible:true, blocked_by_veto:false,
      //     blast_radius_flags:[], advisory:"T0", reasons:[] } }
      // Pre-epic baseline: greenfield veto-check on TRIVIAL_BRIEF yields:
      //   { ok:true, exitCode:0, data:{ blocked:false, flags:[] } }
      //
      // These expectations encode the full byte-identical contract.

      tp = makeTempProject();
      // Greenfield: no state.json at all (uninitialized), no project_mode.
      const briefPath = writeBrief(tp, TRIVIAL_BRIEF);

      // --- classify ---
      const classifyRes = runTierClassify(tp.paths, briefPath);
      expect(classifyRes.ok).toBe(true);
      expect(classifyRes.exitCode).toBe(0);
      expect(classifyRes.data?.tier0_eligible).toBe(true);
      expect(classifyRes.data?.blocked_by_veto).toBe(false);
      expect(classifyRes.data?.blast_radius_flags).toEqual([]);
      expect(classifyRes.data?.advisory).toBe("T0");
      expect(classifyRes.data?.reasons).toEqual([]);
      // No brownfield advisory signal in greenfield output.
      expect(classifyRes.data?.brownfield_prerequisite_missing).toBeUndefined();

      // --- veto-check ---
      const vetoRes = runTierVetoCheck(tp.paths, briefPath);
      expect(vetoRes.ok).toBe(true);
      expect(vetoRes.exitCode).toBe(0);
      expect(vetoRes.data?.blocked).toBe(false);
      expect(vetoRes.data?.flags).toEqual([]);
      // No brownfield error field in greenfield output.
      expect(vetoRes.data?.error).toBeUndefined();
    },
  );

  it(
    "REQ-304: greenfield — explicit project_mode:'greenfield' in state → same byte-identical baseline",
    () => {
      tp = makeTempProject();
      // Explicitly greenfield state.json.
      fs.mkdirSync(tp.paths.stateDir, { recursive: true });
      writeState(tp.paths, { ...initialState(), project_mode: "greenfield" });

      const briefPath = writeBrief(tp, TRIVIAL_BRIEF);

      const classifyRes = runTierClassify(tp.paths, briefPath);
      expect(classifyRes.ok).toBe(true);
      expect(classifyRes.exitCode).toBe(0);
      expect(classifyRes.data?.brownfield_prerequisite_missing).toBeUndefined();

      const vetoRes = runTierVetoCheck(tp.paths, briefPath);
      expect(vetoRes.ok).toBe(true);
      expect(vetoRes.exitCode).toBe(0);
      expect(vetoRes.data?.blocked).toBe(false);
      expect(vetoRes.data?.error).toBeUndefined();
    },
  );

  // -------------------------------------------------------------------------
  // REQ-305: absent / unreadable state.json must not trigger gate
  // -------------------------------------------------------------------------
  it(
    "REQ-305: test_REQ304_unreadable_state_does_not_trigger_gate — absent state.json → tiering follows greenfield path (new readState must not alter non-brownfield output)",
    () => {
      tp = makeTempProject();
      // Confirm no state.json exists (makeTempProject gives a fresh dir).
      expect(fs.existsSync(tp.paths.stateFile)).toBe(false);

      const briefPath = writeBrief(tp, TRIVIAL_BRIEF);

      const classifyRes = runTierClassify(tp.paths, briefPath);
      expect(classifyRes.ok).toBe(true);
      expect(classifyRes.exitCode).toBe(0);
      expect(classifyRes.data?.brownfield_prerequisite_missing).toBeUndefined();

      const vetoRes = runTierVetoCheck(tp.paths, briefPath);
      expect(vetoRes.ok).toBe(true);
      expect(vetoRes.exitCode).toBe(0);
      expect(vetoRes.data?.blocked).toBe(false);
      expect(vetoRes.data?.error).toBeUndefined();
    },
  );

  it(
    "REQ-305: corrupted state.json (invalid JSON) → treated as greenfield, gate does not fire",
    () => {
      tp = makeTempProject();
      // Write an unreadable/corrupt state.json.
      fs.mkdirSync(tp.paths.stateDir, { recursive: true });
      fs.writeFileSync(tp.paths.stateFile, "{ not valid json !!", "utf8");

      const briefPath = writeBrief(tp, TRIVIAL_BRIEF);

      // Neither command should crash or trigger brownfield gate.
      const classifyRes = runTierClassify(tp.paths, briefPath);
      expect(classifyRes.ok).toBe(true);
      expect(classifyRes.exitCode).toBe(0);
      expect(classifyRes.data?.brownfield_prerequisite_missing).toBeUndefined();

      const vetoRes = runTierVetoCheck(tp.paths, briefPath);
      expect(vetoRes.ok).toBe(true);
      expect(vetoRes.exitCode).toBe(0);
      expect(vetoRes.data?.error).toBeUndefined();
    },
  );
});
