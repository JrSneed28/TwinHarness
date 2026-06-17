/**
 * `sleepSync(ms)` — a zero-CPU synchronous sleep for the synchronous CLI (PERF-007).
 *
 * The state lock and the atomic-write/read retry loops are synchronous (there is
 * no event loop to `await`), so they previously blocked by SPINNING a full CPU
 * core in a `while (Date.now() < until) {}` busy-wait — pegging a core during any
 * lock contention or rename retry. This replaces every such spin with a single
 * shared, zero-CPU primitive.
 *
 * Mechanism: `Atomics.wait` on ONE shared, module-level `Int32Array` whose value
 * is `0` and is NEVER changed by anyone. The lock word is allocated EXACTLY ONCE
 * at module load (not per call — the old per-call `new SharedArrayBuffer(4)`
 * caused GC churn during the very contention burst PERF-007/008 keep cheap).
 * Waiting for it to STOP being `0` therefore always TIMES OUT after ~`ms` — the
 * OS parks the thread for the duration with no spinning. Node permits
 * `Atomics.wait` on the main thread (only the browser main thread forbids it), so
 * this is safe in the CLI. Builtins only; zero new runtime dependencies.
 *
 * Never-throws guarantee: on a hardened / non-cross-origin-isolated runtime
 * `SharedArrayBuffer` may be unavailable and its constructor THROWS. The
 * allocation is guarded so IMPORTING this module can never throw (the word is
 * `null` when unavailable), and `sleepSync` itself can never throw: if the word
 * is `null` or `Atomics.wait` throws at call time, it falls through to a bounded
 * `while (Date.now() < until)` spin so the call still returns after ~`ms`. That
 * fallback reintroduces CPU spin ONLY on those hardened runtimes (correctness
 * over a raw throw); the zero-CPU `Atomics` path is unchanged everywhere it works.
 */

/**
 * Shared, never-signalled lock word, allocated EXACTLY ONCE at module load.
 *
 * `null` when `SharedArrayBuffer` is unavailable (hardened runtimes), in which
 * case the constructor would throw — the IIFE swallows that so importing this
 * module can never throw. `sleepSync` falls back to a bounded spin when this is
 * `null`.
 */
const LOCK_WORD: Int32Array | null = (() => {
  try {
    return new Int32Array(new SharedArrayBuffer(4));
  } catch {
    return null;
  }
})();

/**
 * Block the calling thread for approximately `ms` milliseconds with ZERO CPU.
 *
 * A non-positive, non-finite, or NaN `ms` returns immediately (no wait). The wait
 * is implemented as an always-timing-out `Atomics.wait` on the shared module-level
 * lock word, so the thread is parked (not spinning) for the duration. Durations
 * are honored and accumulate across calls.
 *
 * This function NEVER throws: if the lock word is unavailable (no
 * `SharedArrayBuffer`) or `Atomics.wait` throws at call time (hardened runtime),
 * it falls back to a bounded `while (Date.now() < until)` spin that still returns
 * after ~`ms`. The fallback reintroduces CPU spin only on those hardened runtimes.
 */
export function sleepSync(ms: number): void {
  if (!Number.isFinite(ms) || ms <= 0) return;
  if (LOCK_WORD !== null) {
    try {
      // Waiting for the never-signalled word to change from 0 always times out
      // after ~ms, parking the thread with no busy-spin.
      Atomics.wait(LOCK_WORD, 0, 0, ms);
      return;
    } catch {
      // Hardened runtime forbade Atomics.wait — fall through to bounded spin.
    }
  }
  // Bounded fallback: deadline-capped spin so the call always returns after ~ms
  // and can never throw. CPU spin here is intentional and hardened-runtime-only.
  const until = Date.now() + ms;
  while (Date.now() < until) {
    /* bounded busy-wait until the deadline */
  }
}
