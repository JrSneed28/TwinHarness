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

/* ------------------------------------------------------------------ *
 * JSONC reader (DEFERRED #1a) — PURE, deterministic, fail-closed.     *
 * ------------------------------------------------------------------ */

/**
 * Parse a JSON-with-comments string (tsconfig/jsconfig style) into a plain object.
 *
 * NET-NEW, PURE, DETERMINISTIC (RULE-004): this is a minimal text transform —
 * strip `//` line comments and `/* *\/` block comments and trailing commas, then
 * `JSON.parse`. The content is NEVER `require()`'d or executed (a tsconfig may be
 * arbitrary untrusted repo data). On ANY parse failure (or a non-object / array
 * top level) it returns `undefined` — the caller then yields NO aliases and falls
 * back to `unresolved` (fail-closed). String/regex scanning only; no FS, no eval.
 *
 * Comment stripping is string-literal aware so a `//`, `/*`, or comma INSIDE a JSON
 * string is preserved verbatim. The transform is a pure function of its input, so a
 * given config always produces the same object (determinism — REQ-NFR-001).
 */
export function parseJsonc(text: string): Record<string, unknown> | undefined {
  let out = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const next = i + 1 < text.length ? text[i + 1]! : "";
    if (inLineComment) {
      if (c === "\n") {
        inLineComment = false;
        out += c;
      }
      continue;
    }
    if (inBlockComment) {
      if (c === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\") {
        // Preserve the escaped char verbatim (e.g. \" \\ \/).
        if (next) {
          out += next;
          i++;
        }
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    // Not in a string or comment.
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    out += c;
  }
  // Strip trailing commas (e.g. `[1,2,]` / `{"a":1,}`) — comment-free now, and the
  // regex only matches OUTSIDE strings because we operate on the stripped text and
  // a `,]`/`,}` sequence cannot legally appear inside a JSON string after a value.
  // To stay string-safe we re-scan: only collapse a comma followed by optional
  // whitespace then a closing bracket/brace when NOT inside a string.
  out = stripTrailingCommas(out);
  try {
    const v: unknown = JSON.parse(out);
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** String-aware trailing-comma stripper (a `,` before `]`/`}`, ignoring whitespace). */
function stripTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === "\\") {
        if (i + 1 < text.length) {
          out += text[i + 1]!;
          i++;
        }
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === ",") {
      // Look ahead past whitespace for a closing bracket/brace.
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (j < text.length && (text[j] === "]" || text[j] === "}")) {
        // Drop this comma (do not append it); whitespace is re-emitted by the loop.
        continue;
      }
    }
    out += c;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * tsconfig/jsconfig `paths` + `baseUrl` alias resolution (#1a).       *
 * ------------------------------------------------------------------ */

/**
 * A compiled alias table for ONE tsconfig/jsconfig, derived purely from its parsed
 * `compilerOptions.baseUrl` + `compilerOptions.paths`. `configDir` is the POSIX-
 * relative directory of the config file ("" = repo root). `baseDir` is `configDir`
 * joined with `baseUrl` (POSIX-normalized) — the root against which `paths` targets
 * (and bare `baseUrl`-relative specifiers) are resolved.
 */
export interface AliasTable {
  configDir: string;
  baseDir: string;
  hasBaseUrl: boolean;
  /** Pattern → list of target templates (verbatim from `paths`). */
  patterns: { pattern: string; targets: string[] }[];
}

/**
 * Build an `AliasTable` from a parsed tsconfig/jsconfig object. Returns `undefined`
 * when there is no usable `baseUrl`/`paths` (so the caller records nothing). PURE.
 *
 * Note: `paths` REQUIRES a `baseUrl` in classic resolution, but modern TS resolves
 * `paths` relative to the config file when `baseUrl` is absent. We mirror the modern
 * behaviour: `baseDir = configDir + (baseUrl ?? ".")`.
 */
export function buildAliasTable(
  configDir: string,
  parsed: Record<string, unknown>,
): AliasTable | undefined {
  const co = parsed.compilerOptions;
  const opts = typeof co === "object" && co !== null && !Array.isArray(co)
    ? (co as Record<string, unknown>)
    : {};
  const baseUrlRaw = typeof opts.baseUrl === "string" ? opts.baseUrl : undefined;
  const pathsRaw = typeof opts.paths === "object" && opts.paths !== null && !Array.isArray(opts.paths)
    ? (opts.paths as Record<string, unknown>)
    : undefined;
  if (baseUrlRaw === undefined && pathsRaw === undefined) return undefined;

  const joinPosix = (dir: string, rel: string): string => {
    const j = path.posix.normalize(path.posix.join(dir === "" ? "." : dir, rel));
    return j === "." ? "" : j;
  };
  const baseDir = joinPosix(configDir, baseUrlRaw ?? ".");

  const patterns: { pattern: string; targets: string[] }[] = [];
  if (pathsRaw) {
    for (const [pattern, targetsRaw] of Object.entries(pathsRaw)) {
      if (typeof pattern !== "string") continue;
      if (!Array.isArray(targetsRaw)) continue;
      const targets = targetsRaw.filter((t): t is string => typeof t === "string");
      if (targets.length > 0) patterns.push({ pattern, targets });
    }
  }
  return { configDir, baseDir, hasBaseUrl: baseUrlRaw !== undefined, patterns };
}

/** Bound on `extends` chain depth — defends against a pathological/cyclic chain. */
const MAX_EXTENDS_DEPTH = 16;

/**
 * Read a config referenced by `extends` and return its POSIX-relative path, or null
 * when the reference cannot be resolved to an in-repo-relative location WITHOUT
 * guessing. Two forms are supported (TS semantics), both FAIL-SAFE on any miss:
 *   1. A relative path (`./base`, `../tsconfig.base.json`) — resolved against the
 *      EXTENDING config's directory; a `.json` suffix is implied when absent.
 *   2. A BOUNDED single node_modules package hop (`@scope/pkg/tsconfig`, `pkg/base`)
 *      — mapped to `node_modules/<spec>(.json)` at the repo root. Exactly ONE hop,
 *      NO recursive node_modules walk, NO package.json "tsconfig" field lookup.
 * A candidate that escapes the repo (`..` prefix after normalization) is rejected so
 * the chain can never reach outside the scanned tree. Returns the POSIX path of the
 * base config text key to look up via `readFile` (the caller owns the read).
 */
function resolveExtendsTarget(fromConfigDir: string, ref: string): string | null {
  if (typeof ref !== "string" || ref.length === 0) return null;
  const withJson = (p: string): string => (p.endsWith(".json") ? p : `${p}.json`);
  const normPosix = (p: string): string | null => {
    const j = path.posix.normalize(p);
    if (j.startsWith("..") || j === ".." || path.posix.isAbsolute(j)) return null;
    return j;
  };
  if (ref.startsWith("./") || ref.startsWith("../") || ref === "." || ref === "..") {
    // Relative to the extending config's directory.
    const joined = path.posix.join(fromConfigDir === "" ? "." : fromConfigDir, withJson(ref));
    return normPosix(joined);
  }
  if (ref.startsWith("/") || /^[A-Za-z]:[\\/]/.test(ref)) return null; // absolute — never guess
  // Bare specifier → a SINGLE node_modules package hop at the repo root. No walk.
  return normPosix(`node_modules/${withJson(ref)}`);
}

/**
 * DEFERRED #1a (AC#3) — resolve a tsconfig/jsconfig's `extends` chain into a single
 * `AliasTable`, applying real TS inheritance, so aliases declared in a base config and
 * inherited via `extends` resolve to `basis:"alias"` (not `unresolved`):
 *   - `baseUrl` is child-wins (the NEAREST config in the chain that sets it).
 *   - `paths` REPLACES wholesale — a child's `paths` shadows the base's entirely
 *     (NO deep-merge); the effective `paths` resolve against the effective baseDir.
 *   - the effective resolution `baseDir` is computed from whichever config DECLARED
 *     `baseUrl` (classic TS) or, with no baseUrl, the config that declared `paths`
 *     (modern TS) — correct even when the two come from DIFFERENT configs.
 *   - the returned table's `configDir` is the ENTRY config's own dir (its GOVERNANCE
 *     scope), so a child config that inherits a ROOT base does NOT govern the whole
 *     repo — it only governs files under the child.
 *   - bases are read lazily via `readFile` (a POSIX-path-keyed reader the scanner
 *     supplies); a relative base OR a bounded single node_modules hop is followed.
 * FAIL-SAFE: any miss (unreadable base, parse failure, cycle, depth overflow, escape)
 * simply stops following that link — the result reflects only what was resolvable, and
 * a config that yields no usable baseUrl/paths produces `undefined` (the caller then
 * records `unresolved`, NEVER a guess). PURE given `readFile`: deduped + cycle-bounded
 * + depth-bounded, so it is independent of FS iteration order (ADR-003 determinism).
 * `readFile` reads are NOT surface-guarded (reading a base config under node_modules
 * is a legitimate READ; only WRITES are surface-governed).
 *
 * `configPath` is the POSIX-relative path of the ENTRY config (e.g. `tsconfig.json`
 * or `packages/app/tsconfig.json`). `parsed` is its already-parsed object (so the
 * caller does not re-read/parse the entry). `readFile(posixPath)` returns the raw
 * text of a base config or `undefined` when it cannot be read.
 */
export function resolveExtendsChain(
  configPath: string,
  parsed: Record<string, unknown>,
  readFile: (posixPath: string) => string | undefined,
): AliasTable | undefined {
  const optsOf = (obj: Record<string, unknown>): Record<string, unknown> => {
    const co = obj.compilerOptions;
    return typeof co === "object" && co !== null && !Array.isArray(co)
      ? (co as Record<string, unknown>)
      : {};
  };
  const dirOf = (p: string): string => {
    const d = path.posix.dirname(p);
    return d === "." ? "" : d;
  };

  const joinPosix = (dir: string, rel: string): string => {
    const j = path.posix.normalize(path.posix.join(dir === "" ? "." : dir, rel));
    return j === "." ? "" : j;
  };

  // Effective accumulators. Each field takes its NEAREST (child-wins) declaration:
  // we walk child→base and only fill an as-yet-unset value. `paths` REPLACE wholesale
  // (no deep-merge). We track the DECLARING dir of `baseUrl` and of `paths` SEPARATELY
  // so the final baseDir is correct even when they come from different configs.
  let effBaseUrlVal: string | undefined;
  let effBaseUrlDir = "";
  let effPaths: Record<string, unknown> | undefined;
  let effPathsDir = "";

  const seen = new Set<string>();
  // Walk child → base, taking the NEAREST declaration of each field (child-wins).
  const visit = (cfgPath: string, cfgParsed: Record<string, unknown>, depth: number): void => {
    if (depth > MAX_EXTENDS_DEPTH) return; // depth bound — fail-safe stop
    if (seen.has(cfgPath)) return; // cycle / dedupe bound — fail-safe stop
    seen.add(cfgPath);
    const cfgDir = dirOf(cfgPath);
    const opts = optsOf(cfgParsed);
    if (effBaseUrlVal === undefined && typeof opts.baseUrl === "string") {
      effBaseUrlVal = opts.baseUrl;
      effBaseUrlDir = cfgDir;
    }
    if (
      effPaths === undefined &&
      typeof opts.paths === "object" && opts.paths !== null && !Array.isArray(opts.paths)
    ) {
      // `paths` REPLACE — the nearest config that declares them wins wholesale.
      effPaths = opts.paths as Record<string, unknown>;
      effPathsDir = cfgDir;
    }
    // Follow `extends` (string or array form — TS 5.0 allows an array; we visit in
    // order and child-first semantics still hold via the `=== undefined` guards).
    const ext = cfgParsed.extends;
    const refs = typeof ext === "string" ? [ext] : Array.isArray(ext) ? ext : [];
    for (const ref of refs) {
      if (typeof ref !== "string") continue;
      const basePath = resolveExtendsTarget(cfgDir, ref);
      if (basePath === null) continue; // unresolvable ref — fail-safe skip
      if (seen.has(basePath)) continue;
      const text = readFile(basePath); // legitimate READ (not write-guarded)
      if (text === undefined) continue; // unreadable base — fail-safe skip
      const baseParsed = parseJsonc(text);
      if (!baseParsed) continue; // parse failure — fail-safe skip
      visit(basePath, baseParsed, depth + 1);
    }
  };
  visit(configPath, parsed, 0);

  if (effBaseUrlVal === undefined && effPaths === undefined) return undefined;

  // Compute the resolution baseDir. With a baseUrl: it resolves relative to the config
  // that DECLARED it (classic TS). Without one (modern TS): `paths` resolve relative to
  // the config that declared the `paths`. `configDir` (the ENTRY config's own dir) is
  // the GOVERNANCE scope — independent of baseDir — so a child inheriting a ROOT base
  // governs only files under the child, while still resolving targets against the base.
  const configDir = dirOf(configPath);
  const baseDir = effBaseUrlVal !== undefined
    ? joinPosix(effBaseUrlDir, effBaseUrlVal)
    : effPathsDir;

  // Compile the effective `paths` exactly as `buildAliasTable` does (verbatim targets,
  // string-only, non-empty) so the produced table is interchangeable with a non-extends
  // table in `resolveAliasTsJs` (same shape, same tie-break).
  const patterns: { pattern: string; targets: string[] }[] = [];
  if (effPaths) {
    for (const [pattern, targetsRaw] of Object.entries(effPaths)) {
      if (typeof pattern !== "string") continue;
      if (!Array.isArray(targetsRaw)) continue;
      const targets = targetsRaw.filter((t): t is string => typeof t === "string");
      if (targets.length > 0) patterns.push({ pattern, targets });
    }
  }
  return { configDir, baseDir, hasBaseUrl: effBaseUrlVal !== undefined, patterns };
}

/**
 * Resolve a NON-relative TS/JS specifier through tsconfig/jsconfig alias tables.
 * Returns the in-repo POSIX path IFF a candidate lands on a file in `fileSet`;
 * otherwise null (the caller then records `unresolved` — NEVER guesses).
 *
 * Deterministic tie-break (REQ-NFR-001):
 *   1. Consider ALL tables whose `configDir` is an ancestor of (or equal to) the
 *      importing file's directory (a config governs files under it). Tables are
 *      examined in a fixed order: the candidate with the LONGEST non-wildcard
 *      pattern prefix wins; ties broken by POSIX-sorted resolved path.
 *   2. For each matching pattern, each target template is expanded and probed
 *      against `fileSet` using `TS_RESOLVE_EXTS` (same order as relative resolution).
 *   3. A `baseUrl`-relative bare specifier (no matching pattern) is tried last.
 * Any candidate that escapes the repo (normalizes to a `..` prefix) is rejected.
 *
 * `fromRel` is the importing file's POSIX path; `tables` is the full set; ALL
 * resolution is over the in-memory SORTED `fileSet` — never readdir order.
 */
export function resolveAliasTsJs(
  fromRel: string,
  specifier: string,
  tables: AliasTable[],
  fileSet: Set<string>,
): string | null {
  if (specifier.startsWith(".")) return null; // relative handled elsewhere
  const fromDir = path.posix.dirname(fromRel);
  const governs = (configDir: string): boolean =>
    configDir === "" || fromDir === configDir || fromDir.startsWith(configDir + "/");

  // Collect ranked candidates: { prefixLen, resolvedPath }.
  const candidates: { prefixLen: number; resolved: string }[] = [];
  const probe = (baseDir: string, relTarget: string): string | null => {
    const joined = path.posix.normalize(
      path.posix.join(baseDir === "" ? "." : baseDir, relTarget),
    );
    const norm = joined === "." ? "" : joined;
    if (norm.startsWith("..")) return null; // escapes the repo — never guess
    if (fileSet.has(norm)) return norm;
    for (const suf of TS_RESOLVE_EXTS) {
      const cand = norm + suf;
      if (fileSet.has(cand)) return cand;
    }
    return null;
  };

  for (const table of tables) {
    if (!governs(table.configDir)) continue;
    for (const { pattern, targets } of table.patterns) {
      const starIdx = pattern.indexOf("*");
      if (starIdx === -1) {
        // Exact (non-wildcard) pattern — must match the specifier verbatim.
        if (pattern !== specifier) continue;
        for (const t of targets) {
          const r = probe(table.baseDir, t);
          if (r) candidates.push({ prefixLen: pattern.length, resolved: r });
        }
      } else {
        const prefix = pattern.slice(0, starIdx);
        const suffix = pattern.slice(starIdx + 1);
        if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
        if (specifier.length < prefix.length + suffix.length) continue;
        const captured = specifier.slice(prefix.length, specifier.length - suffix.length);
        for (const t of targets) {
          const target = t.includes("*") ? t.replace("*", captured) : t;
          const r = probe(table.baseDir, target);
          // Non-wildcard prefix length is the tie-break key (longer = more specific).
          if (r) candidates.push({ prefixLen: prefix.length, resolved: r });
        }
      }
    }
    // baseUrl-relative bare specifier (only when the table declares a baseUrl).
    if (table.hasBaseUrl) {
      const r = probe(table.baseDir, specifier);
      if (r) candidates.push({ prefixLen: 0, resolved: r });
    }
  }

  if (candidates.length === 0) return null;
  // Longest non-wildcard prefix wins; ties → POSIX-sorted resolved path first.
  candidates.sort((a, b) =>
    b.prefixLen - a.prefixLen ||
    (a.resolved < b.resolved ? -1 : a.resolved > b.resolved ? 1 : 0),
  );
  return candidates[0]!.resolved;
}

/* ------------------------------------------------------------------ *
 * Workspace bare-package alias resolution (DEFERRED #1b) — PURE.      *
 * ------------------------------------------------------------------ */

/**
 * A discovered in-repo package: its POSIX-relative root dir and its declared `name`
 * (from the manifest), plus the manifest's `main`/`module` entry hints (used to land
 * a bare `import "pkg"` on the package entry file).
 */
export interface PackageInfo {
  /** POSIX-relative dir of the package's manifest ("" = repo root). */
  root: string;
  /** Declared package name (manifest `name`). */
  name: string;
  /** Manifest `main` (POSIX-relative to root), if a string. */
  main?: string;
  /** Manifest `module` (POSIX-relative to root), if a string. */
  module?: string;
}

/**
 * Expand a workspace glob pattern (e.g. "packages/*", "apps/**", "libs/foo") against
 * a set of candidate package-root dirs. PURE + deterministic — operates over the
 * provided dir set, never readdir order. A trailing `/*` matches one path segment; a
 * trailing `/**` matches one-or-more; an exact pattern matches that dir verbatim.
 * Returns the subset of `roots` that the pattern selects.
 */
export function matchWorkspacePattern(pattern: string, roots: Iterable<string>): string[] {
  const norm = pattern.replace(/\/+$/, ""); // trim trailing slash
  const out: string[] = [];
  for (const r of roots) {
    if (norm.endsWith("/**")) {
      const base = norm.slice(0, -3);
      if (r === base || r.startsWith(base + "/")) out.push(r);
    } else if (norm.endsWith("/*")) {
      const base = norm.slice(0, -2);
      // Exactly one segment under base.
      if (r.startsWith(base + "/")) {
        const rest = r.slice(base.length + 1);
        if (!rest.includes("/")) out.push(r);
      }
    } else if (norm === "*") {
      if (!r.includes("/") && r !== "") out.push(r);
    } else {
      if (r === norm) out.push(r);
    }
  }
  return out;
}

/**
 * Build a deterministic package-name → `PackageInfo` map from discovered manifests.
 *
 * DETERMINISM + tie-break (REQ-NFR-001): manifests are considered in POSIX-sorted
 * root order; the FIRST occurrence of a duplicate name wins (later duplicates are
 * ignored). `workspacePatterns` (when non-empty) restricts membership: only the
 * repo-root package and packages under a matching workspace pattern are included.
 * When NO workspace patterns are declared, ALL discovered named packages are mapped
 * (a plain multi-package repo without a formal workspace declaration).
 */
export function buildPackageNameMap(
  manifests: PackageInfo[],
  workspacePatterns: string[],
): Map<string, PackageInfo> {
  const sorted = [...manifests].sort((a, b) => (a.root < b.root ? -1 : a.root > b.root ? 1 : 0));
  const allRoots = sorted.map((m) => m.root);
  let eligible: Set<string>;
  if (workspacePatterns.length > 0) {
    eligible = new Set<string>([""]); // repo root always eligible
    for (const pat of workspacePatterns) {
      for (const r of matchWorkspacePattern(pat, allRoots)) eligible.add(r);
    }
  } else {
    eligible = new Set<string>(allRoots);
  }
  const map = new Map<string, PackageInfo>();
  for (const m of sorted) {
    if (!eligible.has(m.root)) continue;
    if (!m.name) continue;
    if (!map.has(m.name)) map.set(m.name, m); // first-wins (sorted root order)
  }
  return map;
}

/**
 * Resolve a BARE TS/JS specifier through the workspace package-name map. Returns an
 * in-repo POSIX path IFF the specifier's package head matches a known package AND a
 * candidate lands on a real file in `fileSet`; otherwise null (→ unresolved, never
 * guessed).
 *
 * Deterministic tie-break (REQ-NFR-001): when the specifier head matches multiple
 * package names (e.g. "@scope/a" vs "@scope/a/sub" both being package names), the
 * LONGEST package name wins, then POSIX-sorted first. The subpath after the package
 * name is resolved within the package root (with `TS_RESOLVE_EXTS`); a bare package
 * import (no subpath) resolves to the manifest `main`/`module` entry or an index.
 */
export function resolveWorkspaceBare(
  specifier: string,
  pkgMap: Map<string, PackageInfo>,
  fileSet: Set<string>,
): string | null {
  if (specifier.startsWith(".")) return null; // relative handled elsewhere

  // Find all package names that are a "head" of the specifier (name === spec, or
  // spec starts with name + "/").
  const matches: PackageInfo[] = [];
  for (const [name, info] of pkgMap.entries()) {
    if (specifier === name || specifier.startsWith(name + "/")) matches.push(info);
  }
  if (matches.length === 0) return null;
  // Longest package name wins; ties → POSIX-sorted root first.
  matches.sort((a, b) =>
    b.name.length - a.name.length ||
    (a.root < b.root ? -1 : a.root > b.root ? 1 : 0),
  );

  const joinPosix = (dir: string, rel: string): string => {
    const j = path.posix.normalize(path.posix.join(dir === "" ? "." : dir, rel));
    return j === "." ? "" : j;
  };
  const probe = (cand: string): string | null => {
    if (cand.startsWith("..")) return null;
    if (fileSet.has(cand)) return cand;
    for (const suf of TS_RESOLVE_EXTS) {
      if (fileSet.has(cand + suf)) return cand + suf;
    }
    return null;
  };

  for (const info of matches) {
    const subpath = specifier === info.name ? "" : specifier.slice(info.name.length + 1);
    if (subpath) {
      const r = probe(joinPosix(info.root, subpath));
      if (r) return r;
    } else {
      // Bare package import → manifest entry (main/module), then index fallback.
      for (const entry of [info.main, info.module]) {
        if (typeof entry === "string" && entry.length > 0) {
          const r = probe(joinPosix(info.root, entry));
          if (r) return r;
        }
      }
      const idx = probe(info.root === "" ? "index" : info.root);
      if (idx) return idx;
    }
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
