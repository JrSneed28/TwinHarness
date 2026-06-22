/**
 * Negative-control suite — the SECURITY HEART of Axis-B slice-1a (BSC-4).
 *
 * BSC-4 mints a content-bound `TerminalTransitionReceipt` per irreversible ledger
 * flip and validates it at the completion gate (`checkProductionReality`, rung 1b /
 * rung 1 / rung 4). Each prior §5 bypass surface — a forged/stale snapshot, a
 * post-upgrade absent receipt, a target that does not resolve, a receipt-less retire
 * double-exonerating itself — is now BLOCKED with a STABLE token. These tests prove
 * the four controls fire (and that the migration story keeps existing pre-upgrade
 * projects green). They assert the EXACT stable token; a control that does not block
 * as specified is a real gap in src (reported, never weakened to pass).
 *
 * Strategy mirrors `production-reality.test.ts`: build a project whose ENTIRE
 * final-verification ladder is green EXCEPT the production-reality rung, then perturb
 * exactly ONE receipt condition and assert its stable token.
 */

import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, mintRequiredApprovals, type TempProject } from "./helpers";
import { writeState, readState } from "../src/core/state-store";
import { initialState, type TwinHarnessState } from "../src/core/state-schema";
import { runArtifactRegister } from "../src/commands/artifact";
import { checkProductionReality } from "../src/core/gate-preconditions";
import { runDriftAdd, runDriftResolve } from "../src/commands/drift";
import {
  runSimAdd,
  runSimRetire,
  simulationLedgerPath,
  scanForSimulationHits,
  simEntryBlocksProductionReality,
  computeUnledgeredDistHitsReceiptAware,
  readSimulationLedger,
} from "../src/commands/sim";
import { runTesterRecord } from "../src/commands/tester";
import {
  terminalReceiptsPath,
  computeTargetDigest,
  computeRecordHash,
  currentSnapshotCoord,
  readLastReceiptRecordHash,
  collectTerminalEntities,
  readReceiptValidated,
  receiptMigrationDone,
  type TerminalTransitionReceipt,
} from "../src/core/receipts";
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

/** The migration marker file path (mirrors receipts.ts `migrationMarkerPath`, which is private). */
function migrationMarkerPath(paths: ProjectPaths): string {
  return path.join(paths.stateDir, ".terminal-receipts-migration");
}

/**
 * Attach a VALID, F8-bound live-QA Tester record (satisfies production-reality
 * condition 3). Mirrors `production-reality.test.ts`'s helper.
 */
function attachTesterRecord(paths: ProjectPaths): void {
  expect(runTesterRecord(paths, { driver: "cli-e2e", provider: "sandbox", passed: true }).ok).toBe(true);
}

/**
 * A project whose entire final-verification ladder is GREEN — slices settled, no
 * verify config (vacuously green), coverage clean (REQ-001 planned+tested), the
 * verification report registered, a Tester record attached, and no dist/ — so the
 * ONLY remaining lever is a production-reality (receipt) condition the caller perturbs.
 * Replicated from `production-reality.test.ts:greenAtFinalVerification` (not exported).
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
  // BSC-7 slice-3a C-2: the completion rung re-validates the closed human-approval
  // required-set; mint it (coords null on this non-git fixture, so it stays `valid` even
  // after a per-scenario git init) so the terminal-receipt condition stays the only lever.
  mintRequiredApprovals(paths, state(paths));
  return paths;
}

/** Run `git` in `cwd`, swallowing output (the test only needs the side-effects). */
function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

/**
 * Turn the scratch project into a real git repo with ONE commit, so
 * `currentSnapshotCoord(root).gitHead` is a non-null 40-hex commit. Local identity is
 * pinned so the commit never depends on global git config. Returns the resolved HEAD.
 */
function makeGitRepoWithCommit(paths: ProjectPaths): string {
  const root = paths.root;
  git(root, ["init"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "initial", "--no-verify"]);
  const head = currentSnapshotCoord(root).gitHead;
  expect(head).not.toBeNull();
  expect(head).toMatch(/^[0-9a-f]{40}$/);
  return head!;
}

/**
 * Seed a resolved requirement-layer DRIFT-001 that `collectTerminalEntities` detects:
 *  - a real `## DRIFT-001 (...) — requirement layer, BLOCKING` entry (so the id is a
 *    KNOWN drift entry — `collectTerminalEntities` requires this), and
 *  - a `## DRIFT-001 — resolved` note (em-dash U+2014, exactly as runDriftResolve
 *    writes it) so the entity reads terminal.
 * The blocking counter is left at 0 (so `checkBlockingDrift` is irrelevant — this
 * suite calls `checkProductionReality` directly anyway). Writes the drift log
 * DIRECTLY so NO real receipt is minted (the bypass we are modelling). Returns the id.
 */
