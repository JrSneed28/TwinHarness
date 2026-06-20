/**
 * R-18 — repo-map symbol-extractor heuristic coverage (lane03 F1/F2/F3 + F4).
 *
 * The TS/JS exported-symbol extractor is a deliberately small heuristic that favours
 * FALSE-NEGATIVES over FALSE-POSITIVES (SCOPE & HONESTY in extract.ts). These tests
 * pin the ADDITIVE constructs P6a added — `export namespace`, anonymous
 * `export default`, and `export *` barrels — and the latent backslash-normalization
 * guard in `resolveRelativeTsJs`. They are characterization tests: every assertion
 * is a construct that previously produced NO symbol/edge and now produces one,
 * WITHOUT regressing the named declarations the extractor already handled.
 *
 * Anchors: REQ-RU heuristic public-api surface (RULE-008 coarse-kind), REQ-NFR-001
 * (deterministic), REQ-NFR-003 (no out-of-repo resolution).
 */

import { describe, it, expect } from "vitest";
import { extractSymbols, resolveRelativeTsJs } from "../src/core/repo-map/extract";
import type { ExportedSymbol } from "../src/core/repo-map/schema";

const CAP = 100;
const names = (syms: ExportedSymbol[]): string[] => syms.map((s) => s.name);

describe("R-18 — extractSymbols: additive namespace / anonymous-default / export-* coverage", () => {
  it("extracts an `export namespace Foo` (kind coarse-bucketed to other)", () => {
    const syms = extractSymbols("ts", "export namespace Foo {\n  export const x = 1;\n}\n", CAP);
    expect(names(syms)).toContain("Foo");
    const ns = syms.find((s) => s.name === "Foo")!;
    expect(ns.kind).toBe("other");
  });

  it("extracts an ambient `export declare namespace Bar`", () => {
    const syms = extractSymbols("ts", "export declare namespace Bar {}\n", CAP);
    expect(names(syms)).toContain("Bar");
  });

  it("records a `default` symbol for an ANONYMOUS `export default function () {}`", () => {
    const syms = extractSymbols("ts", "export default function () {\n  return 1;\n}\n", CAP);
    expect(names(syms)).toContain("default");
  });

  it("records `default` for `export default class {}` and `export default <expr>`", () => {
    expect(names(extractSymbols("ts", "export default class {}\n", CAP))).toContain("default");
    expect(names(extractSymbols("ts", "export default { a: 1, b: 2 };\n", CAP))).toContain("default");
    expect(names(extractSymbols("ts", "export default makeThing();\n", CAP))).toContain("default");
  });

  it("a NAMED default is captured by its real name and is NOT double-counted as `default`", () => {
    // `export default function foo` already matched the named-declaration pass; the
    // anonymous-default pass must NOT also emit a phantom `default` (no false positive).
    const syms = extractSymbols("ts", "export default function foo() {}\n", CAP);
    expect(names(syms)).toContain("foo");
    expect(names(syms)).not.toContain("default");
  });

  it("extracts an `export * from \"./mod\"` barrel as `*`", () => {
    const syms = extractSymbols("ts", "export * from './mod';\n", CAP);
    expect(names(syms)).toContain("*");
  });

  it("extracts a named-namespace re-export `export * as ns from \"./mod\"`", () => {
    const syms = extractSymbols("ts", "export * as ns from './mod';\n", CAP);
    expect(names(syms)).toContain("ns");
    expect(names(syms)).not.toContain("*"); // the `as ns` form names the namespace
  });

  it("REGRESSION: the original named declarations are still extracted unchanged", () => {
    const src = [
      "export function fn() {}",
      "export class Cls {}",
      "export interface Iface {}",
      "export type Alias = number;",
      "export enum E { A }",
      "export const c = 1;",
      "export { reexported };",
    ].join("\n");
    const syms = extractSymbols("ts", src, CAP);
    const got = names(syms);
    for (const n of ["fn", "Cls", "Iface", "Alias", "E", "c", "reexported"]) {
      expect(got).toContain(n);
    }
  });

  it("is deterministic — same input yields byte-identical symbol order", () => {
    const src = "export namespace N {}\nexport default function () {}\nexport * from './m';\n";
    expect(JSON.stringify(extractSymbols("ts", src, CAP))).toBe(JSON.stringify(extractSymbols("ts", src, CAP)));
  });
});

describe("R-18 — resolveRelativeTsJs: backslash normalization (latent-defense)", () => {
  const fileSet = new Set(["src/core/a.ts", "src/core/b.ts"]);

  it("resolves a POSIX relative specifier (the contract the scanner feeds today)", () => {
    expect(resolveRelativeTsJs("src/core/a.ts", "./b", fileSet)).toBe("src/core/b.ts");
  });

  it("resolves a BACKSLASH-separated relative specifier identically (no non-normalizing miss)", () => {
    // path.posix does not treat `\` as a separator, so before the normalization a
    // `.\\b` specifier would mis-join and resolve to null. The one-liner guard maps
    // it to the same POSIX result as `./b`.
    expect(resolveRelativeTsJs("src/core/a.ts", ".\\b", fileSet)).toBe("src/core/b.ts");
  });

  it("still refuses a backslash specifier that escapes the importing tree (never guesses)", () => {
    expect(resolveRelativeTsJs("src/core/a.ts", "..\\..\\..\\etc\\passwd", fileSet)).toBeNull();
  });
});
