/**
 * SG3 P1-B (C-11), audit P1 — the delegate allowed-files scope must REACH the
 * out-of-process PreToolUse write-gate.
 *
 * Before the fix, `th delegate pack --allowed-files` only RETURNED the scope in its
 * result; nothing persisted it, and the installed hook reads only host stdin (which
 * carries no `allowed_files`), so enforcement never activated. The fix ARMS a durable
 * scope (`.twinharness/delegation-scope.json`) that `runHookPretoolGate` reads and that
 * the SubagentStop hook clears.
 */

import { describe, it, expect, afterEach } from "vitest";
import { makeTempProject, type TempProject } from "./helpers";
import { writeState } from "../src/core/state-store";
import { initialState } from "../src/core/state-schema";
import {
  writeDelegationScope,
  readDelegationScope,
  clearDelegationScope,
  delegationScopePath,
} from "../src/core/delegation-scope";
import { runHookPretoolGate, runHookSubagentStop, type PreToolHookInput } from "../src/commands/hook";
import { runDelegatePack } from "../src/commands/delegate";
import * as fs from "node:fs";

let tp: TempProject | undefined;
afterEach(() => {
  tp?.cleanup();
  tp = undefined;
});

function decision(out: { stdout: string }): string | undefined {
  const hso = (JSON.parse(out.stdout) as Record<string, unknown>)["hookSpecificOutput"] as Record<string, unknown> | undefined;
  return hso?.["permissionDecision"] as string | undefined;
}
function reason(out: { stdout: string }): string {
  const hso = (JSON.parse(out.stdout) as Record<string, unknown>)["hookSpecificOutput"] as Record<string, unknown> | undefined;
  return (hso?.["permissionDecisionReason"] as string | undefined) ?? "";
}
function isAllow(out: { stdout: string }): boolean {
  return Object.keys(JSON.parse(out.stdout) as Record<string, unknown>).length === 0;
}

/** A Phase-B (implementation allowed), no-slice state so an in-scope code write is allowed. */
function seedPhaseB(t: TempProject): void {
  writeState(t.paths, { ...initialState(), implementation_allowed: true, current_stage: "implementation", slices: [] });
}

function writeInput(filePath: string, root: string): PreToolHookInput {
  return { tool_name: "Write", tool_input: { file_path: filePath }, cwd: root };
}

describe("delegation-scope persistence round-trip", () => {
  it("write arms a non-empty scope; read returns it; empty disarms (removes the file)", () => {
    tp = makeTempProject();
    seedPhaseB(tp);

    writeDelegationScope(tp.paths, ["src/auth", "src/db/conn.ts"], { agent: "builder", slice: "SLICE-1" });
    expect(fs.existsSync(delegationScopePath(tp.paths))).toBe(true);
    const got = readDelegationScope(tp.paths);
    expect(got.allowedFiles).toEqual(["src/auth", "src/db/conn.ts"]);
    expect(got.agent).toBe("builder");

    // Empty list disarms.
    writeDelegationScope(tp.paths, []);
    expect(fs.existsSync(delegationScopePath(tp.paths))).toBe(false);
    expect(readDelegationScope(tp.paths).allowedFiles).toEqual([]);
  });

  it("a corrupt scope file reads as empty (no-op), never throws", () => {
    tp = makeTempProject();
    seedPhaseB(tp);
    fs.writeFileSync(delegationScopePath(tp.paths), "}{ not json", "utf8");
    expect(readDelegationScope(tp.paths).allowedFiles).toEqual([]);
  });
});

describe("PreToolUse write-gate enforces the PERSISTED delegate scope (the wiring fix)", () => {
  it("DENIES an in-root write OUTSIDE the armed scope", () => {
    tp = makeTempProject();
    seedPhaseB(tp);
    writeDelegationScope(tp.paths, ["src/auth"], {});

    const out = runHookPretoolGate(tp.paths, writeInput("src/other/x.ts", tp.root));
    expect(decision(out)).toBe("deny");
    expect(reason(out)).toContain("delegate scope");
  });

  it("ALLOWS a write INSIDE the armed scope (the C-11 rung does not fire)", () => {
    tp = makeTempProject();
    seedPhaseB(tp);
    writeDelegationScope(tp.paths, ["src/auth"], {});

    const out = runHookPretoolGate(tp.paths, writeInput("src/auth/login.ts", tp.root));
    // Phase B + no slices ⇒ unowned ⇒ allow; the scope rung must not have denied it.
    expect(isAllow(out)).toBe(true);
  });

  it("with NO armed scope, gating is unchanged (in-root code write is not scope-denied)", () => {
    tp = makeTempProject();
    seedPhaseB(tp);
    const out = runHookPretoolGate(tp.paths, writeInput("src/anything/x.ts", tp.root));
    expect(reason(out)).not.toContain("delegate scope");
  });

  it("the scope also applies to a parseable Bash-mediated write (C-11 Bash rung)", () => {
    tp = makeTempProject();
    seedPhaseB(tp);
    writeDelegationScope(tp.paths, ["src/auth"], {});
    const out = runHookPretoolGate(tp.paths, {
      tool_name: "Bash",
      tool_input: { command: "echo x > src/other/y.ts" },
      cwd: tp.root,
    });
    expect(decision(out)).toBe("deny");
    expect(reason(out)).toContain("delegate scope");
  });
});

describe("SubagentStop clears the armed scope (delegation lifecycle)", () => {
  it("a subagent stopping disarms the scope so it cannot leak onto later writes", () => {
    tp = makeTempProject();
    seedPhaseB(tp);
    writeDelegationScope(tp.paths, ["src/auth"], {});
    expect(fs.existsSync(delegationScopePath(tp.paths))).toBe(true);

    runHookSubagentStop(tp.paths, {});
    expect(fs.existsSync(delegationScopePath(tp.paths))).toBe(false);

    // After clearing, an out-of-(former-)scope write is no longer scope-denied.
    const out = runHookPretoolGate(tp.paths, writeInput("src/other/x.ts", tp.root));
    expect(reason(out)).not.toContain("delegate scope");
  });
});

describe("th delegate pack emits the normalized scope the CLI persists", () => {
  it("data.allowedFiles is the deduped/trimmed list (what the CLI arms)", () => {
    tp = makeTempProject();
    const res = runDelegatePack(tp.paths, { agent: "builder", allowedFiles: [" src/auth ", "src/auth", "src/db.ts", ""] });
    expect(res.ok).toBe(true);
    expect(res.data!.allowedFiles).toEqual(["src/auth", "src/db.ts"]);
    // Sanity: arming with that list then reading back matches.
    clearDelegationScope(tp.paths);
    writeDelegationScope(tp.paths, res.data!.allowedFiles as string[], {});
    expect(readDelegationScope(tp.paths).allowedFiles).toEqual(["src/auth", "src/db.ts"]);
  });
});
