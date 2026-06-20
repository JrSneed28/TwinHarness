"use strict";
/**
 * `repo-map/scanner.ts` — a bounded, generated-dir-excluding directory walk that
 * assembles an in-memory `RepoMap` (schema.ts) via ten pure heuristic detectors.
 *
 * TRUST BOUNDARY (RULE-004, REQ-RU-004/040/041): repo content is UNTRUSTED data.
 * Discovered build/test commands are recorded as INERT `CandidateCommand` strings
 * — this module NEVER spawns a subprocess. There is no `child_process` import.
 *
 * REUSE (REQ-NFR-003, RULE-010): REQ anchors come from the pure `extractReqIds()`
 * (the same matcher `scanDirForReqIds` uses) applied to each file's single read in
 * the main walk, and blast-radius flags from `BLAST_RADIUS_FLAGS` — no parallel
 * mechanism is built. (P3-1: the former separate anchor re-walk is folded into the
 * main walk so every file is read at most once.)
 *
 * DETERMINISM (ADR-003): this module does NOT sort or normalize. The serializer
 * (schema.ts `serializeRepoMap`) is the SINGLE determinism point; the scanner may
 * emit collections in arbitrary order and with native separators.
 *
 * BOUNDED COST (REQ-NFR-007): generated/build/cache dirs are skipped BEFORE being
 * opened (RULE-003); a file-count cap (25000) and total-bytes cap (64 MB) stop the
 * walk early, producing a PARTIAL map with `scanReport.capHit` set (a cap is NOT
 * an error — RULE-014).
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
exports.MAX_READ_BYTES = exports.GENERATED_DIRS = exports.MAX_TOTAL_EDGES = exports.MAX_TOTAL_SYMBOLS = exports.MAX_SYMBOLS_PER_FILE = exports.TOTAL_BYTES_CAP = exports.FILE_COUNT_CAP = void 0;
exports.scanRepo = scanRepo;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const anchors_1 = require("../anchors");
const state_schema_1 = require("../state-schema");
const schema_1 = require("./schema");
const extract_1 = require("./extract");
/** Scan caps (TD §Internal — ODQ-001..003; internal tuning, reversible). */
exports.FILE_COUNT_CAP = 25_000;
exports.TOTAL_BYTES_CAP = 64 * 1024 * 1024; // 64 MB
/**
 * P2 cost gate (REQ-NFR-007). The import/symbol graph is bounded INDEPENDENTLY of
 * the file/byte caps so it can never blow the 64 MB / 25k envelope: at 25k files
 * and these caps the serialized graph stays small. AC#4: reaching the whole-graph
 * symbol or edge ceiling now ALSO marks the scan PARTIAL (`scanReport.capHit` ⇒
 * `"symbol-cap"`/`"edge-cap"`, and the derived `partial:true` + banner) — consistent
 * with the file/byte caps. The truncation is therefore declared, never silent.
 *   - MAX_SYMBOLS_PER_FILE: a single pathological file can't emit thousands of symbols.
 *     This is a PER-FILE clamp only (it never sets `capHit` — the whole-graph ceilings do).
 *   - MAX_TOTAL_SYMBOLS / MAX_TOTAL_EDGES: whole-graph ceilings (benchmarked in
 *     repo-bounded-cost.test.ts). Hitting either declares the map partial (AC#4).
 */
exports.MAX_SYMBOLS_PER_FILE = 200;
exports.MAX_TOTAL_SYMBOLS = 100_000;
exports.MAX_TOTAL_EDGES = 200_000;
/**
 * Directory names that are generated/build/cache and are EXCLUDED before being
 * opened (REQ-RU-006/041, RULE-003). Injected content under them is never read.
 */
exports.GENERATED_DIRS = new Set([
    "node_modules",
    "dist",
    "build",
    "target",
    "out",
    ".git",
    ".svn",
    ".hg",
    ".cache",
    ".next",
    ".nuxt",
    ".turbo",
    ".gradle",
    ".idea",
    ".vscode",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".tox",
    "coverage",
    ".venv",
    "venv",
    // NOTE: vendor/bin/obj are NOT here (P3-5) — they are CONTEXT-AWARE
    // (CONTEXT_AWARE_PRUNE_DIRS): pruned only at a module/package root, walked
    // otherwise, so a hand-written `bin/` of scripts is no longer silently dropped.
]);
/**
 * TwinHarness's OWN state directories and generated artifacts — the producer's own
 * output. These are skipped SILENTLY: never descended, and (unlike adopted-repo
 * generated dirs) never recorded in `generated_paths`. Recording them would make a
 * second run differ from the first once the artifacts exist (REQ-NFR-001). The dir
 * names are matched at any depth; the artifact paths are matched root-relative.
 */
const PRODUCER_DIRS = new Set([".twinharness", ".agentic-sdlc"]);
/**
 * Generated artifact paths (POSIX-relative) THIS command writes (IF-004/IF-005):
 * the markdown lives under `docs/` (a legitimate source dir) so it is matched by
 * path; the JSON lives under `.twinharness/` which is already a PRODUCER_DIR.
 */
const GENERATED_ARTIFACTS = new Set(["docs/00-repo-map.md"]);
/**
 * Largest single file we will read for content-based detection (bytes). The main
 * walk reads each file at most ONCE and only when `size <= MAX_READ_BYTES`; an
 * oversize file is name-only — never `readFileSync`-ed — which is what upholds the
 * BOUNDED-COST guarantee (PERF-001, REQ-NFR-007). The same single read serves both
 * manifest detection AND REQ-ID anchor extraction (P3-1 single-walk unification).
 */
exports.MAX_READ_BYTES = 2 * 1024 * 1024; // 2 MB — oversize files are name-only.
/**
 * Extension → language name. P3-4 extends this with C/C++/Objective-C/Swift/Dart/
 * Scala/Shell/SQL so mixed-language / mobile repos report their languages.
 */
