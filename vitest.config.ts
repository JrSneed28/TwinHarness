import { defineConfig } from "vitest/config";
import { sharedTest, STRESS_TEST_FILES, DEFAULT_EXCLUDE } from "./vitest.shared";

export default defineConfig({
  test: {
    ...sharedTest,
    include: ["tests/**/*.test.ts"],
    // The spawn-heavy cross-process stress files run in a SEPARATE serial pass
    // (vitest.stress.config.ts — the second half of `npm test`) so they never
    // overlap each other or the rest of the suite. Excluding them here prevents
    // the 100+-concurrent-subprocess oversubscription that scheduler-starved the
    // state lock on 2-core windows-latest (the REQ-STATE-LOCK-001 flake). See
    // vitest.shared.ts for the full rationale.
    exclude: [...DEFAULT_EXCLUDE, ...STRESS_TEST_FILES],
  },
});
