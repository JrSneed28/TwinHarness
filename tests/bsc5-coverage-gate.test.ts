/**
 * Axis-B slice-7 (BSC-5) — the dimension-SET-coverage gate rung, end-to-end through
 * `checkProductionReality` at final-verification (consensus plan §5/§6). This is the
 * integration surface: a project whose ENTIRE final-verification ladder is GREEN except the
 * BSC-5 coverage rung, then we perturb exactly one coverage condition and assert the stable
 * token / coverage posture.
 *
 * GROUND (`declared ⊆ observed`), recomputed PURELY from live inputs:
 *   - DECLARED = the COMMITTED `DECLARED_DIMENSION_SET` constant (`core/declared-dimensions.ts`,
 *     Interp A — narrowing it is a reviewable code + `dist/` diff, never a runtime self-attest).
 *   - OBSERVED = re-derived from `verify-report.json` at gate time (the SAME shared
 *     `observedDimensionsFromReport` the BSC-3 sensor uses).
 *
 * The four enumerated negative-controls (consensus plan §5, BSC-5 a–d), each a 1:1 blocking test:
 *   (a) declared requires `build` but `verify-report.json` omits the matching command ⇒ blocks.
 *   (b) mint a receipt claiming all observed, then STRIP `build` evidence from the report ⇒ the
 *       gate RE-DERIVES observed, finds it uncovered, blocks (the stored verdict is never trusted).
 *   (c) self-attest coverage with NO receipt + a report missing a declared dimension ⇒ the gate
 *       STILL recomputes `declared ⊆ observed` from the live constant, blocks (absence cannot
 *       grandfather an actually-uncovered run).
 *   (d) the committed declared set is NARROWED after a receipt was minted (digest divergence) ⇒
 *       `declared_set_diverged` blocks (the runtime tripwire that complements the reviewable-diff
 *       guard in bsc5-declared-set.guard.test.ts).
 *
 * FLAG TOGGLE (the ship-dark guard): with `TH_BSC5_ENFORCE=0` a would-be block becomes a
 * non-blocking NOTICE (token unchanged, `coverage` summary still attached); flag ON it BLOCKS.
 *
 * The fixture writes a verify-report so the gate's OBSERVED re-derivation reads a real artifact;
 * because the fixture has NO verify CONFIG, the `production_verify_not_green` rung is vacuously
 * green and the BSC-5 rung is the only remaining lever.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, mintRequiredApprovals, mintAssertionPresenceForFixture, ASSERTED_COV_TEST, type TempProject } from "./helpers";
import { writeState, readState } from "../src/core/state-store";
import { initialState, type TwinHarnessState } from "../src/core/state-schema";
import { runArtifactRegister } from "../src/commands/artifact";
import { runTesterRecord } from "../src/commands/tester";
import { checkProductionReality } from "../src/core/gate-preconditions";
import { writeVerifyReport, readVerifyReport, type VerifyReport } from "../src/core/verify";
import { appendCoverageReceipt, coverageReceiptsPath, readCoverageReceipts } from "../src/core/receipts";
import { declaredDimensionSet, declaredDimensionSetDigest } from "../src/core/declared-dimensions";
import { observedDimensionsFromReport } from "../src/core/verification-driver";
import type { ProjectPaths } from "../src/core/paths";

const SAVED_BSC5_ENFORCE = process.env.TH_BSC5_ENFORCE;
let tp: TempProject | undefined;

afterEach(() => {
  if (SAVED_BSC5_ENFORCE === undefined) delete process.env.TH_BSC5_ENFORCE;
  else process.env.TH_BSC5_ENFORCE = SAVED_BSC5_ENFORCE;
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

/** A verify report observing all three seed (and all declared) dimensions. */
function reportObservingAll(): VerifyReport {
  return {
    ok: true,
    ranAt: new Date().toISOString(),
    results: [
      { command: "vitest run", exitCode: 0, ok: true, durationMs: 1, outputTail: "" },
      { command: "tsc --noEmit", exitCode: 0, ok: true, durationMs: 1, outputTail: "" },
      { command: "npm run build", exitCode: 0, ok: true, durationMs: 1, outputTail: "" },
    ],
  };
}

/** A verify report that OMITS the `build` dimension's command (build never observed). */
function reportMissingBuild(): VerifyReport {
  return {
    ok: true,
    ranAt: new Date().toISOString(),
    results: [
      { command: "vitest run", exitCode: 0, ok: true, durationMs: 1, outputTail: "" },
      { command: "tsc --noEmit", exitCode: 0, ok: true, durationMs: 1, outputTail: "" },
    ],
  };
}

