"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.hashContent = hashContent;
exports.shortHash = shortHash;
const node_crypto_1 = require("node:crypto");
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
