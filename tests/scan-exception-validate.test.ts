/**
 * Axis-B slice-2b (BSC-6) — the external-signed scan-exception ACK validator + the
 * scan-coverage gate's accept/reject INDEPENDENCE proof.
 *
 * An `unobserved` `dist/` path (a file the two-tier scan could not deep-inspect) is
 * exonerated ONLY by an Ed25519-signed, path-and-digest-scoped ack produced OUT of
 * process by `scripts/th-receipt-producer.mjs --kind scan-exception`. The in-process
 * surface holds the verify-only public key and provably cannot mint one — the slice-1b
 * grounded/forged asymmetry applied to scan exceptions.
 *
 * Validator cases drive `readScanExceptionValidated(paths, path, digest)` to each of its
 * four statuses (accepted / stale / absent / forged). The gate cases prove the
 * make-or-break contract end-to-end: a VALID signed ack for the exact `(path, digest)`
 * the scan enumerates makes `checkProductionReality` stop returning
 * `scan_coverage_incomplete` for that path, while an in-process FORGED ack (bad
 * signature) leaves the gate blocking — independence > 0.
 *
 * The accepted/gate-pass scenarios drive the REAL standalone producer (`spawnSync('node',
 * [producer.mjs, ...])`) so the proof exercises the actual out-of-process signing path
 * (mirrors `receipts-external-asymmetry.test.ts`). The forged scenarios write ack lines
 * directly (a different key / a corrupted signature) for precise byte control. Every
 * `TH_SCAN_*` and `TH_RECEIPT_*` env var is restored in afterEach.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { makeTempProject, type TempProject } from "./helpers";
import { writeState, readState } from "../src/core/state-store";
import { initialState, type TwinHarnessState } from "../src/core/state-schema";
import { runArtifactRegister } from "../src/commands/artifact";
import { runTesterRecord } from "../src/commands/tester";
import { checkProductionReality } from "../src/core/gate-preconditions";
import { scanForSimulationHits } from "../src/commands/sim";
import { hashFileStreaming } from "../src/core/hash";
import {
  readScanExceptionValidated,
  scanExceptionsPath,
  scanExceptionCanonicalText,
  computeScanExceptionRecordHash,
  readLastScanExceptionRecordHash,
} from "../src/core/scan-completeness";
import { currentReceiptSnapshotCoord } from "../src/core/receipts";
import { externalKeyId } from "../src/core/receipt-signing";
import type { ProjectPaths } from "../src/core/paths";

const SAVED_PUBLIC_KEYFILE = process.env.TH_RECEIPT_PUBLIC_KEYFILE;
const SAVED_PRIVATE_KEYFILE = process.env.TH_RECEIPT_PRIVATE_KEYFILE;
const SAVED_SCAN_FILE_MAX = process.env.TH_SCAN_FILE_MAX_BYTES;
const SAVED_SCAN_AGG_MAX = process.env.TH_SCAN_AGGREGATE_MAX_BYTES;
const SAVED_SCAN_WATCHDOG = process.env.TH_SCAN_WATCHDOG_MS;

let tp: TempProject | undefined;

function restoreEnv(name: string, saved: string | undefined): void {
  if (saved === undefined) delete process.env[name];
  else process.env[name] = saved;
}

afterEach(() => {
  restoreEnv("TH_RECEIPT_PUBLIC_KEYFILE", SAVED_PUBLIC_KEYFILE);
  restoreEnv("TH_RECEIPT_PRIVATE_KEYFILE", SAVED_PRIVATE_KEYFILE);
  restoreEnv("TH_SCAN_FILE_MAX_BYTES", SAVED_SCAN_FILE_MAX);
  restoreEnv("TH_SCAN_AGGREGATE_MAX_BYTES", SAVED_SCAN_AGG_MAX);
  restoreEnv("TH_SCAN_WATCHDOG_MS", SAVED_SCAN_WATCHDOG);
  tp?.cleanup();
  tp = undefined;
});

const PRODUCER = path.resolve(__dirname, "..", "scripts", "th-receipt-producer.mjs");

function writeFile(paths: ProjectPaths, rel: string, body: string): void {
  const abs = path.resolve(paths.root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, "utf8");
}

function state(paths: ProjectPaths): TwinHarnessState {
  return readState(paths).state!;
}

/** Install the verifier's public key, point the env at it, return its absolute path. */
function setVerifierKey(paths: ProjectPaths, name: string, publicKey: KeyObject): string {
  const f = path.join(paths.stateDir, name);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.writeFileSync(f, publicKey.export({ type: "spki", format: "pem" }));
  process.env.TH_RECEIPT_PUBLIC_KEYFILE = f;
  return f;
}

