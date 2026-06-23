/**
 * Axis-B slice-5 (BSC-1) — realization-receipt UNIT + INTEGRATION tests (worker-impl scope).
 *
 * These keep `npm run verify` green and exercise the gate API the probe/negative-control
 * suite (Lane 4, worker-tests) drives. Coverage here:
 *   - SCHEMA: shape validation (`isValidRealizationReceipt`) + canonical-hash stability.
 *   - PRODUCER: mint-then-validate-unchanged ⇒ `valid`; refuse-at-creation on an unresolving
 *     referent; mutate the referent ⇒ `target_mismatch`; delete it ⇒ `target_missing`.
 *   - OWNERSHIP RESOLVER: REQ→file→component→done-slice join + component normalization
 *     ("src/commands" vs "commands"); the fail-closed unresolved set (control 11f input).
 *   - GRANDFATHER: idempotent `legacy` stamping; re-run after a half-write double-appends
 *     nothing; a post-baseline owned REQ without a receipt classifies `absent`.
 *   - GATE: at final-verification, a done-slice REQ with NO receipt BLOCKS
 *     (`realization_unverified`); a minted referent clears it; the fail-open name-fidelity
 *     case BLOCKS; the `TH_BSC1_ENFORCE=0` flag turns a block into a non-blocking notice.
 *
 * The independence (valid-grounded / forged external) control-flip and the full six
 * enumerated negative-controls live in the worker-tests probe suite; this file pins the
 * stable gate API they consume.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, mintRequiredApprovals, type TempProject } from "./helpers";
import { writeState, readState } from "../src/core/state-store";
import { initialState, type TwinHarnessState } from "../src/core/state-schema";
import { runArtifactRegister } from "../src/commands/artifact";
import { runTesterRecord } from "../src/commands/tester";
import { checkProductionReality } from "../src/core/gate-preconditions";
import { runRealize } from "../src/commands/realize";
import type { ProjectPaths } from "../src/core/paths";
import { emptyRepoMap, serializeRepoMap, type RepoMap, type FileEntry } from "../src/core/repo-map/schema";
import {
  type RealizationReceipt,
  isValidRealizationReceipt,
  realizationCanonicalText,
  computeRealizationRecordHash,
  appendRealizationReceipt,
  readRealizationReceiptValidated,
  readRealizationReceipts,
  realizationReceiptsPath,
  ownedReqsForDoneSlices,
  unresolvedDoneSliceReqs,
  normalizeComponentToken,
  ensureRealizationMigration,
  ensureRealizationMigrationOpportunistic,
  realizationMigrationDone,
  grandfatheredRealizationBaseline,
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

// ---------------------------------------------------------------------------
// SCHEMA
// ---------------------------------------------------------------------------

describe("BSC-1 realization — schema validation + canonical-hash stability", () => {
  it("accepts a well-shaped in-process receipt and rejects malformed ones", () => {
    const good: RealizationReceipt = {
      kind: "realization",
      req_id: "REQ-001",
      owning_slice: "SLICE-0",
      referent: { path: "src/a.ts", digest: "a".repeat(64) },
      snapshot_coord: { gitHead: null, treeDigest: null },
      producer_identity: "runner",
      producer_kind: "in-process",
      prevHash: "0".repeat(64),
      recordHash: "f".repeat(64),
    };
    expect(isValidRealizationReceipt(good)).toBe(true);
    expect(isValidRealizationReceipt({ ...good, kind: "driver-dimension" })).toBe(false);
    expect(isValidRealizationReceipt({ ...good, req_id: "" })).toBe(false);
    expect(isValidRealizationReceipt({ ...good, referent: { path: "x" } })).toBe(false);
    expect(isValidRealizationReceipt({ ...good, prevHash: "short" })).toBe(false);
    expect(isValidRealizationReceipt({ ...good, signature: "not-base64" })).toBe(false);
  });

  it("canonical text drops recordHash + undefined keys; recordHash is stable + recomputable", () => {
    const base = {
      kind: "realization" as const,
      req_id: "REQ-001",
      owning_slice: "SLICE-0",
      referent: { path: "src/a.ts", digest: "a".repeat(64) },
      snapshot_coord: { gitHead: "abc", treeDigest: "def" },
      producer_identity: "runner",
      prevHash: "0".repeat(64),
    };
    const text = realizationCanonicalText(base);
    expect(text).not.toContain("recordHash");
    // Re-emitting in a different source key order yields the SAME canonical text.
    const reordered = {
      prevHash: base.prevHash,
      producer_identity: base.producer_identity,
      snapshot_coord: base.snapshot_coord,
      referent: base.referent,
      owning_slice: base.owning_slice,
      req_id: base.req_id,
      kind: base.kind,
    };
    expect(realizationCanonicalText(reordered)).toBe(text);
    expect(computeRealizationRecordHash(base)).toBe(computeRealizationRecordHash(reordered));
  });
});

// ---------------------------------------------------------------------------
// PRODUCER + content validation
// ---------------------------------------------------------------------------

describe("BSC-1 realization — mint then validate", () => {
  it("mint-then-validate-unchanged ⇒ valid", () => {
    tp = makeTempProject();
    const paths = tp.paths;
    writeState(paths, { ...initialState(), slices: [] });
    writeFile(paths, "src/a.ts", "export const a = 1;\n");
    const sealed = appendRealizationReceipt(paths, {
      reqId: "REQ-001",
      owningSlice: "SLICE-0",
      artifactPath: "src/a.ts",
      producerIdentity: "runner",
    });
    expect(sealed.producer_kind).toBe("in-process");
    expect(readRealizationReceiptValidated(paths, "REQ-001").status).toBe("valid");
  });

  it("refuses to mint when the referent does not resolve in source", () => {
    tp = makeTempProject();
    const paths = tp.paths;
    writeState(paths, { ...initialState(), slices: [] });
    expect(() =>
      appendRealizationReceipt(paths, {
        reqId: "REQ-001",
        owningSlice: "SLICE-0",
        artifactPath: "src/missing.ts",
        producerIdentity: "runner",
      }),
    ).toThrow(/does not resolve/);
  });

  it("editing the referent ⇒ target_mismatch; deleting it ⇒ target_missing", () => {
    tp = makeTempProject();
    const paths = tp.paths;
    writeState(paths, { ...initialState(), slices: [] });
    writeFile(paths, "src/a.ts", "export const a = 1;\n");
    appendRealizationReceipt(paths, { reqId: "REQ-001", owningSlice: "S", artifactPath: "src/a.ts", producerIdentity: "r" });
    writeFile(paths, "src/a.ts", "export const a = 2; // changed\n");
    expect(readRealizationReceiptValidated(paths, "REQ-001").status).toBe("target_mismatch");
    fs.rmSync(path.resolve(paths.root, "src/a.ts"));
    expect(readRealizationReceiptValidated(paths, "REQ-001").status).toBe("target_missing");
  });
});

// ---------------------------------------------------------------------------
// OWNERSHIP RESOLVER + normalization
// ---------------------------------------------------------------------------

describe("BSC-1 realization — REQ→slice ownership resolver", () => {
  it("normalizes component tokens to the last path segment, lowercased", () => {
    expect(normalizeComponentToken("src/commands")).toBe("commands");
    expect(normalizeComponentToken("Commands/")).toBe("commands");
    expect(normalizeComponentToken("commands")).toBe("commands");
    expect(normalizeComponentToken("  ")).toBe("");
  });

  it("joins REQ→file→component→done-slice via normalization (src/commands vs commands)", () => {
    tp = makeTempProject();
    const paths = tp.paths;
    const st: TwinHarnessState = {
      ...initialState(),
      slices: [
        { id: "SLICE-0", status: "done", components: ["commands"] },
        { id: "SLICE-1", status: "in-progress", components: ["core"] },
      ],
    };
    writeRepoMap(paths, [
      { path: "src/commands/realize.ts", component: "src/commands", req_ids: ["REQ-001"] },
      { path: "src/core/x.ts", component: "src/core", req_ids: ["REQ-002"] },
    ]);
    const map = loadRepoMapForRealization(paths)!;
    const owned = ownedReqsForDoneSlices(map, st);
    expect(owned.map((o) => o.reqId)).toEqual(["REQ-001"]);
    expect(owned[0]!.owningSlices).toEqual(["SLICE-0"]);
  });

  it("fail-closed unresolved set: a done-slice exists and a REQ is carried by an unowned-in-map file", () => {
    tp = makeTempProject();
    const paths = tp.paths;
    const st: TwinHarnessState = {
      ...initialState(),
      slices: [{ id: "SLICE-0", status: "done", components: ["commands"] }],
    };
    writeRepoMap(paths, [
      { path: "src/commands/realize.ts", component: "src/commands", req_ids: ["REQ-001"] },
      { path: "src/orphan.ts", component: null, req_ids: ["REQ-099"] },
    ]);
    const map = loadRepoMapForRealization(paths)!;
    expect(unresolvedDoneSliceReqs(map, st)).toEqual(["REQ-099"]);
  });
});

// ---------------------------------------------------------------------------
// GRANDFATHER — idempotent, resume-safe
// ---------------------------------------------------------------------------

describe("BSC-1 realization — idempotent grandfather", () => {
  it("stamps legacy for already-owned REQs once; re-run double-appends nothing", () => {
    tp = makeTempProject();
    const paths = tp.paths;
    const st: TwinHarnessState = {
      ...initialState(),
      slices: [{ id: "SLICE-0", status: "done", components: ["commands"] }],
    };
    writeRepoMap(paths, [{ path: "src/commands/a.ts", component: "src/commands", req_ids: ["REQ-001"] }]);
    const map = loadRepoMapForRealization(paths)!;

    expect(realizationMigrationDone(paths)).toBe(false);
    ensureRealizationMigration(paths, st, map);
    expect(realizationMigrationDone(paths)).toBe(true);
    expect(grandfatheredRealizationBaseline(paths).has("REQ-001")).toBe(true);
    expect(readRealizationReceiptValidated(paths, "REQ-001").status).toBe("legacy");

    const linesAfterFirst = readRealizationReceipts(paths).length;
    ensureRealizationMigration(paths, st, map); // re-run: no-op (marker present)
    expect(readRealizationReceipts(paths).length).toBe(linesAfterFirst);
  });

  it("a post-baseline owned REQ without a receipt classifies absent (not legacy)", () => {
    tp = makeTempProject();
    const paths = tp.paths;
    const st: TwinHarnessState = {
      ...initialState(),
      slices: [{ id: "SLICE-0", status: "done", components: ["commands"] }],
    };
    writeRepoMap(paths, [{ path: "src/commands/a.ts", component: "src/commands", req_ids: ["REQ-001"] }]);
    const map = loadRepoMapForRealization(paths)!;
    ensureRealizationMigration(paths, st, map); // REQ-001 grandfathered
    // A REQ that appears AFTER the baseline is NOT grandfathered ⇒ absent ⇒ BLOCK.
    expect(readRealizationReceiptValidated(paths, "REQ-002").status).toBe("absent");
  });
});

// ---------------------------------------------------------------------------
// GATE integration (at final-verification)
// ---------------------------------------------------------------------------

/**
 * A project GREEN at final-verification on every rung EXCEPT the realization rung, with a
 * repo-map binding REQ-001 to a `done` slice's component. The realization migration is NOT
 * run, so REQ-001 is post-regime and the rung is the only lever.
 */
