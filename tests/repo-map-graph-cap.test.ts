/**
 * AC#4 (STEP 4) — graph-cap truncation is no longer SILENT.
 *
 * Before this change, hitting the whole-graph edge/symbol ceilings stopped graph
 * accumulation WITHOUT marking the map partial (only the file/byte caps did). Now the
 * edge cap sets `scanReport.capHit="edge-cap"` and the symbol cap sets
 * `"symbol-cap"` — the FIRST cap encountered wins (representative), and the derived
 * `partial:true` + PARTIAL banner are the load-bearing exhaustive honesty signal,
 * consistent with the file/byte caps.
 *
 * The whole-graph ceilings are module consts; `ScanOptions.maxTotalEdges` /
 * `maxTotalSymbols` (test-only overrides mirroring `fileCountCap`) let a TINY real
 * fixture exercise the truncation path without synthesizing 100k symbols / 200k edges.
 *
 * Determinism (ADR-003): the capHit marker is a bounded enum independent of traversal
 * order, so a capped scan serializes byte-identically across runs.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import { scanRepo } from "../src/core/repo-map/scanner";
import { serializeRepoMap } from "../src/core/repo-map/schema";
import { runRepoMap, repoFreshnessSummary } from "../src/commands/repo";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

function write(root: string, tree: Record<string, string>): void {
  for (const [rel, content] of Object.entries(tree)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
}

/** A tiny TS project with several resolvable relative import edges. */
function multiEdgeTree(): Record<string, string> {
  return {
    "src/a.ts": 'import { b } from "./b";\nimport { c } from "./c";\nexport const a = (b as unknown as number) + (c as unknown as number);\n',
    "src/b.ts": 'import { c } from "./c";\nexport const b = c;\n',
    "src/c.ts": "export const c = 1;\n",
    "src/d.ts": 'import { a } from "./a";\nexport const d = a;\n',
  };
}

describe("AC#4 — edge cap declares the map partial (capHit='edge-cap')", () => {
  it("hitting maxTotalEdges sets capHit='edge-cap' and the derived partial banner", () => {
    tp = makeTempProject();
    write(tp.root, multiEdgeTree());
    // Cap edges at 1 — the tree has multiple resolvable edges, so truncation is forced.
    const map = scanRepo(tp.root, { maxTotalEdges: 1 });
    expect(map.scanReport.capHit).toBe("edge-cap");
    // At most `maxTotalEdges` edges were kept.
    expect((map.edges ?? []).length).toBeLessThanOrEqual(1);
    // The serialized artifact declares it partial (derived from any non-null capHit).
    const json = serializeRepoMap(map);
    const parsed = JSON.parse(json) as { capHit: string; partial: boolean };
    expect(parsed.capHit).toBe("edge-cap");
    expect(parsed.partial).toBe(true);
  });

  it("an uncapped scan of the same tree is complete (capHit=null, partial:false)", () => {
    tp = makeTempProject();
    write(tp.root, multiEdgeTree());
    const map = scanRepo(tp.root);
    expect(map.scanReport.capHit).toBeNull();
    const parsed = JSON.parse(serializeRepoMap(map)) as { partial: boolean };
    expect(parsed.partial).toBe(false);
  });

  it("ADR-003 — a capped (edge-cap) scan serializes byte-identically across two runs", () => {
    tp = makeTempProject();
    write(tp.root, multiEdgeTree());
    const a = serializeRepoMap(scanRepo(tp.root, { maxTotalEdges: 1 }));
    const b = serializeRepoMap(scanRepo(tp.root, { maxTotalEdges: 1 }));
    expect(a).toBe(b);
  });
});

describe("AC#4 — symbol cap declares the map partial (capHit='symbol-cap')", () => {
  it("hitting maxTotalSymbols sets capHit='symbol-cap'", () => {
    tp = makeTempProject();
    write(tp.root, {
      // Several exported symbols across files; a maxTotalSymbols of 1 truncates them.
      "src/x.ts": "export const m = 1;\nexport const n = 2;\n",
      "src/y.ts": "export const o = 3;\n",
    });
    const map = scanRepo(tp.root, { maxTotalSymbols: 1 });
    expect(map.scanReport.capHit).toBe("symbol-cap");
    const parsed = JSON.parse(serializeRepoMap(map)) as { partial: boolean };
    expect(parsed.partial).toBe(true);
  });

  it("ADR-003 — a capped (symbol-cap) scan serializes byte-identically across two runs", () => {
    tp = makeTempProject();
    write(tp.root, { "src/x.ts": "export const m = 1;\nexport const n = 2;\n", "src/y.ts": "export const o = 3;\n" });
    const a = serializeRepoMap(scanRepo(tp.root, { maxTotalSymbols: 1 }));
    const b = serializeRepoMap(scanRepo(tp.root, { maxTotalSymbols: 1 }));
    expect(a).toBe(b);
  });
});

describe("AC#4 — MCP freshness surfaces the new cap marker (withFreshness path)", () => {
  it("a persisted edge-capped map surfaces partial + capHit through repoFreshnessSummary", () => {
    tp = makeTempProject();
    write(tp.root, multiEdgeTree());
    // Persist a partial (edge-capped) map via the real command, then read it back the
    // way the MCP `withFreshness` wrapper does (repoFreshnessSummary → persisted capHit).
    const res = runRepoMap(tp.paths, { scanOptions: { maxTotalEdges: 1 } });
    expect(res.ok).toBe(true);
    const f = repoFreshnessSummary(tp.paths);
    expect(f.capHit).toBe("edge-cap");
    expect(f.partial).toBe(true);
    expect(f.scanIncomplete).toBe(true);
    // `withFreshness` flags the result stale when partial — mirror that derivation.
    expect(!f.fresh || f.partial).toBe(true);
  });
});
