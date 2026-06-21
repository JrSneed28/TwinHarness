/**
 * SG3 P2-C — the production-reality gate (audit C-05..C-08).
 *
 * Covers:
 *  - The 4 `checkProductionReality` conditions independently (one stable token each)
 *    + the corrupt-ledger fail-closed token + the stage-aware no-op pre-final.
 *  - `th sim` add/list/retire lifecycle + the blocking-id read model.
 *  - `th sim scan` flags an unledgered `stub` in dist/.
 *  - SEAM-PARITY (C-A, mandatory): `th next` (via the composed ladder) AND the
 *    inheriting MCP gate tool (`th_stage_advance` → canAdvanceStage) return the SAME
 *    stable error token for an IDENTICAL red state at final-verification — proving the
 *    gate was reseated through the shared seam, not bypassed.
 *  - e2e gate red→green leg.
 *
 * Strategy mirrors gate-preconditions.test.ts: build a project whose ENTIRE
 * final-verification ladder is green EXCEPT the production-reality rung, then perturb
 * exactly one production-reality condition and assert its stable token.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import { writeState, readState } from "../src/core/state-store";
import { initialState, type TwinHarnessState } from "../src/core/state-schema";
import { runArtifactRegister } from "../src/commands/artifact";
import {
  checkProductionReality,
  canAdvanceStage,
  checkFinalVerification,
} from "../src/core/gate-preconditions";
import { runNext } from "../src/commands/next";
import { runSimAdd, runSimList, runSimRetire, runSimScan, simulationLedgerPath } from "../src/commands/sim";
import { runGateProductionReality } from "../src/commands/gate";
import { runTesterRecord } from "../src/commands/tester";
import { testerRecordPath, readTesterRecord } from "../src/core/tester";
import type { ProjectPaths } from "../src/core/paths";

let tp: TempProject | undefined;
afterEach(() => {
  tp?.cleanup();
  tp = undefined;
});

function writeFile(paths: ProjectPaths, rel: string, body: string): void {
  const abs = path.resolve(paths.root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, "utf8");
}

function state(paths: ProjectPaths): TwinHarnessState {
  return readState(paths).state!;
}

/** Attach a valid live-QA Tester record (satisfies condition 3). */
function attachTesterRecord(paths: ProjectPaths): void {
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.writeFileSync(testerRecordPath(paths), JSON.stringify({ driver: "cli-e2e", provider: "sandbox" }), "utf8");
}

/**
 * A project whose entire final-verification ladder is GREEN — slices settled,
 * no verify config (vacuously green), coverage clean (REQ-001 planned+tested), the
 * verification report registered, a Tester record attached, and no dist/ at all — so
 * the ONLY remaining lever is a production-reality condition the caller perturbs.
 */
function greenAtFinalVerification(): ProjectPaths {
  tp = makeTempProject();
  const paths = tp.paths;
  writeFile(paths, "docs/01-requirements.md", "# Requirements\n\n- REQ-001 the only requirement.\n");
  writeFile(paths, "docs/09-implementation-plan.md", "# Plan\n\nSLICE-0 covers REQ-001.\n");
  writeFile(paths, "tests/cov.test.ts", "// REQ-001 verified here\n");
  writeFile(paths, "docs/10-verification-report.md", "# Verification Report\n\nREQ-001 verified.\n");
  writeState(paths, {
    ...initialState(),
    tier: "T1",
    current_stage: "final-verification",
    implementation_allowed: true,
    slices: [{ id: "SLICE-0", status: "done", components: [] }],
  });
  const reg = runArtifactRegister(paths, "docs/10-verification-report.md", 1);
  expect(reg.ok).toBe(true);
  attachTesterRecord(paths);
  return paths;
}

