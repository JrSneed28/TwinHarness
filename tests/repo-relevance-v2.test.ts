/**
 * P2-5 / P2-6 / P2-7 / P2-8 — relevance ranking v2, file→test mapping, impact v2,
 * and precision telemetry, all over resolved import/symbol edges.
 *
 * The CENTRAL invariant (rev 2 S1 / P2-8): a file that is TIGHTLY COUPLED to the
 * seed by a RESOLVED import edge must outrank a merely SAME-COMPONENT sibling.
 * Unresolved/regex signals are capped at low and never outrank an honest path-token.
 */

import { describe, it, expect } from "vitest";
import { emptyRepoMap, type RepoMap } from "../src/core/repo-map/schema";
import { computeRelevance, computeImpact } from "../src/core/repo-map/query";

/** Build an in-memory map with explicit files + edges (no FS). */
function mapWith(
  files: { path: string; component?: string | null; is_test?: boolean; req_ids?: string[]; symbols?: { name: string; kind: string }[] }[],
  edges?: { from: string; to: string; basis: "parsed" | "unresolved"; external?: boolean }[],
): RepoMap {
  const m = emptyRepoMap("/tmp/x");
  m.files = files.map((f) => ({
    path: f.path,
    component: f.component ?? null,
    language: "TypeScript",
    is_test: f.is_test ?? false,
    req_ids: f.req_ids ?? [],
    ...(f.symbols ? { symbols: f.symbols as RepoMap["files"][number]["symbols"] } : {}),
  }));
  if (edges) m.edges = edges.map((e) => ({ from: e.from, to: e.to, kind: "import" as const, basis: e.basis, ...(e.external ? { external: true } : {}) }));
  return m;
}

describe("P2-5 — resolved import proximity outranks a same-component sibling", () => {
  it("a tightly-coupled importer ranks above a loosely-related sibling (order-sensitive)", () => {
    // seed = src/core/target.ts. `importer.ts` (different component) imports it via a
    // RESOLVED edge; `sibling.ts` merely shares the seed's component.
    const map = mapWith(
      [
        { path: "src/core/target.ts", component: "src/core" },
        { path: "src/core/sibling.ts", component: "src/core" },
        { path: "src/api/importer.ts", component: "src/api" },
        { path: "src/api/unrelated.ts", component: "src/api" },
      ],
      [{ from: "src/api/importer.ts", to: "src/core/target.ts", basis: "parsed" }],
    );
    const r = computeRelevance(map, { kind: "file", value: "src/core/target.ts" });
    const importerItem = r.related.find((i) => i.path === "src/api/importer.ts");
    const siblingItem = r.related.find((i) => i.path === "src/core/sibling.ts");
    expect(importerItem).toBeDefined();
    expect(siblingItem).toBeDefined();
    // The resolved importer must score strictly higher than the path-token sibling.
    expect(importerItem!.score).toBeGreaterThan(siblingItem!.score);
    // ...and therefore appear earlier in the (score-desc) related list.
    const idxImp = r.related.findIndex((i) => i.path === "src/api/importer.ts");
    const idxSib = r.related.findIndex((i) => i.path === "src/core/sibling.ts");
    expect(idxImp).toBeLessThan(idxSib);
  });

  it("an UNRESOLVED/external edge contributes NO ranking signal (never outranks path-token)", () => {
    const map = mapWith(
      [
        { path: "src/core/target.ts", component: "src/core" },
        { path: "src/api/importer.ts", component: "src/api" },
      ],
      // The importer's edge to the seed is UNRESOLVED (e.g. a bare alias) → ignored.
      [{ from: "src/api/importer.ts", to: "target", basis: "unresolved", external: true }],
    );
    const r = computeRelevance(map, { kind: "file", value: "src/core/target.ts" });
    // The importer earns nothing from the unresolved edge (different component, no
    // other signal) → it does not appear in related at all.
    expect(r.related.some((i) => i.path === "src/api/importer.ts")).toBe(false);
  });

  it("P2-5 — a query keyword matching an exported symbol name boosts that file", () => {
    const map = mapWith([
      { path: "src/auth/login.ts", symbols: [{ name: "authenticate", kind: "function" }] },
      { path: "src/util/misc.ts", symbols: [{ name: "helper", kind: "function" }] },
    ]);
    const r = computeRelevance(map, { kind: "query", value: "authenticate" });
    const hit = [...r.readFirst, ...r.related].find((i) => i.path === "src/auth/login.ts");
    expect(hit).toBeDefined();
    expect(hit!.why).toContain("authenticate");
  });
});

