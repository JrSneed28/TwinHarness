/**
 * BSC-2 / Axis-B slice-6 — the assertion-presence production-reality rung (Lane C).
 *
 * The completion gate counts a REQ "tested" on anchor presence in a recognized test file, even
 * when that file carries NO non-trivial assertion (an empty `it()`, a smoke test, a tautology).
 * This rung (`checkAssertionPresence`, composed LAST inside `checkProductionReality`) closes that
 * gap. These tests pin Lane C's surface directly:
 *
 *   - WARN (flag OFF): an assertion-free / no-receipt run does NOT block — it attaches a
 *     non-blocking `notice` + the per-REQ `assertionPresence` observability summary.
 *   - ENFORCE (flag ON): the SAME red conditions BLOCK with the stable tokens
 *     `assertion_unobserved` (no receipt) / `assertion_presence_unverified` (an assertion-free
 *     offender, or a tampered/stale/mismatched receipt) / `mutation_kill_forged`.
 *   - The signed, path/digest-scoped WAIVER (negative-control d): an unsigned / wrong-key /
 *     digest-mismatched / over-broad waiver exempts NOTHING; a valid signed waiver exempts its REQ.
 *   - MutationKillReceipt gate acceptance: a signature-verified controlled-runner receipt grounds
 *     efficacy (`valid-grounded`); a forged one BLOCKS; absent is a no-op.
 *   - The observability summary trust labels (honesty): a 2a-only REQ is `valid`/`attested-presence`,
 *     NEVER `valid-grounded` (reserved for a verified MutationKillReceipt).
 *
 * Strategy mirrors production-reality.test.ts: build a project whose ENTIRE final-verification
 * ladder is green and the ONLY remaining lever is the assertion-presence rung, then force the
 * enforce flag explicitly (the probe + tests force either leg regardless of the compiled default).
 */

import { describe, it, expect, afterEach } from "vitest";
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
import {
  computeAssertionPresenceGround,
  assertionGroundDigest,
  assertionWaiverCanonicalText,
  computeAssertionWaiverRecordHash,
  readLastExternalAssertionWaiverRecordHash,
  assertionWaiversPath,
  mutationKillCanonicalText,
  computeMutationKillRecordHash,
  externalMutationReceiptsPath,
  type AssertionWaiver,
  type MutationKillReceipt,
} from "../src/core/assertion-presence";
import { externalKeyId } from "../src/core/receipt-signing";
import { currentReceiptSnapshotCoord } from "../src/core/receipts";
import type { ProjectPaths } from "../src/core/paths";

const SAVED_PUBLIC_KEYFILE = process.env.TH_RECEIPT_PUBLIC_KEYFILE;
const SAVED_BSC2 = process.env.TH_BSC2_ENFORCE;
let tp: TempProject | undefined;

