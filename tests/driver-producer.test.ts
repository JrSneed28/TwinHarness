/**
 * Axis-B slice-4b (BSC-3) — the EXTERNAL Ed25519 `--kind driver` producer
 * (`scripts/th-receipt-producer.mjs`). The keyed, out-of-process surface that mints a signed
 * {@link DriverDimensionReceipt} the in-process agent provably cannot forge (it holds no key) —
 * the REAL producer that flips the BSC-3 ledger independence from `0` to `>0`.
 *
 * These tests drive the REAL standalone producer (`spawnSync('node', [producer.mjs, ...])`)
 * with a test Ed25519 keypair, exactly like the slice-1b/2b/3b external-producer harness
 * (`receipts-external-asymmetry.test.ts` / `external-approval-producer.test.ts`):
 *   - a signed line lands in `external-driver-receipts.jsonl` with `producer_kind:"external"`, a
 *     `key_id`, a verifying `signature`, and a GENESIS chain seed;
 *   - the make-or-break contract: the SIGNED canonical text is byte-identical to the 4a
 *     in-process `driverCanonicalText` re-derivation, so the signature verifies under the
 *     producer's public key AND `recordHash` matches `computeDriverRecordHash` — proven here so
 *     the gate's `valid-grounded` classification is grounded;
 *   - refuse-at-creation: a `--dimension` naming a dimension the report did NOT observe, and a
 *     run with NO verify-report.json at all, both refuse (nonzero exit, no line written);
 *   - the terminal-receipt flow output is byte-identical to the slice-1b shape (the driver
 *     branch is added BEFORE the terminal machinery, which stays untouched).
 *
 * The dimensions are DERIVED from `verify-report.json` (the 4a sensor), never supplied: the
 * fixture writes a report whose commands observe the three seed dimensions, mirroring
 * `tests/bsc3-driver-gate.test.ts:reportObservingAll`.
 *
 * Deterministic + Windows-safe (path.join, no shell). Every `TH_RECEIPT_*` env var restored.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, createPublicKey, verify, type KeyObject } from "node:crypto";
import { makeTempProject, type TempProject } from "./helpers";
import {
  externalDriverReceiptsPath,
  driverCanonicalText,
  computeDriverRecordHash,
} from "../src/core/verification-driver";
import { externalKeyId } from "../src/core/receipt-signing";
import { writeVerifyReport, type VerifyReport } from "../src/core/verify";
import { GENESIS_PREV_HASH } from "../src/core/hash";
import type { ProjectPaths } from "../src/core/paths";

const SAVED_PUBLIC_KEYFILE = process.env.TH_RECEIPT_PUBLIC_KEYFILE;
const SAVED_PRIVATE_KEYFILE = process.env.TH_RECEIPT_PRIVATE_KEYFILE;

let tp: TempProject | undefined;

function restoreEnv(name: string, saved: string | undefined): void {
  if (saved === undefined) delete process.env[name];
  else process.env[name] = saved;
}

afterEach(() => {
  restoreEnv("TH_RECEIPT_PUBLIC_KEYFILE", SAVED_PUBLIC_KEYFILE);
  restoreEnv("TH_RECEIPT_PRIVATE_KEYFILE", SAVED_PRIVATE_KEYFILE);
  tp?.cleanup();
  tp = undefined;
});

const PRODUCER = path.resolve(__dirname, "..", "scripts", "th-receipt-producer.mjs");

/** Write the producer's Ed25519 private key to a pem and return its absolute path. */
function writeProducerKey(paths: ProjectPaths, name: string, privateKey: KeyObject): string {
  const f = path.join(paths.stateDir, name);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.writeFileSync(f, privateKey.export({ type: "pkcs8", format: "pem" }));
  return f;
}

/** A verify report observing all three seed dimensions (mirrors bsc3-driver-gate). */
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

/** A report observing only tests-executed + typecheck (build NOT observed). */
function reportObservingTwo(): VerifyReport {
  return {
    ok: true,
    ranAt: new Date().toISOString(),
    results: [
      { command: "vitest run", exitCode: 0, ok: true, durationMs: 1, outputTail: "" },
      { command: "tsc --noEmit", exitCode: 0, ok: true, durationMs: 1, outputTail: "" },
    ],
  };
}

