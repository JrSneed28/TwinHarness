/**
 * BSC-6 (Axis-B slice-2a) — the SCAN-COVERAGE GATE + negative-control suite.
 *
 * Slice-2a adds condition-5 (`scan_coverage_incomplete`) to `checkProductionReality`:
 * any enumerated `dist/` path the two-tier scan could NOT deep-inspect (per-file /
 * aggregate / watchdog / read error) is `unobserved` (≠ clean) and BLOCKS completion
 * unless exonerated by a valid external-signed exception ack. The rung RECOMPUTES the
 * residual fresh every run and has ZERO `scan-completeness.jsonl` authority — trusting
 * a persisted "complete" summary is the exact bug class BSC-6 is.
 *
 * Strategy mirrors `receipts-negative-controls.test.ts` / `production-reality.test.ts`:
 * build a project whose ENTIRE final-verification ladder is green EXCEPT the scan-
 * coverage rung, then drive exactly ONE coverage gap (via the `TH_SCAN_*` env seam or a
 * POSIX chmod) and assert the stable token. Each `it` is its own control. Every test
 * that sets a `TH_SCAN_*` env var restores it in `finally` (committed-`dist/`
 * determinism depends on these being UNSET in normal operation + on CI).
 *
 * The "MCP twin" is the pure reader `runGateProductionReality` (`src/commands/gate.ts`):
 * per its header it runs the SAME `checkProductionReality` predicate the typed MCP gate
 * tools inherit through the composed ladder, so its token must equal the CLI path's.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, mintRequiredApprovals, type TempProject } from "./helpers";
import { writeState, readState } from "../src/core/state-store";
import { initialState, type TwinHarnessState } from "../src/core/state-schema";
import { runArtifactRegister } from "../src/commands/artifact";
import { runTesterRecord } from "../src/commands/tester";
import { checkProductionReality } from "../src/core/gate-preconditions";
import { runGateProductionReality } from "../src/commands/gate";
import { scanForSimulationHits } from "../src/commands/sim";
import { scanCompletenessPath } from "../src/core/scan-completeness";
import { hashFileStreaming } from "../src/core/hash";
import type { ProjectPaths } from "../src/core/paths";

const isWin = process.platform === "win32";

let tp: TempProject | undefined;
afterEach(() => {
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

/** Attach a VALID live-QA Tester record (production-reality condition 3). */
function attachTesterRecord(paths: ProjectPaths): void {
  expect(runTesterRecord(paths, { driver: "cli-e2e", provider: "sandbox", passed: true }).ok).toBe(true);
}

/**
 * A project whose entire final-verification ladder is GREEN — slices settled, no verify
 * config (vacuously green), coverage clean (REQ-001 planned+tested), the report
 * registered, a Tester record attached, and (by default) NO dist/ — so the ONLY
 * remaining lever is a scan-coverage condition the caller perturbs.
 * Replicated from `production-reality.test.ts:greenAtFinalVerification` (not exported).
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
  const reg = runArtifactRegister(paths, "docs/10-verification-report.md", 1);
  expect(reg.ok).toBe(true);
  attachTesterRecord(paths);
  // BSC-7 slice-3a C-2: mint the closed human-approval required-set (docs-only placeholders,
  // never touching dist/) so the completion rung passes and scan-coverage stays the lever.
  mintRequiredApprovals(paths, state(paths));
  return paths;
}

/**
 * Set the `TH_SCAN_*` env vars for the duration of `fn`, then restore EXACTLY (a saved
 * `undefined` is deleted again). Guards committed-`dist/` determinism: no override may
 * leak to another test. Restores even if `fn` throws.
 */
function withScanEnv<T>(overrides: Record<string, string>, fn: () => T): T {
  const keys = Object.keys(overrides);
  const prior: Record<string, string | undefined> = {};
  for (const k of keys) prior[k] = process.env[k];
  for (const k of keys) process.env[k] = overrides[k];
  try {
    return fn();
  } finally {
    for (const k of keys) {
      const was = prior[k];
      if (was === undefined) delete process.env[k];
      else process.env[k] = was;
    }
  }
}

