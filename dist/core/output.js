"use strict";
/**
 * Command result + rendering. Command functions are pure and return a
 * `CommandResult`; the CLI dispatcher (cli.ts) prints and sets the exit code.
 * This keeps all command logic unit-testable without spawning a process.
 *
 * Every command supports `--json` (plan §3: "Every command ... has `--json`").
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.success = success;
exports.failure = failure;
exports.renderResult = renderResult;
function success(opts) {
    return { ok: true, exitCode: 0, data: opts?.data, human: opts?.human, receipts: opts?.receipts };
}
function failure(opts) {
    return { ok: false, exitCode: opts?.exitCode ?? 1, data: opts?.data, human: opts?.human, receipts: opts?.receipts };
}
/** Render a result for stdout. `--json` always emits `{"ok": ..., ...data}`. */
function renderResult(result, json) {
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
    if (result.human !== undefined)
        return result.human;
    if (result.data !== undefined)
        return JSON.stringify(result.data, null, 2);
    return result.ok ? "OK" : "FAILED";
}
