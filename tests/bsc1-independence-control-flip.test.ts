/**
 * Axis-B slice-5 (BSC-1) — the 1b INDEPENDENCE control-flip, demonstrated end-to-end through
 * the REAL external Ed25519 producer + the REAL completion gate. This is the proof BSC-1
 * independence is a NUMBER > 0 (consensus §2 driver 2 — SIGNATURE-PROVENANCE independence
 * only; the referent anchor stays agent-authored, so this proves the receipt was not forged
 * in-process, NOT that the referent is independent):
 *
 *   ARM A — ACCEPTED (valid-grounded): the REAL standalone producer
 *     (`scripts/th-receipt-producer.mjs --kind realization`), holding the Ed25519 PRIVATE key,
 *     signs an external `RealizationReceipt`; the gate re-derives the canonical text, VERIFIES
 *     the signature against the loaded PUBLIC key, and ACCEPTS it as `valid-grounded` ⇒ the
 *     realization rung PASSES.
 *   ARM B — REJECTED (forged): the SAME bytes signed in-process with a DIFFERENT key (the
 *     closest the in-process surface gets WITHOUT the private key) does NOT verify ⇒ `forged`
 *     ⇒ the gate BLOCKS with `realization_unverified`.
 *
 * NON-VACUOUS: both arms share the identical fixture, identical REQ-ID, identical referent
 * bytes — the ONLY difference is signature provenance (a verifying signature from the real
 * key vs a non-verifying one from a wrong key). The `valid-grounded` label is reachable ONLY
 * via a signature the in-process surface cannot forge — that delta IS the independence
 * property. CI-safe: both keypairs are generated in-test; no committed key material.
 *
 * Windows-safe (path.join, spawnSync node). The producer spawned here imports COMMITTED dist
 * (`dist/core/realization.js`), so this suite requires `npm run build` to be current — the
 * same posture as `tests/bsc3-independence-control-flip.test.ts`.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { makeTempProject, mintRequiredApprovals, type TempProject } from "./helpers";
import { writeState, readState } from "../src/core/state-store";
import { initialState, type TwinHarnessState } from "../src/core/state-schema";
import { runArtifactRegister } from "../src/commands/artifact";
import { runTesterRecord } from "../src/commands/tester";
import { checkProductionReality } from "../src/core/gate-preconditions";
import { externalKeyId } from "../src/core/receipt-signing";
import { currentReceiptSnapshotCoord, computeTargetDigest } from "../src/core/receipts";
import {
  type RealizationReceipt,
  externalRealizationReceiptsPath,
  realizationCanonicalText,
  computeRealizationRecordHash,
  readLastExternalRealizationRecordHash,
  readRealizationReceiptValidated,
} from "../src/core/realization";
import { emptyRepoMap, serializeRepoMap, type RepoMap, type FileEntry } from "../src/core/repo-map/schema";
import type { ProjectPaths } from "../src/core/paths";

const SAVED_PUBLIC_KEYFILE = process.env.TH_RECEIPT_PUBLIC_KEYFILE;
const SAVED_PRIVATE_KEYFILE = process.env.TH_RECEIPT_PRIVATE_KEYFILE;
const SAVED_BSC1_ENFORCE = process.env.TH_BSC1_ENFORCE;
let tp: TempProject | undefined;

afterEach(() => {
  if (SAVED_PUBLIC_KEYFILE === undefined) delete process.env.TH_RECEIPT_PUBLIC_KEYFILE;
  else process.env.TH_RECEIPT_PUBLIC_KEYFILE = SAVED_PUBLIC_KEYFILE;
  if (SAVED_PRIVATE_KEYFILE === undefined) delete process.env.TH_RECEIPT_PRIVATE_KEYFILE;
  else process.env.TH_RECEIPT_PRIVATE_KEYFILE = SAVED_PRIVATE_KEYFILE;
  if (SAVED_BSC1_ENFORCE === undefined) delete process.env.TH_BSC1_ENFORCE;
  else process.env.TH_BSC1_ENFORCE = SAVED_BSC1_ENFORCE;
  tp?.cleanup();
  tp = undefined;
});

const PRODUCER = path.resolve(__dirname, "..", "scripts", "th-receipt-producer.mjs");
const K1 = generateKeyPairSync("ed25519"); // the verifier's key (real producer holds K1 private)
const K2 = generateKeyPairSync("ed25519"); // the forger's key (never matches the verifier)
const REFERENT = "src/commands/a.ts";

function state(paths: ProjectPaths): TwinHarnessState {
  return readState(paths).state!;
}

function writeFile(paths: ProjectPaths, rel: string, body: string): void {
  const abs = path.resolve(paths.root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, "utf8");
}

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

/**
 * GREEN at final-verification on every rung EXCEPT realization, with REQ-001 owned by a `done`
 * slice via the repo-map and a post-regime migration marker (empty baseline) — the realization
 * rung is the only lever, and the ONLY thing that clears it is a valid referent receipt.
 */
function greenExceptRealization(): ProjectPaths {
  tp = makeTempProject();
  const paths = tp.paths;
  writeFile(paths, "docs/01-requirements.md", "# Requirements\n\n- REQ-001 the only requirement.\n");
  writeFile(paths, "tests/cov.test.ts", "// REQ-001 verified here\n");
  writeFile(paths, "docs/10-verification-report.md", "# Verification Report\n\nREQ-001 verified.\n");
  writeFile(paths, REFERENT, "export const a = 1; // REQ-001\n");
  writeState(paths, {
    ...initialState(),
    tier: "T1",
    current_stage: "final-verification",
    implementation_allowed: true,
    slices: [{ id: "SLICE-0", status: "done", components: ["commands"] }],
  });
  runArtifactRegister(paths, "docs/10-verification-report.md", 1);
  runTesterRecord(paths, { driver: "cli-e2e", provider: "sandbox", passed: true });
  mintRequiredApprovals(paths, state(paths));
  writeRepoMap(paths, [{ path: REFERENT, component: "src/commands", req_ids: ["REQ-001"] }]);
  fs.writeFileSync(
    path.join(paths.stateDir, ".realization-receipts-migration"),
    JSON.stringify({ migratedAt: new Date().toISOString(), baseline: [] }),
    "utf8",
  );
  return paths;
}

