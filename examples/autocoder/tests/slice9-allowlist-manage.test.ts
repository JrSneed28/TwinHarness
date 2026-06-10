/**
 * SLICE-9 / TASK-018 — Allowlist-management subcommand (list / add / remove) + persistence.
 *
 * Anchored to REQ-025 (the CLI provides allowlist-management commands to inspect, add,
 * and remove entries in the command-approval allowlist; changes persist to the config —
 * REQ-018 / RULE-014). The canonical anchor below (REQ-025) is what `th anchors scan` /
 * `th coverage check` match; each test name carries the same anchor in `test_REQ025_...`
 * form (§11).
 *
 * Drives the REAL composition root `runCli` with the `allowlist` subcommand argv against a
 * temp config-file fixture. NO agent loop is started, NO network, NO real subprocess. The
 * persistence-failure case injects a failing FS-write seam (`configFs`) so the non-zero
 * exit (FAIL-004) is proven deterministically with no real disk write.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli } from "../src/cli.js";
import type { CliIo } from "../src/cli.js";
import type { ConfigFsSeam } from "../src/config.js";
import { createStubCommandRunner, createStubLlmClient } from "./stubs.js";

/** Capture stdout/stderr written by the composition root. */
function captureIo(): CliIo & { out: string; err: string } {
  const sink = {
    out: "",
    err: "",
    writeOut(t: string) {
      sink.out += t;
    },
    writeErr(t: string) {
      sink.err += t;
    },
  };
  return sink;
}

/** The DI seams the allowlist (no-loop) path never touches — present to satisfy the input. */
function noLoopSeams() {
  return {
    llm: createStubLlmClient([]),
    commandRunner: createStubCommandRunner(),
  };
}

/** Read + parse the persisted config file's allowlist patterns (the persistence assertion). */
async function readPersistedPatterns(configFile: string): Promise<string[]> {
  const raw = await fs.readFile(configFile, "utf8");
  const obj = JSON.parse(raw) as { allowlist?: { pattern: string }[] };
  return (obj.allowlist ?? []).map((e) => e.pattern);
}

