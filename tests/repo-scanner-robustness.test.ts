/**
 * Phase 3 — scanner robustness for unconventional repos.
 *
 *  P3-1 depth-aware package-root detection (src/lib/tests/docs relative to EACH
 *       package root, not only depth===0).
 *  P3-2 componentForFile derived from package roots (nested packages get components).
 *  P3-3 workspace detection (pnpm-workspace.yaml) + extra manifest tables
 *       (pubspec/Podfile/CMakeLists/Justfile/Taskfile).
 *  P3-4 EXT_LANG extension (C/C++/ObjC/Swift/Dart/Scala/Shell/SQL).
 *  P3-5 configurable exclusions + per-path reason; context-aware vendor/bin/obj.
 *  P3-6 low-confidence-structure warning.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import { scanRepo } from "../src/core/repo-map/scanner";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

function write(root: string, tree: Record<string, string>): void {
  for (const [rel, content] of Object.entries(tree)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
}

describe("P3-1/P3-2 — nested package roots produce components + roots", () => {
  it("detects src/tests under a NESTED package root (monorepo) and derives components", () => {
    tp = makeTempProject();
    write(tp.root, {
      "package.json": JSON.stringify({ name: "root", workspaces: ["packages/*"] }),
      "packages/app/package.json": JSON.stringify({ name: "app" }),
      "packages/app/src/auth/login.ts": "export const login = 1;\n",
      "packages/app/tests/login.test.ts": "// REQ-NEST-001\n",
    });
    const map = scanRepo(tp.root);
    // Nested source/test roots are detected relative to the package root.
    expect(map.source_roots).toContain("packages/app/src");
    expect(map.test_roots).toContain("packages/app/tests");
    // The component is derived from the nested package root, not the top level.
    expect(map.components.some((c) => c.name === "packages/app/src/auth")).toBe(true);
    const f = map.files.find((x) => x.path === "packages/app/src/auth/login.ts");
    expect(f?.component).toBe("packages/app/src/auth");
  });

  it("a src dir NOT under any package root is not promoted to a source root", () => {
    tp = makeTempProject();
    write(tp.root, {
      "package.json": JSON.stringify({ name: "root" }),
      // A `src` nested under a plain (manifest-less) dir is still a candidate, but its
      // parent is not a package root, so it is not promoted.
      "misc/scratch/src/x.ts": "export const x = 1;\n",
    });
    const map = scanRepo(tp.root);
    expect(map.source_roots).not.toContain("misc/scratch/src");
  });
});

describe("P3-3 — workspace + extra manifest detection", () => {
  it("pnpm-workspace.yaml marks a package root so child roots resolve", () => {
    tp = makeTempProject();
    write(tp.root, {
      "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n",
      "apps/web/package.json": JSON.stringify({ name: "web" }),
      "apps/web/src/index.ts": "export const x = 1;\n",
    });
    const map = scanRepo(tp.root);
    expect(map.source_roots).toContain("apps/web/src");
  });

  it("detects pubspec.yaml, CMakeLists.txt, Justfile as package managers / tooling", () => {
    tp = makeTempProject();
    write(tp.root, {
      "pubspec.yaml": "name: app\n",
      "CMakeLists.txt": "project(x)\n",
      "Justfile": "build:\n\techo hi\n",
    });
    const map = scanRepo(tp.root);
    const pmNames = map.package_managers.map((p) => p.name);
    expect(pmNames).toContain("pub");
    expect(pmNames).toContain("cmake");
    expect(pmNames).toContain("just");
  });
});

describe("P3-4 — EXT_LANG covers C/C++/ObjC/Swift/Dart/Scala/Shell/SQL", () => {
  it("reports the new languages by extension", () => {
    tp = makeTempProject();
    write(tp.root, {
      "a.c": "int main(){return 0;}\n",
      "b.cpp": "int x;\n",
      "c.swift": "let x = 1\n",
      "d.dart": "void main(){}\n",
      "e.scala": "object X\n",
      "f.sh": "echo hi\n",
      "g.sql": "select 1;\n",
      "h.m": "@implementation X @end\n",
    });
    const map = scanRepo(tp.root);
    const langs = new Set(map.languages.map((l) => l.name));
    for (const lang of ["C", "C++", "Swift", "Dart", "Scala", "Shell", "SQL", "Objective-C"]) {
      expect(langs.has(lang), `expected language ${lang}`).toBe(true);
    }
  });
});

describe("P3-5 — context-aware pruning + configurable exclusions with reasons", () => {
  it("prunes vendor/ at a module root (sibling manifest) with reason, but walks a plain bin/", () => {
    tp = makeTempProject();
    write(tp.root, {
      "go.mod": "module x\n",
      "vendor/dep/lib.go": "package dep\n", // vendor beside go.mod → dependency output
      "scripts/bin/deploy.sh": "echo deploy\n", // plain bin under scripts, no manifest → walked
    });
    const map = scanRepo(tp.root);
    const exclusions = map.scanReport.exclusions ?? [];
    expect(exclusions.some((e) => e.path === "vendor" && e.reason === "vendor-at-module-root")).toBe(true);
    // The vendored file is NOT scanned; the plain bin script IS.
    expect(map.files.some((f) => f.path.startsWith("vendor/"))).toBe(false);
    expect(map.files.some((f) => f.path === "scripts/bin/deploy.sh")).toBe(true);
  });

  it("honors a configured exclude path and records the reason", () => {
    tp = makeTempProject();
    write(tp.root, {
      "src/keep.ts": "export const k = 1;\n",
      "generated-stuff/x.ts": "export const x = 1;\n",
    });
    const map = scanRepo(tp.root, { excludePaths: ["generated-stuff"] });
    expect(map.files.some((f) => f.path.startsWith("generated-stuff/"))).toBe(false);
    expect((map.scanReport.exclusions ?? []).some((e) => e.reason === "configured")).toBe(true);
    expect(map.files.some((f) => f.path === "src/keep.ts")).toBe(true);
  });
});

describe("P3-6 — low-confidence-structure warning", () => {
  it("flags lowConfidenceStructure when files exist but no source roots/components were derived", () => {
    tp = makeTempProject();
    // Several files, NONE under a conventional source root and no components.
    write(tp.root, {
      "alpha.txt": "a\n",
      "beta.txt": "b\n",
      "gamma.md": "g\n",
      "delta.json": "{}\n",
      "epsilon.cfg": "x\n",
      "zeta.ini": "y\n",
    });
    const map = scanRepo(tp.root);
    expect(map.scanReport.lowConfidenceStructure).toBe(true);
  });

  it("does NOT flag a normal repo with a src root", () => {
    tp = makeTempProject();
    write(tp.root, { "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 2;\n" });
    const map = scanRepo(tp.root);
    expect(map.scanReport.lowConfidenceStructure).toBeUndefined();
  });
});