function seedResolvedDriftWithoutReceipt(paths: ProjectPaths, id = "DRIFT-001"): string {
  const entry =
    `## ${id}  (SLICE-0 / TASK-1, Builder)  — requirement layer, BLOCKING\n` +
    `Discovery : a contradiction\n` +
    `Action    : resolved against source\n` +
    `Escalation: none\n\n`;
  const resolvedNote = `## ${id} — resolved\n`;
  fs.writeFileSync(paths.driftLog, entry + resolvedNote, "utf8");
  return id;
}

/** A forged, shape-valid receipt line sealed onto the chain at the current tail. */
function appendForgedReceipt(
  paths: ProjectPaths,
  fields: Omit<TerminalTransitionReceipt, "prevHash" | "recordHash">,
): TerminalTransitionReceipt {
  const prevHash = readLastReceiptRecordHash(paths);
  const withPrev: Omit<TerminalTransitionReceipt, "recordHash"> = { ...fields, prevHash };
  const recordHash = computeRecordHash(withPrev);
  const sealed: TerminalTransitionReceipt = { ...withPrev, recordHash };
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.appendFileSync(terminalReceiptsPath(paths), JSON.stringify(sealed) + "\n", "utf8");
  return sealed;
}

/** Write the migration marker directly with an explicit grandfathered baseline. */
function writeMigrationMarker(paths: ProjectPaths, baseline: string[]): void {
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.writeFileSync(
    migrationMarkerPath(paths),
    JSON.stringify({ migratedAt: new Date().toISOString(), baseline }),
    "utf8",
  );
}

// ===========================================================================
// (a) STALE / forged snapshot_coord → gate BLOCKS with terminal_receipt_unverified
//     status "stale".
// ===========================================================================
describe("control (a) — a forged/stale snapshot_coord blocks (status=stale)", () => {
  it("a drift-resolve receipt whose snapshot.gitHead diverges from HEAD → terminal_receipt_unverified / stale", () => {
    const paths = greenAtFinalVerification();

    // The target the receipt grounds in must resolve in source (so we are NOT
    // target_missing/target_mismatch — we isolate the snapshot dimension).
    writeFile(paths, "src/x.ts", "export const x = 1;\n");

    // A real git repo so `currentSnapshotCoord(root).gitHead` is a non-null 40-hex.
    const head = makeGitRepoWithCommit(paths);

    // A resolved requirement-layer DRIFT-001 the gate's rung-1b iteration will reach.
    const id = seedResolvedDriftWithoutReceipt(paths);

    // The migration marker is present (post-upgrade) and grandfathers DRIFT-001, so the
    // ABSENT branch would classify `legacy` (NOT block) — proving the block below is
    // purely the snapshot staleness, not an absent-receipt artefact.
    writeMigrationMarker(paths, [`drift-resolve:${id}`]);

    // FORGE a shape-valid drift-resolve receipt for DRIFT-001: target resolves to the
    // CURRENT digest of src/x.ts (so currentDigest === recordedDigest — NOT mismatch),
    // but snapshot.gitHead is a DIFFERENT 40-hex than HEAD (treeDigest null → only the
    // gitHead dimension can diverge). This is exactly the "forged/stale snapshot" bypass.
    const digest = computeTargetDigest(paths.root, "src/x.ts");
    expect(digest).not.toBeNull();
    const forgedHead = head === "f".repeat(40) ? "e".repeat(40) : "f".repeat(40);
    appendForgedReceipt(paths, {
      kind: "drift-resolve",
      refId: id,
      target_resolves_in_source: { path: "src/x.ts", digest: digest! },
      snapshot_coord: { gitHead: forgedHead, treeDigest: null },
      producer_identity: "forged",
    });

    // The validator isolates the snapshot dimension as `stale`...
    const v = readReceiptValidated(paths, "drift-resolve", id);
    expect(v.status).toBe("stale");
    expect(v.staleReasons).toContain("gitHead");

    // ...and the gate BLOCKS with the stable token + detail.status === "stale".
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("terminal_receipt_unverified");
    expect(res.detail!.kind).toBe("drift-resolve");
    expect(res.detail!.refId).toBe(id);
    expect(res.detail!.status).toBe("stale");
    expect(res.detail!.staleReasons).toContain("gitHead");
  });
});

