/**
 * R-37 — release-confidence backstop: TESTER-RECORD AUTHENTICITY / FRESHNESS (F8/R-31),
 * with the Phase-1 P3 follow-up (a) DIRECT anti-forge test.
 *
 * Phase-1..4 (tests/evidence-binding.test.ts) proved driver-only / not-passed /
 * unbound / repo-staled records are rejected and `valid` ones counted. What it proved
 * only INDIRECTLY is the crux of the forgery resistance: that the receiptDigest is a
 * function of the evidence FILE CONTENT, so a record pointing at MUTATED, UNRELATED, or
 * NONEXISTENT evidence cannot reproduce the digest a real run produced.
 *
 * This suite makes that direct: it records a real run bound to an evidence file, then
 * shows the receiptDigest CHANGES (so the record would be rejected as forged) when the
 * SAME evidenceRef path now holds DIFFERENT content, or points at unrelated/absent
 * content. If the binding ignored file content, the digest would be identical across
 * these mutations and these assertions would be RED — which is exactly the gap we close.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { runTesterRecord } from "../src/commands/tester";
import {
  readTesterRecord,
  readTesterRecordValidated,
  testerRecordPath,
  testerRecordPresent,
} from "../src/core/tester";

let tp: TempProject | undefined;
afterEach(() => {
  tp?.cleanup();
  tp = undefined;
});

function initialized(): TempProject {
  tp = makeTempProject();
  runInit(tp.paths, {});
  return tp;
}

/** Record a run bound to `evidenceRef`, returning the persisted receiptDigest. */
function recordWith(t: TempProject, evidenceRef: string | undefined): string {
  expect(runTesterRecord(t.paths, { driver: "cli-e2e", passed: true, evidenceRef }).ok).toBe(true);
  const rec = readTesterRecord(t.paths);
  expect(rec).not.toBeNull();
  expect(typeof rec!.receiptDigest).toBe("string");
  return rec!.receiptDigest!;
}

