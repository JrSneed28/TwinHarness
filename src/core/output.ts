/**
 * Command result + rendering. Command functions are pure and return a
 * `CommandResult`; the CLI dispatcher (cli.ts) prints and sets the exit code.
 * This keeps all command logic unit-testable without spawning a process.
 *
 * Every command supports `--json` (plan §3: "Every command ... has `--json`").
 */
export interface CommandResult {
  ok: boolean;
  exitCode: number;
  /** Machine-readable payload, merged into the `--json` object. */
  data?: Record<string, unknown>;
  /** Human-readable rendering (used when `--json` is absent). */
  human?: string;
}

export function success(opts?: { data?: Record<string, unknown>; human?: string }): CommandResult {
  return { ok: true, exitCode: 0, data: opts?.data, human: opts?.human };
}

export function failure(opts?: {
  data?: Record<string, unknown>;
  human?: string;
  exitCode?: number;
}): CommandResult {
  return { ok: false, exitCode: opts?.exitCode ?? 1, data: opts?.data, human: opts?.human };
}

/** Render a result for stdout. `--json` always emits `{"ok": ..., ...data}`. */
export function renderResult(result: CommandResult, json: boolean): string {
  if (json) {
    return JSON.stringify({ ok: result.ok, ...(result.data ?? {}) });
  }
  if (result.human !== undefined) return result.human;
  if (result.data !== undefined) return JSON.stringify(result.data, null, 2);
  return result.ok ? "OK" : "FAILED";
}
