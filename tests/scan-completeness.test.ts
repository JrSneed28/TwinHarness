/**
 * Axis-B slice-2a (BSC-6) — incomplete-scan receipt store grounding.
 *
 * Proves the `scan-completeness.jsonl` store's behavioural contract:
 *  - append→read round-trip fidelity (entries, snapshot_coord, recordedAt)
 *  - limits_reached is the DISTINCT, SORTED reason set
 *  - unproven_dimensions names each gap as `simulation-token-coverage:<path>`
 *  - the tolerant reader skips bad/wrong-shape lines and never throws; missing file → []
 *  - multiple appends accumulate in file order
 *  - the governed write-surface is satisfied (path is under stateDir, no throw)
 *  - a null-digest entry (Pass-A read_error) round-trips correctly
 *
 * The module under test carries ZERO gate authority — it is a result log only.
 * These tests confirm the audit-trail and human-surface contract, not gate logic.
 *
 * Deterministic + Windows-safe (path.join, scratch projects via makeTempProject).
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { withStateLock } from "../src/core/state-store";
import {
  appendScanCompletenessReceipt,
  readScanCompletenessReceipts,
  scanCompletenessPath,
  type ScanUnobservedEntry,
} from "../src/core/scan-completeness";

let tp: TempProject | undefined;
afterEach(() => {
  tp?.cleanup();
  tp = undefined;
});

/** Initialise a fresh scratch project (creates stateDir so appends can proceed). */
function freshProject(): TempProject {
  const project = makeTempProject();
  runInit(project.paths, {});
  return project;
}

// ---------------------------------------------------------------------------
// 1. Append → read round-trip
// ---------------------------------------------------------------------------
describe("SC-1: append→read round-trip", () => {
  it("two unobserved entries (file_limit + aggregate_limit) survive a read-back intact", () => {
    tp = freshProject();
    const unobserved: ScanUnobservedEntry[] = [
      { path: "dist/foo.js", digest: "a".repeat(64), reason: "file_limit" },
      { path: "dist/bar.js", digest: "b".repeat(64), reason: "aggregate_limit" },
    ];

    withStateLock(tp.paths, () => appendScanCompletenessReceipt(tp!.paths, unobserved));

    const receipts = readScanCompletenessReceipts(tp.paths);
    expect(receipts).toHaveLength(1);
    const r = receipts[0];

    // Unobserved entries round-trip exactly.
    expect(r.unobserved).toEqual(unobserved);

    // recordedAt is a string (ISO timestamp).
    expect(typeof r.recordedAt).toBe("string");
    expect(r.recordedAt.length).toBeGreaterThan(0);

    // snapshot_coord has both keys (values may be null in a tmpdir without git).
    expect(r.snapshot_coord).toHaveProperty("gitHead");
    expect(r.snapshot_coord).toHaveProperty("treeDigest");
  });
});

// ---------------------------------------------------------------------------
// 2. limits_reached — distinct, sorted reason set
// ---------------------------------------------------------------------------
describe("SC-2: limits_reached is the distinct, sorted reason set", () => {
  it("duplicate file_limit entries collapse; result sorted alphabetically", () => {
    tp = freshProject();
    const unobserved: ScanUnobservedEntry[] = [
      { path: "dist/a.js", digest: "a".repeat(64), reason: "file_limit" },
      { path: "dist/b.js", digest: "b".repeat(64), reason: "aggregate_limit" },
      { path: "dist/c.js", digest: "c".repeat(64), reason: "file_limit" },
    ];

    withStateLock(tp.paths, () => appendScanCompletenessReceipt(tp!.paths, unobserved));

    const receipts = readScanCompletenessReceipts(tp.paths);
    expect(receipts[0].limits_reached).toEqual(["aggregate_limit", "file_limit"]);
  });
});