/** Write the producer's Ed25519 private key to a pem and return its absolute path. */
function writeProducerKey(paths: ProjectPaths, name: string, privateKey: KeyObject): string {
  const f = path.join(paths.stateDir, name);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.writeFileSync(f, privateKey.export({ type: "pkcs8", format: "pem" }));
  return f;
}

/**
 * Drive the REAL out-of-process producer for `--kind scan-exception --target <rel>`.
 * Returns the parsed stdout JSON. Asserts a clean exit so a producer-side refusal
 * surfaces loudly in the test rather than as a downstream "absent" mystery.
 */
function produceScanException(
  paths: ProjectPaths,
  targetRel: string,
  privateKeyFile: string,
  publicKeyFile?: string,
): { ok: boolean; path: string; digest: string; recordHash: string; key_id: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, TH_RECEIPT_PRIVATE_KEYFILE: privateKeyFile };
  // TH_RECEIPT_PUBLIC_KEYFILE is inert for the producer (it derives key_id from the
  // private key and never reads the public keyfile). Threaded here so the calling test
  // can keep the env consistent, but the producer ignores it — only the in-process
  // validator (readScanExceptionValidated) consumes TH_RECEIPT_PUBLIC_KEYFILE.
  if (publicKeyFile) env.TH_RECEIPT_PUBLIC_KEYFILE = publicKeyFile;
  const res = spawnSync(
    "node",
    [PRODUCER, "--root", paths.root, "--kind", "scan-exception", "--target", targetRel],
    { env, encoding: "utf8" },
  );
  expect(res.status, res.stderr).toBe(0);
  return JSON.parse(res.stdout.trim());
}

/**
 * Seal a SIGNED scan-exception ack line directly (the producer's formula, in-test) so a
 * negative scenario controls the bytes precisely. `tamper` mutates the sealed object
 * AFTER signing (e.g. corrupt the signature). recordHash + signature bind the IDENTICAL
 * canonical input, exactly like the producer.
 */
function appendSignedAck(
  paths: ProjectPaths,
  fields: { relPath: string; digest: string; keyPair: { privateKey: KeyObject; publicKey: KeyObject }; keyId?: string },
  tamper?: (sealed: Record<string, unknown>) => Record<string, unknown>,
): void {
  const ack = {
    path: fields.relPath,
    digest: fields.digest,
    snapshot_coord: currentReceiptSnapshotCoord(paths),
    producer_kind: "external" as const,
    key_id: fields.keyId ?? externalKeyId(fields.keyPair.publicKey),
    prevHash: readLastScanExceptionRecordHash(paths),
  };
  const canonical = scanExceptionCanonicalText(ack);
  const signature = sign(null, Buffer.from(canonical, "utf8"), fields.keyPair.privateKey).toString("base64");
  const recordHash = computeScanExceptionRecordHash(ack);
  let sealed: Record<string, unknown> = { ...ack, signature, recordHash };
  if (tamper) sealed = tamper(sealed);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.appendFileSync(scanExceptionsPath(paths), JSON.stringify(sealed) + "\n", "utf8");
}