/** The exact spawn the producer expects; passes the private key via env. */
function runProducer(args: string[], privateKeyFile: string): ReturnType<typeof spawnSync> {
  const env: NodeJS.ProcessEnv = { ...process.env, TH_RECEIPT_PRIVATE_KEYFILE: privateKeyFile };
  return spawnSync("node", [PRODUCER, ...args], { env, encoding: "utf8" });
}

const K1 = generateKeyPairSync("ed25519");

// ===========================================================================
// HAPPY PATH — one signed external-driver line, signature/hash match 4a.
// ===========================================================================
describe("slice-4b — external --kind driver producer", () => {
  it("writes exactly ONE signed line to external-driver-receipts.jsonl (producer_kind:external, key_id, signature, GENESIS chain seed, all three dims)", () => {
    tp = makeTempProject();
    const paths = tp.paths;
    const privateKeyFile = writeProducerKey(paths, "k1-private.pem", K1.privateKey);
    writeVerifyReport(paths, reportObservingAll());

    const res = runProducer(["--root", paths.root, "--kind", "driver"], privateKeyFile);
    expect(res.status, res.stderr as string).toBe(0);
    const out = JSON.parse((res.stdout as string).trim());
    expect(out.ok).toBe(true);
    expect(out.kind).toBe("driver");
    expect(out.producer_kind).toBe("external");
    expect(out.dimensions).toEqual(["tests-executed", "typecheck", "build"]);

    const file = externalDriverReceiptsPath(paths);
    const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(1); // EXACTLY one line

    const line = JSON.parse(lines[0]!);
    expect(line.kind).toBe("driver-dimension");
    expect(line.producer_kind).toBe("external");
    expect(typeof line.key_id).toBe("string");
    expect(line.key_id).toBe(externalKeyId(K1.publicKey));
    expect(typeof line.signature).toBe("string");
    expect(line.prevHash).toBe(GENESIS_PREV_HASH); // first line seeds from GENESIS
    expect(line.dimensions.map((d: { name: string }) => d.name)).toEqual([
      "tests-executed",
      "typecheck",
      "build",
    ]);
    for (const d of line.dimensions) expect(d.observed).toBe(true);
  });

  it("MAKE-OR-BREAK: the signed canonical text is byte-identical to the 4a driverCanonicalText, so the signature verifies and recordHash matches", () => {
    tp = makeTempProject();
    const paths = tp.paths;
    const privateKeyFile = writeProducerKey(paths, "k1-private.pem", K1.privateKey);
    writeVerifyReport(paths, reportObservingAll());

    const res = runProducer(["--root", paths.root, "--kind", "driver"], privateKeyFile);
    expect(res.status, res.stderr as string).toBe(0);

    const line = JSON.parse(fs.readFileSync(externalDriverReceiptsPath(paths), "utf8").trim());
    const { signature, recordHash, ...rest } = line;

    // Re-derive the canonical text with the SAME 4a helper the gate validator uses.
    const canonical = driverCanonicalText(rest);
    // signature + recordHash are EXCLUDED trailers (canonical text is signature-free).
    expect(canonical).not.toContain("signature");
    expect(canonical).not.toContain("recordHash");

    // The signature verifies under the producer's PUBLIC key over the 4a canonical bytes.
    const pub = createPublicKey(K1.publicKey.export({ type: "spki", format: "pem" }));
    expect(verify(null, Buffer.from(canonical, "utf8"), pub, Buffer.from(signature, "base64"))).toBe(true);
    // The recordHash matches the 4a hash binding (chain link valid for the gate).
    expect(computeDriverRecordHash(rest)).toBe(recordHash);
  });

  it("chains a second receipt off the first (prevHash = the first line's recordHash)", () => {
    tp = makeTempProject();
    const paths = tp.paths;
    const privateKeyFile = writeProducerKey(paths, "k1-private.pem", K1.privateKey);
    writeVerifyReport(paths, reportObservingAll());

    const r1 = runProducer(["--root", paths.root, "--kind", "driver"], privateKeyFile);
    expect(r1.status, r1.stderr as string).toBe(0);
    const r2 = runProducer(["--root", paths.root, "--kind", "driver"], privateKeyFile);
    expect(r2.status, r2.stderr as string).toBe(0);

    const lines = fs.readFileSync(externalDriverReceiptsPath(paths), "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!);
    const second = JSON.parse(lines[1]!);
    expect(first.prevHash).toBe(GENESIS_PREV_HASH);
    expect(second.prevHash).toBe(first.recordHash); // append-only chain link
  });
});

// ===========================================================================
// REFUSE-AT-CREATION — symmetric with the approval flow's ground-resolve refusal.
// ===========================================================================
describe("slice-4b — external --kind driver refuse-at-creation", () => {
  it("refuses --dimension build when the report observes only tests-executed+typecheck (nonzero exit, no line)", () => {
    tp = makeTempProject();
    const paths = tp.paths;
    const privateKeyFile = writeProducerKey(paths, "k1-private.pem", K1.privateKey);
    writeVerifyReport(paths, reportObservingTwo()); // build NOT observed

    const res = runProducer(["--root", paths.root, "--kind", "driver", "--dimension", "build"], privateKeyFile);
    expect(res.status).not.toBe(0);
    expect(res.stderr as string).toContain("not observed in verify-report.json");
    expect(fs.existsSync(externalDriverReceiptsPath(paths))).toBe(false); // nothing written
  });

  it("refuses when NO verify-report.json exists at all (nonzero exit, no line)", () => {
    tp = makeTempProject();
    const paths = tp.paths;
    const privateKeyFile = writeProducerKey(paths, "k1-private.pem", K1.privateKey);
    // No verify report written ⇒ the sensor observes nothing.

    const res = runProducer(["--root", paths.root, "--kind", "driver"], privateKeyFile);
    expect(res.status).not.toBe(0);
    expect(res.stderr as string).toContain("no driver dimension observed");
    expect(fs.existsSync(externalDriverReceiptsPath(paths))).toBe(false);
  });
});

// ===========================================================================
// TERMINAL-FLOW PIN — the driver branch sits BEFORE the terminal machinery, so a
// terminal-receipt kind still writes external-receipts.jsonl with the SAME slice-1b
// shape and does NOT touch external-driver-receipts.jsonl.
// ===========================================================================
describe("slice-4b — terminal-receipt flow unchanged by the driver branch", () => {
  it("decision-approve still writes external-receipts.jsonl with the slice-1b shape (NOT external-driver-receipts.jsonl)", () => {
    tp = makeTempProject();
    const paths = tp.paths;
    const privateKeyFile = writeProducerKey(paths, "k1-private.pem", K1.privateKey);

    const res = runProducer(
      ["--root", paths.root, "--kind", "decision-approve", "--ref-id", "DEC-001"],
      privateKeyFile,
    );
    expect(res.status, res.stderr as string).toBe(0);
    const out = JSON.parse((res.stdout as string).trim());
    expect(out.ok).toBe(true);
    expect(out.kind).toBe("decision-approve");
    expect(out.producer_kind).toBe("external");
    expect(out.refId).toBe("DEC-001");

    // The terminal store is written; the driver store is NOT touched by this kind.
    expect(fs.existsSync(path.join(paths.stateDir, "external-receipts.jsonl"))).toBe(true);
    expect(fs.existsSync(externalDriverReceiptsPath(paths))).toBe(false);

    // The terminal line keeps its slice-1b field shape (kind/refId/target_resolves_in_source).
    const line = JSON.parse(
      fs.readFileSync(path.join(paths.stateDir, "external-receipts.jsonl"), "utf8").trim(),
    );
    expect(line.kind).toBe("decision-approve");
    expect(line.refId).toBe("DEC-001");
    expect(line.target_resolves_in_source).toEqual({ path: "", digest: "" });
    expect(line.producer_kind).toBe("external");
    expect(typeof line.signature).toBe("string");
    expect(line.prevHash).toBe(GENESIS_PREV_HASH);
  });
});