// ---------------------------------------------------------------------------
// 3. unproven_dimensions — one entry per gap
// ---------------------------------------------------------------------------
describe("SC-3: unproven_dimensions names each unscanned path", () => {
  it("two unobserved paths → two simulation-token-coverage:<path> entries", () => {
    tp = freshProject();
    const unobserved: ScanUnobservedEntry[] = [
      { path: "dist/a.js", digest: "a".repeat(64), reason: "file_limit" },
      { path: "dist/b.js", digest: "b".repeat(64), reason: "watchdog" },
    ];

    withStateLock(tp.paths, () => appendScanCompletenessReceipt(tp!.paths, unobserved));

    const receipts = readScanCompletenessReceipts(tp.paths);
    expect(receipts[0].unproven_dimensions).toEqual([
      "simulation-token-coverage:dist/a.js",
      "simulation-token-coverage:dist/b.js",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 4. Tolerant reader
// ---------------------------------------------------------------------------
describe("SC-4: tolerant reader — bad lines skipped, missing file → []", () => {
  it("one good line + one garbage + one wrong-shape JSON → only good receipt returned", () => {
    tp = freshProject();
    const good: ScanUnobservedEntry[] = [
      { path: "dist/x.js", digest: "d".repeat(64), reason: "read_error" },
    ];

    // Write the good receipt via the API so we know its exact shape.
    withStateLock(tp.paths, () => appendScanCompletenessReceipt(tp!.paths, good));

    // Manually append a garbage non-JSON line and a well-formed-but-wrong-shape JSON line.
    const jsonlPath = scanCompletenessPath(tp.paths);
    fs.appendFileSync(jsonlPath, "this is not JSON at all\n", "utf8");
    fs.appendFileSync(jsonlPath, JSON.stringify({ foo: 1 }) + "\n", "utf8");

    const receipts = readScanCompletenessReceipts(tp.paths);
    // Only the valid receipt survives; the two bad lines are silently skipped.
    expect(receipts).toHaveLength(1);
    expect(receipts[0].unobserved).toEqual(good);
  });

  it("missing file → [] (never throws)", () => {
    tp = freshProject();
    // Do NOT append anything — the file should not exist yet.
    expect(() => readScanCompletenessReceipts(tp!.paths)).not.toThrow();
    expect(readScanCompletenessReceipts(tp.paths)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. Multiple appends accumulate in file order
// ---------------------------------------------------------------------------
describe("SC-5: multiple appends accumulate in file order", () => {
  it("two appends → length 2, first receipt is first in file", () => {
    tp = freshProject();
    const first: ScanUnobservedEntry[] = [
      { path: "dist/first.js", digest: "1".repeat(64), reason: "file_limit" },
    ];
    const second: ScanUnobservedEntry[] = [
      { path: "dist/second.js", digest: "2".repeat(64), reason: "aggregate_limit" },
    ];

    withStateLock(tp.paths, () => appendScanCompletenessReceipt(tp!.paths, first));
    withStateLock(tp.paths, () => appendScanCompletenessReceipt(tp!.paths, second));

    const receipts = readScanCompletenessReceipts(tp.paths);
    expect(receipts).toHaveLength(2);
    expect(receipts[0].unobserved[0].path).toBe("dist/first.js");
    expect(receipts[1].unobserved[0].path).toBe("dist/second.js");
  });
});

// ---------------------------------------------------------------------------
// 6. Governed write-surface — path is under stateDir, no throw
// ---------------------------------------------------------------------------
describe("SC-6: governed write-surface", () => {
  it("appendScanCompletenessReceipt does not throw for a normal project", () => {
    tp = freshProject();
    expect(() =>
      withStateLock(tp!.paths, () =>
        appendScanCompletenessReceipt(tp!.paths, [
          { path: "dist/safe.js", digest: "e".repeat(64), reason: "watchdog" },
        ]),
      ),
    ).not.toThrow();
  });

  it("scanCompletenessPath is under stateDir", () => {
    tp = freshProject();
    const p = scanCompletenessPath(tp.paths);
    // Normalise with path.resolve so comparisons are platform-consistent.
    const stateDir = path.resolve(tp.paths.stateDir);
    const resolved = path.resolve(p);
    expect(resolved.startsWith(stateDir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. Null-digest entry (Pass-A read_error) round-trips correctly
// ---------------------------------------------------------------------------
describe("SC-7: null-digest entry round-trip", () => {
  it("digest:null survives append→read intact", () => {
    tp = freshProject();
    const unobserved: ScanUnobservedEntry[] = [
      { path: "dist/unreadable.js", digest: null, reason: "read_error" },
    ];

    withStateLock(tp.paths, () => appendScanCompletenessReceipt(tp!.paths, unobserved));

    const receipts = readScanCompletenessReceipts(tp.paths);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].unobserved[0].digest).toBeNull();
    expect(receipts[0].unobserved[0].reason).toBe("read_error");
    // unproven_dimensions still names the path even when digest is null.
    expect(receipts[0].unproven_dimensions).toEqual([
      "simulation-token-coverage:dist/unreadable.js",
    ]);
  });
});
