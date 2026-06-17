"use strict";
/**
 * REQ-ID anchor extraction (spec §11 tests-as-contract; §15.8/§15.9 traceability:
 * "every MVP REQ-ID maps to ≥1 slice and ≥1 test"). REQ-IDs are the anchors that
 * tie requirements, slice/task IDs, and TEST names together (spec §17).
 *
 * `extractReqIds`/`REQ_ID_PATTERN` are pure (no IO). `scanDirForReqIds` is the
 * Slice-5 file-tree scanner that feeds traceability/orphan detection (§17): it
 * walks a directory and maps each REQ-ID anchor to the files where it appears.
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
exports.REQ_ID_PATTERN = void 0;
exports.extractReqIds = extractReqIds;
exports.scanDirForReqIds = scanDirForReqIds;
exports.scanDirForReqIdsCapped = scanDirForReqIdsCapped;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
/**
 * Canonical REQ-ID anchor pattern source (exported so the Slice-5 scanner can
 * reuse the exact same shape). Matches `REQ-001`, `REQ-NFR-001`, `REQ-HASH-001`:
 * a `REQ-` prefix followed by one or more `-`-separated uppercase-alnum segments.
 */
exports.REQ_ID_PATTERN = "REQ-[A-Z0-9]+(?:-[A-Z0-9]+)*";
/**
 * Find every REQ-ID anchor in a blob of text and return the UNIQUE set in
 * first-seen (stable) order.
 */
function extractReqIds(text) {
    const re = new RegExp(exports.REQ_ID_PATTERN, "g");
    const seen = new Set();
    const out = [];
    for (const m of text.matchAll(re)) {
        const id = m[0];
        if (!seen.has(id)) {
            seen.add(id);
            out.push(id);
        }
    }
    return out;
}
/** Directory names never descended into when scanning a tree for anchors. */
const SCAN_SKIP_DIRS = new Set([".git", "node_modules", "dist"]);
/**
 * BOUNDED-COST caps for the anchor walk (PERF-001). Without a per-file byte cap,
 * `scanDirForReqIds` would `readFileSync` an arbitrarily large file fully into
 * memory — a single 30 MB source file that passes the name filter defeats the
 * advertised bounded-cost guarantee. These defaults mirror the repo-map scanner's
 * caps so the two walks stay consistent; the scanner overrides them with its OWN
 * exported constants (`MAX_READ_BYTES` / `FILE_COUNT_CAP` / `TOTAL_BYTES_CAP`) at
 * the call site, which is the single source of truth (REQ-NFR-007). The Phase-3
 * single-walk unification (P3-1) deletes this standalone cap; until then this
 * keeps the standalone walk bounded.
 */
const DEFAULT_MAX_READ_BYTES = 2 * 1024 * 1024; // 2 MB — oversize files are skipped, not read.
const DEFAULT_FILE_COUNT_CAP = 25_000;
const DEFAULT_TOTAL_BYTES_CAP = 64 * 1024 * 1024; // 64 MB.
/**
 * Recursively scan `dir` for REQ-ID anchors and return a map of
 * `REQ-ID → list of root-relative (forward-slash) file paths` where it appears.
 *
 * - `extPredicate` optionally restricts which files are read (by file name); when
 *   omitted every regular file is scanned.
 * - `node_modules`, `dist`, and `.git` are always skipped.
 * - File paths are relative to `dir` and use forward slashes for cross-platform
 *   stable output. A missing/non-directory `dir` yields an empty map.
 * - BOUNDED COST (PERF-001): a file larger than the per-file byte cap is NEVER
 *   read (it is skipped without `readFileSync`); the walk also stops once the
 *   file-count or total-bytes cap is reached, yielding a PARTIAL map. This keeps
 *   the cost bounded even on a repo containing a giant file.
 *
 * The legacy positional `extPredicate` second argument is still accepted for
 * backward compatibility; new callers pass a {@link ScanDirOptions} object.
 */
function scanDirForReqIds(dir, optsOrPredicate) {
    return scanDirForReqIdsCapped(dir, optsOrPredicate).anchors;
}
/**
 * Capped variant of {@link scanDirForReqIds} that also returns the bytes/files
 * actually read and a `capHit` partial signal. The repo-map scanner uses this so
 * the standalone anchor walk's byte cost is bounded by — and folded into — the
 * scanner's BOUNDED-COST budget (PERF-001 / REQ-NFR-007).
 */
function scanDirForReqIdsCapped(dir, optsOrPredicate) {
    const opts = typeof optsOrPredicate === "function" ? { extPredicate: optsOrPredicate } : optsOrPredicate ?? {};
    const extPredicate = opts.extPredicate;
    const maxReadBytes = opts.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
    const fileCountCap = opts.fileCountCap ?? DEFAULT_FILE_COUNT_CAP;
    const totalBytesCap = opts.totalBytesCap ?? DEFAULT_TOTAL_BYTES_CAP;
    const skipDirs = opts.skipDirs ?? SCAN_SKIP_DIRS;
    const out = new Map();
    const result = { anchors: out, bytesRead: 0, filesRead: 0, capHit: null };
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory())
        return result;
    const walk = (abs) => {
        if (result.capHit)
            return;
        let entries;
        try {
            entries = fs.readdirSync(abs, { withFileTypes: true });
        }
        catch {
            return; // unreadable dir — skip, do not crash.
        }
        for (const entry of entries) {
            if (result.capHit)
                return;
            if (entry.isDirectory()) {
                if (skipDirs.has(entry.name))
                    continue;
                walk(path.join(abs, entry.name));
            }
            else if (entry.isFile()) {
                if (extPredicate && !extPredicate(entry.name))
                    continue;
                const filePath = path.join(abs, entry.name);
                // BOUNDED COST: stat first — a file larger than the per-file cap is NEVER
                // read (no readFileSync), so a 30 MB file costs one stat, not 30 MB of IO.
                let size;
                try {
                    size = fs.statSync(filePath).size;
                }
                catch {
                    continue; // unreadable stat — skip.
                }
                if (size > maxReadBytes)
                    continue; // oversize → skip, do not read.
                // File-count cap → partial (a cap is not an error).
                if (result.filesRead >= fileCountCap) {
                    result.capHit = "file-count";
                    return;
                }
                // Total-bytes cap → partial.
                if (result.bytesRead + size > totalBytesCap) {
                    result.capHit = "total-bytes";
                    return;
                }
                let content;
                try {
                    content = fs.readFileSync(filePath, "utf8");
                }
                catch {
                    continue; // unreadable read — skip (do not count).
                }
                result.bytesRead += size;
                result.filesRead++;
                const rel = path.relative(dir, filePath).split(path.sep).join("/");
                for (const id of extractReqIds(content)) {
                    const files = out.get(id);
                    if (files) {
                        if (!files.includes(rel))
                            files.push(rel);
                    }
                    else {
                        out.set(id, [rel]);
                    }
                }
            }
        }
    };
    walk(dir);
    return result;
}
