"use strict";
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
exports.StateLocationConflictError = exports.WriteSurfaceError = exports.PathContainmentError = void 0;
exports.assertGovernedWriteSurface = assertGovernedWriteSurface;
exports.resolveWithinRoot = resolveWithinRoot;
exports.isAbsoluteOrEscaping = isAbsoluteOrEscaping;
exports.realpathExistingPrefix = realpathExistingPrefix;
exports.hasValidStateFile = hasValidStateFile;
exports.hasPresentStateFile = hasPresentStateFile;
exports.resolveStateCandidates = resolveStateCandidates;
exports.resolveProjectPaths = resolveProjectPaths;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const state_schema_1 = require("./state-schema");
/**
 * Thrown when a caller attempts to operate on a path that escapes the project
 * root (an absolute path, a `..` segment, or a separator-bearing component where
 * a single component is required). Lives here, beside {@link resolveWithinRoot},
 * because root-relative containment is the invariant this whole module enforces.
 *
 * A DISTINCT, typed error (with a stable `code`) so the single CLI boundary
 * (cli.ts) can map it to a structured `failure(...)` — and therefore a valid
 * `--json` envelope plus a sensible exit code — instead of letting a raw Node
 * stack escape (ARCH-003). The `code` mirrors the convention the state-store
 * uses for its lock/contention errors so the boundary can switch on it uniformly.
 */
class PathContainmentError extends Error {
    segment;
    /** Stable machine token surfaced in the `--json` failure envelope. */
    code = "path_containment";
    constructor(message, 
    /** The offending path/segment, echoed into the structured failure data. */
    segment) {
        super(message);
        this.segment = segment;
        this.name = "PathContainmentError";
    }
}
exports.PathContainmentError = PathContainmentError;
/**
 * Thrown by {@link assertGovernedWriteSurface} when a write targets a path that is
 * IN-ROOT but outside the governed write-surface allowlist
 * (`.twinharness` / `.agentic-sdlc` / `docs/` / `drift-log.md`). Distinct from
 * {@link PathContainmentError} (which is root ESCAPE): a write can be contained in
 * the root yet still land somewhere TwinHarness must never write (e.g. a slice's
 * `src/` implementation file). Mirrors `PathContainmentError`'s shape — a typed
 * error with a stable `code` — so the single CLI boundary maps it to a structured
 * `failure(...)` rather than letting a raw stack escape. This is the MECHANICAL
 * write-surface invariant (AC#1): it fires at the shared `atomicWriteFile`/append
 * chokepoint below every governed writer, so no control surface (CLI or MCP) can
 * write outside the allowlist by convention alone.
 */
class WriteSurfaceError extends Error {
    target;
    /** Stable machine token surfaced in the `--json` failure envelope. */
    code = "write_surface";
    constructor(message, 
    /** The offending absolute path, echoed into the structured failure data. */
    target) {
        super(message);
        this.target = target;
        this.name = "WriteSurfaceError";
    }
}
exports.WriteSurfaceError = WriteSurfaceError;
/**
 * Thrown by {@link resolveProjectPaths} (R-34, finding F5) when the state LOCATION
 * cannot be unambiguously selected by a valid `state.json` file:
 *   • BOTH the `.twinharness` and the legacy `.agentic-sdlc` locations hold a VALID
 *     `state.json` (a genuine ambiguity — picking one silently could clobber the
 *     other's run); or
 *   • a state file is PRESENT at a location but does NOT validate AND the other
 *     location has no valid state either, so there is no safe location to select
 *     (refuse to fail OPEN by treating it as a fresh untracked project).
 *
 * A DISTINCT, typed error with a stable `code` so the single CLI boundary maps it
 * to a structured `failure(...)` — every command (including the READ-ONLY
 * `th doctor`) surfaces it cleanly instead of silently picking the wrong location.
 * The message carries a recovery pointer to a MUTATING command (`th state adopt …`);
 * `th doctor` itself never recovers — it only reports.
 */
