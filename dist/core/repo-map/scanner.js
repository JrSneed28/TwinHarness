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
exports.MAX_READ_BYTES = exports.GENERATED_DIRS = exports.TOTAL_BYTES_CAP = exports.FILE_COUNT_CAP = void 0;
exports.scanRepo = scanRepo;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const anchors_1 = require("../anchors");
const state_schema_1 = require("../state-schema");
const schema_1 = require("./schema");
/** Scan caps (TD §Internal — ODQ-001..003; internal tuning, reversible). */
exports.FILE_COUNT_CAP = 25_000;
exports.TOTAL_BYTES_CAP = 64 * 1024 * 1024; // 64 MB
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
    "vendor",
    "bin",
    "obj",
    ".venv",
    "venv",
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
/** Extension → language name. */
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
    if (!fs.existsSync(absRoot) || !fs.statSync(absRoot).isDirectory()) {
        return map; // empty-but-valid (REQ-RU-090).
    }
    const st = { filesScanned: 0, filesSkipped: 0, totalBytes: 0, capHit: null };
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
    // Component for a file = its top-level directory under a source root (REQ-RU-007/012).
    const componentForFile = (rel) => {
        const parts = rel.split("/");
        if (parts.length < 2)
            return null;
        const top = parts[0];
        if (!SOURCE_ROOT_NAMES.has(top))
            return null;
        return `${parts[0]}/${parts[1]}`;
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
        for (const entry of entries) {
            if (st.capHit)
                return;
            const abs = path.join(absDir, entry.name);
            const rel = relPosix(absRoot, abs);
            if (entry.isDirectory()) {
                // Producer's own state dir: skip SILENTLY (not recorded) so the map is
                // idempotent once `.twinharness/` exists (REQ-NFR-001).
                if (PRODUCER_DIRS.has(entry.name))
                    continue;
                // EXCLUSION BEFORE READ: never descend into a generated/build/cache dir.
                // Anchor: REQ-RU-041 — generated/build/cache dirs excluded across ALL areas (nested too).
                if (exports.GENERATED_DIRS.has(entry.name)) {
                    generatedPaths.add(rel);
                    continue;
                }
                // Root-level root detection (REQ-RU-005).
                if (depth === 0) {
                    const lower = entry.name.toLowerCase();
                    if (SOURCE_ROOT_NAMES.has(lower))
                        sourceRoots.add(rel);
                    if (TEST_ROOT_NAMES.has(lower))
                        testRoots.add(rel);
                    if (DOCS_ROOT_NAMES.has(lower))
                        docsRoots.add(rel);
                }
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
            const pmName = PM_MANIFEST[nameLower];
            if (pmName) {
                let set = pms.get(pmName);
                if (!set) {
                    set = new Set();
                    pms.set(pmName, set);
                }
                set.add(rel);
            }
            const isTest = isTestPath(rel);
            const component = componentForFile(rel);
            if (component) {
                componentFileCounts.set(component, (componentFileCounts.get(component) ?? 0) + 1);
                // Anchor: REQ-RU-012 — ownership hints (file→component mapping) recorded.
                ownershipHints.set(component, component);
            }
            const fileEntry = {
                path: rel,
                component,
                language: langName ?? null,
                is_test: isTest,
                req_ids: [], // filled from this file's single read below.
            };
            files.push(fileEntry);
            // Blast-radius signal detection by path tokens (REQ-RU-013).
            recordBlast(rel);
            // SINGLE READ (P3-1): a file at or under the per-file cap is read ONCE here;
            // that one buffer serves BOTH REQ-ID anchor extraction AND the manifest
            // detectors below. An oversize file is never read (name-only) — this is the
            // BOUNDED-COST guarantee (PERF-001, REQ-NFR-007, REQ-RU-090). The walk's own
            // exclusions (GENERATED_DIRS/PRODUCER_DIRS skipped before descent,
            // GENERATED_ARTIFACTS skipped per-file) mean every anchor collected here is
            // already correctly scoped, so no post-filter is needed (REQ-NFR-001).
            let content;
            if (size <= exports.MAX_READ_BYTES) {
                try {
                    content = fs.readFileSync(abs, "utf8");
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
            // Conventional entry-file detection (REQ-RU-008).
            if (ENTRY_FILES.has(nameLower)) {
                entrypoints.push({ name: entry.name, path: rel, source: "convention" });
            }
        }
    };
    walk(absRoot, 0);
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
    map.components = [...componentFileCounts.entries()].map(([name, file_count]) => ({
        name,
        path: name,
        file_count,
    }));
    map.entrypoints = entrypoints;
    map.public_api =
        apiHints.length > 0
            ? { hints: apiHints, confidence: "heuristic" }
            : null;
    map.ownership_hints = [...ownershipHints.entries()].map(([prefix, component]) => ({
        path_prefix: prefix,
        component,
    }));
    map.files = files;
    map.req_anchors = reqAnchors;
    map.blast_radius_signals = [...blastMatches.entries()].map(([flag, m]) => ({
        flag,
        matching_paths: [...m.paths],
        trigger_patterns: [...m.triggers],
    }));
    map.scanReport = {
        filesScanned: st.filesScanned,
        filesSkipped: st.filesSkipped,
        // The single main walk is the sole source of the cap signal now (P3-1): a cap
        // hit makes the map PARTIAL (REQ-NFR-007); a cap is NOT an error (RULE-014).
        capHit: st.capHit,
    };
    return map;
}
