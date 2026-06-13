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

/** Directory names never descended into when hashing a directory artifact. */
const HASH_SKIP_DIRS = new Set([".git", "node_modules", "dist"]);

/**
 * Deterministic hash of a DIRECTORY's contents (the ADR artifact `docs/05-adrs/`
 * is a directory of `ADR-NNN-*.md` files — spec §15.S; stage contract
 * `produces: docs/05-adrs/`). Walks every file, builds a manifest of
 * `relpath\0filehash` lines, sorts it (order-independent), and hashes the join.
 * Clock-free and order-stable: the same tree always yields the same digest,
 * regardless of readdir order or platform.
 */
export function hashDir(absDir: string): string {
  const entries: string[] = [];
  const walk = (abs: string): void => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (HASH_SKIP_DIRS.has(e.name)) continue;
        walk(path.join(abs, e.name));
      } else if (e.isFile()) {
        const p = path.join(abs, e.name);
        const rel = path.relative(absDir, p).split(path.sep).join("/");
        entries.push(`${rel}\0${hashContent(fs.readFileSync(p, "utf8"))}`);
      }
    }
  };
  walk(absDir);
  entries.sort();
  return hashContent(entries.join("\n"));
}

/** Full hash of a path that may be a file OR a directory (artifact registration §12/§18). */
export function hashPathContent(abs: string): string {
  return fs.statSync(abs).isDirectory() ? hashDir(abs) : hashContent(fs.readFileSync(abs, "utf8"));
}

/** Short 12-hex form of {@link hashPathContent} — used for both file and directory artifacts. */
export function shortHashPath(abs: string): string {
  return hashPathContent(abs).slice(0, 12);
}