afterEach(() => {
  if (SAVED_PUBLIC_KEYFILE === undefined) delete process.env.TH_RECEIPT_PUBLIC_KEYFILE;
  else process.env.TH_RECEIPT_PUBLIC_KEYFILE = SAVED_PUBLIC_KEYFILE;
  if (SAVED_BSC2 === undefined) delete process.env.TH_BSC2_ENFORCE;
  else process.env.TH_BSC2_ENFORCE = SAVED_BSC2;
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

/** Install the verifier's public key and return its absolute path. */
function setVerifierKey(paths: ProjectPaths, publicKey: KeyObject): string {
  const f = path.join(paths.stateDir, "verifier.pub");
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.writeFileSync(f, publicKey.export({ type: "spki", format: "pem" }));
  process.env.TH_RECEIPT_PUBLIC_KEYFILE = f;
  return f;
}

/**
 * Seal a SIGNED external assertion-waiver line directly (the producer's formula, in-test) so a
 * negative scenario can control the bytes precisely. `tamper` mutates the sealed object AFTER
 * signing. The recordHash + signature are computed over the IDENTICAL canonical input.
 */
function appendSignedWaiver(
  paths: ProjectPaths,
  fields: { reqId: string; groundDigest: string; keyPair: { privateKey: KeyObject; publicKey: KeyObject }; keyId?: string },
  tamper?: (sealed: AssertionWaiver) => AssertionWaiver,
): AssertionWaiver {
  const withPrev: Omit<AssertionWaiver, "recordHash" | "signature"> = {
    kind: "assertion-waiver",
    reqId: fields.reqId,
    groundDigest: fields.groundDigest,
    snapshot_coord: currentReceiptSnapshotCoord(paths),
    producer_kind: "external",
    key_id: fields.keyId ?? externalKeyId(fields.keyPair.publicKey),
    prevHash: readLastExternalAssertionWaiverRecordHash(paths),
  };
  const signature = sign(null, Buffer.from(assertionWaiverCanonicalText(withPrev), "utf8"), fields.keyPair.privateKey).toString("base64");
  const recordHash = computeAssertionWaiverRecordHash(withPrev);
  let sealed: AssertionWaiver = { ...withPrev, signature, recordHash };
  if (tamper) sealed = tamper(sealed);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.appendFileSync(assertionWaiversPath(paths), JSON.stringify(sealed) + "\n", "utf8");
  return sealed;
}

/** The CURRENT single-REQ ground digest the waiver must bind (re-derivable, path/digest-scoped). */
function reqGroundDigest(paths: ProjectPaths, reqId: string): string {
  const summary = computeAssertionPresenceGround(paths).find((s) => s.reqId === reqId)!;
  return assertionGroundDigest([summary]);
}

/** Seal a SIGNED external mutation-kill receipt line directly (the controlled-runner formula). */
function appendSignedMutationKill(
  paths: ProjectPaths,
  fields: { keyPair: { privateKey: KeyObject; publicKey: KeyObject }; keyId?: string; score?: number },
  tamper?: (sealed: MutationKillReceipt) => MutationKillReceipt,
): MutationKillReceipt {
  // prevHash seed: GENESIS for the first (and only) line in the external mutation store.
  const seeded: Omit<MutationKillReceipt, "recordHash" | "signature"> = {
    kind: "mutation-kill",
    refId: currentReceiptSnapshotCoord(paths).gitHead ?? "no-git",
    ground: { mutants_generated: 10, mutants_killed: 9, mutants_survived: 1, score: fields.score ?? 0.9, scope: "src/core/hash.ts" },
    snapshot_coord: currentReceiptSnapshotCoord(paths),
    producer_kind: "controlled-runner",
    key_id: fields.keyId ?? externalKeyId(fields.keyPair.publicKey),
    prevHash: GENESIS,
  };
  const signature = sign(null, Buffer.from(mutationKillCanonicalText(seeded), "utf8"), fields.keyPair.privateKey).toString("base64");
  const recordHash = computeMutationKillRecordHash(seeded);
  let sealed: MutationKillReceipt = { ...seeded, signature, recordHash };
  if (tamper) sealed = tamper(sealed);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.appendFileSync(externalMutationReceiptsPath(paths), JSON.stringify(sealed) + "\n", "utf8");
  return sealed;
}

const GENESIS = "0".repeat(64);

/**
 * A project GREEN at final-verification with a tested REQ-001. By default `withReceipt` mints the
 * F8-bound assertion-presence receipt and `asserted` gives REQ-001 a non-trivial assertion, so a
 * bare call is fully green (the assertion rung PASSes). Callers flip those to red exactly one lever.
 */
function greenAtFinal(opts: { asserted?: boolean; withReceipt?: boolean } = {}): ProjectPaths {
  const asserted = opts.asserted ?? true;
  const withReceipt = opts.withReceipt ?? true;
  tp = makeTempProject();
  const paths = tp.paths;
  writeFile(paths, "docs/01-requirements.md", "# Requirements\n\n- REQ-001 the only requirement.\n");
  writeFile(paths, "docs/09-implementation-plan.md", "# Plan\n\nSLICE-0 covers REQ-001.\n");
  // REQ-001's test file: a real non-trivial assertion (green) or a bare comment (assertion-free).
  writeFile(paths, "tests/cov.test.ts", asserted ? ASSERTED_COV_TEST : "// REQ-001 verified here\n");
  writeFile(paths, "docs/10-verification-report.md", "# Verification Report\n\nREQ-001 verified.\n");
  writeState(paths, {
    ...initialState(),
    tier: "T1",
    current_stage: "final-verification",
    implementation_allowed: true,
    slices: [{ id: "SLICE-0", status: "done", components: [] }],
  });
  expect(runArtifactRegister(paths, "docs/10-verification-report.md", 1).ok).toBe(true);
  expect(runTesterRecord(paths, { driver: "cli-e2e", passed: true }).ok).toBe(true);
  mintRequiredApprovals(paths, state(paths));
  if (withReceipt) mintAssertionPresenceForFixture(paths); // LAST — after every tests/** write
  return paths;
}

describe("BSC-2 rung — WARN phase (flag OFF) observes but never blocks", () => {
  it("an assertion-free offender with no receipt does NOT block in WARN; attaches notice + summary", () => {
    delete process.env.TH_BSC2_ENFORCE; // default OFF in commit 1
    const paths = greenAtFinal({ asserted: false, withReceipt: false });
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(true); // WARN never blocks
    expect(res.notice?.token).toBe("assertion_unobserved");
    expect(res.assertionPresence).toBeDefined();
    const req = res.assertionPresence!.find((s) => s.reqId === "REQ-001")!;
    expect(req.assertionFree).toBe(true);
    expect(req.nonTrivialAssertions).toBe(0);
  });

  it("an explicit TH_BSC2_ENFORCE=1 forces ENFORCE even in the warn (default-OFF) build", () => {
    process.env.TH_BSC2_ENFORCE = "1";
    const paths = greenAtFinal({ asserted: false, withReceipt: false });
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("assertion_unobserved");
    expect(res.assertionPresence).toBeDefined();
  });
});

describe("BSC-2 rung — ENFORCE phase blocks each red condition with a distinct token", () => {
  it("a fully-asserted REQ with a fresh receipt PASSES (the non-vacuous green baseline)", () => {
    process.env.TH_BSC2_ENFORCE = "1";
    const paths = greenAtFinal();
    expect(checkProductionReality(paths, state(paths))).toEqual({ ok: true });
  });

  it("no receipt at all (tested REQ present) → assertion_unobserved", () => {
    process.env.TH_BSC2_ENFORCE = "1";
    const paths = greenAtFinal({ withReceipt: false });
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("assertion_unobserved");
  });

  it("an assertion-free offender WITH a fresh receipt → assertion_presence_unverified (offenders named)", () => {
    process.env.TH_BSC2_ENFORCE = "1";
    const paths = greenAtFinal({ asserted: false }); // receipt minted over the assertion-free ground
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("assertion_presence_unverified");
    expect(res.detail!.offenders).toContain("REQ-001");
  });

  it("a target_mismatch receipt (test files edited after recording) → assertion_presence_unverified", () => {
    process.env.TH_BSC2_ENFORCE = "1";
    const paths = greenAtFinal(); // receipt minted over the asserted ground
    // Edit the test file AFTER minting → the recomputed ground digest diverges.
    writeFile(paths, "tests/cov.test.ts", ASSERTED_COV_TEST + '\nit("more", () => { expect(2 + 2).toBe(4); });\n');
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("assertion_presence_unverified");
    expect(res.detail!.contentStatus).toBe("target_mismatch");
  });

  it("a tampered receipt chain → assertion_presence_unverified (contentStatus chain)", () => {
    process.env.TH_BSC2_ENFORCE = "1";
    const paths = greenAtFinal();
    // Corrupt the receipt store (flip a byte in the recorded ground) → chain walk breaks.
    const store = path.join(paths.stateDir, "assertion-presence-receipts.jsonl");
    const line = JSON.parse(fs.readFileSync(store, "utf8").trim());
    line.producer_identity = "tampered";
    fs.writeFileSync(store, JSON.stringify(line) + "\n", "utf8");
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("assertion_presence_unverified");
    expect(res.detail!.contentStatus).toBe("chain");
  });
});

describe("BSC-2 waiver — signed, path/digest-scoped escape (negative-control d)", () => {
  it("a VALID signed waiver over the REQ's current digest exempts the offender (ENFORCE PASSES)", () => {
    process.env.TH_BSC2_ENFORCE = "1";
    const paths = greenAtFinal({ asserted: false }); // REQ-001 is an offender
    const kp = generateKeyPairSync("ed25519");
    setVerifierKey(paths, kp.publicKey);
    appendSignedWaiver(paths, { reqId: "REQ-001", groundDigest: reqGroundDigest(paths, "REQ-001"), keyPair: kp });
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(true); // the offender is waived
    const req = res.assertionPresence?.find((s) => s.reqId === "REQ-001");
    expect(req?.waived).toBe(true);
  });

  it("an UNSIGNED waiver exempts NOTHING (still blocks)", () => {
    process.env.TH_BSC2_ENFORCE = "1";
    const paths = greenAtFinal({ asserted: false });
    const kp = generateKeyPairSync("ed25519");
    setVerifierKey(paths, kp.publicKey);
    appendSignedWaiver(paths, { reqId: "REQ-001", groundDigest: reqGroundDigest(paths, "REQ-001"), keyPair: kp }, (s) => {
      const { signature, ...noSig } = s;
      return noSig as AssertionWaiver; // strip the signature trailer
    });
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("assertion_presence_unverified");
  });

  it("a WRONG-KEY waiver (signed by a key the verifier does not trust) exempts NOTHING", () => {
    process.env.TH_BSC2_ENFORCE = "1";
    const paths = greenAtFinal({ asserted: false });
    const trusted = generateKeyPairSync("ed25519");
    const attacker = generateKeyPairSync("ed25519");
    setVerifierKey(paths, trusted.publicKey); // verifier trusts `trusted` only
    // Signed by the attacker but claims the trusted key_id → signature fails to verify.
    appendSignedWaiver(paths, {
      reqId: "REQ-001",
      groundDigest: reqGroundDigest(paths, "REQ-001"),
      keyPair: attacker,
      keyId: externalKeyId(trusted.publicKey),
    });
    expect(checkProductionReality(paths, state(paths)).error).toBe("assertion_presence_unverified");
  });

  it("a DIGEST-MISMATCHED waiver (REQ's test files changed since signing) exempts NOTHING", () => {
    process.env.TH_BSC2_ENFORCE = "1";
    const paths = greenAtFinal({ asserted: false });
    const kp = generateKeyPairSync("ed25519");
    setVerifierKey(paths, kp.publicKey);
    // Sign over a STALE digest (a different, no-longer-current ground).
    appendSignedWaiver(paths, { reqId: "REQ-001", groundDigest: GENESIS, keyPair: kp });
    expect(checkProductionReality(paths, state(paths)).error).toBe("assertion_presence_unverified");
  });

  it("with NO verifier key loaded, even a well-formed signed waiver exempts NOTHING (fail-closed)", () => {
    process.env.TH_BSC2_ENFORCE = "1";
    delete process.env.TH_RECEIPT_PUBLIC_KEYFILE; // no key ⇒ nothing verifies
    const paths = greenAtFinal({ asserted: false });
    const kp = generateKeyPairSync("ed25519");
    appendSignedWaiver(paths, { reqId: "REQ-001", groundDigest: reqGroundDigest(paths, "REQ-001"), keyPair: kp });
    expect(checkProductionReality(paths, state(paths)).error).toBe("assertion_presence_unverified");
  });
});

describe("BSC-2 MutationKill gate acceptance (the 2b independence hook)", () => {
  it("a signature-verified MutationKillReceipt grounds efficacy → trust label valid-grounded, gate PASSES even with an offender", () => {
    process.env.TH_BSC2_ENFORCE = "1";
    const paths = greenAtFinal({ asserted: false, withReceipt: false }); // an offender, no presence receipt
    const kp = generateKeyPairSync("ed25519");
    setVerifierKey(paths, kp.publicKey);
    appendSignedMutationKill(paths, { keyPair: kp });
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(true); // efficacy-grounded clears the 2a presence gap
    expect(res.assertionPresence?.every((s) => s.trustLabel === "valid-grounded")).toBe(true);
  });

  it("a FORGED MutationKillReceipt (no verifying signature) → mutation_kill_forged BLOCK", () => {
    process.env.TH_BSC2_ENFORCE = "1";
    const paths = greenAtFinal(); // otherwise fully green
    const kp = generateKeyPairSync("ed25519");
    setVerifierKey(paths, kp.publicKey);
    // Sign, then tamper the score AFTER signing → signature no longer verifies → forged.
    appendSignedMutationKill(paths, { keyPair: kp }, (s) => ({ ...s, ground: { ...s.ground, score: 0.1 } }));
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("mutation_kill_forged");
  });

  it("an ABSENT MutationKillReceipt is a no-op (the common 2a path; a 2a-only REQ is NEVER valid-grounded)", () => {
    process.env.TH_BSC2_ENFORCE = "1";
    const paths = greenAtFinal(); // green via 2a presence only
    const res = checkProductionReality(paths, state(paths));
    expect(res).toEqual({ ok: true }); // fully clean ⇒ bare PASS (no summary ride-up)
  });
});
