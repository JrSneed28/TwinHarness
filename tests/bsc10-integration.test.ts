/**
 * BSC-10 / Axis-B slice-A — integration tests for External-Reference Grounding (Lane C).
 *
 * Covers I1/I1b/I2/I7 per the acceptance spec (§3) and test plan (§4 Integration):
 *
 *   I1   — Slice-A-reachable gate states: not-required inert PASS / grounded PASS /
 *           missing FAIL / over-budget FAIL
 *   I1b  — forced-enforce + conformance unobserved ⇒ FAIL (M3: unobserved = fail, never silent pass)
 *   I2   — gate-split behavioral: grounding blocks / precondition consumed-not-bypassed /
 *           approvals-absent + grounding-satisfied still blocks human_approval_unverified
 *   I7   — shipped-probe regression: additive manifest_digest? on BSC-1/3/7 receipts
 *           (DriverDimensionReceipt) is omit-when-absent (absent/undefined ⇒ byte-identical
 *           canonical text; tamper-evident when present)
 *   determinism — shuffled field-order receipt ⇒ same groundingGroundDigest + computeGroundingRecordHash
 *
 * KEY FIXTURE DESIGN (read from source before authoring):
 *   - workClass is NOT a TwinHarnessState field. evaluateGrounding derives declared work-classes
 *     FRESH from receipt.workClass across all trusted receipts in the store (recompute-don't-trust).
 *     To drive the required-kind set, append a GroundingReceipt with the desired workClass via
 *     appendGroundingReceipt(paths, { workClass, ground, conformance, producerIdentity }).
 *   - The MintGroundingInput.ground is a GroundingGround (discriminated union), NOT inline fields.
 *   - UX force-rule at gate level: state.has_ui !== false → surfaces ["ui"] → forces visual-hash.
 *     Set state.has_ui = false to suppress the force-rule (so integration / migration tests don't
 *     also need visual-hash receipts to PASS).
 *   - GroundingSummary shape (from source gate-preconditions.ts:168-183):
 *       { groundKind, grounded: boolean, trustLabel, conformance: "within-budget"|"over-budget"|"unobserved"|"missing", exceptionCovered: boolean }
 *     NO .verdict field.
 *   - Gate detail reason tokens: "missing" / "over_budget" / "unobserved" (underscores).
 *   - Conformance status tokens: "within-budget" / "over-budget" / "unobserved" / "missing" (hyphens).
 *     These are deliberately distinct.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  makeTempProject,
  mintRequiredApprovals,
  type TempProject,
} from "./helpers";
import { writeState, readState } from "../src/core/state-store";
import { initialState, type TwinHarnessState } from "../src/core/state-schema";
import { runArtifactRegister } from "../src/commands/artifact";
import { runTesterRecord } from "../src/commands/tester";
import { checkProductionReality } from "../src/core/gate-preconditions";
import { writeVerifyReport } from "../src/core/verify";
import {
  appendDriverReceipt,
  computeDriverRecordHash,
  type DriverDimensionReceipt,
} from "../src/core/verification-driver";
import {
  appendGroundingReceipt,
  groundingGroundDigest,
  computeGroundingRecordHash,
} from "../src/core/grounding";
import { GENESIS_PREV_HASH } from "../src/core/hash";
import type { GroundingGround, GroundingReceipt } from "../src/core/grounding";
import type { ProjectPaths } from "../src/core/paths";

// Sibling BSC enforcement flags saved at module load; restored after each test.
// Mirror of the pattern in tests/bsc2-assertion-gate.test.ts:59-70.
// BSC-1/2/3 enforcement rungs run BEFORE the grounding rung (rung 9), so leaving them
// ON (default) causes those rungs to block first, shadowing the grounding token.
const SAVED_BSC10 = process.env.TH_BSC10_ENFORCE;
const SAVED_BSC1 = process.env.TH_BSC1_ENFORCE;
const SAVED_BSC2 = process.env.TH_BSC2_ENFORCE;
const SAVED_BSC3 = process.env.TH_BSC3_ENFORCE;
let tp: TempProject | undefined;

beforeEach(() => {
  // Neutralize sibling rungs so the grounding rung (rung 9) is reachable.
  process.env.TH_BSC1_ENFORCE = "0";
  process.env.TH_BSC2_ENFORCE = "0";
  process.env.TH_BSC3_ENFORCE = "0";
});

afterEach(() => {
  if (SAVED_BSC10 === undefined) delete process.env.TH_BSC10_ENFORCE;
  else process.env.TH_BSC10_ENFORCE = SAVED_BSC10;
  if (SAVED_BSC1 === undefined) delete process.env.TH_BSC1_ENFORCE;
  else process.env.TH_BSC1_ENFORCE = SAVED_BSC1;
  if (SAVED_BSC2 === undefined) delete process.env.TH_BSC2_ENFORCE;
  else process.env.TH_BSC2_ENFORCE = SAVED_BSC2;
  if (SAVED_BSC3 === undefined) delete process.env.TH_BSC3_ENFORCE;
  else process.env.TH_BSC3_ENFORCE = SAVED_BSC3;
  tp?.cleanup();
  tp = undefined;
});

function state(paths: ProjectPaths): TwinHarnessState {
  return readState(paths).state!;
}

function writeFile(paths: ProjectPaths, rel: string, body: string): void {
  const abs = path.resolve(paths.root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, "utf8");
}

/**
 * A fully-green final-verification project. has_ui is set to FALSE to suppress the
 * UX-surface force-rule (otherwise all non-visual work classes also need a visual-hash
 * receipt). The BSC-10 grounding rung is the only lever.
 */