// ===========================================================================
// (b) ABSENT receipt via a post-upgrade bypass, marker present → status "absent"
//     → BLOCK; contrast: WITHOUT the marker the same absence is `legacy` (no block).
// ===========================================================================
describe("control (b) — a post-upgrade absent receipt blocks (status=absent); pre-upgrade stays legacy", () => {
  it("marker present + DRIFT-001 NOT in baseline → terminal_receipt_unverified / absent", () => {
    const paths = greenAtFinalVerification();
    const id = seedResolvedDriftWithoutReceipt(paths);

    // The migration marker is present but its baseline does NOT grandfather DRIFT-001
    // (and no receipt exists for it) — the post-upgrade `--emergency` / raw `state set`
    // bypass. `collectTerminalEntities` sees DRIFT-001 terminal; `readReceiptValidated`
    // classifies it `absent` (migrated + not grandfathered + no receipt).
    writeMigrationMarker(paths, []); // empty baseline grandfathers nothing
    expect(receiptMigrationDone(paths)).toBe(true);
    expect(collectTerminalEntities(paths)).toContainEqual({ kind: "drift-resolve", refId: id });
    expect(readReceiptValidated(paths, "drift-resolve", id).status).toBe("absent");

    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("terminal_receipt_unverified");
    expect(res.detail!.refId).toBe(id);
    expect(res.detail!.status).toBe("absent");
  });

  it("CONTRAST: the SAME absent receipt WITHOUT a marker classifies legacy and does NOT block", () => {
    const paths = greenAtFinalVerification();
    const id = seedResolvedDriftWithoutReceipt(paths);

    // No migration marker → genuinely pre-upgrade. The absent receipt is grandfathered
    // implicitly (`legacy`), so an existing complete project stays GREEN — this is the
    // migration story that closes (b) without reddening pre-upgrade runs.
    expect(receiptMigrationDone(paths)).toBe(false);
    expect(readReceiptValidated(paths, "drift-resolve", id).status).toBe("legacy");
    expect(checkProductionReality(paths, state(paths))).toEqual({ ok: true });
  });
});

// ===========================================================================
// (c) TARGET does not resolve — (c1) producer REFUSES at creation;
//     (c2) gate reports target_missing after the ground is deleted.
// ===========================================================================
describe("control (c) — a non-resolving target is refused at creation and caught at the gate", () => {
  it("c1 — runDriftResolve with a non-resolving target → receipt_target_unresolved; the flip is NOT applied", () => {
    tp = makeTempProject();
    const paths = tp.paths;
    writeState(paths, { ...initialState(), tier: "T1", current_stage: "implementation" });

    // A real requirement-layer (BLOCKING) drift to resolve.
    const add = runDriftAdd(paths, { layer: "requirement", ref: "SLICE-0 / TASK-1", discovery: "d", action: "a" });
    expect(add.ok).toBe(true);
    const id = add.data!.id as string;
    expect(state(paths).drift_open_blocking).toBe(1);

    // Resolve with a target that does NOT resolve in source — the producer refuses to
    // mint a receipt whose ground is already missing, and the flip is NOT applied.
    const res = runDriftResolve(paths, id, { target: "does/not/exist.ts" });
    expect(res.ok).toBe(false);
    expect(res.data!.error).toBe("receipt_target_unresolved");

    // No partial flip: counter unchanged, no resolution note, no receipt minted.
    expect(state(paths).drift_open_blocking).toBe(1);
    const driftText = fs.readFileSync(paths.driftLog, "utf8");
    expect(driftText.includes(`## ${id} — resolved`)).toBe(false);
    expect(fs.existsSync(terminalReceiptsPath(paths))).toBe(false);
  });

  it("c2 — a VALID receipt whose target is later DELETED → terminal_receipt_unverified / target_missing", () => {
    const paths = greenAtFinalVerification();

    // A real grounded resolve: write the target, log a blocking drift, resolve it with
    // that target. This mints a VALID drift-resolve receipt + the resolution note.
    writeFile(paths, "src/y.ts", "export const y = 1;\n");
    const add = runDriftAdd(paths, { layer: "requirement", ref: "SLICE-0 / TASK-1", discovery: "d", action: "a" });
    const id = add.data!.id as string;
    const resolve = runDriftResolve(paths, id, { target: "src/y.ts" });
    expect(resolve.ok).toBe(true);
    expect(readReceiptValidated(paths, "drift-resolve", id).status).toBe("valid");
    // Sanity: green before the ground is removed.
    expect(checkProductionReality(paths, state(paths))).toEqual({ ok: true });

    // DELETE the recorded target — the ground no longer resolves → target_missing.
    fs.rmSync(path.resolve(paths.root, "src/y.ts"), { force: true });
    expect(readReceiptValidated(paths, "drift-resolve", id).status).toBe("target_missing");

    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("terminal_receipt_unverified");
    expect(res.detail!.refId).toBe(id);
    expect(res.detail!.status).toBe("target_missing");
  });
});

