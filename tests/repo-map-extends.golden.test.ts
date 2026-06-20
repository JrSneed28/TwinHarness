/**
 * AC#3 (STEP 3) — tsconfig/jsconfig `extends` chain resolution.
 *
 * Path aliases declared in a BASE config and inherited via `extends` (including
 * chains, and a bounded single node_modules hop) must resolve to `basis:"alias"`
 * import edges — NOT `basis:"unresolved"`. Before this change an inherited alias
 * degraded to `unresolved` (the Lane-3 controlled repro).
 *
 * This suite proves both halves of that repro:
 *  - UNIT (`resolveExtendsChain`): 3-config chain merges; a cycle / missing-base /
 *    unresolvable ref FAILS SAFE (never guesses); child `paths` REPLACE base `paths`
 *    (no deep-merge); `baseUrl` is child-wins; a bounded node_modules hop is followed.
 *  - GOLDEN (`scanRepo`): the committed `extends-monorepo/` fixture yields an
 *    `@app/*` edge with `basis:"alias"` THROUGH inheritance, and the committed
 *    `extends-inline/` control yields the IDENTICAL edge declared inline — the
 *    inline-vs-extends parity. Both are asserted two-run byte-identical (ADR-003).
 *
 * RULE-004 / fail-closed: base configs are read as INERT text → `parseJsonc`, never
 * executed; any miss yields no alias and the edge stays honestly `unresolved`.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveExtendsChain, resolveAliasTsJs } from "../src/core/repo-map/extract";
import { scanRepo } from "../src/core/repo-map/scanner";
import { serializeRepoMap } from "../src/core/repo-map/schema";

/**
 * Build a `readFile` reader over an in-memory POSIX-path → text map (the shape the
 * scanner passes `resolveExtendsChain`). A missing key returns undefined (the
 * unreadable-base fail-safe path), exactly like the scanner's lazy reader on a miss.
 */
function readerOf(files: Record<string, string>): (p: string) => string | undefined {
  return (p) => (p in files ? files[p] : undefined);
}

const FIXTURES = path.join(__dirname, "fixtures");