function greenProject(): ProjectPaths {
  tp = makeTempProject();
  const paths = tp.paths;
  writeFile(paths, "docs/01-requirements.md", "# Requirements\n\n- REQ-001 the only requirement.\n");
  writeFile(paths, "docs/09-implementation-plan.md", "# Plan\n\nSLICE-0 covers REQ-001.\n");
  writeFile(paths, "tests/cov.test.ts", "// REQ-001 verified here\ntest('r', () => expect(1).toBe(1));\n");
  writeFile(paths, "docs/10-verification-report.md", "# Verification Report\n\nREQ-001 verified.\n");
  writeState(paths, {
    ...initialState(),
    tier: "T1",
    current_stage: "final-verification",
    implementation_allowed: true,
    has_ui: false, // suppress UX force-rule so integration/migration don't require visual-hash
    slices: [{ id: "SLICE-0", status: "done", components: [] }],
  });
  runArtifactRegister(paths, "docs/10-verification-report.md", 1);
  runTesterRecord(paths, { driver: "cli-e2e", provider: "sandbox", passed: true });
  mintRequiredApprovals(paths, state(paths));
  writeVerifyReport(paths, {
    ok: true,
    ranAt: new Date().toISOString(),
    results: [
      { command: "vitest run", exitCode: 0, ok: true, durationMs: 1, outputTail: "" },
      { command: "tsc --noEmit", exitCode: 0, ok: true, durationMs: 1, outputTail: "" },
      { command: "npm run build", exitCode: 0, ok: true, durationMs: 1, outputTail: "" },
    ],
  });
  appendDriverReceipt(paths, { producerIdentity: "test:runner" });
  return paths;
}

// ---------------------------------------------------------------------------
// I1 — Slice-A-reachable gate states
// The work-class is driven by the workClass field on the appended GroundingReceipt,
// NOT by any state field. No receipt → no declared class → inert PASS (not-required path).
// ---------------------------------------------------------------------------

