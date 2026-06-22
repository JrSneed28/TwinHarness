/**
 * BSC-6 (Axis-B slice-2a) — the two-tier scan coverage descriptor + streaming hash.
 *
 * Proves the enumeration tier ALWAYS runs (every dist/ path streaming-hashed,
 * bounded-memory) and the deep-inspection tier is bounded by the layered budget,
 * marking any un-deep-inspectable path `unobserved` (≠ clean) with the precise reason.
 * Includes the committed-`dist/` ⇒ `unobserved:[]` regression test (decision #8) that
 * prevents a future dist size bump from self-blocking every CI run.
 */
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempProject, type TempProject } from "./helpers";
import { resolveProjectPaths } from "../src/core/paths";
import { hashFileBytes, hashFileStreaming } from "../src/core/hash";
import { scanForSimulationHits, DEFAULT_SCAN_LIMITS } from "../src/commands/sim";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const isWin = process.platform === "win32";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

function writeDist(root: string, rel: string, content: string | Buffer): string {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

describe("hashFileStreaming — byte-identical to hashFileBytes, bounded memory", () => {
  it("matches hashFileBytes for text, empty, all-byte-values, and multi-chunk (>64 KB) files", () => {
    tp = makeTempProject();
    const root = tp.root;
    const cases: Array<[string, Buffer]> = [
      ["a.bin", Buffer.from("export const x = 1; // placeholder\n", "utf8")],
      ["empty.bin", Buffer.alloc(0)],
      ["allbytes.bin", Buffer.from(Array.from({ length: 256 }, (_, i) => i))],
      // 200 KB > the 64 KB chunk buffer — exercises the multi-readSync loop.
      ["big.bin", Buffer.alloc(200 * 1024, 0xab)],
      // A buffer with CR/LF bytes — byte-exact (NOT CRLF-normalized), like hashFileBytes.
      ["crlf.bin", Buffer.from("a\r\nb\r\n", "utf8")],
    ];
    for (const [rel, buf] of cases) {
      const abs = writeDist(root, rel, buf);
      expect(hashFileStreaming(abs), `${rel} digest mismatch`).toBe(hashFileBytes(abs));
    }
  });
});

describe("two-tier scan — enumeration always runs; deep-inspection is bounded", () => {
  it("enumerates + streaming-hashes EVERY dist/ path (sorted, digest matches)", () => {
    tp = makeTempProject();
    const root = tp.root;
    const aAbs = writeDist(root, "dist/a.js", "const a = 1;\n");
    const bAbs = writeDist(root, "dist/sub/b.js", "const b = 2;\n");
    writeDist(root, "dist/notes.txt", "ignored (non-scan extension)\n"); // not enumerated

    const cov = scanForSimulationHits(tp.paths);
    expect(cov.enumerated.map((e) => e.path)).toEqual(["dist/a.js", "dist/sub/b.js"]); // sorted
    expect(cov.enumerated.find((e) => e.path === "dist/a.js")!.digest).toBe(hashFileStreaming(aAbs));
    expect(cov.enumerated.find((e) => e.path === "dist/sub/b.js")!.digest).toBe(hashFileStreaming(bAbs));
    expect(cov.deepInspected.sort()).toEqual(["dist/a.js", "dist/sub/b.js"]);
    expect(cov.unobserved).toEqual([]);
    expect(cov.limitHit).toBe(false);
  });

  it("(a) per-file limit → unobserved{file_limit}, never silently skipped; the token is NOT lost", () => {
    tp = makeTempProject();
    const root = tp.root;
    // A token-bearing file just over a tiny per-file budget — the RED-probe shape in miniature.
    writeDist(root, "dist/big.js", "const m = 1; // placeholder real impl pending\n" + "x".repeat(500));
    writeDist(root, "dist/ok.js", "const ok = 1;\n");

    const cov = scanForSimulationHits(tp.paths, { limits: { deepInspectFileMaxBytes: 100 } });
    expect(cov.enumerated.map((e) => e.path)).toContain("dist/big.js"); // still enumerated + hashed
    const big = cov.unobserved.find((u) => u.path === "dist/big.js");
    expect(big, "big.js must be unobserved (not silently skipped)").toBeDefined();
    expect(big!.reason).toBe("file_limit");
    expect(big!.digest).toBe(hashFileStreaming(path.join(root, "dist/big.js")));
    expect(cov.deepInspected).toContain("dist/ok.js"); // the within-budget file still inspected
    expect(cov.limitHit).toBe(true);
    // The oversize file's token did NOT leak into distHits (it was not deep-inspected) — it is
    // surfaced as a coverage gap instead, which the gate blocks on.
    expect(cov.distHits.some((h) => h.file === "dist/big.js")).toBe(false);
  });

  it("(b) aggregate limit → the remainder is unobserved{aggregate_limit}", () => {
    tp = makeTempProject();
    const root = tp.root;
    writeDist(root, "dist/a.js", "a".repeat(600));
    writeDist(root, "dist/b.js", "b".repeat(600));
    writeDist(root, "dist/c.js", "c".repeat(600));

    // Aggregate budget fits one 600-byte file; the rest are unobserved.
    const cov = scanForSimulationHits(tp.paths, {
      limits: { deepInspectAggregateMaxBytes: 1000, deepInspectFileMaxBytes: 1_000_000 },
    });
    expect(cov.deepInspected).toEqual(["dist/a.js"]);
    expect(cov.unobserved.map((u) => u.path)).toEqual(["dist/b.js", "dist/c.js"]);
    expect(cov.unobserved.every((u) => u.reason === "aggregate_limit")).toBe(true);
    expect(cov.limitHit).toBe(true);
  });

  it("(b2) watchdog (synthetic latency seam) → remainder unobserved{watchdog}, deterministic", () => {
    tp = makeTempProject();
    const root = tp.root;
    for (const n of ["a", "b", "c", "d", "e"]) writeDist(root, `dist/${n}.js`, `const ${n} = 1;\n`);

    // Constant clock (now:0) + 10 ms synthetic per deep-inspected file + 25 ms watchdog ⇒
    // exactly 3 files inspected (0,10,20 ms < 25), then the watchdog trips on the 4th.
    const cov = scanForSimulationHits(tp.paths, {
      now: () => 0,
      deepInspectDelayMs: 10,
      limits: { watchdogMs: 25 },
    });
    expect(cov.deepInspected.length).toBe(3);
    expect(cov.unobserved.map((u) => u.path)).toEqual(["dist/d.js", "dist/e.js"]);
    expect(cov.unobserved.every((u) => u.reason === "watchdog")).toBe(true);
    expect(cov.limitHit).toBe(true);
  });

  it.skipIf(isWin)("(c) unreadable file → unobserved{read_error} (POSIX perms)", () => {
    tp = makeTempProject();
    const root = tp.root;
    const abs = writeDist(root, "dist/locked.js", "const x = 1;\n");
    fs.chmodSync(abs, 0o000);
    try {
      const cov = scanForSimulationHits(tp.paths);
      const locked = cov.unobserved.find((u) => u.path === "dist/locked.js");
      expect(locked, "an unreadable dist file must be unobserved, never silently skipped").toBeDefined();
      expect(locked!.reason).toBe("read_error");
      expect(cov.limitHit).toBe(true);
    } finally {
      fs.chmodSync(abs, 0o644); // restore so cleanup can remove it
    }
  });

  it("determinism — the same tree yields a byte-identical descriptor", () => {
    tp = makeTempProject();
    const root = tp.root;
    writeDist(root, "dist/a.js", "const a = 1; // stub\n");
    writeDist(root, "dist/b.js", "const b = 2;\n");
    const first = scanForSimulationHits(tp.paths);
    const second = scanForSimulationHits(tp.paths);
    expect(second).toEqual(first);
  });
});

describe("committed-dist/ regression (decision #8) — TwinHarness never self-blocks", () => {
  it("the REAL committed dist/ ⇒ unobserved:[] and limitHit:false under the default budget", () => {
    const paths = resolveProjectPaths(REPO_ROOT);
    const cov = scanForSimulationHits(paths); // default 8 MB / 64 MB budget
    expect(cov.enumerated.length).toBeGreaterThan(0); // dist/ exists and was enumerated
    expect(cov.unobserved, `default budget marked committed dist/ files unobserved: ${JSON.stringify(cov.unobserved)}`).toEqual([]);
    expect(cov.limitHit).toBe(false);
    // Sanity: the default budget comfortably covers the real tree.
    expect(DEFAULT_SCAN_LIMITS.deepInspectFileMaxBytes).toBeGreaterThan(2 * 1024 * 1024);
  });
});
