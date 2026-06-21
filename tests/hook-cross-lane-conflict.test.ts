/**
 * CROSS-LANE (F1<->F5) fail-open closure — asserted at the integration base.
 *
 * With Phase-1's `canCompleteRun` Stop wiring AND Phase-3-F5's valid-state-FILE selection
 * both in-tree, a root with NO valid state (a both-exist location conflict, OR a no-safe-
 * location conflict) must yield a NON-completing verdict through the Stop / SubagentStop
 * gates — NOT `block:false` (a silent allow) and NOT an uncaught crash.
 *
 * The trap this pins: the hooks resolve project paths at their entry, and F5's
 * `resolveProjectPaths` THROWS a `StateLocationConflictError` on an ambiguous/unsafe state
 * LOCATION. Without the cross-lane catch that throw escapes as an uncaught crash (non-zero
 * exit, NO JSON decision) — which a strict hook consumer reads as a fail-OPEN. The
 * `runHook*FromRoot` wrappers catch it and emit a fail-safe decision (block / deny).
 *
 * Fail-before (HEAD, pre-Phase-1/3): a both-exist root resolved to ONE valid location
 * silently and the Stop path returned `{block:false}` (complete) — a silent allow.
 * Pass-after: the location is a hard conflict the Stop gate surfaces as a BLOCK.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { serializeState, initialState } from "../src/core/state-schema";
import {
  runHookStopGateFromRoot,
  runHookSubagentStopFromRoot,
  runHookPretoolGateFromRoot,
} from "../src/commands/hook";

let tmp: string | undefined;
afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

function mkroot(label: string): string {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), `th-xlane-${label}-`));
  const root = path.join(tmp, "proj");
  fs.mkdirSync(root, { recursive: true });
  return root;
}
function writeValidState(root: string, dir: string): void {
  const d = path.join(root, dir);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "state.json"), serializeState(initialState()), "utf8");
}
function writeInvalidState(root: string, dir: string): void {
  const d = path.join(root, dir);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "state.json"), '{ "tier": "NOT-A-TIER"', "utf8"); // unparseable
}

/** Parse a Stop-hook decision payload: returns the `decision` field (or undefined = allow). */
function stopDecision(out: { stdout: string }): string | undefined {
  return (JSON.parse(out.stdout) as Record<string, unknown>)["decision"] as string | undefined;
}
function preToolDecision(out: { stdout: string }): string | undefined {
  const hso = (JSON.parse(out.stdout) as Record<string, unknown>)["hookSpecificOutput"] as Record<string, unknown> | undefined;
  return hso?.["permissionDecision"] as string | undefined;
}

describe("CROSS-LANE F1<->F5: a both-VALID location conflict is a NON-completing Stop verdict", () => {
  it("Stop gate BLOCKS (not complete, not a crash) on a both-exist (both-valid) root", () => {
    const root = mkroot("both-valid");
    writeValidState(root, ".twinharness");
    writeValidState(root, ".agentic-sdlc");

    // Must NOT throw (no uncaught crash) and must NOT be `complete` (an empty allow {}).
    const out = runHookStopGateFromRoot(root, {});
    expect(stopDecision(out)).toBe("block"); // verdict != complete
    expect(out.exitCode).toBe(0); // a clean decision, not a crash
    expect(out.stdout).toContain("ambiguous");
  });

  it("SubagentStop gate BLOCKS on a both-exist (both-valid) root", () => {
    const root = mkroot("both-valid-sub");
    writeValidState(root, ".twinharness");
    writeValidState(root, ".agentic-sdlc");

    const out = runHookSubagentStopFromRoot(root, {});
    expect(stopDecision(out)).toBe("block");
    expect(out.exitCode).toBe(0);
  });

  it("PreToolUse gate DENIES (fail-closed) on a both-exist (both-valid) root", () => {
    const root = mkroot("both-valid-pre");
    writeValidState(root, ".twinharness");
    writeValidState(root, ".agentic-sdlc");

    const out = runHookPretoolGateFromRoot(root, { tool_name: "Write", tool_input: { file_path: "src/x.ts" }, cwd: root });
    expect(preToolDecision(out)).toBe("deny");
    expect(out.exitCode).toBe(0);
  });

  it("PreToolUse fail-closed still honors the TH_DISABLE_WRITE_GATE escape hatch", () => {
    const root = mkroot("both-valid-escape");
    writeValidState(root, ".twinharness");
    writeValidState(root, ".agentic-sdlc");

    const out = runHookPretoolGateFromRoot(
      root,
      { tool_name: "Write", tool_input: { file_path: "src/x.ts" }, cwd: root },
      { TH_DISABLE_WRITE_GATE: "1" },
    );
    expect(Object.keys(JSON.parse(out.stdout) as Record<string, unknown>)).toHaveLength(0); // allow {}
  });
});

describe("CROSS-LANE F1<->F5: a no-safe-location conflict (both present-but-invalid) is non-completing", () => {
  it("Stop gate BLOCKS on a both-present-but-invalid root (no fail-open onto a fresh project)", () => {
    const root = mkroot("both-invalid");
    writeInvalidState(root, ".twinharness");
    writeInvalidState(root, ".agentic-sdlc");

    const out = runHookStopGateFromRoot(root, {});
    expect(stopDecision(out)).toBe("block"); // != complete; the conflict is surfaced, not allowed
    expect(out.exitCode).toBe(0);
  });
});

describe("CROSS-LANE F1<->F5: a single present-but-INVALID state (no location conflict) still blocks", () => {
  // Not a LOCATION conflict (no throw) — this routes through the normal decision path, which
  // Phase-3-F5 selects to the present-but-invalid location so the present-but-invalid Stop
  // path BLOCKS (repair first). Pins that a no-valid-state root is non-completing via the
  // ordinary path too (the F1 closure), complementing the throw path above.
  it("Stop gate BLOCKS when the only state file is present-but-invalid", () => {
    const root = mkroot("single-invalid");
    writeInvalidState(root, ".twinharness");

    const out = runHookStopGateFromRoot(root, {});
    expect(stopDecision(out)).toBe("block");
    expect(out.exitCode).toBe(0);
  });
});