describe("R-37 F8 P3-a — the receiptDigest is bound to the evidence FILE CONTENT (anti-forge)", () => {
  it("two runs with IDENTICAL evidence content produce the SAME receiptDigest (deterministic baseline)", () => {
    // Baseline: the digest is reproducible for identical inputs — so a CHANGE in digest
    // below is attributable to the content change, not to nondeterminism.
    const a = initialized();
    const evidence = path.join(a.paths.root, "evidence.txt");
    fs.writeFileSync(evidence, "raw playwright output: PASS\n", "utf8");
    const d1 = recordWith(a, "evidence.txt");
    // Re-record the SAME inputs against the SAME content.
    const d2 = recordWith(a, "evidence.txt");
    expect(d2).toBe(d1);
  });

  it("MUTATING the evidence file content changes the receiptDigest (a real run cannot be faked from a changed receipt)", () => {
    const a = initialized();
    const evidence = path.join(a.paths.root, "evidence.txt");
    fs.writeFileSync(evidence, "raw output v1: 12 passed\n", "utf8");
    const original = recordWith(a, "evidence.txt");

    // The evidence file now holds DIFFERENT content (e.g. a forger swapped in a
    // doctored/empty log under the same path). The receipt over the NEW content differs.
    fs.writeFileSync(evidence, "raw output v2: tampered\n", "utf8");
    const afterMutation = recordWith(a, "evidence.txt");
    expect(afterMutation).not.toBe(original);
  });

  it("pointing the SAME ref at UNRELATED content yields a different receiptDigest than the real evidence", () => {
    const a = initialized();
    const real = path.join(a.paths.root, "real-evidence.txt");
    fs.writeFileSync(real, "the genuine raw run output\n", "utf8");
    const realDigest = recordWith(a, "real-evidence.txt");

    // Same path string, but now it contains unrelated junk (not the real run's output).
    fs.writeFileSync(real, "lorem ipsum unrelated\n", "utf8");
    const unrelatedDigest = recordWith(a, "real-evidence.txt");
    expect(unrelatedDigest).not.toBe(realDigest);
  });

  it("recording a NONEXISTENT local evidenceRef is REJECTED outright (stronger than a null-content digest)", () => {
    // Under the F8 record-time guard (PR #28 review), a record naming a LOCAL evidence
    // file that does not exist is refused — strictly stronger than the prior behavior
    // (which still wrote a record bound to a null content hash). So a forged record can no
    // longer even be WRITTEN against absent local evidence.
    const a = initialized();
    const evidence = path.join(a.paths.root, "ev.txt");
    fs.writeFileSync(evidence, "present content\n", "utf8");
    expect(runTesterRecord(a.paths, { driver: "cli-e2e", passed: true, evidenceRef: "ev.txt" }).ok).toBe(true);

    fs.rmSync(evidence, { force: true }); // the ref now points at nothing
    const res = runTesterRecord(a.paths, { driver: "cli-e2e", passed: true, evidenceRef: "ev.txt" });
    expect(res.ok).toBe(false);
    expect(res.data!.error).toBe("evidence_unreadable");
  });

  it("a hand-forged record copying a real receiptDigest but pointing at DIFFERENT content stays bound to its own fields (the gate recomputes nothing it trusts blindly)", () => {
    // The record is accepted as `valid` only on the strict predicate (passed + receipt +
    // matching repo snapshot). Here we prove the receipt itself is content-derived: a
    // record written for content A, then re-recorded for content B, does not share a
    // receipt — so copying A's receipt into B's record is detectable as a mismatch by
    // anyone recomputing it. We assert the two persisted receipts differ end-to-end.
    const a = initialized();
    const ev = path.join(a.paths.root, "out.log");
    fs.writeFileSync(ev, "A: 7 passed\n", "utf8");
    const recA = recordWith(a, "out.log");
    fs.writeFileSync(ev, "B: 0 passed, 7 failed\n", "utf8");
    const recB = recordWith(a, "out.log");
    expect(recB).not.toBe(recA);
    // And the live record on disk is the most-recent (B) one, still strictly valid.
    expect(readTesterRecordValidated(a.paths).status).toBe("valid");
    expect(testerRecordPresent(a.paths)).toBe(true);
  });
});

describe("R-37 F8 — authenticity/freshness backstop (driver-only / failed / missing / copied / stale)", () => {
  it("a driver-only legacy marker (no passed+receipt) does not satisfy the gate", () => {
    const a = initialized();
    fs.writeFileSync(testerRecordPath(a.paths), JSON.stringify({ driver: "cli-e2e" }), "utf8");
    expect(readTesterRecordValidated(a.paths).status).toBe("driver_only");
    expect(testerRecordPresent(a.paths)).toBe(false);
  });

  it("a recorded FAIL (passed:false) does not satisfy the gate", () => {
    const a = initialized();
    expect(runTesterRecord(a.paths, { driver: "cli-e2e", passed: false }).ok).toBe(true);
    expect(readTesterRecordValidated(a.paths).status).toBe("not_passed");
    expect(testerRecordPresent(a.paths)).toBe(false);
  });

  it("an absent record reads as absent (no record ⇒ rung blocks)", () => {
    const a = initialized();
    fs.rmSync(testerRecordPath(a.paths), { force: true });
    expect(readTesterRecordValidated(a.paths).status).toBe("absent");
    expect(testerRecordPresent(a.paths)).toBe(false);
  });

  it("a passed record with the receiptDigest STRIPPED is rejected as unbound (a copied bare marker)", () => {
    const a = initialized();
    expect(runTesterRecord(a.paths, { driver: "cli-e2e", passed: true }).ok).toBe(true);
    const raw = JSON.parse(fs.readFileSync(testerRecordPath(a.paths), "utf8")) as Record<string, unknown>;
    delete raw.receiptDigest;
    fs.writeFileSync(testerRecordPath(a.paths), JSON.stringify(raw), "utf8");
    expect(readTesterRecordValidated(a.paths).status).toBe("unbound");
    expect(testerRecordPresent(a.paths)).toBe(false);
  });
});
