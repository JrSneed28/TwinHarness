"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.success = success;
exports.failure = failure;
exports.renderResult = renderResult;
function success(opts) {
    return { ok: true, exitCode: 0, data: opts?.data, human: opts?.human };
}
function failure(opts) {
    return { ok: false, exitCode: opts?.exitCode ?? 1, data: opts?.data, human: opts?.human };
}
/** Render a result for stdout. `--json` always emits `{"ok": ..., ...data}`. */
function renderResult(result, json) {
    if (json) {
        return JSON.stringify({ ok: result.ok, ...(result.data ?? {}) });
    }
    if (result.human !== undefined)
        return result.human;
    if (result.data !== undefined)
        return JSON.stringify(result.data, null, 2);
    return result.ok ? "OK" : "FAILED";
}
