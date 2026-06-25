/**
 * BSC-9 (Axis-B slice-7) — the INDEPENDENCE control-flip, demonstrated end-to-end through the
 * REAL external Ed25519 verification path + the REAL completion gate. This is the proof BSC-9
 * independence is a NUMBER > 0 (SIGNATURE-PROVENANCE independence only — the scored judgment is
 * still agent-authored; the external producer proves the readiness receipt was not forged
 * in-process, NOT that the judgment is independent):
 *
 *   ARM A — ACCEPTED (valid-grounded): an external InterviewReadinessReceipt signed with the
 *     verifier's REAL Ed25519 PRIVATE key; the gate re-derives the canonical text, VERIFIES the
 *     signature against the loaded PUBLIC key, and ACCEPTS it as `valid-grounded` ⇒ the BSC-9
 *     readiness leg PASSES.
 *   ARM B — REJECTED (forged): the SAME bytes signed in-process with a DIFFERENT key (the closest
 *     the in-process surface gets WITHOUT the private key) does NOT verify ⇒ `forged` ⇒ the gate
 *     BLOCKS with `bsc9_unverified`.
 *
 * NON-VACUOUS: both arms share the identical fixture, identical refId, identical readiness ground
 * — the ONLY difference is signature provenance (a verifying signature from the real key vs a
 * non-verifying one from a wrong key). The `valid-grounded` label is reachable ONLY via a
 * signature the in-process surface cannot forge — that delta IS the independence property. CI-safe:
 * both keypairs are generated in-test; no committed key material.
 *
 * Run:  npx vitest run .omc/audit/probes/bsc9/independence.test.ts
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { makeTempProject, mintRequiredApprovals, mintAssertionPresenceForFixture, ASSERTED_COV_TEST, type TempProject } from "../../../../tests/helpers";
import { writeState, readState } from "../../../../src/core/state-store";
import { initialState, type TwinHarnessState } from "../../../../src/core/state-schema";
import { runArtifactRegister } from "../../../../src/commands/artifact";
import { runTesterRecord } from "../../../../src/commands/tester";
import { checkProductionReality } from "../../../../src/core/gate-preconditions";
import { externalKeyId } from "../../../../src/core/receipt-signing";
import { currentReceiptSnapshotCoord, computeTargetDigest } from "../../../../src/core/receipts";
import {
  type InterviewReadinessReceipt,
  externalReadinessReceiptsPath,
  readinessCanonicalText,
  computeReadinessRecordHash,
  readLastExternalReadinessRecordHash,
  readReadinessReceiptValidated,
  readinessRefId,
  computeReadinessGround,
} from "../../../../src/core/interview-readiness";
import type { ProjectPaths } from "../../../../src/core/paths";

const SAVED_PUBLIC = process.env.TH_RECEIPT_PUBLIC_KEYFILE;
const SAVED_BSC9 = process.env.TH_BSC9_ENFORCE;
const K1 = generateKeyPairSync("ed25519"); // the verifier's key (the real producer holds K1 private)
const K2 = generateKeyPairSync("ed25519"); // the forger's key (never matches the verifier)
let tp: TempProject | undefined;

afterEach(() => {
  if (SAVED_PUBLIC === undefined) delete process.env.TH_RECEIPT_PUBLIC_KEYFILE;
  else process.env.TH_RECEIPT_PUBLIC_KEYFILE = SAVED_PUBLIC;
  if (SAVED_BSC9 === undefined) delete process.env.TH_BSC9_ENFORCE;
  else process.env.TH_BSC9_ENFORCE = SAVED_BSC9;
  tp?.cleanup();
  tp = undefined;
});

function state(paths: ProjectPaths): TwinHarnessState {
  return readState(paths).state!;
}

const write = (paths: ProjectPaths, rel: string, body: string) => {
  const abs = path.resolve(paths.root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, "utf8");
};

function setVerifierKey(paths: ProjectPaths, publicKey: KeyObject): string {
  const f = path.join(paths.stateDir, "readiness-public.pem");
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.writeFileSync(f, publicKey.export({ type: "spki", format: "pem" }));
  process.env.TH_RECEIPT_PUBLIC_KEYFILE = f;
  return f;
}

const STORE = ".twinharness/interview.json";

/** Append an external-claiming readiness line signed by `keyPair` (K1 = real, K2 = forged). */
function appendExternalReadiness(paths: ProjectPaths, keyPair: { privateKey: KeyObject; publicKey: KeyObject }): void {
  const digest = computeTargetDigest(paths.root, STORE)!;
  const withPrev: Omit<InterviewReadinessReceipt, "recordHash" | "signature"> = {
    kind: "interview-readiness",
    refId: readinessRefId(paths),
    ground: computeReadinessGround(0.95, 0.8),
    store_coord: { path: STORE, digest },
    snapshot_coord: currentReceiptSnapshotCoord(paths),
    producer_identity: "external:readiness-producer",
    producer_kind: "external",
    key_id: externalKeyId(keyPair.publicKey),
    prevHash: readLastExternalReadinessRecordHash(paths),
  };
  const signature = sign(null, Buffer.from(readinessCanonicalText(withPrev), "utf8"), keyPair.privateKey).toString("base64");
  const recordHash = computeReadinessRecordHash(withPrev);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.appendFileSync(externalReadinessReceiptsPath(paths), JSON.stringify({ ...withPrev, signature, recordHash }) + "\n", "utf8");
}

