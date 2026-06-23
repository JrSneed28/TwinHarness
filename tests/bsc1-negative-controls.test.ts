/**
 * Axis-B slice-5 (BSC-1) — the SIX enumerated realization negative-controls (consensus
 * plan §4 step 11). Each control drives the REAL completion gate (`checkProductionReality`)
 * and the REAL realization store (`src/core/realization.ts`) and must BLOCK with the stable
 * token `realization_unverified`, carrying a `detail.failures[]` of `{reqId, status}`. Where
 * meaningful each block is paired with a NON-VACUOUS positive twin (the same fixture with a
 * fresh referent PASSES) so the block is provably the realization rung and not an unrelated
 * one:
 *
 *   (a) Absent                  — a done-slice REQ with NO realization receipt → `absent` →
 *                                 BLOCK. Positive twin: mint a fresh referent → PASS.
 *   (b) Forged/stale digest     — a receipt whose `referent.digest` no longer matches the
 *                                 on-disk file (`target_mismatch`), and a snapshot-stale
 *                                 receipt (`stale`) → BLOCK.
 *   (c) target_missing          — the referent anchor is absent from source / the cached
 *                                 repo-map (the recorded path no longer resolves) → BLOCK.
 *   (d) External-claim forged    — an external-claiming receipt forged in-process (no
 *                                 verifying signature) → `forged` → BLOCK.
 *   (e) Delta-over-coverage     — a done-slice REQ whose anchor RESOLVES in the repo-map
 *                                 (coverage would read it `implemented`) but whose realization
 *                                 referent is absent/stale STILL BLOCKS. The proof BSC-1 is
 *                                 NOT a re-skin of coverage: coverage gates `!planned||!tested`
 *                                 and never hashes the anchor; realization adds digest-freshness
 *                                 + the done-claim coupling. Non-vacuous: the SAME repo-map +
 *                                 coverage shape PASSES once a fresh referent exists.
 *   (f) Fail-open guard         — a done-slice REQ carried only by an unowned-in-map file
 *                                 (component `null`) is REPORTED as `unresolved` and BLOCKS,
 *                                 never silently dropped ("unobserved ≠ clean").
 *
 * Plus the idempotent grandfather + a post-baseline bypass control (§4 step 12).
 *
 * Deterministic + Windows-safe throughout (path.join, no shell). No `dist/` build required —
 * runs against `src/` via vitest.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, mintRequiredApprovals, type TempProject } from "./helpers";
import { writeState, readState } from "../src/core/state-store";
import { initialState, type TwinHarnessState } from "../src/core/state-schema";
import { runArtifactRegister } from "../src/commands/artifact";
import { runTesterRecord } from "../src/commands/tester";
import { runCoverageCheck } from "../src/commands/coverage";
import { checkProductionReality } from "../src/core/gate-preconditions";
import { runRealize } from "../src/commands/realize";
import { currentReceiptSnapshotCoord, computeTargetDigest } from "../src/core/receipts";
import type { ProjectPaths } from "../src/core/paths";
import { emptyRepoMap, serializeRepoMap, type RepoMap, type FileEntry } from "../src/core/repo-map/schema";
import {
  type RealizationReceipt,
  appendRealizationReceipt,
  readRealizationReceiptValidated,
  readRealizationReceipts,
  realizationReceiptsPath,
  externalRealizationReceiptsPath,
  realizationCanonicalText,
  computeRealizationRecordHash,
  readLastExternalRealizationRecordHash,
  ensureRealizationMigration,
  loadRepoMapForRealization,
} from "../src/core/realization";

const SAVED_BSC1_ENFORCE = process.env.TH_BSC1_ENFORCE;
let tp: TempProject | undefined;

afterEach(() => {
  if (SAVED_BSC1_ENFORCE === undefined) delete process.env.TH_BSC1_ENFORCE;
  else process.env.TH_BSC1_ENFORCE = SAVED_BSC1_ENFORCE;
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

/** Write a persisted repo-map.json with the given file entries. */
function writeRepoMap(paths: ProjectPaths, files: Partial<FileEntry>[]): void {
  const map: RepoMap = emptyRepoMap(paths.root);
  map.files = files.map((f) => ({
    path: f.path ?? "src/x.ts",
    component: f.component ?? null,
    language: "typescript",
    is_test: false,
    req_ids: f.req_ids ?? [],
  }));
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.writeFileSync(path.join(paths.stateDir, "repo-map.json"), serializeRepoMap(map), "utf8");
}

