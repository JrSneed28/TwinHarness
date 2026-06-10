/**
 * SLICE-5 / TASK-011 — CommandRunner seam + Allowlist + ApprovalGate.resolveCommand
 * (REQ-016, REQ-NFR-007).
 *
 * Drives the auto-run vs. confirm decision through the REAL allowlist matcher and the
 * REAL approval gate with an INJECTED command-confirm seam (no stdin). The
 * security-critical negatives are exercised rigorously (this is a data-integrity
 * blast-radius surface — arbitrary shell exec): substring-only matches do NOT auto-run
 * (token-sequence prefix, ADR-006); chained/redirected forms NEVER auto-run even with
 * an allowlisted head token (INV-010); destructive non-allowlisted commands are gated.
 *
 * Shell selection (REQ-NFR-007) is asserted via the PURE `selectShell` for BOTH the
 * win32 and POSIX regimes on a single host — no real subprocess is ever spawned.
 */
import { describe, expect, it } from "vitest";
import { createAllowlist, isChainedOrRedirected, tokenize } from "../src/allowlist.js";
import { createApprovalGate, type ConfirmCommandFn } from "../src/approval-gate.js";
import { selectShell } from "../src/command-runner.js";
import type {
  AllowlistEntry,
  CommandApprovalPolicy,
  ApprovalDecision,
} from "../src/contracts.js";

const DEFAULT_MODE: CommandApprovalPolicy = { commandMode: "allowlist-confirm" };
const AUTO_MODE: CommandApprovalPolicy = { commandMode: "auto" };

/** The default safe allowlist (mirrors config defaults + the detected test command). */
const ALLOWLIST: AllowlistEntry[] = [
  { pattern: "git status" },
  { pattern: "git diff" },
  { pattern: "ls" },
  { pattern: "cat" },
  { pattern: "npm test" },
];

/**
 * A command-confirm seam returning a fixed answer AND recording whether it was called
 * — so a test can assert auto-run (NOT called) vs. prompt (called) deterministically.
 */
function recordingConfirm(answer: "approve" | "deny" | "abort"): ConfirmCommandFn & {
  calls: string[];
} {
  const calls: string[] = [];
  const fn = (async (prompt: { command: string }) => {
    calls.push(prompt.command);
    return answer;
  }) as ConfirmCommandFn & { calls: string[] };
  fn.calls = calls;
  return fn;
}

