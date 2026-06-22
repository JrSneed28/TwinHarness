/**
 * Axis-B slice-4a (BSC-3) — VerificationDriver sensor + receipt store UNIT tests
 * (Lane D, plan §6). These exercise the sensor/store surface in
 * `src/core/verification-driver.ts` DIRECTLY (no gate, no flag): the schema/shape
 * guard, the shared `observedDimensionsFromReport` derivation, the canonical
 * text + record-hash stability, the tamper-detecting chain walk, the
 * `validateDriverReceiptContent` status matrix, and the refuse-at-creation
 * negative-control (`appendDriverReceipt` throws on a claim the report does not
 * observe / on missing evidence).
 *
 * The receipt's recomputable GROUND is `verify-report.json`'s per-command
 * `{command, exitCode, ok}` results — NEVER `tester-record.json` (binding there
 * would reproduce BSC-3 inside its own fix). Every fixture writes a real report so
 * the sensor reads an artifact, exactly as a trusted runner would have produced.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { makeTempProject, type TempProject } from "./helpers";
import { writeVerifyReport, verifyReportPath, type VerifyReport } from "../src/core/verify";
import {
  SEED_DIMENSIONS,
  SEED_DIMENSION_NAMES,
  observedDimensionsFromReport,
  observeDriverDimensions,
  appendDriverReceipt,
  readDriverReceipts,
  driverReceiptsPath,
  isValidDriverReceipt,
  driverCanonicalText,
  computeDriverRecordHash,
  verifyDriverChain,
  validateDriverReceiptContent,
  readLastDriverRecordHash,
  DimensionUnobservedError,
  EvidenceUnresolvedError,
  type DriverDimensionReceipt,
} from "../src/core/verification-driver";
import { GENESIS_PREV_HASH } from "../src/core/hash";

let tp: TempProject | undefined;
afterEach(() => {
  tp?.cleanup();
  tp = undefined;
});

/** Initialize a real git repo so the snapshot coordinate is non-null (mirrors receipts.test.ts). */
function initGitRepo(root: string): boolean {
  const run = (args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (run(["init"]).error) return false;
  run(["config", "user.email", "t@t.t"]);
  run(["config", "user.name", "t"]);
  run(["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(root, ".gitkeep"), "x\n", "utf8");
  run(["add", "-A"]);
  const c = run(["commit", "-m", "init", "--no-gpg-sign"]);
  return !(typeof c.status === "number" && c.status !== 0);
}

/** Build a verify report whose per-command results observe the named seed dimensions. */
function reportObserving(...dims: string[]): VerifyReport {
  const cmdFor: Record<string, string> = {
    "tests-executed": "vitest run",
    typecheck: "tsc --noEmit",
    build: "npm run build",
  };
  return {
    ok: true,
    ranAt: new Date().toISOString(),
    results: dims.map((d) => ({
      command: cmdFor[d] ?? d,
      exitCode: 0,
      ok: true,
      durationMs: 1,
      outputTail: "",
    })),
  };
}

/** A green project that has written a verify-report.json observing all three seed dimensions. */
function projectWithReport(...dims: string[]): TempProject {
  const t = makeTempProject();
  writeVerifyReport(t.paths, reportObserving(...(dims.length ? dims : SEED_DIMENSION_NAMES)));
  return t;
}

// ---------------------------------------------------------------------------
// Seed vocabulary + the shared observed-derivation
// ---------------------------------------------------------------------------

describe("seed dimension vocabulary", () => {
  it("seeds exactly the three slice-4a dimensions", () => {
    expect(SEED_DIMENSION_NAMES).toEqual(["tests-executed", "typecheck", "build"]);
    expect(SEED_DIMENSIONS.map((d) => d.name)).toEqual(SEED_DIMENSION_NAMES);
  });
});

describe("observedDimensionsFromReport — the SINGLE shared derivation (sensor + validator)", () => {
  it("observes a dimension iff a matching command ran AND passed (ok===true)", () => {
    expect([...observedDimensionsFromReport(reportObserving("tests-executed", "typecheck", "build"))].sort()).toEqual(
      ["build", "tests-executed", "typecheck"],
    );
  });

  it("a matching command that FAILED (ok===false) does NOT observe the dimension", () => {
    const report: VerifyReport = {
      ok: false,
      ranAt: new Date().toISOString(),
      results: [{ command: "vitest run", exitCode: 1, ok: false, durationMs: 1, outputTail: "fail" }],
    };
    expect(observedDimensionsFromReport(report).has("tests-executed")).toBe(false);
  });

  it("matches by case-insensitive substring against the dimension markers", () => {
    const report: VerifyReport = {
      ok: true,
      ranAt: new Date().toISOString(),
      results: [{ command: "Run TYPECHECK now", exitCode: 0, ok: true, durationMs: 1, outputTail: "" }],
    };
    expect(observedDimensionsFromReport(report).has("typecheck")).toBe(true);
  });

  it("a null/absent report observes NOTHING (fail-closed)", () => {
    expect(observedDimensionsFromReport(null).size).toBe(0);
    expect(observedDimensionsFromReport({ ok: true, ranAt: "", results: [] }).size).toBe(0);
  });
});

describe("observeDriverDimensions — the sensor reads verify-report.json", () => {
  it("returns one observed dimension per seed name evidenced by the report, bound to the report path", () => {
    tp = projectWithReport();
    const dims = observeDriverDimensions(tp.paths);
    expect(dims.map((d) => d.name).sort()).toEqual(["build", "tests-executed", "typecheck"]);
    for (const d of dims) {
      expect(d.observed).toBe(true);
      // The binding is the recomputable verify-report.json (NEVER tester-record.json).
      expect(d.evidenceRef).toContain("verify-report.json");
      expect(d.evidenceRef).not.toContain("tester-record");
    }
  });

  it("a partial report yields only the observed subset", () => {
    tp = projectWithReport("typecheck");
    expect(observeDriverDimensions(tp.paths).map((d) => d.name)).toEqual(["typecheck"]);
  });
});

// ---------------------------------------------------------------------------
// Canonical text + record hash (byte-stable; signing trailers excluded)
// ---------------------------------------------------------------------------

describe("driverCanonicalText + computeDriverRecordHash", () => {
  it("is deterministic and EXCLUDES the signature + recordHash trailers", () => {
    tp = projectWithReport();
    const r = appendDriverReceipt(tp.paths, { producerIdentity: "unit" });
    const { recordHash, ...rest } = r;
    const canon = driverCanonicalText(rest);
    // recordHash is the SHA-256 of the canonical text.
    expect(computeDriverRecordHash(rest)).toBe(recordHash);
    // A signature trailer never enters the canonical text (4a receipts carry none).
    expect(canon).not.toContain("signature");
    expect(canon).not.toContain("recordHash");
    // Adding signing fields as `undefined` does not change the canonical bytes.
    const withUndef = { ...rest, producer_kind: rest.producer_kind, key_id: undefined, signature: undefined };
    expect(driverCanonicalText(withUndef as typeof rest)).toBe(canon);
  });
});

// ---------------------------------------------------------------------------
// isValidDriverReceipt — shape guard
// ---------------------------------------------------------------------------

describe("isValidDriverReceipt — schema/shape validation", () => {
  it("accepts a sealed in-process receipt", () => {
    tp = projectWithReport();
    const r = appendDriverReceipt(tp.paths, { producerIdentity: "unit" });
    expect(isValidDriverReceipt(r)).toBe(true);
  });

  it("rejects wrong kind / missing refId / bad hashes / a non-observed dimension row", () => {
    tp = projectWithReport();
    const r = appendDriverReceipt(tp.paths, { producerIdentity: "unit" });
    expect(isValidDriverReceipt({ ...r, kind: "terminal-transition" })).toBe(false);
    expect(isValidDriverReceipt({ ...r, refId: "" })).toBe(false);
    expect(isValidDriverReceipt({ ...r, prevHash: "nothex" })).toBe(false);
    expect(isValidDriverReceipt({ ...r, recordHash: "nothex" })).toBe(false);
    // A dimension row MUST be observed:true with a non-empty evidenceRef.
    expect(isValidDriverReceipt({ ...r, dimensions: [{ name: "x", observed: false, evidenceRef: "y" }] })).toBe(false);
    expect(isValidDriverReceipt({ ...r, dimensions: [{ name: "", observed: true, evidenceRef: "y" }] })).toBe(false);
    expect(isValidDriverReceipt({ ...r, snapshot_coord: null })).toBe(false);
  });

  it("rejects a malformed signature but accepts the optional signing fields absent", () => {
    tp = projectWithReport();
    const r = appendDriverReceipt(tp.paths, { producerIdentity: "unit" });
    expect(isValidDriverReceipt({ ...r, signature: "tooshort" })).toBe(false);
    expect(isValidDriverReceipt({ ...r, producer_kind: "bogus" })).toBe(false);
    expect(isValidDriverReceipt({ ...r, key_id: 5 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// appendDriverReceipt — sensor + refuse-at-creation (the 4a negative-control)
// ---------------------------------------------------------------------------

describe("appendDriverReceipt — sensor records observed dimensions, refuses claims it cannot observe", () => {
  it("records every observed dimension when no explicit claim is given", () => {
    tp = projectWithReport();
    const r = appendDriverReceipt(tp.paths, { producerIdentity: "runner" });
    expect(r.kind).toBe("driver-dimension");
    expect(r.producer_kind).toBe("in-process");
    expect(r.dimensions.map((d) => d.name).sort()).toEqual(["build", "tests-executed", "typecheck"]);
    expect(readDriverReceipts(tp.paths)).toHaveLength(1);
  });

  it("records the claimed SUBSET when it is observed", () => {
    tp = projectWithReport();
    const r = appendDriverReceipt(tp.paths, { producerIdentity: "runner", dimensionNames: ["typecheck"] });
    expect(r.dimensions.map((d) => d.name)).toEqual(["typecheck"]);
  });

  it("REFUSES (throws DimensionUnobservedError) a claim the report does not observe — the negative-control", () => {
    tp = projectWithReport("typecheck"); // only typecheck observed
    try {
      appendDriverReceipt(tp.paths, { producerIdentity: "liar", dimensionNames: ["typecheck", "build"] });
      throw new Error("expected DimensionUnobservedError");
    } catch (e) {
      expect(e).toBeInstanceOf(DimensionUnobservedError);
      expect((e as DimensionUnobservedError).code).toBe("driver_dimension_unobserved");
      expect((e as DimensionUnobservedError).unobserved).toEqual(["build"]);
    }
    // Refuse-at-creation: NOTHING was written.
    expect(fs.existsSync(driverReceiptsPath(tp.paths))).toBe(false);
  });

  it("REFUSES (throws EvidenceUnresolvedError) when verify-report.json does not resolve", () => {
    tp = makeTempProject(); // no report written
    try {
      appendDriverReceipt(tp.paths, { producerIdentity: "runner" });
      throw new Error("expected EvidenceUnresolvedError");
    } catch (e) {
      expect(e).toBeInstanceOf(EvidenceUnresolvedError);
      expect((e as EvidenceUnresolvedError).code).toBe("driver_evidence_unresolved");
    }
    expect(fs.existsSync(driverReceiptsPath(tp.paths))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// verifyDriverChain — tamper walk
// ---------------------------------------------------------------------------

describe("verifyDriverChain — tamper-detecting walk", () => {
  it("an empty chain and a single genuine append both verify; prevHash seeds from GENESIS", () => {
    tp = projectWithReport();
    expect(verifyDriverChain([])).toEqual({ ok: true });
    expect(readLastDriverRecordHash(tp.paths)).toBe(GENESIS_PREV_HASH);
    const r = appendDriverReceipt(tp.paths, { producerIdentity: "unit" });
    expect(r.prevHash).toBe(GENESIS_PREV_HASH);
    expect(verifyDriverChain(readDriverReceipts(tp.paths))).toEqual({ ok: true });
    expect(readLastDriverRecordHash(tp.paths)).toBe(r.recordHash);
  });

  it("an EDITED record (recordHash no longer matches its canonical text) breaks the chain", () => {
    tp = projectWithReport();
    const r = appendDriverReceipt(tp.paths, { producerIdentity: "unit" });
    const tampered: DriverDimensionReceipt = { ...r, producer_identity: "someone-else" };
    const res = verifyDriverChain([tampered]);
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ brokenAt: 0, reason: "edited" });
  });

  it("a prevHash that does not chain (insert/delete/reorder) breaks with prev_mismatch", () => {
    tp = projectWithReport();
    const a = appendDriverReceipt(tp.paths, { producerIdentity: "unit" });
    // A second receipt whose recordHash is self-consistent but whose prevHash is wrong.
    const { recordHash: _omit, ...restB } = a;
    const forgedPrev = { ...restB, prevHash: "f".repeat(64) };
    const b: DriverDimensionReceipt = { ...forgedPrev, recordHash: computeDriverRecordHash(forgedPrev) };
    const res = verifyDriverChain([a, b]);
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ brokenAt: 1, reason: "prev_mismatch" });
  });
});

// ---------------------------------------------------------------------------
// validateDriverReceiptContent — the status matrix (the F8 recomputable ground)
// ---------------------------------------------------------------------------

describe("validateDriverReceiptContent — status matrix", () => {
  it("valid — every recorded dimension is still observed, evidence resolves, snapshot matches", () => {
    tp = projectWithReport();
    const r = appendDriverReceipt(tp.paths, { producerIdentity: "unit" });
    expect(validateDriverReceiptContent(tp.paths, r).status).toBe("valid");
  });

  it("dimension_unobserved — a recorded dimension the CURRENT report no longer evidences", () => {
    tp = projectWithReport(); // all three observed at mint time
    const r = appendDriverReceipt(tp.paths, { producerIdentity: "unit" });
    // Re-write the report so it no longer observes `build` (drop the build command).
    writeVerifyReport(tp.paths, reportObserving("tests-executed", "typecheck"));
    const res = validateDriverReceiptContent(tp.paths, r);
    expect(res.status).toBe("dimension_unobserved");
    expect(res.unobservedDimensions).toEqual(["build"]);
  });

  it("evidence_missing — the bound verify-report.json no longer resolves in source", () => {
    tp = projectWithReport();
    const r = appendDriverReceipt(tp.paths, { producerIdentity: "unit" });
    // Delete the bound evidence artifact (the receipt object is still in hand).
    fs.rmSync(verifyReportPath(tp.paths), { force: true });
    expect(validateDriverReceiptContent(tp.paths, r).status).toBe("evidence_missing");
  });

  it("stale — a divergent NON-NULL snapshot coordinate (recorded ≠ current, both non-null) under git", () => {
    tp = makeTempProject();
    if (!initGitRepo(tp.root)) return; // git unavailable → covered by the off-git non-discriminating case
    writeVerifyReport(tp.paths, reportObserving());
    const r = appendDriverReceipt(tp.paths, { producerIdentity: "unit" });
    // The recorded coord now matches the repo's current head. Hand-seal a divergent one
    // (both sides non-null) so the ONLY failing rung is staleness — dimensions still observe.
    const { recordHash: _omit, ...rest } = r;
    const forcedRest = { ...rest, snapshot_coord: { gitHead: "0".repeat(40), treeDigest: "0".repeat(64) } };
    const forced: DriverDimensionReceipt = { ...forcedRest, recordHash: computeDriverRecordHash(forcedRest) };
    const res = validateDriverReceiptContent(tp.paths, forced);
    expect(res.status).toBe("stale");
    expect(res.staleReasons).toContain("gitHead");
  });

  it("NOT stale when the recorded coordinate is null (off-git, non-discriminating, F8 honesty)", () => {
    tp = projectWithReport(); // off-git → current coord is null/null
    const r = appendDriverReceipt(tp.paths, { producerIdentity: "unit" });
    expect(r.snapshot_coord.gitHead).toBeNull();
    expect(validateDriverReceiptContent(tp.paths, r).status).toBe("valid");
  });
});