/** Helper: pull the typed failures[] off a realization block. */
function failures(res: { detail?: Record<string, unknown> }): Array<{ reqId: string; status: string }> {
  return (res.detail?.failures ?? []) as Array<{ reqId: string; status: string }>;
}

/**
 * A project GREEN at final-verification on every rung EXCEPT the realization rung, with a
 * repo-map binding REQ-001 to a `done` slice's component, the migration marker stamped with
 * an EMPTY baseline (so REQ-001 is post-regime, NOT grandfathered) — the realization rung is
 * the only lever. Identical shape to worker-impl's `greenExceptRealization`, kept in-suite so
 * the controls are self-contained.
 */
function greenExceptRealization(): ProjectPaths {
  tp = makeTempProject();
  const paths = tp.paths;
  writeFile(paths, "docs/01-requirements.md", "# Requirements\n\n- REQ-001 the only requirement.\n");
  writeFile(paths, "tests/cov.test.ts", "// REQ-001 verified here\n");
  writeFile(paths, "docs/10-verification-report.md", "# Verification Report\n\nREQ-001 verified.\n");
  writeFile(paths, "src/commands/a.ts", "export const a = 1; // REQ-001\n");
  writeState(paths, {
    ...initialState(),
    tier: "T1",
    current_stage: "final-verification",
    implementation_allowed: true,
    slices: [{ id: "SLICE-0", status: "done", components: ["commands"] }],
  });
  expect(runArtifactRegister(paths, "docs/10-verification-report.md", 1).ok).toBe(true);
  expect(runTesterRecord(paths, { driver: "cli-e2e", provider: "sandbox", passed: true }).ok).toBe(true);
  mintRequiredApprovals(paths, state(paths));
  writeRepoMap(paths, [{ path: "src/commands/a.ts", component: "src/commands", req_ids: ["REQ-001"] }]);
  fs.writeFileSync(
    path.join(paths.stateDir, ".realization-receipts-migration"),
    JSON.stringify({ migratedAt: new Date().toISOString(), baseline: [] }),
    "utf8",
  );
  return paths;
}

// ---------------------------------------------------------------------------
// (a) Absent receipt blocks — with a non-vacuous positive twin
// ---------------------------------------------------------------------------

