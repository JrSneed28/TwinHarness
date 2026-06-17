/**
 * Component 3 (Stress) — real multi-process lock contention + large-repo scanner
 * load (plan §11 integration; AC #9). The lock-contention proof spawns N real
 * `node dist/cli.js drift add` OS processes (the `concurrency.test.ts` pattern) so
 * the `withStateLock` serialization is proven across genuine process boundaries —
 * no lost updates, unique ids, no deadlock. Cross-platform parity is RECORDED (not
 * silently skipped) via `runPlatformParity`.
 *
 * Runs against the COMPILED CLI (dist/cli.js); skips gracefully when dist is absent.
 */

import { describe, it, expect } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import { runLockContention, runScannerLoad } from "../src/core/proof/stress";
import { makeLargeRepo } from "../src/core/proof/fixtures";
import { runPlatformParity } from "../src/core/proof/platform";

const CLI = path.resolve(__dirname, "../dist/cli.js");

describe("proof/stress — real multi-process lock contention (AC #9)", () => {
  it.skipIf(!fs.existsSync(CLI))(
    "8 concurrent `node dist/cli.js drift add` writers: no lost updates, unique ids, no deadlock",
    async () => {
      const result = await runLockContention({ writers: 8, cliPath: CLI });

      expect(result.deadlock).toBe(false);
      expect(result.lostUpdates).toBe(false);
      expect(result.finalCount).toBe(8); // every requirement-layer drift counted
      expect(result.uniqueIds).toBe(8); // no DRIFT-NNN id collision
      expect(result.pass).toBe(true);
    },
    60_000,
  );

  it("large-repo scanner load completes within bound through the real scanRepo", () => {
    const root = makeLargeRepo(600);
    try {
      const result = runScannerLoad(root, { boundMs: 30_000 });
      expect(result.files).toBeGreaterThanOrEqual(600);
      expect(result.bytes).toBeGreaterThan(0);
      expect(result.completed).toBe(true); // no cap hit on a 600-file tree
      expect(result.withinBound).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("cross-platform parity is RECORDED, not silently skipped (closes the concurrency.test.ts:138 gap)", () => {
    const parity = runPlatformParity();
    expect(parity.os).toBe(process.platform);
    expect(parity.cases.length).toBeGreaterThan(0);

    // The Windows-skip case must be present and explicitly reported (ran XOR skipped),
    // each with a non-empty reason — never silently dropped.
    const winCase = parity.cases.find((c) => c.name === "windows-eperm-rethrow");
    expect(winCase).toBeDefined();
    expect(winCase!.ran !== winCase!.skipped).toBe(true);
    expect(winCase!.reason.length).toBeGreaterThan(0);
    for (const c of parity.cases) {
      expect(c.os).toBe(process.platform);
      expect(c.reason.length).toBeGreaterThan(0);
    }
  });
});
