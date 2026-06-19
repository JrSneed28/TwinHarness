"use strict";
/**
 * `repo-map/lcov.ts` — PURE, CONTAINED ingestion of an lcov coverage report
 * (P2-6b). The lcov file is UNTRUSTED repo content (RULE-004): it is never
 * executed, and every path it names is resolved through the SAME repo-containment
 * check the scanner uses. A path that escapes the repo root (`..`, absolute, or a
 * Windows drive) is REJECTED — lcov can never grant a coverage edge to an
 * out-of-repo path, and there is NO symlink traversal (we resolve textually, never
 * touch the filesystem here).
 *
 * lcov format (the bits we use):
 *   SF:<source-file-path>   — start of a record for one source file
 *   end_of_record           — end of that record
 * We extract only the SF: source paths, contain them, and POSIX-normalize them so a
 * caller can intersect them with the in-repo file set.
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
exports.containLcovPath = containLcovPath;
exports.parseLcovContained = parseLcovContained;
const path = __importStar(require("node:path"));
/**
 * Resolve an lcov-declared path to a repo-relative POSIX path, or null if it
 * escapes the repo root. `lcovDir` is the POSIX-relative directory of the lcov file
 * itself (so a relative SF path is resolved against it, matching how coverage tools
 * emit paths relative to the report). Absolute paths are accepted ONLY when they
 * fall under `absRoot`. This mirrors the scanner's containment guarantee
 * (REQ-RU-092 / REQ-NFR-003): no path escapes root, no symlink traversal.
 */
function containLcovPath(absRoot, lcovDirRel, sfPath) {
    if (sfPath.length === 0)
        return null;
    const norm = sfPath.replace(/\\/g, "/");
    // Absolute (POSIX or Windows drive) — accept only if under absRoot.
    const isAbsolute = norm.startsWith("/") || /^[A-Za-z]:\//.test(norm);
    let abs;
    if (isAbsolute) {
        abs = path.resolve(norm);
    }
    else {
        abs = path.resolve(absRoot, lcovDirRel, norm);
    }
    const rel = path.relative(absRoot, abs).split(path.sep).join("/");
    // Reject anything that climbs out of the repo root.
    if (rel === "" || rel.startsWith("../") || rel === ".." || path.isAbsolute(rel)) {
        return null;
    }
    return rel;
}
/**
 * Parse lcov text into the SET of CONTAINED, in-repo source paths it covers. Paths
 * that escape the root are dropped (never returned). `knownFiles`, when provided,
 * further restricts the result to files the scanner actually saw (so a stale lcov
 * entry for a deleted file does not introduce a phantom path). Returns POSIX-relative
 * paths.
 */
function parseLcovContained(lcovText, absRoot, lcovDirRel, knownFiles) {
    const out = new Set();
    for (const line of lcovText.split(/\r?\n/)) {
        const m = /^SF:(.*)$/.exec(line.trim());
        if (!m)
            continue;
        const contained = containLcovPath(absRoot, lcovDirRel, m[1].trim());
        if (contained === null)
            continue; // escaping path — never grant an edge
        if (knownFiles && !knownFiles.has(contained))
            continue;
        out.add(contained);
    }
    return [...out];
}