describe("P2-6 — mechanical file→test mapping", () => {
  it("links a foo.test by name convention and a test that imports the seed", () => {
    const map = mapWith(
      [
        { path: "src/core/foo.ts", component: "src/core" },
        { path: "tests/foo.test.ts", is_test: true },
        { path: "tests/other.test.ts", is_test: true },
      ],
      [{ from: "tests/other.test.ts", to: "src/core/foo.ts", basis: "parsed" }],
    );
    const r = computeRelevance(map, { kind: "file", value: "src/core/foo.ts" });
    const testPaths = r.tests.map((t) => t.path);
    expect(testPaths).toContain("tests/foo.test.ts"); // name convention
    expect(testPaths).toContain("tests/other.test.ts"); // resolved import edge
  });
});

describe("P2-7 — impact v2: directImpact vs possibleImpact + caveat", () => {
  it("separates a resolved importer (direct) from a same-component sibling (possible)", () => {
    const map = mapWith(
      [
        { path: "src/core/target.ts", component: "src/core" },
        { path: "src/core/sibling.ts", component: "src/core" },
        { path: "src/api/importer.ts", component: "src/api" },
      ],
      [{ from: "src/api/importer.ts", to: "src/core/target.ts", basis: "parsed" }],
    );
    const r = computeImpact(map, { kind: "file", value: "src/core/target.ts" });
    const directPaths = r.directImpact.map((d) => d.path);
    expect(directPaths).toContain("src/core/target.ts"); // seed
    expect(directPaths).toContain("src/api/importer.ts"); // resolved importer
    const directImporter = r.directImpact.find((d) => d.path === "src/api/importer.ts")!;
    expect(directImporter.basis).toBe("parsed");
    expect(directImporter.confidence).toBe("high");
    // The same-component sibling is POSSIBLE, low-confidence, path-token.
    const possible = r.possibleImpact.find((p) => p.path === "src/core/sibling.ts");
    expect(possible).toBeDefined();
    expect(possible!.basis).toBe("path-token");
    expect(possible!.confidence).toBe("low");
  });

  it("sets caveat=true when impact rests only on path-token heuristics", () => {
    const map = mapWith([
      { path: "src/core/a.ts", component: "src/core" },
      { path: "src/core/b.ts", component: "src/core" },
    ]);
    const r = computeImpact(map, { kind: "component", value: "src/core" });
    expect(r.caveat).toBe(true);
  });
});

describe("P2-8 — precision telemetry (the validation gate)", () => {
  it("counts related-but-zero-coupling separately from coupled suggestions", () => {
    const map = mapWith(
      [
        { path: "src/core/target.ts", component: "src/core" },
        { path: "src/core/sibling.ts", component: "src/core" }, // zero-coupling (path-token)
        { path: "src/api/importer.ts", component: "src/api" }, // coupled (resolved edge)
      ],
      [{ from: "src/api/importer.ts", to: "src/core/target.ts", basis: "parsed" }],
    );
    const r = computeRelevance(map, { kind: "file", value: "src/core/target.ts" });
    expect(r.precision.relatedCoupled).toBe(1);
    expect(r.precision.relatedZeroCoupling).toBe(1);
  });
});

describe("REQ-P4-4 — relevance/impact carry the partial-scan flag from the loaded map", () => {
  it("computeRelevance reflects a partial (capped) map", () => {
    const map = mapWith([{ path: "src/core/target.ts", component: "src/core" }]);
    map.scanReport.capHit = "file-count";
    const r = computeRelevance(map, { kind: "file", value: "src/core/target.ts" });
    expect(r.partial).toBe(true);
    expect(r.scanIncomplete).toBe(true);
  });

  it("computeImpact reflects a complete map as not-partial", () => {
    const map = mapWith([{ path: "src/core/target.ts", component: "src/core" }]);
    // capHit defaults to null on emptyRepoMap → complete.
    const r = computeImpact(map, { kind: "file", value: "src/core/target.ts" });
    expect(r.partial).toBe(false);
    expect(r.scanIncomplete).toBe(false);
  });
});
