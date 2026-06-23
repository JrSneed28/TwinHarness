/**
 * BSC-10 / Axis-B slice-B — Slice-B acceptance tests.
 *
 * Covers the Slice-B acceptance criteria from plan §5 B1/B2 and §4:
 *
 *   E3  — control-flip independence (spawnSync over the real external producer):
 *          ARM A: real-key producer-signed grounding receipt ⇒ readGroundingValidated
 *          classifies `valid-grounded` ⇒ gate PASSES.
 *          ARM B: wrong-key/no-key ⇒ `forged`/`ungrounded` ⇒ gate BLOCKS under enforce.
 *
 *   E4  — 3-party budget authority: producer-signed sibling budget ⇒ validGroundingBudgets
 *          verifies ⇒ an over-budget conformance is EXEMPTED via exception path.
 *          CRITICAL INTEGRATION CHECK: gate canonical (groundingBudgetCanonicalText via
 *          siblingCanonicalText) vs producer canonical (raw JSON.stringify). If these diverge
 *          the test will fail-fast and report the byte diff to the lead.
 *
 *   M4  — unsigned/wrong-key budget|exception|carveout ⇒ exempts NOTHING (over-budget BLOCKS).
 *
 *   I3  — chain_mismatch: a BSC-1/3/7 `manifest_digest` disagreeing with the grounding manifest
 *          digest ⇒ `chain_mismatch` reason ⇒ FAIL under enforce (digest-manifest kind).
 *          Absent threading ⇒ back-compat PASS.
 *
 *   I6  — per-kind enforce leg: digest-manifest/version-pin missing ⇒ BLOCK; visual-hash/a11y
 *          missing ⇒ ok:true + non-blocking notice (per-kind WARN in Slice B, M2).
 *
 *   I7  — shipped BSC-1/3/4 receipts-parity + bsc1/bsc3 probes stay green (manifest_digest
 *          omit-when-absent keeps pre-BSC-10 receipts byte-identical).
 *
 *   U9  — env-leg table: 0/false → off; 1/true/yes/on/banana → on (bsc2-mirror polarity)
 *          + compiled-default leg (unset → false, Slice-B WARN dist).
 *
 * Key fixture design:
 *  - Keypairs K1 (verifier) / K2 (wrong key) generated in-test — no CI secret required.
 *  - `appendSignedExternalGrounding` mirrors `bsc3-independence-control-flip.test.ts:142`.
 *  - `greenProject()` mirrors `bsc10-integration.test.ts:107` (has_ui:false to suppress force-rule).
 *  - All TH_BSC*_ENFORCE + TH_RECEIPT_*_KEYFILE envs are saved/restored in afterEach.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
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
  readGroundingValidated,
  groundingCanonicalText,
  groundingBudgetCanonicalText,
  computeGroundingRecordHash,
  readLastExternalGroundingRecordHash,
  externalGroundingReceiptsPath,
  groundingBudgetsPath,
  validGroundingBudgets,
  verifyGroundingChain,
} from "../src/core/grounding";
import {
  appendDriverReceipt,
  computeDriverRecordHash,
  readLastExternalDriverRecordHash,
  externalDriverReceiptsPath,
  driverCanonicalText,
} from "../src/core/verification-driver";
import { currentReceiptSnapshotCoord } from "../src/core/receipts";
import { bsc10EnforcementEnabled } from "../src/core/bsc10-flag";
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

const PRODUCER = path.resolve(__dirname, "..", "scripts", "th-receipt-producer.mjs");

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

/** Write a producer private key (PKCS8 PEM) and return its absolute path. */
function writeProducerKey(paths: ProjectPaths, name: string, privateKey: KeyObject): string {
  const f = path.join(paths.stateDir, name);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.writeFileSync(f, privateKey.export({ type: "pkcs8", format: "pem" }));
  return f;
}

/**
 * Seal a SIGNED external GroundingReceipt line in-test (mirrors
 * `bsc10-external-grounding.test.ts:appendSignedExternalGrounding`).
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
 * Seal a SIGNED external DriverDimensionReceipt line in-test (mirrors
 * `bsc3-independence-control-flip.test.ts:appendSignedExternalDriver`), with an optional
 * `manifest_digest` field for chain_mismatch testing (I3).
 */
