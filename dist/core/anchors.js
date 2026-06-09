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
 * Recursively scan `dir` for REQ-ID anchors and return a map of
 * `REQ-ID → list of root-relative (forward-slash) file paths` where it appears.
 *
 * - `extPredicate` optionally restricts which files are read (by file name); when
 *   omitted every regular file is scanned.
 * - `node_modules`, `dist`, and `.git` are always skipped.
 * - File paths are relative to `dir` and use forward slashes for cross-platform
 *   stable output. A missing/non-directory `dir` yields an empty map.
 */
function scanDirForReqIds(dir, extPredicate) {
    const out = new Map();
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory())
        return out;
    const walk = (abs) => {
        for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                if (SCAN_SKIP_DIRS.has(entry.name))
                    continue;
                walk(path.join(abs, entry.name));
            }
            else if (entry.isFile()) {
                if (extPredicate && !extPredicate(entry.name))
                    continue;
                const filePath = path.join(abs, entry.name);
                const rel = path.relative(dir, filePath).split(path.sep).join("/");
                const content = fs.readFileSync(filePath, "utf8");
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
    return out;
}
