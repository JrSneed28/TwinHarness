/**
 * Track A-2 — `th handoff write` / `th handoff verify` / `th resume`.
 *
 * handoff write assembles `.twinharness/HANDOFF.md` from durable state + the next
 * action + artifact Summary blocks (reusing context pack) + open questions + a
 * "don't re-read docs/" directive; handoff verify confirms a clean resume against
 * the embedded snapshot (current_stage / slice status / approved-artifact hashes);
 * resume detects the handoff and prints the next action.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { runArtifactRegister } from "../src/commands/artifact";
import { runStateSet } from "../src/commands/state";
import { writeState, readState } from "../src/core/state-store";
import { runHandoffWrite, runHandoffVerify, runResume, handoffPath } from "../src/commands/handoff";

let tp: TempProject | undefined;
afterEach(() => {
  tp?.cleanup();
  tp = undefined;
});

/** Init a project + register one artifact with a Summary block. */
function seed(root: string, paths: TempProject["paths"]): void {
  runInit(paths, {});
  fs.writeFileSync(
    path.join(root, "docs", "01-requirements.md"),
    "# Requirements\n\n## Summary\nGoverning summary block.\n\nREQ-001 the thing.\n",
    "utf8",
  );
  runArtifactRegister(paths, "docs/01-requirements.md", 1);
}

describe("Track A-2: handoff write contents", () => {
  it("writes .twinharness/HANDOFF.md with every required section + the directive", () => {
    tp = makeTempProject();
    seed(tp.root, tp.paths);
    const res = runHandoffWrite(tp.paths);
    expect(res.ok).toBe(true);

    const md = fs.readFileSync(handoffPath(tp.paths), "utf8");
    // Stage / wave-style run state, slices, next action, summary blocks, directive.
    expect(md).toContain("current_stage:");
    expect(md).toContain("## Slices");
    expect(md).toContain("## Next action");
    expect(md).toContain("## Open questions");
    expect(md).toContain("Artifact Summary blocks");
    expect(md).toContain("Governing summary block.");
    expect(md.toLowerCase()).toContain("do not re-read");
  });

  it("data payload surfaces the next action, slices, and artifact snapshot", () => {
    tp = makeTempProject();
    seed(tp.root, tp.paths);
    const res = runHandoffWrite(tp.paths);
    const d = res.data as Record<string, unknown>;
    expect(d.path).toBe(".twinharness/HANDOFF.md");
    expect(typeof d.nextAction).toBe("string");
    expect(d.sections).toContain("Next action");
    const artifacts = d.artifacts as Array<{ file: string }>;
    expect(artifacts.some((a) => a.file === "docs/01-requirements.md")).toBe(true);
  });

  it("includes open questions when present", () => {
    tp = makeTempProject();
    seed(tp.root, tp.paths);
    runStateSet(tp.paths, "open_questions", JSON.stringify(["what is the auth model?"]));
    runHandoffWrite(tp.paths);
    const md = fs.readFileSync(handoffPath(tp.paths), "utf8");
    expect(md).toContain("what is the auth model?");
  });

  it("refuses when no state.json exists", () => {
    tp = makeTempProject();
    const res = runHandoffWrite(tp.paths);
    expect(res.ok).toBe(false);
    expect((res.data as Record<string, unknown>).error).toBe("not_initialized");
  });
});

describe("Track A-2: handoff verify pass + fail", () => {
  it("PASS when current_stage, slices, and artifact hashes all match", () => {
    tp = makeTempProject();
    seed(tp.root, tp.paths);
    runHandoffWrite(tp.paths);
    const res = runHandoffVerify(tp.paths);
    expect(res.ok).toBe(true);
    expect((res.data as Record<string, unknown>).pass).toBe(true);
  });

  it("FAIL when an approved artifact's content changed since the handoff", () => {
    tp = makeTempProject();
    seed(tp.root, tp.paths);
    runHandoffWrite(tp.paths);
    fs.appendFileSync(path.join(tp.root, "docs", "01-requirements.md"), "\nmutated\n", "utf8");
    const res = runHandoffVerify(tp.paths);
    expect(res.ok).toBe(false);
    const mismatches = (res.data as Record<string, unknown>).mismatches as string[];
    expect(mismatches.some((m) => m.includes("docs/01-requirements.md"))).toBe(true);
  });

  it("FAIL when current_stage drifted from the handoff snapshot", () => {
    tp = makeTempProject();
    seed(tp.root, tp.paths);
    runHandoffWrite(tp.paths);
    // Advance the stage out from under the handoff (write directly to bypass enum guard concerns).
    const r = readState(tp.paths);
    writeState(tp.paths, { ...r.state!, current_stage: "requirements" });
    const res = runHandoffVerify(tp.paths);
    expect(res.ok).toBe(false);
    const mismatches = (res.data as Record<string, unknown>).mismatches as string[];
    expect(mismatches.some((m) => m.includes("current_stage"))).toBe(true);
  });

  it("FAIL (no_handoff) when there is no HANDOFF.md to verify", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const res = runHandoffVerify(tp.paths);
    expect(res.ok).toBe(false);
    expect((res.data as Record<string, unknown>).error).toBe("no_handoff");
  });
});

