/**
 * DEFERRED #2 — wire lcov coverage into relevance with P2-8 integrity.
 *
 *  - SCANNER (command layer): an lcov report present → a bounded, SORTED `coverage`
 *    field; emitted ONLY when a report exists → no-coverage repos stay byte-identical.
 *  - QUERY: a coverage-derived signal (basis "coverage") weighted BELOW the lowest
 *    path-token/component signal — it can never outrank a resolved edge or path-token.
 *  - P2-8: coverage-only items change NEITHER `relatedCoupled` NOR
 *    `relatedZeroCoupling` (excluded from both numerator and denominator).
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import { runRepoMap } from "../src/commands/repo";
import { parseRepoMap, serializeRepoMap, type RepoMap } from "../src/core/repo-map/schema";
import { computeRelevance } from "../src/core/repo-map/query";
import { resolveProjectPaths } from "../src/core/paths";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

function write(root: string, tree: Record<string, string>): void {
  for (const [rel, content] of Object.entries(tree)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
}

/**
 * Build the in-memory map produced by `th repo map` (which reads the lcov report and
 * persists `coverage`). We write to disk then round-trip through `parseRepoMap` so the
 * test exercises the SAME serialize→parse path the consumers use.
 */
function buildMap(root: string): RepoMap {
  const paths = resolveProjectPaths(root);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  const res = runRepoMap(paths, { write: true });
  expect(res.ok).toBe(true);
  const json = fs.readFileSync(path.join(paths.stateDir, "repo-map.json"), "utf8");
  const parsed = parseRepoMap(json);
  expect(parsed.ok).toBe(true);
  return parsed.map!;
}

describe("DEFERRED #2 — scanner persists a bounded, sorted coverage field", () => {
  it("emits `coverage` (sorted, contained, knownFiles-restricted) when an lcov report exists", () => {
    tp = makeTempProject();
    write(tp.root, {
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": "export const b = 2;\n",
      "lcov.info": [
        "TN:",
        "SF:src/b.ts",
        "end_of_record",
        "SF:src/a.ts",
        "end_of_record",
        "SF:src/deleted.ts", // not scanned → dropped by knownFiles
        "end_of_record",
        "SF:../../etc/passwd", // escaping → dropped
        "end_of_record",
      ].join("\n"),
    });
    const map = buildMap(tp.root);
    expect(map.coverage).toEqual(["src/a.ts", "src/b.ts"]); // sorted, contained
    expect(map.coverage).not.toContain("src/deleted.ts");
    expect(map.coverage!.some((p) => p.includes(".."))).toBe(false);
  });

  it("a no-lcov repo omits `coverage` entirely → byte-identical to a legacy v3 map", () => {
    tp = makeTempProject();
    write(tp.root, { "src/a.ts": "export const a = 1;\n" });
    const map = buildMap(tp.root);
    expect(map.coverage).toBeUndefined();
    // The serialized form has no "coverage" key.
    expect(serializeRepoMap(map).includes('"coverage"')).toBe(false);
  });

  it("an lcov whose entries ALL escape/are stale yields NO coverage field", () => {
    tp = makeTempProject();
    write(tp.root, {
      "src/a.ts": "export const a = 1;\n",
      "coverage/lcov.info": [
        "SF:../../../etc/passwd",
        "end_of_record",
        "SF:src/gone.ts", // not scanned
        "end_of_record",
      ].join("\n"),
    });
    const map = buildMap(tp.root);
    expect(map.coverage).toBeUndefined();
  });
});