/**
 * A project whose entire final-verification ladder is GREEN except the BSC-5 rung: slices
 * settled, no verify CONFIG (vacuously green), coverage clean, report registered, Tester record
 * attached, required approvals minted, no dist/ — PLUS a verify-report.json so the gate's OBSERVED
 * re-derivation has a real artifact. The caller then perturbs exactly one coverage condition.
 *
 * Default report observes ALL declared dimensions, so the BSC-5 rung is GREEN until perturbed.
 */
function greenAtFinalVerification(report: VerifyReport = reportObservingAll()): ProjectPaths {
  tp = makeTempProject();
  const paths = tp.paths;
  writeFile(paths, "docs/01-requirements.md", "# Requirements\n\n- REQ-001 the only requirement.\n");
  writeFile(paths, "docs/09-implementation-plan.md", "# Plan\n\nSLICE-0 covers REQ-001.\n");
  writeFile(paths, "tests/cov.test.ts", ASSERTED_COV_TEST);
  writeFile(paths, "docs/10-verification-report.md", "# Verification Report\n\nREQ-001 verified.\n");
  writeState(paths, {
    ...initialState(),
    tier: "T1",
    current_stage: "final-verification",
    implementation_allowed: true,
    slices: [{ id: "SLICE-0", status: "done", components: [] }],
  });
  expect(runArtifactRegister(paths, "docs/10-verification-report.md", 1).ok).toBe(true);
  expect(runTesterRecord(paths, { driver: "cli-e2e", provider: "sandbox", passed: true }).ok).toBe(true);
  mintRequiredApprovals(paths, state(paths));
  mintAssertionPresenceForFixture(paths);
  writeVerifyReport(paths, report);
  return paths;
}

/** Mint an in-process coverage receipt grounded in the CURRENT report + the live committed set. */
function mintCoverage(paths: ProjectPaths): void {
  const observed = [...observedDimensionsFromReport(readVerifyReport(paths))];
  appendCoverageReceipt(paths, {
    producerIdentity: "runner",
    declaredSetDigest: declaredDimensionSetDigest(),
    declaredSet: declaredDimensionSet(),
    observedSet: observed,
  });
}

/**
 * Mint a coverage receipt that SELF-ATTESTS full coverage (claims all three dimensions observed)
 * regardless of what the report actually observes — the self-attest the gate must recompute around.
 */
function mintSelfAttestedCovered(paths: ProjectPaths): void {
  appendCoverageReceipt(paths, {
    producerIdentity: "runner",
    declaredSetDigest: declaredDimensionSetDigest(),
    declaredSet: declaredDimensionSet(),
    observedSet: ["tests-executed", "typecheck", "build"],
  });
}

// ---------------------------------------------------------------------------
// GREEN baseline + grandfather
// ---------------------------------------------------------------------------

describe("BSC-5 gate — a fully-covered run PASSES", () => {
  it("declared ⊆ observed (all three observed) ⇒ PASS with a coverage summary", () => {
    delete process.env.TH_BSC5_ENFORCE; // defaults ON
    const paths = greenAtFinalVerification();
    mintCoverage(paths);
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(true);
    expect(res.coverage?.status).toBe("covered");
    expect([...(res.coverage?.declared ?? [])].sort()).toEqual(["build", "tests-executed", "typecheck"]);
  });
});

// ---------------------------------------------------------------------------
// NEGATIVE-CONTROL (a) — declared requires a dimension the report omits
// ---------------------------------------------------------------------------

describe("BSC-5 gate — negative-control (a): declared dimension absent from verify-report", () => {
  it("a coverage CLAIM whose report omits the declared `build` command ⇒ dimension_set_uncovered", () => {
    delete process.env.TH_BSC5_ENFORCE;
    const paths = greenAtFinalVerification(reportMissingBuild());
    // A coverage receipt is present (the claim under test); the gate RE-DERIVES declared ⊆ observed
    // from the live constant + live report, finds `build` unobserved, and blocks.
    mintCoverage(paths); // honest mint records only {tests-executed, typecheck} as observed
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("dimension_set_uncovered");
    expect(res.detail!.reason).toBe("uncovered");
    expect(res.detail!.missing).toEqual(["build"]);
  });
});

// ---------------------------------------------------------------------------
// NEGATIVE-CONTROL (b) — mint all-observed, then strip evidence; gate recomputes
// ---------------------------------------------------------------------------

describe("BSC-5 gate — negative-control (b): stored 'all covered' claim cannot survive stripped evidence", () => {
  it("mint a covered receipt, then strip `build` from the report ⇒ gate re-derives, blocks", () => {
    delete process.env.TH_BSC5_ENFORCE;
    const paths = greenAtFinalVerification(); // observes all three
    mintCoverage(paths); // receipt claims covered:true over all three
    expect(readCoverageReceipts(paths)[0]!.covered).toBe(true);
    // Now rewrite the report so `build` is no longer observed — the stored claim is stale.
    writeVerifyReport(paths, reportMissingBuild());
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("dimension_set_uncovered");
    expect(res.detail!.reason).toBe("uncovered");
    expect(res.detail!.missing).toEqual(["build"]);
  });
});