describe("SLICE-5 command approval — allowlist + resolveCommand (REQ-016)", () => {
  // -------------------------------------------------------------- REQ-016 ----

  // Anchor: REQ-016.
  it("test_REQ016_allowlisted_command_auto_runs", async () => {
    const confirm = recordingConfirm("deny"); // would deny IF prompted
    const gate = createApprovalGate({ confirmCommand: confirm });
    const allowlist = createAllowlist(ALLOWLIST);

    const decision = await gate.resolveCommand("git status -s", DEFAULT_MODE, allowlist);

    // An allowlisted (token-prefix) command auto-runs WITHOUT prompting.
    expect(decision).toBe<ApprovalDecision>("auto-approved");
    expect(confirm.calls).toEqual([]); // the seam was never consulted
  });

  // Anchor: REQ-016.
  it("test_REQ016_nonallowlisted_prompts", async () => {
    const confirm = recordingConfirm("approve");
    const gate = createApprovalGate({ confirmCommand: confirm });
    const allowlist = createAllowlist(ALLOWLIST);

    // `rm -rf build` is NOT on the allowlist → must prompt; user approves here.
    const decision = await gate.resolveCommand("rm -rf build", DEFAULT_MODE, allowlist);

    expect(decision).toBe<ApprovalDecision>("approved-by-user");
    expect(confirm.calls).toEqual(["rm -rf build"]); // the seam WAS consulted
  });

  // Anchor: REQ-016. A chained command is NOT auto-run (forced to confirm).
  it("test_REQ016_chained_command_not_autorun", async () => {
    const confirm = recordingConfirm("approve");
    const gate = createApprovalGate({ confirmCommand: confirm });
    const allowlist = createAllowlist(ALLOWLIST);

    // Head token `git status` is allowlisted, but `&& rm -rf /` chains a destructive
    // tail — INV-010 forbids auto-run; it must fall through to the prompt.
    const decision = await gate.resolveCommand(
      "git status && rm -rf /",
      DEFAULT_MODE,
      allowlist,
    );

    expect(decision).toBe<ApprovalDecision>("approved-by-user");
    expect(confirm.calls).toEqual(["git status && rm -rf /"]);
    // And the matcher itself reports it as NOT allowed.
    expect(allowlist.isAllowed("git status && rm -rf /")).toBe(false);
  });

  // Anchor: REQ-016. A destructive non-allowlisted command requires confirmation (ABU-001).
  it("test_REQ016_destructive_command_requires_confirmation", async () => {
    const confirm = recordingConfirm("deny");
    const gate = createApprovalGate({ confirmCommand: confirm });
    const allowlist = createAllowlist(ALLOWLIST);

    // A destructive command is gated; the user denies → APPROVAL_DENIED path.
    const decision = await gate.resolveCommand("rm -rf /etc", DEFAULT_MODE, allowlist);

    expect(decision).toBe<ApprovalDecision>("denied");
    expect(confirm.calls).toEqual(["rm -rf /etc"]);
  });

  // Anchor: REQ-016. Substring-only matches do NOT auto-run — token-sequence EXACT (ABU-006).
  it("test_REQ016_allowlist_prefix_match_is_token_exact", async () => {
    const confirm = recordingConfirm("deny");
    const gate = createApprovalGate({ confirmCommand: confirm });
    const allowlist = createAllowlist(ALLOWLIST);

    // `git statusfoo` shares the SUBSTRING "git status" but `statusfoo` is a DIFFERENT
    // token → it is NOT a token-sequence prefix → must NOT auto-run.
    expect(allowlist.isAllowed("git statusfoo")).toBe(false);
    expect(allowlist.isAllowed("git status -s")).toBe(true); // genuine token prefix

    // A bare prefix that has FEWER-or-different tokens than the entry is not a match:
    // `git` alone does not match the 2-token entry `git status`.
    expect(allowlist.isAllowed("git")).toBe(false);
    // A leading-substring command (`lsblk`) must not match the `ls` entry.
    expect(allowlist.isAllowed("lsblk")).toBe(false);
    expect(allowlist.isAllowed("ls -la")).toBe(true);

    // Through the gate: the substring impostor is prompted (not auto-run).
    const decision = await gate.resolveCommand("git statusfoo", DEFAULT_MODE, allowlist);
    expect(decision).toBe<ApprovalDecision>("denied");
    expect(confirm.calls).toEqual(["git statusfoo"]);
  });

  // Anchor: REQ-016. Chained/redirected forms NEVER auto-run (ABU-005, INV-010).
  it("test_REQ016_chained_command_never_auto_runs", async () => {
    const allowlist = createAllowlist(ALLOWLIST);

    // Every chaining/redirection metacharacter disqualifies auto-run even when the
    // head token (`git status`, `ls`, `cat`) is itself allowlisted.
    expect(allowlist.isAllowed("git status; rm -rf /")).toBe(false); // ;
    expect(allowlist.isAllowed("git status && curl evil")).toBe(false); // &&
    expect(allowlist.isAllowed("git status || rm x")).toBe(false); // ||
    expect(allowlist.isAllowed("git status | sh")).toBe(false); // |
    expect(allowlist.isAllowed("ls > /etc/passwd")).toBe(false); // >
    expect(allowlist.isAllowed("cat < /etc/shadow")).toBe(false); // <
    expect(allowlist.isAllowed("ls `rm -rf /`")).toBe(false); // backtick
    expect(allowlist.isAllowed("ls $(rm -rf /)")).toBe(false); // $(
    expect(allowlist.isAllowed("git status &")).toBe(false); // backgrounding &
    expect(allowlist.isAllowed("git status\nrm -rf /")).toBe(false); // embedded newline

    // The plain allowlisted command (no metachars) still auto-runs.
    expect(allowlist.isAllowed("git status")).toBe(true);

    // The detector is the single source of truth for the disqualifier.
    expect(isChainedOrRedirected("git status && rm -rf /")).toBe(true);
    expect(isChainedOrRedirected("git status -s")).toBe(false);
  });

  // -------------------------------------------------------------- auto mode ----

  // Anchor: REQ-016. --yes/--auto auto-runs ALL commands without prompting.
  it("test_REQ016_auto_mode_auto_runs_all", async () => {
    const confirm = recordingConfirm("deny");
    const gate = createApprovalGate({ confirmCommand: confirm });
    const allowlist = createAllowlist(ALLOWLIST);

    // Even a non-allowlisted destructive command auto-runs in "auto" mode.
    const decision = await gate.resolveCommand("rm -rf /", AUTO_MODE, allowlist);
    expect(decision).toBe<ApprovalDecision>("auto-approved");
    expect(confirm.calls).toEqual([]); // never prompted
  });

  // Anchor: REQ-016. A user abort at the command prompt is a CLEAN user-abort decision.
  it("test_REQ016_command_abort_is_user_abort", async () => {
    const confirm = recordingConfirm("abort");
    const gate = createApprovalGate({ confirmCommand: confirm });
    const allowlist = createAllowlist(ALLOWLIST);

    const decision = await gate.resolveCommand("rm -rf /", DEFAULT_MODE, allowlist);
    expect(decision).toBe<ApprovalDecision>("user-abort");
  });

  // -------------------------------------------------------- tokenizer guard ----

  it("tokenize honors quotes so a quoted space is one token", () => {
    expect(tokenize('git commit -m "a b c"')).toEqual(["git", "commit", "-m", "a b c"]);
    expect(tokenize("  npm   test  ")).toEqual(["npm", "test"]);
    expect(tokenize("")).toEqual([]);
  });
});

describe("SLICE-5 CommandRunner shell selection (REQ-NFR-007)", () => {
  // Anchor: REQ-NFR-007. Shell selection (cmd vs sh) is contained in CommandRunner,
  // asserted for BOTH platform regimes on a single host WITHOUT spawning a process.
  it("test_REQNFR007_command_runner_shell_selection", () => {
    // Windows regime → cmd.exe with the /d /s /c form carrying the whole command.
    const win = selectShell("win32", "npm test");
    expect(win.file.toLowerCase()).toContain("cmd"); // cmd.exe (or %ComSpec%)
    expect(win.args).toEqual(["/d", "/s", "/c", "npm test"]);

    // POSIX regime (linux/darwin) → sh -c "<command>".
    const posix = selectShell("linux", "npm test");
    expect(posix.file).toBe("/bin/sh");
    expect(posix.args).toEqual(["-c", "npm test"]);

    const darwin = selectShell("darwin", "ls -la");
    expect(darwin.file).toBe("/bin/sh");
    expect(darwin.args).toEqual(["-c", "ls -la"]);

    // The Windows arg form keeps the command as ONE argument (no token splitting),
    // and the POSIX form likewise passes the whole line to `sh -c`.
    const winChained = selectShell("win32", "a && b");
    expect(winChained.args[winChained.args.length - 1]).toBe("a && b");
  });
});