const EXT_LANG = {
    ".ts": "TypeScript",
    ".tsx": "TypeScript",
    ".mts": "TypeScript",
    ".cts": "TypeScript",
    ".js": "JavaScript",
    ".jsx": "JavaScript",
    ".mjs": "JavaScript",
    ".cjs": "JavaScript",
    ".py": "Python",
    ".go": "Go",
    ".rs": "Rust",
    ".java": "Java",
    ".kt": "Kotlin",
    ".kts": "Kotlin",
    ".rb": "Ruby",
    ".php": "PHP",
    ".cs": ".NET",
    ".fs": ".NET",
    ".vb": ".NET",
    // P3-4 — C / C++ / Objective-C.
    ".c": "C",
    ".h": "C/C++",
    ".cc": "C++",
    ".cpp": "C++",
    ".cxx": "C++",
    ".hh": "C++",
    ".hpp": "C++",
    ".hxx": "C++",
    ".m": "Objective-C",
    ".mm": "Objective-C++",
    // P3-4 — Swift / Dart / Scala.
    ".swift": "Swift",
    ".dart": "Dart",
    ".scala": "Scala",
    ".sc": "Scala",
    // P3-4 — Shell / SQL.
    ".sh": "Shell",
    ".bash": "Shell",
    ".zsh": "Shell",
    ".sql": "SQL",
};
/** Manifest file name → language name (manifest-based detection). */
const MANIFEST_LANG = {
    "package.json": "JavaScript/TypeScript",
    "tsconfig.json": "TypeScript",
    "go.mod": "Go",
    "cargo.toml": "Rust",
    "pom.xml": "Java",
    "build.gradle": "Java",
    "build.gradle.kts": "Kotlin",
    "requirements.txt": "Python",
    "pyproject.toml": "Python",
    "setup.py": "Python",
    "pipfile": "Python",
    "gemfile": "Ruby",
    "composer.json": "PHP",
    // P3-3 — additional ecosystems.
    "pubspec.yaml": "Dart",
    "podfile": "Swift/Objective-C",
    "cmakelists.txt": "C/C++",
    "build.sbt": "Scala",
};
/** Manifest/lockfile name → package-manager name (REQ-RU-003). */
const PM_MANIFEST = {
    "package.json": "npm",
    "package-lock.json": "npm",
    "yarn.lock": "yarn",
    "pnpm-lock.yaml": "pnpm",
    "go.mod": "go modules",
    "go.sum": "go modules",
    "cargo.toml": "cargo",
    "cargo.lock": "cargo",
    "requirements.txt": "pip",
    "pipfile": "pipenv",
    "pyproject.toml": "pip",
    "poetry.lock": "poetry",
    "gemfile": "bundler",
    "gemfile.lock": "bundler",
    "composer.json": "composer",
    "composer.lock": "composer",
    "pom.xml": "maven",
    "build.gradle": "gradle",
    "build.gradle.kts": "gradle",
    // P3-3 — additional package managers / build tools.
    "pubspec.yaml": "pub",
    "pubspec.lock": "pub",
    "podfile": "cocoapods",
    "podfile.lock": "cocoapods",
    "cmakelists.txt": "cmake",
    "build.sbt": "sbt",
};
/**
 * P3-3 — file names (lowercased) that are MANIFESTS marking a directory as a
 * PACKAGE ROOT. A directory containing any of these is a package root; `src/lib/
 * tests/docs` and components are detected relative to EACH root (P3-1/P3-2), not
 * only at depth 0. This fixes monorepos / nested packages / sub-root source.
 */
const PACKAGE_MANIFESTS = new Set([
    "package.json",
    "go.mod",
    "cargo.toml",
    "pyproject.toml",
    "setup.py",
    "pipfile",
    "requirements.txt",
    "gemfile",
    "composer.json",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "build.sbt",
    "pubspec.yaml",
    "cmakelists.txt",
]);
/**
 * P3-3 — workspace/monorepo manifests (lowercased) that declare child packages.
 * Their PRESENCE marks a workspace root; the children are discovered structurally
 * by package-manifest detection (we do not glob the patterns — that is Phase 2B).
 */
const WORKSPACE_FILES = new Set([
    "pnpm-workspace.yaml",
    "lerna.json",
]);
/**
 * P3-5 — non-source build/task manifests added to the manifest-detection set so
 * mixed repos surface their build tooling. Not package roots themselves.
 */
const TASK_MANIFESTS = {
    "justfile": "just",
    "taskfile.yml": "task",
    "taskfile.yaml": "task",
};
/** Conventional source-root directory names (REQ-RU-005). */
const SOURCE_ROOT_NAMES = new Set(["src", "lib", "app", "pkg", "internal", "cmd"]);
/** Conventional test-root directory names (REQ-RU-005/010). */
const TEST_ROOT_NAMES = new Set(["tests", "test", "__tests__", "spec", "specs"]);
/** Conventional docs-root directory names (REQ-RU-005). */
const DOCS_ROOT_NAMES = new Set(["docs", "doc", "documentation"]);
/** Conventional entry-file names (REQ-RU-008). */
const ENTRY_FILES = new Set([
    "index.ts",
    "index.js",
    "main.ts",
    "main.js",
    "main.py",
    "main.go",
    "main.rs",
    "__main__.py",
    "cli.ts",
    "cli.js",
    "app.ts",
    "app.js",
    "server.ts",
    "server.js",
]);
/**
 * Blast-radius detection: flag → trigger token substrings (matched against the
 * lowercased file path). REQ-RU-013; over-firing is acceptable (RULE-008).
 */
const BLAST_PATTERNS = {
    authentication: ["auth", "login", "logout", "session", "credential", "password", "oauth", "token"],
    authorization: ["authz", "permission", "rbac", "acl", "role", "policy", "scope", "grant"],
    "data-integrity": ["migration", "schema", "transaction", "integrity", "constraint", "checksum"],
    money: ["payment", "billing", "invoice", "charge", "price", "currency", "stripe", "paypal"],
    migrations: ["migration", "migrate", "schema_migration", "flyway", "liquibase", "alembic"],
};
/**
 * P3-5 — directory names that are CONTEXT-AWARE: only pruned when they sit at a
 * module/package root (i.e. a sibling manifest indicates they are dependency/build
 * output, e.g. Go `vendor/`, build `bin/`/`obj/`). Elsewhere (a source dir literally
 * named `bin` with hand-written scripts) they are NOT silently dropped — they are
 * walked. This fixes the over-pruning of #4.
 */
