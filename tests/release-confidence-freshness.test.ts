/**
 * R-37 — release-confidence backstop: VERIFICATION FRESHNESS (F2/R-30).
 *
 * Phase-1..4 already proved the verify-report binding for command add/clear and a
 * tampered gitHead (tests/evidence-binding.test.ts). This suite closes the freshness
 * GAPS those tests do not exercise as distinct, real, on-disk change triggers:
 *
 *   - a SOURCE-file edit (a tracked .ts change)             → dirtyTreeDigest moves → stale
 *   - a CONFIG-file edit (a tracked config change)          → dirtyTreeDigest moves → stale
 *   - a LOCKFILE edit (a tracked package-lock change)       → dirtyTreeDigest moves → stale
 *   - a NEW COMMIT (HEAD advances)                          → gitHead moves        → stale
 *   - going from a clean tree to a dirty tree               → dirtyTreeDigest moves → stale
 *
 * These require a REAL git checkout so the git coordinates discriminate (a bare
 * mkdtemp project is non-git → gitHead/dirtyTreeDigest are null and never flip a
 * report to stale; that honest-null posture is itself asserted at the end).
 *
 * It ALSO characterizes one HONEST LIMIT the freshness binding does NOT cover: the
 * `th` BINARY VERSION is not a binding coordinate, so a `th` upgrade alone does not
 * stale a report. This is asserted as the current contract (NOT a wish) so a future
 * change to bind the version is a deliberate, test-visible decision.
 */

import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { resolveProjectPaths, type ProjectPaths } from "../src/core/paths";
import { runInit } from "../src/commands/init";
import { runVerifyAdd, runVerifyApprove, runVerifyRun } from "../src/commands/verify";
import {
  readVerifyReportValidated,
  currentVerifyBinding,
  writeVerifyReportEnvelope,
  verifyReportPath,
  type VerifyReport,
} from "../src/core/verify";

let cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  cleanupDirs = [];
});

/** Is a real `git` binary available? (Skip the git-coordinate cases if not.) */
function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const HAS_GIT = gitAvailable();

/** A REAL git checkout with one tracked source/config/lockfile + a committed HEAD. */
function makeGitProject(): { paths: ProjectPaths; root: string } {
  const literal = fs.mkdtempSync(path.join(os.tmpdir(), "th-fresh-git-"));
  cleanupDirs.push(literal);
  const paths = resolveProjectPaths(literal);
  const root = paths.root;
  // Seed tracked files BEFORE init so they are part of HEAD (so editing them later
  // produces a real diff against HEAD, i.e. dirtyTreeDigest moves).
  fs.writeFileSync(path.join(root, "src.ts"), "export const x = 1;\n", "utf8");
  fs.writeFileSync(path.join(root, "app.config.json"), JSON.stringify({ k: 1 }) + "\n", "utf8");
  fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3 }) + "\n", "utf8");
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: root, stdio: "ignore" });
  };
  git("init");
  git("config", "user.email", "t@e.st");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  git("add", "-A");
  git("commit", "-m", "seed");
  return { paths, root };
}

/** Arm an APPROVED, RUN verify report bound to the current (clean) snapshot. */
function approvedAndRun(paths: ProjectPaths): void {
  runInit(paths, {});
  runVerifyAdd(paths, "node -e \"process.exit(0)\"");
  runVerifyApprove(paths, { as: "alice", tty: { isTTY: true, stdinLine: "y" } });
  expect(runVerifyRun(paths).ok).toBe(true);
  expect(readVerifyReportValidated(paths).status).toBe("valid");
}

/** Commit the current changes (advance HEAD) on a real git project. */
function commitAll(root: string, msg: string): void {
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", msg], { cwd: root, stdio: "ignore" });
}

describe("R-37 verify freshness (F2) — a tracked-file edit staleness via dirtyTreeDigest", () => {
  // One parametrized assertion per change shape: edit a tracked SOURCE / CONFIG /
  // LOCKFILE file after the run, then the prior report must read as stale because the
  // working tree moved. (All three flow through the same dirtyTreeDigest coordinate,
  // but we assert each independently so a regression that special-cases one shape is
  // still caught.)
  const SHAPES: Array<{ name: string; file: string; body: string }> = [
    { name: "source (.ts)", file: "src.ts", body: "export const x = 2; // edited\n" },
    { name: "config (.json)", file: "app.config.json", body: JSON.stringify({ k: 2 }) + "\n" },
    { name: "lockfile", file: "package-lock.json", body: JSON.stringify({ lockfileVersion: 3, changed: true }) + "\n" },
  ];

  for (const shape of SHAPES) {
    it.skipIf(!HAS_GIT)(`editing a tracked ${shape.name} after the run marks the prior report stale`, () => {
      const { paths, root } = makeGitProject();
      approvedAndRun(paths);
      // Sanity: the run was bound to a non-null git snapshot (so the coordinate discriminates).
      const binding = currentVerifyBinding(paths, ["node -e \"process.exit(0)\""]);
      expect(binding.dirtyTreeDigest).not.toBeNull();

      // Mutate a tracked file → the working tree delta changes.
      fs.writeFileSync(path.join(root, shape.file), shape.body, "utf8");

      const v = readVerifyReportValidated(paths);
      expect(v.status).toBe("stale");
      expect(v.staleReasons).toContain("dirtyTreeDigest");
    });
  }

  it.skipIf(!HAS_GIT)("a clean→dirty transition (any tracked edit) flips a clean-tree report to stale", () => {
    const { paths, root } = makeGitProject();
    approvedAndRun(paths); // sealed against a CLEAN tree (CLEAN_TREE_DIGEST)
    // The report was sealed clean; introduce ANY dirt.
    fs.writeFileSync(path.join(root, "src.ts"), "export const x = 99;\n", "utf8");
    const v = readVerifyReportValidated(paths);
    expect(v.status).toBe("stale");
    expect(v.staleReasons).toContain("dirtyTreeDigest");
  });
});

