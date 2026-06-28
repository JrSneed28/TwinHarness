/**
 * tests/context-scan-equivalence.test.ts
 *
 * M3 — proves that the dirty-file incremental path in `scanRepo` produces
 * output that is **byte-identical** to a fresh full-rebuild `scanRepo` for
 * the same tree.
 *
 * Why this matters: symbol-page `logical_key` and `content_hash` in the
 * context-pages layer (T5/S5) are derived from the serialized RepoMap.  If
 * an incremental scan silently drifts from a full rebuild for unchanged files
 * the page identity changes, breaking residency.  This test suite pins the
 * identity contract so any regression fails loudly.
 *
 * Test scenarios:
 *   1. Zero dirty files  → incremental == full scan (no work skipped incorrectly)
 *   2. All files dirty   → incremental == full scan (all files re-read)
 *   3. One file modified → incremental == fresh full scan on the modified tree
 *   4. Per-file data     → unchanged files preserve req_ids + symbols exactly
 *   5. Entry-file reuse  → entry-point detection still fires for reused files
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import { scanRepo } from "../src/core/repo-map/scanner";
import {
  serializeRepoMap,
  buildCallerPages,
  buildTestPages,
  buildSymbolPages,
  buildComponentPages,
} from "../src/core/repo-map/schema";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

/** Write a partial file tree into `root`, creating directories as needed. */
function write(root: string, tree: Record<string, string>): void {
  for (const [rel, content] of Object.entries(tree)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
}

/** A small TypeScript project fixture with imports, exports, and a test file. */
function baseTree(): Record<string, string> {
  return {
    "package.json": JSON.stringify({
      name: "scan-equiv-pkg",
      version: "1.0.0",
      scripts: { test: "vitest run" },
    }),
    "src/index.ts": 'export { greet } from "./greet";\n',
    "src/greet.ts":
      "/** REQ-GREET-001 */\n" +
      "export function greet(name: string): string {\n" +
      "  return `Hello, ${name}`;\n" +
      "}\n",
    "src/util.ts": 'export const VERSION = "1.0.0";\n',
    "src/app.ts":
      'import { greet } from "./greet";\n' +
      'import { VERSION } from "./util";\n' +
      "console.log(greet(\"world\"), VERSION);\n",
    "tests/greet.test.ts":
      'import { greet } from "../src/greet";\n' +
      'console.log(greet("test"));\n',
  };
}

// ---------------------------------------------------------------------------
// M3 core equivalence tests
// ---------------------------------------------------------------------------

describe("M3 — incremental scan byte-identical to full rebuild", () => {
  it("zero dirty files: incremental output is byte-identical to the full scan", () => {
    tp = makeTempProject();
    write(tp.root, baseTree());

    const fullMap = scanRepo(tp.root);
    const incrMap = scanRepo(tp.root, {
      incrementalOpts: { dirtyFiles: new Set(), previousMap: fullMap },
    });

    expect(serializeRepoMap(incrMap)).toBe(serializeRepoMap(fullMap));
  });

  it("all files dirty: incremental output is byte-identical to the full scan (all re-read)", () => {
    tp = makeTempProject();
    write(tp.root, baseTree());

    const fullMap = scanRepo(tp.root);
    // Mark every scanned file as dirty → nothing is reused, all re-read from disk.
    const allFiles = new Set(fullMap.files.map((f) => f.path));
    const incrMap = scanRepo(tp.root, {
      incrementalOpts: { dirtyFiles: allFiles, previousMap: fullMap },
    });

    expect(serializeRepoMap(incrMap)).toBe(serializeRepoMap(fullMap));
  });

  it("one file modified: incremental == fresh full scan on the modified tree", () => {
    tp = makeTempProject();
    write(tp.root, baseTree());

    // Step 1: full scan of the original tree.
    const firstFullMap = scanRepo(tp.root);

    // Step 2: modify src/util.ts in place (same POSIX path, new content).
    write(tp.root, {
      "src/util.ts": 'export const VERSION = "2.0.0";\nexport const REVISION = 42;\n',
    });
    const dirtyFiles = new Set(["src/util.ts"]);

    // Step 3: incremental scan acknowledging the dirty file.
    const incrMap = scanRepo(tp.root, {
      incrementalOpts: { dirtyFiles, previousMap: firstFullMap },
    });

    // Step 4: fresh full scan of the modified tree (ground truth).
    const secondFullMap = scanRepo(tp.root);

    // M3 invariant: byte-identical to the fresh full scan.
    expect(serializeRepoMap(incrMap)).toBe(serializeRepoMap(secondFullMap));
  });

  it("modifying a deeply-imported file: incremental == fresh full scan", () => {
    tp = makeTempProject();
    write(tp.root, baseTree());

    const firstFull = scanRepo(tp.root);

    // Modify src/greet.ts — it is imported by src/index.ts, src/app.ts, and tests/.
    write(tp.root, {
      "src/greet.ts":
        "/** REQ-GREET-001 REQ-GREET-002 */\n" +
        "export function greet(name: string): string {\n" +
        "  return `Hi, ${name}!`;\n" +
        "}\n" +
        "export function farewell(name: string): string {\n" +
        "  return `Bye, ${name}.`;\n" +
        "}\n",
    });
    const dirty = new Set(["src/greet.ts"]);

    const incrMap = scanRepo(tp.root, {
      incrementalOpts: { dirtyFiles: dirty, previousMap: firstFull },
    });
    const freshFull = scanRepo(tp.root);

    expect(serializeRepoMap(incrMap)).toBe(serializeRepoMap(freshFull));
  });

  it("modifying package.json (always-read manifest): incremental == fresh full scan", () => {
    tp = makeTempProject();
    write(tp.root, baseTree());

    const firstFull = scanRepo(tp.root);

    // Modify package.json — it is always re-read even if not in dirtyFiles,
    // but marking it dirty exercises the explicit dirty-file path too.
    write(tp.root, {
      "package.json": JSON.stringify({
        name: "scan-equiv-pkg",
        version: "2.0.0",
        scripts: { test: "vitest run", build: "tsc" },
      }),
    });
    const dirty = new Set(["package.json"]);

    const incrMap = scanRepo(tp.root, {
      incrementalOpts: { dirtyFiles: dirty, previousMap: firstFull },
    });
    const freshFull = scanRepo(tp.root);

    expect(serializeRepoMap(incrMap)).toBe(serializeRepoMap(freshFull));
  });
});

// ---------------------------------------------------------------------------
// Per-file data preservation for unchanged files
// ---------------------------------------------------------------------------

describe("per-file data: unchanged files preserve req_ids and symbols", () => {
  it("unchanged file req_ids are preserved exactly (M3)", () => {
    tp = makeTempProject();
    write(tp.root, baseTree());

    const fullMap = scanRepo(tp.root);

    // Modify only src/app.ts; src/greet.ts (with REQ anchor) is unchanged.
    write(tp.root, {
      "src/app.ts":
        'import { greet } from "./greet";\n' +
        "console.log(greet(\"updated\"));\n",
    });

    const incrMap = scanRepo(tp.root, {
      incrementalOpts: {
        dirtyFiles: new Set(["src/app.ts"]),
        previousMap: fullMap,
      },
    });

    const fullGreet = fullMap.files.find((f) => f.path === "src/greet.ts")!;
    const incrGreet = incrMap.files.find((f) => f.path === "src/greet.ts")!;
    expect(incrGreet).toBeDefined();
    // REQ-GREET-001 must be present and identical.
    expect(incrGreet.req_ids).toEqual(fullGreet.req_ids);
  });

  it("unchanged file exported symbols are preserved exactly (M3)", () => {
    tp = makeTempProject();
    write(tp.root, baseTree());

    const fullMap = scanRepo(tp.root);

    // Dirty only util.ts; greet.ts symbols must be reused from fullMap.
    write(tp.root, {
      "src/util.ts": 'export const VERSION = "2.0.0";\n',
    });

    const incrMap = scanRepo(tp.root, {
      incrementalOpts: {
        dirtyFiles: new Set(["src/util.ts"]),
        previousMap: fullMap,
      },
    });

    const fullGreet = fullMap.files.find((f) => f.path === "src/greet.ts")!;
    const incrGreet = incrMap.files.find((f) => f.path === "src/greet.ts")!;
    expect(incrGreet.symbols).toEqual(fullGreet.symbols);
  });

  it("dirty file gets fresh symbols while unchanged files keep prior symbols", () => {
    tp = makeTempProject();
    write(tp.root, baseTree());

    const fullMap = scanRepo(tp.root);

    // Add a new export to util.ts.
    write(tp.root, {
      "src/util.ts": 'export const VERSION = "2.0.0";\nexport const REVISION = 42;\n',
    });

    const incrMap = scanRepo(tp.root, {
      incrementalOpts: {
        dirtyFiles: new Set(["src/util.ts"]),
        previousMap: fullMap,
      },
    });

    // util.ts is dirty — must have both new symbols.
    const incrUtil = incrMap.files.find((f) => f.path === "src/util.ts")!;
    const symbolNames = (incrUtil.symbols ?? []).map((s) => s.name);
    expect(symbolNames).toContain("VERSION");
    expect(symbolNames).toContain("REVISION");

    // greet.ts is unchanged — must match the first full scan's symbols.
    const fullGreet = fullMap.files.find((f) => f.path === "src/greet.ts")!;
    const incrGreet = incrMap.files.find((f) => f.path === "src/greet.ts")!;
    expect(incrGreet.symbols).toEqual(fullGreet.symbols);
  });
});

// ---------------------------------------------------------------------------
// Entry-file detection runs even for reused (unchanged) files
// ---------------------------------------------------------------------------

describe("entry-file detection fires for reused files", () => {
  it("conventional entry file (src/index.ts) is still detected as entrypoint when reused", () => {
    tp = makeTempProject();
    write(tp.root, baseTree());

    const fullMap = scanRepo(tp.root);

    // Dirty only util.ts; src/index.ts is unchanged but is a conventional entry.
    write(tp.root, {
      "src/util.ts": 'export const VERSION = "2.0.0";\n',
    });

    const incrMap = scanRepo(tp.root, {
      incrementalOpts: {
        dirtyFiles: new Set(["src/util.ts"]),
        previousMap: fullMap,
      },
    });

    const fullEntry = fullMap.entrypoints.find((e) => e.path === "src/index.ts");
    const incrEntry = incrMap.entrypoints.find((e) => e.path === "src/index.ts");

    // If entry was in full scan, it must be in incremental scan too.
    if (fullEntry !== undefined) {
      expect(incrEntry).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Page projection stability — advisory views derived from the byte-stable map
// ---------------------------------------------------------------------------

describe("page projections are deterministic and byte-stable (advisory only)", () => {
  it("buildCallerPages output is identical for full vs incremental map", () => {
    tp = makeTempProject();
    write(tp.root, baseTree());

    const fullMap = scanRepo(tp.root);

    write(tp.root, {
      "src/util.ts": 'export const VERSION = "2.0.0";\n',
    });

    const incrMap = scanRepo(tp.root, {
      incrementalOpts: {
        dirtyFiles: new Set(["src/util.ts"]),
        previousMap: fullMap,
      },
    });
    const freshFull = scanRepo(tp.root);

    expect(JSON.stringify(buildCallerPages(incrMap))).toBe(
      JSON.stringify(buildCallerPages(freshFull)),
    );
  });

  it("buildTestPages output is identical for full vs incremental map", () => {
    tp = makeTempProject();
    write(tp.root, baseTree());

    const fullMap = scanRepo(tp.root);

    write(tp.root, {
      "src/util.ts": 'export const VERSION = "2.0.0";\n',
    });

    const incrMap = scanRepo(tp.root, {
      incrementalOpts: {
        dirtyFiles: new Set(["src/util.ts"]),
        previousMap: fullMap,
      },
    });
    const freshFull = scanRepo(tp.root);

    expect(JSON.stringify(buildTestPages(incrMap))).toBe(
      JSON.stringify(buildTestPages(freshFull)),
    );
  });

  it("buildSymbolPages output is identical for full vs incremental map", () => {
    tp = makeTempProject();
    write(tp.root, baseTree());

    const fullMap = scanRepo(tp.root);

    write(tp.root, {
      "src/util.ts": 'export const VERSION = "2.0.0";\nexport const REVISION = 42;\n',
    });

    const incrMap = scanRepo(tp.root, {
      incrementalOpts: {
        dirtyFiles: new Set(["src/util.ts"]),
        previousMap: fullMap,
      },
    });
    const freshFull = scanRepo(tp.root);

    expect(JSON.stringify(buildSymbolPages(incrMap))).toBe(
      JSON.stringify(buildSymbolPages(freshFull)),
    );
  });

  it("buildComponentPages output is identical for full vs incremental map", () => {
    tp = makeTempProject();
    write(tp.root, baseTree());

    const fullMap = scanRepo(tp.root);

    write(tp.root, {
      "src/util.ts": 'export const VERSION = "2.0.0";\n',
    });

    const incrMap = scanRepo(tp.root, {
      incrementalOpts: {
        dirtyFiles: new Set(["src/util.ts"]),
        previousMap: fullMap,
      },
    });
    const freshFull = scanRepo(tp.root);

    expect(JSON.stringify(buildComponentPages(incrMap))).toBe(
      JSON.stringify(buildComponentPages(freshFull)),
    );
  });

  it("buildCallerPages: caller relationships are pure derived data (no side effects)", () => {
    tp = makeTempProject();
    write(tp.root, baseTree());

    const map = scanRepo(tp.root);
    const pages = buildCallerPages(map);

    // src/greet.ts is imported by src/index.ts, src/app.ts, tests/greet.test.ts
    // — it must appear as a target with callers if edges were resolved.
    const greetPage = pages.find((p) => p.file === "src/greet.ts");
    if (greetPage !== undefined) {
      // At least one caller, sorted.
      expect(greetPage.callers.length).toBeGreaterThan(0);
      const sorted = [...greetPage.callers].sort();
      expect(greetPage.callers).toEqual(sorted);
    }
  });

  it("buildSymbolPages: output sorted by (defined_in, name, kind)", () => {
    tp = makeTempProject();
    write(tp.root, baseTree());

    const map = scanRepo(tp.root);
    const pages = buildSymbolPages(map);

    // Verify sort invariant: each page must be >= the previous.
    for (let i = 1; i < pages.length; i++) {
      const prev = pages[i - 1]!;
      const curr = pages[i]!;
      const cmp =
        prev.defined_in < curr.defined_in ? -1 :
        prev.defined_in > curr.defined_in ? 1 :
        prev.name < curr.name ? -1 :
        prev.name > curr.name ? 1 :
        prev.kind < curr.kind ? -1 :
        prev.kind > curr.kind ? 1 : 0;
      expect(cmp).toBeLessThanOrEqual(0);
    }
  });

  it("buildComponentPages: symbols sorted by (name, kind) within each component", () => {
    tp = makeTempProject();
    write(tp.root, baseTree());

    const map = scanRepo(tp.root);
    const pages = buildComponentPages(map);

    for (const page of pages) {
      for (let i = 1; i < page.symbols.length; i++) {
        const prev = page.symbols[i - 1]!;
        const curr = page.symbols[i]!;
        const cmp =
          prev.name < curr.name ? -1 :
          prev.name > curr.name ? 1 :
          prev.kind < curr.kind ? -1 :
          prev.kind > curr.kind ? 1 : 0;
        expect(cmp).toBeLessThanOrEqual(0);
      }
    }
  });
});
