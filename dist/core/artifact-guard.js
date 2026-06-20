"use strict";
/**
 * Approved-artifact clobber guard (R-14 / DR-04 option (a)).
 *
 * Invariant: a human-edited / registered `docs/NN-*.md` artifact (one recorded in
 * `approved_artifacts` via `th artifact register`) must not be SILENTLY overwritten
 * when a stage agent re-runs. The artifact content-hash (`th artifact register` /
 * `th artifact stale`) detects drift AFTER the fact but does not PREVENT the
 * overwrite; `assertGovernedWriteSurface` governs WHERE a write may land, not
 * WHETHER to overwrite.
 *
 * This module is the single, narrow membership test both clobber-guard call sites
 * share: the PreToolUse write-gate (Claude `Write`/`Edit` tool writes — `docs/` is
 * otherwise whitelisted) and the direct CLI/MCP artifact writer `th repo map`. It is
 * keyed STRICTLY on `approved_artifacts` membership, so it changes NOTHING for
 * state.json / ledger / interview / verify / non-registered `docs/` writes — those
 * paths are never registered as artifacts. `atomicWriteFile` itself is left
 * untouched (it is the low-level primitive for many non-artifact writers).
 *
 * Directory artifacts (e.g. the T3 ADR set `docs/05-adrs/`) are registered as a
 * single entry whose `file` is the directory key; a write to any file UNDER that
 * directory is a write to the approved artifact, so the match treats a registered
 * directory key as a prefix.
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
exports.APPROVED_ARTIFACT_CLOBBER_CODE = void 0;
exports.matchApprovedArtifact = matchApprovedArtifact;
exports.isApprovedArtifactPath = isApprovedArtifactPath;
const path = __importStar(require("node:path"));
const paths_1 = require("./paths");
/** Stable machine token surfaced when a registered-artifact overwrite is refused. */
exports.APPROVED_ARTIFACT_CLOBBER_CODE = "approved_artifact_clobber";
/**
 * Normalize `target` (absolute, or relative to `root`) to the SAME root-relative
 * forward-slash key shape stored in `ApprovedArtifact.file` (the shape
 * `th artifact register` writes via its `toRelKey`). Returns null when the target
 * escapes the project root (an out-of-root write is not an artifact overwrite — the
 * surface guards reject it elsewhere). Mirrors `resolveWithinRoot` containment so a
 * symlink/junction can't dodge the key match.
 */
function toArtifactKey(root, target) {
    const contained = (0, paths_1.resolveWithinRoot)(root, target);
    if (contained === null)
        return null;
    const rel = path.relative(path.resolve(root), contained);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel))
        return null;
    return rel.split(path.sep).join("/");
}
/**
 * The registered artifact (if any) that `target` would overwrite, else null. A
 * write matches a registered entry when the target's root-relative key EQUALS the
 * entry's `file` (a file artifact) OR is nested UNDER it (a directory artifact such
 * as `docs/05-adrs/`). Pure: no filesystem access beyond the containment realpath
 * `resolveWithinRoot` already performs.
 *
 * `target` may be an absolute path (the hook gate's resolved abs target, the repo
 * writer's abs file) or a root-relative path; both normalize to the same key.
 */
function matchApprovedArtifact(approved, root, target) {
    if (approved.length === 0)
        return null;
    const key = toArtifactKey(root, target);
    if (key === null)
        return null;
    for (const a of approved) {
        if (a.file === key)
            return a; // exact file-artifact match
        // Directory-artifact match: the target is nested under a registered dir key.
        // Guard against a partial-segment false positive ("docs/05" vs "docs/05-adrs")
        // by requiring a separator boundary.
        if (key.startsWith(a.file.endsWith("/") ? a.file : `${a.file}/`))
            return a;
    }
    return null;
}
/**
 * Whether `target` would overwrite a path registered in `approved_artifacts` (the
 * R-14 clobber predicate). Thin boolean wrapper over {@link matchApprovedArtifact}
 * for call sites that only need the yes/no.
 */
function isApprovedArtifactPath(approved, root, target) {
    return matchApprovedArtifact(approved, root, target) !== null;
}
