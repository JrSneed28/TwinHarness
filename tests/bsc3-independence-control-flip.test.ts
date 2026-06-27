/**
 * Axis-B slice-4b (BSC-3) — the INDEPENDENCE control-flip.
 *
 * BSC-3 independence ("verification dimensions the agent cannot forge") is a NUMBER: it is
 * > 0 iff a producer-signed external driver receipt is ACCEPTED while the SAME receipt forged
 * on the in-process surface is REJECTED. This file demonstrates that number is now > 0 by
 * asserting BOTH arms through the REAL gate (`checkProductionReality`) so neither is vacuous:
 *
 *   - Arm A (real, accepted): an external Ed25519-signed `DriverDimensionReceipt` minted by the
 *     REAL out-of-process producer (`scripts/th-receipt-producer.mjs --kind driver`) classifies
 *     `valid-grounded`; the production-reality gate at final-verification PASSES.
 *   - Arm B (forged, rejected): in a FRESH fixture, (b1) the SAME receipt signed with a WRONG
 *     key, and (b2) a genuine K1-signed external line but with the public key env UNSET, both
 *     classify `forged`; the gate BLOCKS with `driver_dimension_unverified` / reason "forged".
 *
 * The keypair is generated IN-TEST (PKCS8 private + SPKI public written to temp keyfiles,
 * `TH_RECEIPT_PRIVATE_KEYFILE` + `TH_RECEIPT_PUBLIC_KEYFILE`), so the suite is deterministic on
 * CI (which has no real key). Enforcement defaults ON (TH_BSC3_ENFORCE unset). All `TH_RECEIPT_*`
 * + `TH_BSC3_ENFORCE` env restored in afterEach.
 *
 * Deterministic + Windows-safe (path.join, no shell). Fixtures mirror bsc3-driver-gate.test.ts.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { makeTempProject, mintRequiredApprovals, mintAssertionPresenceForFixture, ASSERTED_COV_TEST, type TempProject } from "./helpers";
import { writeState, readState } from "../src/core/state-store";
import { initialState, type TwinHarnessState } from "../src/core/state-schema";
import { runArtifactRegister } from "../src/commands/artifact";
import { runTesterRecord } from "../src/commands/tester";
import { checkProductionReality } from "../src/core/gate-preconditions";
import { writeVerifyReport, type VerifyReport } from "../src/core/verify";
import { externalKeyId } from "../src/core/receipt-signing";
import {
  externalDriverReceiptsPath,
  driverCanonicalText,
  computeDriverRecordHash,
  readLastExternalDriverRecordHash,
} from "../src/core/verification-driver";
import { currentReceiptSnapshotCoord } from "../src/core/receipts";
import type { DriverDimensionReceipt } from "../src/core/receipts";
import type { ProjectPaths } from "../src/core/paths";

const SAVED_PUBLIC_KEYFILE = process.env.TH_RECEIPT_PUBLIC_KEYFILE;
const SAVED_PRIVATE_KEYFILE = process.env.TH_RECEIPT_PRIVATE_KEYFILE;
const SAVED_BSC3_ENFORCE = process.env.TH_BSC3_ENFORCE;
let tp: TempProject | undefined;

afterEach(() => {
  if (SAVED_PUBLIC_KEYFILE === undefined) delete process.env.TH_RECEIPT_PUBLIC_KEYFILE;
  else process.env.TH_RECEIPT_PUBLIC_KEYFILE = SAVED_PUBLIC_KEYFILE;
  if (SAVED_PRIVATE_KEYFILE === undefined) delete process.env.TH_RECEIPT_PRIVATE_KEYFILE;
  else process.env.TH_RECEIPT_PRIVATE_KEYFILE = SAVED_PRIVATE_KEYFILE;
  if (SAVED_BSC3_ENFORCE === undefined) delete process.env.TH_BSC3_ENFORCE;
  else process.env.TH_BSC3_ENFORCE = SAVED_BSC3_ENFORCE;
  tp?.cleanup();
  tp = undefined;
});

const PRODUCER = path.resolve(__dirname, "..", "scripts", "th-receipt-producer.mjs");

const K1 = generateKeyPairSync("ed25519");
const K2 = generateKeyPairSync("ed25519");

function writeFile(paths: ProjectPaths, rel: string, body: string): void {
  const abs = path.resolve(paths.root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, "utf8");
}

function state(paths: ProjectPaths): TwinHarnessState {
  return readState(paths).state!;
}

/** A verify report observing all three seed dimensions (the runner exercised them). */
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

/**
 * A project whose entire final-verification ladder is GREEN except the BSC-3 rung: slices
 * settled, no verify CONFIG (vacuously green), report registered, Tester record attached,
 * required approvals minted, PLUS a verify-report.json so the driver sensor has a real
 * artifact. Mirrors `tests/bsc3-driver-gate.test.ts:greenAtFinalVerification`.
 */