describe("I1 — Slice-A gate states (not-required / grounded PASS / missing FAIL / over-budget FAIL)", () => {
  it("I1a: no receipt (no declared work-class) ⇒ ok:true, no grounding_unverified token", () => {
    process.env.TH_BSC10_ENFORCE = "1";
    const paths = greenProject();
    // No grounding receipts → evaluateGrounding returns null (no declared class) → inert PASS
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(true);
    expect(res.error).not.toBe("grounding_unverified");
  });

  it("I1b: required + grounded + within-budget (integration: digest-manifest + version-pin) ⇒ ok:true", () => {
    process.env.TH_BSC10_ENFORCE = "1";
    const paths = greenProject();
    // Append receipts declaring workClass "integration" (requires digest-manifest + version-pin).
    // Both provided within-budget → gate PASSES.
    appendGroundingReceipt(paths, {
      workClass: "integration",
      ground: {
        groundKind: "digest-manifest",
        manifestDigest: "sha256:aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
      },
      conformance: [{ metric: "api", observed: 0, status: "within-budget" }],
      producerIdentity: "test:runner",
    });
    appendGroundingReceipt(paths, {
      workClass: "integration",
      ground: {
        groundKind: "version-pin",
        pkg: "some-dep",
        version: "2.1.0",
      },
      conformance: [{ metric: "version", observed: "2.1.0", status: "within-budget" }],
      producerIdentity: "test:runner",
    });
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(true);
    expect(res.error).toBeUndefined();
  });

  it("I1c: required + MISSING (integration receipt with digest-manifest only, version-pin absent) ⇒ ok:false, error:'grounding_unverified', reason:'missing'", () => {
    process.env.TH_BSC10_ENFORCE = "1";
    const paths = greenProject();
    // Declare workClass "integration" but only append digest-manifest (version-pin missing)
    appendGroundingReceipt(paths, {
      workClass: "integration",
      ground: {
        groundKind: "digest-manifest",
        manifestDigest: "sha256:aabb",
      },
      conformance: [{ metric: "api", observed: 0, status: "within-budget" }],
      producerIdentity: "test:runner",
    });
    // version-pin not appended → missing required kind
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("grounding_unverified");
    expect((res.detail as { reason?: string } | undefined)?.reason).toBe("missing");
  });

  it("I1d: required + over-budget (without signed exception) ⇒ ok:false, error:'grounding_unverified', reason:'over_budget'", () => {
    process.env.TH_BSC10_ENFORCE = "1";
    const paths = greenProject();
    appendGroundingReceipt(paths, {
      workClass: "integration",
      ground: {
        groundKind: "digest-manifest",
        manifestDigest: "sha256:aabb",
      },
      conformance: [{ metric: "api", observed: 500, status: "over-budget" }],
      producerIdentity: "test:runner",
    });
    appendGroundingReceipt(paths, {
      workClass: "integration",
      ground: { groundKind: "version-pin", pkg: "some-dep", version: "2.1.0" },
      conformance: [{ metric: "version", observed: "2.1.0", status: "within-budget" }],
      producerIdentity: "test:runner",
    });
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("grounding_unverified");
    expect((res.detail as { reason?: string } | undefined)?.reason).toBe("over_budget");
  });
});

// ---------------------------------------------------------------------------
// I1b — unobserved-under-enforce (M3): unobserved = fail, never silent pass
// ---------------------------------------------------------------------------

describe("I1b — forced-enforce + conformance unobserved ⇒ FAIL (M3)", () => {
  it("required kind + TH_BSC10_ENFORCE=1 + receipt conformance:unobserved ⇒ ok:false, reason:'unobserved'", () => {
    process.env.TH_BSC10_ENFORCE = "1";
    const paths = greenProject();
    // Receipts present but all conformance metrics are unobserved (visual-hash stub in Slice A)
    appendGroundingReceipt(paths, {
      workClass: "integration",
      ground: {
        groundKind: "digest-manifest",
        manifestDigest: "sha256:aabb",
      },
      conformance: [{ metric: "api", observed: "unobserved", status: "unobserved" }],
      producerIdentity: "test:runner",
    });
    appendGroundingReceipt(paths, {
      workClass: "integration",
      ground: { groundKind: "version-pin", pkg: "some-dep", version: "2.1.0" },
      conformance: [{ metric: "version", observed: "unobserved", status: "unobserved" }],
      producerIdentity: "test:runner",
    });
    const res = checkProductionReality(paths, state(paths));
    // unobserved = FAIL under enforce — never a silent pass (M3)
    expect(res.ok).toBe(false);
    expect(res.error).toBe("grounding_unverified");
    expect((res.detail as { reason?: string } | undefined)?.reason).toBe("unobserved");
  });
});

// ---------------------------------------------------------------------------
// I2 — gate-split behavioral (C1/PCC-1)
// Three legs: (a) grounding blocks / (b) precondition consumed-not-bypassed /
// (c) approvals-absent + grounding-satisfied still blocks human_approval_unverified
// ---------------------------------------------------------------------------