describe("DEFERRED #2 — coverage signal weight + P2-8 integrity", () => {
  it("a coverage-only item appears in related but ranks BELOW a path-token sibling", () => {
    // Seed src/core/seed.ts (covered). src/core/sibling.ts is a same-component
    // path-token sibling (score 40). tests/cov.test.ts is coverage-only (score 20).
    const map: RepoMap = {
      schema_version: 3,
      repoRoot: "/tmp/x",
      scanReport: { filesScanned: 0, filesSkipped: 0, capHit: null },
      languages: [],
      package_managers: [],
      candidate_commands: [],
      source_roots: [],
      test_roots: [],
      docs_roots: [],
      generated_paths: [],
      components: [],
      entrypoints: [],
      public_api: null,
      ownership_hints: [],
      files: [
        { path: "src/core/seed.ts", component: "src/core", language: "TypeScript", is_test: false, req_ids: [] },
        { path: "src/core/sibling.ts", component: "src/core", language: "TypeScript", is_test: false, req_ids: [] },
        { path: "tests/cov.test.ts", component: null, language: "TypeScript", is_test: true, req_ids: [] },
      ],
      req_anchors: [],
      blast_radius_signals: [],
      coverage: ["src/core/seed.ts", "tests/cov.test.ts"],
    };
    const r = computeRelevance(map, { kind: "file", value: "src/core/seed.ts" });
    const sibling = r.related.find((i) => i.path === "src/core/sibling.ts");
    const covTest = r.tests.find((i) => i.path === "tests/cov.test.ts");
    expect(sibling).toBeDefined();
    expect(covTest).toBeDefined();
    // Coverage signal (20) is strictly below the path-token sibling (40).
    expect(covTest!.score).toBeLessThan(sibling!.score);
    expect(covTest!.why).toMatch(/coverage association/);
  });

  it("coverage-only items change NEITHER relatedCoupled NOR relatedZeroCoupling (P2-8)", () => {
    const base: RepoMap = {
      schema_version: 3,
      repoRoot: "/tmp/x",
      scanReport: { filesScanned: 0, filesSkipped: 0, capHit: null },
      languages: [],
      package_managers: [],
      candidate_commands: [],
      source_roots: [],
      test_roots: [],
      docs_roots: [],
      generated_paths: [],
      components: [],
      entrypoints: [],
      public_api: null,
      ownership_hints: [],
      files: [
        { path: "src/core/seed.ts", component: "src/core", language: "TypeScript", is_test: false, req_ids: [] },
        { path: "src/core/sibling.ts", component: "src/core", language: "TypeScript", is_test: false, req_ids: [] },
        { path: "src/other/cov.ts", component: "src/other", language: "TypeScript", is_test: false, req_ids: [] },
      ],
      req_anchors: [],
      blast_radius_signals: [],
    };
    // Without coverage.
    const before = computeRelevance(base, { kind: "file", value: "src/core/seed.ts" });
    // With coverage adding ONLY a coverage-only related item (src/other/cov.ts).
    const withCov: RepoMap = { ...base, coverage: ["src/core/seed.ts", "src/other/cov.ts"] };
    const after = computeRelevance(withCov, { kind: "file", value: "src/core/seed.ts" });

    // The coverage-only item is now emitted as a related item...
    expect(after.related.some((i) => i.path === "src/other/cov.ts")).toBe(true);
    expect(before.related.some((i) => i.path === "src/other/cov.ts")).toBe(false);
    // ...but the P2-8 precision base is UNCHANGED (no new inflation).
    expect(after.precision.relatedCoupled).toBe(before.precision.relatedCoupled);
    expect(after.precision.relatedZeroCoupling).toBe(before.precision.relatedZeroCoupling);
  });

  it("the coverage signal never fires when NO seed is covered", () => {
    const map: RepoMap = {
      schema_version: 3,
      repoRoot: "/tmp/x",
      scanReport: { filesScanned: 0, filesSkipped: 0, capHit: null },
      languages: [],
      package_managers: [],
      candidate_commands: [],
      source_roots: [],
      test_roots: [],
      docs_roots: [],
      generated_paths: [],
      components: [],
      entrypoints: [],
      public_api: null,
      ownership_hints: [],
      files: [
        { path: "src/seed.ts", component: "src", language: "TypeScript", is_test: false, req_ids: [] },
        { path: "tests/cov.test.ts", component: null, language: "TypeScript", is_test: true, req_ids: [] },
      ],
      req_anchors: [],
      blast_radius_signals: [],
      // The seed (src/seed.ts) is NOT in the coverage set → no association fires.
      coverage: ["tests/cov.test.ts"],
    };
    const r = computeRelevance(map, { kind: "file", value: "src/seed.ts" });
    expect(r.tests.some((i) => i.path === "tests/cov.test.ts")).toBe(false);
  });

  it("deterministic ordering: re-running yields identical related/tests ordering", () => {
    tp = makeTempProject();
    write(tp.root, {
      "src/core/seed.ts": "export const s = 1;\n",
      "src/core/sib.ts": "export const x = 1;\n",
      "tests/one.test.ts": "// t\n",
      "tests/two.test.ts": "// t\n",
      "lcov.info": [
        "SF:src/core/seed.ts",
        "end_of_record",
        "SF:tests/one.test.ts",
        "end_of_record",
        "SF:tests/two.test.ts",
        "end_of_record",
      ].join("\n"),
    });
    const map = buildMap(tp.root);
    const a = computeRelevance(map, { kind: "file", value: "src/core/seed.ts" });
    const b = computeRelevance(map, { kind: "file", value: "src/core/seed.ts" });
    expect(a.tests.map((i) => i.path)).toEqual(b.tests.map((i) => i.path));
    expect(a.related.map((i) => i.path)).toEqual(b.related.map((i) => i.path));
  });
});
