/**
 * Axis-B slice-1a (BSC-4) — sim-retire receipt grounding (src/commands/sim.ts).
 *
 * The producer-side + receipt-aware-join half of the keystone, tested against the
 * frozen `src/core/receipts.ts` API:
 *  - negative-control (c) at creation: retiring a BLOCKING (user-visible) simulation
 *    REQUIRES `--target`, and a non-resolving target refuses the flip (entry stays
 *    active, no partial flip).
 *  - the happy path: a real target mints a `valid` sim-retire receipt and clears the
 *    receipt-aware rung-1 blocker.
 *  - negative-control (d) no-double-exoneration: once migrated, a receipt-LESS retire
 *    (the `--emergency`/attestation bypass, simulated by writing the ledger directly)
 *    still BLOCKS and still counts in the dist-scan coverage set.
 *  - a non-user-visible simulated entry retires WITHOUT a target (behavior unchanged).
 *
 * Deterministic + Windows-safe (path.join, no shell, scratch projects via mkdtemp).
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import { writeState } from "../src/core/state-store";
import { initialState } from "../src/core/state-schema";
import {
  runSimAdd,
  runSimRetire,
  readSimulationLedger,
  simulationLedgerPath,
  simEntryBlocksProductionReality,
  activeOrUngroundedSimulatedEntries,
  computeUnledgeredDistHitsReceiptAware,
  type ScanHit,
} from "../src/commands/sim";
import { readReceiptValidated, receiptMigrationDone } from "../src/core/receipts";
import type { ProjectPaths } from "../src/core/paths";
import type { SimulationEntry } from "../src/core/simulation";

let tp: TempProject | undefined;
afterEach(() => {
  tp?.cleanup();
  tp = undefined;
});

/** A temp project with an initialized state.json so the sim handlers run past their guards. */
function freshProject(): ProjectPaths {
  tp = makeTempProject();
  const paths = tp.paths;
  fs.mkdirSync(paths.stateDir, { recursive: true });
  writeState(paths, { ...initialState(), tier: "T1", current_stage: "implementation" });
  return paths;
}

/** Write a real source file the retirement can ground against; return its root-relative path. */
function writeSourceFile(root: string, rel: string, content: string): string {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  return rel;
}

/** The single ledger entry by id (after re-reading the ledger from disk). */
function entryById(paths: ProjectPaths, id: string): SimulationEntry {
  const e = readSimulationLedger(paths).find((x) => x.id === id);
  if (!e) throw new Error(`entry ${id} not found`);
  return e;
}

describe("sim-retire receipt grounding (BSC-4) — negative-control (c) at creation", () => {
  it("retiring a user-visible Mocked entry WITHOUT --target → sim_retire_target_required, stays active", () => {
    const paths = freshProject();
    expect(runSimAdd(paths, { classification: "Mocked", userVisible: true, replaces: "auth" }).ok).toBe(true);

    const res = runSimRetire(paths, "SIM-001"); // no --target
    expect(res.ok).toBe(false);
    expect(res.data!.error).toBe("sim_retire_target_required");
    // No partial flip: the entry is still active.
    expect(entryById(paths, "SIM-001").status).toBe("active");
  });

  it("retiring with a NON-RESOLVING --target → receipt_target_unresolved, stays active", () => {
    const paths = freshProject();
    expect(runSimAdd(paths, { classification: "Mocked", userVisible: true, replaces: "auth" }).ok).toBe(true);

    const res = runSimRetire(paths, "SIM-001", { target: "src/does-not-exist.ts" });
    expect(res.ok).toBe(false);
    expect(res.data!.error).toBe("receipt_target_unresolved");
    expect(res.data!.target).toBe("src/does-not-exist.ts");
    // Mint failed BEFORE the flip — entry stays active, no receipt was written.
    expect(entryById(paths, "SIM-001").status).toBe("active");
    expect(readReceiptValidated(paths, "sim-retire", "SIM-001").status).not.toBe("valid");
  });

  it("retiring with a REAL --target → succeeds, mints a VALID receipt, and clears the rung-1 blocker", () => {
    const paths = freshProject();
    const target = writeSourceFile(paths.root, "src/auth.ts", "export const realAuth = () => true;\n");
    expect(runSimAdd(paths, { classification: "Mocked", userVisible: true, replaces: "auth" }).ok).toBe(true);

    // Before retire: an active user-visible simulation blocks.
    expect(simEntryBlocksProductionReality(paths, entryById(paths, "SIM-001"))).toBe(true);

    const res = runSimRetire(paths, "SIM-001", { target });
    expect(res.ok).toBe(true);
    expect(entryById(paths, "SIM-001").status).toBe("retired");
    expect(readReceiptValidated(paths, "sim-retire", "SIM-001").status).toBe("valid");
    // Grounded retire no longer blocks.
    expect(simEntryBlocksProductionReality(paths, entryById(paths, "SIM-001"))).toBe(false);
  });
});