describe("I2 — gate-split behavioral (grounding / precondition consumed / independence)", () => {
  it("I2a (grounding blocks): all approvals present + required kind MISSING ⇒ blocks grounding_unverified", () => {
    process.env.TH_BSC10_ENFORCE = "1";
    const paths = greenProject();
    // Declare workClass "integration" but only provide digest-manifest (version-pin missing)
    appendGroundingReceipt(paths, {
      workClass: "integration",
      ground: { groundKind: "digest-manifest", manifestDigest: "sha256:aabb" },
      conformance: [{ metric: "api", observed: 0, status: "within-budget" }],
      producerIdentity: "test:runner",
    });
    // version-pin absent → missing required kind
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("grounding_unverified");
  });

  it("I2b (precondition consumed-not-bypassed): over-budget ground blocks even with all approvals present", () => {
    process.env.TH_BSC10_ENFORCE = "1";
    const paths = greenProject();
    // Ground present but over-budget — must block the approval acceptance leg (PCC-1)
    appendGroundingReceipt(paths, {
      workClass: "integration",
      ground: { groundKind: "digest-manifest", manifestDigest: "sha256:aabb" },
      conformance: [{ metric: "api", observed: 999, status: "over-budget" }],
      producerIdentity: "test:runner",
    });
    appendGroundingReceipt(paths, {
      workClass: "integration",
      ground: { groundKind: "version-pin", pkg: "dep", version: "1.0.0" },
      conformance: [{ metric: "version", observed: "1.0.0", status: "within-budget" }],
      producerIdentity: "test:runner",
    });
    const res = checkProductionReality(paths, state(paths));
    // Conformance precondition consumed inside the approval-acceptance split (PCC-1) — blocks
    expect(res.ok).toBe(false);
    expect(res.error).toBe("grounding_unverified");
  });

  it("I2c (independence): grounding SATISFIED + approvals ABSENT still blocks human_approval_unverified", () => {
    process.env.TH_BSC10_ENFORCE = "1";
    // Build a project WITHOUT minting approvals (independence leg)
    const _tp = makeTempProject();
    tp = _tp; // register for cleanup
    const paths = _tp.paths;
    writeFile(paths, "docs/01-requirements.md", "# Requirements\n\n- REQ-001 the only requirement.\n");
    writeFile(paths, "docs/09-implementation-plan.md", "# Plan\n\nSLICE-0 covers REQ-001.\n");
    writeFile(paths, "tests/cov.test.ts", "// REQ-001 verified here\ntest('r', () => expect(1).toBe(1));\n");
    writeFile(paths, "docs/10-verification-report.md", "# Verification Report\n\nREQ-001 verified.\n");
    writeState(paths, {
      ...initialState(),
      tier: "T1",
      current_stage: "final-verification",
      implementation_allowed: true,
      has_ui: false,
      slices: [{ id: "SLICE-0", status: "done", components: [] }],
    });
    runArtifactRegister(paths, "docs/10-verification-report.md", 1);
    runTesterRecord(paths, { driver: "cli-e2e", provider: "sandbox", passed: true });
    // Deliberately NO mintRequiredApprovals — approvals absent
    writeVerifyReport(paths, {
      ok: true,
      ranAt: new Date().toISOString(),
      results: [
        { command: "vitest run", exitCode: 0, ok: true, durationMs: 1, outputTail: "" },
        { command: "tsc --noEmit", exitCode: 0, ok: true, durationMs: 1, outputTail: "" },
        { command: "npm run build", exitCode: 0, ok: true, durationMs: 1, outputTail: "" },
      ],
    });
    appendDriverReceipt(paths, { producerIdentity: "test:runner" });

    // Grounding SATISFIED — both required kinds provided within-budget
    appendGroundingReceipt(paths, {
      workClass: "integration",
      ground: {
        groundKind: "digest-manifest",
        manifestDigest: "sha256:aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
      },
      conformance: [{ metric: "api", observed: 0, status: "within-budget" }],
      producerIdentity: "test:runner",
    });
    appendGroundingReceipt(paths, {
      workClass: "integration",
      ground: { groundKind: "version-pin", pkg: "dep", version: "1.0.0" },
      conformance: [{ metric: "version", observed: "1.0.0", status: "within-budget" }],
      producerIdentity: "test:runner",
    });

    const res = checkProductionReality(paths, state(paths));
    // Grounding satisfied but approvals absent → must still block on approval token
    // (the approval-existence leg runs before grounding verdict is consumed — they are independent)
    expect(res.ok).toBe(false);
    expect(res.error).toBe("human_approval_unverified");
  });
});