class StateLocationConflictError extends Error {
    kind;
    candidates;
    code = "state_location_conflict";
    constructor(message, 
    /** Machine token: "both-valid" (ambiguous) or "no-valid-location" (corrupt, no fail-open). */
    kind, 
    /** The two candidate state files, echoed into the structured failure data. */
    candidates) {
        super(message);
        this.kind = kind;
        this.candidates = candidates;
        this.name = "StateLocationConflictError";
    }
}
exports.StateLocationConflictError = StateLocationConflictError;
/**
 * The governed write-surface allowlist: the FIRST path segment (under root) that a
 * TwinHarness write is permitted to create/touch. `.twinharness` is the default
 * state dir; `.agentic-sdlc` is the legacy fallback (kept FOREVER so pre-migration
 * projects' legitimate writes are never false-rejected — pinned by test); `docs`
 * holds generated docs; `drift-log.md` and `debate-log.md` are the two root-level
 * append-only ledger files (the debate ledger mirrors the drift ledger,
 * `core/debate-log.ts`). This is the set the write-gate hook already allows
 * (`hook.ts` doc/state allowlist — which also permits any root-level `*.md`),
 * expressed here as a chokepoint guard so it binds CLI and MCP writes uniformly, not
 * just Claude-tool writes. Kept as an EXPLICIT list (not "any *.md") so the guard's
 * write surface is a closed, auditable set rather than an open category.
 */
const GOVERNED_WRITE_SURFACES = new Set([
    ".twinharness",
    ".agentic-sdlc",
    "docs",
    "drift-log.md",
    "debate-log.md",
]);
/**
 * Assert that `absPath` is a GOVERNED write target under `root` (AC#1). Two checks,
 * in order:
 *   1. Root containment via {@link resolveWithinRoot} — a path that escapes the
 *      root (absolute elsewhere, `..`, symlink/junction) throws (treated as a
 *      surface violation; the offending path is echoed).
 *   2. First-segment allowlist — the path's first component under root must be one
 *      of {@link GOVERNED_WRITE_SURFACES}; otherwise throw {@link WriteSurfaceError}.
 *
 * The root itself (a write AT `root`, rel === "") is not a file write and is
 * rejected. Called at the shared write chokepoint (`atomicWriteFile` + the four
 * append sites), so it is surface-agnostic: every governed writer passes through
 * it regardless of whether the caller is the CLI or the MCP adapter. Reads are
 * never guarded — only writes (per the spec: extends-target reads, artifact reads,
 * etc. are legitimate and bypass this).
 */
function assertGovernedWriteSurface(root, absPath) {
    const contained = resolveWithinRoot(root, absPath);
    if (contained === null) {
        throw new WriteSurfaceError(`Refusing a write that escapes the project root: ${absPath}`, absPath);
    }
    const rel = path.relative(path.resolve(root), contained);
    // A write AT the root (rel === "") is not a file write — reject it.
    // The first path segment is the allowlist key; split on either separator so the
    // check is identical on POSIX and Windows.
    const firstSegment = rel.split(/[\\/]/)[0] ?? "";
    if (firstSegment === "" || !GOVERNED_WRITE_SURFACES.has(firstSegment)) {
        throw new WriteSurfaceError(`Refusing a write outside the governed write-surface ` +
            `(${[...GOVERNED_WRITE_SURFACES].join(", ")}): ${rel || absPath}`, absPath);
    }
}
/**
 * Resolve `p` (absolute, or relative to `root`) to an absolute path, but ONLY
 * if it stays within `root`. Returns null when the path escapes the project
 * root (callers reject these — TwinHarness commands never operate outside the
 * project they govern). Mirrors the write-gate's root-containment check.
 */
