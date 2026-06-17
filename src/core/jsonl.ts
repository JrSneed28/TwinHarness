/**
 * Tolerant JSONL primitives (#11 dedup) — the append-only-log read patterns shared
 * by the decision ledger (`core/decisions.ts`), the gate ledger (`core/ledger.ts`),
 * and the local telemetry log (`core/telemetry.ts`).
 *
 * All three logs are append-only and TOLERANT: a torn last write, a malformed
 * line, or a legacy/unsealed line must be SKIPPED, never crash a read. Each module
 * previously inlined its own copy of (a) a tolerant full forward read and/or (b) a
 * tolerant tail scan for the last valid line. They are unified here.
 *
 * SCOPE: bound to those three modules deliberately. The tolerant-read shape appears
 * in ~18 files across the codebase; chasing all of them is a separate follow-up and
 * is explicitly NOT done here (finding #11). Pure, dependency-light, never throws.
 */

import * as fs from "node:fs";

/** Tolerant JSON parse: the parsed value, or `undefined` on any parse error. */
export function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Tolerant FULL forward read of a JSONL file: every line that parses AND satisfies
 * `isValid`, in file order. Missing file → `[]`. Malformed / partial-tail /
 * schema-invalid lines are silently skipped (append-only, tolerant). Never throws.
 */
export function readJsonlValues<T>(file: string, isValid: (parsed: unknown) => parsed is T): T[] {
  if (!fs.existsSync(file)) return [];
  const out: T[] = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = safeParseJson(trimmed);
    if (parsed !== undefined && isValid(parsed)) out.push(parsed);
  }
  return out;
}

/**
 * Tolerant TAIL scan of a JSONL file: walks lines from the END and returns the LAST
 * line that parses AND satisfies `isValid`, or `undefined` if none (or the file is
 * missing). Reads the file once but only parses the tail down to the last valid
 * line, so N appends that each do a tail read stay O(N) total. Tolerant: a
 * malformed / partial-tail / non-matching line is skipped while scanning upward.
 * Never throws.
 */
export function scanTailValid<T>(file: string, isValid: (parsed: unknown) => parsed is T): T | undefined {
  if (!fs.existsSync(file)) return undefined;
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i]!.trim();
    if (!trimmed) continue;
    const parsed = safeParseJson(trimmed);
    if (parsed !== undefined && isValid(parsed)) return parsed;
  }
  return undefined;
}