// ---------------------------------------------------------------------------
// I7 — additive manifest_digest? on BSC-1/3/7 receipts (DriverDimensionReceipt) is omit-when-absent
//
// The manifest_digest field lives on DriverDimensionReceipt (receipts.ts) — NOT on GroundingReceipt.
// GroundingReceipt carries its digest inside ground.manifestDigest for the digest-manifest kind.
// This test targets the correct receipt type and its hasher (computeDriverRecordHash).
//
// Invariant: absent/undefined manifest_digest ⇒ byte-identical canonical text ⇒ same recordHash
// (so shipped BSC-3 probes and pre-BSC-10 receipts stay byte-stable after the field is added to
// the canonical field order). When the field IS present it must change the hash (tamper-evident).
// ---------------------------------------------------------------------------

/** Minimal valid DriverDimensionReceipt without recordHash or manifest_digest. */
function makeDriverBase(): Omit<DriverDimensionReceipt, "recordHash"> {
  return {
    kind: "driver",
    refId: "no-git",
    dimensions: [
      { name: "tests-executed", observed: true, evidenceRef: "verify-report.json" },
      { name: "typecheck", observed: true, evidenceRef: "verify-report.json" },
      { name: "build", observed: true, evidenceRef: "verify-report.json" },
    ],
    snapshot_coord: { gitHead: null, treeDigest: null },
    producer_identity: "test:runner",
    prevHash: GENESIS_PREV_HASH,
  };
}

describe("I7 — additive manifest_digest? on BSC-1/3/7 receipts (DriverDimensionReceipt) is omit-when-absent", () => {
  it("absent manifest_digest ≡ manifest_digest:undefined → same computeDriverRecordHash (byte-stable)", () => {
    const withoutField = makeDriverBase();
    const withFieldUndefined = { ...makeDriverBase(), manifest_digest: undefined };
    // omit-when-absent: the canonical text serializer must skip undefined fields
    expect(computeDriverRecordHash(withoutField)).toBe(computeDriverRecordHash(withFieldUndefined));
  });

  it("manifest_digest present → changes computeDriverRecordHash (tamper-evident when set)", () => {
    const baseline = makeDriverBase();
    const withDigest = { ...makeDriverBase(), manifest_digest: "sha256:deadbeef00112233445566778899aabbccddeeff00112233445566778899aabb" };
    // A present manifest_digest must alter the hash — it is hash-bound once set
    expect(computeDriverRecordHash(baseline)).not.toBe(computeDriverRecordHash(withDigest));
  });

  it("two different manifest_digest values → two different hashes (collision resistance)", () => {
    const withDigestA = { ...makeDriverBase(), manifest_digest: "sha256:aaaa0000000000000000000000000000000000000000000000000000000000aa" };
    const withDigestB = { ...makeDriverBase(), manifest_digest: "sha256:bbbb0000000000000000000000000000000000000000000000000000000000bb" };
    expect(computeDriverRecordHash(withDigestA)).not.toBe(computeDriverRecordHash(withDigestB));
  });

  it("GroundingReceipt has NO manifest_digest field (the thread lives on BSC-1/3/7 receipts, not here)", () => {
    // Structural guard: a GroundingReceipt built without manifest_digest must not carry the key.
    const groundingBase: Omit<GroundingReceipt, "recordHash"> = {
      kind: "grounding",
      refId: "no-git",
      workClass: "integration",
      ground: { groundKind: "version-pin", pkg: "react", version: "18.3.1" },
      conformance: [],
      snapshot_coord: { gitHead: null, treeDigest: null },
      producer_identity: "test:runner",
      prevHash: GENESIS_PREV_HASH,
    };
    expect((groundingBase as Record<string, unknown>)["manifest_digest"]).toBeUndefined();
    // And the hash is stable (omit-when-absent at the GroundingReceipt level too — via groundingGroundDigest)
    const h1 = computeGroundingRecordHash(groundingBase);
    const h2 = computeGroundingRecordHash({ ...groundingBase, manifest_digest: undefined } as unknown as Omit<GroundingReceipt, "recordHash">);
    expect(h1).toBe(h2);
  });
});

// ---------------------------------------------------------------------------
// Determinism — shuffled field-order receipt produces same hash
// ---------------------------------------------------------------------------

