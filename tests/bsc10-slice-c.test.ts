/**
 * BSC-10 / Axis-B slice-C — Slice-C acceptance tests (I2/I7/I8 + neg-controls).
 *
 * Covers the Slice-C acceptance criteria from team-plan-bsc10c.md §3:
 *
 *   I2   — approval β leg consumes conformance: a present-but-over-budget required ground
 *           BLOCKS approval acceptance inside `:1599-1631` β leg under enforce. The block
 *           MUST surface as `grounding_unverified`, not `human_approval_unverified` — proof
 *           the precondition is CONSUMED inside the 1c leg, not bypassed.
 *           I2d is the WARN-only guard (visual-hash pre-C4d); becomes a C4d-lockstep test.
 *
 *   I7   — BSC-1/3/4 shipped probes re-run under the C4a opt-in contract:
 *           (a) Legacy (grounding_bound unset) + no manifest_digest ⇒ PASS (grandfathered).
 *           (b) grounding_bound:true + manifest_digest ABSENT on BSC-3 driver receipt ⇒
 *               BLOCK under C4a (`manifest_digest_absent`). Awaits gate landing.
 *           (c) manifest_digest present + ground satisfied ⇒ PASS (no chain_mismatch).
 *           (d) computeDriverRecordHash byte-stability (omit-when-absent invariant).
 *           (e) BSC-1/3/4 regression — legacy (grounding_bound absent) still PASS.
 *           (f) grounding_bound:true + manifest_digest PRESENT (matching) ⇒ PASS (positive ctrl).
 *           (g) grounding_bound absent ⇒ byte-identical to pre-C receipt (omit-when-absent inv.).
 *
 *   I8   — Determinism self-test: same fixture → same verdict across two invocations
 *           (no clock/random/renderer); unobserved/unpinned visual-hash tolerance kind
 *           under enforce ⇒ FAIL (never silent pass), satisfying the C4c fail-closed contract.
 *
 *   neg  — Negative controls: forged-budget ⇒ exempts NOTHING; over-threshold visual-hash ⇒
 *           BLOCK when kind is enforced (C4d); unobserved under enforce ⇒ FAIL; grandfathered
 *           (no ground required) ⇒ manifest_digest absent PASS.
 *
 * Gate implementation status (Slice C SHIPPED — d5d4fcb C4a/b/c + 7e4ef9c C4d):
 *   C4a: IMPLEMENTED — gate bumps `manifest_digest_absent` when grounding_bound===true &&
 *        manifest_digest absent on a BSC-1/3/7 receipt (hasUnboundGroundingReceipt). I7b is the TP.
 *   C4b: IMPLEMENTED — β leg fires for over_budget/unobserved on enforced kinds;
 *        `groundingBlocksAcceptance` gates it on `groundingVerdictBlocks`.
 *   C4c: IMPLEMENTED — `toleranceThresholdVerdicts` + `worseGroundingConformance` in gate.
 *        `unpinned` (no signed budget) collapses to `unobserved` (fail-closed).
 *   C4d: IMPLEMENTED — `visual-hash` IS in ENFORCED_GROUND_KINDS (bsc10-flag.ts). The visual-hash
 *        tests are flag-aware (green in both flag states); C4d-canary below LOCKS the flip.
 *
 * C4a field contract (pinned by team-lead):
 *   FIELD: `grounding_bound?: boolean` on DriverDimensionReceipt / RealizationReceipt /
 *          HumanApprovalReceipt. Omit-when-absent ⇒ byte-identical to pre-C canonical text.
 *   CANONICAL ORDER: immediately BEFORE `manifest_digest` in DRIVER_CANONICAL_FIELD_ORDER.
 *   GATE RULE: grounding_bound===true && !manifest_digest ⇒ BLOCK (manifest_digest_absent).
 *              absent/false ⇒ PASS (legacy / opt-out path).
 *
 * Fixture field shapes (coordinate with worker-gate):
 *   GroundingReceipt conformance: { metric:"visual"|"a11y", observed:number|"unobserved", status:"within-budget"|"over-budget"|"unobserved" }
 *   visual-hash ground:           { groundKind:"visual-hash", perceptualHash:"<hash>", renderer?:"<name>" }
 *   GroundingBudget canonical:    { kind:"grounding-budget", workClass, groundKind, metric, threshold,
 *                                   snapshot_coord, producer_kind:"external", key_id, prevHash }
 *   grounding_bound on BSC-3:     boolean | undefined; omit-when-absent; IN canonical order just before
 *                                  manifest_digest. Absent ⇒ legacy PASS; true+no-digest ⇒ BLOCK (C4a).
 *
 * IMPORTANT: `worseGroundingConformance` collapses `unpinned` → `unobserved`.  A visual-hash receipt
 * with a numeric `observed` and NO matching signed budget will therefore appear as `unobserved` in
 * `res.grounding[].conformance`, not `over-budget`.  Tests that check summary conformance must use
 * the actual value (`unobserved`) not the logical intent (`over-budget`).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import {
  makeTempProject,
  mintRequiredApprovals,
  mintAssertionPresenceForFixture,
  ASSERTED_COV_TEST,
  type TempProject,
} from "./helpers";
import { writeState, readState } from "../src/core/state-store";
import { initialState, type TwinHarnessState } from "../src/core/state-schema";
import { runArtifactRegister } from "../src/commands/artifact";
import { runTesterRecord } from "../src/commands/tester";
import { checkProductionReality } from "../src/core/gate-preconditions";
import { writeVerifyReport } from "../src/core/verify";
import { externalKeyId } from "../src/core/receipt-signing";
import { GENESIS_PREV_HASH } from "../src/core/hash";
import {
  appendGroundingReceipt,
  groundingCanonicalText,
  computeGroundingRecordHash,
  readLastExternalGroundingRecordHash,
  externalGroundingReceiptsPath,
  groundingBudgetsPath,
  validGroundingBudgets,
  groundingBudgetCanonicalText,
} from "../src/core/grounding";
import {
  appendDriverReceipt,
  computeDriverRecordHash,
  readLastExternalDriverRecordHash,
  externalDriverReceiptsPath,
  driverCanonicalText,
} from "../src/core/verification-driver";
import { currentReceiptSnapshotCoord } from "../src/core/receipts";
import { bsc10KindEnforced } from "../src/core/bsc10-flag";
import { hashContent } from "../src/core/hash";
import type { GroundingGround, GroundingReceipt, GroundingBudget } from "../src/core/grounding";
import type { DriverDimensionReceipt } from "../src/core/receipts";
import type { ProjectPaths } from "../src/core/paths";

// ---------------------------------------------------------------------------
// Env save/restore
// ---------------------------------------------------------------------------

const SAVED_BSC10 = process.env.TH_BSC10_ENFORCE;
const SAVED_BSC1 = process.env.TH_BSC1_ENFORCE;
const SAVED_BSC2 = process.env.TH_BSC2_ENFORCE;
const SAVED_BSC3 = process.env.TH_BSC3_ENFORCE;
const SAVED_PUBLIC_KEYFILE = process.env.TH_RECEIPT_PUBLIC_KEYFILE;
const SAVED_PRIVATE_KEYFILE = process.env.TH_RECEIPT_PRIVATE_KEYFILE;

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
  if (SAVED_PUBLIC_KEYFILE === undefined) delete process.env.TH_RECEIPT_PUBLIC_KEYFILE;
  else process.env.TH_RECEIPT_PUBLIC_KEYFILE = SAVED_PUBLIC_KEYFILE;
  if (SAVED_PRIVATE_KEYFILE === undefined) delete process.env.TH_RECEIPT_PRIVATE_KEYFILE;
  else process.env.TH_RECEIPT_PRIVATE_KEYFILE = SAVED_PRIVATE_KEYFILE;
  tp?.cleanup();
  tp = undefined;
});

// ---------------------------------------------------------------------------
// Keypairs (in-test, deterministic on CI — no real key required)
// ---------------------------------------------------------------------------

const K1 = generateKeyPairSync("ed25519");
const K2 = generateKeyPairSync("ed25519");

// ---------------------------------------------------------------------------
// Shared ground fixtures
// ---------------------------------------------------------------------------

/** redesign requires digest-manifest + visual-hash. VisualHashGround has perceptualHash + optional renderer. */
const VISUAL_HASH_GROUND: GroundingGround = {
  groundKind: "visual-hash",
  perceptualHash: "phash:aabbccddeeff001122334455",
  renderer: "test-renderer@1.0.0",
};