const CONTEXT_AWARE_PRUNE_DIRS = new Set(["vendor", "bin", "obj"]);
// Anchor: REQ-RU-010 — test location detection (is_test on conventional test paths).
function isTestPath(relPosix) {
    const lower = relPosix.toLowerCase();
    if (/(^|\/)(tests?|__tests__|specs?)(\/|$)/.test(lower))
        return true;
    if (/\.(test|spec)\.[a-z0-9]+$/.test(lower))
        return true;
    if (/_test\.[a-z0-9]+$/.test(lower))
        return true; // go-style foo_test.go
    if (/test_[^/]*\.py$/.test(lower))
        return true; // python test_foo.py
    return false;
}
/** Convert an absolute path to a repo-root-relative POSIX path. */
function relPosix(root, abs) {
    return path.relative(root, abs).split(path.sep).join("/");
}
/**
 * Best-effort JSON parse that never throws (untrusted data).
 */
function safeParseJson(text) {
    try {
        const v = JSON.parse(text);
        return typeof v === "object" && v !== null && !Array.isArray(v) ? v : undefined;
    }
    catch {
        return undefined;
    }
}
/** Classify a script/command name into a CandidateCommand kind. */
function classifyCommand(name) {
    const n = name.toLowerCase();
    if (n.includes("test") || n.includes("spec") || n.includes("check"))
        return "test";
    if (n.includes("lint") || n.includes("format") || n.includes("fmt"))
        return "lint";
    if (n.includes("build") || n.includes("compile") || n.includes("bundle"))
        return "build";
    return "other";
}
/**
 * Scan a project root and assemble an in-memory `RepoMap` (best-effort, never
 * throws on repo content). The walk excludes generated dirs before opening them
 * and stops at the caps. Sorting/normalization is deferred to the serializer.
 */
