/**
 * SLICE-1 / TASK-003 — Config resolution + working-root validation + fail-fast.
 *
 * Anchored to REQ-002 (resolve + validate the WorkingRoot: default cwd, or
 * --cwd/--root; must be an existing directory), REQ-018 (config precedence flags >
 * env > file > defaults, incl. ANTHROPIC_API_KEY from env), and REQ-NFR-006
 * (misconfiguration fails fast with an actionable message + non-zero exit, BEFORE
 * any iteration — CONFIG_INVALID / ERR-015 / RULE-016). The canonical anchors
 * below (REQ-002, REQ-018, REQ-NFR-006) are what `th anchors scan` /
 * `th coverage check` match; each test name carries the same anchor (§11).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveConfig, ConfigError, CONFIG_INVALID } from "../src/config.js";
import { runCli } from "../src/cli.js";
import type { CliIo } from "../src/cli.js";
import { createStubCommandRunner, createStubLlmClient } from "./stubs.js";

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

const KEY_ENV = { ANTHROPIC_API_KEY: "test-key" };

// Anchor: REQ-002, REQ-018, REQ-NFR-006 — config precedence, root validation, fail-fast.
describe("SLICE-1 config resolution (REQ-002, REQ-018, REQ-NFR-006)", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "autocoder-slice1-cfg-"));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("test_REQ002_defaults_to_cwd_root (REQ-002)", () => {
    // With no --root, the resolved root equals the injected cwd (resolved/realish).
    const config = resolveConfig({
      flags: { task: "t" },
      env: KEY_ENV,
      cwd: tmpRoot,
    });
    expect(config.root).toBe(path.resolve(tmpRoot));
  });

  it("test_REQ002_root_flag_sets_boundary (REQ-002)", async () => {
    // A second existing directory the flag will point at.
    const otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), "autocoder-other-"));
    try {
      const config = resolveConfig({
        flags: { task: "t", root: otherRoot },
        env: KEY_ENV,
        cwd: tmpRoot, // cwd differs — the flag must win.
      });
      expect(config.root).toBe(path.resolve(otherRoot));
      expect(config.root).not.toBe(path.resolve(tmpRoot));
    } finally {
      await fs.rm(otherRoot, { recursive: true, force: true });
    }
  });

  it("test_REQ002_invalid_root_failfast (REQ-002)", async () => {
    const missing = path.join(tmpRoot, "does", "not", "exist");

    // Unit: resolveConfig throws CONFIG_INVALID before producing a Config.
    expect(() =>
      resolveConfig({ flags: { task: "t", root: missing }, env: KEY_ENV, cwd: tmpRoot }),
    ).toThrowError(ConfigError);
    try {
      resolveConfig({ flags: { task: "t", root: missing }, env: KEY_ENV, cwd: tmpRoot });
    } catch (err) {
      expect((err as ConfigError).code).toBe(CONFIG_INVALID);
    }

    // Integration: the CLI fails fast (non-zero) before any run/iteration. No
    // transcript dir is even reached; the stub LlmClient is never called.
    const io = captureIo();
    const llm = createStubLlmClient([]);
    const code = await runCli({
      argv: ["a task", "--root", missing],
      env: KEY_ENV,
      cwd: tmpRoot,
      transcriptDir: path.join(tmpRoot, ".transcripts"),
      llm,
      commandRunner: createStubCommandRunner(),
      io,
    });
    expect(code).not.toBe(0);
    expect(io.err).toContain(CONFIG_INVALID);
    expect(llm.calls).toHaveLength(0); // fail-fast: no iteration occurred.
  });

  it("test_REQ018_config_precedence_flags_over_env_over_file (REQ-018)", async () => {
    // modelId present at all three layers; flags must win, then env, then file.
    const configFile = path.join(tmpRoot, "autocoder.json");
    await fs.writeFile(
      configFile,
      JSON.stringify({ modelId: "from-file", maxIterations: 7 }),
      "utf8",
    );
    const env = { ...KEY_ENV, AUTOCODER_MODEL: "from-env" };

    // Flag wins over env wins over file.
    const flagWins = resolveConfig({
      flags: { task: "t", modelId: "from-flag", configFile },
      env,
      cwd: tmpRoot,
    });
    expect(flagWins.modelId).toBe("from-flag");

    // No flag → env wins over file.
    const envWins = resolveConfig({
      flags: { task: "t", configFile },
      env,
      cwd: tmpRoot,
    });
    expect(envWins.modelId).toBe("from-env");

    // No flag, no env → file wins over default.
    const fileWins = resolveConfig({
      flags: { task: "t", configFile },
      env: KEY_ENV,
      cwd: tmpRoot,
    });
    expect(fileWins.modelId).toBe("from-file");
    expect(fileWins.maxIterations).toBe(7); // file value over the default 25.

    // No flag, no env, no file → built-in default applies.
    const defaultWins = resolveConfig({ flags: { task: "t" }, env: KEY_ENV, cwd: tmpRoot });
    expect(defaultWins.maxIterations).toBe(25);
    expect(defaultWins.editMode).toBe("confirm-each");
    expect(defaultWins.commandMode).toBe("allowlist-confirm");
    expect(defaultWins.tokenBudget).toBeGreaterThan(0);
    expect(defaultWins.allowlist.length).toBeGreaterThan(0);

    // --yes/--auto forces BOTH approval modes to "auto" (IF-017 rule).
    const auto = resolveConfig({ flags: { task: "t", auto: true }, env: KEY_ENV, cwd: tmpRoot });
    expect(auto.editMode).toBe("auto");
    expect(auto.commandMode).toBe("auto");
  });

  it("test_REQ018_missing_apikey_failfast (REQ-018)", async () => {
    // Unit: no ANTHROPIC_API_KEY → CONFIG_INVALID before any Config is produced.
    expect(() =>
      resolveConfig({ flags: { task: "t" }, env: {}, cwd: tmpRoot }),
    ).toThrowError(ConfigError);

    // Integration: the CLI fails fast (non-zero) and never starts the run.
    const io = captureIo();
    const llm = createStubLlmClient([]);
    const code = await runCli({
      argv: ["a task", "--root", tmpRoot],
      env: {}, // no key
      cwd: tmpRoot,
      transcriptDir: path.join(tmpRoot, ".transcripts"),
      llm,
      commandRunner: createStubCommandRunner(),
      io,
    });
    expect(code).not.toBe(0);
    expect(io.err).toContain(CONFIG_INVALID);
    expect(llm.calls).toHaveLength(0);
  });

  it("test_REQNFR006_missing_apikey_actionable_message (REQ-NFR-006)", async () => {
    const io = captureIo();
    const code = await runCli({
      argv: ["a task", "--root", tmpRoot],
      env: {}, // no ANTHROPIC_API_KEY
      cwd: tmpRoot,
      transcriptDir: path.join(tmpRoot, ".transcripts"),
      llm: createStubLlmClient([]),
      commandRunner: createStubCommandRunner(),
      io,
    });

    // Non-zero exit, and the message is actionable on STDERR (names the env var
    // and tells the user how to fix it) — not a bare stack trace, not on stdout.
    expect(code).not.toBe(0);
    expect(io.out).toBe("");
    expect(io.err).toContain("ANTHROPIC_API_KEY");
    expect(io.err.toLowerCase()).toContain("set");
    expect(io.err).toContain("export ANTHROPIC_API_KEY");
  });
});