function appendSignedExternalDriver(
  paths: ProjectPaths,
  keyPair: { privateKey: KeyObject; publicKey: KeyObject },
  opts: { dimensionNames?: string[]; keyId?: string; manifest_digest?: string } = {},
): DriverDimensionReceipt {
  const evidenceRef = path
    .relative(paths.root, path.join(paths.stateDir, "verify-report.json"))
    .split(path.sep)
    .join("/");
  const names = opts.dimensionNames ?? ["tests-executed", "typecheck", "build"];
  const coord = currentReceiptSnapshotCoord(paths);
  const withPrev: Omit<DriverDimensionReceipt, "recordHash" | "signature"> = {
    kind: "driver-dimension",
    refId: coord.gitHead ?? "no-git",
    dimensions: names.map((name) => ({ name, observed: true as const, evidenceRef })),
    snapshot_coord: coord,
    producer_identity: "external:ci",
    producer_kind: "external",
    key_id: opts.keyId ?? externalKeyId(keyPair.publicKey),
    prevHash: readLastExternalDriverRecordHash(paths),
    ...(opts.manifest_digest !== undefined ? { manifest_digest: opts.manifest_digest } : {}),
  };
  const canonical = driverCanonicalText(withPrev);
  const signature = sign(null, Buffer.from(canonical, "utf8"), keyPair.privateKey).toString("base64");
  const recordHash = computeDriverRecordHash(withPrev);
  const sealed: DriverDimensionReceipt = { ...withPrev, signature, recordHash };
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.appendFileSync(externalDriverReceiptsPath(paths), JSON.stringify(sealed) + "\n", "utf8");
  return sealed;
}