describe("Determinism — hash is stable across shuffled field order", () => {
  it("SHUFFLED GroundingGround field order → same groundingGroundDigest (serializer sorts)", () => {
    const canonical: GroundingGround = {
      groundKind: "digest-manifest",
      manifestDigest: "sha256:aabb",
      entries: [
        { path: "src/a.ts", digest: "sha256:aa" },
        { path: "src/b.ts", digest: "sha256:bb" },
      ],
    };
    const shuffled: GroundingGround = {
      entries: [
        { path: "src/b.ts", digest: "sha256:bb" }, // reversed insertion order
        { path: "src/a.ts", digest: "sha256:aa" },
      ],
      manifestDigest: "sha256:aabb",
      groundKind: "digest-manifest",
    };
    expect(groundingGroundDigest(canonical)).toBe(groundingGroundDigest(shuffled));
  });

  it("SHUFFLED Omit<GroundingReceipt,'recordHash'> field order → same computeGroundingRecordHash", () => {
    const base: Omit<GroundingReceipt, "recordHash"> = {
      kind: "grounding",
      refId: "no-git",
      workClass: "integration",
      ground: { groundKind: "digest-manifest", manifestDigest: "sha256:aabb" },
      conformance: [{ metric: "api", observed: 0, status: "within-budget" }],
      snapshot_coord: { gitHead: null, treeDigest: null },
      producer_identity: "test:runner",
      prevHash: GENESIS_PREV_HASH,
    };
    // Simulate a differently-ordered object (as from JSON.parse of a reordered JSONL line)
    const shuffled = {
      conformance: [{ metric: "api", observed: 0, status: "within-budget" }],
      producer_identity: "test:runner",
      kind: "grounding" as const,
      prevHash: GENESIS_PREV_HASH,
      workClass: "integration",
      refId: "no-git",
      ground: { groundKind: "digest-manifest" as const, manifestDigest: "sha256:aabb" },
      snapshot_coord: { gitHead: null as null, treeDigest: null as null },
    };
    expect(computeGroundingRecordHash(base)).toBe(computeGroundingRecordHash(shuffled));
  });
});

// ---------------------------------------------------------------------------
// M-1 — Tamper-block: a non-empty broken in-process chain blocks under enforce;
//        WARN leg stays ok:true with notice; empty store stays inert PASS.
//
// Mechanism: readGroundingValidated drops all in-process receipts when the chain
// is broken (inProcessChainOk:false). evaluateGrounding detects this BEFORE
// deriving declared classes and returns { ok:false, reason:"tampered" } immediately
// (line 1231 of gate-preconditions.ts). An empty store always verifies
// (verifyGroundingChain([]) ⇒ ok:true), so absence ≠ forgery is preserved.
// ---------------------------------------------------------------------------

describe("M-1 — tamper-block: broken in-process chain blocks under enforce, WARN is non-blocking", () => {
  it("ENFORCE + tampered chain ⇒ ok:false, error:'grounding_unverified', detail.reason:'tampered'", () => {
    process.env.TH_BSC10_ENFORCE = "1";
    const paths = greenProject();
    // Append a valid receipt first, then corrupt the JSONL file so the chain breaks.
    appendGroundingReceipt(paths, {
      workClass: "integration",
      ground: {
        groundKind: "digest-manifest",
        manifestDigest: "sha256:aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
      },
      conformance: [{ metric: "api", observed: 0, status: "within-budget" }],
      producerIdentity: "test:runner",
    });
    // Tamper: overwrite the JSONL with a mutated recordHash so verifyGroundingChain fails.
    const jsonlPath = path.join(paths.stateDir, "grounding-receipts.jsonl");
    const raw = fs.readFileSync(jsonlPath, "utf8");
    const tampered = raw.replace(/"recordHash":"[0-9a-f]{64}"/, '"recordHash":"' + "0".repeat(64) + '"');
    fs.writeFileSync(jsonlPath, tampered, "utf8");

    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("grounding_unverified");
    expect((res.detail as { reason?: string } | undefined)?.reason).toBe("tampered");
  });

  it("WARN (TH_BSC10_ENFORCE unset) + tampered chain ⇒ ok:true, non-blocking (grounding summary empty by design)", () => {
    delete process.env.TH_BSC10_ENFORCE; // WARN default OFF
    const paths = greenProject();
    appendGroundingReceipt(paths, {
      workClass: "integration",
      ground: {
        groundKind: "digest-manifest",
        manifestDigest: "sha256:aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
      },
      conformance: [{ metric: "api", observed: 0, status: "within-budget" }],
      producerIdentity: "test:runner",
    });
    const jsonlPath = path.join(paths.stateDir, "grounding-receipts.jsonl");
    const raw = fs.readFileSync(jsonlPath, "utf8");
    const tampered = raw.replace(/"recordHash":"[0-9a-f]{64}"/, '"recordHash":"' + "0".repeat(64) + '"');
    fs.writeFileSync(jsonlPath, tampered, "utf8");

    const res = checkProductionReality(paths, state(paths));
    // WARN: non-blocking — ok:true, no blocking error.
    // tamper ⇒ empty summary by design (no trustworthy per-kind data); WARN proves only non-blocking.
    // res.notice is a single precedence-ordered slot (driver > realization > assertion > grounding);
    // other WARN rungs can win it — assert only the non-blocking property via res.grounding.
    expect(res.ok).toBe(true);
    expect(res.error).toBeUndefined();
    // The tamper verdict returns summary:[] (no trustworthy per-kind data), so grounding is empty.
    expect(Array.isArray(res.grounding)).toBe(true);
  });

  it("ENFORCE + EMPTY store (no receipts) ⇒ inert PASS (absence ≠ forgery; tamper-block must not break this)", () => {
    process.env.TH_BSC10_ENFORCE = "1";
    const paths = greenProject();
    // No receipts appended — empty store verifies (verifyGroundingChain([]) ⇒ ok:true)
    // → evaluateGrounding: inProcessChainOk:true, byKind empty, declaredClasses empty → null → PASS
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(true);
    expect(res.error).toBeUndefined();
    // Must NOT have a grounding_unverified error or notice
    expect(res.error).not.toBe("grounding_unverified");
    expect(res.notice?.token).not.toBe("grounding_unverified");
  });
});

