import { createHash } from "node:crypto";

/**
 * Deterministic content hash (plan §12: "each artifact is versioned with a content
 * hash"; Principle 1/4: hashing must be testable and clock-free).
 *
 * Line endings are normalized (CRLF -> LF) so the same logical content hashes
 * identically on Windows and POSIX. No clock, no randomness — same input always
 * yields the same digest.
 */
export function hashContent(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n");
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

/** Short 12-hex-char form used in `state.json` / `drift-log.md` references (§18). */
export function shortHash(content: string): string {
  return hashContent(content).slice(0, 12);
}