/** Green-at-final-verification, interview required + asserted ready, NO in-process readiness receipt. */
function greenExceptReadiness(): ProjectPaths {
  tp = makeTempProject();
  const paths = tp.paths;
  write(paths, "docs/01-requirements.md", "# Requirements\n\n- REQ-001 the only requirement.\n");
  write(paths, "docs/09-implementation-plan.md", "# Plan\n\nSLICE-0 covers REQ-001.\n");
  write(paths, "tests/cov.test.ts", `// REQ-001\n${ASSERTED_COV_TEST}`);
  write(paths, "docs/10-verification-report.md", "# Verification Report\n\nREQ-001 verified.\n");
  write(
    paths,
    STORE,
    JSON.stringify({ idea: "x", cutoff: 0.8, rounds: [{ question: "q", answer: "a", scores: { goal: 1, constraints: 1, criteria: 1 }, confidence: 0.95, entities: [] }], confidence: 0.95, status: "in-progress" }, null, 2) + "\n",
  );
  // A faithful single-fixture set so the projection leg is clean (isolate the readiness leg).
  write(
    paths,
    ".omc/audit/probes/bsc9/projection-fixtures.json",
    JSON.stringify({ fixtures: [{ tool: "th_doctor", result: { ok: true, exitCode: 0 }, projected: { isError: false, text: "OK", structuredContent: { exitCode: 0 } } }] }, null, 2),
  );
  writeState(paths, {
    ...initialState(),
    tier: "T1",
    current_stage: "final-verification",
    implementation_allowed: true,
    interview_required: true,
    slices: [{ id: "SLICE-0", status: "done", components: [] }],
  });
  runArtifactRegister(paths, "docs/10-verification-report.md", 1);
  runTesterRecord(paths, { driver: "cli-e2e", provider: "sandbox", passed: true });
  mintRequiredApprovals(paths, state(paths));
  mintAssertionPresenceForFixture(paths);
  return paths;
}

describe("BSC-9 independence control-flip — external-signed readiness accepted ↔ in-process-forged rejected", () => {
  it("ARM A — ACCEPT: an external readiness receipt signed by the REAL key ⇒ valid-grounded ⇒ gate PASSES", () => {
    delete process.env.TH_BSC9_ENFORCE; // enforcement ON
    const paths = greenExceptReadiness();
    setVerifierKey(paths, K1.publicKey); // verifier holds K1
    appendExternalReadiness(paths, K1); // signed by K1 (the real producer key)

    const validated = readReadinessReceiptValidated(paths, readinessRefId(paths));
    const gate = checkProductionReality(paths, state(paths));
    console.log("[ACCEPT real] " + JSON.stringify({ "validated.status": validated.status, "gate.ok": gate.ok, "gate.error": gate.error ?? null }));
    expect(validated.status).toBe("valid-grounded");
    expect(gate.ok).toBe(true);
  });

  it("ARM B — REJECT: the SAME bytes forged in-process with a DIFFERENT key ⇒ forged ⇒ gate BLOCKS", () => {
    delete process.env.TH_BSC9_ENFORCE; // enforcement ON
    const paths = greenExceptReadiness();
    setVerifierKey(paths, K1.publicKey); // verifier holds K1
    appendExternalReadiness(paths, K2); // forged with K2 (no access to K1 private key)

    const validated = readReadinessReceiptValidated(paths, readinessRefId(paths));
    const gate = checkProductionReality(paths, state(paths));
    console.log("[REJECT forge] " + JSON.stringify({ "validated.status": validated.status, "gate.ok": gate.ok, "gate.error": gate.error ?? null, "readinessStatus": (gate.detail as { readinessStatus?: string } | undefined)?.readinessStatus ?? null }));
    expect(validated.status).toBe("forged");
    expect(gate.ok).toBe(false);
    expect(gate.error).toBe("bsc9_unverified");
    expect((gate.detail as { readinessStatus?: string }).readinessStatus).toBe("forged");
  });
});
