import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

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

// ---------------------------------------------------------------------------
// Hash-chain shared constants (#14 dedup) — used by BOTH the decision ledger
// (core/decisions.ts) and the gate ledger (core/ledger.ts). Lifted here so the
// two chains share one definition instead of each declaring its own; both modules
// re-export `GENESIS_PREV_HASH` for back-compat with existing importers.
// ---------------------------------------------------------------------------

/**
 * `prevHash` of the FIRST sealed entry in a SHA-256 hash chain — 64 hex zeros (the
 * migration anchor; DS-001 for decisions, the first-seal anchor for the ledger).
 */
export const GENESIS_PREV_HASH = "0".repeat(64);

/** A 64-char lowercase-hex string — the shape of every `recordHash` / `prevHash`. */
export const HEX64 = /^[0-9a-f]{64}$/;

/** Directory names never descended into when hashing a directory artifact. */
const HASH_SKIP_DIRS = new Set([".git", "node_modules", "dist"]);

/**
 * Guardrails so a misdirected `th artifact register <huge-dir>` (e.g. a path that
 * sidesteps the skip-list, or a vendored tree) fails fast with a clear message
 * instead of walking millions of files / reading gigabytes into memory and
 * hanging the CLI. An *artifact* is a governed document set, never a build/vendor
 * tree, so these ceilings are far above any legitimate artifact directory.
 */
export const MAX_HASH_FILES = 5_000;
export const MAX_HASH_TOTAL_BYTES = 50 * 1024 * 1024; // 50 MB
export const MAX_HASH_FILE_BYTES = 10 * 1024 * 1024; // 10 MB per file

export interface HashLimits {
  maxFiles: number;
  maxTotalBytes: number;
  maxFileBytes: number;
}

/** Default guardrails; injectable so the caps are testable without huge fixtures. */
export const DEFAULT_HASH_LIMITS: HashLimits = {
  maxFiles: MAX_HASH_FILES,
  maxTotalBytes: MAX_HASH_TOTAL_BYTES,
  maxFileBytes: MAX_HASH_FILE_BYTES,
};

/** Thrown by {@link hashDir} when a directory exceeds a hashing guardrail. */
export class HashLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HashLimitError";
  }
}

/**
 * Deterministic hash of a DIRECTORY's contents (the ADR artifact `docs/05-adrs/`
 * is a directory of `ADR-NNN-*.md` files — spec §15.S; stage contract
 * `produces: docs/05-adrs/`). Walks every file, builds a manifest of
 * `relpath\0filehash` lines, sorts it (order-independent), and hashes the join.
 * Clock-free and order-stable: the same tree always yields the same digest,
 * regardless of readdir order or platform. Bounded by the MAX_HASH_* guardrails
 * (throws {@link HashLimitError} on exceed).
 */
export function hashDir(absDir: string, limits: HashLimits = DEFAULT_HASH_LIMITS): string {
  const entries: string[] = [];
  let fileCount = 0;
  let totalBytes = 0;
  const walk = (abs: string): void => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (HASH_SKIP_DIRS.has(e.name)) continue;
        walk(path.join(abs, e.name));
      } else if (e.isFile()) {
        const p = path.join(abs, e.name);
        if (++fileCount > limits.maxFiles) {
          throw new HashLimitError(
            `directory has more than ${limits.maxFiles} files — too large to hash as one artifact; register a narrower path`,
          );
        }
        const rel = path.relative(absDir, p).split(path.sep).join("/");
        const size = fs.statSync(p).size;
        if (size > limits.maxFileBytes) {
          throw new HashLimitError(
            `file "${rel}" exceeds ${limits.maxFileBytes} bytes — artifacts are governed documents, not binaries; register a narrower path`,
          );
        }
        totalBytes += size;
        if (totalBytes > limits.maxTotalBytes) {
          throw new HashLimitError(
            `directory exceeds ${limits.maxTotalBytes} bytes total — too large to hash as one artifact; register a narrower path`,
          );
        }
        entries.push(`${rel}\0${hashContent(fs.readFileSync(p, "utf8"))}`);
      }
    }
  };
  walk(absDir);
  entries.sort();
  return hashContent(entries.join("\n"));
}

/**
 * P2-4 (#6) — content hash of a SINGLE file from its RAW bytes, with NO utf8
 * decode and NO CRLF normalization.
 *
 * The freshness layer (`repo-map.json fileHashes` store path + `th repo check`
 * re-scan path) previously did `hashContent(fs.readFileSync(abs, "utf8"))`. For
 * BINARY files that round-trip is LOSSY: invalid byte sequences collapse to the
 * replacement char U+FFFD and CR bytes are stripped, so two DISTINCT binaries can
 * hash IDENTICALLY — a real edit then reads as `fresh` (silently missed
 * staleness). Hashing the raw `Buffer` removes both lossy steps so every distinct
 * byte sequence has a distinct digest.
 *
 * This is the BUFFER side of the all-or-nothing fix (P2-4 / rev 2 B3): it MUST be
 * used by BOTH the store path (`repo.ts` fileHashes) and the re-check path
 * (`runRepoCheck`) together. Using it on only one side would flip every binary to
 * permanently-`modified`. For TEXT content the two paths still agree because the
 * stored hash and the re-check hash are produced by the SAME function here.
 *
 * NOTE: this is intentionally NOT CRLF-normalized — it is byte-exact. The
 * markdown/JSON artifact hashing (`hashContent`) stays CRLF-normalized; only the
 * per-file freshness hashes move to byte-exact via this function.
 */
export function hashFileBytes(abs: string): string {
  return createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
}

/** Full hash of a path that may be a file OR a directory (artifact registration §12/§18). */
export function hashPathContent(abs: string): string {
  return fs.statSync(abs).isDirectory() ? hashDir(abs) : hashFileBytes(abs);
}

/** Short 12-hex form of {@link hashPathContent} — used for both file and directory artifacts. */
export function shortHashPath(abs: string): string {
  return hashPathContent(abs).slice(0, 12);
}