function greenExceptRealization(opts: { stampMarker?: boolean } = {}): ProjectPaths {
  const stampMarker = opts.stampMarker ?? true;
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
  // Bind REQ-001 to SLICE-0's "commands" component AFTER the migration window (no marker),
  // so REQ-001 is an enforceable post-regime owned REQ.
  writeRepoMap(paths, [{ path: "src/commands/a.ts", component: "src/commands", req_ids: ["REQ-001"] }]);
  // Stamp the migration marker with an EMPTY baseline (state had no done slice when first
  // stamped) so REQ-001 is NOT grandfathered — the realization obligation is live. When
  // stampMarker is false the fixture simulates the FAIL-OPEN path: a done slice reached via a
  // non-slice-set-status route (emergency state set / import) with NO marker yet.
  if (stampMarker) {
    fs.writeFileSync(
      path.join(paths.stateDir, ".realization-receipts-migration"),
      JSON.stringify({ migratedAt: new Date().toISOString(), baseline: [] }),
      "utf8",
    );
  }
  return paths;
}

describe("BSC-1 realization — gate rung at final-verification", () => {
  it("a done-slice REQ with NO realization receipt BLOCKS (realization_unverified)", () => {
    delete process.env.TH_BSC1_ENFORCE; // defaults ON
    const paths = greenExceptRealization();
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("realization_unverified");
    const failures = res.detail!.failures as Array<{ reqId: string; status: string }>;
    expect(failures.some((f) => f.reqId === "REQ-001" && f.status === "absent")).toBe(true);
  });

  it("minting a fresh referent for the owned REQ clears the rung", () => {
    delete process.env.TH_BSC1_ENFORCE;
    const paths = greenExceptRealization();
    expect(runRealize(paths, { reqId: "REQ-001", artifact: "src/commands/a.ts" }).ok).toBe(true);
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(true);
  });

  it("the fail-closed name-fidelity case BLOCKS (control 11f input)", () => {
    delete process.env.TH_BSC1_ENFORCE;
    const paths = greenExceptRealization();
    // Re-bind REQ-001 to a file with a NULL component (unowned-in-map) — the join can no
    // longer place it under SLICE-0, so it is reported unresolved (never silently dropped).
    writeRepoMap(paths, [{ path: "src/commands/a.ts", component: null, req_ids: ["REQ-001"] }]);
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("realization_unverified");
    const failures = res.detail!.failures as Array<{ reqId: string; status: string }>;
    expect(failures.some((f) => f.reqId === "REQ-001" && f.status === "unresolved")).toBe(true);
  });

  it("TH_BSC1_ENFORCE=0 turns a would-be block into a non-blocking notice", () => {
    process.env.TH_BSC1_ENFORCE = "0";
    const paths = greenExceptRealization();
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(true);
    expect(res.notice?.token).toBe("realization_unverified");
  });

  it("a project with NO repo-map does not block on realization (freshness owned elsewhere)", () => {
    delete process.env.TH_BSC1_ENFORCE;
    const paths = greenExceptRealization();
    fs.rmSync(path.join(paths.stateDir, "repo-map.json"));
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FAIL-OPEN CLOSURE (team-fix #8) — the gate stamps the grandfather baseline the
// first time it observes a done slice, no matter how the slice became done.
// ---------------------------------------------------------------------------

describe("BSC-1 realization — opportunistic migration closes the marker fail-open window", () => {
  it("a done slice reached WITHOUT slice set-status (no marker) makes the gate STAMP the baseline (regime now active)", () => {
    delete process.env.TH_BSC1_ENFORCE; // defaults ON
    // No marker stamped: simulates a done slice arriving via `--emergency state set` / import.
    const paths = greenExceptRealization({ stampMarker: false });
    expect(realizationMigrationDone(paths)).toBe(false); // the fail-open precondition

    // The first gate observation stamps the marker (grandfathering the pre-existing owned REQ
    // REQ-001 as legacy — work that predates the regime is not retroactively blocked). The KEY
    // closure: the marker is now durably present, so the regime is ACTIVE for everything after.
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(true); // REQ-001 grandfathered (correct — pre-regime work)
    expect(realizationMigrationDone(paths)).toBe(true); // marker stamped opportunistically
    expect(grandfatheredRealizationBaseline(paths).has("REQ-001")).toBe(true);
  });

  it("AFTER the opportunistic stamp, a NEW owned REQ BLOCKS (pre-fix it would grandfather forever)", () => {
    delete process.env.TH_BSC1_ENFORCE;
    const paths = greenExceptRealization({ stampMarker: false });
    // First gate observation stamps the baseline {REQ-001}.
    expect(checkProductionReality(paths, state(paths)).ok).toBe(true);
    // Now a NEW REQ-002 becomes owned by the done slice (added after the baseline). Pre-fix,
    // the marker NEVER existed (the emergency path never stamps), so REQ-002 would classify
    // `legacy` and the gate would silently pass forever. With the window closed, REQ-002 is
    // post-baseline ⇒ absent ⇒ BLOCK.
    writeRepoMap(paths, [
      { path: "src/commands/a.ts", component: "src/commands", req_ids: ["REQ-001", "REQ-002"] },
    ]);
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("realization_unverified");
    const failures = res.detail!.failures as Array<{ reqId: string; status: string }>;
    expect(failures.some((f) => f.reqId === "REQ-002" && f.status === "absent")).toBe(true);
    // REQ-001 stays grandfathered (legacy) — not double-counted as a failure.
    expect(failures.some((f) => f.reqId === "REQ-001")).toBe(false);
  });

  it("the opportunistic stamp is a no-op when no done slice exists (obligation not yet live)", () => {
    tp = makeTempProject();
    const paths = tp.paths;
    writeState(paths, {
      ...initialState(),
      slices: [{ id: "SLICE-0", status: "in-progress", components: ["commands"] }],
    });
    ensureRealizationMigrationOpportunistic(paths);
    // No done slice → no premature stamp (the baseline is not frozen before the regime matters).
    expect(realizationMigrationDone(paths)).toBe(false);
  });

  it("the opportunistic stamp re-check under lock is idempotent (a second call double-appends nothing)", () => {
    delete process.env.TH_BSC1_ENFORCE;
    const paths = greenExceptRealization({ stampMarker: false });
    ensureRealizationMigrationOpportunistic(paths);
    const after = readRealizationReceipts(paths).length;
    ensureRealizationMigrationOpportunistic(paths); // fast-path: marker present, no lock, no write
    expect(readRealizationReceipts(paths).length).toBe(after);
  });
});