// Anchor: REQ-025 — allowlist inspect/add/remove + persistence (RULE-014).
describe("SLICE-9 allowlist management (REQ-025)", () => {
  let tmpRoot: string;
  let configFile: string;
  const env = { ANTHROPIC_API_KEY: "test-key" };

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "autocoder-slice9-allowlist-"));
    configFile = path.join(tmpRoot, "autocoder.json");
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("test_REQ025_allowlist_list_add_remove_persists (REQ-025)", async () => {
    // Seed a config file with a known allowlist so `list` has a deterministic set.
    await fs.writeFile(
      configFile,
      JSON.stringify({ allowlist: [{ pattern: "git status" }, { pattern: "ls" }] }, null, 2),
      "utf8",
    );

    // --- list: inspects and prints the current set (no mutation). ---
    const ioList = captureIo();
    const codeList = await runCli({
      argv: ["allowlist", "list", "--config", configFile],
      env,
      cwd: tmpRoot,
      transcriptDir: path.join(tmpRoot, ".transcripts"),
      ...noLoopSeams(),
      io: ioList,
    });
    expect(codeList).toBe(0);
    expect(ioList.out).toContain("git status");
    expect(ioList.out).toContain("ls");
    expect(ioList.err).toBe("");
    // No mutation occurred — the file is unchanged.
    expect(await readPersistedPatterns(configFile)).toEqual(["git status", "ls"]);

    // --- add: mutates the set AND persists the new entry to the config file. ---
    const ioAdd = captureIo();
    const codeAdd = await runCli({
      argv: ["allowlist", "add", "npm test", "--config", configFile],
      env,
      cwd: tmpRoot,
      transcriptDir: path.join(tmpRoot, ".transcripts"),
      ...noLoopSeams(),
      io: ioAdd,
    });
    expect(codeAdd).toBe(0);
    expect(ioAdd.err).toBe("");
    expect(ioAdd.out.toLowerCase()).toContain("saved");
    // Re-READ the config file from disk: the new entry is persisted (RULE-014).
    const afterAdd = await readPersistedPatterns(configFile);
    expect(afterAdd).toContain("npm test");
    expect(afterAdd).toEqual(["git status", "ls", "npm test"]);

    // --- remove: mutates the set AND persists the removal to the config file. ---
    const ioRemove = captureIo();
    const codeRemove = await runCli({
      argv: ["allowlist", "remove", "ls", "--config", configFile],
      env,
      cwd: tmpRoot,
      transcriptDir: path.join(tmpRoot, ".transcripts"),
      ...noLoopSeams(),
      io: ioRemove,
    });
    expect(codeRemove).toBe(0);
    expect(ioRemove.err).toBe("");
    // Re-READ from disk: the entry is gone (RULE-014).
    const afterRemove = await readPersistedPatterns(configFile);
    expect(afterRemove).not.toContain("ls");
    expect(afterRemove).toEqual(["git status", "npm test"]);
  });

  it("test_REQ025_allowlist_ops_idempotent (REQ-025)", async () => {
    // Seed with a single entry.
    await fs.writeFile(
      configFile,
      JSON.stringify({ allowlist: [{ pattern: "git status" }] }, null, 2),
      "utf8",
    );

    // add-EXISTING: a no-op success (exit 0, no duplicate, no error).
    const ioAddDup = captureIo();
    const codeAddDup = await runCli({
      argv: ["allowlist", "add", "git status", "--config", configFile],
      env,
      cwd: tmpRoot,
      transcriptDir: path.join(tmpRoot, ".transcripts"),
      ...noLoopSeams(),
      io: ioAddDup,
    });
    expect(codeAddDup).toBe(0);
    expect(ioAddDup.err).toBe("");
    // No duplicate was added — set membership is unchanged.
    expect(await readPersistedPatterns(configFile)).toEqual(["git status"]);

    // remove-ABSENT: a no-op success (exit 0, set unchanged, no error).
    const ioRemoveAbsent = captureIo();
    const codeRemoveAbsent = await runCli({
      argv: ["allowlist", "remove", "does not exist", "--config", configFile],
      env,
      cwd: tmpRoot,
      transcriptDir: path.join(tmpRoot, ".transcripts"),
      ...noLoopSeams(),
      io: ioRemoveAbsent,
    });
    expect(codeRemoveAbsent).toBe(0);
    expect(ioRemoveAbsent.err).toBe("");
    // The set is still exactly the original — nothing was removed.
    expect(await readPersistedPatterns(configFile)).toEqual(["git status"]);
  });

  it("test_REQ025_allowlist_persist_failure (REQ-025)", async () => {
    await fs.writeFile(
      configFile,
      JSON.stringify({ allowlist: [{ pattern: "git status" }] }, null, 2),
      "utf8",
    );

    // Inject an FS seam whose WRITE fails (disk full / permission — FAIL-004). Reads
    // succeed so the manager loads the current set; only persistence fails.
    let writeAttempted = false;
    const failingFs: ConfigFsSeam = {
      readFileSync: (p) => readFileSync(p, "utf8"),
      writeFileSync: () => {
        writeAttempted = true;
        const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      },
    };

    const io = captureIo();
    const code = await runCli({
      argv: ["allowlist", "add", "npm test", "--config", configFile],
      env,
      cwd: tmpRoot,
      transcriptDir: path.join(tmpRoot, ".transcripts"),
      ...noLoopSeams(),
      io,
      configFs: failingFs,
    });

    // The write WAS attempted, but it FAILED → non-zero exit (never a silent "saved").
    expect(writeAttempted).toBe(true);
    expect(code).not.toBe(0);
    // The failure is reported on stderr...
    expect(io.err).toContain("ALLOWLIST_PERSIST_FAILED");
    // ...and NO false "saved" success was printed to stdout.
    expect(io.out.toLowerCase()).not.toContain("saved");
    // The real on-disk file was NOT mutated (the failing write never landed).
    expect(await readPersistedPatterns(configFile)).toEqual(["git status"]);
  });
});
