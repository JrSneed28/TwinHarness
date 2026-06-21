/**
 * SG3 P1-B (C-11) — the DURABLE delegate allowed-files scope.
 *
 * `th delegate pack --allowed-files <list>` computes the explicit write scope a
 * delegated agent may touch, but the PreToolUse write-gate runs in a SEPARATE process
 * (the installed hook `node dist/cli.js hook pretool-gate`) and Claude Code's PreToolUse
 * stdin payload carries NO `allowed_files`. So a scope returned only in the pack's
 * result can never reach the gate — enforcement stays inactive (audit P1). This module
 * is the missing seam: the CLI ARMS the scope here on `th delegate pack`, the gate READS
 * it from here on every write, and it is CLEARED when the delegated subagent stops.
 *
 * Lifecycle (single active delegation at a time):
 *   - `th delegate pack --allowed-files a,b`  → arms the scope (writes the file).
 *   - `th delegate pack` (no scope)           → disarms (removes the file).
 *   - SubagentStop hook                       → disarms (the delegate finished).
 * The latest pack defines the active scope. KNOWN LIMITATION: parallel delegations share
 * one scope file, so the last pack wins and the first subagent-stop lifts it — fail-OPEN
 * for the still-running peers (never a false block), and the orchestrator should arm the
 * scope immediately before spawning the delegate to keep the window tight.
 *
 * The file lives under the state dir (`.twinharness/delegation-scope.json`), written
 * through the governed-write chokepoint. Reads are tolerant: an absent/empty/corrupt
 * file yields an empty scope (a no-op for the gate), never throws.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectPaths } from "./paths";
import { atomicWriteFile } from "./atomic-io";

/** `<stateDir>/delegation-scope.json` — the persisted delegate allowed-files scope. */
export function delegationScopePath(paths: ProjectPaths): string {
  return path.join(paths.stateDir, "delegation-scope.json");
}

/** The persisted scope shape. `allowedFiles` is the only gate-relevant field. */
export interface DelegationScope {
  /** Root-relative write scope (verbatim as `th delegate pack` emitted them). */
  allowedFiles: string[];
  /** When the scope was armed (provenance only). */
  packedAt?: string;
  /** The delegated agent (provenance only). */
  agent?: string;
  /** The slice the delegation is framed for (provenance only). */
  slice?: string;
}

/** Trim, drop empties, dedupe, preserve insertion order. */
function dedupeTrim(list: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of list) {
    const t = f.trim();
    if (t.length > 0 && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/**
 * Read the persisted scope. Absent / empty / unreadable / malformed ⇒
 * `{ allowedFiles: [] }` — a NO-OP for the gate (the gate only enforces a non-empty
 * set), so a damaged scope file never wedges every write. Never throws.
 */
export function readDelegationScope(paths: ProjectPaths): DelegationScope {
  const file = delegationScopePath(paths);
  if (!fs.existsSync(file)) return { allowedFiles: [] };
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { allowedFiles: [] };
  }
  if (raw.trim() === "") return { allowedFiles: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { allowedFiles: [] };
  }
  if (typeof parsed !== "object" || parsed === null) return { allowedFiles: [] };
  const p = parsed as Record<string, unknown>;
  const allowedFiles = Array.isArray(p.allowedFiles)
    ? dedupeTrim(p.allowedFiles.filter((x): x is string => typeof x === "string"))
    : [];
  return {
    allowedFiles,
    packedAt: typeof p.packedAt === "string" ? p.packedAt : undefined,
    agent: typeof p.agent === "string" ? p.agent : undefined,
    slice: typeof p.slice === "string" ? p.slice : undefined,
  };
}

/**
 * Arm the delegate scope when `allowedFiles` is non-empty (write the file through the
 * governed chokepoint); DISARM (remove the file) when it is empty — so a plain
 * `th delegate pack` with no scope lifts a previously-armed one. Returns the normalized
 * list that was persisted (empty ⇒ cleared).
 */
export function writeDelegationScope(
  paths: ProjectPaths,
  allowedFiles: readonly string[],
  meta: { agent?: string; slice?: string } = {},
): string[] {
  const list = dedupeTrim(allowedFiles);
  if (list.length === 0) {
    clearDelegationScope(paths);
    return [];
  }
  const scope: DelegationScope = {
    allowedFiles: list,
    packedAt: new Date().toISOString(),
    ...(meta.agent ? { agent: meta.agent } : {}),
    ...(meta.slice ? { slice: meta.slice } : {}),
  };
  atomicWriteFile(delegationScopePath(paths), JSON.stringify(scope, null, 2) + "\n", { root: paths.root });
  return list;
}

/** Best-effort disarm (the delegation ended). Never throws. */
export function clearDelegationScope(paths: ProjectPaths): void {
  try {
    fs.rmSync(delegationScopePath(paths), { force: true });
  } catch {
    /* best-effort — a missing/locked scope file must never break the hook. */
  }
}