describe("checkProductionReality — the 4 conditions, each a distinct stable token", () => {
  it("GREEN baseline passes (all four conditions satisfied)", () => {
    const paths = greenAtFinalVerification();
    expect(checkProductionReality(paths, state(paths))).toEqual({ ok: true });
  });

  it("condition 1 — a non-retired user-visible simulation → simulation_unretired", () => {
    const paths = greenAtFinalVerification();
    runSimAdd(paths, { classification: "Mocked", userVisible: true, replaces: "auth" });
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("simulation_unretired");
    expect((res.detail!.ids as string[])).toContain("SIM-001");
  });

  it("condition 1 does NOT fire for a non-user-visible simulation (mocks-in-tests are legal)", () => {
    const paths = greenAtFinalVerification();
    runSimAdd(paths, { classification: "Mocked", userVisible: false, replaces: "test double" });
    expect(checkProductionReality(paths, state(paths))).toEqual({ ok: true });
  });

  it("condition 1 does NOT fire for a Real/Sandbox classification (reality never blocks)", () => {
    const paths = greenAtFinalVerification();
    runSimAdd(paths, { classification: "Real", userVisible: true, replaces: "live API" });
    runSimAdd(paths, { classification: "Sandbox", userVisible: true, replaces: "sandbox API" });
    expect(checkProductionReality(paths, state(paths))).toEqual({ ok: true });
  });

  it("condition 2 — a red verify report → production_verify_not_green", () => {
    const paths = greenAtFinalVerification();
    // A configured suite with a red report (write config + a failing report).
    fs.writeFileSync(path.join(paths.stateDir, "verify.json"), JSON.stringify({ commands: ["npm test"] }), "utf8");
    fs.writeFileSync(
      path.join(paths.stateDir, "verify-report.json"),
      JSON.stringify({ ok: false, ranAt: new Date().toISOString(), results: [{ command: "npm test", exitCode: 1, ok: false, durationMs: 1, outputTail: "x" }] }),
      "utf8",
    );
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("production_verify_not_green");
  });

  it("condition 3 — no Tester record → tester_record_missing", () => {
    const paths = greenAtFinalVerification();
    fs.rmSync(testerRecordPath(paths), { force: true });
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("tester_record_missing");
  });

  it("condition 4 — unledgered simulation pattern in dist/ → unledgered_simulation_in_dist", () => {
    const paths = greenAtFinalVerification();
    writeFile(paths, "dist/x.js", "const v = stubProvider(); // placeholder\n");
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("unledgered_simulation_in_dist");
    expect((res.detail!.total as number)).toBeGreaterThan(0);
  });

  it("condition 4 is suppressed once an ACTIVE simulation entry declares the simulation", () => {
    const paths = greenAtFinalVerification();
    writeFile(paths, "dist/x.js", "const v = stubProvider(); // placeholder\n");
    // A non-user-visible active stub entry declares the simulation: dist hits are now ledgered.
    runSimAdd(paths, { classification: "Stubbed", userVisible: false, replaces: "provider" });
    expect(checkProductionReality(paths, state(paths))).toEqual({ ok: true });
  });

  it("a corrupt simulation ledger fails CLOSED → simulation_ledger_corrupt", () => {
    const paths = greenAtFinalVerification();
    fs.writeFileSync(simulationLedgerPath(paths), "}{ not json", "utf8");
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("simulation_ledger_corrupt");
  });

  it("stage-aware: production-reality is a no-op before final-verification (no Tester/dist needed)", () => {
    const paths = greenAtFinalVerification();
    // Move to a pre-final stage and strip the Tester record: the rung must NOT block.
    writeState(paths, { ...state(paths), current_stage: "implementation-planning" });
    fs.rmSync(testerRecordPath(paths), { force: true });
    expect(checkProductionReality(paths, state(paths))).toEqual({ ok: true });
  });
});