const DIGEST_MANIFEST_GROUND: GroundingGround = {
  groundKind: "digest-manifest",
  manifestDigest: "sha256:aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeFile(paths: ProjectPaths, rel: string, body: string): void {
  const abs = path.resolve(paths.root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, "utf8");
}

function state(paths: ProjectPaths): TwinHarnessState {
  return readState(paths).state!;
}

/** Install K's public key as the verifier key. */
function setVerifierKey(paths: ProjectPaths, publicKey: KeyObject): void {
  const f = path.join(paths.stateDir, "grounding-public.pem");
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.writeFileSync(f, publicKey.export({ type: "spki", format: "pem" }));
  process.env.TH_RECEIPT_PUBLIC_KEYFILE = f;
}

/**
 * Seal a SIGNED external GroundingReceipt line in-test (mirrors bsc10-slice-b.test.ts helper).
 */
function appendSignedExternalGrounding(
  paths: ProjectPaths,
  opts: {
    ground?: GroundingGround;
    workClass?: string;
    signWith?: KeyObject;
    keyId?: string;
    conformance?: GroundingReceipt["conformance"];
  } = {},
): GroundingReceipt {
  const coord = currentReceiptSnapshotCoord(paths);
  const ground: GroundingGround = opts.ground ?? {
    groundKind: "version-pin",
    pkg: "left-pad",
    version: "1.3.0",
  };
  const withPrev: Omit<GroundingReceipt, "recordHash" | "signature"> = {
    kind: "grounding",
    refId: coord.gitHead ?? "no-git",
    workClass: opts.workClass ?? "integration",
    ground,
    conformance: opts.conformance ?? [],
    snapshot_coord: coord,
    producer_identity: "external:ci",
    producer_kind: "external",
    key_id: opts.keyId ?? externalKeyId(K1.publicKey),
    prevHash: readLastExternalGroundingRecordHash(paths),
  };
  const canonical = groundingCanonicalText(withPrev);
  const signature = sign(null, Buffer.from(canonical, "utf8"), opts.signWith ?? K1.privateKey).toString("base64");
  const recordHash = computeGroundingRecordHash(withPrev);
  const sealed: GroundingReceipt = { ...withPrev, signature, recordHash };
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.appendFileSync(externalGroundingReceiptsPath(paths), JSON.stringify(sealed) + "\n", "utf8");
  return sealed;
}

/**
 * Seal a SIGNED external DriverDimensionReceipt in-test.
 * Supports the C4a opt-in field `grounding_bound` (BEFORE `manifest_digest` in canonical order).
 * Mirrors the helper in bsc10-slice-b.test.ts. Used for I7c/I7f/I7g (C4a contract).
 *
 * Field placement contract (pinned by team-lead):
 *   `grounding_bound` is in DRIVER_CANONICAL_FIELD_ORDER immediately BEFORE `manifest_digest`.
 *   Omit-when-absent: undefined ⇒ NOT emitted ⇒ canonical text byte-identical to pre-C receipt.
 *   The `driverCanonicalText` helper from the compiled dist enforces the order automatically;
 *   we just pass the field in the receipt object.
 *
 * NOTE: Until worker-gate lands the schema+gate changes (`grounding_bound` added to
 * DriverDimensionReceipt and DRIVER_CANONICAL_FIELD_ORDER), the field will be present in the
 * JSONL line but NOT in the canonical text (the helper's FIELD_ORDER loop skips unknown keys).
 * This means I7b tests the contracted behavior but the gate ignores the field until the schema
 * lands. We cast to `any` here to avoid a TS compile error until the type is extended.
 */
function appendSignedExternalDriver(
  paths: ProjectPaths,
  keyPair: { privateKey: KeyObject; publicKey: KeyObject },
  opts: {
    dimensionNames?: string[];
    keyId?: string;
    manifest_digest?: string;
    // C4a opt-in: true ⇒ gate BLOCKS when manifest_digest absent (under enforce + C4a wired).
    // Omit-when-absent ⇒ legacy PASS path.
    grounding_bound?: boolean;
  } = {},
): DriverDimensionReceipt {
  const evidenceRef = path
    .relative(paths.root, path.join(paths.stateDir, "verify-report.json"))
    .split(path.sep)
    .join("/");
  const names = opts.dimensionNames ?? ["tests-executed", "typecheck", "build"];
  const coord = currentReceiptSnapshotCoord(paths);
  // Build in the correct canonical order so `driverCanonicalText` (which iterates
  // DRIVER_CANONICAL_FIELD_ORDER) picks up the fields in the right sequence.
  // `grounding_bound` must appear BEFORE `manifest_digest` in the object; the canonical
  // helper uses its own field-order array so insertion order only matters for clarity.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const withPrev: any = {
    kind: "driver-dimension",
    refId: coord.gitHead ?? "no-git",
    dimensions: names.map((name) => ({ name, observed: true as const, evidenceRef })),
    snapshot_coord: coord,
    producer_identity: "external:ci",
    producer_kind: "external",
    key_id: opts.keyId ?? externalKeyId(keyPair.publicKey),
    ...(opts.grounding_bound !== undefined ? { grounding_bound: opts.grounding_bound } : {}),
    ...(opts.manifest_digest !== undefined ? { manifest_digest: opts.manifest_digest } : {}),
    prevHash: readLastExternalDriverRecordHash(paths),
  };
  const canonical = driverCanonicalText(withPrev as DriverDimensionReceipt);
  const signature = sign(null, Buffer.from(canonical, "utf8"), keyPair.privateKey).toString("base64");
  const recordHash = computeDriverRecordHash(withPrev as DriverDimensionReceipt);
  const sealed: DriverDimensionReceipt = { ...withPrev, signature, recordHash };
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.appendFileSync(externalDriverReceiptsPath(paths), JSON.stringify(sealed) + "\n", "utf8");
  return sealed;
}

/**
 * Write a signed GroundingBudget to the budget store. Producer canonical formula:
 * JSON.stringify of the fixed GROUNDING_BUDGET_CANONICAL_FIELD_ORDER object. The E4
 * canonical-match test in bsc10-slice-b.test.ts verifies this formula matches the gate.
 */
function appendSignedBudget(
  paths: ProjectPaths,
  opts: {
    workClass: string;
    groundKind: "digest-manifest" | "version-pin" | "visual-hash";
    metric: "version" | "api" | "visual" | "a11y";
    threshold: number;
    signWith?: KeyObject;
    keyId?: string;
    prevHash?: string;
  },
): void {
  const coord = currentReceiptSnapshotCoord(paths);
  const keyId = opts.keyId ?? externalKeyId(K1.publicKey);
  const prevHash = opts.prevHash ?? GENESIS_PREV_HASH;
  // Producer insertion order MUST match GROUNDING_BUDGET_CANONICAL_FIELD_ORDER.
  const budgetEntry: Record<string, unknown> = {
    kind: "grounding-budget",
    workClass: opts.workClass,
    groundKind: opts.groundKind,
    metric: opts.metric,
    threshold: opts.threshold,
    snapshot_coord: coord,
    producer_kind: "external",
    key_id: keyId,
    prevHash,
  };
  const producerCanonical = JSON.stringify(budgetEntry);
  const signKey = opts.signWith ?? K1.privateKey;
  const signature = sign(null, Buffer.from(producerCanonical, "utf8"), signKey).toString("base64");
  const recordHash = hashContent(producerCanonical);
  const sealed = { ...budgetEntry, signature, recordHash };
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.appendFileSync(groundingBudgetsPath(paths), JSON.stringify(sealed) + "\n", "utf8");
}