describe("AC#3 — resolveExtendsChain (real TS inheritance, fail-safe, deterministic)", () => {
  it("merges a 3-config chain: child → mid → base, inheriting the base's paths", () => {
    const files = {
      "tsconfig.json": JSON.stringify({ extends: "./tsconfig.mid.json" }),
      "tsconfig.mid.json": JSON.stringify({ extends: "./tsconfig.base.json" }),
      "tsconfig.base.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@app/*": ["src/*"] } },
      }),
    };
    const parsed = JSON.parse(files["tsconfig.json"]) as Record<string, unknown>;
    const table = resolveExtendsChain("tsconfig.json", parsed, readerOf(files));
    expect(table).toBeDefined();
    // configDir = the ENTRY config's dir ("" — repo root); baseDir = "" (baseUrl ".").
    expect(table!.configDir).toBe("");
    expect(table!.baseDir).toBe("");
    expect(table!.hasBaseUrl).toBe(true);
    expect(table!.patterns).toEqual([{ pattern: "@app/*", targets: ["src/*"] }]);
  });

  it("FAILS SAFE on a cycle (a → b → a): the chain stops, no infinite loop, partial result", () => {
    const files = {
      "a.json": JSON.stringify({ extends: "./b.json", compilerOptions: { baseUrl: "." } }),
      "b.json": JSON.stringify({ extends: "./a.json", compilerOptions: { paths: { "@/*": ["lib/*"] } } }),
    };
    const parsed = JSON.parse(files["a.json"]) as Record<string, unknown>;
    // Must terminate (cycle-bounded). `a` has baseUrl; `b` (visited once) supplies paths.
    const table = resolveExtendsChain("a.json", parsed, readerOf(files));
    expect(table).toBeDefined();
    expect(table!.patterns).toEqual([{ pattern: "@/*", targets: ["lib/*"] }]);
  });

  it("FAILS SAFE on a missing base: an extends-ref that does not resolve yields only the child's own options", () => {
    const files = {
      // The base is referenced but NOT present in the reader → unreadable → skipped.
      "tsconfig.json": JSON.stringify({
        extends: "./tsconfig.base.json",
        compilerOptions: { baseUrl: ".", paths: { "@x/*": ["x/*"] } },
      }),
    };
    const parsed = JSON.parse(files["tsconfig.json"]) as Record<string, unknown>;
    const table = resolveExtendsChain("tsconfig.json", parsed, readerOf(files));
    expect(table).toBeDefined();
    expect(table!.patterns).toEqual([{ pattern: "@x/*", targets: ["x/*"] }]);
  });

  it("returns undefined when neither the child nor any reachable base declares baseUrl/paths", () => {
    const files = {
      "tsconfig.json": JSON.stringify({ extends: "./tsconfig.base.json", compilerOptions: { strict: true } }),
      "tsconfig.base.json": JSON.stringify({ compilerOptions: { target: "ES2020" } }),
    };
    const parsed = JSON.parse(files["tsconfig.json"]) as Record<string, unknown>;
    expect(resolveExtendsChain("tsconfig.json", parsed, readerOf(files))).toBeUndefined();
  });

  it("child `paths` REPLACE base `paths` wholesale (NO deep-merge)", () => {
    const files = {
      "tsconfig.json": JSON.stringify({
        extends: "./tsconfig.base.json",
        compilerOptions: { paths: { "@child/*": ["child/*"] } },
      }),
      "tsconfig.base.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@base/*": ["base/*"] } },
      }),
    };
    const parsed = JSON.parse(files["tsconfig.json"]) as Record<string, unknown>;
    const table = resolveExtendsChain("tsconfig.json", parsed, readerOf(files));
    expect(table).toBeDefined();
    // ONLY the child's paths survive; the base's `@base/*` is shadowed entirely.
    expect(table!.patterns).toEqual([{ pattern: "@child/*", targets: ["child/*"] }]);
    // baseUrl is still inherited from the base (child declared none).
    expect(table!.hasBaseUrl).toBe(true);
  });

  it("`baseUrl` is child-wins (the nearest config in the chain that sets it)", () => {
    const files = {
      "pkg/tsconfig.json": JSON.stringify({
        extends: "../tsconfig.base.json",
        compilerOptions: { baseUrl: "src", paths: { "@/*": ["a/*"] } },
      }),
      "tsconfig.base.json": JSON.stringify({ compilerOptions: { baseUrl: "lib" } }),
    };
    const parsed = JSON.parse(files["pkg/tsconfig.json"]) as Record<string, unknown>;
    const table = resolveExtendsChain("pkg/tsconfig.json", parsed, readerOf(files));
    expect(table).toBeDefined();
    // Child baseUrl "src" (declared in pkg/) wins → baseDir = pkg/src, NOT the base's lib.
    expect(table!.baseDir).toBe("pkg/src");
  });

  it("follows a BOUNDED single node_modules hop for a bare extends ref", () => {
    const files = {
      "tsconfig.json": JSON.stringify({ extends: "@org/tsconfig/base.json" }),
      // Single hop: node_modules/<spec>. No recursive walk, no package.json lookup.
      "node_modules/@org/tsconfig/base.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@app/*": ["src/*"] } },
      }),
    };
    const parsed = JSON.parse(files["tsconfig.json"]) as Record<string, unknown>;
    const table = resolveExtendsChain("tsconfig.json", parsed, readerOf(files));
    expect(table).toBeDefined();
    expect(table!.patterns).toEqual([{ pattern: "@app/*", targets: ["src/*"] }]);
    // The inherited paths resolve relative to the BASE's declaring dir (node_modules/@org/tsconfig).
    expect(table!.baseDir).toBe("node_modules/@org/tsconfig");
  });

  it("never escapes the repo: a `..`-escaping extends ref is rejected (fail-safe)", () => {
    const files = {
      "tsconfig.json": JSON.stringify({ extends: "../../outside/tsconfig.json" }),
    };
    const parsed = JSON.parse(files["tsconfig.json"]) as Record<string, unknown>;
    // The escaping ref is not followed; with no own options the result is undefined.
    expect(resolveExtendsChain("tsconfig.json", parsed, readerOf(files))).toBeUndefined();
  });

  it("the produced table resolves an inherited alias edge end-to-end via resolveAliasTsJs", () => {
    const files = {
      "packages/app/tsconfig.json": JSON.stringify({ extends: "../../configs/tsconfig.base.json" }),
      "configs/tsconfig.base.json": JSON.stringify({
        compilerOptions: { baseUrl: "..", paths: { "@app/*": ["packages/app/src/*"] } },
      }),
    };
    const parsed = JSON.parse(files["packages/app/tsconfig.json"]) as Record<string, unknown>;
    const table = resolveExtendsChain("packages/app/tsconfig.json", parsed, readerOf(files))!;
    const fileSet = new Set(["packages/app/src/util.ts", "packages/app/src/main.ts"]);
    // The config governs files under packages/app and resolves @app/util to the target.
    const to = resolveAliasTsJs("packages/app/src/main.ts", "@app/util", [table], fileSet);
    expect(to).toBe("packages/app/src/util.ts");
    // ...and does NOT govern a file outside packages/app (governance = entry dir).
    expect(resolveAliasTsJs("other/main.ts", "@app/util", [table], fileSet)).toBeNull();
  });
});

