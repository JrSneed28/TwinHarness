/**
 * Command result + rendering. Command functions are pure and return a
 * `CommandResult`; the CLI dispatcher (cli.ts) prints and sets the exit code.
 * This keeps all command logic unit-testable without spawning a process.
 *
 * Every command supports `--json` (plan §3: "Every command ... has `--json`").
 */

/**
 * SG3 P1-B — a content-read RECEIPT: a verifiable record that a governed reader
 * (`th repo search`, `th artifact section`, `th context read`) actually read the
 * bytes it cites. `file` is the root-relative POSIX path; `hash` is the SHA-256 of
 * the content the reader saw (full hex via {@link hashContent}); `tokensConsumed`
 * is the heuristic char/4 token cost charged against the reader's budget (absent
 * for receipts not produced under a token budget, e.g. a search citation). This is
 * the additive evidence contract every governed read carries in `data.receipts`,
 * so a downstream consumer can audit WHAT was read without re-reading the file.
 */
export interface ReadReceipt {
  /** Root-relative POSIX path of the file read. */
  file: string;
  /** SHA-256 (full hex) of the exact content the reader saw. */
  hash: string;
  /** Heuristic token cost (≈ chars/4) charged against the read budget, when applicable. */
  tokensConsumed?: number;
}

export interface CommandResult {
  ok: boolean;
  exitCode: number;
  /** Machine-readable payload, merged into the `--json` object. */
  data?: Record<string, unknown>;
  /** Human-readable rendering (used when `--json` is absent). */
  human?: string;
  /**
   * SG3 P1-B — content-read receipts for governed readers. ADDITIVE: it rides in
   * the result and is also surfaced in `data.receipts` by the producing handler
   * (so the `--json` envelope carries it). Absent on every command that reads no
   * governed content (the common case). P2-A's `th research write` and P3-A's
   * `th inspector write` also emit these to bind each written artifact to its content hash.
   */
  receipts?: ReadReceipt[];
}

export function success(opts?: {
  data?: Record<string, unknown>;
  human?: string;
  /** SG3 P1-B — content-read receipts (additive; surfaced in `--json`). */
  receipts?: ReadReceipt[];
}): CommandResult {
  return { ok: true, exitCode: 0, data: opts?.data, human: opts?.human, receipts: opts?.receipts };
}

export function failure(opts?: {
  data?: Record<string, unknown>;
  human?: string;
  exitCode?: number;
  /** SG3 P1-B — content-read receipts (additive; surfaced in `--json`). */
  receipts?: ReadReceipt[];
}): CommandResult {
  return { ok: false, exitCode: opts?.exitCode ?? 1, data: opts?.data, human: opts?.human, receipts: opts?.receipts };
}

/** Render a result for stdout. `--json` always emits `{"ok": ..., ...data}`. */
export function renderResult(result: CommandResult, json: boolean): string {
  if (json) {
    // SG3 P1-B — surface top-level `receipts` in the `--json` envelope. Handlers
    // also place `receipts` in `data` (the documented "rides in data" contract), so
    // spread `data` LAST: a handler-provided `data.receipts` wins, and the top-level
    // field is a fallback so a receipt is never silently dropped from `--json`.
    return JSON.stringify({
      ok: result.ok,
      ...(result.receipts ? { receipts: result.receipts } : {}),
      ...(result.data ?? {}),
    });
  }
  if (result.human !== undefined) return result.human;
  if (result.data !== undefined) return JSON.stringify(result.data, null, 2);
  return result.ok ? "OK" : "FAILED";
}