function greenAtFinalVerification(): ProjectPaths {
  tp = makeTempProject();
  const paths = tp.paths;
  writeFile(paths, "docs/01-requirements.md", "# Requirements\n\n- REQ-001 the only requirement.\n");
  writeFile(paths, "docs/09-implementation-plan.md", "# Plan\n\nSLICE-0 covers REQ-001.\n");
  // BSC-2 slice-6: REQ-001's test file carries a NON-TRIVIAL assertion (was a bare comment).
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
  // BSC-2 slice-6: mint the F8-bound assertion-presence receipt LAST (after every tests/** write).
  mintAssertionPresenceForFixture(paths);
  writeVerifyReport(paths, reportObservingAll());
  return paths;
}

/** Install the verifier's public key (SPKI PEM) and point the env at it. */
function setVerifierKey(paths: ProjectPaths, publicKey: KeyObject): void {
  const f = path.join(paths.stateDir, "driver-public.pem");
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
 * Seal a SIGNED external DriverDimensionReceipt line directly (the producer's formula, in-test)
 * so a forged-arm scenario can control the key. Mirrors `appendSignedExternalDriver` in
 * `tests/bsc3-driver-gate.test.ts`.
 */
function appendSignedExternalDriver(
  paths: ProjectPaths,
  keyPair: { privateKey: KeyObject; publicKey: KeyObject },
  opts: { dimensionNames?: string[]; keyId?: string } = {},
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
  };
  const canonical = driverCanonicalText(withPrev);
  const signature = sign(null, Buffer.from(canonical, "utf8"), keyPair.privateKey).toString("base64");
  const recordHash = computeDriverRecordHash(withPrev);
  const sealed: DriverDimensionReceipt = { ...withPrev, signature, recordHash };
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.appendFileSync(externalDriverReceiptsPath(paths), JSON.stringify(sealed) + "\n", "utf8");
  return sealed;
}

// ===========================================================================
// THE CONTROL-FLIP: BSC-3 independence > 0 — both arms non-vacuous, one file.
// ===========================================================================
describe("BSC-3 slice-4b — independence control-flip (real accepted ↔ forged rejected)", () => {
  it("ARM A (real): the REAL producer mints an external driver receipt the gate ACCEPTS (valid-grounded)", () => {
    delete process.env.TH_BSC3_ENFORCE; // enforcement ON by default
    const paths = greenAtFinalVerification();
    const publicKeyFile = path.join(paths.stateDir, "driver-public.pem");
    fs.writeFileSync(publicKeyFile, K1.publicKey.export({ type: "spki", format: "pem" }));
    process.env.TH_RECEIPT_PUBLIC_KEYFILE = publicKeyFile;
    const privateKeyFile = writeProducerKey(paths, "k1-private.pem", K1.privateKey);

    // The genuine external producer (OUT of process) signs the driver receipt.
    const res = spawnSync(
      "node",
      [PRODUCER, "--root", paths.root, "--kind", "driver"],
      {
        env: {
          ...process.env,
          TH_RECEIPT_PUBLIC_KEYFILE: publicKeyFile,
          TH_RECEIPT_PRIVATE_KEYFILE: privateKeyFile,
        },
        encoding: "utf8",
      },
    );
    expect(res.status, res.stderr as string).toBe(0);
    const out = JSON.parse((res.stdout as string).trim());
    expect(out.ok).toBe(true);
    expect(out.producer_kind).toBe("external");

    // The external keyed receipt is INDEPENDENTLY grounded (the in-process surface cannot forge
    // the Ed25519 signature — that delta IS the BSC-3 independence property).
    const gate = checkProductionReality(paths, state(paths));
    expect(gate.ok).toBe(true);
    expect(gate.dimensions!.length).toBeGreaterThan(0);
    for (const d of gate.dimensions!) expect(d.trustLabel).toBe("valid-grounded");
  });

  it("ARM B (forged): the SAME receipt signed with a WRONG key is REJECTED (forged) and BLOCKS", () => {
    delete process.env.TH_BSC3_ENFORCE;
    const paths = greenAtFinalVerification();
    setVerifierKey(paths, K1.publicKey); // verifier holds K1
    appendSignedExternalDriver(paths, K2); // signed with the WRONG key K2

    const gate = checkProductionReality(paths, state(paths));
    expect(gate.ok).toBe(false);
    expect(gate.error).toBe("driver_dimension_unverified");
    expect(gate.detail!.reason).toBe("forged");
    for (const d of gate.dimensions!) expect(d.trustLabel).toBe("forged");
  });

  it("ARM B variant: a genuine K1-signed external line with the verifier key env UNSET → forged → BLOCK", () => {
    delete process.env.TH_BSC3_ENFORCE;
    const paths = greenAtFinalVerification();
    setVerifierKey(paths, K1.publicKey);
    appendSignedExternalDriver(paths, K1); // genuine K1 signature
    delete process.env.TH_RECEIPT_PUBLIC_KEYFILE; // no key to verify with → unprovable

    const gate = checkProductionReality(paths, state(paths));
    expect(gate.ok).toBe(false);
    expect(gate.error).toBe("driver_dimension_unverified");
    expect(gate.detail!.reason).toBe("forged");
    for (const d of gate.dimensions!) expect(d.trustLabel).toBe("forged");
  });
});