describe("R-06: handoff snapshot stateHash catches gate-relevant changes not in the per-field snapshot", () => {
  it("FAIL when a gate-relevant field NOT in the legacy snapshot changes (drift_open_blocking 0→1)", () => {
    tp = makeTempProject();
    seed(tp.root, tp.paths);
    runHandoffWrite(tp.paths);
    // Open a blocking drift directly via the data layer (the per-field snapshot does
    // NOT track drift_open_blocking — only current_stage / slices / artifacts). The
    // whole-state hash must catch it.
    const r = readState(tp.paths);
    writeState(tp.paths, { ...r.state!, drift_open_blocking: r.state!.drift_open_blocking + 1 });
    const res = runHandoffVerify(tp.paths);
    expect(res.ok).toBe(false);
    const mismatches = (res.data as Record<string, unknown>).mismatches as string[];
    expect(mismatches.some((m) => m.includes("state hash mismatch"))).toBe(true);
  });

  it("FAIL when implementation_allowed flips after the handoff (also untracked per-field)", () => {
    tp = makeTempProject();
    seed(tp.root, tp.paths);
    runHandoffWrite(tp.paths);
    const r = readState(tp.paths);
    writeState(tp.paths, { ...r.state!, implementation_allowed: !r.state!.implementation_allowed });
    const res = runHandoffVerify(tp.paths);
    expect(res.ok).toBe(false);
    const mismatches = (res.data as Record<string, unknown>).mismatches as string[];
    expect(mismatches.some((m) => m.includes("state hash mismatch"))).toBe(true);
  });

  it("PASS when nothing changed (the stateHash matches the live state)", () => {
    tp = makeTempProject();
    seed(tp.root, tp.paths);
    runHandoffWrite(tp.paths);
    const res = runHandoffVerify(tp.paths);
    expect(res.ok).toBe(true);
    expect((res.data as Record<string, unknown>).pass).toBe(true);
  });

  it("the written snapshot embeds a stateHash (current format)", () => {
    tp = makeTempProject();
    seed(tp.root, tp.paths);
    runHandoffWrite(tp.paths);
    const md = fs.readFileSync(handoffPath(tp.paths), "utf8");
    const open = md.indexOf("<!-- TH-HANDOFF-STATE");
    const close = md.indexOf("TH-HANDOFF-STATE -->");
    const json = md.slice(open + "<!-- TH-HANDOFF-STATE".length, close).trim();
    const snap = JSON.parse(json) as Record<string, unknown>;
    expect(typeof snap.stateHash).toBe("string");
    expect((snap.stateHash as string).length).toBe(64); // full sha256 hex
  });

  it("LEGACY TOLERANCE: a snapshot WITHOUT stateHash skips the hash check (falls back to per-field; no hard-fail)", () => {
    tp = makeTempProject();
    seed(tp.root, tp.paths);
    runHandoffWrite(tp.paths);
    // Simulate an OLD handoff: strip the stateHash from the embedded snapshot, then
    // change an untracked field. With no stateHash the verify must NOT fail on the
    // untracked change (it relies on per-field comparisons only) — i.e. legacy files
    // are tolerated, not hard-failed on absence.
    const file = handoffPath(tp.paths);
    const md = fs.readFileSync(file, "utf8");
    const open = md.indexOf("<!-- TH-HANDOFF-STATE");
    const close = md.indexOf("TH-HANDOFF-STATE -->");
    const prefix = md.slice(0, open + "<!-- TH-HANDOFF-STATE".length);
    const json = md.slice(open + "<!-- TH-HANDOFF-STATE".length, close).trim();
    const suffix = md.slice(close);
    const snap = JSON.parse(json) as Record<string, unknown>;
    delete snap.stateHash;
    fs.writeFileSync(file, `${prefix}\n${JSON.stringify(snap)}\n${suffix}`, "utf8");
    // Change an untracked field — without a stateHash this is NOT detected.
    const r = readState(tp.paths);
    writeState(tp.paths, { ...r.state!, drift_open_blocking: r.state!.drift_open_blocking + 1 });
    const res = runHandoffVerify(tp.paths);
    expect(res.ok).toBe(true); // legacy snapshot: per-field still match, no hard-fail
  });
});

describe("Track A-2: resume detection", () => {
  it("detects HANDOFF.md and prints the next action", () => {
    tp = makeTempProject();
    seed(tp.root, tp.paths);
    runHandoffWrite(tp.paths);
    const res = runResume(tp.paths);
    expect(res.ok).toBe(true);
    const d = res.data as Record<string, unknown>;
    expect(d.hasHandoff).toBe(true);
    expect(d.handoffPath).toBe(".twinharness/HANDOFF.md");
    expect(typeof d.nextAction).toBe("string");
  });

  it("still resumes from durable state when HANDOFF.md is absent", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const res = runResume(tp.paths);
    expect(res.ok).toBe(true);
    const d = res.data as Record<string, unknown>;
    expect(d.hasHandoff).toBe(false);
    expect(d.handoffPath).toBeNull();
    expect(typeof d.nextAction).toBe("string");
  });
});
