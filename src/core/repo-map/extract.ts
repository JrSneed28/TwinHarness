/**
 * `repo-map/extract.ts` — PURE, lightweight per-language text parsers for exported
 * symbols (P2-1) and import specifiers (P2-2). NEVER executes content (RULE-004):
 * every function here is regex/string scanning over an already-read buffer.
 *
 * SCOPE & HONESTY (rev 2 S1). These are deliberately small heuristic parsers, not
 * compilers. They favour FALSE-NEGATIVES (miss an odd construct) over FALSE-
 * POSITIVES (invent a symbol/edge). Import specifiers that are NOT relative are
 * returned as `unresolved` and never guessed into an in-repo path — full module
 * resolution (tsconfig paths, bare-package mapping) is Phase 2B.
 */

import * as path from "node:path";
import type { ExportedSymbol, SymbolKind } from "./schema";

/** Binary sniff: a NUL byte in the first chunk ⇒ treat as binary (skip extraction). */
export function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/**
 * Text-extension allowlist for symbol/import extraction. A file outside this set is
 * never parsed for symbols/edges (it may still be language-detected by EXT_LANG and
 * hashed). Keyed by lowercased extension WITHOUT the dot.
 */
const PARSE_EXTS = new Set([
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs",
  "py", "go", "rs", "java",
]);

export function isParseableExt(ext: string): boolean {
  return PARSE_EXTS.has(ext.replace(/^\./, "").toLowerCase());
}

