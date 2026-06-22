/**
 * BSC-6 (Axis-B slice-2a) — DETERMINISM of the two-tier scan across runner conditions.
 *
 * The scan verdict must be reproducible regardless of the machine it runs on:
 *   1. `readdir` order varies by platform, so enumeration sorts by relpath — the same
 *      snapshot must yield a byte-identical {@link ScanCoverage} every call, with the
 *      enumerated set in canonical (sorted) order.
 *   2. The wall-clock watchdog is an operational SAFETY net only, never a coverage
 *      determinant — below its budget, NO timing injection (`now` / `deepInspectDelayMs`)
 *      may change the verdict or leak a `watchdog` reason into `unobserved`.
 *   3. The REAL committed `dist/` completes far inside the watchdog, so a `watchdog`
 *      reason there would signal genuine timing-induced flakiness — assert its absence.
 *
 * Reuses the temp-repo / dist-fixture idiom of `sim-scan-coverage.test.ts`.
 */
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempProject, type TempProject } from "./helpers";
import { resolveProjectPaths } from "../src/core/paths";
import { scanForSimulationHits } from "../src/commands/sim";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

let tp: TempProject | undefined;
afterEach(() => {
  tp?.cleanup();
  tp = undefined;
});

function writeDist(root: string, rel: string, content: string): string {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

/**
 * A fixture with a mix of token-bearing and token-free files at varied relpaths,
 * including nested subdirs, so the relpath sort (not readdir order) is what makes the
 * descriptor canonical. The relpaths are deliberately authored OUT of sorted order.
 */
function buildVariedFixture(root: string): void {
  writeDist(root, "dist/z.js", "const z = 1;\n");
  writeDist(root, "dist/a.js", "const a = 1; // placeholder real impl pending\n");
  writeDist(root, "dist/sub/m.js", "const m = 2;\n");
  writeDist(root, "dist/sub/deep/inner.js", "const inner = 3; // stub\n");
  writeDist(root, "dist/b.js", "const b = 4;\n");
  writeDist(root, "dist/sub/a.js", "const sa = 5;\n");
  writeDist(root, "dist/notes.txt", "ignored (non-scan extension)\n");
}

describe("scan determinism — same snapshot yields a byte-identical descriptor", () => {
  it("(1) N repeated scans of an unchanged snapshot are deeply equal in every field", () => {
    tp = makeTempProject();
    buildVariedFixture(tp.root);

    const first = scanForSimulationHits(tp.paths);
    const second = scanForSimulationHits(tp.paths);
    const third = scanForSimulationHits(tp.paths);

    // Whole-descriptor equality covers enumerated (paths + order + digests),
    // deepInspected, distHits, testHits, unobserved, and limitHit at once.
    expect(second).toEqual(first);
    expect(third).toEqual(first);

    // Spell out the load-bearing fields explicitly so a regression names the culprit.
    expect(second.enumerated).toEqual(first.enumerated);
    expect(second.deepInspected).toEqual(first.deepInspected);
    expect(second.distHits).toEqual(first.distHits);
    expect(second.testHits).toEqual(first.testHits);
    expect(second.unobserved).toEqual(first.unobserved);
    expect(second.limitHit).toEqual(first.limitHit);
  });

  it("(2) enumerated is in canonical (sorted-by-relpath) order, not readdir order", () => {
    tp = makeTempProject();
    buildVariedFixture(tp.root);

    const cov = scanForSimulationHits(tp.paths);
    const order = cov.enumerated.map((e) => e.path);
    expect(order).toEqual(order.slice().sort());
    // The fixture was authored out of order; the sort must surface the canonical layout.
    expect(order).toEqual([
      "dist/a.js",
      "dist/b.js",
      "dist/sub/a.js",
      "dist/sub/deep/inner.js",
      "dist/sub/m.js",
      "dist/z.js",
    ]);
  });
});

describe("scan determinism — timing is verdict-invariant below the watchdog", () => {
  it("(3) different injected timing yields an IDENTICAL verdict and no watchdog reason", () => {
    tp = makeTempProject();
    buildVariedFixture(tp.root);

    // A generous watchdog (1 hour) that the synthetic latencies below never approach,
    // so the watchdog is provably untripped while the timing inputs vary widely.
    const generous = { watchdogMs: 3_600_000 };

    // Each injection drives `now`/`deepInspectDelayMs` differently, but all stay far
    // under the generous watchdog (6 files * 250 ms = 1.5 s << 3.6e6 ms).
    const injections = [
      {}, // real Date.now, no synthetic latency (production default)
      { now: () => 0, deepInspectDelayMs: 0, limits: generous },
      { now: () => 1_000_000, deepInspectDelayMs: 50, limits: generous },
      { now: () => 42, deepInspectDelayMs: 250, limits: generous },
      // A monotonically advancing clock + per-file synthetic latency, still under budget.
      ((): { now: () => number; deepInspectDelayMs: number; limits: { watchdogMs: number } } => {
        let t = 5_000;
        return { now: () => (t += 7), deepInspectDelayMs: 13, limits: generous };
      })(),
    ];

    const covs = injections.map((opts) => scanForSimulationHits(tp!.paths, opts));

    for (const cov of covs) {
      // (a) the watchdog never leaked into the verdict.
      expect(cov.unobserved.some((u) => u.reason === "watchdog")).toBe(false);
    }

    // (b) the verdict is byte-identical across every timing injection. Compare each of
    // the load-bearing verdict fields against the first (production-default) scan.
    const base = covs[0]!;
    for (let i = 1; i < covs.length; i++) {
      const cov = covs[i]!;
      expect(cov.enumerated, `enumerated diverged for injection ${i}`).toEqual(base.enumerated);
      expect(cov.deepInspected, `deepInspected diverged for injection ${i}`).toEqual(base.deepInspected);
      expect(cov.distHits, `distHits diverged for injection ${i}`).toEqual(base.distHits);
      expect(cov.unobserved, `unobserved diverged for injection ${i}`).toEqual(base.unobserved);
      expect(cov.limitHit, `limitHit diverged for injection ${i}`).toEqual(base.limitHit);
    }

    // Sanity: the fixture was actually deep-inspected (so the timing seam ran per file),
    // and the verdict is clean (no coverage gap from the generous budget).
    expect(base.deepInspected.length).toBeGreaterThan(0);
    expect(base.unobserved).toEqual([]);
  });
});

describe("scan determinism — real committed dist/ has no watchdog nondeterminism", () => {
  it("(4) the REAL dist/ scan completes within the watchdog (no watchdog unobserved)", () => {
    const paths = resolveProjectPaths(REPO_ROOT);
    const cov = scanForSimulationHits(paths); // default 30 s watchdog
    expect(cov.enumerated.length).toBeGreaterThan(0); // real dist/ exists + was enumerated
    expect(
      cov.unobserved.filter((u) => u.reason === "watchdog"),
      `real dist/ produced watchdog-reason unobserved entries (timing flakiness): ${JSON.stringify(
        cov.unobserved.filter((u) => u.reason === "watchdog"),
      )}`,
    ).toEqual([]);
  });
});
