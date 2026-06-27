/**
 * Axis-B slice-6 2b (BSC-2) — the INDEPENDENCE control-flip.
 *
 * BSC-2 independence ("a mutation-efficacy proof the agent cannot forge") is a NUMBER: it is
 * > 0 iff a producer-signed external `MutationKillReceipt` is ACCEPTED while the SAME claim forged
 * on the in-process surface is REJECTED. This file demonstrates that number is now > 0 by driving
 * BOTH arms through the REAL gate (`checkProductionReality`) AND the REAL out-of-process producer
 * (`scripts/th-receipt-producer.mjs --kind mutation-kill`) so neither arm is vacuous:
 *
 *   - Arm A (real, accepted): an external Ed25519-signed `MutationKillReceipt` minted by the REAL
 *     producer from a controlled CI job's mutation report classifies `valid-grounded`; the gate
 *     records the MODULE-scoped `mutationEfficacy` signal — and crucially does NOT pass-override an
 *     assertion-presence offender (efficacy is scope-only; presence ≠ efficacy, review HIGH).
 *   - Arm B (forged, rejected): an in-process-forged line (valid shape, `producer_kind:
 *     "controlled-runner"`, but signed with a WRONG key — the in-process surface holds no trusted
 *     key) classifies `forged`; the gate BLOCKs with `mutation_kill_forged` in enforce.
 *   - Arm C (absent): no mutation receipt ⇒ `absent`, a no-op on this path (the common 2a run).
 *
 * The independence property is SIGNATURE-PROVENANCE only, over a bounded single-module mutation
 * `scope`: it proves the receipt was not forged in-process, NOT that the suite kills every fault.
 *
 * The keypair is generated IN-TEST (PKCS8 private + SPKI public written to temp keyfiles,
 * `TH_RECEIPT_PRIVATE_KEYFILE` + `TH_RECEIPT_PUBLIC_KEYFILE`), so the suite is deterministic on CI
 * (which has no real key). Enforcement is forced ON explicitly (`TH_BSC2_ENFORCE=1`). All
 * `TH_RECEIPT_*` + `TH_BSC2_ENFORCE` env restored in afterEach.
 *
 * Deterministic + Windows-safe (path.join, no shell). Fixtures mirror bsc2-assertion-gate.test.ts
 * and bsc3-independence-control-flip.test.ts.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
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
import {
  readMutationKillValidated,
  externalMutationReceiptsPath,
  mutationKillCanonicalText,
  computeMutationKillRecordHash,
  readLastExternalMutationRecordHash,
  type MutationKillReceipt,
} from "../src/core/assertion-presence";
import { externalKeyId } from "../src/core/receipt-signing";
import { currentReceiptSnapshotCoord } from "../src/core/receipts";
import type { ProjectPaths } from "../src/core/paths";

const SAVED_PUBLIC_KEYFILE = process.env.TH_RECEIPT_PUBLIC_KEYFILE;
const SAVED_PRIVATE_KEYFILE = process.env.TH_RECEIPT_PRIVATE_KEYFILE;
const SAVED_BSC2 = process.env.TH_BSC2_ENFORCE;
let tp: TempProject | undefined;

afterEach(() => {
  if (SAVED_PUBLIC_KEYFILE === undefined) delete process.env.TH_RECEIPT_PUBLIC_KEYFILE;
  else process.env.TH_RECEIPT_PUBLIC_KEYFILE = SAVED_PUBLIC_KEYFILE;
  if (SAVED_PRIVATE_KEYFILE === undefined) delete process.env.TH_RECEIPT_PRIVATE_KEYFILE;
  else process.env.TH_RECEIPT_PRIVATE_KEYFILE = SAVED_PRIVATE_KEYFILE;
  if (SAVED_BSC2 === undefined) delete process.env.TH_BSC2_ENFORCE;
  else process.env.TH_BSC2_ENFORCE = SAVED_BSC2;
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

/** Install the verifier's public key (SPKI PEM) and point the env at it. */
function setVerifierKey(paths: ProjectPaths, publicKey: KeyObject): string {
  const f = path.join(paths.stateDir, "verifier.pub");
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.writeFileSync(f, publicKey.export({ type: "spki", format: "pem" }));
  process.env.TH_RECEIPT_PUBLIC_KEYFILE = f;
  return f;
}

