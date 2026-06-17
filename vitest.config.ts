import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
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
  },
});