describe("R-37 verify freshness (F2) — a new commit (HEAD advances) marks the report stale", () => {
  it.skipIf(!HAS_GIT)("committing after the run moves gitHead → prior report is stale", () => {
    const { paths, root } = makeGitProject();
    approvedAndRun(paths);
    const before = currentVerifyBinding(paths, ["node -e \"process.exit(0)\""]);
    expect(before.gitHead).not.toBeNull();

    // Advance HEAD with a new commit (a code change committed AND the tree returned clean).
    fs.writeFileSync(path.join(root, "src.ts"), "export const x = 3;\n", "utf8");
    commitAll(root, "advance");

    const after = currentVerifyBinding(paths, ["node -e \"process.exit(0)\""]);
    expect(after.gitHead).not.toBe(before.gitHead); // HEAD really moved

    const v = readVerifyReportValidated(paths);
    expect(v.status).toBe("stale");
    expect(v.staleReasons).toContain("gitHead");
  });
});

describe("R-37 verify freshness (F2) — HONEST LIMITS (characterization, not a wish)", () => {
  it("a NON-git project's report is NOT staled by git coordinates (honest-null posture)", () => {
    // A bare mkdtemp project is not a git checkout → gitHead/dirtyTreeDigest are null
    // and CANNOT discriminate. The report stays valid across the absence of a git
    // identity; only command-set / config-lock changes (always-present hashes) move it.
    const literal = fs.mkdtempSync(path.join(os.tmpdir(), "th-fresh-nogit-"));
    cleanupDirs.push(literal);
    const paths = resolveProjectPaths(literal);
    const binding = currentVerifyBinding(paths, []);
    // Only run the assertion when the temp dir is genuinely non-git (CI's tmp is not a repo).
    if (binding.gitHead === null && binding.dirtyTreeDigest === null) {
      approvedAndRun(paths);
      // No git change possible; the report remains valid (no false-stale from null coords).
      expect(readVerifyReportValidated(paths).status).toBe("valid");
    }
  });

  it("the `th` BINARY VERSION is NOT a freshness coordinate (documented contract)", () => {
    // The binding is exactly {commandSetHash, configLockDigest, gitHead, dirtyTreeDigest}.
    // It deliberately does NOT carry the `th` package version, so a binary upgrade alone
    // does not stale a report. This asserts the ACTUAL shape so a future decision to bind
    // the version is a visible, deliberate change — and flags the gap for the audit.
    const literal = fs.mkdtempSync(path.join(os.tmpdir(), "th-fresh-ver-"));
    cleanupDirs.push(literal);
    const paths = resolveProjectPaths(literal);
    const binding = currentVerifyBinding(paths, ["a", "b"]);
    const keys = Object.keys(binding).sort();
    expect(keys).toEqual(["commandSetHash", "configLockDigest", "dirtyTreeDigest", "gitHead"]);
    // Explicitly: no version-bearing coordinate is present.
    expect(keys).not.toContain("thVersion");
    expect(keys).not.toContain("toolVersion");
    expect(keys).not.toContain("binaryVersion");
  });
});

describe("R-37 verify freshness (F2) — forged / cross-project report rejection (backstop)", () => {
  it("a forged minimal {\"ok\":true} report is rejected as legacy (no binding)", () => {
    const literal = fs.mkdtempSync(path.join(os.tmpdir(), "th-fresh-forge-"));
    cleanupDirs.push(literal);
    const paths = resolveProjectPaths(literal);
    fs.mkdirSync(paths.stateDir, { recursive: true });
    fs.writeFileSync(verifyReportPath(paths), JSON.stringify({ ok: true, ranAt: "x", results: [] }), "utf8");
    expect(readVerifyReportValidated(paths).status).toBe("legacy");
  });

  it.skipIf(!HAS_GIT)("a report copied from ANOTHER project (different commands AND gitHead) is stale on BOTH coordinates", () => {
    // Build a real bound envelope, then tamper BOTH the command-set hash and gitHead to
    // simulate a report lifted wholesale from a different project/revision. The reader
    // must flag it stale and name BOTH diverged coordinates (not silently trust `ok`).
    const { paths } = makeGitProject();
    runInit(paths, {});
    runVerifyAdd(paths, "real-cmd");
    const report: VerifyReport = { ok: true, ranAt: "x", results: [] };
    writeVerifyReportEnvelope(paths, report, ["real-cmd"]);
    const raw = JSON.parse(fs.readFileSync(verifyReportPath(paths), "utf8")) as Record<string, unknown>;
    raw.commandSetHash = "deadbeef".repeat(8); // a different project's command set
    raw.gitHead = "0000000000000000000000000000000000000000"; // a different revision
    fs.writeFileSync(verifyReportPath(paths), JSON.stringify(raw), "utf8");
    const v = readVerifyReportValidated(paths);
    expect(v.status).toBe("stale");
    expect(v.staleReasons).toEqual(expect.arrayContaining(["commandSetHash", "gitHead"]));
  });
});