// ---------------------------------------------------------------------------
// L-1 — has_ui force-rule pin: has_ui absent/undefined forces visual-hash into
//        the required set; a run with no visual-hash receipt blocks under enforce.
//
// state.has_ui !== false (default undefined/true) → surfaces ["ui"] → forces
// "visual-hash" via UX_SURFACE_LABELS. This is intentional fail-closed over-require:
// a screen surface is grounded visually. Slice C softens when real visual measurement
// lands; pin this behavior now so it cannot silently regress.
// ---------------------------------------------------------------------------

describe("L-1 — has_ui force-rule pin: undefined has_ui forces visual-hash into required set", () => {
  it("has_ui:undefined + receipt declaring 'greenfield' + ENFORCE ⇒ visual-hash forced ⇒ ok:false / reason:'missing'", () => {
    process.env.TH_BSC10_ENFORCE = "1";
    tp = makeTempProject();
    const paths = tp.paths;
    const writeFile2 = (rel: string, body: string) => {
      const abs = path.join(paths.root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body, "utf8");
    };
    writeFile2("docs/01-requirements.md", "# Requirements\n\n- REQ-001 the only requirement.\n");
    writeFile2("docs/09-implementation-plan.md", "# Plan\n\nSLICE-0 covers REQ-001.\n");
    writeFile2("tests/cov.test.ts", "// REQ-001 verified here\ntest('r', () => expect(1).toBe(1));\n");
    writeFile2("docs/10-verification-report.md", "# Verification Report\n\nREQ-001 verified.\n");
    writeState(paths, {
      ...initialState(),
      tier: "T1",
      current_stage: "final-verification",
      implementation_allowed: true,
      // has_ui intentionally NOT set (defaults to undefined, which is !== false)
      slices: [{ id: "SLICE-0", status: "done", components: [] }],
    });
    runArtifactRegister(paths, "docs/10-verification-report.md", 1);
    runTesterRecord(paths, { driver: "cli-e2e", provider: "sandbox", passed: true });
    mintRequiredApprovals(paths, readState(paths).state!);
    writeVerifyReport(paths, {
      ok: true,
      ranAt: new Date().toISOString(),
      results: [
        { command: "vitest run", exitCode: 0, ok: true, durationMs: 1, outputTail: "" },
        { command: "tsc --noEmit", exitCode: 0, ok: true, durationMs: 1, outputTail: "" },
        { command: "npm run build", exitCode: 0, ok: true, durationMs: 1, outputTail: "" },
      ],
    });
    appendDriverReceipt(paths, { producerIdentity: "test:runner" });
    // Declare "greenfield" work-class — greenfield's required-kind matrix is empty by itself,
    // but has_ui:undefined triggers the UX force-rule which adds "visual-hash" to the required set.
    // No visual-hash receipt is appended, so the required kind is missing.
    appendGroundingReceipt(paths, {
      workClass: "greenfield",
      ground: { groundKind: "version-pin", pkg: "some-dep", version: "1.0.0" },
      conformance: [{ metric: "version", observed: "1.0.0", status: "within-budget" }],
      producerIdentity: "test:runner",
    });

    const st = readState(paths).state!;
    const res = checkProductionReality(paths, st);
    // Intentional fail-closed over-require: the screen surface forces visual-hash.
    // Revisit softening in Slice C when real visual measurement lands.
    expect(res.ok).toBe(false);
    expect(res.error).toBe("grounding_unverified");
    expect((res.detail as { reason?: string } | undefined)?.reason).toBe("missing");
    // The summary must expose the missing visual-hash kind
    const vhSummary = (res.grounding ?? []).find((g) => g.groundKind === "visual-hash");
    expect(vhSummary).toBeDefined();
    expect(vhSummary?.grounded).toBe(false);
    expect(vhSummary?.conformance).toBe("missing");
  });
});