// ===========================================================================
// (a) per-file limit → scan_coverage_incomplete (reason file_limit)
// ===========================================================================
describe("control (a) — a per-file budget leaves a dist file unobserved → scan_coverage_incomplete", () => {
  it("TH_SCAN_FILE_MAX_BYTES=10 caps a token-bearing dist file → checkProductionReality blocks with scan_coverage_incomplete", () => {
    const paths = greenAtFinalVerification();
    // A tiny token-bearing dist file just over a 10-byte per-file budget. Because it is
    // OVER budget it is never deep-inspected, so its token cannot reach the unledgered
    // rung (4) — the coverage rung (5) is what bites. (Proven by asserting the token.)
    writeFile(paths, "dist/big.js", "const m = stubProvider(); // placeholder\n");
    withScanEnv({ TH_SCAN_FILE_MAX_BYTES: "10" }, () => {
      const res = checkProductionReality(paths, state(paths));
      expect(res.ok).toBe(false);
      expect(res.error).toBe("scan_coverage_incomplete");
      expect((res.detail!.reasons as string[])).toContain("file_limit");
      expect((res.detail!.unobserved as Array<{ path: string }>).some((u) => u.path === "dist/big.js")).toBe(true);
    });
    // Sanity: with the override RESTORED, the same file is deep-inspectable and the gate
    // is no longer blocked by coverage (it would now be the unledgered rung — see (e)).
    expect(checkProductionReality(paths, state(paths)).error).not.toBe("scan_coverage_incomplete");
  });
});

// ===========================================================================
// (b) aggregate limit → scan_coverage_incomplete (reason aggregate_limit)
// ===========================================================================
describe("control (b) — an aggregate budget leaves the remainder unobserved → scan_coverage_incomplete", () => {
  it("TH_SCAN_AGGREGATE_MAX_BYTES=10 exhausts the aggregate budget → block with reason aggregate_limit", () => {
    const paths = greenAtFinalVerification();
    // Two token-free dist files; a 10-byte aggregate budget cannot deep-inspect both, so
    // at least one remains unobserved{aggregate_limit}. Token-free keeps rung 4 silent so
    // the block is unambiguously the coverage rung.
    writeFile(paths, "dist/a.js", "const a = 1;\n");
    writeFile(paths, "dist/b.js", "const b = 2;\n");
    withScanEnv({ TH_SCAN_AGGREGATE_MAX_BYTES: "10" }, () => {
      const res = checkProductionReality(paths, state(paths));
      expect(res.ok).toBe(false);
      expect(res.error).toBe("scan_coverage_incomplete");
      expect((res.detail!.reasons as string[])).toContain("aggregate_limit");
    });
  });
});

// ===========================================================================
// (b2) watchdog → scan_coverage_incomplete (reason watchdog)
// ===========================================================================
describe("control (b2) — a 0 ms watchdog leaves files unobserved → scan_coverage_incomplete", () => {
  it("TH_SCAN_WATCHDOG_MS=0 trips the watchdog before any file is deep-inspected → block with reason watchdog", () => {
    const paths = greenAtFinalVerification();
    writeFile(paths, "dist/a.js", "const a = 1;\n");
    writeFile(paths, "dist/b.js", "const b = 2;\n");
    withScanEnv({ TH_SCAN_WATCHDOG_MS: "0" }, () => {
      const res = checkProductionReality(paths, state(paths));
      expect(res.ok).toBe(false);
      expect(res.error).toBe("scan_coverage_incomplete");
      expect((res.detail!.reasons as string[])).toContain("watchdog");
    });
  });
});

