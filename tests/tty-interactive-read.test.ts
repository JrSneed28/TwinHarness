/**
 * TTY interactive-read regression — the production fd-0 path of
 * `requireTTYConfirmation` (src/commands/decision.ts).
 *
 * Every other approval test injects `opts.stdinLine`, so the REAL interactive
 * read — the fallback the helper takes when no line is injected — had zero
 * coverage. That path used to be `fs.readFileSync(0, "utf8")`, which reads stdin
 * to EOF: on a controlling TTY pressing Enter does NOT return (it blocks until
 * Ctrl+D / Ctrl+Z) and on the Windows console it throws outright, failing the
 * prompt closed so a legitimate human could never approve. The fix reads fd 0
 * one byte at a time, stops at the first newline, and — critically — RETRIES on
 * EAGAIN instead of treating it as a decline.
 *
 * Two layers of coverage:
 *
 *  A. Line-parsing on a PIPE (`spawnSync` + `input`). These pin the byte-level
 *     semantics (CRLF stripping, EOF-without-newline, decline-on-`n`/empty).
 *     NOTE: a pipe is blocking and closes with EOF, so the OLD `readFileSync(0)`
 *     code also passed these — they guard parsing, NOT the TTY/EAGAIN bug.
 *
 *  B. NON-BLOCKING fd 0 (the real interactive condition). Node flips fd 0 to
 *     O_NONBLOCK the moment the `process.stdin` stream is referenced, after which
 *     `readSync(0)` throws EAGAIN until a byte is available. The child references
 *     `process.stdin`, then calls the helper; the parent writes `y\n` only after
 *     a delay. The fixed helper sleeps-and-retries on EAGAIN and returns ok once
 *     the delayed byte lands; the pre-fix helper (EAGAIN -> "") would decline
 *     immediately. A hard timeout turns any real blocking-to-EOF hang into a
 *     deterministic failure.
 *
 * Mirrors the dist-subprocess + graceful-skip discipline of
 * tests/decision-concurrency.test.ts. CI builds before testing; a local run
 * without a build skips rather than throwing.
 */

import { describe, it, expect } from "vitest";
import { spawnSync, spawn } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";

const DECISION_MOD = path.resolve(__dirname, "../dist/commands/decision.js");
const HAVE_BUILD = fs.existsSync(DECISION_MOD);

/**
 * Run the real interactive path in a child process over a PIPE: `isTTY:true`
 * (barrier 1 satisfied) and NO injected stdinLine, so it reads the supplied
 * bytes from fd 0. A 5s timeout turns a blocking-to-EOF hang into a failure.
 */
function confirmWithStdin(input: string): { ok: boolean; error?: string } {
  const script = `
    const { requireTTYConfirmation } = require(${JSON.stringify(DECISION_MOD)});
    const r = requireTTYConfirmation("DECISION-001", "approve", { isTTY: true });
    process.stdout.write(JSON.stringify({ ok: r.ok, error: r.error }));
  `;
  const out = spawnSync(process.execPath, ["-e", script], {
    input,
    encoding: "utf8",
    timeout: 5000,
  });
  if (out.error) throw out.error; // e.g. ETIMEDOUT if the read hung
  return JSON.parse(out.stdout);
}

/**
 * Drive the helper against a NON-BLOCKING fd 0 (the real interactive shape).
 * The child references `process.stdin` so Node flips fd 0 to O_NONBLOCK, then
 * calls the helper; the parent writes `input` only after `delayMs`, so the
 * helper's first reads hit EAGAIN before any byte exists. Uses async `spawn`
 * (a delayed write is impossible with spawnSync's all-at-once `input`).
 */
function confirmDelayedNonblocking(
  input: string,
  delayMs = 250,
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve, reject) => {
    const script = `
      // Reference process.stdin so Node flips fd 0 to O_NONBLOCK (the condition
      // that makes a real interactive readSync throw EAGAIN). Stays paused, so
      // it does not consume bytes; the helper reads fd 0 directly via readSync.
      void process.stdin.isTTY;
      const { requireTTYConfirmation } = require(${JSON.stringify(DECISION_MOD)});
      const r = requireTTYConfirmation("DECISION-001", "approve", { isTTY: true });
      process.stdout.write(JSON.stringify({ ok: r.ok, error: r.error }));
    `;
    const child = spawn(process.execPath, ["-e", script], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    let out = "";
    const killer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("interactive read hung (blocked to EOF?)"));
    }, 5000);
    child.stdout.on("data", (d) => (out += String(d)));
    child.on("error", reject);
    child.on("close", () => {
      clearTimeout(killer);
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error(`child produced no parseable result: ${JSON.stringify(out)}`));
      }
    });
    setTimeout(() => {
      child.stdin.write(input);
      child.stdin.end();
    }, delayMs);
  });
}

describe.skipIf(!HAVE_BUILD)("TTY interactive read — production fd-0 path", () => {
  // ---- A. line-parsing on a pipe (parsing semantics only) ----
  it("returns ok on `y` + newline and stops at the line (does not consume leftovers)", () => {
    // Trailing bytes after the newline must NOT change the result and must NOT hang.
    expect(confirmWithStdin("y\nLEFTOVER\n")).toEqual({ ok: true });
  });

  it("strips a trailing CR (CRLF line ending)", () => {
    expect(confirmWithStdin("y\r\n")).toEqual({ ok: true });
  });

  it("accepts `yes` with no trailing newline (terminated by EOF)", () => {
    expect(confirmWithStdin("yes")).toEqual({ ok: true });
  });

  it("declines on `n`", () => {
    expect(confirmWithStdin("n\n")).toEqual({ ok: false, error: "confirmation_declined" });
  });

  it("declines (fail-closed) on empty stdin / immediate EOF", () => {
    expect(confirmWithStdin("")).toEqual({ ok: false, error: "confirmation_declined" });
  });

  // ---- B. non-blocking fd 0 — the actual TTY/Windows-console failure mode ----
  // This is the discriminating case: the pre-fix helper returned "" on EAGAIN
  // (decline), so a legitimate human could never approve. The fixed helper
  // retries on EAGAIN and returns ok once the delayed byte arrives.
  it("tolerates a non-blocking fd 0: waits for delayed input rather than declining on EAGAIN", async () => {
    expect(await confirmDelayedNonblocking("y\n")).toEqual({ ok: true });
  });

  it("declines a delayed `n` on a non-blocking fd 0 (still fails closed on a real no)", async () => {
    expect(await confirmDelayedNonblocking("n\n")).toEqual({
      ok: false,
      error: "confirmation_declined",
    });
  });
});