function resolveWithinRoot(root, p) {
    // Cross-platform containment: a Windows drive-absolute (`C:\…`), UNC (`\\…`), or
    // any backslash-separated path is a real separator on Windows but would be parsed
    // as a single innocuous filename on POSIX — letting a hostile `C:\Windows\…` slip
    // through `path.isAbsolute`/`path.relative` and resolve *inside* the root. Reject
    // these on POSIX so containment never depends on the host OS. On Windows the guard
    // is skipped: the native isAbsolute/relative checks below already handle them, and
    // legitimate in-root absolute paths are themselves drive-absolute.
    if (path.sep === "/" && (/^[a-zA-Z]:[\\/]/.test(p) || p.includes("\\")))
        return null;
    const absRoot = path.resolve(root);
    const abs = path.isAbsolute(p) ? p : path.resolve(absRoot, p);
    const rel = path.relative(absRoot, abs);
    // 1. Lexical containment (cheap reject; rel === "" is the root itself).
    if (rel !== "" && (rel.startsWith("..") || path.isAbsolute(rel)))
        return null;
    // 2. Symlink/junction defense (H-5): a lexical check is fooled by a symlink or
    //    NTFS junction inside the root that points outside it. NTFS junctions are
    //    NOT symlinks (lstat().isSymbolicLink() is false for them), so a
    //    per-component symlink check misses the proven vector. Instead re-check
    //    containment after resolving REAL paths: realpath the root and the longest
    //    existing prefix of `abs` (tolerating a not-yet-created tail), symmetrically
    //    so a symlinked tmpdir (e.g. macOS /var -> /private/var) never false-rejects.
    // Resolve BOTH sides through `realpathExistingPrefix` so the symmetry holds even
    // when the root itself does not exist yet (a fresh `th init`, or a test tmpdir):
    // `realpathSafe` falls back to the LITERAL path on ENOENT, so realpath-ing the
    // root directly would leave it unresolved (e.g. `/var/...`) while `abs` resolves
    // its existing ancestor through a symlink (e.g. `/private/var/...`) — that
    // asymmetry false-rejects valid in-root paths on macOS/CI. `realpathExistingPrefix`
    // resolves each one's longest existing prefix identically.
    const realRoot = realpathExistingPrefix(absRoot);
    const realAbs = realpathExistingPrefix(abs);
    const realRel = path.relative(realRoot, realAbs);
    if (realRel === "")
        return abs; // resolves to the root itself
    if (realRel.startsWith("..") || path.isAbsolute(realRel))
        return null;
    return abs; // success: return the lexical in-root path (contract unchanged)
}
/**
 * Pure (no-I/O) predicate (R-22): does `p` look absolute or parent-escaping on
 * EITHER platform? Encodes the same cross-platform reject rule as
 * `resolveWithinRoot`'s `path.sep === "/"` branch above, but WITHOUT filesystem
 * realpath resolution — so it is safe (and correct) to run against an opaque
 * ledger KEY that is never joined to disk (the `<file>` part of an artifact lease
 * section id, and the artifact-register MCP pre-check). Catches:
 *   - native absolute (`path.isAbsolute`): POSIX `/x`; on Windows also `C:\x`, `\\unc`;
 *   - Windows drive-absolute (`C:\x`) — host-native `path.isAbsolute` returns FALSE
 *     for this on a POSIX host, which was the R-11 cross-platform gap this closes;
 *   - UNC (`\\server\share`) on a POSIX host;
 *   - any `..` segment (parent escape) on either platform.
 * The drive/UNC/`..` checks are host-independent (regex + string ops), so a hostile
 * `C:\Windows\x` is rejected identically on POSIX and Windows — containment no longer
 * depends on the host OS.
 */
function isAbsoluteOrEscaping(p) {
    return (path.isAbsolute(p) ||
        /^[a-zA-Z]:[\\/]/.test(p) ||
        p.startsWith("\\\\") ||
        p.split(/[\\/]/).includes(".."));
}
/** realpath `p`, preferring the native resolver; fall back to `p` if it errors. */
function realpathSafe(p) {
    try {
        return fs.realpathSync.native(p);
    }
    catch {
        try {
            return fs.realpathSync(p);
        }
        catch {
            return p;
        }
    }
}
/**
 * realpath the longest EXISTING prefix of `abs`, re-appending any not-yet-created
 * tail literally (a tail that does not exist on disk cannot contain a symlink or
 * junction). This lets us resolve real locations for paths that point at files
 * about to be written, without throwing ENOENT.
 *
 * Exported so the write-gate hook canonicalizes a tool's target the SAME way the
 * root is canonicalized (R-13): `resolveProjectPaths` realpaths the selected root,
 * so a containment check that compares a NON-canonical target (resolved against a
 * symlinked/8.3-aliased payload `cwd`) against the canonical root would falsely
 * read as "outside root" and fail the gate OPEN. Both sides must be canonicalized.
 */
function realpathExistingPrefix(abs) {
    let existing = abs;
    const tail = [];
    while (!fs.existsSync(existing)) {
        const parent = path.dirname(existing);
        if (parent === existing)
            break; // reached the filesystem root
        tail.unshift(path.basename(existing));
        existing = parent;
    }
    const real = realpathSafe(existing);
    return tail.length === 0 ? real : path.join(real, ...tail);
}
/**
 * R-34 / finding F5 — the state-location selection predicate. Returns true iff
 * `<stateFile>` exists AND parses AND VALIDATES against the state schema.
 *
 * Keying selection on a VALID FILE (not mere directory/file existence) is the
 * whole point of R-34: an `.twinharness` directory that holds only `templates/`
 * (no `state.json`), or a `state.json` that is corrupt/half-written, must NOT be
 * treated as "this is the project's state location" — that fail-open let the
 * resolver pick the wrong (empty) location while the real run lived in legacy.
 * A present-but-invalid file returns FALSE here (it is not a usable location);
 * the caller decides between legacy-fallback and a hard error from there.
 */