// ===========================================================================
// (c) read error (POSIX-only) → scan_coverage_incomplete (reason read_error)
// ===========================================================================
describe("control (c) — an unreadable dist file is unobserved → scan_coverage_incomplete (POSIX perms)", () => {
  it.skipIf(isWin)("chmod 0 on a dist file makes Pass-A/B read fail → block with reason read_error", () => {
    const paths = greenAtFinalVerification();
    const abs = path.resolve(paths.root, "dist/locked.js");
    writeFile(paths, "dist/locked.js", "const x = 1;\n");
    fs.chmodSync(abs, 0o000);
    try {
      const res = checkProductionReality(paths, state(paths));
      expect(res.ok).toBe(false);
      expect(res.error).toBe("scan_coverage_incomplete");
      expect((res.detail!.reasons as string[])).toContain("read_error");
      expect((res.detail!.unobserved as Array<{ path: string }>).some((u) => u.path === "dist/locked.js")).toBe(true);
    } finally {
      fs.chmodSync(abs, 0o644); // restore so cleanup can remove it
      // Isolation: once readable, the same file must not block on coverage.
      expect(checkProductionReality(paths, state(paths)).error).not.toBe("scan_coverage_incomplete");
    }
  });
});

describe("control (c2) — an unreadable dist directory is unobserved → scan_coverage_incomplete (POSIX perms)", () => {
  it.skipIf(isWin)("chmod 0 on a dist subdirectory blocks with reason read_error", () => {
    const paths = greenAtFinalVerification();
    writeFile(paths, "dist/ok.js", "const ok = 1;\n");
    const blockedDir = path.resolve(paths.root, "dist", "blocked");
    writeFile(paths, "dist/blocked/hidden.js", "const hidden = 1;\n");
    fs.chmodSync(blockedDir, 0o000);
    try {
      const res = checkProductionReality(paths, state(paths));
      expect(res.ok).toBe(false);
      expect(res.error).toBe("scan_coverage_incomplete");
      expect((res.detail!.reasons as string[])).toContain("read_error");
      expect((res.detail!.unobserved as Array<{ path: string }>).some((u) => u.path === "dist/blocked")).toBe(true);
    } finally {
      fs.chmodSync(blockedDir, 0o755); // restore so cleanup can remove it
    }
  });
});

// ===========================================================================
// (d) a clean, fully-observed dist/ → ok:true (no env override)
// ===========================================================================
describe("control (d) — a fully deep-inspected, token-free dist/ passes the gate", () => {
  it("no env override + token-free dist files are all deep-inspected → checkProductionReality returns ok:true", () => {
    const paths = greenAtFinalVerification();
    writeFile(paths, "dist/a.js", "const a = 1;\n");
    writeFile(paths, "dist/b.js", "const b = 2;\n");
    // Sanity: the default budget deep-inspects everything (nothing unobserved).
    const cov = scanForSimulationHits(paths);
    expect(cov.unobserved).toEqual([]);
    expect(checkProductionReality(paths, state(paths))).toEqual({ ok: true });
  });
});

// ===========================================================================
// (e) the unledgered rung (4) still bites ON ITS OWN — independent of rung 5.
// ===========================================================================
describe("control (e) — a within-budget token-bearing dist file blocks on the UNLEDGERED rung, not coverage", () => {
  it("no env override → the token-bearing file IS deep-inspected → unledgered_simulation_in_dist (rung 5 never reached)", () => {
    const paths = greenAtFinalVerification();
    // Small enough to be deep-inspected under the default budget, so it is NOT unobserved;
    // it carries an undeclared simulation token → the unledgered rung (4) fires FIRST,
    // proving that rung still bites independently of the new coverage rung (5).
    writeFile(paths, "dist/payments.js", "const v = stubProvider(); // placeholder\n");
    // It is deep-inspected (nothing unobserved) — so a coverage block is impossible here.
    expect(scanForSimulationHits(paths).unobserved).toEqual([]);
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("unledgered_simulation_in_dist");
  });
});

