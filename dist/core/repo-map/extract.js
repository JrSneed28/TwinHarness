"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.looksBinary = looksBinary;
exports.isParseableExt = isParseableExt;
exports.extractSymbols = extractSymbols;
exports.extractImports = extractImports;
exports.resolveRelativeTsJs = resolveRelativeTsJs;
exports.parseJsonc = parseJsonc;
exports.buildAliasTable = buildAliasTable;
exports.resolveAliasTsJs = resolveAliasTsJs;
exports.matchWorkspacePattern = matchWorkspacePattern;
exports.buildPackageNameMap = buildPackageNameMap;
exports.resolveWorkspaceBare = resolveWorkspaceBare;
exports.resolveRelativePython = resolveRelativePython;
const path = __importStar(require("node:path"));
/** Binary sniff: a NUL byte in the first chunk ⇒ treat as binary (skip extraction). */
function looksBinary(buf) {
    const n = Math.min(buf.length, 8192);
    for (let i = 0; i < n; i++) {
        if (buf[i] === 0)
            return true;
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
function isParseableExt(ext) {
    return PARSE_EXTS.has(ext.replace(/^\./, "").toLowerCase());
}
/** De-dup + cap symbols deterministically-agnostic (the serializer sorts). */
function dedupSymbols(symbols, cap) {
    const seen = new Set();
    const out = [];
    for (const s of symbols) {
        const key = `${s.name}\0${s.kind}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push(s);
        if (out.length >= cap)
            break;
    }
    return out;
}
/* ------------------------------------------------------------------ *
 * Exported-symbol extraction (P2-1) — per language.                   *
 * ------------------------------------------------------------------ */
function tsKind(token) {
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
function extractTsJsSymbols(content) {
    const out = [];
    const re = /^[ \t]*export\s+(?:default\s+)?(?:async\s+)?(function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;
    let m;
    while ((m = re.exec(content)) !== null) {
        out.push({ name: m[2], kind: tsKind(m[1]) });
    }
    // `export { a, b as c }` re-export lists (names only; kind unknown → other).
    const listRe = /^[ \t]*export\s*\{([^}]*)\}/gm;
    while ((m = listRe.exec(content)) !== null) {
        for (const part of m[1].split(",")) {
            const name = part.trim().split(/\s+as\s+/).pop()?.trim();
            if (name && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name))
                out.push({ name, kind: "other" });
        }
    }
    return out;
}
/** Python: top-level `def NAME` / `class NAME` (a public symbol unless _underscored). */
function extractPythonSymbols(content) {
    const out = [];
    const re = /^(def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/gm; // column 0 ⇒ module-level
    let m;
    while ((m = re.exec(content)) !== null) {
        const name = m[2];
        if (name.startsWith("_"))
            continue; // private by convention
        out.push({ name, kind: m[1] === "class" ? "class" : "function" });
    }
    return out;
}
/** Go: exported (Capitalized) `func NAME` / `type NAME`. */
function extractGoSymbols(content) {
    const out = [];
    const re = /^(?:func(?:\s*\([^)]*\))?|type)\s+([A-Z][A-Za-z0-9_]*)/gm;
    const kindRe = /^(func|type)\b/;
    let m;
    while ((m = re.exec(content)) !== null) {
        const head = m[0].match(kindRe)?.[1];
        out.push({ name: m[1], kind: head === "type" ? "type" : "function" });
    }
    return out;
}
/** Rust: `pub fn|struct|enum|trait|type|const NAME`. */
function extractRustSymbols(content) {
    const out = [];
    const re = /^[ \t]*pub(?:\([^)]*\))?\s+(?:async\s+)?(fn|struct|enum|trait|type|const|static)\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
    const kindMap = {
        fn: "function", struct: "class", enum: "enum", trait: "trait",
        type: "type", const: "const", static: "const",
    };
    let m;
    while ((m = re.exec(content)) !== null) {
        out.push({ name: m[2], kind: kindMap[m[1]] ?? "other" });
    }
    return out;
}
/** Java: `public class|interface|enum NAME` (top-level public types). */
function extractJavaSymbols(content) {
    const out = [];
    const re = /\bpublic\s+(?:final\s+|abstract\s+|sealed\s+)?(class|interface|enum|record)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
    const kindMap = {
        class: "class", interface: "interface", enum: "enum", record: "class",
    };
    let m;
    while ((m = re.exec(content)) !== null) {
        out.push({ name: m[2], kind: kindMap[m[1]] ?? "other" });
    }
    return out;
}
/**
 * Exported-symbol extraction dispatched by extension. `cap` bounds the per-file
 * symbol count (REQ-NFR-007). Returns [] for an unparseable extension.
 */
function extractSymbols(ext, content, cap) {
    const e = ext.replace(/^\./, "").toLowerCase();
    let raw;
    switch (e) {
        case "ts":
        case "tsx":
        case "mts":
        case "cts":
        case "js":
        case "jsx":
        case "mjs":
        case "cjs":
            raw = extractTsJsSymbols(content);
            break;
        case "py":
            raw = extractPythonSymbols(content);
            break;
        case "go":
            raw = extractGoSymbols(content);
            break;
        case "rs":
            raw = extractRustSymbols(content);
            break;
        case "java":
            raw = extractJavaSymbols(content);
            break;
        default: return [];
    }
    return dedupSymbols(raw, cap);
}
/** TS/JS imports: `import ... from "x"`, `require("x")`, `import("x")`, `export ... from "x"`. */
function extractTsJsImports(content) {
    const out = [];
    const push = (s) => {
        if (s)
            out.push({ specifier: s });
    };
    let m;
    const fromRe = /(?:import|export)\b[^;'"]*?from\s*['"]([^'"]+)['"]/g;
    while ((m = fromRe.exec(content)) !== null)
        push(m[1]);
    const bareImportRe = /import\s*['"]([^'"]+)['"]/g; // `import "side-effect"`
    while ((m = bareImportRe.exec(content)) !== null)
        push(m[1]);
    const reqRe = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((m = reqRe.exec(content)) !== null)
        push(m[1]);
    const dynRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((m = dynRe.exec(content)) !== null)
        push(m[1]);
    return out;
}
/** Python imports: `from .x import y`, `import a.b`. Returns the module path token. */
function extractPythonImports(content) {
    const out = [];
    let m;
    const fromRe = /^[ \t]*from\s+(\.+[A-Za-z0-9_.]*|[A-Za-z0-9_.]+)\s+import\b/gm;
    while ((m = fromRe.exec(content)) !== null)
        out.push({ specifier: m[1] });
    const impRe = /^[ \t]*import\s+([A-Za-z0-9_.]+)/gm;
    while ((m = impRe.exec(content)) !== null)
        out.push({ specifier: m[1] });
    return out;
}
/** Go imports: lines/blocks of quoted import paths. */
function extractGoImports(content) {
    const out = [];
    let m;
    const re = /^\s*(?:[A-Za-z0-9_.]+\s+)?"([^"]+)"/gm;
    // Restrict to within an import ( ... ) block OR single `import "x"` lines.
    const blockRe = /\bimport\s*\(([\s\S]*?)\)/g;
    let b;
    while ((b = blockRe.exec(content)) !== null) {
        const body = b[1];
        let mm;
        const inner = /"([^"]+)"/g;
        while ((mm = inner.exec(body)) !== null)
            out.push({ specifier: mm[1] });
    }
    const singleRe = /^\s*import\s+(?:[A-Za-z0-9_.]+\s+)?"([^"]+)"/gm;
    while ((m = singleRe.exec(content)) !== null)
        out.push({ specifier: m[1] });
    void re;
    return out;
}
/** Rust: `use crate::a::b;` / `mod x;` — only `mod` is locally resolvable cheaply. */
function extractRustImports(content) {
    const out = [];
    let m;
    const modRe = /^[ \t]*(?:pub\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/gm;
    while ((m = modRe.exec(content)) !== null)
        out.push({ specifier: m[1] });
    const useRe = /^[ \t]*use\s+([A-Za-z_:][A-Za-z0-9_:]*)/gm;
    while ((m = useRe.exec(content)) !== null)
        out.push({ specifier: m[1] });
    return out;
}
/** Java: `import a.b.C;` — package-qualified (not locally resolvable cheaply). */
function extractJavaImports(content) {
    const out = [];
    let m;
    const re = /^[ \t]*import\s+(?:static\s+)?([A-Za-z0-9_.*]+)\s*;/gm;
    while ((m = re.exec(content)) !== null)
        out.push({ specifier: m[1] });
    return out;
}
function extractImports(ext, content) {
    const e = ext.replace(/^\./, "").toLowerCase();
    switch (e) {
        case "ts":
        case "tsx":
        case "mts":
        case "cts":
        case "js":
        case "jsx":
        case "mjs":
        case "cjs":
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
function resolveRelativeTsJs(fromRel, specifier, fileSet) {
    if (!specifier.startsWith("."))
        return null; // bare/aliased → unresolved (Phase 2B)
    const dir = path.posix.dirname(fromRel);
    const base = path.posix.normalize(path.posix.join(dir, specifier));
    if (base.startsWith(".."))
        return null; // escapes the importing tree — never guess
    if (fileSet.has(base))
        return base; // explicit extension already present
    for (const suf of TS_RESOLVE_EXTS) {
        const cand = base + suf;
        if (fileSet.has(cand))
            return cand;
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
function parseJsonc(text) {
    let out = "";
    let inString = false;
    let inLineComment = false;
    let inBlockComment = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        const next = i + 1 < text.length ? text[i + 1] : "";
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
            }
            else if (c === '"') {
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
        const v = JSON.parse(out);
        return typeof v === "object" && v !== null && !Array.isArray(v)
            ? v
            : undefined;
    }
    catch {
        return undefined;
    }
}
/** String-aware trailing-comma stripper (a `,` before `]`/`}`, ignoring whitespace). */
function stripTrailingCommas(text) {
    let out = "";
    let inString = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inString) {
            out += c;
            if (c === "\\") {
                if (i + 1 < text.length) {
                    out += text[i + 1];
                    i++;
                }
            }
            else if (c === '"') {
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
            while (j < text.length && /\s/.test(text[j]))
                j++;
            if (j < text.length && (text[j] === "]" || text[j] === "}")) {
                // Drop this comma (do not append it); whitespace is re-emitted by the loop.
                continue;
            }
        }
        out += c;
    }
    return out;
}
/**
 * Build an `AliasTable` from a parsed tsconfig/jsconfig object. Returns `undefined`
 * when there is no usable `baseUrl`/`paths` (so the caller records nothing). PURE.
 *
 * Note: `paths` REQUIRES a `baseUrl` in classic resolution, but modern TS resolves
 * `paths` relative to the config file when `baseUrl` is absent. We mirror the modern
 * behaviour: `baseDir = configDir + (baseUrl ?? ".")`.
 */
function buildAliasTable(configDir, parsed) {
    const co = parsed.compilerOptions;
    const opts = typeof co === "object" && co !== null && !Array.isArray(co)
        ? co
        : {};
    const baseUrlRaw = typeof opts.baseUrl === "string" ? opts.baseUrl : undefined;
    const pathsRaw = typeof opts.paths === "object" && opts.paths !== null && !Array.isArray(opts.paths)
        ? opts.paths
        : undefined;
    if (baseUrlRaw === undefined && pathsRaw === undefined)
        return undefined;
    const joinPosix = (dir, rel) => {
        const j = path.posix.normalize(path.posix.join(dir === "" ? "." : dir, rel));
        return j === "." ? "" : j;
    };
    const baseDir = joinPosix(configDir, baseUrlRaw ?? ".");
    const patterns = [];
    if (pathsRaw) {
        for (const [pattern, targetsRaw] of Object.entries(pathsRaw)) {
            if (typeof pattern !== "string")
                continue;
            if (!Array.isArray(targetsRaw))
                continue;
            const targets = targetsRaw.filter((t) => typeof t === "string");
            if (targets.length > 0)
                patterns.push({ pattern, targets });
        }
    }
    return { configDir, baseDir, hasBaseUrl: baseUrlRaw !== undefined, patterns };
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
function resolveAliasTsJs(fromRel, specifier, tables, fileSet) {
    if (specifier.startsWith("."))
        return null; // relative handled elsewhere
    const fromDir = path.posix.dirname(fromRel);
    const governs = (configDir) => configDir === "" || fromDir === configDir || fromDir.startsWith(configDir + "/");
    // Collect ranked candidates: { prefixLen, resolvedPath }.
    const candidates = [];
    const probe = (baseDir, relTarget) => {
        const joined = path.posix.normalize(path.posix.join(baseDir === "" ? "." : baseDir, relTarget));
        const norm = joined === "." ? "" : joined;
        if (norm.startsWith(".."))
            return null; // escapes the repo — never guess
        if (fileSet.has(norm))
            return norm;
        for (const suf of TS_RESOLVE_EXTS) {
            const cand = norm + suf;
            if (fileSet.has(cand))
                return cand;
        }
        return null;
    };
    for (const table of tables) {
        if (!governs(table.configDir))
            continue;
        for (const { pattern, targets } of table.patterns) {
            const starIdx = pattern.indexOf("*");
            if (starIdx === -1) {
                // Exact (non-wildcard) pattern — must match the specifier verbatim.
                if (pattern !== specifier)
                    continue;
                for (const t of targets) {
                    const r = probe(table.baseDir, t);
                    if (r)
                        candidates.push({ prefixLen: pattern.length, resolved: r });
                }
            }
            else {
                const prefix = pattern.slice(0, starIdx);
                const suffix = pattern.slice(starIdx + 1);
                if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix))
                    continue;
                if (specifier.length < prefix.length + suffix.length)
                    continue;
                const captured = specifier.slice(prefix.length, specifier.length - suffix.length);
                for (const t of targets) {
                    const target = t.includes("*") ? t.replace("*", captured) : t;
                    const r = probe(table.baseDir, target);
                    // Non-wildcard prefix length is the tie-break key (longer = more specific).
                    if (r)
                        candidates.push({ prefixLen: prefix.length, resolved: r });
                }
            }
        }
        // baseUrl-relative bare specifier (only when the table declares a baseUrl).
        if (table.hasBaseUrl) {
            const r = probe(table.baseDir, specifier);
            if (r)
                candidates.push({ prefixLen: 0, resolved: r });
        }
    }
    if (candidates.length === 0)
        return null;
    // Longest non-wildcard prefix wins; ties → POSIX-sorted resolved path first.
    candidates.sort((a, b) => b.prefixLen - a.prefixLen ||
        (a.resolved < b.resolved ? -1 : a.resolved > b.resolved ? 1 : 0));
    return candidates[0].resolved;
}
/**
 * Expand a workspace glob pattern (e.g. "packages/*", "apps/**", "libs/foo") against
 * a set of candidate package-root dirs. PURE + deterministic — operates over the
 * provided dir set, never readdir order. A trailing `/*` matches one path segment; a
 * trailing `/**` matches one-or-more; an exact pattern matches that dir verbatim.
 * Returns the subset of `roots` that the pattern selects.
 */
function matchWorkspacePattern(pattern, roots) {
    const norm = pattern.replace(/\/+$/, ""); // trim trailing slash
    const out = [];
    for (const r of roots) {
        if (norm.endsWith("/**")) {
            const base = norm.slice(0, -3);
            if (r === base || r.startsWith(base + "/"))
                out.push(r);
        }
        else if (norm.endsWith("/*")) {
            const base = norm.slice(0, -2);
            // Exactly one segment under base.
            if (r.startsWith(base + "/")) {
                const rest = r.slice(base.length + 1);
                if (!rest.includes("/"))
                    out.push(r);
            }
        }
        else if (norm === "*") {
            if (!r.includes("/") && r !== "")
                out.push(r);
        }
        else {
            if (r === norm)
                out.push(r);
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
function buildPackageNameMap(manifests, workspacePatterns) {
    const sorted = [...manifests].sort((a, b) => (a.root < b.root ? -1 : a.root > b.root ? 1 : 0));
    const allRoots = sorted.map((m) => m.root);
    let eligible;
    if (workspacePatterns.length > 0) {
        eligible = new Set([""]); // repo root always eligible
        for (const pat of workspacePatterns) {
            for (const r of matchWorkspacePattern(pat, allRoots))
                eligible.add(r);
        }
    }
    else {
        eligible = new Set(allRoots);
    }
    const map = new Map();
    for (const m of sorted) {
        if (!eligible.has(m.root))
            continue;
        if (!m.name)
            continue;
        if (!map.has(m.name))
            map.set(m.name, m); // first-wins (sorted root order)
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
function resolveWorkspaceBare(specifier, pkgMap, fileSet) {
    if (specifier.startsWith("."))
        return null; // relative handled elsewhere
    // Find all package names that are a "head" of the specifier (name === spec, or
    // spec starts with name + "/").
    const matches = [];
    for (const [name, info] of pkgMap.entries()) {
        if (specifier === name || specifier.startsWith(name + "/"))
            matches.push(info);
    }
    if (matches.length === 0)
        return null;
    // Longest package name wins; ties → POSIX-sorted root first.
    matches.sort((a, b) => b.name.length - a.name.length ||
        (a.root < b.root ? -1 : a.root > b.root ? 1 : 0));
    const joinPosix = (dir, rel) => {
        const j = path.posix.normalize(path.posix.join(dir === "" ? "." : dir, rel));
        return j === "." ? "" : j;
    };
    const probe = (cand) => {
        if (cand.startsWith(".."))
            return null;
        if (fileSet.has(cand))
            return cand;
        for (const suf of TS_RESOLVE_EXTS) {
            if (fileSet.has(cand + suf))
                return cand + suf;
        }
        return null;
    };
    for (const info of matches) {
        const subpath = specifier === info.name ? "" : specifier.slice(info.name.length + 1);
        if (subpath) {
            const r = probe(joinPosix(info.root, subpath));
            if (r)
                return r;
        }
        else {
            // Bare package import → manifest entry (main/module), then index fallback.
            for (const entry of [info.main, info.module]) {
                if (typeof entry === "string" && entry.length > 0) {
                    const r = probe(joinPosix(info.root, entry));
                    if (r)
                        return r;
                }
            }
            const idx = probe(info.root === "" ? "index" : info.root);
            if (idx)
                return idx;
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
function resolveRelativePython(fromRel, specifier, fileSet) {
    if (!specifier.startsWith("."))
        return null;
    const dots = /^\.+/.exec(specifier)[0].length;
    const rest = specifier.slice(dots).replace(/\./g, "/");
    // One leading dot = current package; each extra dot climbs a level.
    let dir = path.posix.dirname(fromRel);
    for (let i = 1; i < dots; i++)
        dir = path.posix.dirname(dir);
    const base = rest ? path.posix.normalize(path.posix.join(dir, rest)) : dir;
    if (base.startsWith(".."))
        return null;
    for (const cand of [`${base}.py`, `${base}/__init__.py`]) {
        if (fileSet.has(cand))
            return cand;
    }
    return null;
}