describe("th sim — add / list / retire lifecycle", () => {
  it("add mints SIM-NNN; list reports it and flags it as blocking; retire clears the block", () => {
    tp = makeTempProject();
    const paths = tp.paths;
    writeState(paths, { ...initialState(), tier: "T1", current_stage: "implementation" });

    const add = runSimAdd(paths, { classification: "Stubbed", userVisible: true, replaces: "payments" });
    expect(add.ok).toBe(true);
    expect(add.data!.id).toBe("SIM-001");
    expect(add.data!.blocks).toBe(true);

    const list = runSimList(paths, {});
    expect(list.ok).toBe(true);
    expect((list.data!.entries as unknown[]).length).toBe(1);
    expect((list.data!.blocking as string[])).toEqual(["SIM-001"]);

    const retire = runSimRetire(paths, "SIM-001", { retireSlice: "SLICE-3" });
    expect(retire.ok).toBe(true);
    expect((retire.data!.entry as { status: string }).status).toBe("retired");

    const list2 = runSimList(paths, {});
    expect((list2.data!.blocking as string[])).toEqual([]);
  });

  it("add refuses an unknown classification", () => {
    tp = makeTempProject();
    const paths = tp.paths;
    writeState(paths, { ...initialState(), tier: "T1" });
    const res = runSimAdd(paths, { classification: "Bogus" });
    expect(res.ok).toBe(false);
    expect(res.data!.error).toBe("invalid_classification");
  });

  it("retire refuses an unknown id and a double-retire", () => {
    tp = makeTempProject();
    const paths = tp.paths;
    writeState(paths, { ...initialState(), tier: "T1" });
    runSimAdd(paths, { classification: "Mocked", userVisible: true });
    expect(runSimRetire(paths, "SIM-999").data!.error).toBe("simulation_not_found");
    runSimRetire(paths, "SIM-001");
    expect(runSimRetire(paths, "SIM-001").data!.error).toBe("already_retired");
  });

  it("ids stay monotonic across adds (append-only, never reused)", () => {
    tp = makeTempProject();
    const paths = tp.paths;
    writeState(paths, { ...initialState(), tier: "T1" });
    expect(runSimAdd(paths, { classification: "Mocked" }).data!.id).toBe("SIM-001");
    expect(runSimAdd(paths, { classification: "Stubbed" }).data!.id).toBe("SIM-002");
    runSimRetire(paths, "SIM-001");
    // A retire does not free the id; the next add is SIM-003.
    expect(runSimAdd(paths, { classification: "Hardcoded" }).data!.id).toBe("SIM-003");
  });
});

describe("th sim scan — flags an unledgered simulation pattern in dist/", () => {
  it("flags a `stub` in dist/ with no active ledger entry; advisory (exit 0)", () => {
    tp = makeTempProject();
    const paths = tp.paths;
    writeState(paths, { ...initialState(), tier: "T1" });
    writeFile(paths, "dist/fake.js", "const x = stubProvider(); // TODO real impl\n");

    const res = runSimScan(paths, {});
    expect(res.ok).toBe(true); // advisory — never refuses
    expect(res.exitCode).toBe(0);
    const unledgered = res.data!.unledgeredDistHits as Array<{ token: string }>;
    expect(unledgered.length).toBeGreaterThan(0);
    expect(unledgered.some((h) => h.token === "stub")).toBe(true);
  });

  it("treats a RETIRED entry as not covering dist hits (still unledgered)", () => {
    tp = makeTempProject();
    const paths = tp.paths;
    writeState(paths, { ...initialState(), tier: "T1" });
    writeFile(paths, "dist/fake.js", "const x = stub();\n");
    runSimAdd(paths, { classification: "Stubbed", userVisible: false });
    runSimRetire(paths, "SIM-001");
    const res = runSimScan(paths, {});
    expect((res.data!.unledgeredDistHits as unknown[]).length).toBeGreaterThan(0);
  });
});