describe("AC#3 — golden: inherited alias edge over the committed extends fixture (basis:'alias')", () => {
  it("an `@app/*` import inherited via extends resolves to basis:'alias' (NOT unresolved)", () => {
    const map = scanRepo(path.join(FIXTURES, "extends-monorepo"));
    const edge = (map.edges ?? []).find(
      (e) => e.from === "packages/app/src/main.ts" && e.to === "packages/app/src/util.ts",
    );
    expect(edge, "inherited @app/util edge must exist").toBeDefined();
    expect(edge!.basis).toBe("alias");
    // The honest-unresolved label must NOT also appear for this specifier.
    expect((map.edges ?? []).some((e) => e.to === "@app/util" && e.basis === "unresolved")).toBe(false);
  });

  it("inline-vs-extends parity: the inline control fixture lands the IDENTICAL alias edge", () => {
    const mapInline = scanRepo(path.join(FIXTURES, "extends-inline"));
    const edge = (mapInline.edges ?? []).find(
      (e) => e.from === "packages/app/src/main.ts" && e.to === "packages/app/src/util.ts",
    );
    expect(edge, "inline @app/util edge must exist").toBeDefined();
    expect(edge!.basis).toBe("alias");
  });

  it("ADR-003 — two runs over the extends fixture serialize byte-identically", () => {
    const root = path.join(FIXTURES, "extends-monorepo");
    const a = serializeRepoMap(scanRepo(root));
    const b = serializeRepoMap(scanRepo(root));
    expect(a).toBe(b);
  });
});

describe("AC#3 — scanner: a `tsconfig.base.json` base config is now captured + lazily readable", () => {
  it("resolves an alias whose base lives in node_modules (excluded from the walk) via the lazy reader", () => {
    // Build an OS-tmpdir project whose extends base sits under the EXCLUDED node_modules
    // dir — proving the lazy reader follows the single node_modules hop the walk skips.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "th-extends-nm-"));
    try {
      const write = (rel: string, content: string): void => {
        const abs = path.join(root, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, "utf8");
      };
      write("tsconfig.json", JSON.stringify({ extends: "@org/tsc/base.json" }));
      // The base sits at node_modules/@org/tsc/; baseUrl "../../.." points its inherited
      // paths back at the consuming repo root, where src/* lives.
      write(
        "node_modules/@org/tsc/base.json",
        JSON.stringify({ compilerOptions: { baseUrl: "../../..", paths: { "@app/*": ["src/*"] } } }),
      );
      write("src/util.ts", "export const x = 1;\n");
      write("src/main.ts", 'import { x } from "@app/util";\nexport const y = x;\n');

      const map = scanRepo(root);
      const edge = (map.edges ?? []).find((e) => e.from === "src/main.ts" && e.to === "src/util.ts");
      expect(edge, "alias edge via node_modules base must exist").toBeDefined();
      expect(edge!.basis).toBe("alias");

      // Two-run byte-identical (the lazy base read is deduped + path-keyed → deterministic).
      expect(serializeRepoMap(scanRepo(root))).toBe(serializeRepoMap(scanRepo(root)));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
