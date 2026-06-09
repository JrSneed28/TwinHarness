import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Each test isolates its own temp project dir; no global setup needed.
    pool: "threads",
  },
});
