"use strict";
/**
 * Blackboard collab substrate (REQ-PCO-040, plan Phase 4 / Slice 5).
 *
 * A deterministic file-backed "blackboard" where parallel agents drop fragment
 * files and a Reconciler merges them. Fragments live under
 * `<stateDir>/collab/<stage>/<round>/` — one file per fragment. The merge is
 * pure concatenation in sorted (deterministic) order, so re-running it on the
 * same inputs is idempotent.
 *
 * Boundary rule (plan §3): this module is purely mechanical — it records and
 * computes against the fragment tree. It never *decides* which fragments belong,
 * who reconciles, or what the merged artifact means. The one rule it enforces is
 * traceability (§17): every fragment must carry at least one REQ-ID anchor, so
 * the merged blackboard stays attributable to requirements. Pure/synchronous,
 * mirroring the rest of `src/core`.
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
exports.FRAGMENT_TTL_MS = exports.FragmentExistsError = void 0;
exports.collabDir = collabDir;
exports.writeFragment = writeFragment;
exports.listFragments = listFragments;
exports.staleFragments = staleFragments;
exports.sweepStaleFragments = sweepStaleFragments;
exports.mergeFragments = mergeFragments;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const paths_1 = require("./paths");
const anchors_1 = require("./anchors");
/**
 * Validate that `segment` is a safe single path component: rejects absolute
 * paths, `..`, and any value containing a path separator (`/` or `\`). Throws a
 * typed {@link PathContainmentError} (a security-relevant containment violation)
 * so the CLI boundary maps it to a structured `--json` failure with a stable
 * `path_containment` code instead of letting a raw Node stack escape (ARCH-003) —
 * while still preventing the path traversal it always did.
 */
function validatePathSegment(segment, label) {
    if (path.isAbsolute(segment)) {
        throw new paths_1.PathContainmentError(`collab: ${label} must not be an absolute path: "${segment}"`, segment);
    }
    if (segment === ".." || segment.includes("/") || segment.includes("\\")) {
        throw new paths_1.PathContainmentError(`collab: ${label} must be a single path component with no separators or "..": "${segment}"`, segment);
    }
}
/**
 * Thrown by {@link writeFragment} when a fragment of the same name already exists
 * and `force` is not set. A DISTINCT type so the command layer can convert only a
 * collision into a structured failure while letting path-validation errors (a
 * different, security-relevant failure mode) keep propagating as throws.
 */
class FragmentExistsError extends Error {
    file;
    constructor(file) {
        super(`collab: fragment already exists: ${file}. Pass --force to overwrite it.`);
        this.file = file;
        this.name = "FragmentExistsError";
    }
}
exports.FragmentExistsError = FragmentExistsError;
/**
 * Build the absolute collab directory for a stage (and optional round) under
 * `paths.stateDir`. Path construction only — never creates anything (dirs are
 * created on write).
 */
function collabDir(paths, stage, round) {
    validatePathSegment(stage, "stage");
    if (round !== undefined)
        validatePathSegment(round, "round");
    const base = path.join(paths.stateDir, "collab", stage);
    return round === undefined ? base : path.join(base, round);
}
/**
 * Write a fragment file under `<stateDir>/collab/<stage>/<round>/<name>`,
 * creating the round directory tree on demand. Returns the absolute path written.
 *
 * Collision guard: refuses to overwrite an existing fragment of the same name
 * unless `input.force` is set, so two parallel agents dropping the same name into
 * a round cannot silently clobber each other. Throws a descriptive `Error` on a
 * collision (the command layer converts it to a structured failure).
 */
function writeFragment(paths, input) {
    validatePathSegment(input.name, "name");
    const dir = collabDir(paths, input.stage, input.round);
    const file = path.join(dir, input.name);
    fs.mkdirSync(dir, { recursive: true });
    // R-16: ATOMIC create-or-fail. The old `existsSync`-then-`writeFileSync` guard was
    // a check-then-write TOCTOU — two parallel writers could both see `!existsSync` and
    // both write, the second silently clobbering with NO FragmentExistsError. The `wx`
    // open flag (write, fail if the path exists) lets the OS arbitrate the race: exactly
    // one create wins, the loser gets EEXIST → FragmentExistsError. `--force` keeps the
    // overwrite semantics via the plain `w` flag.
    try {
        fs.writeFileSync(file, input.content, { encoding: "utf8", flag: input.force ? "w" : "wx" });
    }
    catch (e) {
        if (e.code === "EEXIST")
            throw new FragmentExistsError(file);
        throw e;
    }
    return file;
}
/**
 * List fragment descriptors for a stage, optionally scoped to a single round.
 * Returned in deterministic (round, then name) sorted order. A missing collab
 * tree yields an empty list — listing never creates anything.
 */