function hasValidStateFile(stateFile) {
    let raw;
    try {
        raw = fs.readFileSync(stateFile, "utf8");
    }
    catch {
        return false; // absent or unreadable → not a usable state location
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return false; // present but not JSON (corrupt/partial) → not usable
    }
    return (0, state_schema_1.validateState)(parsed).ok;
}
/**
 * R-34 — the upward-walk STOP predicate. Returns true iff `<stateFile>` is PRESENT
 * on disk, parseable or not. Keys on the state FILE (never a bare `.twinharness` /
 * `.agentic-sdlc` DIRECTORY, which may hold only `templates/`), so a templates-only
 * dir still does NOT anchor a project — the original M-7 fail-open that this preserves.
 *
 * Distinct from {@link hasValidStateFile}: the walk must stop at the nearest PRESENT
 * state file even when it does not validate, so a command run below a nested project
 * whose `state.json` is malformed diagnoses THAT child's invalid state (via the
 * present-but-invalid arm of {@link resolveProjectPaths}) instead of skipping the
 * child and silently selecting a valid OUTER ancestor — which would land state/build
 * mutations in the wrong project. Validity is decided afterward by the selection
 * policy; presence alone anchors the root.
 */
function hasPresentStateFile(stateFile) {
    return fs.existsSync(stateFile);
}
/**
 * Compute the canonical root and the two candidate state locations for `root`
 * WITHOUT applying the selection policy (never throws). Shared by
 * {@link resolveProjectPaths} and the `th state adopt` recovery so both anchor on
 * the SAME root + candidate set (R-34 parity).
 */
