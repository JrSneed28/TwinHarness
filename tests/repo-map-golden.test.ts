/**
 * P3-1 — SINGLE-WALK proof for the repo-map scanner.
 *
 * The scanner used to walk the tree TWICE: the main walk stat-ed every file and
 * read manifests, then a SEPARATE `scanDirForReqIdsCapped` re-walked the WHOLE
 * tree and `readFileSync`-ed every file AGAIN to extract REQ-IDs. P3-1 folds
 * REQ-ID extraction into the single main walk so each regular file is read at most
 * ONCE. This file pins two guarantees:
 *
 *  (a) READ-ONCE — count `readFileSync` calls per path and assert every regular
 *      file under the cap is read EXACTLY once (the two-walk collapse). An oversize
 *      file is read ZERO times (name-only — BOUNDED-COST, PERF-001 / REQ-NFR-007).
 *  (b) BYTE-STABILITY — the serialized repo-map for a FIXED fixture equals a
 *      committed golden (`tests/fixtures/repo-map-golden.json`), captured from the
 *      PRE-refactor output. Any future drift in the (reqId → files) set, manifest
 *      REQ-ID collection, sorting, or path normalization fails here (ADR-003,
 *      REQ-NFR-001/006). The golden carries REQ-IDs inside `package.json`
 *      (REQ-RU-050) and the `Makefile` (REQ-RU-051) to prove the SINGLE manifest
 *      read still feeds `extractReqIds` (manifest anchors are not dropped).
 *
 * COUNTING READS under vitest: `vi.spyOn(fs, "readFileSync")` is rejected — vitest
 * loads `node:fs` as a non-configurable ESM namespace (the same limitation noted
 * in repo-bounded-cost.test.ts). Instead we `vi.mock("node:fs", …)` with a factory
 * that wraps the REAL module and tallies `readFileSync` calls per path, then
 * delegates verbatim. The counter is a module-level `let` the (hoisted) factory
 * closes over. This counts ACTUAL reads (not observable side effects), giving an
 * exact read-count assertion the bounded-cost test cannot make.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import { scanRepo } from "../src/core/repo-map/scanner";
import { serializeRepoMap } from "../src/core/repo-map/schema";

// Per-path readFileSync tally, populated by the mocked node:fs below. `null` =
// not counting (the factory then just delegates, adding no observation overhead).
let readCounts: Map<string, number> | null = null;

// Wrap node:fs: every member is the real implementation EXCEPT readFileSync, which
// tallies string-path reads into `readCounts` (when active) then delegates. The
// factory is hoisted by vitest above the imports; it may reference the module-scope
// `readCounts` let (a closure over a live binding) and `vi.importActual`.
vi.mock("node:fs", async (importActual) => {
  const actual = await importActual<typeof import("node:fs")>();
  const wrapped = {
    ...actual,
    readFileSync: (p: Parameters<typeof actual.readFileSync>[0], ...rest: unknown[]) => {
      if (readCounts && typeof p === "string") readCounts.set(p, (readCounts.get(p) ?? 0) + 1);
      // @ts-expect-error — delegate verbatim to the real implementation.
      return actual.readFileSync(p, ...rest);
    },
  };
  return { ...wrapped, default: wrapped };
});

// Import fs AFTER the mock factory is declared so this binding is the wrapped one.
// (Used only for the test's own fixture writes; those go through the wrapper too
// but are not counted because `readCounts` is null outside the scan window.)
import * as fs from "node:fs";

let tp: TempProject | undefined;
afterEach(() => {
  readCounts = null;
  vi.restoreAllMocks();
  tp?.cleanup();
});

/** Write a relative-path tree under `root`. */
function writeTree(root: string, tree: Record<string, string>): void {
  for (const [rel, content] of Object.entries(tree)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
}

/** The FIXED golden fixture — identical shape to the captured golden. */
function buildGoldenFixture(root: string): void {
  writeTree(root, {
    "package.json": JSON.stringify({
      name: "golden-fixture",
      description: "carries REQ-RU-050 in a manifest field",
      scripts: { test: "vitest run", build: "tsc" },
      bin: { th: "dist/cli.js" },
      main: "dist/index.js",
      exports: { ".": "./index.js" },
    }),
    "Makefile": "# REQ-RU-051 anchor in a Makefile\nbuild:\n\ttsc\ntest:\n\tvitest\n",
    "src/core/a.ts": "// Anchor: REQ-RU-001\nexport const a = 1;\n",
    "src/core/b.ts": "// Anchor: REQ-RU-002 and REQ-RU-001\nexport const b = 2;\n",
    "src/commands/repo.ts": "// REQ-RU-003\nexport const c = 3;\n",
    "src/auth/login.ts": "// authentication concern, REQ-RU-013\nexport const d = 4;\n",
    "tests/a.test.ts": "// Anchor: REQ-RU-001\n",
    "docs/x.md": "# doc REQ-RU-099\n",
    "go.mod": "module x\n",
    "main.go": "package main\n",
  });
}

describe("P3-1 — single-walk scanner: read-once + byte-stability", () => {
  // ---- (a) READ-ONCE proof -------------------------------------------------
  it("reads every regular file under the cap EXACTLY once (two-walk collapse)", () => {
    tp = makeTempProject();
    const root = tp.root;
    // A handful of files carrying REQ-IDs, plus manifests (also read for content).
    const tree: Record<string, string> = {
      "package.json": JSON.stringify({ name: "x", scripts: { test: "vitest" } }),
      "Makefile": "build:\n\ttsc\n",
      "src/a.ts": "// REQ-RU-001\nexport const a = 1;\n",
      "src/b.ts": "// REQ-RU-002\nexport const b = 2;\n",
      "src/nested/c.ts": "// REQ-RU-001 and REQ-RU-003\nexport const c = 3;\n",
      "docs/d.md": "# REQ-RU-004\n",
    };
    writeTree(root, tree);

    // Start counting only across the scan window.
    readCounts = new Map<string, number>();
    const map = scanRepo(root);
    const counts = readCounts;
    readCounts = null;

    // The scan produced anchors (proves it really read the files, not skipped all).
    expect(map.req_anchors.some((r) => r.req_id === "REQ-RU-001")).toBe(true);
    expect(map.req_anchors.some((r) => r.req_id === "REQ-RU-004")).toBe(true);

    // EVERY regular file in the fixture was readFileSync-ed EXACTLY once. Before
    // P3-1, non-manifest files were read once (anchor pass) and manifests TWICE
    // (manifest pass + anchor pass).
    for (const rel of Object.keys(tree)) {
      const abs = path.join(root, rel);
      expect(counts.get(abs), `${rel} should be read exactly once`).toBe(1);
    }
    // No file under the scanned root is read more than once.
    for (const [p, n] of counts) {
      if (p.startsWith(root)) expect(n, `${p} read ${n} times`).toBeLessThanOrEqual(1);
    }
  });

  it("reads an OVERSIZE file ZERO times (name-only — bounded cost)", () => {
    tp = makeTempProject();
    const root = tp.root;
    const oversizeAbs = path.join(root, "src", "huge.ts");
    fs.mkdirSync(path.dirname(oversizeAbs), { recursive: true });
    fs.writeFileSync(oversizeAbs, `// REQ-OVERSIZE-001\n${"x".repeat(3 * 1024 * 1024)}`, "utf8");
    const smallAbs = path.join(root, "src", "small.ts");
    fs.writeFileSync(smallAbs, "// REQ-SMALL-002\n", "utf8");

    readCounts = new Map<string, number>();
    const map = scanRepo(root);
    const counts = readCounts;
    readCounts = null;

    // The oversize file was NEVER read (zero readFileSync calls); its anchor absent.
    expect(counts.get(oversizeAbs) ?? 0).toBe(0);
    expect(map.req_anchors.some((r) => r.req_id === "REQ-OVERSIZE-001")).toBe(false);
    // The small file WAS read once and its anchor surfaced.
    expect(counts.get(smallAbs)).toBe(1);
    expect(map.req_anchors.some((r) => r.req_id === "REQ-SMALL-002")).toBe(true);
  });

  // ---- (b) BYTE-STABILITY golden ------------------------------------------
  it("serialized repo-map for the fixed fixture equals the committed golden (byte-stable)", () => {
    tp = makeTempProject();
    buildGoldenFixture(tp.root);
    const serialized = serializeRepoMap(scanRepo(tp.root));

    const goldenPath = path.join(__dirname, "fixtures", "repo-map-golden.json");
    // Defensive CRLF→LF normalization: the serializer always emits LF and the
    // fixture is committed LF (.gitattributes `* text=auto eol=lf`); normalize in
    // case a tool rewrites the working-tree fixture so the test asserts CONTENT,
    // not the host checkout's line endings.
    const golden = fs.readFileSync(goldenPath, "utf8").replace(/\r\n/g, "\n");

    expect(serialized).toBe(golden);
    // Golden carries manifest REQ-IDs — the single manifest read still feeds
    // extractReqIds (the old second pass read manifests too; this proves no loss).
    expect(serialized.includes('"REQ-RU-050"')).toBe(true); // from package.json
    expect(serialized.includes('"REQ-RU-051"')).toBe(true); // from Makefile
  });

  it("re-running the scan on the fixed fixture is byte-identical (determinism)", () => {
    tp = makeTempProject();
    buildGoldenFixture(tp.root);
    const a = serializeRepoMap(scanRepo(tp.root));
    const b = serializeRepoMap(scanRepo(tp.root));
    expect(a).toBe(b);
  });
});
