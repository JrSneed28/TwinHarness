/**
 * Axis-B slice-4a (BSC-3) — the verification-driver gate rung, end-to-end through
 * `checkProductionReality` at final-verification (Lane D, plan §6). This is the
 * integration surface: a project whose ENTIRE final-verification ladder is GREEN
 * except the BSC-3 driver-dimension rung, then we perturb exactly one driver
 * condition and assert the stable token / trust posture.
 *
 * Coverage:
 *   - GRANDFATHER (ABSENCE ≠ FORGERY): no driver receipt ⇒ PASS, empty dimensions.
 *   - block-on-claimed-unobserved: a recorded dimension the current report no longer
 *     evidences ⇒ `driver_dimension_unverified` reason "unobserved" (flag ON).
 *   - block-on-chain-tamper: an edited in-process chain ⇒ reason "chain".
 *   - block-on-forged-external: an external CLAIM whose signature does not verify ⇒
 *     reason "forged" + trustLabel "forged".
 *   - INDEPENDENCE (>0): a properly external-signed receipt ⇒ trustLabel
 *     "valid-grounded" (accepted); the SAME bytes with a broken signature ⇒ "forged"
 *     (BLOCK). Proven with an EPHEMERAL test keypair, mirroring slice-1b/3b.
 *   - FLAG TOGGLES (the fail-open guard for Lane B): with `TH_BSC3_ENFORCE=0` a
 *     would-be block becomes a non-blocking NOTICE (token unchanged, `dimensions`
 *     still attached); flag ON it BLOCKS.
 *   - observability: `dimensions` rides on the result whether PASS or BLOCK.
 *
 * The driver receipt's recomputable GROUND is `verify-report.json` (NEVER
 * tester-record.json). The fixture writes a bare report so the sensor reads a real
 * artifact; because the fixture has NO verify CONFIG, the `production_verify_not_green`
 * rung is vacuously green and the BSC-3 rung is the only remaining lever.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { makeTempProject, mintRequiredApprovals, type TempProject } from "./helpers";
import { writeState, readState } from "../src/core/state-store";
import { initialState, type TwinHarnessState } from "../src/core/state-schema";
import { runArtifactRegister } from "../src/commands/artifact";
import { runTesterRecord } from "../src/commands/tester";
import { checkProductionReality } from "../src/core/gate-preconditions";
import { writeVerifyReport, type VerifyReport } from "../src/core/verify";
import { externalKeyId } from "../src/core/receipt-signing";
import {
  appendDriverReceipt,
  driverReceiptsPath,
  externalDriverReceiptsPath,
  driverCanonicalText,
  computeDriverRecordHash,
  readLastExternalDriverRecordHash,
} from "../src/core/verification-driver";
import { currentReceiptSnapshotCoord } from "../src/core/receipts";
import type { DriverDimensionReceipt } from "../src/core/receipts";
import type { ProjectPaths } from "../src/core/paths";

const SAVED_PUBLIC_KEYFILE = process.env.TH_RECEIPT_PUBLIC_KEYFILE;
const SAVED_BSC3_ENFORCE = process.env.TH_BSC3_ENFORCE;
let tp: TempProject | undefined;

afterEach(() => {
  if (SAVED_PUBLIC_KEYFILE === undefined) delete process.env.TH_RECEIPT_PUBLIC_KEYFILE;
  else process.env.TH_RECEIPT_PUBLIC_KEYFILE = SAVED_PUBLIC_KEYFILE;
  if (SAVED_BSC3_ENFORCE === undefined) delete process.env.TH_BSC3_ENFORCE;
  else process.env.TH_BSC3_ENFORCE = SAVED_BSC3_ENFORCE;
  tp?.cleanup();
  tp = undefined;
});

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
 * A project whose entire final-verification ladder is GREEN except the BSC-3 rung:
 * slices settled, no verify CONFIG (vacuously green), coverage clean, report
 * registered, Tester record attached, required approvals minted, no dist/ — PLUS a
 * bare verify-report.json so the driver SENSOR has a real artifact to bind to. The
 * caller then perturbs exactly one driver condition.
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
  expect(runArtifactRegister(paths, "docs/10-verification-report.md", 1).ok).toBe(true);
  expect(runTesterRecord(paths, { driver: "cli-e2e", provider: "sandbox", passed: true }).ok).toBe(true);
  mintRequiredApprovals(paths, state(paths));
  // The driver SENSOR's recomputable ground (NEVER tester-record.json).
  writeVerifyReport(paths, reportObservingAll());
  return paths;
}

/**
 * Seal a SIGNED external DriverDimensionReceipt line directly (the producer's formula,
 * in-test) so a scenario can control the bytes. `tamper` mutates the sealed object
 * AFTER signing. Mirrors `appendSignedExternal` in receipts-external-asymmetry.test.ts.
 */
