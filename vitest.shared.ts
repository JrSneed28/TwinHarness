import { configDefaults } from "vitest/config";

/**
 * Settings shared by the two-pass `npm test` (see package.json `test`):
 *
 *   pass 1 — vitest.config.ts: the full suite EXCEPT the stress files, run in
 *            parallel as usual.
 *   pass 2 — vitest.stress.config.ts: ONLY the cross-process concurrency stress
 *            files, run serially (fileParallelism: false) with the machine
 *            otherwise idle (pass 1 has already finished).
 *
 * Why split: each stress file spawns 12–52 real `node dist/cli.js` processes at
 * once to prove the cross-process state lock loses no updates (audit finding F10 /
 * REQ-STATE-LOCK-001). When vitest ran all ~165 files in parallel, two or more of
 * the four stress files could overlap and put 100+ short-lived subprocesses on a
 * 2-core windows-latest runner. An unlucky state-lock waiter was then
 * scheduler-starved past even the 90s TH_LOCK_TIMEOUT_MS and threw a
 * LockTimeoutError on a write that would otherwise have landed — a false red that
 * recurred ONLY on windows-latest (raising the deadline to 90s in the prior commit
 * did not help: the waiter still starved out, just at 90s instead of 25s).
 *
 * Running the stress files alone and one at a time caps the simultaneous
 * subprocess wave to a single file's worth (~52) instead of the cross-file sum
 * (100+), which removes the starvation WITHOUT weakening any "no lost updates"
 * assertion (the lock, its timeout, and every correctness check are unchanged).
 *
 * Keep both configs on these shared settings so the two passes behave identically.
 */

/** The spawn-heavy cross-process stress files, isolated into the serial pass 2. */
export const STRESS_TEST_FILES = [
  "tests/concurrency.test.ts",
  "tests/decision-concurrency.test.ts",
  "tests/collab.test.ts",
  "tests/state-store-lock.test.ts",
];

/** Test settings common to both passes (mirrors the historic single config). */
export const sharedTest = {
  environment: "node",
  globalSetup: ["tests/global-setup.ts"],
  pool: "threads",
  // vitest 4's heavier per-run import phase (~10s for this suite) overlaps with
  // test execution, so the FIRST real-subprocess test (e.g. `runCLI` spawning a
  // cold `node dist/cli.js`) can exceed the old 5s default under full-suite load —
  // a false-red, since these pass in isolation. Raise the default to 15s (still
  // well under any genuine hang; tests that spawn many processes keep their own
  // explicit longer per-test timeouts, which override this).
  testTimeout: 15000,
  hookTimeout: 15000,
};

/** vitest's built-in excludes (node_modules, dist, …) — preserved by the main config. */
export const DEFAULT_EXCLUDE = configDefaults.exclude;