describe("sim-retire receipt grounding (BSC-4) — negative-control (d) no double-exoneration", () => {
  it("a receipt-LESS retire of a user-visible entry (post-migration) still BLOCKS and stays in coverage", () => {
    const paths = freshProject();

    // Establish the migration marker via one GROUNDED retire — so the project is now
    // "migrated" and an absent receipt classifies as `absent` (BLOCK), not implicitly
    // grandfathered. SIM-001 is a throwaway grounded retirement to flip the marker on.
    const t0 = writeSourceFile(paths.root, "src/seed.ts", "export const seed = 1;\n");
    expect(runSimAdd(paths, { classification: "Mocked", userVisible: true, replaces: "seed-dep" }).ok).toBe(true);
    expect(runSimRetire(paths, "SIM-001", { target: t0 }).ok).toBe(true);
    expect(receiptMigrationDone(paths)).toBe(true);

    // The bypass target: a user-visible blocking entry whose dependency appears in dist/.
    expect(runSimAdd(paths, { classification: "Stubbed", userVisible: true, replaces: "payments" }).ok).toBe(true);

    // Simulate the --emergency/attestation bypass: flip SIM-002 to "retired" by writing
    // the ledger DIRECTLY, WITHOUT minting a receipt. (runSimRetire would have required
    // a --target + receipt; this mimics a raw `state set`-style ledger edit.)
    const all = readSimulationLedger(paths).map((e) =>
      e.id === "SIM-002" ? { ...e, status: "retired" as const } : e,
    );
    fs.writeFileSync(simulationLedgerPath(paths), JSON.stringify(all, null, 2) + "\n", "utf8");

    const bypassed = entryById(paths, "SIM-002");
    expect(bypassed.status).toBe("retired");
    // No valid/legacy receipt backs this retirement.
    expect(readReceiptValidated(paths, "sim-retire", "SIM-002").status).toBe("absent");

    // (d) The retired-but-ungrounded entry STILL blocks (no double-exoneration).
    expect(simEntryBlocksProductionReality(paths, bypassed)).toBe(true);

    // (d) It is STILL in the dist-scan coverage set (active-or-ungrounded).
    const coverage = activeOrUngroundedSimulatedEntries(paths, readSimulationLedger(paths));
    expect(coverage.map((e) => e.id)).toContain("SIM-002");

    // (d) Its declared dependency ("payments") therefore still COVERS a dist hit on it —
    // the join treats the ungrounded entry exactly like an active one, so the hit is NOT
    // reported as unledgered (the exoneration cannot disappear the live simulation).
    const distHits: ScanHit[] = [
      { file: "dist/payments.js", line: 3, token: "stub", text: "// payments stub" },
    ];
    const unledgered = computeUnledgeredDistHitsReceiptAware(paths, readSimulationLedger(paths), distHits);
    expect(unledgered).toHaveLength(0);
  });
});

describe("sim-retire receipt grounding (BSC-4) — non-blocking retire unchanged", () => {
  it("a non-user-visible simulated entry retires WITHOUT a target (no receipt required)", () => {
    const paths = freshProject();
    expect(runSimAdd(paths, { classification: "Stubbed", userVisible: false, replaces: "provider" }).ok).toBe(true);

    const res = runSimRetire(paths, "SIM-001"); // no --target — allowed for non-blocking
    expect(res.ok).toBe(true);
    expect(entryById(paths, "SIM-001").status).toBe("retired");
    // No receipt was minted; a non-user-visible entry never blocks either way.
    expect(simEntryBlocksProductionReality(paths, entryById(paths, "SIM-001"))).toBe(false);
  });
});