describe("th tester record — the missing writer for the gate's 3rd condition (audit P1)", () => {
  it("requires a non-empty driver", () => {
    const paths = greenAtFinalVerification();
    fs.rmSync(testerRecordPath(paths), { force: true });
    expect(runTesterRecord(paths, { driver: "" }).data!.error).toBe("missing_driver");
    expect(runTesterRecord(paths, {}).data!.error).toBe("missing_driver");
  });

  it("writes a well-shaped record (driver/provider/evidence/ranAt) the gate's read predicate accepts", () => {
    const paths = greenAtFinalVerification();
    fs.rmSync(testerRecordPath(paths), { force: true });
    const res = runTesterRecord(paths, { driver: "playwright", provider: "sandbox", evidenceRef: "out/run.log" });
    expect(res.ok).toBe(true);
    const rec = readTesterRecord(paths);
    expect(rec).not.toBeNull();
    expect(rec!.driver).toBe("playwright");
    expect(rec!.provider).toBe("sandbox");
    expect(rec!.evidenceRef).toBe("out/run.log");
    expect(typeof rec!.ranAt).toBe("string");
  });

  it("CLEARS the production-reality gate's tester_record_missing block end-to-end", () => {
    const paths = greenAtFinalVerification();
    fs.rmSync(testerRecordPath(paths), { force: true });
    expect(checkProductionReality(paths, state(paths)).error).toBe("tester_record_missing");
    expect(runTesterRecord(paths, { driver: "cli-e2e" }).ok).toBe(true);
    expect(checkProductionReality(paths, state(paths))).toEqual({ ok: true });
  });
});

describe("dist/ detection is PER-DEPENDENCY, not global existence (audit P1)", () => {
  it("an UNRELATED active simulation entry does NOT suppress an undeclared dist stub", () => {
    const paths = greenAtFinalVerification();
    writeFile(paths, "dist/payments.js", "const v = stubProvider(); // placeholder\n");
    // An active simulation about an UNRELATED dependency must not blanket-cover the
    // payments stub — the regression the audit flagged (global existence check).
    runSimAdd(paths, { classification: "Mocked", userVisible: false, replaces: "telemetry-sink" });
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("unledgered_simulation_in_dist");
  });

  it("an entry whose `replaces` names the dependency DOES cover the matching dist hit", () => {
    const paths = greenAtFinalVerification();
    writeFile(paths, "dist/x.js", "const v = stubProvider(); // placeholder\n");
    // "provider" appears in the matched line `stubProvider()` → per-dependency match.
    runSimAdd(paths, { classification: "Stubbed", userVisible: false, replaces: "provider" });
    expect(checkProductionReality(paths, state(paths))).toEqual({ ok: true });
  });

  it("th sim scan agrees: an unrelated entry leaves the dist hit unledgered", () => {
    tp = makeTempProject();
    const paths = tp.paths;
    writeState(paths, { ...initialState(), tier: "T1" });
    writeFile(paths, "dist/payments.js", "const x = stubProvider();\n");
    runSimAdd(paths, { classification: "Stubbed", userVisible: false, replaces: "telemetry-sink" });
    const res = runSimScan(paths, {});
    expect((res.data!.unledgeredDistHits as unknown[]).length).toBeGreaterThan(0);
  });
});

describe("simulation ledger fails CLOSED on a malformed row (audit P2)", () => {
  it("a damaged blocker row → simulation_ledger_corrupt (it does not silently disappear)", () => {
    const paths = greenAtFinalVerification();
    // A user-visible Mocked blocker whose `userVisible` flag was edited away (string,
    // not boolean) must NOT downgrade to non-blocking — the whole ledger reads corrupt.
    fs.writeFileSync(
      simulationLedgerPath(paths),
      JSON.stringify([{ id: "SIM-001", classification: "Mocked", status: "active", userVisible: "true", replaces: "auth" }]),
      "utf8",
    );
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("simulation_ledger_corrupt");
  });

  it("an entry with an invalid classification → simulation_ledger_corrupt", () => {
    const paths = greenAtFinalVerification();
    fs.writeFileSync(
      simulationLedgerPath(paths),
      JSON.stringify([{ id: "SIM-001", classification: "Bogus", status: "active", userVisible: true }]),
      "utf8",
    );
    expect(checkProductionReality(paths, state(paths)).error).toBe("simulation_ledger_corrupt");
  });

  it("a non-object row → simulation_ledger_corrupt (no skip-malformed fail-open)", () => {
    const paths = greenAtFinalVerification();
    fs.writeFileSync(simulationLedgerPath(paths), JSON.stringify(["not-an-object"]), "utf8");
    expect(checkProductionReality(paths, state(paths)).error).toBe("simulation_ledger_corrupt");
  });
});

