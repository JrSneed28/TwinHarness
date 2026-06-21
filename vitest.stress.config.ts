import { defineConfig } from "vitest/config";
import { sharedTest, STRESS_TEST_FILES } from "./vitest.shared";

export default defineConfig({
  test: {
    ...sharedTest,
    // ONLY the cross-process concurrency stress files (the main pass excludes them).
    include: STRESS_TEST_FILES,
    // Run ONE stress file at a time. The main pass has already finished, so the
    // machine is otherwise idle: this caps the simultaneous spawned-subprocess
    // wave to a single file's worth (~52) instead of the cross-file sum (100+),
    // so the cross-process state-lock waiter is no longer scheduler-starved past
    // its deadline on a 2-core windows-latest runner. See vitest.shared.ts.
    fileParallelism: false,
  },
});