function resolveStateCandidates(root) {
    const startAbs = path.resolve(root);
    // M-7 — walk UP from the start dir to the nearest ancestor that already holds a
    // PRESENT TwinHarness state FILE (R-34: a state FILE, not a bare directory). A
    // session whose cwd is a subdirectory of the project must still find the
    // project's gates instead of failing OPEN (treating the subdir as untracked and
    // allowing the run). Keying the stop-condition on a present state FILE — rather
    // than on a `.twinharness` directory that may hold only `templates/` — closes
    // the fail-open seam where a bare state dir was mistaken for the project root.
    //
    // The stop keys on PRESENCE, not VALIDITY: stopping only at a *valid* file would
    // skip a nearer child whose `state.json` is malformed and select a valid OUTER
    // ancestor, so state/build mutations could land in the wrong project instead of
    // diagnosing the child's invalid state. Stopping at the nearest PRESENT file lets
    // the selection policy below run the present-but-invalid diagnose/block arm at the
    // CHILD. If no ancestor has any state file, fall back to the start dir
    // (fresh-project path through the selection below).
    let abs = startAbs;
    let cursor = startAbs;
    while (true) {
        if (hasPresentStateFile(path.join(cursor, ".twinharness", "state.json")) ||
            hasPresentStateFile(path.join(cursor, ".agentic-sdlc", "state.json"))) {
            abs = cursor;
            break;
        }
        const parent = path.dirname(cursor);
        if (parent === cursor)
            break; // reached the filesystem root: keep startAbs
        cursor = parent;
    }
    // R-13: canonicalize the selected root ONCE, here at selection — the walk picks
    // `abs` LEXICALLY, so a junction/symlink in the ancestor chain (NTFS junctions
    // are not symlinks: lstat().isSymbolicLink() is false for them) would leave the
    // containment anchor non-canonical. `resolveWithinRoot` realpaths both sides
    // today so writes are safe, but any future writer using `paths.root` directly
    // would inherit the redirected base. Anchoring the canonical form here makes the
    // root the single source of truth. `realpathExistingPrefix` tolerates a
    // not-yet-created root (fresh `th init`) by resolving its longest existing prefix.
    abs = realpathExistingPrefix(abs);
    const newDir = path.join(abs, ".twinharness");
    const legacyDir = path.join(abs, ".agentic-sdlc");
    const newStateFile = path.join(newDir, "state.json");
    const legacyStateFile = path.join(legacyDir, "state.json");
    return {
        root: abs,
        newDir,
        legacyDir,
        newStateFile,
        legacyStateFile,
        // R-34 — validity is by VALID state FILE; the directory's mere existence is
        // deliberately NOT consulted (that was the fail-open vector).
        newValid: hasValidStateFile(newStateFile),
        legacyValid: hasValidStateFile(legacyStateFile),
    };
}
function resolveProjectPaths(root) {
    const { root: abs, newDir, legacyDir, newStateFile, legacyStateFile, newValid, legacyValid } = resolveStateCandidates(root);
    let stateDir;
    if (newValid && legacyValid) {
        // Both locations hold a valid state — a genuine ambiguity. Refuse to pick one
        // (picking silently could clobber/strand the other run). Recovery lives in a
        // MUTATING command; `th doctor` stays read-only and just surfaces this error.
        throw new StateLocationConflictError(`Two valid TwinHarness state files were found and the location is ambiguous:\n` +
            `  - ${newStateFile} (.twinharness)\n` +
            `  - ${legacyStateFile} (.agentic-sdlc, legacy)\n` +
            `Refusing to guess. Consolidate onto one location with the mutating recovery command:\n` +
            `  th state adopt --twinharness   (keep .twinharness, retire the legacy state file)\n` +
            `  th state adopt --legacy        (keep .agentic-sdlc, retire the .twinharness state file)`, "both-valid", { twinharness: newStateFile, legacy: legacyStateFile });
    }
    else if (newValid) {
        stateDir = newDir;
    }
    else if (legacyValid) {
        // Legacy project: a valid `.agentic-sdlc/state.json`, and `.twinharness` has no
        // valid state (empty, only `templates/`, or corrupt). Stay in the legacy dir so
        // the existing project keeps working without migration.
        stateDir = legacyDir;
    }
    else {
        // Neither location has a VALID state file. There are three sub-cases:
        //   (a) BOTH locations have a state file present but NEITHER validates → a true
        //       both-invalid ambiguity with NO safe location: HARD ERROR, never fail
        //       open onto a fresh project (R-34 "no fail-open"). Picking one silently
        //       could resume the wrong broken run.
        //   (b) exactly ONE location has a present-but-invalid file → selection is
        //       UNAMBIGUOUS (that location); select it so the EXISTING present-but-invalid
        //       machinery runs — `readState` returns `{exists:true, issues}`, `th doctor`
        //       reports "present but INVALID", and the gates BLOCK. This is a diagnosable
        //       corrupt-file state, NOT a location-selection failure, so it must NOT throw.
        //   (c) NO state file at either location → a genuinely fresh project: default to
        //       `.twinharness`.
        const newPresent = fs.existsSync(newStateFile);
        const legacyPresent = fs.existsSync(legacyStateFile);
        if (newPresent && legacyPresent) {
            // (a) both present, both invalid — no fail-open.
            throw new StateLocationConflictError(`Both TwinHarness state files are present but NEITHER validates, so there is no safe ` +
                `location to select:\n` +
                `  - ${newStateFile} (.twinharness)\n` +
                `  - ${legacyStateFile} (.agentic-sdlc, legacy)\n` +
                `Refusing to fail open (treating this as a fresh untracked project would silently ` +
                `bypass the broken run's gates). Repair one file (\`th doctor\` to see why, then ` +
                `\`th migrate\`), or retire one with \`th state adopt\`.`, "no-valid-location", { twinharness: newStateFile, legacy: legacyStateFile });
        }
        else if (legacyPresent && !newPresent) {
            // (b) only the legacy file is present (and invalid) — select legacy so the
            // existing present-but-invalid path diagnoses + blocks there.
            stateDir = legacyDir;
        }
        else {
            // (b) only `.twinharness/state.json` is present-but-invalid → select
            //     `.twinharness` (the diagnose/block path), OR (c) neither present → fresh
            //     project defaults to `.twinharness`. Both resolve to the new dir.
            stateDir = newDir;
        }
    }
    return {
        root: abs,
        stateDir,
        stateFile: path.join(stateDir, "state.json"),
        docsDir: path.join(abs, "docs"),
        driftLog: path.join(abs, "drift-log.md"),
        interviewFile: path.join(stateDir, "interview.json"),
    };
}