function scanRepo(root, opts = {}) {
    const absRoot = path.resolve(root);
    const map = (0, schema_1.emptyRepoMap)(absRoot);
    const fileCountCap = opts.fileCountCap ?? exports.FILE_COUNT_CAP;
    const totalBytesCap = opts.totalBytesCap ?? exports.TOTAL_BYTES_CAP;
    // AC#4 — whole-graph ceilings (test-overridable, mirroring the file/byte caps).
    const maxTotalSymbols = opts.maxTotalSymbols ?? exports.MAX_TOTAL_SYMBOLS;
    const maxTotalEdges = opts.maxTotalEdges ?? exports.MAX_TOTAL_EDGES;
    if (!fs.existsSync(absRoot) || !fs.statSync(absRoot).isDirectory()) {
        return map; // empty-but-valid (REQ-RU-090).
    }
    const st = { filesScanned: 0, filesSkipped: 0, totalBytes: 0, capHit: null };
    // P3-5 — configured exclusion tokens (bare names or POSIX path prefixes).
    const excludeSet = new Set(opts.excludePaths ?? []);
    // P2-1/P2-2 — graph accumulators. `rawImportsByFile` defers edge resolution until
    // AFTER the walk (we need the full file set to resolve relative specifiers in-
    // memory; no extra FS access). `symbolTotal` enforces the whole-graph cost cap.
    const rawImportsByFile = new Map();
    let symbolTotal = 0;
    // DEFERRED #1a / AC#3 — raw tsconfig/jsconfig text captured during the walk, keyed
    // by the config's POSIX-relative FILE PATH (e.g. "tsconfig.json",
    // "packages/app/tsconfig.json", "tsconfig.base.json"). Parsed into alias tables
    // AFTER the walk so resolution sees the complete in-memory fileSet. An `extends`
    // base not captured during the walk (e.g. under the excluded node_modules) is read
    // lazily on demand. Content is INERT text — never require()'d/executed (RULE-004).
    const tsConfigText = new Map();
    // DEFERRED #1b — discovered in-repo package manifests (name + entry hints) and the
    // declared workspace glob patterns. Built PURELY in-memory after the walk into a
    // package-name -> root map; manifests are INERT JSON (never require()'d).
    const packageManifests = [];
    const workspacePatterns = [];
    // Accumulators (deduped by key, unsorted — the serializer sorts).
    const langs = new Map();
    const pms = new Map();
    const commands = [];
    const sourceRoots = new Set();
    const testRoots = new Set();
    const docsRoots = new Set();
    const generatedPaths = new Set();
    const componentFileCounts = new Map();
    const entrypoints = [];
    const ownershipHints = new Map();
    const files = [];
    const blastMatches = new Map();
    const apiHints = [];
    // REQ-ID anchors collected DURING the main walk (P3-1): reqId → set of POSIX-rel
    // files. A Set dedups the (reqId, file) pair so a file mentioning the same anchor
    // twice records one location, matching the old `scanDirForReqIds` semantics. The
    // serializer sorts both `req_anchors` and each `FileEntry.req_ids`, so insertion
    // order here is irrelevant to the byte-stable output (ADR-003).
    const reqIdToFiles = new Map();
    const recordLang = (name, evidence, source) => {
        let e = langs.get(name);
        if (!e) {
            e = { evidence: new Set(), sources: new Set() };
            langs.set(name, e);
        }
        e.evidence.add(evidence);
        e.sources.add(source);
    };
    const recordBlast = (relFile) => {
        const lower = relFile.toLowerCase();
        for (const flag of state_schema_1.BLAST_RADIUS_FLAGS) {
            for (const token of BLAST_PATTERNS[flag]) {
                if (lower.includes(token)) {
                    let m = blastMatches.get(flag);
                    if (!m) {
                        m = { paths: new Set(), triggers: new Set() };
                        blastMatches.set(flag, m);
                    }
                    m.paths.add(relFile);
                    m.triggers.add(token);
                }
            }
        }
    };
    // P3-1/P3-2 — package roots discovered during the walk (POSIX-relative dir of a
    // package manifest; "" = repo root). Source/test/docs roots and components are
    // derived RELATIVE to these roots after the walk, not from a depth===0 assumption.
    const packageRoots = new Set([""]); // repo root is always a package root
    // Candidate conventional-root dirs found at ANY depth: {rel dir, parent dir, kind}.
    const rootCandidates = [];
    // P3-5 — per-path exclusion reasons (in-memory only; surfaced, never persisted).
    const exclusions = [];
    /**
     * P3-2 — component for a file derived from the NEAREST enclosing package root: the
     * first path segment under that root (the conventional source-root name) plus one
     * more segment, e.g. under root "packages/app" the file
     * "packages/app/src/auth/x.ts" → component "packages/app/src/auth". Falls back to
     * the legacy top-level `src/<dir>` shape at the repo root so existing maps are
     * unchanged when there are no nested package roots.
     */
    const componentForFile = (rel) => {
        // Choose the longest package root that is a prefix of `rel` (nearest root).
        let best = "";
        for (const r of packageRoots) {
            if (r === "")
                continue;
            if ((rel === r || rel.startsWith(r + "/")) && r.length > best.length)
                best = r;
        }
        const sub = best === "" ? rel : rel.slice(best.length + 1);
        const parts = sub.split("/");
        if (parts.length < 2)
            return null;
        const top = parts[0];
        if (!SOURCE_ROOT_NAMES.has(top.toLowerCase()))
            return null;
        const local = `${parts[0]}/${parts[1]}`;
        return best === "" ? local : `${best}/${local}`;
    };
    // --- bounded recursive walk; exclusion BEFORE read (REQ-RU-006/041) ---------
    const walk = (absDir, depth) => {
        if (st.capHit)
            return;
        let entries;
        try {
            entries = fs.readdirSync(absDir, { withFileTypes: true });
        }
        catch {
            return; // unreadable dir — skip, do not crash (REQ-RU-090).
        }
        // P3-1/P3-3 — does THIS directory contain a package or workspace manifest?
        // Computed once per directory (before descending) so child conventional-root
        // dirs can be promoted relative to a real package root, at any depth.
        const dirRel = relPosix(absRoot, absDir);
        const dirRelKey = dirRel === "." ? "" : dirRel;
        let dirHasManifest = depth === 0; // repo root is always a package root
        let dirHasDeps = false; // any package/lock manifest ⇒ vendor/bin/obj are deps output
        for (const e of entries) {
            if (!e.isFile())
                continue;
            const ln = e.name.toLowerCase();
            if (PACKAGE_MANIFESTS.has(ln)) {
                dirHasManifest = true;
                dirHasDeps = true;
            }
            // P3-3 — a pnpm/lerna workspace declaration marks a package/workspace root so
            // its child packages' src/test/docs roots resolve relative to it.
            if (WORKSPACE_FILES.has(ln))
                dirHasManifest = true;
            if (ln in PM_MANIFEST)
                dirHasDeps = true;
        }
        if (dirHasManifest)
            packageRoots.add(dirRelKey);
        for (const entry of entries) {
            if (st.capHit)
                return;
            const abs = path.join(absDir, entry.name);
            const rel = relPosix(absRoot, abs);
            if (entry.isDirectory()) {
                // Producer's own state dir: skip SILENTLY (not recorded) so the map is
                // idempotent once `.twinharness/` exists (REQ-NFR-001).
                if (PRODUCER_DIRS.has(entry.name)) {
                    exclusions.push({ path: rel, reason: "producer-dir" });
                    continue;
                }
                // EXCLUSION BEFORE READ: never descend into a generated/build/cache dir.
                // Anchor: REQ-RU-041 — generated/build/cache dirs excluded across ALL areas (nested too).
                if (exports.GENERATED_DIRS.has(entry.name)) {
                    generatedPaths.add(rel);
                    exclusions.push({ path: rel, reason: "generated-dir" });
                    continue;
                }
                // P3-5 — CONTEXT-AWARE prune: vendor/bin/obj are pruned ONLY when a sibling
                // manifest indicates they are dependency/build output (a module root). A
                // plain `bin/` of hand-written scripts (no sibling manifest) is WALKED, not
                // silently dropped (#4 fix).
                if (CONTEXT_AWARE_PRUNE_DIRS.has(entry.name.toLowerCase()) && dirHasDeps) {
                    generatedPaths.add(rel);
                    exclusions.push({ path: rel, reason: "vendor-at-module-root" });
                    continue;
                }
                // P3-5 — configured exclusions (.twinharnessignore / ScanOptions). Matches a
                // bare dir name OR a POSIX-relative path prefix.
                if (excludeSet.has(entry.name) ||
                    excludeSet.has(rel) ||
                    [...excludeSet].some((x) => rel === x || rel.startsWith(x.replace(/\/$/, "") + "/"))) {
                    exclusions.push({ path: rel, reason: "configured" });
                    continue;
                }
                // Conventional-root detection at ANY depth (P3-1): record a candidate; it is
                // promoted to a real root after the walk IFF its parent dir is a package root.
                const lower = entry.name.toLowerCase();
                if (SOURCE_ROOT_NAMES.has(lower))
                    rootCandidates.push({ rel, parent: dirRelKey, kind: "source" });
                if (TEST_ROOT_NAMES.has(lower))
                    rootCandidates.push({ rel, parent: dirRelKey, kind: "test" });
                if (DOCS_ROOT_NAMES.has(lower))
                    rootCandidates.push({ rel, parent: dirRelKey, kind: "docs" });
                walk(abs, depth + 1);
                continue;
            }
            // Symlinks: Dirent.isFile() / isDirectory() use lstat semantics — symlinks
            // return false for both, so they fall through here and are skipped entirely.
            // This means a symlink pointing outside the repo is never followed (RULE-005).
            // Anchor: REQ-RU-092 — symlink not followed; in-repo symlink outside → skipped, not descended.
            if (!entry.isFile())
                continue;
            // Skip the producer's OWN generated artifacts SILENTLY so the map is
            // idempotent (REQ-NFR-001): a second run must not pick up — nor record —
            // files this command wrote.
            if (GENERATED_ARTIFACTS.has(rel))
                continue;
            // File-count cap → partial map (REQ-NFR-007); the cap is NOT an error.
            if (st.filesScanned >= fileCountCap) {
                st.capHit = "file-count";
                return;
            }
            let size = 0;
            try {
                size = fs.statSync(abs).size;
            }
            catch {
                st.filesSkipped++;
                continue; // unreadable stat — skip.
            }
            // Total-bytes cap → partial map (REQ-NFR-007).
            if (st.totalBytes + size > totalBytesCap) {
                st.capHit = "total-bytes";
                return;
            }
            st.totalBytes += size;
            st.filesScanned++;
            const nameLower = entry.name.toLowerCase();
            const ext = path.extname(entry.name).toLowerCase();
            // Language by extension (REQ-RU-002).
            const langName = EXT_LANG[ext];
            if (langName)
                recordLang(langName, rel, "extension");
            // Manifest-based language + package-manager detection (REQ-RU-002/003).
            const manifestLang = MANIFEST_LANG[nameLower];
            if (manifestLang)
                recordLang(manifestLang, rel, "manifest");
            // P3-3 — task runners (Justfile/Taskfile) surface as build tooling too.
            const pmName = PM_MANIFEST[nameLower] ?? TASK_MANIFESTS[nameLower];
            if (pmName) {
                let set = pms.get(pmName);
                if (!set) {
                    set = new Set();
                    pms.set(pmName, set);
                }
                set.add(rel);
            }
            const isTest = isTestPath(rel);
            // P3-2 — component is derived AFTER the walk (it depends on the full set of
            // package roots, which may include nested/monorepo roots discovered later).
            // Set null now; reassigned in the post-walk component pass below.
            const fileEntry = {
                path: rel,
                component: null,
                language: langName ?? null,
                is_test: isTest,
                req_ids: [], // filled from this file's single read below.
            };
            files.push(fileEntry);
            // Blast-radius signal detection by path tokens (REQ-RU-013).
            recordBlast(rel);
            // SINGLE READ (P3-1): a file at or under the per-file cap is read ONCE here as
            // a RAW Buffer. That one buffer serves the binary sniff (P2-4), REQ-ID anchor
            // extraction, the manifest detectors, AND symbol/import extraction (P2-1/2).
            // An oversize file is never read (name-only) — the BOUNDED-COST guarantee
            // (PERF-001, REQ-NFR-007, REQ-RU-090).
            //
            // P2-4 binary guard: a NUL byte in the buffer ⇒ treat as binary. Binary files
            // are NEVER decoded for anchors/symbols/imports (a lossy utf8 decode would
            // both invent garbage anchors and is meaningless for parsing). They are still
            // counted/sized/hashed (hashing happens in the command layer on raw bytes).
            let content;
            if (size <= exports.MAX_READ_BYTES) {
                try {
                    const buf = fs.readFileSync(abs);
                    // P2-4 binary guard: a NUL byte ⇒ binary ⇒ leave `content` undefined so
                    // no anchors/symbols/imports are extracted from a lossy utf8 decode.
                    if (!(0, extract_1.looksBinary)(buf))
                        content = buf.toString("utf8");
                }
                catch {
                    content = undefined; // unreadable → name-only, like an oversize file.
                }
            }
            // REQ-ID anchors (REQ-RU-011) from the SAME single read — uses the pure
            // `extractReqIds` matcher that `scanDirForReqIds` uses (REQ-NFR-003).
            if (content !== undefined) {
                const ids = (0, anchors_1.extractReqIds)(content);
                if (ids.length > 0) {
                    fileEntry.req_ids = ids;
                    for (const id of ids) {
                        let set = reqIdToFiles.get(id);
                        if (!set) {
                            set = new Set();
                            reqIdToFiles.set(id, set);
                        }
                        set.add(rel);
                    }
                }
            }
            // P2-1 / P2-2 — symbol + import extraction from the SAME single read. Only for
            // text source files in the parse allowlist (never binary, never oversize). The
            // per-file symbol cap and the whole-graph symbol cap (REQ-NFR-007) bound cost.
            if (content !== undefined && (0, extract_1.isParseableExt)(ext)) {
                if (symbolTotal < maxTotalSymbols) {
                    const syms = (0, extract_1.extractSymbols)(ext, content, exports.MAX_SYMBOLS_PER_FILE);
                    if (syms.length > 0) {
                        const room = maxTotalSymbols - symbolTotal;
                        const bounded = syms.length > room ? syms.slice(0, room) : syms;
                        fileEntry.symbols = bounded;
                        symbolTotal += bounded.length;
                        // AC#4 — the whole-graph symbol ceiling truncated this file's symbols:
                        // the symbol graph is now INCOMPLETE → declare the map partial (first-non-
                        // null wins; `partial:true` + banner are derived from any non-null capHit).
                        if (bounded.length < syms.length)
                            st.capHit ??= "symbol-cap";
                    }
                }
                else {
                    // AC#4 — already at the whole-graph symbol ceiling: this file's symbols are
                    // dropped entirely. The symbol graph is incomplete → declare it partial.
                    st.capHit ??= "symbol-cap";
                }
                const imports = (0, extract_1.extractImports)(ext, content);
                if (imports.length > 0) {
                    rawImportsByFile.set(rel, { ext, imports });
                }
            }
            // Manifest content detectors (commands, entrypoints, public-api hints) — only
            // for small manifests; oversize files are name-only (REQ-RU-090). Reuses the
            // single `content` read above — no second `readFileSync`.
            if (nameLower === "package.json" && content !== undefined) {
                const json = safeParseJson(content);
                if (json) {
                    // Candidate commands from scripts (RECORDED, NEVER EXECUTED — REQ-RU-004).
                    // Anchor: REQ-RU-091 — discovered commands are inert data; no subprocess is ever spawned.
                    // Anchor: REQ-RU-040 — no execution of any discovered command anywhere in the layer.
                    const scripts = json.scripts;
                    if (typeof scripts === "object" && scripts !== null && !Array.isArray(scripts)) {
                        for (const [label, raw] of Object.entries(scripts)) {
                            if (typeof raw === "string") {
                                commands.push({ label, raw, source_file: rel, kind: classifyCommand(label) });
                            }
                        }
                    }
                    // Entrypoints: bin (REQ-RU-008).
                    const bin = json.bin;
                    const dir = path.dirname(rel) === "." ? "" : path.dirname(rel) + "/";
                    if (typeof bin === "string") {
                        entrypoints.push({ name: path.basename(rel, ".json"), path: dir + bin, source: "package.json:bin" });
                    }
                    else if (typeof bin === "object" && bin !== null && !Array.isArray(bin)) {
                        for (const [bname, bpath] of Object.entries(bin)) {
                            if (typeof bpath === "string") {
                                entrypoints.push({ name: bname, path: dir + bpath, source: "package.json:bin" });
                            }
                        }
                    }
                    // Entrypoints: main / module (REQ-RU-008).
                    if (typeof json.main === "string") {
                        entrypoints.push({ name: "main", path: dir + json.main, source: "package.json:main" });
                    }
                    if (typeof json.module === "string") {
                        entrypoints.push({ name: "module", path: dir + json.module, source: "package.json:module" });
                    }
                    // Public-API hint: an `exports` field (best-effort — REQ-RU-009).
                    if (json.exports !== undefined) {
                        apiHints.push({ name: path.basename(rel), source: "package.json:exports" });
                    }
                    // DEFERRED #1b — record this manifest's name + entry hints for the
                    // package-name -> root map. `dir` (computed above) ends with "/" or is "".
                    const pkgRoot = dir.endsWith("/") ? dir.slice(0, -1) : dir; // "" = repo root
                    if (typeof json.name === "string" && json.name.length > 0) {
                        packageManifests.push({
                            root: pkgRoot,
                            name: json.name,
                            ...(typeof json.main === "string" ? { main: json.main } : {}),
                            ...(typeof json.module === "string" ? { module: json.module } : {}),
                        });
                    }
                    // DEFERRED #1b — workspace glob patterns from `workspaces` (array form OR
                    // the yarn `{ packages: [...] }` object form). Patterns are repo-root-
                    // relative; prefixed with the manifest dir for nested workspace roots.
                    const collectPatterns = (raw) => {
                        if (!Array.isArray(raw))
                            return;
                        for (const p of raw) {
                            if (typeof p === "string" && p.length > 0) {
                                workspacePatterns.push(pkgRoot === "" ? p : `${pkgRoot}/${p}`);
                            }
                        }
                    };
                    if (Array.isArray(json.workspaces))
                        collectPatterns(json.workspaces);
                    else if (typeof json.workspaces === "object" && json.workspaces !== null &&
                        Array.isArray(json.workspaces.packages)) {
                        collectPatterns(json.workspaces.packages);
                    }
                }
            }
            else if ((nameLower === "pnpm-workspace.yaml" || nameLower === "pnpm-workspace.yml") && content !== undefined) {
                // DEFERRED #1b — pnpm declares workspace globs as a YAML `packages:` list. We
                // read it as INERT text with a minimal line scanner (never a YAML executor):
                // `packages:` followed by `- 'glob'` items. Patterns are repo-root-relative.
                const dir = path.posix.dirname(rel);
                const base = dir === "." ? "" : dir;
                let inPackages = false;
                for (const line of content.split(/\r?\n/)) {
                    if (/^packages\s*:/.test(line)) {
                        inPackages = true;
                        continue;
                    }
                    if (inPackages) {
                        const m = /^\s*-\s*['"]?([^'"\s#]+)['"]?/.exec(line);
                        if (m && m[1])
                            workspacePatterns.push(base === "" ? m[1] : `${base}/${m[1]}`);
                        else if (/^\S/.test(line))
                            inPackages = false; // dedented → end of list
                    }
                }
            }
            else if (nameLower === "lerna.json" && content !== undefined) {
                // DEFERRED #1b — lerna declares workspace globs in a JSON `packages` array.
                const json = safeParseJson(content);
                const dir = path.posix.dirname(rel);
                const base = dir === "." ? "" : dir;
                if (json && Array.isArray(json.packages)) {
                    for (const p of json.packages) {
                        if (typeof p === "string" && p.length > 0) {
                            workspacePatterns.push(base === "" ? p : `${base}/${p}`);
                        }
                    }
                }
            }
            else if (nameLower === "makefile" && content !== undefined) {
                // Makefile targets → candidate commands (RECORDED, NEVER EXECUTED). Reuses
                // the single `content` read above — no second `readFileSync`.
                for (const line of content.split(/\r?\n/)) {
                    const m = /^([A-Za-z0-9_.-]+):(?!=)/.exec(line);
                    if (m && m[1] && m[1] !== ".PHONY") {
                        commands.push({ label: m[1], raw: `make ${m[1]}`, source_file: rel, kind: classifyCommand(m[1]) });
                    }
                }
            }
            // DEFERRED #1a / AC#3 — capture tsconfig/jsconfig raw text for post-walk alias-
            // table construction, keyed by the config's resolved POSIX FILE PATH (not its
            // dir). Keying by path lets an `extends` base that is NOT named exactly
            // `tsconfig.json` (e.g. `tsconfig.base.json`) be found in-memory, and is the
            // stable key the extends-chain reader looks up. We capture the canonical entry
            // names AND any `tsconfig*.json`/`jsconfig*.json` base variant; a base under
            // `node_modules` (excluded from the walk) is read lazily on demand below.
            // Reuses the single read; content is INERT text (RULE-004, never executed).
            if (content !== undefined &&
                (nameLower === "tsconfig.json" || nameLower === "jsconfig.json" ||
                    /^(tsconfig|jsconfig)\..*\.json$/.test(nameLower))) {
                tsConfigText.set(rel, content);
            }
            // Conventional entry-file detection (REQ-RU-008).
            if (ENTRY_FILES.has(nameLower)) {
                entrypoints.push({ name: entry.name, path: rel, source: "convention" });
            }
        }
    };
    walk(absRoot, 0);
    // --- P3-1/P3-2: promote conventional roots + derive components (post-walk) ----
    // A candidate src/lib/tests/docs dir becomes a real root ONLY when its parent is
    // a package root (the repo root, or any dir that held a package manifest). This
    // fixes monorepos / nested packages / sub-root source: roots are detected relative
    // to EACH package root, not under the old `depth===0` assumption (scanner.ts:360).
    for (const c of rootCandidates) {
        if (!packageRoots.has(c.parent))
            continue;
        if (c.kind === "source")
            sourceRoots.add(c.rel);
        else if (c.kind === "test")
            testRoots.add(c.rel);
        else
            docsRoots.add(c.rel);
    }
    // Re-derive each file's component from the (now-complete) package-root set.
    for (const fe of files) {
        const comp = componentForFile(fe.path);
        fe.component = comp;
        if (comp) {
            componentFileCounts.set(comp, (componentFileCounts.get(comp) ?? 0) + 1);
            ownershipHints.set(comp, comp);
        }
    }
    // --- P2-2: resolve import edges (locally-resolvable only; never guess) --------
    // Resolution is pure + in-memory: a relative specifier is resolved against the
    // full set of scanned file paths. Bare/aliased/tsconfig-paths specifiers are
    // recorded as `unresolved`/`external` (Phase 2B does full module resolution). The
    // whole-graph edge cap bounds cost (REQ-NFR-007).
    const fileSet = new Set(files.map((f) => f.path));
    // DEFERRED #1a / AC#3 — build tsconfig/jsconfig alias tables from the captured raw
    // text, resolving each config's `extends` chain FIRST so aliases declared in a base
    // config (incl. a `tsconfig.base.json` or a node_modules base) and inherited via
    // `extends` resolve to `basis:"alias"` (not `unresolved`). PURE + in-memory for the
    // walked configs; an extends base NOT captured by the walk is read lazily ON DEMAND
    // through `readExtendsBase` below. A parse failure (or no usable baseUrl/paths) simply
    // yields no table (fall back to unresolved — never a guess). Configs are processed in
    // POSIX-sorted FILE-PATH order for deterministic table ordering (ADR-003).
    //
    // `readExtendsBase` is the single, BOUNDED lazy reader the chain uses. It is keyed by
    // POSIX path: it returns the in-memory text when the base was walked, else reads it
    // ONCE from disk (under absRoot — `resolveExtendsTarget` already rejected `..`-escapes
    // and absolute refs, so the key cannot leave the tree). Both hits AND misses are
    // memoized so the reader is a pure function of its key set, independent of FS
    // iteration / call order (ADR-003). These are legitimate READS (a base under the
    // excluded node_modules is read here, never written) — only WRITES are surface-guarded.
    const extendsReadCache = new Map();
    const readExtendsBase = (posixKey) => {
        const inMem = tsConfigText.get(posixKey);
        if (inMem !== undefined)
            return inMem;
        if (extendsReadCache.has(posixKey))
            return extendsReadCache.get(posixKey);
        let text;
        try {
            const abs = path.join(absRoot, ...posixKey.split("/"));
            const buf = fs.readFileSync(abs);
            // Binary guard mirrors the main walk: a NUL byte ⇒ not a usable text config.
            text = (0, extract_1.looksBinary)(buf) ? undefined : buf.toString("utf8");
        }
        catch {
            text = undefined; // unreadable base — fail-safe (the chain records unresolved).
        }
        extendsReadCache.set(posixKey, text);
        return text;
    };
    const aliasTables = [];
    for (const [configPath, text] of [...tsConfigText.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        const parsed = (0, extract_1.parseJsonc)(text);
        if (!parsed)
            continue;
        // Resolve the `extends` chain into an alias table (real TS semantics: paths REPLACE,
        // baseUrl child-wins, declaring-dir tracked, depth+cycle bounded, single node_modules
        // hop, fail-safe). Returns undefined when the chain declares neither baseUrl nor paths
        // (this config contributes no aliases — skip it). A config with no `extends` collapses
        // to exactly the same table `buildAliasTable` would have produced for it alone.
        const table = (0, extract_1.resolveExtendsChain)(configPath, parsed, readExtendsBase);
        if (table)
            aliasTables.push(table);
    }
    // DEFERRED #1b — build the workspace package-name -> root map PURELY in-memory from
    // the discovered manifests + declared workspace glob patterns. Deterministic:
    // first-wins over POSIX-sorted roots; membership restricted to matched workspace
    // members when patterns are declared (else all named packages).
    const packageNameMap = (0, extract_1.buildPackageNameMap)(packageManifests, workspacePatterns);
    const edges = [];
    const edgeSeen = new Set();
    outer: for (const [from, { ext, imports }] of rawImportsByFile.entries()) {
        const e = ext.replace(/^\./, "").toLowerCase();
        const isTsJs = ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"].includes(e);
        const isPy = e === "py";
        for (const imp of imports) {
            // AC#4 — the whole-graph edge ceiling truncates the import graph: declare the map
            // partial (first-non-null wins) BEFORE stopping, so the truncation is never silent
            // (`partial:true` + banner are derived from any non-null capHit).
            if (edges.length >= maxTotalEdges) {
                st.capHit ??= "edge-cap";
                break outer;
            }
            let to = null;
            if (isTsJs)
                to = (0, extract_1.resolveRelativeTsJs)(from, imp.specifier, fileSet);
            else if (isPy)
                to = (0, extract_1.resolveRelativePython)(from, imp.specifier, fileSet);
            if (to !== null) {
                const key = `${from}\0${to}\0parsed`;
                if (edgeSeen.has(key))
                    continue;
                edgeSeen.add(key);
                edges.push({ from, to, kind: "import", basis: "parsed" });
                continue;
            }
            // DEFERRED #1a — relative resolution failed: try tsconfig/jsconfig aliases for
            // a TS/JS specifier. A successful alias lands on an in-repo file and is recorded
            // with basis:"alias" (DISTINCT from parsed — inspection/telemetry only). Counts
            // against MAX_TOTAL_EDGES (REQ-NFR-007). Never guessed: a non-landing specifier
            // falls through to the honest `unresolved` label below.
            let aliasTo = null;
            if (isTsJs && aliasTables.length > 0) {
                aliasTo = (0, extract_1.resolveAliasTsJs)(from, imp.specifier, aliasTables, fileSet);
            }
            // DEFERRED #1b — tsconfig aliases failed: try workspace bare-package resolution
            // for a TS/JS bare specifier whose head matches an in-repo package name. A
            // landing candidate is recorded basis:"alias"; a non-landing specifier falls
            // through to `unresolved` (never guessed).
            if (aliasTo === null && isTsJs && packageNameMap.size > 0) {
                aliasTo = (0, extract_1.resolveWorkspaceBare)(imp.specifier, packageNameMap, fileSet);
            }
            if (aliasTo !== null) {
                const key = `${from}\0${aliasTo}\0alias`;
                if (edgeSeen.has(key))
                    continue;
                edgeSeen.add(key);
                edges.push({ from, to: aliasTo, kind: "import", basis: "alias" });
                continue;
            }
            // Honest unresolved label — NEVER guessed into an in-repo path (RULE / S1).
            const key = `${from}\0${imp.specifier}\0unresolved`;
            if (edgeSeen.has(key))
                continue;
            edgeSeen.add(key);
            edges.push({ from, to: imp.specifier, kind: "import", basis: "unresolved", external: true });
        }
    }
    // --- REQ anchors (REQ-RU-011, REQ-NFR-003) ----------------------------------
    // Collected DURING the single main walk above (P3-1): each file was read at most
    // once and `extractReqIds` ran on that same buffer, with `FileEntry.req_ids` set
    // inline. Because the walk applies the SAME exclusions (GENERATED_DIRS /
    // PRODUCER_DIRS skipped before descent, GENERATED_ARTIFACTS skipped per-file),
    // every collected anchor is already correctly scoped — no post-filter is needed,
    // so the producer's own output can never re-enter the map (REQ-NFR-001).
    //
    // SCOPE CONTRACT (finding #2 / ADR-004 — NOT "byte-identical to an uncapped
    // two-pass"). The anchor set is COMPLETE for in-scope files, but a REQ-ID that
    // appears ONLY inside an oversize file (> MAX_READ_BYTES — read name-only) or
    // ONLY under a generated/producer directory is INTENTIONALLY EXCLUDED. That is
    // the deliberate bounded-cost + scope guarantee (PERF-001 / REQ-RU-006/041), not
    // an oversight: re-including those anchors would reintroduce the unbounded read
    // (oversize) or let build output pollute traceability (generated). The boundary
    // is pinned by golden tests (repo-bounded-cost.test.ts for oversize,
    // scanner-anchor-scope.test.ts for generated/producer) so any re-inclusion fails
    // loudly. The serializer sorts `req_anchors` and each `locations` array, so
    // insertion order is irrelevant to the byte-stable output (ADR-003).
    const reqAnchors = [];
    for (const [reqId, locations] of reqIdToFiles.entries()) {
        reqAnchors.push({ req_id: reqId, locations: [...locations] });
    }
    // --- assemble final accumulators into the in-memory map ----------------------
    map.languages = [...langs.entries()].map(([name, e]) => ({
        name,
        evidence: [...e.evidence],
        source: e.sources.has("extension") && e.sources.has("manifest")
            ? "both"
            : e.sources.has("manifest")
                ? "manifest"
                : "extension",
    }));
    map.package_managers = [...pms.entries()].map(([name, set]) => ({
        name,
        manifest_paths: [...set],
    }));
    map.candidate_commands = commands;
    map.source_roots = [...sourceRoots];
    map.test_roots = [...testRoots];
    map.docs_roots = [...docsRoots];
    map.generated_paths = [...generatedPaths];
    // P1-3 — fixed provenance per derived structure. These are HONEST self-labels:
    // components/ownership/blast-radius are directory/path-token heuristics (medium);
    // an entrypoint declared in a manifest is high-confidence, a convention-derived
    // one only a name heuristic; the public-API surface here comes from manifest
    // `exports` so it is manifest-basis (medium until Phase 2 adds parsed evidence).
    const PROV_PATH_TOKEN = { basis: "path-token", confidence: "medium" };
    const entrypointProvenance = (source) => source.startsWith("package.json")
        ? { basis: "manifest", confidence: "high" }
        : { basis: "name", confidence: "medium" };
    map.components = [...componentFileCounts.entries()].map(([name, file_count]) => ({
        name,
        path: name,
        file_count,
        provenance: PROV_PATH_TOKEN,
    }));
    map.entrypoints = entrypoints.map((e) => ({
        ...e,
        provenance: entrypointProvenance(e.source),
    }));
    // P2-3 — public-API beyond the manifest: barrel/`index` files that EXPORT symbols
    // are a parsed public surface. Combine the manifest `exports` hints (above) with
    // parsed barrel hints. When ANY hint is parsed, the surface basis is "parsed"
    // (higher trust than manifest-only); otherwise it stays "manifest".
    const parsedApiHints = [];
    for (const fe of files) {
        const base = fe.path.split("/").pop().toLowerCase();
        const isBarrel = /^(index|mod|lib)\.[a-z]+$/.test(base) || base === "__init__.py";
        if (isBarrel && fe.symbols && fe.symbols.length > 0) {
            parsedApiHints.push({ name: fe.path, source: "barrel:exports" });
        }
    }
    const allApiHints = [...apiHints, ...parsedApiHints];
    map.public_api =
        allApiHints.length > 0
            ? {
                hints: allApiHints,
                confidence: "heuristic",
                provenance: parsedApiHints.length > 0
                    ? { basis: "parsed", confidence: "medium" }
                    : { basis: "manifest", confidence: "medium" },
            }
            : null;
    map.ownership_hints = [...ownershipHints.entries()].map(([prefix, component]) => ({
        path_prefix: prefix,
        component,
        provenance: PROV_PATH_TOKEN,
    }));
    map.files = files;
    map.req_anchors = reqAnchors;
    map.blast_radius_signals = [...blastMatches.entries()].map(([flag, m]) => ({
        flag,
        matching_paths: [...m.paths],
        trigger_patterns: [...m.triggers],
        provenance: PROV_PATH_TOKEN,
    }));
    // P2-2 — attach edges only when non-empty (omit-when-absent — the serializer also
    // omits an empty array, but keeping the in-memory field absent is tidier).
    if (edges.length > 0)
        map.edges = edges;
    // P3-6 — low-confidence-structure warning: files were scanned but NO source roots
    // and NO components were derived (a likely-missed layout). Surfaced visibly so a
    // structure miss is never silent. The floor (5) avoids flagging tiny/empty repos.
    const lowConfidenceStructure = st.filesScanned > 5 && sourceRoots.size === 0 && componentFileCounts.size === 0;
    map.scanReport = {
        filesScanned: st.filesScanned,
        filesSkipped: st.filesSkipped,
        // The single main walk is the sole source of the cap signal now (P3-1): a cap
        // hit makes the map PARTIAL (REQ-NFR-007); a cap is NOT an error (RULE-014).
        capHit: st.capHit,
        ...(lowConfidenceStructure ? { lowConfidenceStructure: true } : {}),
        ...(exclusions.length > 0 ? { exclusions } : {}),
    };
    return map;
}
