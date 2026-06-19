/**
 * P2-4 (#6) — binary/encoding guard + the all-or-nothing Buffer-based freshness
 * hash fix.
 *
 * Two defects this pins:
 *
 *  (a) FRESHNESS HASH (rev 2 B3). The store path (`runRepoMap` → fileHashes) and the
 *      re-check path (`runRepoCheck`) previously utf8-decoded + CRLF-normalized
 *      every file before hashing. For BINARIES that is LOSSY: invalid byte runs
 *      collapse to U+FFFD and CR bytes vanish, so two DISTINCT binaries can hash
 *      IDENTICALLY → a real edit reads as `fresh` (silently missed staleness). Both
 *      paths now use byte-exact `hashFileBytes`, so a stored binary round-trips to
 *      `fresh` and two distinct binaries get distinct stored hashes. Because BOTH
 *      sides changed together (all-or-nothing), a binary is never falsely-modified.
 *
 *  (b) BINARY EXTRACTION GUARD. A NUL-containing file is never decoded for
 *      anchors/symbols/imports — so a binary that happens to contain the bytes of a
 *      REQ-ID never produces a phantom anchor or symbol.
 *
 * Anchors: REQ-202 (modified detection), REQ-NFR-002 (deterministic hash),
 *          REQ-NFR-003 (read-only), REQ-RU-011 (anchors).
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import { runRepoMap, runRepoCheck } from "../src/commands/repo";
import { hashFileBytes } from "../src/core/hash";
import { scanRepo } from "../src/core/repo-map/scanner";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

describe("P2-4 — binary freshness hash is byte-exact and all-or-nothing", () => {
  it("REQ-202: a stored binary re-checks as FRESH (store + re-check use the same byte-exact hash)", () => {
    tp = makeTempProject();
    // A binary blob with NUL bytes and a high byte that would be lossy under utf8.
    const blob = Buffer.from([0x00, 0xff, 0x10, 0x00, 0xc3, 0x28, 0x0d, 0x0a, 0x41]);
    fs.writeFileSync(path.join(tp.root, "asset.bin"), blob);
    fs.writeFileSync(path.join(tp.root, "readme.txt"), "hello", "utf8");

    const mapResult = runRepoMap(tp.paths, { write: true });
    expect(mapResult.ok).toBe(true);

    // Immediately after writing, the tree (binary included) must be FRESH.
    const check = runRepoCheck(tp.paths, {});
    expect(check.exitCode).toBe(0);
    expect(check.data?.fresh).toBe(true);
  });

  it("REQ-202: two DISTINCT binaries that collide under lossy utf8 get DISTINCT byte-exact hashes (no missed staleness)", () => {
    tp = makeTempProject();
    const aAbs = path.join(tp.root, "a.bin");
    const bAbs = path.join(tp.root, "b.bin");
    // Both decode to the same lossy utf8 string (U+FFFD … U+FFFD) but differ in raw
    // bytes — the exact collision the old utf8-hash would miss.
    fs.writeFileSync(aAbs, Buffer.from([0x00, 0xff, 0x00, 0xfe]));
    fs.writeFileSync(bAbs, Buffer.from([0x00, 0xfd, 0x00, 0xfc]));

    expect(hashFileBytes(aAbs)).not.toBe(hashFileBytes(bAbs));

    // End-to-end: map one, then overwrite it with the other binary → MODIFIED.
    runRepoMap(tp.paths, { write: true });
    fs.writeFileSync(aAbs, Buffer.from([0x00, 0xfd, 0x00, 0xfc])); // now equals b's bytes
    const check = runRepoCheck(tp.paths, {});
    expect(check.exitCode).not.toBe(0); // stale, not silently fresh
    expect((check.data?.modified as string[]).includes("a.bin")).toBe(true);
  });

  it("REQ-RU-011: a binary containing REQ-ID bytes never produces a phantom anchor/symbol (binary guard)", () => {
    tp = makeTempProject();
    // A NUL byte makes this binary; the ascii bytes spell a REQ-ID + an export.
    const buf = Buffer.concat([
      Buffer.from("// Anchor: REQ-FAKE-999\nexport const phantom = 1;\n", "utf8"),
      Buffer.from([0x00, 0x01, 0x02]),
    ]);
    fs.mkdirSync(path.join(tp.root, "src"), { recursive: true });
    fs.writeFileSync(path.join(tp.root, "src/blob.ts"), buf);
    // A real text source file with a genuine anchor + export, for contrast.
    fs.writeFileSync(path.join(tp.root, "src/real.ts"), "// REQ-REAL-001\nexport const real = 2;\n", "utf8");

    const map = scanRepo(tp.root);
    expect(map.req_anchors.some((r) => r.req_id === "REQ-FAKE-999")).toBe(false);
    expect(map.req_anchors.some((r) => r.req_id === "REQ-REAL-001")).toBe(true);
    const blob = map.files.find((f) => f.path === "src/blob.ts");
    expect(blob?.symbols ?? []).toEqual([]); // no symbols extracted from a binary
    const real = map.files.find((f) => f.path === "src/real.ts");
    expect(real?.symbols?.some((s) => s.name === "real")).toBe(true);
  });
});