// ---------------------------------------------------------------------------
// WARN default-path gap: TH_BSC10_ENFORCE unset (Slice A default OFF) + a run
// where a required ground is MISSING or over-budget ⇒ ok:true (non-blocking) AND
// the grounding notice/summary rides up. Proves the WARN advisory path is wired.
// ---------------------------------------------------------------------------

// res.notice is a single precedence-ordered advisory slot (driver > realization > assertion > grounding,
// gate-preconditions.ts:1618). With TH_BSC2_ENFORCE=0 the BSC-2 rung is in WARN and can win the slot
// with "assertion_unobserved", shadowing grounding's token. The DEDICATED res.grounding summary array
// is the correct, uncontended observability channel for grounding (contract O1) — assert that instead.
describe("WARN default-path: flag unset + failing ground ⇒ ok:true + res.grounding summary rides up", () => {
  it("TH_BSC10_ENFORCE unset + required kind MISSING ⇒ ok:true, res.grounding has version-pin with conformance:'missing'", () => {
    delete process.env.TH_BSC10_ENFORCE; // compiled default OFF
    const paths = greenProject();
    // Declare "integration" but only append digest-manifest (version-pin missing)
    appendGroundingReceipt(paths, {
      workClass: "integration",
      ground: {
        groundKind: "digest-manifest",
        manifestDigest: "sha256:aabb",
      },
      conformance: [{ metric: "api", observed: 0, status: "within-budget" }],
      producerIdentity: "test:runner",
    });
    // version-pin deliberately NOT appended

    const res = checkProductionReality(paths, state(paths));
    // WARN: must NOT block
    expect(res.ok).toBe(true);
    expect(res.error).toBeUndefined();
    // The dedicated grounding summary is the deterministic observability channel (O1).
    // It must be non-empty and expose the missing required kind.
    expect(Array.isArray(res.grounding)).toBe(true);
    expect((res.grounding ?? []).length).toBeGreaterThan(0);
    const vpSummary = (res.grounding ?? []).find((g) => g.groundKind === "version-pin");
    expect(vpSummary).toBeDefined();
    expect(vpSummary?.grounded).toBe(false);
    expect(vpSummary?.conformance).toBe("missing");
  });

  it("TH_BSC10_ENFORCE unset + over-budget ground ⇒ ok:true, res.grounding has digest-manifest with conformance:'over-budget'", () => {
    delete process.env.TH_BSC10_ENFORCE;
    const paths = greenProject();
    appendGroundingReceipt(paths, {
      workClass: "integration",
      ground: { groundKind: "digest-manifest", manifestDigest: "sha256:aabb" },
      conformance: [{ metric: "api", observed: 999, status: "over-budget" }],
      producerIdentity: "test:runner",
    });
    appendGroundingReceipt(paths, {
      workClass: "integration",
      ground: { groundKind: "version-pin", pkg: "dep", version: "1.0.0" },
      conformance: [{ metric: "version", observed: "1.0.0", status: "within-budget" }],
      producerIdentity: "test:runner",
    });

    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(true);
    expect(res.error).toBeUndefined();
    // The over-budget kind must appear in the summary with the conformance hyphen-vocab token.
    expect(Array.isArray(res.grounding)).toBe(true);
    const dmSummary = (res.grounding ?? []).find((g) => g.groundKind === "digest-manifest");
    expect(dmSummary).toBeDefined();
    expect(dmSummary?.conformance).toBe("over-budget"); // hyphen — summary vocab, not gate-detail underscore
  });
});