describe("SEAM-PARITY (C-A) — th next and the MCP gate tool agree on the token", () => {
  /**
   * The mechanical proof the gate was reseated through the shared seam, not bypassed:
   * for an IDENTICAL red state at final-verification, the ladder (`canAdvanceStage`,
   * which the MCP `th_stage_advance` tool consumes) and the `th next` oracle must both
   * surface the SAME production-reality condition. We assert the ladder's token equals
   * the predicate's token AND that `th next`'s rendered action carries the same data.
   */
  it("simulation_unretired: canAdvanceStage (MCP twin path) === checkFinalVerification === th next data", () => {
    const paths = greenAtFinalVerification();
    runSimAdd(paths, { classification: "Mocked", userVisible: true, replaces: "auth" });
    const s = state(paths);

    // The MCP gate tools consume canAdvanceStage; assert it surfaces the token.
    const ladder = canAdvanceStage(paths, s);
    expect(ladder.ok).toBe(false);
    expect(ladder.error).toBe("simulation_unretired");

    // checkFinalVerification (the composed sub-rung) returns the SAME token.
    expect(checkFinalVerification(paths, s).error).toBe("simulation_unretired");

    // The pure reader returns the SAME token.
    expect(runGateProductionReality(paths).data!.error).toBe("simulation_unretired");

    // th next renders the matching action carrying the same id state (NOT degraded
    // to "reader returns red" — the oracle reaches the same rung for the same state).
    const next = runNext(paths, {});
    expect(next.data!.kind).toBe("retire-simulation");
    expect((next.data!.ids as string[])).toContain("SIM-001");
  });

  it("tester_record_missing: ladder token === reader token === th next action", () => {
    const paths = greenAtFinalVerification();
    fs.rmSync(testerRecordPath(paths), { force: true });
    const s = state(paths);
    expect(canAdvanceStage(paths, s).error).toBe("tester_record_missing");
    expect(runGateProductionReality(paths).data!.error).toBe("tester_record_missing");
    expect(runNext(paths, {}).data!.kind).toBe("run-tester");
  });
});

describe("e2e — production-reality gate red→green leg", () => {
  it("blocks at final-verification, then clears once the user-visible sim is retired and a Tester record is attached", () => {
    const paths = greenAtFinalVerification();
    // Strip the Tester record and add a user-visible simulation → RED.
    fs.rmSync(testerRecordPath(paths), { force: true });
    runSimAdd(paths, { classification: "Stubbed", userVisible: true, replaces: "db" });

    // RED: the first production-reality blocker is the simulation.
    expect(runGateProductionReality(paths).data!.error).toBe("simulation_unretired");

    // Retire the simulation → next blocker is the missing Tester record.
    runSimRetire(paths, "SIM-001");
    expect(runGateProductionReality(paths).data!.error).toBe("tester_record_missing");

    // Attach the Tester record → GREEN.
    attachTesterRecord(paths);
    const green = runGateProductionReality(paths);
    expect(green.ok).toBe(true);
    expect(green.exitCode).toBe(0);

    // And the ladder the MCP gate tool consumes now passes the production-reality rung
    // (canAdvanceStage at the terminal final stage returns PASS through the gate;
    // the only thing left is the human sign-off the CLI cannot certify).
    expect(canAdvanceStage(paths, state(paths))).toEqual({ ok: true });
  });
});
