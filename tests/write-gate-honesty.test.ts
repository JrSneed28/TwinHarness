/**
 * Phase 6 (#18, P6-7) — write-gate honesty signal.
 *
 * The write-gate is a GUARDRAIL for a compliant agent, not a security sandbox.
 * These tests pin the honesty surfacing: `th doctor` states the caveat; setting
 * `write_gate: "strict"` echoes the caveat; and under strict mode a write-SHAPED
 * Bash command whose target was metachar/variable-obscured is surfaced as `ask`
 * (not a silent allow) — while default modes keep the historical silent allow.
 */

import { describe, it, expect, afterEach } from "vitest";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { runDoctor } from "../src/commands/doctor";
import { runStateSet } from "../src/commands/state";
import { writeState } from "../src/core/state-store";
import { initialState } from "../src/core/state-schema";
import { runHookPretoolGate, bashWriteTargetWasDropped, type PreToolHookInput } from "../src/commands/hook";

let tp: TempProject | undefined;
afterEach(() => {
  tp?.cleanup();
  tp = undefined;
});

interface Check {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}
const byName = (data: unknown, name: string): Check | undefined =>
  (data as { checks: Check[] }).checks.find((c) => c.name === name);

function parseOut(out: { stdout: string; exitCode: number }): Record<string, unknown> {
  return JSON.parse(out.stdout) as Record<string, unknown>;
}
function permissionDecision(out: { stdout: string; exitCode: number }): string | undefined {
  const o = parseOut(out);
  const h = o.hookSpecificOutput as { permissionDecision?: string } | undefined;
  return h?.permissionDecision;
}
function isAllow(out: { stdout: string; exitCode: number }): boolean {
  return out.stdout === "{}";
}

describe("REQ-WGATE-HONESTY-001 (P6-7): th doctor states the guardrail-not-sandbox caveat", () => {
  it("a write-gate check is present and names guardrail, not sandbox", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const res = runDoctor(tp.paths);
    const wg = byName(res.data, "write gate");
    expect(wg).toBeDefined();
    expect(wg!.detail).toContain("GUARDRAIL");
    expect(wg!.detail).toContain("NOT a security sandbox");
  });
});

describe("REQ-WGATE-HONESTY-002 (P6-7): setting write_gate=strict echoes the caveat", () => {
  it("th state set write_gate strict surfaces the not-a-sandbox note", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    // write_gate is gate-owned → requires --emergency for a raw set; the honesty
    // caveat still fires (and is independent of the emergency banner).
    const res = runStateSet(tp.paths, "write_gate", "strict", { emergency: true });
    expect(res.ok).toBe(true);
    expect(res.data?.writeGateCaveat).toBe(true);
    expect(res.human).toContain("not a security sandbox");
  });
});

describe("REQ-WGATE-HONESTY-003 (P6-7): strict-mode ASK on a metachar-obscured write target", () => {
  it("bashWriteTargetWasDropped flags a write-shape with a dropped metachar target", () => {
    expect(bashWriteTargetWasDropped("echo hi > $f")).toBe(true);
    expect(bashWriteTargetWasDropped("tee $OUT")).toBe(true);
    // A concrete literal target is NOT a drop; a pure read is NOT a drop.
    expect(bashWriteTargetWasDropped("echo hi > src/foo.ts")).toBe(false);
    expect(bashWriteTargetWasDropped("npm test")).toBe(false);
  });

  it("strict mode + Phase A + `echo hi > $f` → ask (surfaced, not silently allowed)", () => {
    tp = makeTempProject();
    writeState(tp.paths, { ...initialState(), current_stage: "stage-05", write_gate: "strict" });
    const input: PreToolHookInput = {
      tool_name: "Bash",
      tool_input: { command: "echo hi > $f" },
      cwd: tp.root,
    };
    const out = runHookPretoolGate(tp.paths, input);
    expect(permissionDecision(out)).toBe("ask");
    expect(parseOut(out).hookSpecificOutput).toBeDefined();
  });

  it("default mode + Phase A + `echo hi > $f` → allow (historical M-4 contract preserved)", () => {
    tp = makeTempProject();
    writeState(tp.paths, { ...initialState(), current_stage: "stage-05" });
    const input: PreToolHookInput = {
      tool_name: "Bash",
      tool_input: { command: "echo hi > $f" },
      cwd: tp.root,
    };
    const out = runHookPretoolGate(tp.paths, input);
    expect(isAllow(out)).toBe(true);
  });
});
