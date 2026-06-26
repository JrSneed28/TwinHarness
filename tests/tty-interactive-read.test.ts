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
 * one byte at a time and stops at the first newline.
 *
 * These tests spawn the COMPILED handler (dist/commands/decision.js), feed real
 * bytes on the child's stdin pipe, and assert:
 *   1. `y` + newline + trailing bytes → ok:true, and the call RETURNS (a hard
 *      timeout proves it did not block reading to EOF).
 *   2. CRLF (`y\r\n`) → ok:true (the carriage return is stripped).
 *   3. `yes` with NO trailing newline, terminated by EOF → ok:true.
 *   4. `n` → confirmation_declined; empty stdin (immediate EOF) → declined
 *      (fail-closed).
 *
 * Mirrors the dist-subprocess + graceful-skip discipline of
 * tests/decision-concurrency.test.ts. CI builds before testing; a local run
 * without a build skips rather than throwing.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";

const DECISION_MOD = path.resolve(__dirname, "../dist/commands/decision.js");
const HAVE_BUILD = fs.existsSync(DECISION_MOD);

/**
 * Run the real interactive path in a child process: `requireTTYConfirmation`
 * with `isTTY:true` (barrier 1 satisfied) and NO injected stdinLine, so it reads
 * the supplied bytes from fd 0. A 5s timeout turns the old EOF-blocking bug into
 * a deterministic failure instead of a hang.
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
  if (out.error) throw out.error; // e.g. ETIMEDOUT if the read blocked to EOF
  return JSON.parse(out.stdout);
}

describe.skipIf(!HAVE_BUILD)("TTY interactive read — production fd-0 path", () => {
  it("returns ok on `y` + newline and stops at the line (does not block to EOF)", () => {
    // Trailing bytes after the newline must NOT be consumed and must NOT hang.
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
});
