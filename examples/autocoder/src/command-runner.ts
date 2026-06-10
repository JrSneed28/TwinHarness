/**
 * IF-007 CommandRunner (DI seam — LOCKED) — the shell/process boundary (REQ-009,
 * REQ-NFR-002, REQ-NFR-007). Owner component: `command-runner`.
 *
 * This seam SPAWNS ONLY. It performs NO policy and NO confinement logic — the cwd is
 * already confirmed inside the root by `path-sandbox` and the command is already
 * approved by `approval-gate` upstream (RULE-001/005). Its single job is to run a
 * command line in a cwd with a timeout and capture `{exitCode, stdout, stderr,
 * timedOut}`. A non-zero exit code is a VALID result, NOT an error (ADR-007).
 *
 * Cross-platform shell selection (REQ-NFR-007) is contained HERE and nowhere else:
 *   - Windows  → `cmd.exe /d /s /c "<command>"`
 *   - POSIX    → `sh -c "<command>"`
 * The selection is a PURE function (`selectShell`) parameterized over a platform
 * string, so a single host can unit-test BOTH regimes WITHOUT spawning a real
 * process (`test_REQNFR007_command_runner_shell_selection`).
 *
 * The actual process launch is an INJECTABLE seam (`spawn`) so the suite drives the
 * runner with a deterministic stub — no real subprocess in tests (RULE-015,
 * REQ-NFR-002). The default seam binds `child_process.spawn`; a spawn failure
 * (executable not found, etc.) surfaces as a resolved result the caller maps to
 * COMMAND_FAILED, and a timeout surfaces as `timedOut:true` (caller → COMMAND_TIMEOUT).
 */
import { spawn as nodeSpawn } from "node:child_process";
import process from "node:process";
import type { CommandResult, CommandRunner } from "./contracts.js";

/** The shell invocation the runner spawns: an executable plus its argv. */
export interface ShellInvocation {
  /** The shell executable (`cmd.exe` on Windows, `sh` elsewhere). */
  file: string;
  /** The argv passed to the shell (the `-c` / `/c` form carrying the command). */
  args: string[];
}

/**
 * PURE cross-platform shell selection (REQ-NFR-007). Given a platform id (the value
 * of `process.platform`) and the command line, return the `{file, args}` to spawn.
 * Windows uses `cmd.exe /d /s /c`; every other platform uses `sh -c`. Exposed for
 * direct unit testing of BOTH regimes on a single host (no real subprocess).
 */
export function selectShell(platform: string, command: string): ShellInvocation {
  if (platform === "win32") {
    // `/d` skips AutoRun, `/s` + quoting keeps the whole command as one argument,
    // `/c` runs the command and exits. This is the Node-default Windows shell form.
    return { file: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", command] };
  }
  return { file: "/bin/sh", args: ["-c", command] };
}

/** A spawned child's observable surface — the minimal slice the runner needs. */
export interface SpawnedChild {
  /** stdout stream emitting `data` chunks (Buffer | string). */
  stdout: { on(event: "data", cb: (chunk: unknown) => void): void } | null;
  /** stderr stream emitting `data` chunks (Buffer | string). */
  stderr: { on(event: "data", cb: (chunk: unknown) => void): void } | null;
  /** Lifecycle events: `close` (exit/exit-code), `error` (spawn failure). */
  on(event: "close", cb: (code: number | null, signal: string | null) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  /** Kill the process (used at the timeout). */
  kill(signal?: string): void;
}

/** The injectable process-launch seam (default binds `child_process.spawn`). */
export type SpawnFn = (
  file: string,
  args: string[],
  options: { cwd: string },
) => SpawnedChild;

/** Dependencies for the CommandRunner. All optional — defaults bind the live host. */
export interface CommandRunnerDeps {
  /** Process-launch seam (default: `child_process.spawn`). Stubbed in tests. */
  spawn?: SpawnFn;
  /** Platform id for shell selection (default: `process.platform`). */
  platform?: string;
}

/** The default spawn seam: launch a real OS process (production only). */
const defaultSpawn: SpawnFn = (file, args, options) =>
  nodeSpawn(file, args, {
    cwd: options.cwd,
    // The shell selection is done explicitly (selectShell), so DO NOT also ask
    // child_process to wrap in a shell — that would double-wrap the command.
    shell: false,
    windowsHide: true,
  }) as unknown as SpawnedChild;

/**
 * Build a CommandRunner. The runner resolves (never rejects) for the two expected
 * non-success outcomes: a timeout (→ `timedOut:true`) and a spawn failure (→ a
 * sentinel `exitCode: -1` result the caller maps to COMMAND_FAILED). A genuinely
 * unexpected fault is left to propagate (handled as fatal by `agent-run`).
 */
export function createCommandRunner(deps: CommandRunnerDeps = {}): CommandRunner {
  const spawn = deps.spawn ?? defaultSpawn;
  const platform = deps.platform ?? process.platform;

  return {
    run(command: string, cwd: string, timeoutMs: number): Promise<CommandResult> {
      const { file, args } = selectShell(platform, command);

      return new Promise<CommandResult>((resolve, reject) => {
        let child: SpawnedChild;
        try {
          child = spawn(file, args, { cwd });
        } catch (err) {
          // A synchronous spawn throw (rare) is still a spawn failure, not fatal:
          // mark `spawnFailed` so the caller maps it to COMMAND_FAILED (ERR-010).
          resolve({
            exitCode: -1,
            stdout: "",
            stderr: (err as Error).message,
            timedOut: false,
            spawnFailed: true,
          });
          return;
        }

        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let settled = false;

        const timer = setTimeout(() => {
          timedOut = true;
          // Kill the process; the `close` handler resolves with timedOut:true.
          try {
            child.kill("SIGKILL");
          } catch {
            // Best-effort kill; the close/error handler still settles the promise.
          }
        }, timeoutMs);

        const settle = (result: CommandResult): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        };

        child.stdout?.on("data", (chunk) => {
          stdout += String(chunk);
        });
        child.stderr?.on("data", (chunk) => {
          stderr += String(chunk);
        });

        child.on("error", (err) => {
          // An async spawn failure (ENOENT etc.) → `spawnFailed:true` so the caller
          // maps it to COMMAND_FAILED (ERR-010). This is NOT a process that ran and
          // exited non-zero; it never started — the distinction the caller needs.
          settle({
            exitCode: -1,
            stdout,
            stderr: stderr.length > 0 ? stderr : err.message,
            timedOut: false,
            spawnFailed: true,
          });
        });

        child.on("close", (code) => {
          if (settled) return;
          // A normal exit (any code, including non-zero) OR a kill at the timeout.
          settle({
            exitCode: timedOut ? -1 : code ?? 0,
            stdout,
            stderr,
            timedOut,
          });
        });

        // `reject` is retained for genuinely unexpected faults; the expected
        // outcomes above all resolve. Nothing currently rejects, but keeping the
        // parameter makes the unexpected-fault path explicit if ever needed.
        void reject;
      });
    },
  };
}

/** The COMMAND_FAILED spawn-failure sentinel exit code (caller maps it to ERR-010). */
export const SPAWN_FAILED_EXIT_CODE = -1;
