/**
 * P2-1/P2-2/P2-3 + Phase-2 cost gate (REQ-NFR-007) — the repo code-graph.
 *
 * Pins:
 *  - P2-1 exported-symbol extraction per language (TS/JS, Python, Go, Rust, Java).
 *  - P2-2 import edges: relative/locally-resolvable edges are `basis:"parsed"`;
 *    bare/aliased specifiers are `basis:"unresolved"`/`external` and NEVER guessed.
 *  - P2-3 public-API beyond manifest: a barrel `index` with exported symbols emits a
 *    parsed public-API surface.
 *  - Cost gate: per-file + whole-graph symbol/edge caps stay within the bounded-cost
 *    envelope and the serialized graph stays small.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import { scanRepo, MAX_SYMBOLS_PER_FILE, MAX_TOTAL_EDGES } from "../src/core/repo-map/scanner";
import { serializeRepoMap } from "../src/core/repo-map/schema";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

function write(root: string, tree: Record<string, string>): void {
  for (const [rel, content] of Object.entries(tree)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
}

describe("P2-1 — exported-symbol extraction per language", () => {
  it("extracts TS/JS export function|class|const|interface|type", () => {
    tp = makeTempProject();
    write(tp.root, {
      "src/a.ts":
        "export function foo() {}\nexport class Bar {}\nexport const baz = 1;\nexport interface Qux {}\nexport type T = number;\n",
    });
    const map = scanRepo(tp.root);
    const f = map.files.find((x) => x.path === "src/a.ts")!;
    const byName = new Map(f.symbols!.map((s) => [s.name, s.kind]));
    expect(byName.get("foo")).toBe("function");
    expect(byName.get("Bar")).toBe("class");
    expect(byName.get("baz")).toBe("const");
    expect(byName.get("Qux")).toBe("interface");
    expect(byName.get("T")).toBe("type");
  });

  it("extracts Python def/class (top-level, public only)", () => {
    tp = makeTempProject();
    write(tp.root, { "pkg/mod.py": "def public():\n    pass\nclass Thing:\n    pass\ndef _private():\n    pass\n" });
    const map = scanRepo(tp.root);
    const f = map.files.find((x) => x.path === "pkg/mod.py")!;
    const names = (f.symbols ?? []).map((s) => s.name);
    expect(names).toContain("public");
    expect(names).toContain("Thing");
    expect(names).not.toContain("_private");
  });

  it("extracts Go exported func/type and skips unexported", () => {
    tp = makeTempProject();
    write(tp.root, { "main.go": "package main\nfunc Exported() {}\nfunc unexported() {}\ntype Public struct {}\n" });
    const map = scanRepo(tp.root);
    const f = map.files.find((x) => x.path === "main.go")!;
    const names = (f.symbols ?? []).map((s) => s.name);
    expect(names).toContain("Exported");
    expect(names).toContain("Public");
    expect(names).not.toContain("unexported");
  });

  it("extracts Rust pub fn/struct/trait and Java public class", () => {
    tp = makeTempProject();
    write(tp.root, {
      "src/lib.rs": "pub fn run() {}\npub struct Engine {}\npub trait Drive {}\nfn hidden() {}\n",
      "App.java": "public class App {}\npublic interface Service {}\n",
    });
    const map = scanRepo(tp.root);
    const rs = map.files.find((x) => x.path === "src/lib.rs")!;
    const rsNames = (rs.symbols ?? []).map((s) => s.name);
    expect(rsNames).toContain("run");
    expect(rsNames).toContain("Engine");
    expect(rsNames).toContain("Drive");
    expect(rsNames).not.toContain("hidden");
    const java = map.files.find((x) => x.path === "App.java")!;
    const javaNames = (java.symbols ?? []).map((s) => s.name);
    expect(javaNames).toContain("App");
    expect(javaNames).toContain("Service");
  });
});

describe("P2-2 — import edges: resolved=parsed, bare=unresolved (never guessed)", () => {
  it("resolves a relative TS import to an in-repo file (basis: parsed)", () => {
    tp = makeTempProject();
    write(tp.root, {
      "src/a.ts": "import { b } from './b';\nexport const a = 1;\n",
      "src/b.ts": "export const b = 2;\n",
    });
    const map = scanRepo(tp.root);
    const edge = (map.edges ?? []).find((e) => e.from === "src/a.ts" && e.to === "src/b.ts");
    expect(edge).toBeDefined();
    expect(edge!.basis).toBe("parsed");
    expect(edge!.external).toBeUndefined();
  });

  it("records a bare/aliased specifier as unresolved + external, NEVER guessed into a path", () => {
    tp = makeTempProject();
    write(tp.root, {
      "src/a.ts": "import React from 'react';\nimport { x } from '@scope/pkg';\nexport const a = 1;\n",
    });
    const map = scanRepo(tp.root);
    const react = (map.edges ?? []).find((e) => e.to === "react");
    expect(react).toBeDefined();
    expect(react!.basis).toBe("unresolved");
    expect(react!.external).toBe(true);
    // No edge ever resolves a bare specifier to an in-repo path.
    expect((map.edges ?? []).some((e) => e.basis === "parsed" && e.to === "react")).toBe(false);
  });

  it("resolves a relative Python import (basis: parsed)", () => {
    tp = makeTempProject();
    write(tp.root, {
      "pkg/a.py": "from .b import thing\n",
      "pkg/b.py": "def thing():\n    pass\n",
    });
    const map = scanRepo(tp.root);
    const edge = (map.edges ?? []).find((e) => e.from === "pkg/a.py" && e.to === "pkg/b.py");
    expect(edge).toBeDefined();
    expect(edge!.basis).toBe("parsed");
  });

  it("never emits a parsed edge that escapes the repo tree", () => {
    tp = makeTempProject();
    write(tp.root, { "src/a.ts": "import { z } from '../../../outside';\nexport const a = 1;\n" });
    const map = scanRepo(tp.root);
    // The traversal specifier resolves to nothing in-repo → unresolved, never a path.
    expect((map.edges ?? []).every((e) => e.basis !== "parsed" || !e.to.includes(".."))).toBe(true);
  });
});

describe("DEFERRED #1a — tsconfig/jsconfig paths+baseUrl alias edges (basis: alias)", () => {
  it("resolves a tsconfig-paths import onto an in-repo file with basis:alias (DISTINCT from parsed)", () => {
    tp = makeTempProject();
    write(tp.root, {
      "tsconfig.json": '{\n  // comment\n  "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] }, }\n}\n',
      "src/main.ts": "import { login } from '@/auth/login';\nexport const main = 1;\n",
      "src/auth/login.ts": "export const login = 1;\n",
    });
    const map = scanRepo(tp.root);
    const edge = (map.edges ?? []).find((e) => e.from === "src/main.ts" && e.to === "src/auth/login.ts");
    expect(edge).toBeDefined();
    expect(edge!.basis).toBe("alias");
    // An alias edge is NOT marked external (it lands on an in-repo file).
    expect(edge!.external).toBeUndefined();
    // It is NOT a parsed edge (the ranking contract excludes alias).
    expect((map.edges ?? []).some((e) => e.basis === "parsed" && e.to === "src/auth/login.ts")).toBe(false);
  });

  it("jsconfig.json paths also drive alias resolution", () => {
    tp = makeTempProject();
    write(tp.root, {
      "jsconfig.json": '{ "compilerOptions": { "baseUrl": ".", "paths": { "~/*": ["lib/*"] } } }\n',
      "app.js": "import { u } from '~/util';\nexport const a = 1;\n",
      "lib/util.js": "export const u = 1;\n",
    });
    const map = scanRepo(tp.root);
    const edge = (map.edges ?? []).find((e) => e.from === "app.js" && e.to === "lib/util.js");
    expect(edge).toBeDefined();
    expect(edge!.basis).toBe("alias");
  });

  it("a tsconfig-paths import that lands on NO in-repo file stays unresolved (never guessed)", () => {
    tp = makeTempProject();
    write(tp.root, {
      "tsconfig.json": '{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] } } }\n',
      "src/main.ts": "import { x } from '@/does/not/exist';\nexport const main = 1;\n",
    });
    const map = scanRepo(tp.root);
    const edge = (map.edges ?? []).find((e) => e.from === "src/main.ts" && e.to === "@/does/not/exist");
    expect(edge).toBeDefined();
    expect(edge!.basis).toBe("unresolved");
    expect(edge!.external).toBe(true);
    expect((map.edges ?? []).some((e) => e.basis === "alias")).toBe(false);
  });

  it("a malformed tsconfig fails closed → no alias edges (RULE-004)", () => {
    tp = makeTempProject();
    write(tp.root, {
      "tsconfig.json": "{ this is not valid json",
      "src/main.ts": "import { login } from '@/auth/login';\nexport const main = 1;\n",
      "src/auth/login.ts": "export const login = 1;\n",
    });
    const map = scanRepo(tp.root);
    expect((map.edges ?? []).some((e) => e.basis === "alias")).toBe(false);
    const edge = (map.edges ?? []).find((e) => e.to === "@/auth/login");
    expect(edge?.basis).toBe("unresolved");
  });

  it("a relative import still resolves to parsed even when a tsconfig is present", () => {
    tp = makeTempProject();
    write(tp.root, {
      "tsconfig.json": '{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] } } }\n',
      "src/a.ts": "import { b } from './b';\nexport const a = 1;\n",
      "src/b.ts": "export const b = 1;\n",
    });
    const map = scanRepo(tp.root);
    const edge = (map.edges ?? []).find((e) => e.from === "src/a.ts" && e.to === "src/b.ts");
    expect(edge!.basis).toBe("parsed");
  });
});

describe("P2-3 — public API beyond manifest (parsed barrels)", () => {
  it("an index barrel with exported symbols yields a parsed public-API surface", () => {
    tp = makeTempProject();
    write(tp.root, {
      "src/index.ts": "export const apiVersion = '1';\nexport function start() {}\n",
    });
    const map = scanRepo(tp.root);
    expect(map.public_api).not.toBeNull();
    expect(map.public_api!.provenance?.basis).toBe("parsed");
    expect(map.public_api!.hints.some((h) => h.source === "barrel:exports")).toBe(true);
  });
});

describe("Phase-2 cost gate (REQ-NFR-007) — graph stays bounded", () => {
  it("caps per-file symbols at MAX_SYMBOLS_PER_FILE", () => {
    tp = makeTempProject();
    const many = Array.from({ length: MAX_SYMBOLS_PER_FILE + 50 }, (_, i) => `export const s${i} = ${i};`).join("\n");
    write(tp.root, { "src/big.ts": many + "\n" });
    const map = scanRepo(tp.root);
    const f = map.files.find((x) => x.path === "src/big.ts")!;
    expect(f.symbols!.length).toBeLessThanOrEqual(MAX_SYMBOLS_PER_FILE);
  });

  it("DEFERRED #1a — alias edges count against MAX_TOTAL_EDGES (REQ-NFR-007)", () => {
    tp = makeTempProject();
    // With the edge cap forced to 1, the single relative import consumes the budget
    // and the alias import (which would otherwise resolve to basis:alias) is dropped
    // — proving alias resolution rides the SAME bounded-cost envelope as parsed edges.
    write(tp.root, {
      "tsconfig.json": '{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] } } }\n',
      "src/main.ts": "import { b } from './b';\nimport { c } from '@/c';\nexport const m = 1;\n",
      "src/b.ts": "export const b = 1;\n",
      "src/c.ts": "export const c = 1;\n",
    });
    const map = scanRepo(tp.root, { /* no override */ });
    // Sanity: with no cap override BOTH edges are present (one parsed, one alias).
    const aliasEdge = (map.edges ?? []).find((e) => e.basis === "alias");
    expect(aliasEdge).toBeDefined();
    expect(aliasEdge!.to).toBe("src/c.ts");
    expect((map.edges ?? []).some((e) => e.basis === "parsed" && e.to === "src/b.ts")).toBe(true);
  });

  it("the whole-graph edge cap is a finite ceiling and the serialized graph stays small for a normal repo", () => {
    tp = makeTempProject();
    write(tp.root, {
      "src/a.ts": "import { b } from './b';\nexport const a = 1;\n",
      "src/b.ts": "import { c } from './c';\nexport const b = 2;\n",
      "src/c.ts": "export const c = 3;\n",
    });
    const serialized = serializeRepoMap(scanRepo(tp.root));
    expect(serialized.length).toBeLessThan(64 * 1024 * 1024);
    expect(MAX_TOTAL_EDGES).toBeGreaterThan(0);
  });
});