/**
 * A project whose ENTIRE final-verification ladder is GREEN — slices settled, no verify
 * config, coverage clean (REQ-001 planned+tested), the report registered, a Tester record
 * attached. Replicated from `sim-scan-coverage-gate.test.ts:greenAtFinalVerification`.
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
  return paths;
}

const K1 = generateKeyPairSync("ed25519");
const K2 = generateKeyPairSync("ed25519");

// ===========================================================================
// VALIDATOR — readScanExceptionValidated drives each of the four statuses.
// ===========================================================================
describe("slice-2b — scan-exception ACK validator (readScanExceptionValidated)", () => {
  it("ACCEPTED: a producer-signed ack for the exact (path, current digest) → status accepted", () => {
    tp = makeTempProject();
    const paths = tp.paths;
    const publicKeyFile = setVerifierKey(paths, "k1-public.pem", K1.publicKey);
    const privateKeyFile = writeProducerKey(paths, "k1-private.pem", K1.privateKey);
    writeFile(paths, "dist/unseen.js", "const a = 1;\n");
    const abs = path.resolve(paths.root, "dist/unseen.js");
    const digest = hashFileStreaming(abs);

    const out = produceScanException(paths, "dist/unseen.js", privateKeyFile, publicKeyFile);
    expect(out.ok).toBe(true);
    // The producer's emitted (path, digest) is the SCAN's coordinate form, byte-for-byte.
    expect(out.path).toBe("dist/unseen.js");
    expect(out.digest).toBe(digest);

    const v = readScanExceptionValidated(paths, "dist/unseen.js", digest);
    expect(v.status).toBe("accepted");
    expect(v.ack!.path).toBe("dist/unseen.js");
    expect(v.ack!.digest).toBe(digest);
  });

  it("STALE: a valid ack exists but the file's CURRENT digest differs → status stale", () => {
    tp = makeTempProject();
    const paths = tp.paths;
    const publicKeyFile = setVerifierKey(paths, "k1-public.pem", K1.publicKey);
    const privateKeyFile = writeProducerKey(paths, "k1-private.pem", K1.privateKey);
    writeFile(paths, "dist/unseen.js", "const a = 1;\n");

    produceScanException(paths, "dist/unseen.js", privateKeyFile, publicKeyFile);

    // Mutate the file AFTER the ack — the signed digest no longer matches the current one.
    writeFile(paths, "dist/unseen.js", "const a = 2; // changed after the ack\n");
    const newDigest = hashFileStreaming(path.resolve(paths.root, "dist/unseen.js"));
    const v = readScanExceptionValidated(paths, "dist/unseen.js", newDigest);
    expect(v.status).toBe("stale");
  });

  it("ABSENT: no ack line names the path → status absent", () => {
    tp = makeTempProject();
    const paths = tp.paths;
    setVerifierKey(paths, "k1-public.pem", K1.publicKey);
    writeFile(paths, "dist/unseen.js", "const a = 1;\n");
    const digest = hashFileStreaming(path.resolve(paths.root, "dist/unseen.js"));
    // No ack store at all.
    expect(readScanExceptionValidated(paths, "dist/unseen.js", digest).status).toBe("absent");
  });

  it("FORGED (wrong key): an ack signed by K2 but the loaded verifier key is K1 → status forged", () => {
    tp = makeTempProject();
    const paths = tp.paths;
    setVerifierKey(paths, "k1-public.pem", K1.publicKey);
    writeFile(paths, "dist/unseen.js", "const a = 1;\n");
    const digest = hashFileStreaming(path.resolve(paths.root, "dist/unseen.js"));
    // Signed with K2 (a key the validator does not have) → cannot verify under K1.
    appendSignedAck(paths, { relPath: "dist/unseen.js", digest, keyPair: K2 });
    expect(readScanExceptionValidated(paths, "dist/unseen.js", digest).status).toBe("forged");
  });

  it("FORGED (tampered signature): a valid ack with one base64 char of the signature flipped → status forged", () => {
    tp = makeTempProject();
    const paths = tp.paths;
    setVerifierKey(paths, "k1-public.pem", K1.publicKey);
    writeFile(paths, "dist/unseen.js", "const a = 1;\n");
    const digest = hashFileStreaming(path.resolve(paths.root, "dist/unseen.js"));
    appendSignedAck(paths, { relPath: "dist/unseen.js", digest, keyPair: K1 }, (sealed) => {
      const sig = sealed.signature as string;
      const c = sig[0] === "a" ? "b" : "a";
      return { ...sealed, signature: c + sig.slice(1) };
    });
    expect(readScanExceptionValidated(paths, "dist/unseen.js", digest).status).toBe("forged");
  });

  it("FORGED (key absent): a well-formed K1-signed ack but TH_RECEIPT_PUBLIC_KEYFILE unset → status forged", () => {
    tp = makeTempProject();
    const paths = tp.paths;
    writeFile(paths, "dist/unseen.js", "const a = 1;\n");
    const digest = hashFileStreaming(path.resolve(paths.root, "dist/unseen.js"));
    appendSignedAck(paths, { relPath: "dist/unseen.js", digest, keyPair: K1 });
    delete process.env.TH_RECEIPT_PUBLIC_KEYFILE; // validator has no key → unprovable claim
    expect(readScanExceptionValidated(paths, "dist/unseen.js", digest).status).toBe("forged");
  });

  it("REFUSED: producer exits nonzero when --target resolves outside dist/ — no ack written", () => {
    tp = makeTempProject();
    const paths = tp.paths;
    const privateKeyFile = writeProducerKey(paths, "k1-private.pem", K1.privateKey);
    // A real file that EXISTS but is outside dist/ — the producer must refuse at creation.
    writeFile(paths, "docs/req.md", "# Requirements\n");
    const res = spawnSync(
      "node",
      [PRODUCER, "--root", paths.root, "--kind", "scan-exception", "--target", "docs/req.md"],
      { env: { ...process.env, TH_RECEIPT_PRIVATE_KEYFILE: privateKeyFile }, encoding: "utf8" },
    );
    expect(res.status).not.toBe(0);
    expect(JSON.parse(res.stderr).error).toContain("dist/");
    // No ack store should have been created — nothing was written.
    expect(fs.existsSync(scanExceptionsPath(paths))).toBe(false);
  });
});

// ===========================================================================
// GATE INDEPENDENCE — a valid ack lets the gate pass; a forged ack still blocks.
// ===========================================================================
describe("slice-2b — scan-coverage gate accept/reject (the independence proof)", () => {
  /**
   * Build a green-at-final-verification project with ONE real dist file driven
   * UNOBSERVED via a tiny per-file budget. Returns the path + its enumerated digest.
   * Asserts the scan genuinely sees the gap (fail-closed) before the exception is applied.
   */
  function unobservedDistGap(): { paths: ProjectPaths; rel: string; digest: string } {
    const paths = greenAtFinalVerification();
    const rel = "dist/unseen.js";
    writeFile(paths, rel, "const a = 1;\n");
    const digest = hashFileStreaming(path.resolve(paths.root, rel));
    return { paths, rel, digest };
  }

  it("VALID ACK → gate STOPS blocking on coverage: the residual no longer contains the path", () => {
    const { paths, rel, digest } = unobservedDistGap();
    const publicKeyFile = setVerifierKey(paths, "k1-public.pem", K1.publicKey);
    const privateKeyFile = writeProducerKey(paths, "k1-private.pem", K1.privateKey);

    // A tiny per-file budget keeps the file UNOBSERVED for both the bare-scan sanity check
    // AND the gate evaluation (the override must be live during checkProductionReality).
    process.env.TH_SCAN_FILE_MAX_BYTES = "1";

    // Sanity: without the ack the gate blocks on coverage for THIS path.
    const before = scanForSimulationHits(paths);
    expect(before.unobserved.some((u) => u.path === rel)).toBe(true);
    const blocked = checkProductionReality(paths, state(paths));
    expect(blocked.error).toBe("scan_coverage_incomplete");
    expect((blocked.detail!.unobserved as Array<{ path: string }>).some((u) => u.path === rel)).toBe(true);

    // Produce a VALID signed ack for the exact (path, digest) the scan enumerates.
    const out = produceScanException(paths, rel, privateKeyFile, publicKeyFile);
    expect(out.path).toBe(rel);
    expect(out.digest).toBe(digest);
    expect(readScanExceptionValidated(paths, rel, digest).status).toBe("accepted");

    // The gate no longer reports scan_coverage_incomplete for THIS path. Nothing else
    // blocks the green ladder, so the gate is ok:true — but the load-bearing assertion is
    // the negative: the path is gone from the residual.
    const after = checkProductionReality(paths, state(paths));
    expect(after.error).not.toBe("scan_coverage_incomplete");
    if (after.ok === false) {
      expect((after.detail!.unobserved as Array<{ path: string }> | undefined)?.some((u) => u.path === rel)).not.toBe(
        true,
      );
    } else {
      expect(after).toEqual({ ok: true });
    }
  });

  it("FORGED ACK → gate STILL blocks: an in-process bad-signature ack cannot exonerate", () => {
    const { paths, rel, digest } = unobservedDistGap();
    setVerifierKey(paths, "k1-public.pem", K1.publicKey);

    process.env.TH_SCAN_FILE_MAX_BYTES = "1";

    // An in-process forge: a shape-valid ack for the exact (path, digest) but signed by a
    // key the validator does not have (K2). The in-process surface provably cannot produce
    // a K1 signature, so this is the strongest forge available to it.
    appendSignedAck(paths, { relPath: rel, digest, keyPair: K2 });
    expect(readScanExceptionValidated(paths, rel, digest).status).toBe("forged");

    // Independence > 0: the forged ack does NOT subtract the path — the gate still blocks.
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("scan_coverage_incomplete");
    expect((res.detail!.unobserved as Array<{ path: string }>).some((u) => u.path === rel)).toBe(true);
  });
});