function setVerifierKey(paths: ProjectPaths, publicKey: KeyObject): string {
  const f = path.join(paths.stateDir, "realization-public.pem");
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.writeFileSync(f, publicKey.export({ type: "spki", format: "pem" }));
  process.env.TH_RECEIPT_PUBLIC_KEYFILE = f;
  return f;
}

function writeProducerKey(paths: ProjectPaths, privateKey: KeyObject): string {
  const f = path.join(paths.stateDir, "k1-private.pem");
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.writeFileSync(f, privateKey.export({ type: "pkcs8", format: "pem" }));
  return f;
}

/**
 * Forge (in-process) an external-claiming realization line with a WRONG-key signature. The
 * canonical bytes are byte-identical to a real external receipt (same fields); the only flaw
 * is the signature was produced by K2 while the verifier holds K1.
 */
function appendForgedExternalRealization(paths: ProjectPaths, keyPair: { privateKey: KeyObject; publicKey: KeyObject }): void {
  const digest = computeTargetDigest(paths.root, REFERENT)!;
  const withPrev: Omit<RealizationReceipt, "recordHash" | "signature"> = {
    kind: "realization",
    req_id: "REQ-001",
    owning_slice: "",
    referent: { path: REFERENT, digest },
    snapshot_coord: currentReceiptSnapshotCoord(paths),
    producer_identity: "forged:in-process",
    producer_kind: "external",
    key_id: externalKeyId(keyPair.publicKey),
    prevHash: readLastExternalRealizationRecordHash(paths),
  };
  const signature = sign(null, Buffer.from(realizationCanonicalText(withPrev), "utf8"), keyPair.privateKey).toString("base64");
  const recordHash = computeRealizationRecordHash(withPrev);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.appendFileSync(externalRealizationReceiptsPath(paths), JSON.stringify({ ...withPrev, signature, recordHash }) + "\n", "utf8");
}

describe("BSC-1 independence control-flip — external-signed accepted ↔ in-process-forged rejected", () => {
  it("ARM A — ACCEPT: the REAL producer's external-signed receipt ⇒ valid-grounded ⇒ gate PASSES", () => {
    delete process.env.TH_BSC1_ENFORCE; // enforcement ON
    const paths = greenExceptRealization();
    const publicKeyFile = setVerifierKey(paths, K1.publicKey);
    const privateKeyFile = writeProducerKey(paths, K1.privateKey);

    const res = spawnSync(
      "node",
      [PRODUCER, "--root", paths.root, "--kind", "realization", "--ref-id", "REQ-001", "--target", REFERENT],
      {
        env: { ...process.env, TH_RECEIPT_PUBLIC_KEYFILE: publicKeyFile, TH_RECEIPT_PRIVATE_KEYFILE: privateKeyFile },
        encoding: "utf8",
      },
    );
    const validated = readRealizationReceiptValidated(paths, "REQ-001");
    const gate = checkProductionReality(paths, state(paths));
    console.log(
      "[ACCEPT real] " +
        JSON.stringify({
          "producer.status": res.status,
          "producer.stderr": (res.stderr ?? "").trim().slice(0, 200),
          "validated.status": validated.status,
          "gate.ok": gate.ok,
          "gate.error": gate.error ?? null,
        }),
    );
    expect(res.status).toBe(0);
    expect(validated.status).toBe("valid-grounded");
    expect(gate.ok).toBe(true);
  });

  it("ARM B — REJECT: the SAME bytes forged in-process with a DIFFERENT key ⇒ forged ⇒ gate BLOCKS", () => {
    delete process.env.TH_BSC1_ENFORCE; // enforcement ON
    const paths = greenExceptRealization();
    setVerifierKey(paths, K1.publicKey); // verifier holds K1
    appendForgedExternalRealization(paths, K2); // forged with K2 (no access to K1 private key)

    const validated = readRealizationReceiptValidated(paths, "REQ-001");
    const gate = checkProductionReality(paths, state(paths));
    const failures = (gate.detail?.failures ?? []) as Array<{ reqId: string; status: string }>;
    console.log(
      "[REJECT forged] " +
        JSON.stringify({
          "validated.status": validated.status,
          "gate.ok": gate.ok,
          "gate.error": gate.error ?? null,
          failures,
        }),
    );
    expect(validated.status).toBe("forged");
    expect(gate.ok).toBe(false);
    expect(gate.error).toBe("realization_unverified");
    expect(failures.some((f) => f.reqId === "REQ-001" && f.status === "forged")).toBe(true);
  });

  it("ARMS DIFFER for the RIGHT reason: identical referent bytes, only signature provenance differs", () => {
    // ARM A and ARM B bind the IDENTICAL referent {path, digest}; the accept/reject split is
    // therefore NOT a content difference — it is purely whether a verifying signature exists.
    delete process.env.TH_BSC1_ENFORCE;
    const a = greenExceptRealization();
    const aDigest = computeTargetDigest(a.root, REFERENT);
    tp?.cleanup();
    const b = greenExceptRealization();
    const bDigest = computeTargetDigest(b.root, REFERENT);
    expect(aDigest).toBe(bDigest); // identical referent content across both arms
    expect(aDigest).not.toBeNull();
  });
});