/** De-dup + cap symbols deterministically-agnostic (the serializer sorts). */
function dedupSymbols(symbols: ExportedSymbol[], cap: number): ExportedSymbol[] {
  const seen = new Set<string>();
  const out: ExportedSymbol[] = [];
  for (const s of symbols) {
    const key = `${s.name}\0${s.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= cap) break;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Exported-symbol extraction (P2-1) — per language.                   *
 * ------------------------------------------------------------------ */

function tsKind(token: string): SymbolKind {
  switch (token) {
    case "function": return "function";
    case "class": return "class";
    case "interface": return "interface";
    case "type": return "type";
    case "enum": return "enum";
    case "const":
    case "let":
    case "var": return "const";
    default: return "other";
  }
}

/** TS/JS: `export function|class|const|interface|type|enum NAME`, plus `export default`. */
function extractTsJsSymbols(content: string): ExportedSymbol[] {
  const out: ExportedSymbol[] = [];
  const re =
    /^[ \t]*export\s+(?:default\s+)?(?:async\s+)?(function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    out.push({ name: m[2]!, kind: tsKind(m[1]!) });
  }
  // `export { a, b as c }` re-export lists (names only; kind unknown → other).
  const listRe = /^[ \t]*export\s*\{([^}]*)\}/gm;
  while ((m = listRe.exec(content)) !== null) {
    for (const part of m[1]!.split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) out.push({ name, kind: "other" });
    }
  }
  return out;
}

/** Python: top-level `def NAME` / `class NAME` (a public symbol unless _underscored). */
function extractPythonSymbols(content: string): ExportedSymbol[] {
  const out: ExportedSymbol[] = [];
  const re = /^(def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/gm; // column 0 ⇒ module-level
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const name = m[2]!;
    if (name.startsWith("_")) continue; // private by convention
    out.push({ name, kind: m[1] === "class" ? "class" : "function" });
  }
  return out;
}

/** Go: exported (Capitalized) `func NAME` / `type NAME`. */
function extractGoSymbols(content: string): ExportedSymbol[] {
  const out: ExportedSymbol[] = [];
  const re = /^(?:func(?:\s*\([^)]*\))?|type)\s+([A-Z][A-Za-z0-9_]*)/gm;
  const kindRe = /^(func|type)\b/;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const head = m[0]!.match(kindRe)?.[1];
    out.push({ name: m[1]!, kind: head === "type" ? "type" : "function" });
  }
  return out;
}

/** Rust: `pub fn|struct|enum|trait|type|const NAME`. */
function extractRustSymbols(content: string): ExportedSymbol[] {
  const out: ExportedSymbol[] = [];
  const re =
    /^[ \t]*pub(?:\([^)]*\))?\s+(?:async\s+)?(fn|struct|enum|trait|type|const|static)\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
  const kindMap: Record<string, SymbolKind> = {
    fn: "function", struct: "class", enum: "enum", trait: "trait",
    type: "type", const: "const", static: "const",
  };
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    out.push({ name: m[2]!, kind: kindMap[m[1]!] ?? "other" });
  }
  return out;
}

/** Java: `public class|interface|enum NAME` (top-level public types). */
function extractJavaSymbols(content: string): ExportedSymbol[] {
  const out: ExportedSymbol[] = [];
  const re =
    /\bpublic\s+(?:final\s+|abstract\s+|sealed\s+)?(class|interface|enum|record)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
  const kindMap: Record<string, SymbolKind> = {
    class: "class", interface: "interface", enum: "enum", record: "class",
  };
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    out.push({ name: m[2]!, kind: kindMap[m[1]!] ?? "other" });
  }
  return out;
}

/**
 * Exported-symbol extraction dispatched by extension. `cap` bounds the per-file
 * symbol count (REQ-NFR-007). Returns [] for an unparseable extension.
 */
export function extractSymbols(ext: string, content: string, cap: number): ExportedSymbol[] {
  const e = ext.replace(/^\./, "").toLowerCase();
  let raw: ExportedSymbol[];
  switch (e) {
    case "ts": case "tsx": case "mts": case "cts":
    case "js": case "jsx": case "mjs": case "cjs":
      raw = extractTsJsSymbols(content); break;
    case "py": raw = extractPythonSymbols(content); break;
    case "go": raw = extractGoSymbols(content); break;
    case "rs": raw = extractRustSymbols(content); break;
    case "java": raw = extractJavaSymbols(content); break;
    default: return [];
  }
  return dedupSymbols(raw, cap);
}

/* ------------------------------------------------------------------ *
 * Import-specifier extraction (P2-2).                                 *
 * ------------------------------------------------------------------ */

/** A raw import specifier as it appears in source (before resolution). */
export interface RawImport {
  /** The specifier string, e.g. "./foo", "react", "../bar/baz". */
  specifier: string;
}

/** TS/JS imports: `import ... from "x"`, `require("x")`, `import("x")`, `export ... from "x"`. */
function extractTsJsImports(content: string): RawImport[] {
  const out: RawImport[] = [];
  const push = (s: string | undefined): void => {
    if (s) out.push({ specifier: s });
  };
  let m: RegExpExecArray | null;
  const fromRe = /(?:import|export)\b[^;'"]*?from\s*['"]([^'"]+)['"]/g;
  while ((m = fromRe.exec(content)) !== null) push(m[1]);
  const bareImportRe = /import\s*['"]([^'"]+)['"]/g; // `import "side-effect"`
  while ((m = bareImportRe.exec(content)) !== null) push(m[1]);
  const reqRe = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = reqRe.exec(content)) !== null) push(m[1]);
  const dynRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = dynRe.exec(content)) !== null) push(m[1]);
  return out;
}

/** Python imports: `from .x import y`, `import a.b`. Returns the module path token. */
function extractPythonImports(content: string): RawImport[] {
  const out: RawImport[] = [];
  let m: RegExpExecArray | null;
  const fromRe = /^[ \t]*from\s+(\.+[A-Za-z0-9_.]*|[A-Za-z0-9_.]+)\s+import\b/gm;
  while ((m = fromRe.exec(content)) !== null) out.push({ specifier: m[1]! });
  const impRe = /^[ \t]*import\s+([A-Za-z0-9_.]+)/gm;
  while ((m = impRe.exec(content)) !== null) out.push({ specifier: m[1]! });
  return out;
}

/** Go imports: lines/blocks of quoted import paths. */
function extractGoImports(content: string): RawImport[] {
  const out: RawImport[] = [];
  let m: RegExpExecArray | null;
  const re = /^\s*(?:[A-Za-z0-9_.]+\s+)?"([^"]+)"/gm;
  // Restrict to within an import ( ... ) block OR single `import "x"` lines.
  const blockRe = /\bimport\s*\(([\s\S]*?)\)/g;
  let b: RegExpExecArray | null;
  while ((b = blockRe.exec(content)) !== null) {
    const body = b[1]!;
    let mm: RegExpExecArray | null;
    const inner = /"([^"]+)"/g;
    while ((mm = inner.exec(body)) !== null) out.push({ specifier: mm[1]! });
  }
  const singleRe = /^\s*import\s+(?:[A-Za-z0-9_.]+\s+)?"([^"]+)"/gm;
  while ((m = singleRe.exec(content)) !== null) out.push({ specifier: m[1]! });
  void re;
  return out;
}

/** Rust: `use crate::a::b;` / `mod x;` — only `mod` is locally resolvable cheaply. */
function extractRustImports(content: string): RawImport[] {
  const out: RawImport[] = [];
  let m: RegExpExecArray | null;
  const modRe = /^[ \t]*(?:pub\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/gm;
  while ((m = modRe.exec(content)) !== null) out.push({ specifier: m[1]! });
  const useRe = /^[ \t]*use\s+([A-Za-z_:][A-Za-z0-9_:]*)/gm;
  while ((m = useRe.exec(content)) !== null) out.push({ specifier: m[1]! });
  return out;
}

/** Java: `import a.b.C;` — package-qualified (not locally resolvable cheaply). */
function extractJavaImports(content: string): RawImport[] {
  const out: RawImport[] = [];
  let m: RegExpExecArray | null;
  const re = /^[ \t]*import\s+(?:static\s+)?([A-Za-z0-9_.*]+)\s*;/gm;
  while ((m = re.exec(content)) !== null) out.push({ specifier: m[1]! });
  return out;
}

export function extractImports(ext: string, content: string): RawImport[] {
  const e = ext.replace(/^\./, "").toLowerCase();
  switch (e) {
    case "ts": case "tsx": case "mts": case "cts":
    case "js": case "jsx": case "mjs": case "cjs":
      return extractTsJsImports(content);
    case "py": return extractPythonImports(content);
    case "go": return extractGoImports(content);
    case "rs": return extractRustImports(content);
    case "java": return extractJavaImports(content);
    default: return [];
  }
}

/* ------------------------------------------------------------------ *
 * Relative-specifier resolution (P2-2) — locally-resolvable ONLY.     *
 * ------------------------------------------------------------------ */

/** Candidate resolution suffixes for an extension-less JS/TS relative import. */
const TS_RESOLVE_EXTS = [
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs",
  "/index.ts", "/index.tsx", "/index.js", "/index.jsx",
];

/**
 * Resolve a relative TS/JS specifier against the importing file's POSIX-relative
 * path, returning the in-repo POSIX path if (and only if) it lands on a file that
 * EXISTS in the scanned file set. `fileSet` is the set of all POSIX-relative file
 * paths the scanner saw, so resolution is purely in-memory (no FS access here).
 * Returns null when not relative or when no candidate exists in the set.
 */
export function resolveRelativeTsJs(
  fromRel: string,
  specifier: string,
  fileSet: Set<string>,
): string | null {
  if (!specifier.startsWith(".")) return null; // bare/aliased → unresolved (Phase 2B)
  const dir = path.posix.dirname(fromRel);
  const base = path.posix.normalize(path.posix.join(dir, specifier));
  if (base.startsWith("..")) return null; // escapes the importing tree — never guess
  if (fileSet.has(base)) return base; // explicit extension already present
  for (const suf of TS_RESOLVE_EXTS) {
    const cand = base + suf;
    if (fileSet.has(cand)) return cand;
  }
  return null;
}

/**
 * Resolve a Python relative import (leading dots) against the importing file's
 * package directory. Only DOTTED (relative) specifiers are resolvable; absolute
 * module paths are left unresolved (Phase 2B). Returns an in-repo POSIX `.py` path
 * when it exists in `fileSet`, else null.
 */
export function resolveRelativePython(
  fromRel: string,
  specifier: string,
  fileSet: Set<string>,
): string | null {
  if (!specifier.startsWith(".")) return null;
  const dots = /^\.+/.exec(specifier)![0].length;
  const rest = specifier.slice(dots).replace(/\./g, "/");
  // One leading dot = current package; each extra dot climbs a level.
  let dir = path.posix.dirname(fromRel);
  for (let i = 1; i < dots; i++) dir = path.posix.dirname(dir);
  const base = rest ? path.posix.normalize(path.posix.join(dir, rest)) : dir;
  if (base.startsWith("..")) return null;
  for (const cand of [`${base}.py`, `${base}/__init__.py`]) {
    if (fileSet.has(cand)) return cand;
  }
  return null;
}