/** Write a producer private key (PKCS8 PEM) and return its absolute path. */
function writeProducerKey(paths: ProjectPaths, name: string, privateKey: KeyObject): string {
  const f = path.join(paths.stateDir, name);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.writeFileSync(f, privateKey.export({ type: "pkcs8", format: "pem" }));
  return f;
}

/** Write a synthetic controlled-runner mutation report (the canonical minimal shape). */
function writeMutationReport(paths: ProjectPaths, scope: string): string {
  const f = path.join(paths.stateDir, "mutation-report.json");
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.writeFileSync(
    f,
    JSON.stringify({ mutants_generated: 50, mutants_killed: 48, mutants_survived: 2, score: 0.96, scope }),
    "utf8",
  );
  return f;
}

/**
 * Seal a SIGNED external MutationKillReceipt line directly (the producer's formula, in-test) so a
 * forged-arm scenario can control the key. Mirrors `appendSignedMutationKill` in
 * bsc2-assertion-gate.test.ts; the recordHash + signature are computed over the IDENTICAL bytes.
 */
function appendSignedMutationKill(
  paths: ProjectPaths,
  keyPair: { privateKey: KeyObject; publicKey: KeyObject },
  opts: { scope?: string; keyId?: string } = {},
): MutationKillReceipt {
  const coord = currentReceiptSnapshotCoord(paths);
  const withPrev: Omit<MutationKillReceipt, "recordHash" | "signature"> = {
    kind: "mutation-kill",
    refId: coord.gitHead ?? "no-git",
    ground: { mutants_generated: 50, mutants_killed: 48, mutants_survived: 2, score: 0.96, scope: opts.scope ?? "src/core/hash.ts" },
    snapshot_coord: coord,
    producer_kind: "controlled-runner",
    key_id: opts.keyId ?? externalKeyId(keyPair.publicKey),
    prevHash: readLastExternalMutationRecordHash(paths),
  };
  const canonical = mutationKillCanonicalText(withPrev);
  const signature = sign(null, Buffer.from(canonical, "utf8"), keyPair.privateKey).toString("base64");
  const recordHash = computeMutationKillRecordHash(withPrev);
  const sealed: MutationKillReceipt = { ...withPrev, signature, recordHash };
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.appendFileSync(externalMutationReceiptsPath(paths), JSON.stringify(sealed) + "\n", "utf8");
  return sealed;
}

/**
 * A project GREEN at final-verification with a tested REQ-001. `asserted` gives REQ-001 a
 * non-trivial assertion (so the presence rung PASSes); when false REQ-001 is an assertion-free
 * offender. `withReceipt` mints the F8-bound in-process presence receipt. Mirrors
 * bsc2-assertion-gate.test.ts:greenAtFinal.
 */
