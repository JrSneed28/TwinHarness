/**
 * Phase B / AC #1 — the `th proof …` CLI command group dispatches against the
 * REAL compiled `dist/cli.js` (no mocks). Proves the proof subcommands resolve,
 * the new flags are recognized, and the bad-args guard still rejects typos. The
 * full self-test run is exercised at the engine level (proof-self-test.test.ts);
 * here we only assert CLI dispatch wiring against fast, side-effect-free paths.
 */
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it, expect } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const CLI = path.join(ROOT, "dist", "cli.js");

function runCli(args: string[]): { status: number | null; stdout: string } {
  const r = spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, TH_NO_LOG: "1" },
  });
  return { status: r.status, stdout: r.stdout };
}

describe("REQ-PROOF-CLI: `th proof` command group dispatches against dist/cli.js", () => {
  it("help enumerates the proof commands", () => {
    const r = runCli(["help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("th proof run");
    expect(r.stdout).toContain("th proof component");
    expect(r.stdout).toContain("th proof scenario start");
  });

  it("`proof scenario list` dispatches (sync) and returns a valid JSON envelope (exit 0)", () => {
    const r = runCli(["proof", "scenario", "list", "--json"]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as { ok: boolean; scenarios?: unknown };
    expect(parsed.ok).toBe(true);
    expect(Array.isArray(parsed.scenarios)).toBe(true);
  });

  it("the `--self-test` flag is recognized (not rejected as an unknown flag)", () => {
    // A bogus component fails with `unknown_component` — NOT a bad-args/unknown-flag
    // error — which proves `--self-test` parsed through the proof dispatch path.
    const r = runCli(["proof", "component", "bogus", "--self-test", "--json"]);
    expect(r.status).not.toBe(0);
    const parsed = JSON.parse(r.stdout) as { ok: boolean; error?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe("unknown_component");
  });

  it("an unknown `proof` subcommand is rejected with guidance", () => {
    const r = runCli(["proof", "bogus-sub"]);
    expect(r.status).not.toBe(0);
    expect(r.stdout.toLowerCase()).toContain("unknown 'proof' subcommand");
  });

  it("an unknown flag on a proof command is still rejected (bad-args guard intact)", () => {
    const r = runCli(["proof", "scenario", "list", "--totally-unknown"]);
    expect(r.status).not.toBe(0);
    expect(r.stdout.toLowerCase()).toContain("unknown flag");
  });
});
