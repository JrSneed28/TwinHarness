/**
 * PERF-001 (P1-7) — BOUNDED-COST guard at the `scanRepo` boundary.
 *
 * The repo-map scan must never `readFileSync` a file larger than the per-file
 * byte cap. The REUSED anchor walk (`scanDirForReqIdsCapped`) previously did its
 * own uncapped recursive walk and read EVERY regular file fully into memory — a
 * single 30 MB source file that passed the name filter was fully read, defeating
 * the advertised BOUNDED-COST guarantee (REQ-NFR-007).
 *
 * This test is placed at the `scanRepo` boundary (NOT in anchors.test.ts) on
 * purpose: it is path-agnostic, so it survives P3-1's later deletion of the
 * standalone anchor cap and becomes the bounded-cost guard for the unified walk.
 *
 * Instrumentation: `fs.readFileSync` cannot be spied on under ESM (the scanner's
 * own design note: "spying on node:fs which ESM forbids"), so we instrument
 * "was the oversize file READ?" through the scan's OBSERVABLE output. A unique
 * REQ-ID anchor is placed INSIDE the 30 MB file; if the scanner reads it, that
 * anchor appears in `req_anchors`. A small file carries a different anchor that
 * MUST always be found. FAIL-before (uncapped anchor walk): the oversize file is
 * read → its anchor appears. PASS-after (capped walk): the oversize file is
 * skipped via a single `statSync` → its anchor is absent, the small one present,
 * and the scan completes fast.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import { scanRepo } from "../src/core/repo-map/scanner";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

/** The scanner's per-file read cap (2 MB). Oversize files must never be read. */
const MAX_READ_BYTES = 2 * 1024 * 1024;

describe("PERF-001 — scanRepo never reads a file larger than the per-file byte cap", () => {
  it("skips a 30 MB file (its anchor is never seen) while still reading small files, and stays bounded", () => {
    tp = makeTempProject();
    const root = tp.root;

    // A 30 MB `.ts` file that passes any name filter and CARRIES a unique anchor
    // at byte 0. If the scanner reads it, REQ-OVERSIZE-001 surfaces — that is the
    // bug. The cap must skip it entirely, so the anchor must NOT surface.
    const oversizeAbs = path.join(root, "src", "huge.ts");
    fs.mkdirSync(path.dirname(oversizeAbs), { recursive: true });
    const filler = "x".repeat(30 * 1024 * 1024);
    fs.writeFileSync(oversizeAbs, `// Anchor: REQ-OVERSIZE-001\n${filler}`, "utf8");
    expect(fs.statSync(oversizeAbs).size).toBeGreaterThan(MAX_READ_BYTES);

    // A small normal file WITH a different anchor — must still be found.
    const smallAbs = path.join(root, "src", "small.ts");
    fs.writeFileSync(smallAbs, "// Anchor: REQ-SMALL-002\nexport const x = 1;\n", "utf8");

    const start = Date.now();
    const map = scanRepo(root);
    const elapsedMs = Date.now() - start;

    // 1) The oversize file's anchor is NEVER seen — its bytes were never read.
    expect(map.req_anchors.some((r) => r.req_id === "REQ-OVERSIZE-001")).toBe(false);
    // It is also absent from any FileEntry's req_ids.
    expect(map.files.some((f) => f.req_ids.includes("REQ-OVERSIZE-001"))).toBe(false);

    // 2) The small file is still scanned: its anchor IS found at the boundary.
    const anchor = map.req_anchors.find((r) => r.req_id === "REQ-SMALL-002");
    expect(anchor).toBeDefined();
    expect(anchor!.locations).toContain("src/small.ts");

    // 3) Bounded cost: skipping the 30 MB file via one stat keeps the scan fast
    //    (reading 30 MB into a UTF-8 string + regex-scanning it would be far slower).
    expect(elapsedMs).toBeLessThan(5_000);
  });
});
