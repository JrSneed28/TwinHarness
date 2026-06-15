/**
 * Append-only gate-mutation ledger (audit finding F5).
 *
 * The mechanical gates (Stop-gate, write-gate) only bind a *compliant* agent:
 * the orchestrator legitimately sets `implementation_allowed`, the blast-radius
 * `tier`, and resolves blocking drift via the same `th` CLI. The CLI cannot tell
 * *who* invoked it (the agent runs every `th` command), so this ledger does NOT
 * claim provenance — it provides a timestamped, append-only RECORD of every
 * gate-relevant state change so a human reviewing afterwards can see exactly
 * when `implementation_allowed` flipped, when blocking drift opened/closed, etc.
 *
 * It is observability, not enforcement: it never blocks a mutation. Writes are
 * best-effort and must never crash a command. The ledger lives next to the state
 * it audits (`<stateDir>/gate-ledger.jsonl`), one JSON object per line.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectPaths } from "./paths";

/** Top-level state keys whose mutation is gate-relevant and therefore audited. */
export const GATE_LEDGER_KEYS = new Set<string>([
  "implementation_allowed",
  "drift_open_blocking",
  "debate_open_blocking",
  "write_gate",
  "tier",
  "blast_radius_flags",
]);

export interface LedgerEntry {
  /** ISO-8601 UTC timestamp (audit record — intentionally clock-bearing). */
  ts: string;
  /** Event kind, e.g. "gate-state-change", "drift-blocking-opened". */
  event: string;
  [key: string]: unknown;
}

/** `<stateDir>/gate-ledger.jsonl` — the audit record's location. */
export function ledgerPath(paths: ProjectPaths): string {
  return path.join(paths.stateDir, "gate-ledger.jsonl");
}

/**
 * Append one entry to the gate ledger. Best-effort: a ledger failure must never
 * crash the command that triggered it (mirrors `structuredLog`).
 */
export function appendLedger(paths: ProjectPaths, entry: Omit<LedgerEntry, "ts">): void {
  try {
    fs.mkdirSync(paths.stateDir, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
    fs.appendFileSync(ledgerPath(paths), line, "utf8");
  } catch {
    // Never throw from the audit path.
  }
}

/** Read + parse every ledger entry. Missing file → empty. Bad lines skipped. */
export function readLedger(paths: ProjectPaths): LedgerEntry[] {
  const file = ledgerPath(paths);
  if (!fs.existsSync(file)) return [];
  const out: LedgerEntry[] = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (typeof parsed === "object" && parsed !== null) out.push(parsed as LedgerEntry);
    } catch {
      // Skip malformed lines; the ledger is append-only and tolerant.
    }
  }
  return out;
}