/**
 * A fully-green final-verification project with has_ui:false (suppresses visual-hash force-rule)
 * and assertion-presence receipt (BSC-2 rung). BSC-10 grounding rung is the only lever.
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
    has_ui: false, // suppress UX force-rule
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

// ---------------------------------------------------------------------------
// E3 — control-flip independence (spawnSync over the real producer)
// ---------------------------------------------------------------------------

describe("E3 — BSC-10 independence control-flip (real accepted ↔ forged rejected)", () => {
  it("ARM A (real): the REAL producer mints an external grounding receipt the gate ACCEPTS (valid-grounded)", () => {
    // Independence proof: the REAL out-of-process producer (spawnSync) writes a signed
    // receipt to external-grounding-receipts.jsonl. We then verify:
    //   1. The producer exits 0 and emits ok:true (it ran correctly).
    //   2. The signed receipt file exists and was written by the producer.
    //   3. The receipt's signature verifies under K1 (the Ed25519 boundary IS the independence).
    //   4. readGroundingValidated classifies the PRODUCER'S ACTUAL receipt valid-grounded.
    //   5. The production-reality gate passes.
    //
    // The producer now emits conformance:[] (absent in report → default empty array) in the
    // {metric,observed,status} shape, so isValidGroundingReceipt accepts the line directly.
    // No in-test receipt helper — the gate sees only what the producer wrote.
    process.env.TH_BSC10_ENFORCE = "1";
    const paths = greenProject();
    setVerifierKey(paths, K1.publicKey);
    const privateKeyFile = writeProducerKey(paths, "k1-private.pem", K1.privateKey);

    // Write a grounding report (no conformance → producer writes conformance:[]).
    const reportPath = path.join(paths.stateDir, "grounding-report.json");
    fs.writeFileSync(
      reportPath,
      JSON.stringify({
        workClass: "integration",
        ground: { groundKind: "version-pin", pkg: "left-pad", version: "1.3.0" },
      }),
      "utf8",
    );

    // Step 1: run the real producer (out-of-process). Independence proof: the in-process
    // surface holds no private key; only the producer (via TH_RECEIPT_PRIVATE_KEYFILE) can
    // write an Ed25519-signed receipt to external-grounding-receipts.jsonl.
    const pubKeyFile = path.join(paths.stateDir, "grounding-public.pem");
    const spawnResult = spawnSync(
      "node",
      [PRODUCER, "--root", paths.root, "--kind", "grounding", "--grounding-report", path.relative(paths.root, reportPath)],
      {
        env: { ...process.env, TH_RECEIPT_PUBLIC_KEYFILE: pubKeyFile, TH_RECEIPT_PRIVATE_KEYFILE: privateKeyFile },
        encoding: "utf8",
      },
    );
    expect(spawnResult.status, `producer stderr: ${spawnResult.stderr as string}`).toBe(0);
    const producerOut = JSON.parse((spawnResult.stdout as string).trim());
    expect(producerOut.ok).toBe(true);
    expect(producerOut.producer_kind).toBe("external");

    // Step 2: the external file exists and the producer's line has a signature.
    const extFile = path.join(paths.stateDir, "external-grounding-receipts.jsonl");
    expect(fs.existsSync(extFile), "external-grounding-receipts.jsonl must exist after producer run").toBe(true);
    const producerLine = JSON.parse(fs.readFileSync(extFile, "utf8").trim().split("\n")[0]!);
    expect(producerLine.producer_kind).toBe("external");
    expect(typeof producerLine.signature).toBe("string");

    // Step 3+4: readGroundingValidated reads the PRODUCER'S ACTUAL receipt from the external
    // store and classifies it valid-grounded. No in-test helper receipt — the gate sees only
    // what the producer wrote. This is the genuine end-to-end independence proof.
    process.env.TH_RECEIPT_PUBLIC_KEYFILE = pubKeyFile;
    const validated = readGroundingValidated(paths);
    const entry = validated.byKind.get("version-pin");
    expect(entry).toBeDefined();
    expect(entry!.trustLabel).toBe("valid-grounded");

    // Step 5: the production-reality gate passes with both required kinds satisfied.
    appendGroundingReceipt(paths, {
      workClass: "integration",
      ground: {
        groundKind: "digest-manifest",
        manifestDigest: "sha256:aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
      },
      conformance: [{ metric: "api", observed: 0, status: "within-budget" }],
      producerIdentity: "test:runner",
    });
    const gate = checkProductionReality(paths, state(paths));
    expect(gate.ok).toBe(true);
  });

  it("ARM B1 (forged): SAME receipt signed with WRONG key ⇒ ungrounded ⇒ gate BLOCKS under enforce", () => {
    process.env.TH_BSC10_ENFORCE = "1";
    const paths = greenProject();
    setVerifierKey(paths, K1.publicKey); // verifier holds K1
    // Signed with K2 (wrong key) — key_id still claims K1 ⇒ signature verification fails.
    appendSignedExternalGrounding(paths, {
      ground: { groundKind: "version-pin", pkg: "left-pad", version: "1.3.0" },
      workClass: "integration",
      signWith: K2.privateKey,
      keyId: externalKeyId(K1.publicKey),
    });
    // Digest-manifest also required for integration — provide it in-process so only the
    // version-pin grounding status is the lever.
    appendGroundingReceipt(paths, {
      workClass: "integration",
      ground: {
        groundKind: "digest-manifest",
        manifestDigest: "sha256:aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
      },
      conformance: [{ metric: "api", observed: 0, status: "within-budget" }],
      producerIdentity: "test:runner",
    });

    // The unverifiable external receipt is IGNORED → version-pin is absent (ungrounded) → missing.
    const validated = readGroundingValidated(paths);
    expect(validated.byKind.get("version-pin")).toBeUndefined();

    const gate = checkProductionReality(paths, state(paths));
    expect(gate.ok).toBe(false);
    expect(gate.error).toBe("grounding_unverified");
    // version-pin is a deterministic kind ⇒ its absence BLOCKS under enforce (bsc10KindEnforced).
    expect((gate.detail as { reason?: string } | undefined)?.reason).toBe("missing");
  });

  it("ARM B2 (no-key): verifier key env UNSET ⇒ external receipt unprovable ⇒ ungrounded ⇒ BLOCKS", () => {
    process.env.TH_BSC10_ENFORCE = "1";
    const paths = greenProject();
    setVerifierKey(paths, K1.publicKey);
    appendSignedExternalGrounding(paths, {
      ground: { groundKind: "version-pin", pkg: "left-pad", version: "1.3.0" },
      workClass: "integration",
    });
    appendGroundingReceipt(paths, {
      workClass: "integration",
      ground: {
        groundKind: "digest-manifest",
        manifestDigest: "sha256:aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
      },
      conformance: [{ metric: "api", observed: 0, status: "within-budget" }],
      producerIdentity: "test:runner",
    });
    delete process.env.TH_RECEIPT_PUBLIC_KEYFILE; // no verifier key → cannot prove the signature

    const validated = readGroundingValidated(paths);
    expect(validated.byKind.get("version-pin")).toBeUndefined();

    const gate = checkProductionReality(paths, state(paths));
    expect(gate.ok).toBe(false);
    expect(gate.error).toBe("grounding_unverified");
  });
});

// ---------------------------------------------------------------------------
// E4 — 3-party budget authority + canonical match check
// ---------------------------------------------------------------------------

describe("E4 — 3-party budget authority (producer-signed budget ⇒ validGroundingBudgets verifies)", () => {
  it("E4 canonical match: producer budget canonical (JSON.stringify of fixed-order object) matches gate budget canonical (groundingBudgetCanonicalText)", () => {
    // CRITICAL INTEGRATION CHECK (plan §1d): if these two canonicals differ, a real
    // producer-signed budget will fail to verify at gate time and this test reds.
    // We construct the budget entry EXACTLY as the producer does (grounding.ts:982-993)
    // and compare its JSON.stringify to groundingBudgetCanonicalText of the same object.
    const coord = { gitHead: null, treeDigest: null };
    const keyId = externalKeyId(K1.publicKey);

    // Producer formula: insertion-order matches GROUNDING_BUDGET_CANONICAL_FIELD_ORDER
    const budgetEntry: Record<string, unknown> = {
      kind: "grounding-budget",
      workClass: "integration",
      groundKind: "digest-manifest",
      metric: "api",
      threshold: 10,
      snapshot_coord: coord,
      producer_kind: "external",
      key_id: keyId,
      prevHash: GENESIS_PREV_HASH,
    };
    const producerCanonical = JSON.stringify(budgetEntry);

    // Gate formula: groundingBudgetCanonicalText via siblingCanonicalText with GROUNDING_BUDGET_CANONICAL_FIELD_ORDER
    const budget: Omit<GroundingBudget, "signature" | "recordHash"> = {
      kind: "grounding-budget",
      workClass: "integration",
      groundKind: "digest-manifest",
      metric: "api",
      threshold: 10,
      snapshot_coord: coord,
      producer_kind: "external",
      key_id: keyId,
      prevHash: GENESIS_PREV_HASH,
    };
    const gateCanonical = groundingBudgetCanonicalText(budget);

    // If these don't match, E4 is an integration finding — report the byte diff to the lead.
    expect(
      producerCanonical,
      `E4 CANONICAL MISMATCH — producer canonical: ${producerCanonical}\ngate canonical: ${gateCanonical}`,
    ).toBe(gateCanonical);
  });

  it("E4 gate path: a producer-signed budget in the budget store is accepted by validGroundingBudgets", () => {
    // Build a budget entry signed with K1, write it to grounding-budgets.jsonl, then verify
    // that validGroundingBudgets returns it (meaning: gate canonical == producer canonical
    // AND the signature verifies).
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
        threshold: 10,
        snapshot_coord: coord,
        producer_kind: "external",
        key_id: keyId,
        prevHash: GENESIS_PREV_HASH,
      };

      // Producer signs over JSON.stringify (its canonical formula).
      const producerCanonical = JSON.stringify(budgetEntry);
      const signature = sign(null, Buffer.from(producerCanonical, "utf8"), K1.privateKey).toString("base64");
      const recordHash = hashContent(producerCanonical);
      const sealedBudget = { ...budgetEntry, signature, recordHash };

      fs.mkdirSync(paths.stateDir, { recursive: true });
      fs.appendFileSync(groundingBudgetsPath(paths), JSON.stringify(sealedBudget) + "\n", "utf8");

      const budgets = validGroundingBudgets(paths);
      const key = "integration::digest-manifest::api";
      expect(
        budgets.has(key),
        `validGroundingBudgets did not accept the budget under key '${key}'. ` +
          `If this fails, the producer canonical does NOT match the gate canonical — ` +
          `report byte diff: producer='${producerCanonical}' vs gate='${groundingBudgetCanonicalText(sealedBudget as unknown as Omit<GroundingBudget, "signature" | "recordHash">)}'`,
      ).toBe(true);
    } finally {
      tp2.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// M4 — unsigned/wrong-key budget|exception|carveout ⇒ exempts NOTHING
// ---------------------------------------------------------------------------

describe("M4 — unsigned/wrong-key budget proposal ⇒ inert (gate treats as over-budget, BLOCKS under enforce)", () => {
  it("M4: unsigned budget in grounding-budgets.jsonl ⇒ validGroundingBudgets returns empty map (exempts NOTHING)", () => {
    const tp2 = makeTempProject();
    try {
      const paths = tp2.paths;
      setVerifierKey(paths, K1.publicKey);

      const coord = currentReceiptSnapshotCoord(paths);
      const keyId = externalKeyId(K1.publicKey);

      // Budget with NO signature — producer_kind/key_id present but signature absent.
      const unsignedBudget = {
        kind: "grounding-budget",
        workClass: "integration",
        groundKind: "digest-manifest",
        metric: "api",
        threshold: 10,
        snapshot_coord: coord,
        producer_kind: "external",
        key_id: keyId,
        prevHash: GENESIS_PREV_HASH,
        // signature: deliberately absent
        recordHash: hashContent(
          JSON.stringify({
            kind: "grounding-budget",
            workClass: "integration",
            groundKind: "digest-manifest",
            metric: "api",
            threshold: 10,
            snapshot_coord: coord,
            producer_kind: "external",
            key_id: keyId,
            prevHash: GENESIS_PREV_HASH,
          }),
        ),
      };

      fs.mkdirSync(paths.stateDir, { recursive: true });
      fs.appendFileSync(groundingBudgetsPath(paths), JSON.stringify(unsignedBudget) + "\n", "utf8");

      // An unsigned budget (signature absent) does not verify ⇒ validGroundingBudgets returns empty.
      const budgets = validGroundingBudgets(paths);
      expect(budgets.size).toBe(0);
    } finally {
      tp2.cleanup();
    }
  });

  it("M4: wrong-key signed budget ⇒ validGroundingBudgets returns empty map", () => {
    const tp2 = makeTempProject();
    try {
      const paths = tp2.paths;
      setVerifierKey(paths, K1.publicKey); // verifier holds K1

      const coord = currentReceiptSnapshotCoord(paths);
      const keyId = externalKeyId(K1.publicKey);

      const budgetEntry: Record<string, unknown> = {
        kind: "grounding-budget",
        workClass: "integration",
        groundKind: "digest-manifest",
        metric: "api",
        threshold: 10,
        snapshot_coord: coord,
        producer_kind: "external",
        key_id: keyId,
        prevHash: GENESIS_PREV_HASH,
      };
      const producerCanonical = JSON.stringify(budgetEntry);
      // Sign with K2 (wrong key) but key_id claims K1 → verification fails.
      const signature = sign(null, Buffer.from(producerCanonical, "utf8"), K2.privateKey).toString("base64");
      const recordHash = hashContent(producerCanonical);
      const wrongKeySigned = { ...budgetEntry, signature, recordHash };

      fs.mkdirSync(paths.stateDir, { recursive: true });
      fs.appendFileSync(groundingBudgetsPath(paths), JSON.stringify(wrongKeySigned) + "\n", "utf8");

      const budgets = validGroundingBudgets(paths);
      expect(budgets.size).toBe(0);
    } finally {
      tp2.cleanup();
    }
  });

  it("M4: unsigned budget ⇒ gate treats required kind as over-budget ⇒ BLOCKS under enforce", () => {
    // The unsigned budget proposes a high threshold for 'api' on 'digest-manifest'.
    // Because unsigned budgets exempt NOTHING, the receipt's over-budget conformance still blocks.
    process.env.TH_BSC10_ENFORCE = "1";
    const paths = greenProject();
    setVerifierKey(paths, K1.publicKey);

    const coord = currentReceiptSnapshotCoord(paths);
    const keyId = externalKeyId(K1.publicKey);
    const budgetEntry = {
      kind: "grounding-budget",
      workClass: "integration",
      groundKind: "digest-manifest",
      metric: "api",
      threshold: 9999, // would exempt the 500-symbol-delta below if it were signed
      snapshot_coord: coord,
      producer_kind: "external",
      key_id: keyId,
      prevHash: GENESIS_PREV_HASH,
      recordHash: hashContent(
        JSON.stringify({
          kind: "grounding-budget",
          workClass: "integration",
          groundKind: "digest-manifest",
          metric: "api",
          threshold: 9999,
          snapshot_coord: coord,
          producer_kind: "external",
          key_id: keyId,
          prevHash: GENESIS_PREV_HASH,
        }),
      ),
      // signature absent — unsigned
    };
    fs.mkdirSync(paths.stateDir, { recursive: true });
    fs.appendFileSync(groundingBudgetsPath(paths), JSON.stringify(budgetEntry) + "\n", "utf8");

    // Over-budget digest-manifest receipt.
    appendGroundingReceipt(paths, {
      workClass: "integration",
      ground: { groundKind: "digest-manifest", manifestDigest: "sha256:aabb" },
      conformance: [{ metric: "api", observed: 500, status: "over-budget" }],
      producerIdentity: "test:runner",
    });
    appendGroundingReceipt(paths, {
      workClass: "integration",
      ground: { groundKind: "version-pin", pkg: "dep", version: "1.0.0" },
      conformance: [{ metric: "version", observed: "1.0.0", status: "within-budget" }],
      producerIdentity: "test:runner",
    });

    const gate = checkProductionReality(paths, state(paths));
    // Unsigned budget exempts NOTHING → over-budget still blocks.
    expect(gate.ok).toBe(false);
    expect(gate.error).toBe("grounding_unverified");
    expect((gate.detail as { reason?: string } | undefined)?.reason).toBe("over_budget");
  });
});

// ---------------------------------------------------------------------------
// I3 — chain_mismatch: threaded manifest_digest disagreement ⇒ FAIL under enforce
// ---------------------------------------------------------------------------

describe("I3 — chain_mismatch: threaded manifest_digest mismatch ⇒ FAIL; absent ⇒ back-compat PASS", () => {
  it("I3a: BSC-3 driver receipt carrying a MATCHING manifest_digest ⇒ no chain_mismatch ⇒ PASS", () => {
    process.env.TH_BSC10_ENFORCE = "1";
    const paths = greenProject();
    // Use a real verifier key so the external driver receipt verifies.
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

    // Thread the SAME manifest_digest through a BSC-3 driver receipt.
    appendSignedExternalDriver(paths, K1, { manifest_digest: manifestDigest });

    const gate = checkProductionReality(paths, state(paths));
    expect(gate.ok).toBe(true);
    expect(gate.error).toBeUndefined();
  });

  it("I3b: BSC-3 driver receipt carrying a DIFFERENT manifest_digest ⇒ chain_mismatch ⇒ FAIL under enforce", () => {
    process.env.TH_BSC10_ENFORCE = "1";
    const paths = greenProject();
    setVerifierKey(paths, K1.publicKey);

    const groundingDigest = "sha256:aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";
    const differentDigest = "sha256:deadbeef00000000000000000000000000000000000000000000000000000000";

    appendGroundingReceipt(paths, {
      workClass: "integration",
      ground: { groundKind: "digest-manifest", manifestDigest: groundingDigest },
      conformance: [{ metric: "api", observed: 0, status: "within-budget" }],
      producerIdentity: "test:runner",
    });
    appendGroundingReceipt(paths, {
      workClass: "integration",
      ground: { groundKind: "version-pin", pkg: "dep", version: "1.0.0" },
      conformance: [{ metric: "version", observed: "1.0.0", status: "within-budget" }],
      producerIdentity: "test:runner",
    });

    // Thread a DIFFERENT digest through the BSC-3 driver receipt — this is the chain_mismatch condition.
    appendSignedExternalDriver(paths, K1, { manifest_digest: differentDigest });

    const gate = checkProductionReality(paths, state(paths));
    // digest-manifest is a deterministic kind → chain_mismatch BLOCKS.
    expect(gate.ok).toBe(false);
    expect(gate.error).toBe("grounding_unverified");
    expect((gate.detail as { reason?: string } | undefined)?.reason).toBe("chain_mismatch");
  });

  it("I3c: absent manifest_digest on driver receipt (pre-BSC-10) ⇒ no chain_mismatch ⇒ back-compat PASS", () => {
    process.env.TH_BSC10_ENFORCE = "1";
    const paths = greenProject();
    setVerifierKey(paths, K1.publicKey);

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

    // Driver receipt WITHOUT manifest_digest (pre-BSC-10, additive-optional).
    appendSignedExternalDriver(paths, K1 /*, no manifest_digest */);

    const gate = checkProductionReality(paths, state(paths));
    // Absent threading ⇒ no chain_mismatch ⇒ PASS.
    expect(gate.ok).toBe(true);
    expect(gate.error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// I6 — per-kind enforce leg
// ---------------------------------------------------------------------------

describe("I6 — per-kind enforce: deterministic kinds BLOCK; visual-hash stays WARN", () => {
  it("I6a: digest-manifest missing under ENFORCE ⇒ BLOCK (deterministic kind)", () => {
    process.env.TH_BSC10_ENFORCE = "1";
    const paths = greenProject();
    // Only version-pin provided; digest-manifest absent (required for integration).
    appendGroundingReceipt(paths, {
      workClass: "integration",
      ground: { groundKind: "version-pin", pkg: "dep", version: "1.0.0" },
      conformance: [{ metric: "version", observed: "1.0.0", status: "within-budget" }],
      producerIdentity: "test:runner",
    });
    const gate = checkProductionReality(paths, state(paths));
    expect(gate.ok).toBe(false);
    expect(gate.error).toBe("grounding_unverified");
    expect((gate.detail as { reason?: string } | undefined)?.reason).toBe("missing");
  });

  it("I6b: version-pin missing under ENFORCE ⇒ BLOCK (deterministic kind)", () => {
    process.env.TH_BSC10_ENFORCE = "1";
    const paths = greenProject();
    // Only digest-manifest provided; version-pin absent.
    appendGroundingReceipt(paths, {
      workClass: "integration",
      ground: {
        groundKind: "digest-manifest",
        manifestDigest: "sha256:aabb",
      },
      conformance: [{ metric: "api", observed: 0, status: "within-budget" }],
      producerIdentity: "test:runner",
    });
    const gate = checkProductionReality(paths, state(paths));
    expect(gate.ok).toBe(false);
    expect(gate.error).toBe("grounding_unverified");
    expect((gate.detail as { reason?: string } | undefined)?.reason).toBe("missing");
  });

  it("I6c: visual-hash missing under ENFORCE ⇒ ok:true + non-blocking notice (per-kind WARN, M2)", () => {
    // Set up a project where visual-hash is the only offender (has_ui:true forces it for integration).
    process.env.TH_BSC10_ENFORCE = "1";
    tp = makeTempProject();
    const paths = tp.paths;
    writeFile(paths, "docs/01-requirements.md", "# Requirements\n\n- REQ-001\n");
    writeFile(paths, "docs/09-implementation-plan.md", "# Plan\n\nSLICE-0 covers REQ-001.\n");
    writeFile(paths, "tests/cov.test.ts", ASSERTED_COV_TEST);
    writeFile(paths, "docs/10-verification-report.md", "# Verification Report\n\nREQ-001 verified.\n");
    writeState(paths, {
      ...initialState(),
      tier: "T1",
      current_stage: "final-verification",
      implementation_allowed: true,
      has_ui: true, // ENABLE UX force-rule → visual-hash required for integration
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

    // Provide digest-manifest + version-pin (deterministic kinds satisfied); visual-hash absent.
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
    // visual-hash deliberately NOT provided.

    const st = readState(paths).state!;
    const gate = checkProductionReality(paths, st);
    // visual-hash is NOT in ENFORCED_GROUND_KINDS (Slice B per-kind WARN, M2) → non-blocking.
    expect(gate.ok).toBe(true);
    expect(gate.error).toBeUndefined();
    // Summary must expose the missing visual-hash as a non-blocking advisory.
    expect(Array.isArray(gate.grounding)).toBe(true);
    const vhEntry = (gate.grounding ?? []).find((g) => g.groundKind === "visual-hash");
    expect(vhEntry).toBeDefined();
    expect(vhEntry?.grounded).toBe(false);
    expect(vhEntry?.conformance).toBe("missing");
  });
});

// ---------------------------------------------------------------------------
// I7 — shipped BSC-1/3/4 receipts byte-stability under manifest_digest (additive-optional)
// ---------------------------------------------------------------------------

describe("I7 — manifest_digest additive-optional on BSC-1/3/7 receipts (omit-when-absent)", () => {
  it("I7a: computeDriverRecordHash stable when manifest_digest absent or undefined (byte-identical)", () => {
    // Mirrors bsc10-integration.test.ts I7 but verifies the Slice-B driver receipt shape
    // used in the I3 tests above also stays byte-stable when the field is absent.
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
    expect(computeDriverRecordHash(base)).toBe(computeDriverRecordHash(withUndefined));
  });

  it("I7b: manifest_digest present → different hash (tamper-evident once set)", () => {
    const evidenceRef = ".th-state/verify-report.json";
    const base: Omit<DriverDimensionReceipt, "recordHash"> = {
      kind: "driver-dimension",
      refId: "no-git",
      dimensions: [{ name: "tests-executed", observed: true, evidenceRef }],
      snapshot_coord: { gitHead: null, treeDigest: null },
      producer_identity: "test:runner",
      producer_kind: "external",
      key_id: externalKeyId(K1.publicKey),
      prevHash: GENESIS_PREV_HASH,
    };
    const withDigest = {
      ...base,
      manifest_digest: "sha256:deadbeef00000000000000000000000000000000000000000000000000000000",
    };
    expect(computeDriverRecordHash(base)).not.toBe(computeDriverRecordHash(withDigest));
  });
});

// ---------------------------------------------------------------------------
// U9 — env-leg table (bsc2-mirror polarity) + compiled-default leg
// (Duplicates the unit-test assertions here for probe-level confirmation in the
// Slice-B test file. The unit-test in bsc10-unit.test.ts is the canonical coverage.)
// ---------------------------------------------------------------------------

describe("U9 — bsc10EnforcementEnabled(): bsc2-mirror polarity confirmation", () => {
  const SAVED = process.env.TH_BSC10_ENFORCE;
  afterEach(() => {
    if (SAVED === undefined) delete process.env.TH_BSC10_ENFORCE;
    else process.env.TH_BSC10_ENFORCE = SAVED;
  });

  it.each([
    ["0", false],
    ["false", false],
    ["FALSE", false],
    ["  false  ", false],
    ["1", true],
    ["true", true],
    ["TRUE", true],
    ["yes", true],
    ["on", true],
    ["banana", true],
  ])("TH_BSC10_ENFORCE=%s ⇒ %s", (value, expected) => {
    process.env.TH_BSC10_ENFORCE = value;
    expect(bsc10EnforcementEnabled()).toBe(expected);
  });

  it("unset ⇒ false (Slice-B WARN compiled default)", () => {
    delete process.env.TH_BSC10_ENFORCE;
    expect(bsc10EnforcementEnabled()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// M-1 negative control: empty store is inert (absence ≠ forgery)
// A project with NO grounding receipts passes the gate under WARN default —
// the tamper-block path must not fire on an empty chain.
// ---------------------------------------------------------------------------

describe("M-1 negative — empty grounding store is inert", () => {
  it("WARN default + empty store (no receipts) ⇒ ok:true (absence ≠ forgery)", () => {
    delete process.env.TH_BSC10_ENFORCE;
    const paths = greenProject();
    // No receipts appended — verifyGroundingChain([]) ⇒ ok:true → evaluateGrounding:
    // no declared class → null → PASS. The tamper-block path must not fire here.
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(true);
    expect(res.error).toBeUndefined();
    expect(res.error).not.toBe("grounding_unverified");
  });
});

// ---------------------------------------------------------------------------
// M-2 external-chain integrity — reorder/duplicate breaks the external store
// (flag-gated, symmetric with in-process M-1; NOT unconditional)
//
// A validly-signed external receipt whose chain is broken by reordering or
// duplicating a line is detected by verifyGroundingChain(external). The entire
// external store is dropped — kind absent → gate evaluates as missing.
// Under ENFORCE the gate blocks (reason:'tampered'); under WARN it is non-blocking.
// Complement: a single validly-signed line (trivial genesis chain) still grades
// valid-grounded and passes — proving the reorder/dup is what breaks it, not
// the signature itself.
// ---------------------------------------------------------------------------

describe("M-2 external-chain integrity — reorder/dup breaks external store (flag-gated)", () => {
  it("complement: single valid external receipt ⇒ verifyGroundingChain ok + valid-grounded ⇒ gate PASS", () => {
    // Non-vacuity control: one correctly-chained external receipt passes.
    process.env.TH_BSC10_ENFORCE = "1";
    const paths = greenProject();
    setVerifierKey(paths, K1.publicKey);
    appendSignedExternalGrounding(paths, {
      ground: { groundKind: "version-pin", pkg: "left-pad", version: "1.3.0" },
      workClass: "integration",
    });

    // Chain must verify.
    const extPath = externalGroundingReceiptsPath(paths);
    const lines = fs.readFileSync(extPath, "utf8").trim().split("\n");
    const parsed = lines.map((l) => JSON.parse(l));
    expect(verifyGroundingChain(parsed).ok).toBe(true);

    // Gate classifies valid-grounded.
    const validated = readGroundingValidated(paths);
    expect(validated.byKind.get("version-pin")?.trustLabel).toBe("valid-grounded");

    // Gate PASS (add digest-manifest in-process so both required kinds are satisfied).
    appendGroundingReceipt(paths, {
      workClass: "integration",
      ground: {
        groundKind: "digest-manifest",
        manifestDigest: "sha256:aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
      },
      conformance: [{ metric: "api", observed: 0, status: "within-budget" }],
      producerIdentity: "test:runner",
    });
    expect(checkProductionReality(paths, state(paths)).ok).toBe(true);
  });

  it("ENFORCE + reordered external chain ⇒ verifyGroundingChain fails ⇒ store dropped ⇒ gate blocks (reason:'tampered')", () => {
    process.env.TH_BSC10_ENFORCE = "1";
    const paths = greenProject();
    setVerifierKey(paths, K1.publicKey);

    // Append two validly-signed receipts so there is a chain to reorder.
    appendSignedExternalGrounding(paths, {
      ground: { groundKind: "version-pin", pkg: "left-pad", version: "1.3.0" },
      workClass: "integration",
    });
    appendSignedExternalGrounding(paths, {
      ground: { groundKind: "version-pin", pkg: "left-pad", version: "1.3.0" },
      workClass: "integration",
    });

    // Reorder: swap the two lines → prevHash chain breaks.
    const extPath = externalGroundingReceiptsPath(paths);
    const lines = fs.readFileSync(extPath, "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
    fs.writeFileSync(extPath, [lines[1], lines[0]].join("\n") + "\n", "utf8");

    // verifyGroundingChain must detect the break.
    const parsed = fs.readFileSync(extPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(verifyGroundingChain(parsed).ok).toBe(false);

    // Gate blocks under ENFORCE.
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("grounding_unverified");
    expect((res.detail as { reason?: string } | undefined)?.reason).toBe("tampered");
  });

  it("WARN default + reordered external chain ⇒ non-blocking notice (ok:true, flag-gated)", () => {
    delete process.env.TH_BSC10_ENFORCE;
    const paths = greenProject();
    setVerifierKey(paths, K1.publicKey);

    appendSignedExternalGrounding(paths, {
      ground: { groundKind: "version-pin", pkg: "left-pad", version: "1.3.0" },
      workClass: "integration",
    });
    appendSignedExternalGrounding(paths, {
      ground: { groundKind: "version-pin", pkg: "left-pad", version: "1.3.0" },
      workClass: "integration",
    });

    // Reorder: swap lines → chain breaks.
    const extPath = externalGroundingReceiptsPath(paths);
    const lines = fs.readFileSync(extPath, "utf8").trim().split("\n");
    fs.writeFileSync(extPath, [lines[1], lines[0]].join("\n") + "\n", "utf8");

    // Under WARN the gate does NOT block.
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(true);
    expect(res.error).toBeUndefined();
  });

  it("ENFORCE + duplicated external receipt ⇒ verifyGroundingChain fails ⇒ store dropped ⇒ gate blocks (reason:'tampered')", () => {
    process.env.TH_BSC10_ENFORCE = "1";
    const paths = greenProject();
    setVerifierKey(paths, K1.publicKey);

    appendSignedExternalGrounding(paths, {
      ground: { groundKind: "version-pin", pkg: "left-pad", version: "1.3.0" },
      workClass: "integration",
    });

    // Duplicate: append the same line again → second line's prevHash ≠ expectedPrev.
    const extPath = externalGroundingReceiptsPath(paths);
    const line = fs.readFileSync(extPath, "utf8").trim();
    fs.appendFileSync(extPath, line + "\n", "utf8");

    const parsed = fs.readFileSync(extPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(verifyGroundingChain(parsed).ok).toBe(false);

    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("grounding_unverified");
    expect((res.detail as { reason?: string } | undefined)?.reason).toBe("tampered");
  });
});

