/**
 * DEFERRED #1a — the NET-NEW pure JSONC reader (`parseJsonc`) and tsconfig/jsconfig
 * `paths`+`baseUrl` alias resolution (`buildAliasTable` + `resolveAliasTsJs`).
 *
 * RULE-004 (trust boundary): `parseJsonc` is a PURE text transform → `JSON.parse`.
 * It NEVER `require()`s or executes the content, and FAILS CLOSED (returns
 * `undefined`) on any malformed input → the scanner then records `unresolved`,
 * never a guessed path.
 *
 * REQ-NFR-001 (determinism): the same config text always yields the same object;
 * alias resolution operates over an in-memory SORTED fileSet with a deterministic
 * longest-non-wildcard-prefix then POSIX-sorted tie-break.
 */

import { describe, it, expect } from "vitest";
import {
  parseJsonc,
  buildAliasTable,
  resolveAliasTsJs,
  matchWorkspacePattern,
  buildPackageNameMap,
  resolveWorkspaceBare,
  type AliasTable,
  type PackageInfo,
} from "../src/core/repo-map/extract";

describe("DEFERRED #1a — parseJsonc (RULE-004: pure, fail-closed JSONC reader)", () => {
  it("strips // line comments and /* block */ comments before JSON.parse", () => {
    const text = `{
      // line comment
      "compilerOptions": {
        /* block
           comment */
        "baseUrl": "."
      }
    }`;
    const obj = parseJsonc(text);
    expect(obj).toBeDefined();
    expect((obj!.compilerOptions as Record<string, unknown>).baseUrl).toBe(".");
  });

  it("strips trailing commas in objects and arrays", () => {
    const obj = parseJsonc(`{ "a": [1, 2, 3,], "b": { "c": 1, }, }`);
    expect(obj).toEqual({ a: [1, 2, 3], b: { c: 1 } });
  });

  it("preserves // and , and /* INSIDE string literals (string-aware)", () => {
    const obj = parseJsonc(`{ "url": "http://x/y", "csv": "a,b,", "glob": "/*keep*/" }`);
    expect(obj).toEqual({ url: "http://x/y", csv: "a,b,", glob: "/*keep*/" });
  });

  it("FAILS CLOSED on malformed JSON → returns undefined (no aliases, no guess)", () => {
    expect(parseJsonc("{ not json")).toBeUndefined();
    expect(parseJsonc("")).toBeUndefined();
    expect(parseJsonc("not even close")).toBeUndefined();
  });

  it("returns undefined for a non-object top level (array / scalar)", () => {
    expect(parseJsonc("[1,2,3]")).toBeUndefined();
    expect(parseJsonc("42")).toBeUndefined();
    expect(parseJsonc('"a string"')).toBeUndefined();
  });

  it("REQ-NFR-001 — deterministic: identical text yields a deep-equal object every call", () => {
    const text = `{ /* c */ "compilerOptions": { "paths": { "@/*": ["src/*"], } } }`;
    const a = parseJsonc(text);
    const b = parseJsonc(text);
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("DEFERRED #1a — buildAliasTable", () => {
  it("returns undefined when no baseUrl and no paths are present", () => {
    expect(buildAliasTable("", { compilerOptions: {} })).toBeUndefined();
    expect(buildAliasTable("", {})).toBeUndefined();
  });

  it("derives baseDir from configDir + baseUrl and keeps paths verbatim", () => {
    const t = buildAliasTable("packages/app", {
      compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } },
    });
    expect(t).toBeDefined();
    expect(t!.baseDir).toBe("packages/app");
    expect(t!.hasBaseUrl).toBe(true);
    expect(t!.patterns).toEqual([{ pattern: "@/*", targets: ["src/*"] }]);
  });

  it("resolves paths relative to the config file when baseUrl is absent (modern TS)", () => {
    const t = buildAliasTable("sub", { compilerOptions: { paths: { "@/*": ["lib/*"] } } });
    expect(t).toBeDefined();
    expect(t!.baseDir).toBe("sub");
    expect(t!.hasBaseUrl).toBe(false);
  });
});

describe("DEFERRED #1a — resolveAliasTsJs (in-memory, deterministic, never guesses)", () => {
  const fileSet = new Set([
    "src/auth/login.ts",
    "src/auth/index.ts",
    "src/util/x.ts",
    "packages/app/src/a.ts",
  ]);
  const table: AliasTable = {
    configDir: "",
    baseDir: "",
    hasBaseUrl: true,
    patterns: [{ pattern: "@/*", targets: ["src/*"] }],
  };

  it("resolves an aliased wildcard specifier onto an in-repo file → basis alias", () => {
    const r = resolveAliasTsJs("src/main.ts", "@/auth/login", [table], fileSet);
    expect(r).toBe("src/auth/login.ts");
  });

  it("resolves to an index file via TS_RESOLVE_EXTS order", () => {
    const r = resolveAliasTsJs("src/main.ts", "@/auth", [table], fileSet);
    expect(r).toBe("src/auth/index.ts");
  });

  it("returns null (→ unresolved) when the alias lands on no in-repo file", () => {
    expect(resolveAliasTsJs("src/main.ts", "@/does/not/exist", [table], fileSet)).toBeNull();
  });

  it("returns null for a relative specifier (handled by the relative resolver)", () => {
    expect(resolveAliasTsJs("src/main.ts", "./x", [table], fileSet)).toBeNull();
  });

  it("rejects a `..`-escape candidate (never resolves outside the repo)", () => {
    const escaping: AliasTable = {
      configDir: "",
      baseDir: "",
      hasBaseUrl: true,
      patterns: [{ pattern: "@/*", targets: ["../*"] }],
    };
    expect(resolveAliasTsJs("src/main.ts", "@/secret", [escaping], fileSet)).toBeNull();
  });

  it("deterministic tie-break: LONGEST non-wildcard prefix wins", () => {
    const fs2 = new Set(["src/specific/x.ts", "src/generic/specific/x.ts"]);
    const t2: AliasTable = {
      configDir: "",
      baseDir: "",
      hasBaseUrl: false,
      patterns: [
        { pattern: "@/*", targets: ["src/generic/*"] }, // prefix "@/"
        { pattern: "@/specific/*", targets: ["src/specific/*"] }, // prefix "@/specific/"
      ],
    };
    // The longer prefix ("@/specific/") must win over the shorter ("@/").
    const r = resolveAliasTsJs("src/main.ts", "@/specific/x", [t2], fs2);
    expect(r).toBe("src/specific/x.ts");
  });

  it("resolves a bare baseUrl-relative specifier when the table declares a baseUrl", () => {
    // baseUrl points at src/, so a bare "util/x" resolves to src/util/x.ts.
    const srcBase: AliasTable = {
      configDir: "",
      baseDir: "src",
      hasBaseUrl: true,
      patterns: [],
    };
    const r = resolveAliasTsJs("src/main.ts", "util/x", [srcBase], fileSet);
    expect(r).toBe("src/util/x.ts");
  });

  it("a config only governs files under its directory", () => {
    const scoped: AliasTable = {
      configDir: "packages/app",
      baseDir: "packages/app",
      hasBaseUrl: true,
      patterns: [{ pattern: "@/*", targets: ["src/*"] }],
    };
    // A file OUTSIDE packages/app is not governed by that config.
    expect(resolveAliasTsJs("src/main.ts", "@/a", [scoped], fileSet)).toBeNull();
    // A file INSIDE packages/app is governed.
    expect(resolveAliasTsJs("packages/app/src/main.ts", "@/a", [scoped], fileSet)).toBe(
      "packages/app/src/a.ts",
    );
  });
});

describe("DEFERRED #1b — matchWorkspacePattern (pure glob over an in-memory dir set)", () => {
  const roots = ["packages/a", "packages/b", "packages/nested/c", "apps/web", "libs/x"];
  it("expands a trailing /* to exactly one segment", () => {
    expect(matchWorkspacePattern("packages/*", roots).sort()).toEqual(["packages/a", "packages/b"]);
  });
  it("expands a trailing /** to one-or-more segments", () => {
    expect(matchWorkspacePattern("packages/**", roots).sort()).toEqual([
      "packages/a",
      "packages/b",
      "packages/nested/c",
    ]);
  });
  it("matches an exact dir verbatim", () => {
    expect(matchWorkspacePattern("apps/web", roots)).toEqual(["apps/web"]);
  });
});

describe("DEFERRED #1b — buildPackageNameMap (deterministic, first-wins)", () => {
  it("first-wins on duplicate names over POSIX-sorted roots", () => {
    const manifests: PackageInfo[] = [
      { root: "packages/z", name: "dup" },
      { root: "packages/a", name: "dup" },
    ];
    const m = buildPackageNameMap(manifests, []);
    // POSIX-sorted: packages/a before packages/z → packages/a wins.
    expect(m.get("dup")!.root).toBe("packages/a");
  });

  it("restricts membership to matched workspace patterns (+ repo root)", () => {
    const manifests: PackageInfo[] = [
      { root: "", name: "root-pkg" },
      { root: "packages/a", name: "a" },
      { root: "vendored/b", name: "b" }, // NOT under a workspace pattern
    ];
    const m = buildPackageNameMap(manifests, ["packages/*"]);
    expect(m.has("root-pkg")).toBe(true);
    expect(m.has("a")).toBe(true);
    expect(m.has("b")).toBe(false);
  });

  it("maps all named packages when no workspace patterns are declared", () => {
    const manifests: PackageInfo[] = [
      { root: "x", name: "x" },
      { root: "y", name: "y" },
    ];
    const m = buildPackageNameMap(manifests, []);
    expect([...m.keys()].sort()).toEqual(["x", "y"]);
  });
});

describe("DEFERRED #1b — resolveWorkspaceBare (in-memory, never guesses)", () => {
  const fileSet = new Set([
    "packages/a/src/index.ts",
    "packages/a/src/sub.ts",
    "packages/a/dist/index.js",
    "packages/scoped/index.ts",
    "packages/scoped-extra/index.ts",
  ]);

  it("resolves a bare package import to its manifest main entry", () => {
    const m = new Map<string, PackageInfo>([
      ["@scope/a", { root: "packages/a", name: "@scope/a", main: "src/index.ts" }],
    ]);
    expect(resolveWorkspaceBare("@scope/a", m, fileSet)).toBe("packages/a/src/index.ts");
  });

  it("resolves a subpath import within the package root", () => {
    const m = new Map<string, PackageInfo>([
      ["@scope/a", { root: "packages/a", name: "@scope/a" }],
    ]);
    expect(resolveWorkspaceBare("@scope/a/src/sub", m, fileSet)).toBe("packages/a/src/sub.ts");
  });

  it("returns null (→ unresolved) when the head matches no package name", () => {
    const m = new Map<string, PackageInfo>([
      ["@scope/a", { root: "packages/a", name: "@scope/a" }],
    ]);
    expect(resolveWorkspaceBare("react", m, fileSet)).toBeNull();
  });

  it("returns null when a matched package's candidate lands on no in-repo file", () => {
    const m = new Map<string, PackageInfo>([
      ["@scope/a", { root: "packages/a", name: "@scope/a", main: "missing.ts" }],
    ]);
    expect(resolveWorkspaceBare("@scope/a/nope", m, fileSet)).toBeNull();
  });

  it("deterministic tie-break: LONGEST matching package name wins", () => {
    // Both "p" and "p-extra" could be heads of "p-extra/index" but only the longer
    // is the correct package; "p" must not greedily win.
    const fs2 = new Set(["pkgs/short/index.ts", "pkgs/long/index.ts"]);
    const m = new Map<string, PackageInfo>([
      ["p", { root: "pkgs/short", name: "p", main: "index.ts" }],
      ["p-extra", { root: "pkgs/long", name: "p-extra", main: "index.ts" }],
    ]);
    expect(resolveWorkspaceBare("p-extra", m, fs2)).toBe("pkgs/long/index.ts");
  });
});