function appendSignedExternalDriver(
  paths: ProjectPaths,
  keyPair: { privateKey: KeyObject; publicKey: KeyObject },
  opts: { dimensionNames?: string[]; keyId?: string } = {},
  tamper?: (sealed: DriverDimensionReceipt) => DriverDimensionReceipt,
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
  let sealed: DriverDimensionReceipt = { ...withPrev, signature, recordHash };
  if (tamper) sealed = tamper(sealed);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.appendFileSync(externalDriverReceiptsPath(paths), JSON.stringify(sealed) + "\n", "utf8");
  return sealed;
}

/** Install the verifier's public key and point the env at it. */
function setVerifierKey(paths: ProjectPaths, publicKey: KeyObject): void {
  const f = path.join(paths.stateDir, "driver-public.pem");
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.writeFileSync(f, publicKey.export({ type: "spki", format: "pem" }));
  process.env.TH_RECEIPT_PUBLIC_KEYFILE = f;
}

// ---------------------------------------------------------------------------
// GRANDFATHER — ABSENCE ≠ FORGERY
// ---------------------------------------------------------------------------

describe("BSC-3 gate — ABSENCE is grandfathered (no receipt ⇒ bare PASS, no dimensions field)", () => {
  it("a green run with NO driver receipt PASSES, even with enforcement ON", () => {
    delete process.env.TH_BSC3_ENFORCE; // defaults ON
    const paths = greenAtFinalVerification();
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(true);
    // An empty observation summary conveys nothing, so a clean grandfathered PASS carries
    // NO `dimensions` field — preserving the `{ ok: true }` contract every rung composes.
    expect(res.dimensions).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// BLOCK — claimed-but-unobserved, chain tamper (flag ON)
// ---------------------------------------------------------------------------

describe("BSC-3 gate — blocks a claimed-but-unobserved dimension at final-verification (flag ON)", () => {
  it("a recorded dimension the CURRENT report no longer evidences ⇒ driver_dimension_unverified (unobserved)", () => {
    delete process.env.TH_BSC3_ENFORCE;
    const paths = greenAtFinalVerification();
    // Mint a clean in-process receipt that observed all three.
    appendDriverReceipt(paths, { producerIdentity: "runner" });
    // Now rewrite the report so it no longer observes `build` — the recorded claim no
    // longer corresponds to a real run (the negative-control, detectable at the gate).
    writeVerifyReport(paths, {
      ok: true,
      ranAt: new Date().toISOString(),
      results: [
        { command: "vitest run", exitCode: 0, ok: true, durationMs: 1, outputTail: "" },
        { command: "tsc --noEmit", exitCode: 0, ok: true, durationMs: 1, outputTail: "" },
      ],
    });
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("driver_dimension_unverified");
    expect(res.detail!.reason).toBe("unobserved");
    // The `dimensions` summary still rides on the block (observability), build now false.
    const build = res.dimensions!.find((d) => d.name === "build");
    expect(build).toMatchObject({ observed: false, trustLabel: "valid" });
  });

  it("an EDITED in-process chain ⇒ driver_dimension_unverified (chain)", () => {
    delete process.env.TH_BSC3_ENFORCE;
    const paths = greenAtFinalVerification();
    const r = appendDriverReceipt(paths, { producerIdentity: "runner" });
    // Tamper the persisted line so recordHash no longer matches its canonical text.
    const tampered = { ...r, producer_identity: "attacker" };
    fs.writeFileSync(driverReceiptsPath(paths), JSON.stringify(tampered) + "\n", "utf8");
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("driver_dimension_unverified");
    expect(res.detail!.reason).toBe("chain");
  });
});

// ---------------------------------------------------------------------------
// INDEPENDENCE (>0) — external-signed accepted; forged rejected
// ---------------------------------------------------------------------------

describe("BSC-3 gate — INDEPENDENCE: external-signed accepted (valid-grounded), forged rejected (forged)", () => {
  it("a properly external-signed receipt ⇒ trustLabel valid-grounded ⇒ ACCEPTED", () => {
    delete process.env.TH_BSC3_ENFORCE;
    const paths = greenAtFinalVerification();
    setVerifierKey(paths, K1.publicKey);
    appendSignedExternalDriver(paths, K1);
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(true);
    // The independence property: the grounded label is reachable ONLY via a verifying
    // signature the in-process surface cannot forge.
    expect(res.dimensions!.length).toBeGreaterThan(0);
    for (const d of res.dimensions!) expect(d.trustLabel).toBe("valid-grounded");
  });

  it("the SAME receipt with a BROKEN signature but still CLAIMING external ⇒ forged ⇒ BLOCK", () => {
    delete process.env.TH_BSC3_ENFORCE;
    const paths = greenAtFinalVerification();
    setVerifierKey(paths, K1.publicKey);
    // Sign with K1 (well-formed) then flip one base64 char — claims external, fails verify.
    appendSignedExternalDriver(paths, K1, {}, (sealed) => {
      const sig = sealed.signature!;
      const c = sig[0] === "a" ? "b" : "a";
      return { ...sealed, signature: c + sig.slice(1) };
    });
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("driver_dimension_unverified");
    expect(res.detail!.reason).toBe("forged");
    for (const d of res.dimensions!) expect(d.trustLabel).toBe("forged");
  });

  it("WRONG KEY: external receipt signed with K2 while the loaded key is K1 ⇒ forged ⇒ BLOCK", () => {
    delete process.env.TH_BSC3_ENFORCE;
    const paths = greenAtFinalVerification();
    setVerifierKey(paths, K1.publicKey);
    appendSignedExternalDriver(paths, K2); // signed by a key the verifier does not hold
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.detail!.reason).toBe("forged");
  });

  it("KEY ABSENT (env unset): an external CLAIM is unprovable ⇒ forged ⇒ BLOCK", () => {
    delete process.env.TH_BSC3_ENFORCE;
    const paths = greenAtFinalVerification();
    setVerifierKey(paths, K1.publicKey);
    appendSignedExternalDriver(paths, K1);
    delete process.env.TH_RECEIPT_PUBLIC_KEYFILE; // no key to verify with
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.detail!.reason).toBe("forged");
  });
});

// ---------------------------------------------------------------------------
// FLAG TOGGLES — the fail-open guard for Lane B's flag (defaults ON)
// ---------------------------------------------------------------------------

describe("BSC-3 gate — enforcement flag governs ENFORCEMENT only, never observation", () => {
  it("flag OFF (TH_BSC3_ENFORCE=0): a would-be FORGED block becomes a non-blocking NOTICE (token unchanged)", () => {
    process.env.TH_BSC3_ENFORCE = "0";
    const paths = greenAtFinalVerification();
    setVerifierKey(paths, K1.publicKey);
    appendSignedExternalDriver(paths, K2); // forged (wrong key)
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(true); // NOT blocked
    expect(res.notice).toBeDefined();
    expect(res.notice!.token).toBe("driver_dimension_unverified");
    expect(res.notice!.detail!.reason).toBe("forged");
    // Observability is unconditional: dimensions still attached under flag-OFF.
    expect(res.dimensions!.length).toBeGreaterThan(0);
    for (const d of res.dimensions!) expect(d.trustLabel).toBe("forged");
  });

  it("flag ON (default, env unset): the SAME forged receipt BLOCKS", () => {
    delete process.env.TH_BSC3_ENFORCE;
    const paths = greenAtFinalVerification();
    setVerifierKey(paths, K1.publicKey);
    appendSignedExternalDriver(paths, K2); // forged
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("driver_dimension_unverified");
  });

  it("flag value 'false' (case-insensitive) also disables enforcement; 'true'/typo keep it ON (fail-closed)", () => {
    const paths = greenAtFinalVerification();
    setVerifierKey(paths, K1.publicKey);
    appendSignedExternalDriver(paths, K2); // forged

    process.env.TH_BSC3_ENFORCE = "FALSE";
    expect(checkProductionReality(paths, state(paths)).ok).toBe(true); // disabled

    process.env.TH_BSC3_ENFORCE = "true";
    expect(checkProductionReality(paths, state(paths)).ok).toBe(false); // ON

    process.env.TH_BSC3_ENFORCE = "yes-please"; // unrecognized ⇒ fail-closed ON
    expect(checkProductionReality(paths, state(paths)).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Stage-aware no-op + clean accepted in-process receipt
// ---------------------------------------------------------------------------

describe("BSC-3 gate — clean in-process receipt accepted; pre-final is a no-op", () => {
  it("a clean in-process receipt (valid) is ACCEPTED with trustLabel valid", () => {
    delete process.env.TH_BSC3_ENFORCE;
    const paths = greenAtFinalVerification();
    appendDriverReceipt(paths, { producerIdentity: "runner" });
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(true);
    expect(res.dimensions!.length).toBe(3);
    for (const d of res.dimensions!) expect(d).toMatchObject({ observed: true, trustLabel: "valid" });
  });

  it("pre-final-verification: the BSC-3 rung is a no-op even with a forged receipt present", () => {
    delete process.env.TH_BSC3_ENFORCE;
    const paths = greenAtFinalVerification();
    setVerifierKey(paths, K1.publicKey);
    appendSignedExternalDriver(paths, K2); // forged
    writeState(paths, { ...state(paths), current_stage: "implementation-planning" });
    expect(checkProductionReality(paths, state(paths))).toEqual({ ok: true });
  });
});