// ---------------------------------------------------------------------------
// NEGATIVE-CONTROL (c) — self-attest with NO grounding (no receipt) cannot bypass
// ---------------------------------------------------------------------------

describe("BSC-5 gate — negative-control (c): a self-attested coverage claim is recomputed, never trusted", () => {
  it("a receipt SELF-ATTESTING all-observed over a report missing `build` ⇒ gate recomputes, blocks", () => {
    delete process.env.TH_BSC5_ENFORCE;
    const paths = greenAtFinalVerification(reportMissingBuild());
    // The receipt claims covered:true over all three — but the report never observed `build`. The
    // gate re-derives observed from the live report (never the receipt's stored set), finds `build`
    // unobserved, and blocks: a self-attested coverage claim cannot route around the re-derivation.
    mintSelfAttestedCovered(paths);
    expect(readCoverageReceipts(paths)[0]!.covered).toBe(true); // the receipt SELF-attests covered
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("dimension_set_uncovered");
    expect(res.detail!.reason).toBe("uncovered");
    expect(res.detail!.missing).toEqual(["build"]);
  });

  it("ABSENCE ≠ FORGERY: NO coverage receipt ⇒ grandfathered PASS (additive — never reds an in-flight run)", () => {
    delete process.env.TH_BSC5_ENFORCE;
    // Even with a report missing a declared dimension, NO coverage claim ⇒ no claim to block. This
    // mirrors the BSC-1/2/3 grandfather posture, so adding the rung does not red existing runs.
    const paths = greenAtFinalVerification(reportMissingBuild());
    expect(readCoverageReceipts(paths)).toHaveLength(0);
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// NEGATIVE-CONTROL (d) — committed declared set narrowed after mint ⇒ digest divergence
// ---------------------------------------------------------------------------

describe("BSC-5 gate — negative-control (d): a narrowed committed set is a digest divergence", () => {
  it("a receipt bound to a DIFFERENT declared-set digest ⇒ declared_set_diverged block", () => {
    delete process.env.TH_BSC5_ENFORCE;
    const paths = greenAtFinalVerification(); // observes all three
    // Mint a receipt whose declared_set_digest is NOT the live committed digest — simulating a
    // receipt minted against a now-changed (e.g. narrowed) committed declared set. The gate
    // recomputes the live digest and detects the divergence; it never trusts the stored digest.
    appendCoverageReceipt(paths, {
      producerIdentity: "runner",
      declaredSetDigest: "0".repeat(64), // a digest that cannot match the live committed set
      declaredSet: ["tests-executed"],
      observedSet: ["tests-executed", "typecheck", "build"],
    });
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("dimension_set_uncovered");
    expect(res.detail!.reason).toBe("declared_set_diverged");
    expect((res.detail!.digests as { live: string }).live).toBe(declaredDimensionSetDigest());
  });
});

// ---------------------------------------------------------------------------
// CHAIN TAMPER — an edited coverage line blocks (no line from a tampered store is trusted)
// ---------------------------------------------------------------------------

describe("BSC-5 gate — a tampered coverage chain blocks (chain)", () => {
  it("an edited persisted coverage line ⇒ dimension_set_uncovered (chain)", () => {
    delete process.env.TH_BSC5_ENFORCE;
    const paths = greenAtFinalVerification();
    mintCoverage(paths);
    const r = readCoverageReceipts(paths)[0]!;
    // Tamper the persisted line so recordHash no longer matches its canonical text.
    fs.writeFileSync(coverageReceiptsPath(paths), JSON.stringify({ ...r, producer_identity: "attacker" }) + "\n", "utf8");
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("dimension_set_uncovered");
    expect(res.detail!.reason).toBe("chain");
  });
});

// ---------------------------------------------------------------------------
// FLAG TOGGLE — ship-dark: a would-be block becomes a non-blocking notice
// ---------------------------------------------------------------------------

describe("BSC-5 gate — TH_BSC5_ENFORCE toggles enforcement (ship-dark guard)", () => {
  it("flag OFF (=0): a would-be uncovered block becomes a non-blocking notice + summary", () => {
    process.env.TH_BSC5_ENFORCE = "0";
    const paths = greenAtFinalVerification(reportMissingBuild());
    mintCoverage(paths); // a present claim, so the rung reaches its verdict
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(true); // does NOT block
    expect(res.notice?.token).toBe("dimension_set_uncovered");
    expect(res.coverage?.status).toBe("uncovered");
  });

  it("flag ON (default): the same uncovered claim BLOCKS", () => {
    delete process.env.TH_BSC5_ENFORCE;
    const paths = greenAtFinalVerification(reportMissingBuild());
    mintCoverage(paths);
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("dimension_set_uncovered");
  });
});