/**
 * A fully-green final-verification project (has_ui:false suppresses visual-hash force-rule).
 * Mirrors bsc10-slice-b.test.ts:greenProject().
 */
function greenProject(): ProjectPaths {
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
    has_ui: false, // suppress UX force-rule so integration doesn't require visual-hash
    slices: [{ id: "SLICE-0", status: "done", components: [] }],
  });
  runArtifactRegister(paths, "docs/10-verification-report.md", 1);
  runTesterRecord(paths, { driver: "cli-e2e", provider: "sandbox", passed: true });
  mintRequiredApprovals(paths, state(paths));
  mintAssertionPresenceForFixture(paths);
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

/** A green project with has_ui:true so the UX force-rule fires (visual-hash required). */
function greenProjectWithUi(): ProjectPaths {
  const _tp = makeTempProject();
  tp = _tp;
  const paths = _tp.paths;
  writeFile(paths, "docs/01-requirements.md", "# Requirements\n\n- REQ-001\n");
  writeFile(paths, "docs/09-implementation-plan.md", "# Plan\n\nSLICE-0 covers REQ-001.\n");
  writeFile(paths, "tests/cov.test.ts", ASSERTED_COV_TEST);
  writeFile(paths, "docs/10-verification-report.md", "# Verification Report\n\nREQ-001 verified.\n");
  writeState(paths, {
    ...initialState(),
    tier: "T1",
    current_stage: "final-verification",
    implementation_allowed: true,
    has_ui: true, // UX force-rule active → visual-hash required for redesign
    slices: [{ id: "SLICE-0", status: "done", components: [] }],
  });
  runArtifactRegister(paths, "docs/10-verification-report.md", 1);
  runTesterRecord(paths, { driver: "cli-e2e", provider: "sandbox", passed: true });
  mintRequiredApprovals(paths, readState(paths).state!);
  mintAssertionPresenceForFixture(paths);
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
// I2 — approval β leg consumes conformance (present-but-over-budget BLOCKS acceptance)
//
// The PCC-1 split in gate-preconditions.ts:1599-1631:
//   leg α: approval EXISTENCE check (absent/stale/forged ⇒ human_approval_unverified)
//   leg β: approval ACCEPTANCE check at :1622 (`groundingBlocksAcceptance`) — fires when
//           the verdict is `over_budget`/`unobserved` AND groundingVerdictBlocks (kind enforced).
//
// I2 proves the block token is `grounding_unverified`, NOT `human_approval_unverified`.
// That distinction is the proof the precondition is consumed INSIDE the 1c leg, not bypassed.
//
// STATUS: C4b FULLY IMPLEMENTED. All I2a/I2b/I2c tests GREEN now.
// I2d tests the WARN-only visual-hash path (currently WARN → ok:true); it is the Slice B
// control that stays ok:true until C4d promotes visual-hash to ENFORCE.
// ---------------------------------------------------------------------------

describe("I2 — approval β leg: present-but-over-budget ground BLOCKS acceptance (grounding_unverified, not human_approval_unverified)", () => {
  it("I2a: digest-manifest over-budget + all approvals present ⇒ grounding_unverified (β leg, over_budget)", () => {
    // C4b IMPLEMENTED. digest-manifest is enforced ⇒ groundingVerdictBlocks=true ⇒ β fires.
    process.env.TH_BSC10_ENFORCE = "1";
    const paths = greenProject();

    appendGroundingReceipt(paths, {
      workClass: "integration",
      ground: DIGEST_MANIFEST_GROUND,
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
    // β leg fires: grounding_unverified, NOT human_approval_unverified.
    expect(res.ok).toBe(false);
    expect(res.error).toBe("grounding_unverified");
    expect(res.error).not.toBe("human_approval_unverified");
    expect((res.detail as { reason?: string } | undefined)?.reason).toBe("over_budget");
  });

  it("I2b: version-pin over-budget + digest-manifest within-budget + all approvals present ⇒ grounding_unverified (β leg)", () => {
    process.env.TH_BSC10_ENFORCE = "1";
    const paths = greenProject();

    appendGroundingReceipt(paths, {
      workClass: "integration",
      ground: DIGEST_MANIFEST_GROUND,
      conformance: [{ metric: "api", observed: 0, status: "within-budget" }],
      producerIdentity: "test:runner",
    });
    appendGroundingReceipt(paths, {
      workClass: "integration",
      ground: { groundKind: "version-pin", pkg: "dep", version: "1.0.0" },
      conformance: [{ metric: "version", observed: 999, status: "over-budget" }],
      producerIdentity: "test:runner",
    });

    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("grounding_unverified");
    expect(res.error).not.toBe("human_approval_unverified");
    expect((res.detail as { reason?: string } | undefined)?.reason).toBe("over_budget");
  });

  it("I2c: unobserved conformance + all approvals present ⇒ grounding_unverified (β leg, unobserved outranks over-budget)", () => {
    // unobserved outranks over-budget in precedence; β leg fires for unobserved too.
    process.env.TH_BSC10_ENFORCE = "1";
    const paths = greenProject();

    appendGroundingReceipt(paths, {
      workClass: "integration",
      ground: DIGEST_MANIFEST_GROUND,
      conformance: [{ metric: "api", observed: "unobserved", status: "unobserved" }],
      producerIdentity: "test:runner",
    });
    appendGroundingReceipt(paths, {
      workClass: "integration",
      ground: { groundKind: "version-pin", pkg: "dep", version: "1.0.0" },
      conformance: [{ metric: "version", observed: "1.0.0", status: "within-budget" }],
      producerIdentity: "test:runner",
    });

    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("grounding_unverified");
    expect(res.error).not.toBe("human_approval_unverified");
    expect((res.detail as { reason?: string } | undefined)?.reason).toBe("unobserved");
  });

  it("I2d: visual-hash within-budget (signed budget present, observed under threshold) does NOT block via β leg ⇒ ok:true pre-C4d AND post-C4d", () => {
    // C4d-ROBUST design: a signed budget (threshold=1000) + observed=50 ⇒ within-budget.
    // PRE-C4D: visual-hash WARN-only → β leg inert → ok:true (non-blocking advisory).
    // POST-C4D: visual-hash enforced → β leg fires only for over_budget/unobserved → within-budget
    //           → groundingBlocksAcceptance=false → β leg still inert → ok:true.
    // This assertion holds in BOTH states so no C4d lockstep update is needed.
    //
    // This test proves the β-leg guard: a within-budget visual-hash receipt does NOT block
    // acceptance regardless of whether visual-hash is in ENFORCED_GROUND_KINDS. The error
    // token remains absent (NOT human_approval_unverified, NOT grounding_unverified).
    process.env.TH_BSC10_ENFORCE = "1";
    const paths = greenProjectWithUi();
    setVerifierKey(paths, K1.publicKey);

    // Signed budget: threshold=1000; observed=50 ⇒ well within budget.
    appendSignedBudget(paths, {
      workClass: "redesign",
      groundKind: "visual-hash",
      metric: "visual",
      threshold: 1000,
    });

    // redesign requires digest-manifest + visual-hash.
    appendGroundingReceipt(paths, {
      workClass: "redesign",
      ground: DIGEST_MANIFEST_GROUND,
      conformance: [{ metric: "api", observed: 0, status: "within-budget" }],
      producerIdentity: "test:runner",
    });
    // Visual-hash: within-budget (observed=50 ≤ threshold=1000; gate arithmetic + receipt agree).
    appendGroundingReceipt(paths, {
      workClass: "redesign",
      ground: VISUAL_HASH_GROUND,
      conformance: [{ metric: "visual", observed: 50, status: "within-budget" }],
      producerIdentity: "test:runner",
    });

    const st = readState(paths).state!;
    const res = checkProductionReality(paths, st);
    // Within-budget → β leg does NOT fire (ok:true) both pre-C4d and post-C4d.
    expect(res.ok).toBe(true);
    expect(res.error).toBeUndefined();
    // Summary confirms within-budget for visual-hash.
    const vhSummary = (res.grounding ?? []).find((g) => g.groundKind === "visual-hash");
    expect(vhSummary).toBeDefined();
    expect(vhSummary?.conformance).toBe("within-budget");
  });
});

// ---------------------------------------------------------------------------
// I7 — C4a opt-in contract: grounding_bound flag + manifest_digest BLOCK / grandfathered PASS
//
// C4a FIELD CONTRACT (pinned by team-lead):
//   FIELD: `grounding_bound?: boolean` on DriverDimensionReceipt / RealizationReceipt /
//          HumanApprovalReceipt. IN canonical order immediately BEFORE `manifest_digest`.
//          Omit-when-absent ⇒ canonical text byte-identical to pre-C receipt (regression-safe).
//   GATE RULE: grounding_bound===true && manifest_digest ABSENT ⇒ BLOCK (manifest_digest_absent)
//              under enforce. absent/false ⇒ legacy PASS.
//
// Current state (re-grepped):
//   - GroundingReason includes "manifest_digest_absent" (type defined).
//   - grounding_bound field NOT yet in DriverDimensionReceipt schema or DRIVER_CANONICAL_FIELD_ORDER.
//   - The gate bump("manifest_digest_absent") NOT YET WIRED in evaluateGrounding.
//   - I7b is EXPECTED TO FAIL until worker-gate lands schema + gate changes.
// ---------------------------------------------------------------------------

describe("I7 — C4a opt-in: grounding_bound:true + no manifest_digest ⇒ BLOCK; legacy (absent) ⇒ PASS", () => {
  it("I7a: no ground required (no receipt declares a work class) + grounding_bound absent ⇒ PASS (grandfathered, omit-when-absent)", () => {
    // Absence ≠ forgery: no declared work class and no grounding_bound ⇒ C4a does not fire.
    process.env.TH_BSC10_ENFORCE = "1";
    const paths = greenProject();
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(true);
    expect(res.error).not.toBe("grounding_unverified");
  });

  it("I7b: grounding_bound:true + manifest_digest ABSENT on BSC-3 driver receipt ⇒ BLOCK (manifest_digest_absent)", () => {
    // C4a TRUE POSITIVE: a BSC-3 driver receipt with grounding_bound:true declares it is bound to
    // a grounding manifest. If manifest_digest is ABSENT under enforce ⇒ BLOCK (manifest_digest_absent).
    // The opt-in field makes the blocking condition unambiguous (hasUnboundGroundingReceipt).
    process.env.TH_BSC10_ENFORCE = "1";
    const paths = greenProject();
    setVerifierKey(paths, K1.publicKey);

    // Both required grounding kinds satisfied within-budget.
    appendGroundingReceipt(paths, {
      workClass: "integration",
      ground: DIGEST_MANIFEST_GROUND,
      conformance: [{ metric: "api", observed: 0, status: "within-budget" }],
      producerIdentity: "test:runner",
    });
    appendGroundingReceipt(paths, {
      workClass: "integration",
      ground: { groundKind: "version-pin", pkg: "dep", version: "1.0.0" },
      conformance: [{ metric: "version", observed: "1.0.0", status: "within-budget" }],
      producerIdentity: "test:runner",
    });

    // External driver receipt with grounding_bound:true but NO manifest_digest.
    // Post-C4a: gate sees grounding_bound===true + manifest_digest absent ⇒ BLOCK.
    appendSignedExternalDriver(paths, K1, { grounding_bound: true });

    const res = checkProductionReality(paths, state(paths));
    // C4a true positive — grounding_bound + absent manifest_digest ⇒ BLOCK:
    expect(res.ok).toBe(false);
    expect(res.error).toBe("grounding_unverified");
    expect((res.detail as { reason?: string } | undefined)?.reason).toBe("manifest_digest_absent");
  });

  it("I7c: manifest_digest present + matching grounding digest ⇒ PASS (no chain_mismatch; satisfies C4a anchor)", () => {
    // A signed external driver receipt that carries the SAME manifest_digest as the grounding
    // receipt — satisfies both I3a (no chain_mismatch) and C4a (manifest_digest present).
    process.env.TH_BSC10_ENFORCE = "1";
    const paths = greenProject();
    setVerifierKey(paths, K1.publicKey);

    const manifestDigest = "sha256:aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";

    appendGroundingReceipt(paths, {
      workClass: "integration",
      ground: { groundKind: "digest-manifest", manifestDigest },
      conformance: [{ metric: "api", observed: 0, status: "within-budget" }],
      producerIdentity: "test:runner",
    });
    appendGroundingReceipt(paths, {
      workClass: "integration",
      ground: { groundKind: "version-pin", pkg: "dep", version: "1.0.0" },
      conformance: [{ metric: "version", observed: "1.0.0", status: "within-budget" }],
      producerIdentity: "test:runner",
    });

    // Append a signed external driver with the matching manifest_digest (C4a + I3a).
    appendSignedExternalDriver(paths, K1, { manifest_digest: manifestDigest });

    const res = checkProductionReality(paths, state(paths));
    // Should PASS: manifest_digest present (C4a) and matching (no chain_mismatch).
    // Pre-C4a: passes trivially (C4a not wired). Post-C4a: still passes (digest present).
    expect(res.ok).toBe(true);
    expect(res.error).toBeUndefined();
    const dmRow = (res.grounding ?? []).find((g) => g.groundKind === "digest-manifest");
    expect(dmRow?.conformance).not.toBe("chain_mismatch");
    expect(dmRow?.conformance).not.toBe("manifest_digest_absent" as string);
  });

  it("I7d: computeDriverRecordHash byte-stable when manifest_digest absent/undefined (omit-when-absent invariant)", () => {
    // Already GREEN (shipped). Re-asserted here for Slice-C independent regression coverage.
    const evidenceRef = ".th-state/verify-report.json";
    const base: Omit<DriverDimensionReceipt, "recordHash"> = {
      kind: "driver-dimension",
      refId: "no-git",
      dimensions: [
        { name: "tests-executed", observed: true, evidenceRef },
        { name: "typecheck", observed: true, evidenceRef },
        { name: "build", observed: true, evidenceRef },
      ],
      snapshot_coord: { gitHead: null, treeDigest: null },
      producer_identity: "test:runner",
      producer_kind: "external",
      key_id: externalKeyId(K1.publicKey),
      prevHash: GENESIS_PREV_HASH,
    };
    const withUndefined = { ...base, manifest_digest: undefined };
    // Omit-when-absent: both produce the same hash.
    expect(computeDriverRecordHash(base)).toBe(computeDriverRecordHash(withUndefined));
    // Present manifest_digest changes the hash (tamper-evident once set).
    const withDigest = {
      ...base,
      manifest_digest: "sha256:aabb0000000000000000000000000000000000000000000000000000000000aa",
    };
    expect(computeDriverRecordHash(base)).not.toBe(computeDriverRecordHash(withDigest));
  });

  it("I7e: BSC-1/3/4 shipped probe regression — within-budget integration + NO manifest_digest ⇒ PASS (absence ≠ forgery, C4a not triggered without anchor)", () => {
    // Grandfathered path: when the digest-manifest ground IS in the required-set and IS satisfied
    // but NO BSC-1/3/7 receipt threads manifest_digest at all (absent ⇒ threaded set is empty),
    // C4a should NOT block (the absence is not a mismatch; `manifest_digest_absent` requires
    // that the anchor IS required+present AND the threaded set is empty). This is a REGRESSION
    // guard: the shipped BSC-1/3/4 probes must stay GREEN.
    // PRE-C4A: passes (C4a not wired). POST-C4A: also passes (empty threaded set ≠ mismatch).
    // (I7b is the case that BLOCKS — that requires the gate-lane change to fire.)
    process.env.TH_BSC10_ENFORCE = "1";
    const paths = greenProject();

    appendGroundingReceipt(paths, {
      workClass: "integration",
      ground: DIGEST_MANIFEST_GROUND,
      conformance: [{ metric: "api", observed: 0, status: "within-budget" }],
      producerIdentity: "test:runner",
    });
    appendGroundingReceipt(paths, {
      workClass: "integration",
      ground: { groundKind: "version-pin", pkg: "dep", version: "1.0.0" },
      conformance: [{ metric: "version", observed: "1.0.0", status: "within-budget" }],
      producerIdentity: "test:runner",
    });
    // NOTE: no manifest_digest and no grounding_bound on the driver receipt (legacy/pre-C4a).
    // C4a grandfathered path: grounding_bound absent → PASS regardless of manifest_digest.

    const res = checkProductionReality(paths, state(paths));
    // Pre-C4a AND post-C4a: legacy (grounding_bound absent) ⇒ PASS.
    expect(res.ok).toBe(true);
    expect(res.error).toBeUndefined();
  });

  it("I7f: grounding_bound:true + manifest_digest PRESENT (matching) ⇒ PASS (positive control)", () => {
    // C4a POSITIVE CONTROL: grounding_bound:true with a PRESENT manifest_digest satisfying the
    // grounding ground digest ⇒ PASS. The block fires ONLY when manifest_digest is ABSENT.
    // Pre-C4a: passes (grounding_bound ignored). Post-C4a: also PASS (digest present).
    process.env.TH_BSC10_ENFORCE = "1";
    const paths = greenProject();
    setVerifierKey(paths, K1.publicKey);

    const manifestDigest = "sha256:aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";

    appendGroundingReceipt(paths, {
      workClass: "integration",
      ground: { groundKind: "digest-manifest", manifestDigest },
      conformance: [{ metric: "api", observed: 0, status: "within-budget" }],
      producerIdentity: "test:runner",
    });
    appendGroundingReceipt(paths, {
      workClass: "integration",
      ground: { groundKind: "version-pin", pkg: "dep", version: "1.0.0" },
      conformance: [{ metric: "version", observed: "1.0.0", status: "within-budget" }],
      producerIdentity: "test:runner",
    });

    // grounding_bound:true AND manifest_digest present (matches grounding digest) ⇒ PASS.
    appendSignedExternalDriver(paths, K1, {
      grounding_bound: true,
      manifest_digest: manifestDigest,
    });

    const res = checkProductionReality(paths, state(paths));
    // Both pre-C4a (field ignored) and post-C4a (field+digest both present) ⇒ PASS.
    expect(res.ok).toBe(true);
    expect(res.error).toBeUndefined();
    const dmRow = (res.grounding ?? []).find((g) => g.groundKind === "digest-manifest");
    expect(dmRow?.conformance).not.toBe("manifest_digest_absent" as string);
    expect(dmRow?.conformance).not.toBe("chain_mismatch");
  });

  it("I7g: grounding_bound absent ⇒ computeDriverRecordHash byte-identical to receipt without the field (omit-when-absent invariant)", () => {
    // C4a field contract: `grounding_bound` is omit-when-absent in canonical order.
    // A receipt with grounding_bound:undefined MUST hash identically to one without the key at all.
    // A receipt with grounding_bound:true MUST hash DIFFERENTLY (the field IS in canonical order).
    // NOTE: this assertion holds NOW (pre-C4a) only if DRIVER_CANONICAL_FIELD_ORDER does NOT yet
    // include `grounding_bound`. Post-C4a schema landing: the field will be in the order, so
    // grounding_bound:undefined still hashes identically (omit-when-absent skip), but
    // grounding_bound:true will diverge.
    const evidenceRef = ".th-state/verify-report.json";
    const base: Omit<DriverDimensionReceipt, "recordHash"> = {
      kind: "driver-dimension",
      refId: "no-git",
      dimensions: [
        { name: "tests-executed", observed: true, evidenceRef },
        { name: "typecheck", observed: true, evidenceRef },
        { name: "build", observed: true, evidenceRef },
      ],
      snapshot_coord: { gitHead: null, treeDigest: null },
      producer_identity: "test:runner",
      producer_kind: "external",
      key_id: externalKeyId(K1.publicKey),
      prevHash: GENESIS_PREV_HASH,
    };

    // grounding_bound:undefined ⇒ field omitted by canonical helper ⇒ byte-identical to base.
    const withUndefinedBound = { ...base, grounding_bound: undefined } as typeof base;
    expect(computeDriverRecordHash(base)).toBe(computeDriverRecordHash(withUndefinedBound));

    // manifest_digest present still changes hash (tamper-evident, pre-existing invariant).
    const withDigest = {
      ...base,
      manifest_digest: "sha256:aabb0000000000000000000000000000000000000000000000000000000000aa",
    };
    expect(computeDriverRecordHash(base)).not.toBe(computeDriverRecordHash(withDigest));
  });
});

// ---------------------------------------------------------------------------
// I8 — Determinism self-test (same fixture → same verdict) + fail-closed unobserved
//
// I8a: same fixture → same verdict across two calls (no clock/random/renderer).
// I8b: unobserved/unpinned tolerance kind under enforce ⇒ FAIL (never silent pass).
//      For deterministic kinds (digest-manifest/version-pin): GREEN now.
//      For visual-hash: awaits C4d enforce-flip.
// ---------------------------------------------------------------------------

describe("I8 — determinism self-test (same fixture → same verdict twice) + fail-closed unobserved", () => {
  it("I8a-missing: same missing-kind fixture ⇒ same verdict twice (deterministic block)", () => {
    process.env.TH_BSC10_ENFORCE = "1";
    const paths = greenProject();
    appendGroundingReceipt(paths, {
      workClass: "integration",
      ground: DIGEST_MANIFEST_GROUND,
      conformance: [{ metric: "api", observed: 0, status: "within-budget" }],
      producerIdentity: "test:runner",
    });
    // version-pin absent → missing required kind.
    const res1 = checkProductionReality(paths, state(paths));
    const res2 = checkProductionReality(paths, state(paths));
    expect(res1.ok).toBe(res2.ok);
    expect(res1.error).toBe(res2.error);
    expect((res1.detail as { reason?: string } | undefined)?.reason).toBe(
      (res2.detail as { reason?: string } | undefined)?.reason,
    );
    // Non-vacuous: real block.
    expect(res1.ok).toBe(false);
    expect(res1.error).toBe("grounding_unverified");
    expect((res1.detail as { reason?: string } | undefined)?.reason).toBe("missing");
  });

  it("I8a-overbudget: same over-budget fixture ⇒ same verdict twice (deterministic block)", () => {
    process.env.TH_BSC10_ENFORCE = "1";
    const paths = greenProject();
    appendGroundingReceipt(paths, {
      workClass: "integration",
      ground: DIGEST_MANIFEST_GROUND,
      conformance: [{ metric: "api", observed: 500, status: "over-budget" }],
      producerIdentity: "test:runner",
    });
    appendGroundingReceipt(paths, {
      workClass: "integration",
      ground: { groundKind: "version-pin", pkg: "dep", version: "1.0.0" },
      conformance: [{ metric: "version", observed: "1.0.0", status: "within-budget" }],
      producerIdentity: "test:runner",
    });
    const res1 = checkProductionReality(paths, state(paths));
    const res2 = checkProductionReality(paths, state(paths));
    expect(res1.ok).toBe(res2.ok);
    expect(res1.error).toBe(res2.error);
    expect((res1.detail as { reason?: string } | undefined)?.reason).toBe(
      (res2.detail as { reason?: string } | undefined)?.reason,
    );
    expect(res1.ok).toBe(false);
    expect(res1.error).toBe("grounding_unverified");
    expect((res1.detail as { reason?: string } | undefined)?.reason).toBe("over_budget");
  });

  it("I8a-pass: within-budget fixture ⇒ PASS twice (deterministic green)", () => {
    process.env.TH_BSC10_ENFORCE = "1";
    const paths = greenProject();
    appendGroundingReceipt(paths, {
      workClass: "integration",
      ground: DIGEST_MANIFEST_GROUND,
      conformance: [{ metric: "api", observed: 0, status: "within-budget" }],
      producerIdentity: "test:runner",
    });
    appendGroundingReceipt(paths, {
      workClass: "integration",
      ground: { groundKind: "version-pin", pkg: "dep", version: "1.0.0" },
      conformance: [{ metric: "version", observed: "1.0.0", status: "within-budget" }],
      producerIdentity: "test:runner",
    });
    const res1 = checkProductionReality(paths, state(paths));
    const res2 = checkProductionReality(paths, state(paths));
    expect(res1.ok).toBe(res2.ok);
    expect(res1.error).toBe(res2.error);
    expect(res1.ok).toBe(true);
  });

  it("I8b-unobserved-deterministic: unobserved digest-manifest ⇒ FAIL twice (deterministic kind, GREEN now)", () => {
    // digest-manifest IS in ENFORCED_GROUND_KINDS → blocks. Both calls identical.
    process.env.TH_BSC10_ENFORCE = "1";
    const paths = greenProject();
    appendGroundingReceipt(paths, {
      workClass: "integration",
      ground: DIGEST_MANIFEST_GROUND,
      conformance: [{ metric: "api", observed: "unobserved", status: "unobserved" }],
      producerIdentity: "test:runner",
    });
    appendGroundingReceipt(paths, {
      workClass: "integration",
      ground: { groundKind: "version-pin", pkg: "dep", version: "1.0.0" },
      conformance: [{ metric: "version", observed: "1.0.0", status: "within-budget" }],
      producerIdentity: "test:runner",
    });
    const res1 = checkProductionReality(paths, state(paths));
    const res2 = checkProductionReality(paths, state(paths));
    expect(res1.ok).toBe(res2.ok);
    expect(res1.error).toBe(res2.error);
    expect(res1.ok).toBe(false);
    expect(res1.error).toBe("grounding_unverified");
    expect((res1.detail as { reason?: string } | undefined)?.reason).toBe("unobserved");
  });

  it("I8b-unobserved-visual-hash (C4d flag-aware): unobserved visual-hash ⇒ FAIL twice after enforce-flip", () => {
    // C4c IMPLEMENTED: toleranceThresholdVerdicts collapses unobserved → unobserved.
    // worseGroundingConformance: unobserved → summary shows unobserved.
    // C4d NOT YET: visual-hash not in ENFORCED_GROUND_KINDS → groundingVerdictBlocks=false.
    // PRE-C4D: ok:true (WARN), both calls. POST-C4D: ok:false (FAIL), both calls.
    // Test contracts the POST-C4D behavior. Fails until C4d flip.
    process.env.TH_BSC10_ENFORCE = "1";
    const paths = greenProjectWithUi();

    appendGroundingReceipt(paths, {
      workClass: "redesign",
      ground: DIGEST_MANIFEST_GROUND,
      conformance: [{ metric: "api", observed: 0, status: "within-budget" }],
      producerIdentity: "test:runner",
    });
    appendGroundingReceipt(paths, {
      workClass: "redesign",
      ground: VISUAL_HASH_GROUND,
      conformance: [{ metric: "visual", observed: "unobserved", status: "unobserved" }],
      producerIdentity: "test:runner",
    });

    const st = readState(paths).state!;
    const res1 = checkProductionReality(paths, st);
    const res2 = checkProductionReality(paths, st);

    // Deterministic (both calls return same verdict).
    expect(res1.ok).toBe(res2.ok);
    expect(res1.error).toBe(res2.error);

    // C4d flag-aware: WARN ⇒ ok:true (advisory); ENFORCED ⇒ ok:false (block).
    const vhEnforced = bsc10KindEnforced("visual-hash");
    expect(res1.ok).toBe(!vhEnforced);
    if (vhEnforced) {
      expect(res1.error).toBe("grounding_unverified");
      expect((res1.detail as { reason?: string } | undefined)?.reason).toBe("unobserved");
    }
    // The summary exposes the unobserved visual-hash in BOTH states (C4c).
    const vhSummary = (res1.grounding ?? []).find((g) => g.groundKind === "visual-hash");
    expect(vhSummary?.conformance).toBe("unobserved");
  });

  it("I8b-unpinned-visual-hash (C4d flag-aware): visual-hash observed but no signed budget ⇒ unpinned→unobserved ⇒ FAIL twice", () => {
    // C4c IMPLEMENTED: no signed budget → unpinned → collapses to unobserved in worseGroundingConformance.
    // C4d NOT YET: visual-hash not enforced → ok:true (WARN). POST-C4D: ok:false (FAIL).
    // Test contracts the POST-C4D behavior. Fails until C4d flip.
    process.env.TH_BSC10_ENFORCE = "1";
    const paths = greenProjectWithUi();

    appendGroundingReceipt(paths, {
      workClass: "redesign",
      ground: DIGEST_MANIFEST_GROUND,
      conformance: [{ metric: "api", observed: 0, status: "within-budget" }],
      producerIdentity: "test:runner",
    });
    // Observed numeric value but NO signed budget → unpinned → unobserved (fail-closed C4c).
    appendGroundingReceipt(paths, {
      workClass: "redesign",
      ground: VISUAL_HASH_GROUND,
      conformance: [{ metric: "visual", observed: 42, status: "within-budget" }],
      producerIdentity: "test:runner",
    });
    // No budget appended → no signed threshold.

    const st = readState(paths).state!;
    const res1 = checkProductionReality(paths, st);
    const res2 = checkProductionReality(paths, st);

    // Deterministic in both states.
    expect(res1.ok).toBe(res2.ok);
    expect(res1.error).toBe(res2.error);

    // C4d flag-aware: WARN ⇒ ok:true (advisory); ENFORCED ⇒ ok:false (block).
    const vhEnforced = bsc10KindEnforced("visual-hash");
    expect(res1.ok).toBe(!vhEnforced);
    if (vhEnforced) {
      expect(res1.error).toBe("grounding_unverified");
      // worseGroundingConformance collapses unpinned → unobserved.
      expect((res1.detail as { reason?: string } | undefined)?.reason).toBe("unobserved");
    }
    // The summary exposes unobserved in BOTH states (C4c — unpinned collapses to unobserved).
    const vhSummary = (res1.grounding ?? []).find((g) => g.groundKind === "visual-hash");
    expect(vhSummary?.conformance).toBe("unobserved");
  });

  // CANARY (review-fix, code MED): LOCKS the C4d enforce-flip. Unlike the flag-aware tests above,
  // this asserts the flip is ACTIVE — `bsc10KindEnforced("visual-hash")` MUST be true and a
  // visual-hash offender MUST block ABSOLUTELY (no `!vhEnforced` indirection). If the C4d flip is
  // reverted (visual-hash removed from ENFORCED_GROUND_KINDS), this FAILS loudly — so reverting the
  // "revertable flip" is a DELIBERATE act (revert this canary too), not a silent regression.
  it("C4d-canary: visual-hash IS enforced — bsc10KindEnforced true + a visual-hash offender blocks absolutely", () => {
    process.env.TH_BSC10_ENFORCE = "1";
    expect(bsc10KindEnforced("visual-hash")).toBe(true);
    const paths = greenProjectWithUi();
    appendGroundingReceipt(paths, {
      workClass: "redesign",
      ground: DIGEST_MANIFEST_GROUND,
      conformance: [{ metric: "api", observed: 0, status: "within-budget" }],
      producerIdentity: "test:runner",
    });
    appendGroundingReceipt(paths, {
      workClass: "redesign",
      ground: VISUAL_HASH_GROUND,
      conformance: [{ metric: "visual", observed: "unobserved", status: "unobserved" }],
      producerIdentity: "test:runner",
    });
    const st = readState(paths).state!;
    const res = checkProductionReality(paths, st);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("grounding_unverified");
  });
});

// ---------------------------------------------------------------------------
// Negative controls — forged-budget / over-threshold / unobserved / grandfathered
// ---------------------------------------------------------------------------

describe("Negative controls — forged-budget / over-threshold / unobserved / grandfathered", () => {
  it("neg-1a: forged budget (wrong-key signature) ⇒ validGroundingBudgets empty (exempts NOTHING)", () => {
    const tp2 = makeTempProject();
    try {
      const paths = tp2.paths;
      setVerifierKey(paths, K1.publicKey);
      // Budget signed with K2 but key_id claims K1 → verification fails → empty map.
      appendSignedBudget(paths, {
        workClass: "integration",
        groundKind: "digest-manifest",
        metric: "api",
        threshold: 9999,
        signWith: K2.privateKey,
        keyId: externalKeyId(K1.publicKey),
      });
      const budgets = validGroundingBudgets(paths);
      expect(budgets.size).toBe(0);
    } finally {
      tp2.cleanup();
    }
  });

  it("neg-1b: forged budget ⇒ gate treats over-budget conformance as BLOCKING (M4 fail-closed)", () => {
    // Unsigned/wrong-key budget exempts NOTHING → over-budget receipt still blocks.
    process.env.TH_BSC10_ENFORCE = "1";
    const paths = greenProject();
    setVerifierKey(paths, K1.publicKey);

    // Forged budget (wrong key) that would exempt the over-budget if valid.
    appendSignedBudget(paths, {
      workClass: "integration",
      groundKind: "digest-manifest",
      metric: "api",
      threshold: 9999,
      signWith: K2.privateKey, // wrong key → forged → inert
    });

    appendGroundingReceipt(paths, {
      workClass: "integration",
      ground: DIGEST_MANIFEST_GROUND,
      conformance: [{ metric: "api", observed: 500, status: "over-budget" }],
      producerIdentity: "test:runner",
    });
    appendGroundingReceipt(paths, {
      workClass: "integration",
      ground: { groundKind: "version-pin", pkg: "dep", version: "1.0.0" },
      conformance: [{ metric: "version", observed: "1.0.0", status: "within-budget" }],
      producerIdentity: "test:runner",
    });

    const res = checkProductionReality(paths, state(paths));
    // Forged budget exempts NOTHING → over-budget BLOCKS (M4).
    expect(res.ok).toBe(false);
    expect(res.error).toBe("grounding_unverified");
    expect((res.detail as { reason?: string } | undefined)?.reason).toBe("over_budget");
  });

  it("neg-2 (C4d flag-aware): valid signed budget + visual over-budget receipt ⇒ BLOCK when visual-hash enforced", () => {
    // C4c IMPLEMENTED: gate reads receipt status (over-budget) + independently compares
    // observed(150) > signed_threshold(100) ⇒ over-budget. worseGroundingConformance takes worse.
    // C4d NOT YET: visual-hash not in ENFORCED_GROUND_KINDS → WARN → ok:true.
    // POST-C4D: ok:false, reason over_budget.
    process.env.TH_BSC10_ENFORCE = "1";
    const paths = greenProjectWithUi();
    setVerifierKey(paths, K1.publicKey);

    // Signed valid budget: threshold=100 for redesign::visual-hash::visual.
    appendSignedBudget(paths, {
      workClass: "redesign",
      groundKind: "visual-hash",
      metric: "visual",
      threshold: 100,
    });

    appendGroundingReceipt(paths, {
      workClass: "redesign",
      ground: DIGEST_MANIFEST_GROUND,
      conformance: [{ metric: "api", observed: 0, status: "within-budget" }],
      producerIdentity: "test:runner",
    });
    // observed=150 > threshold=100 → C4c: over-budget (gate arithmetic).
    appendGroundingReceipt(paths, {
      workClass: "redesign",
      ground: VISUAL_HASH_GROUND,
      conformance: [{ metric: "visual", observed: 150, status: "over-budget" }],
      producerIdentity: "test:runner",
    });

    const st = readState(paths).state!;
    const res = checkProductionReality(paths, st);
    // C4d flag-aware: WARN ⇒ ok:true (advisory); ENFORCED ⇒ ok:false (block).
    const vhEnforced = bsc10KindEnforced("visual-hash");
    expect(res.ok).toBe(!vhEnforced);
    if (vhEnforced) {
      expect(res.error).toBe("grounding_unverified");
      expect((res.detail as { reason?: string } | undefined)?.reason).toBe("over_budget");
    }
    const vhSummary = (res.grounding ?? []).find((g) => g.groundKind === "visual-hash");
    expect(vhSummary?.conformance).toBe("over-budget");
  });

  it("neg-3: valid signed budget within-threshold ⇒ validGroundingBudgets has the entry (canonical match)", () => {
    // GREEN now (not C4d-gated). Confirms appendSignedBudget uses the same canonical formula
    // as the gate (mirrors bsc10-slice-b.test.ts E4 canonical-match test).
    const tp2 = makeTempProject();
    try {
      const paths = tp2.paths;
      setVerifierKey(paths, K1.publicKey);

      appendSignedBudget(paths, {
        workClass: "integration",
        groundKind: "digest-manifest",
        metric: "api",
        threshold: 200,
      });

      const budgets = validGroundingBudgets(paths);
      const key = "integration::digest-manifest::api";
      expect(
        budgets.has(key),
        `validGroundingBudgets should accept the budget under key '${key}'. ` +
          `If this fails, the appendSignedBudget helper's canonical formula diverged from the gate's groundingBudgetCanonicalText.`,
      ).toBe(true);
      expect(budgets.get(key)?.threshold).toBe(200);
    } finally {
      tp2.cleanup();
    }
  });

  it("neg-4: grandfathered (no ground required) ⇒ manifest_digest absent PASS (C4a does not fire)", () => {
    // C4a requires the work to declare a ground class. No receipts → not-required → PASS.
    process.env.TH_BSC10_ENFORCE = "1";
    const paths = greenProject();
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(true);
    expect(res.error).not.toBe("grounding_unverified");
  });

  it("neg-5: canonical text check — appendSignedBudget formula matches groundingBudgetCanonicalText (no divergence)", () => {
    // This is the Slice-C analogue of the bsc10-slice-b E4 canonical-match test.
    const tp2 = makeTempProject();
    try {
      const paths = tp2.paths;
      setVerifierKey(paths, K1.publicKey);
      const coord = currentReceiptSnapshotCoord(paths);
      const keyId = externalKeyId(K1.publicKey);

      const budgetEntry: Record<string, unknown> = {
        kind: "grounding-budget",
        workClass: "integration",
        groundKind: "digest-manifest",
        metric: "api",
        threshold: 50,
        snapshot_coord: coord,
        producer_kind: "external",
        key_id: keyId,
        prevHash: GENESIS_PREV_HASH,
      };
      const producerCanonical = JSON.stringify(budgetEntry);
      const gateCanonical = groundingBudgetCanonicalText(
        budgetEntry as Omit<GroundingBudget, "signature" | "recordHash">,
      );
      expect(
        producerCanonical,
        `Canonical mismatch — producer: ${producerCanonical}\ngate: ${gateCanonical}`,
      ).toBe(gateCanonical);
    } finally {
      tp2.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// C4c — threshold comparison: signed-budget path for visual/a11y
//
// The gate's `worseGroundingConformance` takes the WORSE of:
//   (a) receipt's own conformance status (self-reported by the producer)
//   (b) toleranceThresholdVerdicts (gate-side arithmetic: observed vs signed threshold)
//
// `unpinned` (numeric observed, no signed budget) collapses to `unobserved` (fail-closed).
// This describe block exercises the C4c threshold comparison path directly.
// ---------------------------------------------------------------------------

describe("C4c — tolerance threshold comparison: visual/a11y observed-vs-signed-budget (C4c IMPLEMENTED)", () => {
  it("C4c-a: valid signed budget (threshold=100) + within-budget receipt (observed=50) ⇒ within-budget summary", () => {
    // C4c: observed(50) ≤ threshold(100) ⇒ within-budget. Receipt also says within-budget.
    // visual-hash is WARN-only (C4d pending) so gate is non-blocking in either case.
    // This test focuses on the C4c verdict path: summary conformance = within-budget.
    process.env.TH_BSC10_ENFORCE = "1";
    const paths = greenProjectWithUi();
    setVerifierKey(paths, K1.publicKey);

    appendSignedBudget(paths, {
      workClass: "redesign",
      groundKind: "visual-hash",
      metric: "visual",
      threshold: 100,
    });

    appendGroundingReceipt(paths, {
      workClass: "redesign",
      ground: DIGEST_MANIFEST_GROUND,
      conformance: [{ metric: "api", observed: 0, status: "within-budget" }],
      producerIdentity: "test:runner",
    });
    appendGroundingReceipt(paths, {
      workClass: "redesign",
      ground: VISUAL_HASH_GROUND,
      conformance: [{ metric: "visual", observed: 50, status: "within-budget" }],
      producerIdentity: "test:runner",
    });

    const st = readState(paths).state!;
    const res = checkProductionReality(paths, st);
    // Pre-C4d: ok:true (visual-hash WARN). Post-C4d + within-budget: still ok:true.
    expect(res.ok).toBe(true);
    // The summary should show within-budget for visual-hash.
    const vhSummary = (res.grounding ?? []).find((g) => g.groundKind === "visual-hash");
    if (vhSummary !== undefined) {
      expect(vhSummary.conformance).toBe("within-budget");
    }
  });

  it("C4c-b (C4d flag-aware): valid signed budget (threshold=10) + over-budget receipt (observed=50) ⇒ over-budget + BLOCK when enforced", () => {
    // C4c: gate arithmetic: observed(50) > threshold(10) ⇒ over-budget.
    // Receipt also declares over-budget (worst-of: over-budget).
    // PRE-C4D: ok:true (WARN). POST-C4D: ok:false (FAIL).
    process.env.TH_BSC10_ENFORCE = "1";
    const paths = greenProjectWithUi();
    setVerifierKey(paths, K1.publicKey);

    appendSignedBudget(paths, {
      workClass: "redesign",
      groundKind: "visual-hash",
      metric: "visual",
      threshold: 10, // strict: observed=50 > 10 ⇒ over-budget
    });

    appendGroundingReceipt(paths, {
      workClass: "redesign",
      ground: DIGEST_MANIFEST_GROUND,
      conformance: [{ metric: "api", observed: 0, status: "within-budget" }],
      producerIdentity: "test:runner",
    });
    appendGroundingReceipt(paths, {
      workClass: "redesign",
      ground: VISUAL_HASH_GROUND,
      conformance: [{ metric: "visual", observed: 50, status: "over-budget" }],
      producerIdentity: "test:runner",
    });

    const st = readState(paths).state!;
    const res = checkProductionReality(paths, st);
    // C4d flag-aware: WARN ⇒ ok:true (advisory); ENFORCED ⇒ ok:false (block).
    const vhEnforced = bsc10KindEnforced("visual-hash");
    expect(res.ok).toBe(!vhEnforced);
    if (vhEnforced) {
      expect(res.error).toBe("grounding_unverified");
      expect((res.detail as { reason?: string } | undefined)?.reason).toBe("over_budget");
    }
    const vhSummary = (res.grounding ?? []).find((g) => g.groundKind === "visual-hash");
    expect(vhSummary?.conformance).toBe("over-budget");
  });

  it("C4c-c: receipt self-reports within-budget but observed(200) > signed threshold(100) ⇒ gate arithmetic overrides summary to over-budget (C4c GREEN now)", () => {
    // C4c recompute-don't-trust: the gate's OWN arithmetic overrides the receipt's self-reported
    // status. A generous self-reported 'within-budget' at observed=200 with threshold=100 must
    // be caught in the summary. This C4c arithmetic path is IMPLEMENTED — GREEN now in both states.
    process.env.TH_BSC10_ENFORCE = "1";
    const paths = greenProjectWithUi();
    setVerifierKey(paths, K1.publicKey);

    appendSignedBudget(paths, {
      workClass: "redesign",
      groundKind: "visual-hash",
      metric: "visual",
      threshold: 100,
    });

    appendGroundingReceipt(paths, {
      workClass: "redesign",
      ground: DIGEST_MANIFEST_GROUND,
      conformance: [{ metric: "api", observed: 0, status: "within-budget" }],
      producerIdentity: "test:runner",
    });
    // Receipt lies: says within-budget but observed=200 > threshold=100.
    appendGroundingReceipt(paths, {
      workClass: "redesign",
      ground: VISUAL_HASH_GROUND,
      conformance: [{ metric: "visual", observed: 200, status: "within-budget" }],
      producerIdentity: "test:runner",
    });

    const st = readState(paths).state!;
    const res = checkProductionReality(paths, st);
    // C4c: gate arithmetic catches the breach → summary = over-budget (GREEN in both states).
    const vhSummary = (res.grounding ?? []).find((g) => g.groundKind === "visual-hash");
    expect(vhSummary?.conformance).toBe("over-budget");
    // The blocking gate fires only after C4d; this test validates the summary arithmetic only.
    // C4d flag-aware: WARN ⇒ ok:true (advisory); ENFORCED ⇒ ok:false (block).
    const vhEnforced = bsc10KindEnforced("visual-hash");
    expect(res.ok).toBe(!vhEnforced);
    if (vhEnforced) {
      expect(res.error).toBe("grounding_unverified");
      expect((res.detail as { reason?: string } | undefined)?.reason).toBe("over_budget");
    }
  });

  it("C4c-c-block: same fixture as C4c-c ⇒ BLOCK when visual-hash enforced (flag-aware)", () => {
    // Same fixture as C4c-c. Summary already shows over-budget (C4c arithmetic, proven above).
    // This test is the dedicated blocking assertion: flag-aware so it is GREEN in both states.
    // PRE-C4D (visual-hash WARN): vhEnforced=false ⇒ ok:true (no block, advisory only).
    // POST-C4D (visual-hash ENFORCED): vhEnforced=true ⇒ ok:false (grounding_unverified/over_budget).
    process.env.TH_BSC10_ENFORCE = "1";
    const paths = greenProjectWithUi();
    setVerifierKey(paths, K1.publicKey);

    appendSignedBudget(paths, {
      workClass: "redesign",
      groundKind: "visual-hash",
      metric: "visual",
      threshold: 100,
    });

    appendGroundingReceipt(paths, {
      workClass: "redesign",
      ground: DIGEST_MANIFEST_GROUND,
      conformance: [{ metric: "api", observed: 0, status: "within-budget" }],
      producerIdentity: "test:runner",
    });
    appendGroundingReceipt(paths, {
      workClass: "redesign",
      ground: VISUAL_HASH_GROUND,
      conformance: [{ metric: "visual", observed: 200, status: "within-budget" }],
      producerIdentity: "test:runner",
    });

    const st = readState(paths).state!;
    const res = checkProductionReality(paths, st);
    // C4d flag-aware: WARN ⇒ ok:true (advisory); ENFORCED ⇒ ok:false (block).
    const vhEnforced = bsc10KindEnforced("visual-hash");
    expect(res.ok).toBe(!vhEnforced);
    if (vhEnforced) {
      expect(res.error).toBe("grounding_unverified");
      expect((res.detail as { reason?: string } | undefined)?.reason).toBe("over_budget");
    }
  });
});