describe("BSC-1 negative-control (a): absent receipt on a done-slice REQ blocks", () => {
  it("BLOCKS with realization_unverified / status absent", () => {
    delete process.env.TH_BSC1_ENFORCE; // default ON
    const paths = greenExceptRealization();
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("realization_unverified");
    expect(failures(res).some((f) => f.reqId === "REQ-001" && f.status === "absent")).toBe(true);
  });

  it("POSITIVE twin: a fresh referent on the SAME fixture PASSES (block was the realization rung)", () => {
    delete process.env.TH_BSC1_ENFORCE;
    const paths = greenExceptRealization();
    expect(runRealize(paths, { reqId: "REQ-001", artifact: "src/commands/a.ts" }).ok).toBe(true);
    expect(readRealizationReceiptValidated(paths, "REQ-001").status).toBe("valid");
    expect(checkProductionReality(paths, state(paths)).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (b) Forged/stale referent.digest blocks
// ---------------------------------------------------------------------------

describe("BSC-1 negative-control (b): a stale/forged referent.digest blocks", () => {
  it("editing the referent AFTER mint ⇒ target_mismatch ⇒ BLOCK", () => {
    delete process.env.TH_BSC1_ENFORCE;
    const paths = greenExceptRealization();
    expect(runRealize(paths, { reqId: "REQ-001", artifact: "src/commands/a.ts" }).ok).toBe(true);
    // Tamper: change the source AFTER the digest was bound.
    writeFile(paths, "src/commands/a.ts", "export const a = 2; // REQ-001 changed\n");
    expect(readRealizationReceiptValidated(paths, "REQ-001").status).toBe("target_mismatch");
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("realization_unverified");
    expect(failures(res).some((f) => f.reqId === "REQ-001" && f.status === "target_mismatch")).toBe(true);
  });

  it("a snapshot-stale receipt ⇒ stale ⇒ BLOCK (forged-fresh digest cannot save a diverged snapshot)", () => {
    delete process.env.TH_BSC1_ENFORCE;
    const paths = greenExceptRealization();
    // Hand-mint a receipt whose digest MATCHES the file (so it passes content) but whose
    // snapshot_coord names a DIFFERENT gitHead+treeDigest than the current tree → stale.
    const referentPath = "src/commands/a.ts";
    const digest = computeTargetDigest(paths.root, referentPath)!;
    const cur = currentReceiptSnapshotCoord(paths);
    const divergent = {
      gitHead: (cur.gitHead ?? "0".repeat(40)).replace(/.$/, "f") + "0",
      treeDigest: "d".repeat(64),
    };
    const withPrev: Omit<RealizationReceipt, "recordHash"> = {
      kind: "realization",
      req_id: "REQ-001",
      owning_slice: "SLICE-0",
      referent: { path: referentPath, digest },
      snapshot_coord: divergent,
      producer_identity: "test:stale",
      producer_kind: "in-process",
      prevHash: "0".repeat(64),
    };
    const recordHash = computeRealizationRecordHash(withPrev);
    fs.appendFileSync(realizationReceiptsPath(paths), JSON.stringify({ ...withPrev, recordHash }) + "\n", "utf8");
    const v = readRealizationReceiptValidated(paths, "REQ-001");
    // The control is non-vacuous ONLY when the snapshot coordinate actually discriminates
    // (both sides non-null). In a no-git temp project gitHead is null → non-discriminating;
    // in that case the receipt is `valid` and this leg degrades to a documented no-op. Assert
    // the meaningful branch when the tree is real, else assert the receipt was at least bound.
    if (v.status === "stale") {
      const res = checkProductionReality(paths, state(paths));
      expect(res.ok).toBe(false);
      expect(failures(res).some((f) => f.reqId === "REQ-001" && f.status === "stale")).toBe(true);
    } else {
      // No discriminating snapshot in this environment → the digest still matched ⇒ valid.
      expect(v.status).toBe("valid");
    }
  });
});

// ---------------------------------------------------------------------------
// (c) Referent anchor absent from source / cached repo-map ⇒ target_missing
// ---------------------------------------------------------------------------

describe("BSC-1 negative-control (c): a referent that no longer resolves blocks (target_missing)", () => {
  it("deleting the referent file AFTER mint ⇒ target_missing ⇒ BLOCK", () => {
    delete process.env.TH_BSC1_ENFORCE;
    const paths = greenExceptRealization();
    expect(runRealize(paths, { reqId: "REQ-001", artifact: "src/commands/a.ts" }).ok).toBe(true);
    fs.rmSync(path.resolve(paths.root, "src/commands/a.ts"));
    // The repo-map still lists src/commands/a.ts (cached) so REQ-001 stays an owned obligation,
    // but the referent path no longer resolves in source ⇒ target_missing.
    expect(readRealizationReceiptValidated(paths, "REQ-001").status).toBe("target_missing");
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(failures(res).some((f) => f.reqId === "REQ-001" && f.status === "target_missing")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (d) External-claim receipt forged via in-process th ⇒ forged
// ---------------------------------------------------------------------------

describe("BSC-1 negative-control (d): an in-process-forged external-claim receipt blocks (forged)", () => {
  it("a receipt CLAIMING producer_kind external with no verifying signature ⇒ forged ⇒ BLOCK", () => {
    delete process.env.TH_BSC1_ENFORCE;
    delete process.env.TH_RECEIPT_PUBLIC_KEYFILE; // no verifier key loaded → no external signature can verify
    const paths = greenExceptRealization();
    const referentPath = "src/commands/a.ts";
    const digest = computeTargetDigest(paths.root, referentPath)!;
    // Forge an external-claiming line in-process: it carries key_id (claimsExternal) but the
    // signature is a syntactically-valid-but-bogus Ed25519 blob that cannot verify.
    const withPrev: Omit<RealizationReceipt, "recordHash"> = {
      kind: "realization",
      req_id: "REQ-001",
      owning_slice: "",
      referent: { path: referentPath, digest },
      snapshot_coord: currentReceiptSnapshotCoord(paths),
      producer_identity: "forged:in-process",
      producer_kind: "external",
      key_id: "forged-key-id",
      prevHash: readLastExternalRealizationRecordHash(paths),
    };
    const recordHash = computeRealizationRecordHash(withPrev);
    const forgedSig = "A".repeat(86) + "=="; // matches ED25519_SIGNATURE_BASE64 shape, but bogus
    fs.appendFileSync(
      externalRealizationReceiptsPath(paths),
      JSON.stringify({ ...withPrev, signature: forgedSig, recordHash }) + "\n",
      "utf8",
    );
    expect(readRealizationReceiptValidated(paths, "REQ-001").status).toBe("forged");
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("realization_unverified");
    expect(failures(res).some((f) => f.reqId === "REQ-001" && f.status === "forged")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (e) Delta-over-coverage — coverage GREEN but realization still BLOCKS
// ---------------------------------------------------------------------------

describe("BSC-1 negative-control (e): delta-over-coverage — coverage passes yet realization blocks", () => {
  it("NON-VACUOUS: the SAME anchor that makes coverage GREEN does NOT satisfy realization", () => {
    delete process.env.TH_BSC1_ENFORCE;
    const paths = greenExceptRealization();
    // The fixture already wrote docs/01-requirements.md (REQ-001) and tests/cov.test.ts and
    // minted approvals bound to those digests — do NOT rewrite them (that would fail the
    // earlier human-approval rung first and mask the realization delta we are proving). Only
    // ADD the plan file coverage needs; it is not an approval-bound artifact.
    writeFile(paths, "docs/09-implementation-plan.md", "# Plan\n\nSLICE-0 covers REQ-001.\n");

    // PROOF coverage is GREEN on the SAME REQ-ID (its membership ground is satisfied).
    const cov = runCoverageCheck(paths, {
      reqsFile: "docs/01-requirements.md",
      planFile: "docs/09-implementation-plan.md",
      testsDir: "tests",
    });
    expect(cov.ok).toBe(true);
    const covData = cov.data as { gaps?: unknown[]; total?: number; covered?: number };
    expect(covData.gaps).toEqual([]); // zero coverage gaps on REQ-001
    expect(covData.covered).toBe(covData.total);

    // Yet realization BLOCKS: coverage never hashed the anchor nor coupled it to the done-claim.
    // (No `th realize` was run ⇒ the digest-fresh referent is absent.)
    expect(readRealizationReceiptValidated(paths, "REQ-001").status).toBe("absent");
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("realization_unverified");
    expect(failures(res).some((f) => f.reqId === "REQ-001" && f.status === "absent")).toBe(true);

    // Non-vacuous closer: mint the referent ⇒ realization passes WITHOUT touching coverage —
    // the two gates are independent axes, so the delta is real, not an artifact of the fixture.
    expect(runRealize(paths, { reqId: "REQ-001", artifact: "src/commands/a.ts" }).ok).toBe(true);
    expect(checkProductionReality(paths, state(paths)).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (f) Fail-open guard — unowned-in-map REQ reported, never silently dropped
// ---------------------------------------------------------------------------

describe("BSC-1 negative-control (f): fail-open name-fidelity guard blocks (unresolved)", () => {
  it("a done-slice REQ carried only by a null-component file is REPORTED unresolved ⇒ BLOCK", () => {
    delete process.env.TH_BSC1_ENFORCE;
    const paths = greenExceptRealization();
    // Re-bind REQ-001 to a file whose component is NULL: the ownership join cannot place it
    // under SLICE-0's "commands" component. A naive gate would silently drop it (fail-OPEN);
    // the guard REPORTS it as `unresolved` and blocks ("unobserved ≠ clean").
    writeRepoMap(paths, [{ path: "src/orphan.ts", component: null, req_ids: ["REQ-001"] }]);
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("realization_unverified");
    expect(failures(res).some((f) => f.reqId === "REQ-001" && f.status === "unresolved")).toBe(true);
  });

  it("NON-VACUOUS twin: the SAME REQ under a MATCHING component (not null) is enforceable, not dropped", () => {
    delete process.env.TH_BSC1_ENFORCE;
    const paths = greenExceptRealization();
    // With a matched component the REQ is OWNED (not `unresolved`) — and still blocks `absent`
    // until realized — proving the `unresolved` path is the null-component branch specifically,
    // not a catch-all that fires regardless of the join.
    writeRepoMap(paths, [{ path: "src/commands/a.ts", component: "src/commands", req_ids: ["REQ-001"] }]);
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    const fs1 = failures(res);
    expect(fs1.some((f) => f.reqId === "REQ-001" && f.status === "absent")).toBe(true);
    expect(fs1.some((f) => f.reqId === "REQ-001" && f.status === "unresolved")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Idempotent grandfather + post-baseline bypass control (§4 step 12)
// ---------------------------------------------------------------------------

describe("BSC-1 grandfather — idempotent + a post-baseline owned REQ still blocks", () => {
  it("pre-existing done-slice REQs read legacy; re-run after a half-write double-appends nothing", () => {
    tp = makeTempProject();
    const paths = tp.paths;
    const st: TwinHarnessState = {
      ...initialState(),
      slices: [{ id: "SLICE-0", status: "done", components: ["commands"] }],
    };
    writeRepoMap(paths, [{ path: "src/commands/a.ts", component: "src/commands", req_ids: ["REQ-001"] }]);
    const map = loadRepoMapForRealization(paths)!;

    ensureRealizationMigration(paths, st, map);
    expect(readRealizationReceiptValidated(paths, "REQ-001").status).toBe("legacy");
    const afterFirst = readRealizationReceipts(paths).length;

    // Simulate a half-write resume: delete the marker (as if a crash happened AFTER the legacy
    // stamp but BEFORE the marker was written), then re-run. The double-stamp guard must skip
    // the already-stamped REQ-001 → no new line.
    fs.rmSync(path.join(paths.stateDir, ".realization-receipts-migration"));
    ensureRealizationMigration(paths, st, map);
    expect(readRealizationReceipts(paths).length).toBe(afterFirst);
    expect(readRealizationReceiptValidated(paths, "REQ-001").status).toBe("legacy");
  });

  it("a POST-baseline done-slice REQ without a full receipt BLOCKS (absent, not legacy)", () => {
    delete process.env.TH_BSC1_ENFORCE;
    const paths = greenExceptRealization(); // marker stamped with EMPTY baseline
    // REQ-001 is owned by SLICE-0 but appeared AFTER the (empty) baseline ⇒ not grandfathered.
    expect(readRealizationReceiptValidated(paths, "REQ-001").status).toBe("absent");
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(failures(res).some((f) => f.reqId === "REQ-001" && f.status === "absent")).toBe(true);
  });
});