// ===========================================================================
// (f) THE KEY NEGATIVE CONTROL — a forged scan-completeness.jsonl is IGNORED.
// ===========================================================================
describe("control (f) — a forged scan-completeness.jsonl claiming 'all clean' has ZERO gate authority", () => {
  it("a real unobserved dist file + a forged receipt saying unobserved:[] → gate STILL blocks (recomputed, never read)", () => {
    const paths = greenAtFinalVerification();
    // A real, token-free dist file driven unobserved via the per-file budget.
    writeFile(paths, "dist/unseen.js", "const a = 1;\n");
    const digest = hashFileStreaming(path.resolve(paths.root, "dist/unseen.js"));

    withScanEnv({ TH_SCAN_FILE_MAX_BYTES: "1" }, () => {
      // The scan genuinely sees the file as unobserved (fail-closed).
      const cov = scanForSimulationHits(paths);
      expect(cov.unobserved.some((u) => u.path === "dist/unseen.js")).toBe(true);

      // FORGE a shape-valid incomplete-scan receipt LYING that nothing is unobserved
      // (and that all limits/dimensions are clean). This is exactly the persisted
      // "complete" summary BSC-6 must never trust. Written DIRECTLY to its on-disk path
      // (an attacker-style append), bypassing appendScanCompletenessReceipt.
      fs.mkdirSync(paths.stateDir, { recursive: true });
      const forged = {
        unobserved: [],
        limits_reached: [],
        unproven_dimensions: [],
        snapshot_coord: { gitHead: null, treeDigest: null },
        recordedAt: new Date().toISOString(),
      };
      fs.writeFileSync(scanCompletenessPath(paths), JSON.stringify(forged) + "\n", "utf8");
      // The forged file is on disk and parses as the "all clean" lie...
      expect(fs.existsSync(scanCompletenessPath(paths))).toBe(true);

      // ...yet the gate RECOMPUTES the residual fresh and STILL blocks (it never reads
      // that store to decide — zero gate authority). The digest binding is irrelevant
      // because no external-signed ack exists; the forged receipt cannot exonerate.
      const res = checkProductionReality(paths, state(paths));
      expect(res.ok).toBe(false);
      expect(res.error).toBe("scan_coverage_incomplete");
      expect((res.detail!.unobserved as Array<{ path: string }>).some((u) => u.path === "dist/unseen.js")).toBe(true);
      // Pin the binding the forgery cannot satisfy: the recomputed gap is over THIS digest.
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
    });
  });
});

// ===========================================================================
// (g) MCP twin parity — runGateProductionReality === CLI/checkProductionReality verdict.
// ===========================================================================
describe("control (g) — the MCP twin (runGateProductionReality) returns the IDENTICAL verdict", () => {
  it("file_limit-block case: the pure reader reports scan_coverage_incomplete, matching checkProductionReality", () => {
    const paths = greenAtFinalVerification();
    writeFile(paths, "dist/big.js", "const a = 1;\n");
    withScanEnv({ TH_SCAN_FILE_MAX_BYTES: "1" }, () => {
      const cli = checkProductionReality(paths, state(paths));
      expect(cli.error).toBe("scan_coverage_incomplete");
      const twin = runGateProductionReality(paths);
      expect(twin.ok).toBe(false);
      expect(twin.data!.error).toBe(cli.error); // identical token
      expect(twin.data!.gate).toBe("production-reality");
    });
  });

  it("clean-ok case: the pure reader passes, matching checkProductionReality ok:true", () => {
    const paths = greenAtFinalVerification();
    writeFile(paths, "dist/a.js", "const a = 1;\n");
    const cli = checkProductionReality(paths, state(paths));
    expect(cli).toEqual({ ok: true });
    const twin = runGateProductionReality(paths);
    expect(twin.ok).toBe(true);
    expect(twin.data!.ok).toBe(true);
    expect(twin.data!.gate).toBe("production-reality");
  });
});