function greenAtFinal(opts: { asserted?: boolean; withReceipt?: boolean } = {}): ProjectPaths {
  const asserted = opts.asserted ?? true;
  const withReceipt = opts.withReceipt ?? true;
  tp = makeTempProject();
  const paths = tp.paths;
  writeFile(paths, "docs/01-requirements.md", "# Requirements\n\n- REQ-001 the only requirement.\n");
  writeFile(paths, "docs/09-implementation-plan.md", "# Plan\n\nSLICE-0 covers REQ-001.\n");
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

// ===========================================================================
// THE CONTROL-FLIP: BSC-2 independence > 0 — both arms non-vacuous, one file.
// ===========================================================================
describe("BSC-2 slice-6 2b — independence control-flip (real accepted ↔ forged rejected)", () => {
  it("ARM A (real): the REAL producer mints an external MutationKillReceipt the validator ACCEPTS (valid-grounded)", () => {
    process.env.TH_BSC2_ENFORCE = "1";
    const paths = greenAtFinal(); // fully green via 2a presence
    const verifierKeyFile = setVerifierKey(paths, K1.publicKey); // verifier holds K1
    const privateKeyFile = writeProducerKey(paths, "k1-private.pem", K1.privateKey);
    const reportFile = writeMutationReport(paths, "src/core/hash.ts");

    // The genuine external producer (OUT of process — the in-process surface holds no key) signs
    // the mutation-kill receipt over a controlled CI job's mutation report.
    const res = spawnSync(
      "node",
      [PRODUCER, "--root", paths.root, "--kind", "mutation-kill", "--mutation-report", reportFile],
      {
        env: {
          ...process.env,
          TH_RECEIPT_PUBLIC_KEYFILE: verifierKeyFile,
          TH_RECEIPT_PRIVATE_KEYFILE: privateKeyFile,
        },
        encoding: "utf8",
      },
    );
    expect(res.status, res.stderr as string).toBe(0);
    const out = JSON.parse((res.stdout as string).trim());
    expect(out.ok).toBe(true);
    expect(out.kind).toBe("mutation-kill");
    expect(out.producer_kind).toBe("controlled-runner");
    expect(out.scope).toBe("src/core/hash.ts");

    // EXACTLY one signed line landed in the EXTERNAL store.
    const lines = fs.readFileSync(externalMutationReceiptsPath(paths), "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(1);

    // The in-process validator (which holds only the verify-only public key) classifies it
    // valid-grounded — the Ed25519 signature the in-process surface cannot forge IS the independence.
    const validated = readMutationKillValidated(paths);
    expect(validated.status).toBe("valid-grounded");
    expect(validated.receipt!.ground.scope).toBe("src/core/hash.ts");

    // Drive the REAL gate: the module-scoped efficacy signal rides up as a DISTINCT observability axis.
    const gate = checkProductionReality(paths, state(paths));
    expect(gate.ok).toBe(true); // green on its OWN 2a presence merits
    expect(gate.mutationEfficacy).toEqual({ status: "valid-grounded", scope: "src/core/hash.ts", score: 0.96 });
    // Per-REQ presence labels stay presence-only — efficacy is NEVER propagated onto them.
    expect(gate.assertionPresence?.every((s) => s.trustLabel === "valid" || s.trustLabel === "attested-presence")).toBe(true);
  });

  it("ARM A (scope-only no-override): a valid-grounded receipt does NOT pass-override an assertion-presence offender — still BLOCKs", () => {
    process.env.TH_BSC2_ENFORCE = "1";
    // REQ-001 is an assertion-free offender WITH a fresh presence receipt (so the only failing
    // lever is the offender), and the mutation scope is an UNRELATED module.
    const paths = greenAtFinal({ asserted: false });
    const verifierKeyFile = setVerifierKey(paths, K1.publicKey);
    const privateKeyFile = writeProducerKey(paths, "k1-private.pem", K1.privateKey);
    const reportFile = writeMutationReport(paths, "src/core/hash.ts"); // NOT REQ-001's module

    const res = spawnSync(
      "node",
      [PRODUCER, "--root", paths.root, "--kind", "mutation-kill", "--mutation-report", reportFile],
      {
        env: { ...process.env, TH_RECEIPT_PUBLIC_KEYFILE: verifierKeyFile, TH_RECEIPT_PRIVATE_KEYFILE: privateKeyFile },
        encoding: "utf8",
      },
    );
    expect(res.status, res.stderr as string).toBe(0);
    expect(readMutationKillValidated(paths).status).toBe("valid-grounded");

    const gate = checkProductionReality(paths, state(paths));
    expect(gate.ok).toBe(false); // presence ≠ efficacy: the module-scoped spike cannot excuse REQ-001
    expect(gate.error).toBe("assertion_presence_unverified");
    expect((gate.detail!.offenders as string[])).toContain("REQ-001");
    // The efficacy signal is STILL recorded as a distinct axis on the BLOCK (did not override).
    expect(gate.mutationEfficacy).toEqual({ status: "valid-grounded", scope: "src/core/hash.ts", score: 0.96 });
  });

  it("ARM B (forged): an in-process-forged line signed with a WRONG key is REJECTED (forged) and BLOCKs", () => {
    process.env.TH_BSC2_ENFORCE = "1";
    const paths = greenAtFinal(); // otherwise fully green
    setVerifierKey(paths, K1.publicKey); // verifier holds K1
    appendSignedMutationKill(paths, K2); // forged in-process: signed with the WRONG key K2

    expect(readMutationKillValidated(paths).status).toBe("forged");

    const gate = checkProductionReality(paths, state(paths));
    expect(gate.ok).toBe(false);
    expect(gate.error).toBe("mutation_kill_forged");
  });

  it("ARM B variant: a genuine K1-signed line with the verifier key env UNSET → forged → BLOCK", () => {
    process.env.TH_BSC2_ENFORCE = "1";
    const paths = greenAtFinal();
    setVerifierKey(paths, K1.publicKey);
    appendSignedMutationKill(paths, K1); // genuine K1 signature
    delete process.env.TH_RECEIPT_PUBLIC_KEYFILE; // no key to verify with → unprovable

    expect(readMutationKillValidated(paths).status).toBe("forged");

    const gate = checkProductionReality(paths, state(paths));
    expect(gate.ok).toBe(false);
    expect(gate.error).toBe("mutation_kill_forged");
  });

  it("ARM C (absent): no mutation receipt ⇒ absent, a no-op on this path (fully-clean bare PASS)", () => {
    process.env.TH_BSC2_ENFORCE = "1";
    const paths = greenAtFinal(); // green via 2a presence only, no mutation receipt
    expect(readMutationKillValidated(paths).status).toBe("absent");
    expect(checkProductionReality(paths, state(paths))).toEqual({ ok: true });
  });

  // REFUSE-AT-CREATION: a controlled report whose ground is out-of-bounds / count-inconsistent
  // is refused BEFORE any line is signed/written (the gate validator only checks finiteness, so
  // the producer must reject a phantom efficacy signal here). Each case mints NOTHING.
  for (const bad of [
    { name: "score out of range (> 1)", report: { mutants_generated: 50, mutants_killed: 48, mutants_survived: 2, score: 7, scope: "src/core/hash.ts" } },
    { name: "killed + survived exceeds generated", report: { mutants_generated: 10, mutants_killed: 9, mutants_survived: 5, score: 0.9, scope: "src/core/hash.ts" } },
    { name: "negative count", report: { mutants_generated: 50, mutants_killed: -1, mutants_survived: 2, score: 0.9, scope: "src/core/hash.ts" } },
  ]) {
    it(`REFUSE: ${bad.name} \u2192 nonzero exit, no line written`, () => {
      process.env.TH_BSC2_ENFORCE = "1";
      const paths = greenAtFinal();
      const verifierKeyFile = setVerifierKey(paths, K1.publicKey);
      const privateKeyFile = writeProducerKey(paths, "k1-private.pem", K1.privateKey);
      const reportFile = path.join(paths.stateDir, "bad-report.json");
      fs.mkdirSync(paths.stateDir, { recursive: true });
      fs.writeFileSync(reportFile, JSON.stringify(bad.report), "utf8");

      const res = spawnSync(
        "node",
        [PRODUCER, "--root", paths.root, "--kind", "mutation-kill", "--mutation-report", reportFile],
        { env: { ...process.env, TH_RECEIPT_PUBLIC_KEYFILE: verifierKeyFile, TH_RECEIPT_PRIVATE_KEYFILE: privateKeyFile }, encoding: "utf8" },
      );
      expect(res.status).not.toBe(0);
      expect(fs.existsSync(externalMutationReceiptsPath(paths))).toBe(false);
      expect(readMutationKillValidated(paths).status).toBe("absent");
    });
  }
});