// ===========================================================================
// (d) NO DOUBLE-EXONERATION (sim): a receipt-less retire is STILL seen as active by
//     BOTH the rung-1 blocker AND the rung-4 dist-coverage join.
// ===========================================================================
describe("control (d) — a receipt-less retire cannot exonerate itself (both surfaces)", () => {
  it("a user-visible sim forced retired WITHOUT a receipt still blocks (rung 1) and stays in dist coverage (rung 4)", () => {
    const paths = greenAtFinalVerification();

    // A dist hit naming the dependency this sim `replaces` (so the per-dependency join
    // can match it). "provider" appears in `stubProvider()` → covered while the entry
    // is in the coverage set.
    writeFile(paths, "dist/payments.js", "const v = stubProvider(); // placeholder\n");

    // Write the simulation ledger DIRECTLY: a user-visible Stubbed entry whose status is
    // already "retired" — the `--emergency`/attestation bypass that never minted a
    // sim-retire receipt. (A real `runSimRetire` of a blocking entry would REQUIRE a
    // resolving target and mint a receipt; here we model the bypass.)
    fs.writeFileSync(
      simulationLedgerPath(paths),
      JSON.stringify([
        {
          id: "SIM-001",
          classification: "Stubbed",
          status: "retired",
          userVisible: true,
          replaces: "provider",
          introSlice: "",
          retireSlice: "SLICE-3",
          owner: "",
        },
      ]),
      "utf8",
    );

    // Migration marker present, SIM-001 NOT grandfathered → its retirement is NOT
    // receipt-grounded (no valid/legacy sim-retire receipt).
    writeMigrationMarker(paths, []);

    const entries = readSimulationLedger(paths);
    const entry = entries.find((e) => e.id === "SIM-001")!;
    expect(entry.status).toBe("retired");

    // (i) rung 1 — the receipt-aware blocker still treats the retire as ACTIVE.
    expect(simEntryBlocksProductionReality(paths, entry)).toBe(true);
    // Its retirement is not grounded (would be `absent`, not valid/legacy).
    expect(readReceiptValidated(paths, "sim-retire", "SIM-001").status).toBe("absent");

    // (ii) rung 4 — the dependency stays in coverage: the matching dist hit is treated
    // as LEDGERED (covered), i.e. the receipt-less retire did NOT drop its dependency.
    const scan = scanForSimulationHits(paths);
    expect(scan.distHits.length).toBeGreaterThan(0);
    const unledgered = computeUnledgeredDistHitsReceiptAware(paths, entries, scan.distHits);
    const paymentsHit = scan.distHits.find((h) => h.file === "dist/payments.js");
    expect(paymentsHit).toBeDefined();
    // The payments hit is COVERED (not in the unledgered set) because the ungrounded
    // retire is kept in the coverage set — no double-exoneration via rung 4 either.
    expect(unledgered.some((h) => h.file === "dist/payments.js")).toBe(false);

    // And the gate BLOCKS on rung 1 with the simulation_unretired token (the
    // receipt-less retire is the first production-reality blocker reached).
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("simulation_unretired");
    expect((res.detail!.ids as string[])).toContain("SIM-001");
  });

  it("CONTRAST: a GROUNDED retire (real receipt) DOES exonerate — gate passes, dependency leaves coverage", () => {
    const paths = greenAtFinalVerification();
    writeFile(paths, "dist/payments.js", "const v = stubProvider(); // placeholder\n");
    writeFile(paths, "src/real-provider.ts", "export const provider = () => 1;\n");

    // A real user-visible blocking sim, retired THROUGH the producer with a resolving
    // target → a valid sim-retire receipt grounds the retirement.
    const add = runSimAdd(paths, { classification: "Stubbed", userVisible: true, replaces: "provider" });
    expect(add.data!.id).toBe("SIM-001");
    const retire = runSimRetire(paths, "SIM-001", { retireSlice: "SLICE-3", target: "src/real-provider.ts" });
    expect(retire.ok).toBe(true);
    expect(readReceiptValidated(paths, "sim-retire", "SIM-001").status).toBe("valid");

    const entries = readSimulationLedger(paths);
    const entry = entries.find((e) => e.id === "SIM-001")!;
    // The grounded retire no longer blocks, and its dependency LEAVES the coverage set
    // (the dist hit is now unledgered — correctly flagged once the sim is truly retired).
    expect(simEntryBlocksProductionReality(paths, entry)).toBe(false);
    const scan = scanForSimulationHits(paths);
    const unledgered = computeUnledgeredDistHitsReceiptAware(paths, entries, scan.distHits);
    expect(unledgered.some((h) => h.file === "dist/payments.js")).toBe(true);

    // The gate's first blocker is now rung 4 (the now-undeclared dist stub), NOT a
    // double-exonerated simulation — proving the grounded path behaves oppositely.
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("unledgered_simulation_in_dist");
  });
});
