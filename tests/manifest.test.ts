/**
 * `th manifest export` — deterministic run snapshot (Phase 4) — REQ-anchored.
 */

import { describe, it, expect, afterEach } from "vitest";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { runStateSet } from "../src/commands/state";
import { runDriftAdd } from "../src/commands/drift";
import { buildManifest, runManifestExport } from "../src/commands/manifest";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

function seedRun(t: TempProject): void {
  runInit(t.paths, {});
  runStateSet(t.paths, "tier", "T2");
  runStateSet(t.paths, "current_stage", "implementation");
  runStateSet(t.paths, "blast_radius_flags", '["money","authentication"]');
  runStateSet(t.paths, "implementation_allowed", "true");
  runDriftAdd(t.paths, { layer: "requirement", ref: "SLICE-1 / TASK-001", discovery: "x", action: "paused" });
}

describe("REQ-MANIFEST-001: deterministic run snapshot", () => {
  it("aggregates state, drift, and the gate ledger", () => {
    tp = makeTempProject();
    seedRun(tp);
    const res = runManifestExport(tp.paths);
    expect(res.ok).toBe(true);
    const m = (res.data as { manifest: ReturnType<typeof buildManifest> }).manifest!;
    expect(m.tier).toBe("T2");
    expect(m.current_stage).toBe("implementation");
    expect(m.implementation_allowed).toBe(true);
    // blast_radius_flags are sorted deterministically.
    expect(m.blast_radius_flags).toEqual(["authentication", "money"]);
    expect(m.drift_open_blocking).toBe(1);
    expect(m.drift_entries.length).toBe(1);
    expect(m.gate_ledger.count).toBeGreaterThan(0);
  });

  it("is byte-stable: ledger timestamps are dropped so repeated exports match", () => {
    tp = makeTempProject();
    seedRun(tp);
    const a = buildManifest(tp.paths);
    const b = buildManifest(tp.paths);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // No volatile ts leaked into the manifest's ledger view.
    for (const e of a!.gate_ledger.events) {
      expect(e).not.toHaveProperty("ts");
    }
  });

  it("fails cleanly when there is no run", () => {
    tp = makeTempProject();
    const res = runManifestExport(tp.paths);
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("not_initialized");
  });
});