function listFragments(paths, stage, round) {
    const out = [];
    const readRound = (r) => {
        const dir = collabDir(paths, stage, r);
        if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory())
            return;
        const names = fs
            .readdirSync(dir, { withFileTypes: true })
            .filter((e) => e.isFile())
            .map((e) => e.name)
            .sort();
        for (const name of names) {
            out.push({ stage, round: r, name, path: path.join(dir, name) });
        }
    };
    if (round !== undefined) {
        readRound(round);
        return out;
    }
    const stageDir = collabDir(paths, stage);
    if (!fs.existsSync(stageDir) || !fs.statSync(stageDir).isDirectory())
        return out;
    const rounds = fs
        .readdirSync(stageDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
    for (const r of rounds)
        readRound(r);
    return out;
}
/* ------------------------------------------------------------------ *
 * Fragment GC / TTL stale-recovery (Phase 5 / P5-3).                   *
 *                                                                      *
 * Blackboard fragments are dropped by parallel writers and consumed by *
 * a Reconciler. A writer that crashed (or a round abandoned after a     *
 * re-plan) leaves orphaned fragments on disk that no Reconciler will     *
 * ever merge — clutter that can also confuse a later merge of the same  *
 * round. This is the fragment analogue of the section-lease dead-holder *
 * bug. The recovery is a TTL sweep keyed on each fragment file's mtime: *
 * a fragment untouched for longer than the TTL is considered stale and  *
 * recoverable. {@link staleFragments} is a pure predicate (lists them); *
 * {@link sweepStaleFragments} performs the GC (deletes them and reports  *
 * what it removed). The caller decides WHEN to sweep — listing never     *
 * deletes anything.                                                     *
 * ------------------------------------------------------------------ */
/** Default fragment TTL: 24 hours in ms. A fragment untouched longer than this is stale. */
exports.FRAGMENT_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * List the STALE fragments for a stage (optionally one round): every fragment whose
 * file mtime is older than `ttlMs` relative to `now`. Pure — it reads the tree and
 * decides nothing; it never deletes. Mirrors {@link staleSectionLeases} on the
 * lease side. Clock-injectable for deterministic tests.
 */
function staleFragments(paths, stage, round, ttlMs = exports.FRAGMENT_TTL_MS, now = () => new Date()) {
    const cutoff = now().getTime() - ttlMs;
    const out = [];
    for (const f of listFragments(paths, stage, round)) {
        let mtimeMs;
        try {
            mtimeMs = fs.statSync(f.path).mtimeMs;
        }
        catch {
            continue; // raced deletion — skip
        }
        if (mtimeMs < cutoff)
            out.push({ ...f, mtimeMs });
    }
    return out;
}
/**
 * GC the stale fragments for a stage (optionally one round): delete every fragment
 * older than `ttlMs` and return the {@link StaleFragment} descriptors that were
 * removed. Idempotent (a second sweep finds none) and bounded to the collab tree
 * (it only ever touches files {@link listFragments} returned). Clock-injectable.
 */
function sweepStaleFragments(paths, stage, round, ttlMs = exports.FRAGMENT_TTL_MS, now = () => new Date()) {
    const stale = staleFragments(paths, stage, round, ttlMs, now);
    for (const f of stale) {
        try {
            fs.rmSync(f.path);
        }
        catch {
            // Best-effort GC: a fragment already gone (raced) is fine.
        }
    }
    return stale;
}
/**
 * Reconcile a round: concatenate every fragment in deterministic (sorted-by-name)
 * order. Before concatenating it validates that EVERY fragment carries at least
 * one REQ-ID anchor (reusing {@link extractReqIds}); when any are missing it
 * returns `ok:false` with the offending fragment names and an empty merge.
 *
 * Each fragment is separated by a blank line and the merged blob ends with a
 * trailing newline, so the output is stable: re-running the merge on unchanged
 * inputs yields byte-identical output (idempotent).
 */
function mergeFragments(paths, stage, round) {
    const fragments = listFragments(paths, stage, round);
    const unanchored = [];
    for (const f of fragments) {
        const content = fs.readFileSync(f.path, "utf8");
        if ((0, anchors_1.extractReqIds)(content).length === 0)
            unanchored.push(f.name);
    }
    if (unanchored.length > 0) {
        return { ok: false, merged: "", fragments, unanchored };
    }
    const parts = fragments.map((f) => {
        const content = fs.readFileSync(f.path, "utf8");
        return content.endsWith("\n") ? content : `${content}\n`;
    });
    const merged = parts.join("\n");
    return { ok: true, merged, fragments, unanchored: [] };
}
