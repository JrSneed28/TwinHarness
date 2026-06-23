/**
 * Axis-B slice-6 (BSC-2) — the FOUR enumerated assertion-presence negative-controls (Lane D,
 * deliverable 2). Each control drives the REAL completion gate (`checkProductionReality`) and the
 * REAL assertion-presence store (`src/core/assertion-presence.ts`); enforcement defaults ON
 * (`TH_BSC2_ENFORCE` unset). Mirrors `tests/bsc1-negative-controls.test.ts` /
 * `tests/bsc7-negative-controls.test.ts`.
 *
 *   (a) forged/stale snapshot_coord    — a receipt whose recorded snapshot diverged from the
 *                                        current tree ⇒ `stale` content ⇒ BLOCK
 *                                        `assertion_presence_unverified`.
 *   (b) bypass: tested REQ, NO receipt  — tested REQs in the checked set but NO assertion-presence
 *                                        receipt (the `--emergency`/raw `state set` path) ⇒
 *                                        fail-closed `assertion_unobserved` BLOCK (the load-bearing
 *                                        "unobserved ≠ clean" control).
 *   (c) ground no longer re-derives     — mint a receipt, then EDIT the REQ's test file so the
 *                                        recomputed ground ≠ the recorded ground ⇒ `target_mismatch`
 *                                        BLOCK (proves the gate recomputes + digest-compares — F8).
 *   (d) waiver does NOT bypass when bad — unsigned / wrong-key / over-broad / digest-mismatched
 *                                        waivers exempt NOTHING (still blocks); the POSITIVE control:
 *                                        a correctly-signed, digest-matching waiver DOES exempt
 *                                        (rendered `waived`, gate PASSes).
 *
 * The keypair for (d) is generated IN-TEST (PKCS8 private + SPKI public to temp keyfiles,
 * `TH_RECEIPT_PUBLIC_KEYFILE`), so the suite is deterministic on CI. All `TH_*` env restored in
 * afterEach. Deterministic + Windows-safe (path.join, no shell). No `dist/` build required.
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
import { currentReceiptSnapshotCoord } from "../src/core/receipts";
import { externalKeyId } from "../src/core/receipt-signing";
import {
  type AssertionPresenceReceipt,
  type AssertionWaiver,
  appendAssertionPresenceReceipt,
  assertionPresenceReceiptsPath,
  assertionPresenceCanonicalText,
  computeAssertionPresenceRecordHash,
  computeAssertionPresenceGround,
  assertionGroundDigest,
  readLastAssertionPresenceRecordHash,
  assertionWaiversPath,
  assertionWaiverCanonicalText,
  computeAssertionWaiverRecordHash,
  readLastExternalAssertionWaiverRecordHash,
} from "../src/core/assertion-presence";
import type { ProjectPaths } from "../src/core/paths";

const SAVED_BSC2_ENFORCE = process.env.TH_BSC2_ENFORCE;
const SAVED_PUBLIC_KEYFILE = process.env.TH_RECEIPT_PUBLIC_KEYFILE;
let tp: TempProject | undefined;

afterEach(() => {
  if (SAVED_BSC2_ENFORCE === undefined) delete process.env.TH_BSC2_ENFORCE;
  else process.env.TH_BSC2_ENFORCE = SAVED_BSC2_ENFORCE;
  if (SAVED_PUBLIC_KEYFILE === undefined) delete process.env.TH_RECEIPT_PUBLIC_KEYFILE;
  else process.env.TH_RECEIPT_PUBLIC_KEYFILE = SAVED_PUBLIC_KEYFILE;
  tp?.cleanup();
  tp = undefined;
});

const K1 = generateKeyPairSync("ed25519"); // the configured waiver key
const K2 = generateKeyPairSync("ed25519"); // the WRONG key

function writeFile(paths: ProjectPaths, rel: string, body: string): void {
  const abs = path.resolve(paths.root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, "utf8");
}

function state(paths: ProjectPaths): TwinHarnessState {
  return readState(paths).state!;
}

/** A real git repo with one commit at `root`, or false when git is unavailable. */
function initGitRepo(root: string): boolean {
  const run = (args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (run(["init"]).error) return false;
  run(["config", "user.email", "t@t.t"]);
  run(["config", "user.name", "t"]);
  run(["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(root, ".gitkeep"), "x\n", "utf8");
  run(["add", "-A"]);
  const c = run(["commit", "-m", "init", "--no-gpg-sign"]);
  return !c.error && c.status === 0;
}

/**
 * A project GREEN at final-verification on every rung EXCEPT the BSC-2 assertion rung: slices
 * settled, coverage clean (REQ-001 in reqs + plan + tests), report registered, Tester record
 * attached, required approvals minted, no repo-map (so the realization rung PASSes) and no driver
 * receipt (grandfathered ⇒ driver rung PASSes). The assertion-presence rung is the ONLY lever. The
 * caller decides whether to mint the assertion-presence receipt (some controls omit/forge it).
 */
function greenExceptAssertion(opts: { covBody?: string } = {}): ProjectPaths {
  tp = makeTempProject();
  const paths = tp.paths;
  writeFile(paths, "docs/01-requirements.md", "# Requirements\n\n- REQ-001 the only requirement.\n");
  writeFile(paths, "docs/09-implementation-plan.md", "# Plan\n\nSLICE-0 covers REQ-001.\n");
  writeFile(paths, "tests/cov.test.ts", opts.covBody ?? ASSERTED_COV_TEST);
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
  return paths;
}

/** Confirm the assertion rung is reached (no earlier rung blocks first) by minting a clean receipt. */
function assertGreenWithReceipt(paths: ProjectPaths): void {
  mintAssertionPresenceForFixture(paths);
  const res = checkProductionReality(paths, state(paths));
  expect(res.ok, `expected a clean fixture+receipt to PASS, got error=${res.error}`).toBe(true);
}

// ---------------------------------------------------------------------------
// (a) forged/stale snapshot_coord — a receipt whose snapshot diverged ⇒ stale ⇒ BLOCK
// ---------------------------------------------------------------------------

describe("BSC-2 negative-control (a): a snapshot-stale assertion-presence receipt blocks", () => {
  it("a receipt whose recorded snapshot_coord diverged from the current tree ⇒ stale ⇒ BLOCK", () => {
    delete process.env.TH_BSC2_ENFORCE; // default ON
    const paths = greenExceptAssertion();
    // The F8 stale rule discriminates ONLY when BOTH the recorded and current coordinates are
    // non-null. A no-git temp project has gitHead===null AND treeDigest===null (the digest is a
    // git-status hash), so we make the tree a REAL git repo first; then both current coords are
    // non-null and a divergent recorded coord is genuinely `stale`. Skip when git is unavailable.
    if (!initGitRepo(paths.root)) return;
    const cur = currentReceiptSnapshotCoord(paths);
    if (cur.gitHead === null || cur.treeDigest === null) return; // git present but no usable coord

    // Hand-mint a receipt whose GROUND matches the current recompute (so it passes the
    // target_mismatch check) but whose snapshot_coord names a DIFFERENT gitHead+treeDigest than
    // the current tree → stale.
    const ground = computeAssertionPresenceGround(paths);
    const divergent = {
      gitHead: cur.gitHead.replace(/.$/, (ch) => (ch === "f" ? "0" : "f")),
      treeDigest: "d".repeat(64),
    };
    const withPrev: Omit<AssertionPresenceReceipt, "recordHash"> = {
      kind: "assertion-presence",
      refId: cur.gitHead,
      ground,
      snapshot_coord: divergent,
      producer_identity: "test:stale",
      prevHash: readLastAssertionPresenceRecordHash(paths),
    };
    const recordHash = computeAssertionPresenceRecordHash(withPrev);
    fs.appendFileSync(
      assertionPresenceReceiptsPath(paths),
      JSON.stringify({ ...withPrev, recordHash }) + "\n",
      "utf8",
    );

    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("assertion_presence_unverified");
    expect((res.detail as { contentStatus?: string }).contentStatus).toBe("stale");
    expect((res.detail as { staleReasons?: string[] }).staleReasons).toEqual(
      expect.arrayContaining(["gitHead", "treeDigest"]),
    );
  });
});

// ---------------------------------------------------------------------------
// (b) bypass: tested REQ but NO receipt ⇒ fail-closed assertion_unobserved
// ---------------------------------------------------------------------------

describe("BSC-2 negative-control (b): tested REQs with NO assertion-presence receipt fail closed", () => {
  it("a green fixture that NEVER minted a receipt ⇒ assertion_unobserved BLOCK (unobserved ≠ clean)", () => {
    delete process.env.TH_BSC2_ENFORCE;
    const paths = greenExceptAssertion();
    // Deliberately do NOT mint an assertion-presence receipt (the --emergency / raw state-set path).
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("assertion_unobserved");
    expect((res.detail as { tested?: number }).tested).toBeGreaterThan(0);
  });

  it("POSITIVE twin: minting the receipt on the SAME fixture PASSES (the block was the assertion rung)", () => {
    delete process.env.TH_BSC2_ENFORCE;
    const paths = greenExceptAssertion();
    assertGreenWithReceipt(paths);
  });
});

// ---------------------------------------------------------------------------
// (c) ground no longer re-derives — edit the test file after mint ⇒ target_mismatch
// ---------------------------------------------------------------------------

describe("BSC-2 negative-control (c): editing the REQ's test file after mint ⇒ target_mismatch BLOCK", () => {
  it("a receipt, then an assertion ADDED to the test file ⇒ recomputed ground ≠ recorded ⇒ target_mismatch", () => {
    delete process.env.TH_BSC2_ENFORCE;
    const paths = greenExceptAssertion();
    mintAssertionPresenceForFixture(paths); // ground bound to the original cov.test.ts
    // Tamper: change the assertion shape AFTER the digest was bound (add a second assertion).
    writeFile(
      paths,
      "tests/cov.test.ts",
      `import { expect, it } from "vitest";\n\nit("REQ-001 is verified", () => {\n  expect(1 + 1).toBe(2);\n  expect(2 + 2).toBe(4);\n});\n`,
    );
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("assertion_presence_unverified");
    expect((res.detail as { contentStatus?: string }).contentStatus).toBe("target_mismatch");
  });
});

// ---------------------------------------------------------------------------
// (d) waiver: bad waivers exempt NOTHING; a correct waiver DOES exempt (positive control)
// ---------------------------------------------------------------------------

/** Install K1's public key (SPKI PEM) as the verifier key and point the env at it. */
function setVerifierKey(paths: ProjectPaths, publicKey: KeyObject): void {
  const f = path.join(paths.stateDir, "waiver-public.pem");
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.writeFileSync(f, publicKey.export({ type: "spki", format: "pem" }));
  process.env.TH_RECEIPT_PUBLIC_KEYFILE = f;
}

/**
 * Append a waiver line for `reqId`, signing the canonical text with `signWith` (or leaving it
 * unsigned when `signWith` is undefined). `groundDigest`/`reqId`/`keyId` overridable so the bad
 * variants (over-broad reqId, stale digest, wrong key_id) can be constructed. The current REQ's
 * correct digest is `assertionGroundDigest([thatReqsSummary])`.
 */
function appendWaiver(
  paths: ProjectPaths,
  opts: {
    reqId: string;
    groundDigest: string;
    keyId: string;
    signWith?: KeyObject;
  },
): AssertionWaiver {
  const withPrev: Omit<AssertionWaiver, "signature" | "recordHash"> = {
    kind: "assertion-waiver",
    reqId: opts.reqId,
    groundDigest: opts.groundDigest,
    snapshot_coord: currentReceiptSnapshotCoord(paths),
    producer_kind: "external",
    key_id: opts.keyId,
    prevHash: readLastExternalAssertionWaiverRecordHash(paths),
  };
  const recordHash = computeAssertionWaiverRecordHash(withPrev);
  const line: AssertionWaiver = { ...withPrev, recordHash };
  if (opts.signWith) {
    line.signature = sign(null, Buffer.from(assertionWaiverCanonicalText(withPrev), "utf8"), opts.signWith).toString("base64");
  }
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.appendFileSync(assertionWaiversPath(paths), JSON.stringify(line) + "\n", "utf8");
  return line;
}

/** The CURRENT correct ground digest of a single REQ (`assertionGroundDigest([summary])`). */
function currentReqDigest(paths: ProjectPaths, reqId: string): string {
  const ground = computeAssertionPresenceGround(paths);
  const summary = ground.find((s) => s.reqId === reqId);
  expect(summary, `REQ ${reqId} must have a recomputed summary`).toBeDefined();
  return assertionGroundDigest([summary!]);
}

describe("BSC-2 negative-control (d): a bad waiver exempts NOTHING; a correct one DOES (positive control)", () => {
  /**
   * The assertion-free fixture: REQ-001's test body is TRIVIAL (`expect(true).toBe(true)`), so the
   * REQ is an offender. A receipt is minted (so the rung reaches the offender check, not the
   * no-receipt fail-closed). Without an exempting waiver the gate BLOCKS `assertion_presence_unverified`.
   */
  function assertionFreeFixture(): ProjectPaths {
    const paths = greenExceptAssertion({
      covBody: `// REQ-001\nimport { it, expect } from "vitest";\nit("trivial", () => {\n  expect(true).toBe(true);\n});\n`,
    });
    mintAssertionPresenceForFixture(paths); // receipt bound to the trivial body
    return paths;
  }

  it("baseline: the assertion-free REQ BLOCKS with no waiver (the offender is real)", () => {
    delete process.env.TH_BSC2_ENFORCE;
    const paths = assertionFreeFixture();
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("assertion_presence_unverified");
    expect((res.detail as { offenders?: string[] }).offenders).toContain("REQ-001");
  });

  it("(i) an UNSIGNED waiver exempts NOTHING (still blocks)", () => {
    delete process.env.TH_BSC2_ENFORCE;
    const paths = assertionFreeFixture();
    setVerifierKey(paths, K1.publicKey);
    appendWaiver(paths, { reqId: "REQ-001", groundDigest: currentReqDigest(paths, "REQ-001"), keyId: externalKeyId(K1.publicKey) }); // no signWith
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("assertion_presence_unverified");
  });

  it("(ii) a waiver signed by the WRONG key exempts NOTHING (still blocks)", () => {
    delete process.env.TH_BSC2_ENFORCE;
    const paths = assertionFreeFixture();
    setVerifierKey(paths, K1.publicKey); // verifier holds K1
    // Signed with K2; key_id still claims K1 so the shape passes but the signature cannot verify.
    appendWaiver(paths, { reqId: "REQ-001", groundDigest: currentReqDigest(paths, "REQ-001"), keyId: externalKeyId(K1.publicKey), signWith: K2.privateKey });
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("assertion_presence_unverified");
  });

  it("(iii) an OVER-BROAD waiver (empty reqId) exempts NOTHING (rejected by the shape check)", () => {
    delete process.env.TH_BSC2_ENFORCE;
    const paths = assertionFreeFixture();
    setVerifierKey(paths, K1.publicKey);
    // Even correctly signed by K1, an empty reqId is rejected (isValidAssertionWaiver: reqId !== "")
    // so it never enters the exempt set — an over-broad waiver covers nothing.
    appendWaiver(paths, { reqId: "", groundDigest: currentReqDigest(paths, "REQ-001"), keyId: externalKeyId(K1.publicKey), signWith: K1.privateKey });
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("assertion_presence_unverified");
    expect((res.detail as { offenders?: string[] }).offenders).toContain("REQ-001");
  });

  it("(iv) a DIGEST-MISMATCHED waiver (stale groundDigest) exempts NOTHING (still blocks)", () => {
    delete process.env.TH_BSC2_ENFORCE;
    const paths = assertionFreeFixture();
    setVerifierKey(paths, K1.publicKey);
    // Correctly signed by K1, but the groundDigest is a stale/bogus value that does not match the
    // REQ's CURRENT recomputed summary digest ⇒ digest-scoped check fails ⇒ exempts nothing.
    appendWaiver(paths, { reqId: "REQ-001", groundDigest: "a".repeat(64), keyId: externalKeyId(K1.publicKey), signWith: K1.privateKey });
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("assertion_presence_unverified");
  });

  it("POSITIVE control: a correctly-signed, digest-matching K1 waiver EXEMPTS the REQ (rendered waived, gate PASSES)", () => {
    delete process.env.TH_BSC2_ENFORCE;
    const paths = assertionFreeFixture();
    setVerifierKey(paths, K1.publicKey);
    appendWaiver(paths, {
      reqId: "REQ-001",
      groundDigest: currentReqDigest(paths, "REQ-001"), // matches the CURRENT recompute
      keyId: externalKeyId(K1.publicKey),
      signWith: K1.privateKey,
    });
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok, `expected the correctly-signed waiver to PASS, got error=${res.error}`).toBe(true);
    // The REQ is rendered `waived` in the observability summary.
    const req001 = (res.assertionPresence ?? []).find((s) => s.reqId === "REQ-001");
    expect(req001, "REQ-001 should appear in the assertionPresence summary").toBeDefined();
    expect(req001!.waived).toBe(true);
  });
});
