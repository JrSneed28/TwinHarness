/**
 * Axis-B slice-6 (BSC-2) — cross-runner DETERMINISM of the assertion-presence sensor (Lane D,
 * deliverable 3). The P6 binding-contract guard: the serialized ground (and therefore the
 * receipt's `recordHash`) MUST be byte-identical regardless of `readdirSync` order, so a
 * receipt minted on one runner re-derives clean on another (the F8 grounding only holds if the
 * digest is platform/runner-stable).
 *
 * This is NOT a mere recompute-twice check. It INJECTS a shuffled directory listing by mocking
 * `node:fs` (a factory wrapping the real module — ESM namespaces are not `vi.spyOn`-able) so every
 * `fs.readdirSync` returns a re-ordered listing (REVERSED, then ROTATED order) and asserts:
 *   - `assertionGroundDigest` is IDENTICAL to the natural-order run, AND
 *   - every `testFiles[]` array is lexically SORTED, AND
 *   - every path is POSIX (forward-slash) regardless of injected order.
 *
 * This catches the `scanDirForReqIds` determinism hazard (`anchors.ts` returns first-seen readdir
 * order) the sensor neutralizes by sorting + POSIX-normalizing on the way out (P6).
 *
 * No `dist/` build required — runs against `src/` via vitest. Windows-safe (path.join, no shell).
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import {
  computeAssertionPresenceGround,
  assertionGroundDigest,
  serializeAssertionGround,
} from "../src/core/assertion-presence";
import type { ProjectPaths } from "../src/core/paths";

/**
 * The active readdir-order transform, swapped per-test. `null` ⇒ natural order. The sensor reads
 * directories via `anchors.ts:scanDirForReqIds` → `fs.readdirSync(abs, { withFileTypes: true })`;
 * ESM module namespaces are not `vi.spyOn`-able (their exports are non-configurable), so we
 * `vi.mock("node:fs")` with a factory that wraps the REAL module and re-orders ONLY the readdir
 * result. This injects a SHUFFLED directory listing the way a different runner/filesystem would.
 */
let readdirTransform: (<T>(entries: T[]) => T[]) | null = null;
/** Count of readdir calls observed under an active transform — guards against a vacuous (no-op) test. */
let readdirCalls = 0;

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const wrappedReaddir = ((p: import("node:fs").PathLike, opts?: unknown) => {
    const entries = (real.readdirSync as (p: import("node:fs").PathLike, opts?: unknown) => unknown[])(p, opts);
    if (readdirTransform === null) return entries;
    readdirCalls++;
    return readdirTransform(entries);
  }) as typeof real.readdirSync;
  return { ...real, readdirSync: wrappedReaddir, default: { ...real, readdirSync: wrappedReaddir } };
});

// `fs` is now the mocked module (factory above); import it AFTER the mock is registered.
import * as fs from "node:fs";

let tp: TempProject | undefined;
afterEach(() => {
  readdirTransform = null;
  readdirCalls = 0;
  tp?.cleanup();
  tp = undefined;
});

/** Write a file under `<root>/tests/<rel>` (the sensor's default scan dir). */
function writeTestFile(paths: ProjectPaths, rel: string, body: string): void {
  const abs = path.resolve(paths.root, "tests", rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, "utf8");
}

/**
 * A multi-REQ, multi-file fixture so the ordering of BOTH the directory walk AND the per-REQ
 * testFiles[] is observable. Several REQs spread across several files in several subdirs, with
 * mixed healthy/trivial/unparsed content so the recompute is non-degenerate.
 */
function buildFixture(paths: ProjectPaths): void {
  writeTestFile(
    paths,
    "alpha.test.ts",
    `// REQ-001 REQ-003\nimport { it, expect } from "vitest";\nit("a", () => { expect(compute()).toBe(1); });\n`,
  );
  writeTestFile(
    paths,
    "beta.test.ts",
    `// REQ-002\nimport { it, expect } from "vitest";\nit("b", () => { expect(true).toBe(true); });\n`,
  );
  writeTestFile(
    paths,
    "sub/gamma.test.ts",
    `// REQ-001 REQ-002\nimport { it, expect } from "vitest";\nit("g", () => { expect(other()).toEqual({ a: 1 }); });\n`,
  );
  writeTestFile(
    paths,
    "sub/delta.test.ts",
    `// REQ-003\nimport { it, expect } from "vitest";\nit("d", () => { expect(x).toBe(x); });\n`,
  );
  writeTestFile(
    paths,
    "feature_test.go",
    `// REQ-004\npackage f\nfunc TestX(t *testing.T) { if compute() != 42 { t.Fail() } }\n`,
  );
}

