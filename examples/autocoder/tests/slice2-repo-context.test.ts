/**
 * SLICE-2 / TASK-004 — RepoContext builder (REQ-003).
 *
 * Anchored to REQ-003: the agent builds bounded initial context (directory
 * listing, detected project type / test command, key files) WITHOUT loading the
 * whole repo into the prompt. These tests drive `buildRepoContext` against a
 * temp-dir fixture and assert the detected metadata + the bound.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildRepoContext,
  FILE_LISTING_CAP,
} from "../src/repo-context.js";

describe("SLICE-2 RepoContext builder (REQ-003)", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "autocoder-slice2-ctx-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  // Anchor: REQ-003.
  it("test_REQ003_context_lists_and_detects_testcmd", async () => {
    // A Node fixture repo with a `scripts.test` and a couple of source files.
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify(
        { name: "fixture", scripts: { test: "vitest run", build: "tsc" } },
        null,
        2,
      ),
      "utf8",
    );
    await fs.writeFile(path.join(root, "tsconfig.json"), "{}", "utf8");
    await fs.writeFile(path.join(root, "README.md"), "# fixture\n", "utf8");
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "index.ts"), "export {};\n", "utf8");
    // Volume that must NOT be descended (proves the ignore + bound work).
    await fs.mkdir(path.join(root, "node_modules", "dep"), { recursive: true });
    await fs.writeFile(
      path.join(root, "node_modules", "dep", "index.js"),
      "module.exports={};\n",
      "utf8",
    );

    const ctx = buildRepoContext(root);

    // Project type detected from package.json.
    expect(ctx.projectType).toBe("node");
    // Test command detected from scripts.test → runs the script (`npm test`).
    expect(ctx.testCommand).toBe("npm test");
    // The listing counts real repo files but excludes ignored dirs.
    expect(ctx.fileCount).toBeGreaterThan(0);
    expect(ctx.files).toContain("package.json");
    expect(ctx.files).toContain(path.join("src", "index.ts"));
    expect(ctx.files.some((f) => f.includes("node_modules"))).toBe(false);
    // Key files are surfaced (names only) and capped.
    expect(ctx.keyFiles).toContain("package.json");
    expect(ctx.keyFiles).toContain("tsconfig.json");

    // Config override wins over detection (overridable via Config).
    const overridden = buildRepoContext(root, {
      testCommandOverride: "make check",
    });
    expect(overridden.testCommand).toBe("make check");
  });

  // Anchor: REQ-003.
  it("test_REQ003_context_without_full_repo_in_prompt", async () => {
    // Create MANY files — far more than the listing cap — to prove the context
    // is BOUNDED (it never becomes "the whole repo in the prompt").
    const total = FILE_LISTING_CAP + 50;
    await fs.mkdir(path.join(root, "many"), { recursive: true });
    for (let n = 0; n < total; n++) {
      await fs.writeFile(
        path.join(root, "many", `f${String(n).padStart(4, "0")}.txt`),
        // Each file has content — the context must NOT embed file CONTENTS.
        `content for file ${n}\n`.repeat(20),
        "utf8",
      );
    }

    const ctx = buildRepoContext(root);

    // The listing is capped — bounded, not the whole repo.
    expect(ctx.files.length).toBeLessThanOrEqual(FILE_LISTING_CAP);
    expect(ctx.fileCount).toBeLessThanOrEqual(FILE_LISTING_CAP);
    expect(ctx.truncated).toBe(true);

    // The context carries file NAMES, never the file CONTENTS — assert no file's
    // body text leaked into any field of the bounded context.
    const serialized = JSON.stringify(ctx);
    expect(serialized).not.toContain("content for file");
  });
});
