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
exports.HashLimitError = exports.DEFAULT_HASH_LIMITS = exports.MAX_HASH_FILE_BYTES = exports.MAX_HASH_TOTAL_BYTES = exports.MAX_HASH_FILES = void 0;
exports.hashContent = hashContent;
exports.shortHash = shortHash;
exports.hashDir = hashDir;
exports.hashPathContent = hashPathContent;
exports.shortHashPath = shortHashPath;
const node_crypto_1 = require("node:crypto");
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
/**
 * Deterministic content hash (plan §12: "each artifact is versioned with a content
 * hash"; Principle 1/4: hashing must be testable and clock-free).
 *
 * Line endings are normalized (CRLF -> LF) so the same logical content hashes
 * identically on Windows and POSIX. No clock, no randomness — same input always
 * yields the same digest.
 */
function hashContent(content) {
    const normalized = content.replace(/\r\n/g, "\n");
    return (0, node_crypto_1.createHash)("sha256").update(normalized, "utf8").digest("hex");
}
/** Short 12-hex-char form used in `state.json` / `drift-log.md` references (§18). */
function shortHash(content) {
    return hashContent(content).slice(0, 12);
}
/** Directory names never descended into when hashing a directory artifact. */
const HASH_SKIP_DIRS = new Set([".git", "node_modules", "dist"]);
/**
 * Guardrails so a misdirected `th artifact register <huge-dir>` (e.g. a path that
 * sidesteps the skip-list, or a vendored tree) fails fast with a clear message
 * instead of walking millions of files / reading gigabytes into memory and
 * hanging the CLI. An *artifact* is a governed document set, never a build/vendor
 * tree, so these ceilings are far above any legitimate artifact directory.
 */
exports.MAX_HASH_FILES = 5_000;
exports.MAX_HASH_TOTAL_BYTES = 50 * 1024 * 1024; // 50 MB
exports.MAX_HASH_FILE_BYTES = 10 * 1024 * 1024; // 10 MB per file
/** Default guardrails; injectable so the caps are testable without huge fixtures. */
exports.DEFAULT_HASH_LIMITS = {
    maxFiles: exports.MAX_HASH_FILES,
    maxTotalBytes: exports.MAX_HASH_TOTAL_BYTES,
    maxFileBytes: exports.MAX_HASH_FILE_BYTES,
};
/** Thrown by {@link hashDir} when a directory exceeds a hashing guardrail. */
class HashLimitError extends Error {
    constructor(message) {
        super(message);
        this.name = "HashLimitError";
    }
}
exports.HashLimitError = HashLimitError;
/**
 * Deterministic hash of a DIRECTORY's contents (the ADR artifact `docs/05-adrs/`
 * is a directory of `ADR-NNN-*.md` files — spec §15.S; stage contract
 * `produces: docs/05-adrs/`). Walks every file, builds a manifest of
 * `relpath\0filehash` lines, sorts it (order-independent), and hashes the join.
 * Clock-free and order-stable: the same tree always yields the same digest,
 * regardless of readdir order or platform. Bounded by the MAX_HASH_* guardrails
 * (throws {@link HashLimitError} on exceed).
 */
function hashDir(absDir, limits = exports.DEFAULT_HASH_LIMITS) {
    const entries = [];
    let fileCount = 0;
    let totalBytes = 0;
    const walk = (abs) => {
        for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
            if (e.isDirectory()) {
                if (HASH_SKIP_DIRS.has(e.name))
                    continue;
                walk(path.join(abs, e.name));
            }
            else if (e.isFile()) {
                const p = path.join(abs, e.name);
                if (++fileCount > limits.maxFiles) {
                    throw new HashLimitError(`directory has more than ${limits.maxFiles} files — too large to hash as one artifact; register a narrower path`);
                }
                const rel = path.relative(absDir, p).split(path.sep).join("/");
                const size = fs.statSync(p).size;
                if (size > limits.maxFileBytes) {
                    throw new HashLimitError(`file "${rel}" exceeds ${limits.maxFileBytes} bytes — artifacts are governed documents, not binaries; register a narrower path`);
                }
                totalBytes += size;
                if (totalBytes > limits.maxTotalBytes) {
                    throw new HashLimitError(`directory exceeds ${limits.maxTotalBytes} bytes total — too large to hash as one artifact; register a narrower path`);
                }
                entries.push(`${rel}\0${hashContent(fs.readFileSync(p, "utf8"))}`);
            }
        }
    };
    walk(absDir);
    entries.sort();
    return hashContent(entries.join("\n"));
}
/** Full hash of a path that may be a file OR a directory (artifact registration §12/§18). */
function hashPathContent(abs) {
    return fs.statSync(abs).isDirectory() ? hashDir(abs) : hashContent(fs.readFileSync(abs, "utf8"));
}
/** Short 12-hex form of {@link hashPathContent} — used for both file and directory artifacts. */
function shortHashPath(abs) {
    return hashPathContent(abs).slice(0, 12);
}