/**
 * Activate a readdir-order transform (e.g. reversed or rotated), simulating a runner whose
 * filesystem returns directory entries in a different order. The wrapped `readdirSync` (installed
 * by the `vi.mock` factory above) applies it to EVERY listing while preserving `withFileTypes`
 * (Dirent[]) and plain-string call shapes. Reset in `afterEach`.
 */
function spyReaddirOrder(transform: <T>(entries: T[]) => T[]): void {
  readdirTransform = transform;
}

describe("BSC-2 determinism — sensor ground is invariant under readdir shuffling (P6)", () => {
  it("REVERSED readdir order yields the IDENTICAL ground digest + serialization", () => {
    tp = makeTempProject();
    buildFixture(tp.paths);

    // Natural order (no spy).
    const natural = computeAssertionPresenceGround(tp.paths);
    const naturalDigest = assertionGroundDigest(natural);
    const naturalSerialized = serializeAssertionGround(natural);

    // REVERSED readdir order.
    spyReaddirOrder((entries) => [...entries].reverse());
    const reversed = computeAssertionPresenceGround(tp.paths);

    // The spy actually fired (guard against a no-op that would make the test vacuous).
    expect(readdirCalls, "the readdir transform must actually fire").toBeGreaterThan(0);

    expect(assertionGroundDigest(reversed)).toBe(naturalDigest);
    expect(serializeAssertionGround(reversed)).toBe(naturalSerialized);
  });

  it("ROTATED readdir order also yields the IDENTICAL ground digest", () => {
    tp = makeTempProject();
    buildFixture(tp.paths);

    const naturalDigest = assertionGroundDigest(computeAssertionPresenceGround(tp.paths));

    // ROTATE by one (move the first entry to the end) — a different permutation than reverse.
    spyReaddirOrder((entries) =>
      entries.length <= 1 ? entries : [...entries.slice(1), entries[0]!],
    );
    const rotated = computeAssertionPresenceGround(tp.paths);
    expect(readdirCalls, "the readdir transform must actually fire").toBeGreaterThan(0);
    expect(assertionGroundDigest(rotated)).toBe(naturalDigest);
  });

  it("every testFiles[] is lexically sorted and POSIX-normalized regardless of injected order", () => {
    tp = makeTempProject();
    buildFixture(tp.paths);

    spyReaddirOrder((entries) => [...entries].reverse());
    const ground = computeAssertionPresenceGround(tp.paths);
    expect(readdirCalls, "the readdir transform must actually fire").toBeGreaterThan(0);

    // The ground itself is sorted by reqId.
    const reqIds = ground.map((s) => s.reqId);
    expect(reqIds).toEqual([...reqIds].sort());

    for (const s of ground) {
      // testFiles[] is lexically sorted.
      expect(s.testFiles, `testFiles for ${s.reqId} sorted`).toEqual([...s.testFiles].sort());
      // Every path is POSIX (no backslash) — load-bearing on Windows where path.sep is "\".
      for (const f of s.testFiles) {
        expect(f.includes("\\"), `path ${f} must be forward-slash POSIX`).toBe(false);
      }
    }

    // The multi-dir REQs prove the cross-directory ordering is normalized: REQ-001 anchors
    // alpha.test.ts (root) + sub/gamma.test.ts (subdir); the sort must interleave them lexically.
    const req001 = ground.find((s) => s.reqId === "REQ-001");
    expect(req001).toBeDefined();
    expect(req001!.testFiles).toEqual(["alpha.test.ts", "sub/gamma.test.ts"]);
  });
});
