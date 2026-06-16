"use strict";
/**
 * `sleepSync(ms)` — a zero-CPU synchronous sleep for the synchronous CLI (PERF-007).
 *
 * The state lock and the atomic-write/read retry loops are synchronous (there is
 * no event loop to `await`), so they previously blocked by SPINNING a full CPU
 * core in a `while (Date.now() < until) {}` busy-wait — pegging a core during any
 * lock contention or rename retry. This replaces every such spin with a single
 * shared, zero-CPU primitive.
 *
 * Mechanism: `Atomics.wait` on a brand-new `Int32Array(new SharedArrayBuffer(4))`
 * whose value is `0` and is NEVER changed by anyone. Waiting for it to STOP being
 * `0` therefore always TIMES OUT after ~`ms` — the OS parks the thread for the
 * duration with no spinning. Node permits `Atomics.wait` on the main thread (only
 * the browser main thread forbids it), so this is safe in the CLI. Builtins only;
 * zero new runtime dependencies.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.sleepSync = sleepSync;
/**
 * Block the calling thread for approximately `ms` milliseconds with ZERO CPU.
 *
 * A non-positive, non-finite, or NaN `ms` returns immediately (no wait). The wait
 * is implemented as an always-timing-out `Atomics.wait`, so the thread is parked
 * (not spinning) for the duration.
 */
function sleepSync(ms) {
    if (!Number.isFinite(ms) || ms <= 0)
        return;
    // A private, never-signalled lock word: waiting for it to change from 0 always
    // times out after ~ms, parking the thread with no busy-spin.
    const sab = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(sab, 0, 0, ms);
}
