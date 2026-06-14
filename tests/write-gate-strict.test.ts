/**
 * Strict write-gate mode test suite (G4) — REQ-anchored against
 * spec/write-gate-design.md §State schema change / §Decision ladder step i.
 *
 * `write_gate: "strict"` carries two behaviours on top of the default ladder:
 *   1. It maps to `deny` semantics everywhere the gate fires (like `deny`), so a
 *      Phase-A code write is DENIED rather than ASKED.
 *   2. It additionally gates Phase-B Bash-mediated writes: with implementation
 *      allowed and slices present, a Bash redirection into a path owned solely by
 *      slices that are NOT in-progress is DENIED — the same §16 component-boundary
 *      rule the Write/Edit path enforces. This narrows (but does not close) the
 *      Bash bypass: here-docs, subshells, variable indirection, and globbing are
 *      still not parsed (fail-open).
 *
 * Default modes (`ask`, `deny`, `off`, or absent) leave Phase-B Bash writes
 * ungated, exactly as before strict shipped — those cases are asserted here to
 * lock in the backward-compatible behaviour.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import { runHookPretoolGate, type PreToolHookInput } from "../src/commands/hook";
import { writeState } from "../src/core/state-store";
import { initialState } from "../src/core/state-schema";
import { resolveProjectPaths } from "../src/core/paths";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

// ---------------------------------------------------------------------------
// Helpers (mirror tests/pretool-gate.test.ts)
// ---------------------------------------------------------------------------

function parseOut(out: { stdout: string; exitCode: number }): Record<string, unknown> {
  return JSON.parse(out.stdout) as Record<string, unknown>;
}

function isAllow(out: { stdout: string; exitCode: number }): boolean {
  const j = parseOut(out);
  return Object.keys(j).length === 0;
}

function permissionDecision(out: { stdout: string; exitCode: number }): string | undefined {
  const j = parseOut(out);
  const hso = j["hookSpecificOutput"] as Record<string, unknown> | undefined;
  return hso?.["permissionDecision"] as string | undefined;
}

function permissionReason(out: { stdout: string; exitCode: number }): string | undefined {
  const j = parseOut(out);
  const hso = j["hookSpecificOutput"] as Record<string, unknown> | undefined;
  return hso?.["permissionDecisionReason"] as string | undefined;
}

/** Write a pre-implementation strict state (implementation_allowed=false). */
function writeStrictPreImpl(paths: ReturnType<typeof resolveProjectPaths>, override = {}) {
  writeState(paths, {
    ...initialState(),
    write_gate: "strict",
    current_stage: "stage-05",
    ...override,
  });
}

/** Write a post-implementation strict state (implementation_allowed=true). */
function writeStrictPostImpl(paths: ReturnType<typeof resolveProjectPaths>, override = {}) {
  writeState(paths, {
    ...initialState(),
    write_gate: "strict",
    implementation_allowed: true,
    current_stage: "stage-10",
    ...override,
  });
}

/** Build a Bash input payload for a given command. */
function bashInput(command: string, cwd?: string): PreToolHookInput {
  return { tool_name: "Bash", tool_input: { command }, cwd };
}

// ---------------------------------------------------------------------------
// REQ-WGATE-010: strict gates Phase-B Bash-mediated writes
// ---------------------------------------------------------------------------

describe("REQ-WGATE-010: strict gates Phase-B Bash-mediated writes", () => {
  it("REQ-WGATE-010: strict denies a Phase-B Bash write into a non-in-progress slice", () => {
    tp = makeTempProject();
    // SLICE-1 owns src/api.ts (path-like via forward-slash token) but is pending.
    writeStrictPostImpl(tp.paths, {
      slices: [{ id: "SLICE-1", status: "pending", components: ["src/api.ts"] }],
    });
    const out = runHookPretoolGate(tp.paths, bashInput("echo hi > src/api.ts", tp.root));
    expect(out.exitCode).toBe(0);
    expect(permissionDecision(out)).toBe("deny");
    expect(permissionReason(out)).toContain("SLICE-1");
    expect(permissionReason(out)).toContain("strict");
    expect(permissionReason(out)).toContain("src/api.ts");
  });

  it("REQ-WGATE-010: strict allows a Phase-B Bash write when the owning slice is in-progress", () => {
    tp = makeTempProject();
    writeStrictPostImpl(tp.paths, {
      slices: [{ id: "SLICE-1", status: "in-progress", components: ["src/api.ts"] }],
    });
    const out = runHookPretoolGate(tp.paths, bashInput("echo hi > src/api.ts", tp.root));
    expect(isAllow(out)).toBe(true);
    expect(out.exitCode).toBe(0);
  });

  it("REQ-WGATE-010: strict allows a Phase-B Bash write to a path owned by no slice", () => {
    tp = makeTempProject();
    writeStrictPostImpl(tp.paths, {
      slices: [{ id: "SLICE-1", status: "pending", components: ["src/api.ts"] }],
    });
    // src/other.ts is not owned by SLICE-1 → unowned in-root path → allow.
    const out = runHookPretoolGate(tp.paths, bashInput("echo hi > src/other.ts", tp.root));
    expect(isAllow(out)).toBe(true);
  });

  it("REQ-WGATE-010: strict denies a sed -i Phase-B Bash write into a pending slice", () => {
    tp = makeTempProject();
    writeStrictPostImpl(tp.paths, {
      slices: [{ id: "SLICE-2", status: "done", components: ["src/api.ts"] }],
    });
    const out = runHookPretoolGate(tp.paths, bashInput("sed -i s/a/b/ src/api.ts", tp.root));
    expect(permissionDecision(out)).toBe("deny");
    expect(permissionReason(out)).toContain("SLICE-2");
  });

  it("REQ-WGATE-011: strict + allowlisted doc-path Bash write → allow", () => {
    tp = makeTempProject();
    writeStrictPostImpl(tp.paths, {
      slices: [{ id: "SLICE-1", status: "pending", components: ["src/api.ts"] }],
    });
    // docs/ is on the always-allow doc/state allowlist regardless of phase.
    const out = runHookPretoolGate(tp.paths, bashInput("echo hi > docs/notes.md", tp.root));
    expect(isAllow(out)).toBe(true);
  });

  it("REQ-WGATE-011: strict + Bash write outside project root → allow (fail-open, not our concern)", () => {
    tp = makeTempProject();
    writeStrictPostImpl(tp.paths, {
      slices: [{ id: "SLICE-1", status: "pending", components: ["src/api.ts"] }],
    });
    const out = runHookPretoolGate(tp.paths, bashInput("echo hi > /etc/passwd", tp.root));
    expect(isAllow(out)).toBe(true);
  });

  it("REQ-WGATE-011: strict + Bash command with no write redirection → allow (fail-open)", () => {
    tp = makeTempProject();
    writeStrictPostImpl(tp.paths, {
      slices: [{ id: "SLICE-1", status: "pending", components: ["src/api.ts"] }],
    });
    const out = runHookPretoolGate(tp.paths, bashInput("npm test && ls", tp.root));
    expect(isAllow(out)).toBe(true);
  });

  it("REQ-WGATE-011: strict + implementation_allowed=true but empty slices → allow (no Phase-B universe)", () => {
    tp = makeTempProject();
    writeStrictPostImpl(tp.paths, { slices: [] });
    const out = runHookPretoolGate(tp.paths, bashInput("echo hi > src/api.ts", tp.root));
    expect(isAllow(out)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// REQ-WGATE-012: strict maps to deny semantics on the Write/Edit + Phase-A paths
// ---------------------------------------------------------------------------

describe("REQ-WGATE-012: strict carries deny semantics", () => {
  it("REQ-WGATE-012: strict + Phase A file write → deny (gateMode is deny under strict)", () => {
    tp = makeTempProject();
    writeStrictPreImpl(tp.paths, { current_stage: "stage-05" });
    const input: PreToolHookInput = {
      tool_name: "Write",
      tool_input: { file_path: "src/engine.ts" },
      cwd: tp.root,
    };
    const out = runHookPretoolGate(tp.paths, input);
    expect(out.exitCode).toBe(0);
    expect(permissionDecision(out)).toBe("deny");
  });

  it("REQ-WGATE-012: strict + Phase A Bash-mediated write → deny (Phase-A Bash branch uses gateMode)", () => {
    tp = makeTempProject();
    writeStrictPreImpl(tp.paths, { current_stage: "stage-05" });
    const out = runHookPretoolGate(tp.paths, bashInput("echo hi > src/foo.ts", tp.root));
    expect(permissionDecision(out)).toBe("deny");
  });
});

// ---------------------------------------------------------------------------
// REQ-WGATE-013: default modes leave Phase-B Bash writes ungated (unchanged)
// ---------------------------------------------------------------------------

describe("REQ-WGATE-013: default modes do not gate Phase-B Bash writes (backward-compatible)", () => {
  it("REQ-WGATE-013: default ask (no write_gate) + Phase-B Bash write into pending slice → allow", () => {
    tp = makeTempProject();
    // No write_gate field set → default ask semantics → strict is NOT active.
    writeState(tp.paths, {
      ...initialState(),
      implementation_allowed: true,
      current_stage: "stage-10",
      slices: [{ id: "SLICE-1", status: "pending", components: ["src/api.ts"] }],
    });
    const out = runHookPretoolGate(tp.paths, bashInput("echo hi > src/api.ts", tp.root));
    expect(isAllow(out)).toBe(true);
  });

  it("REQ-WGATE-013: write_gate=deny (not strict) + Phase-B Bash write into pending slice → allow", () => {
    tp = makeTempProject();
    writeState(tp.paths, {
      ...initialState(),
      write_gate: "deny",
      implementation_allowed: true,
      current_stage: "stage-10",
      slices: [{ id: "SLICE-1", status: "pending", components: ["src/api.ts"] }],
    });
    const out = runHookPretoolGate(tp.paths, bashInput("echo hi > src/api.ts", tp.root));
    expect(isAllow(out)).toBe(true);
  });

  it("REQ-WGATE-013: write_gate=off + Phase-B Bash write into pending slice → allow", () => {
    tp = makeTempProject();
    writeState(tp.paths, {
      ...initialState(),
      write_gate: "off",
      implementation_allowed: true,
      current_stage: "stage-10",
      slices: [{ id: "SLICE-1", status: "pending", components: ["src/api.ts"] }],
    });
    const out = runHookPretoolGate(tp.paths, bashInput("echo hi > src/api.ts", tp.root));
    expect(isAllow(out)).toBe(true);
  });

  it("REQ-WGATE-013: strict Phase-B Write/Edit boundary check still ASKs (unchanged), only Bash is deny", () => {
    tp = makeTempProject();
    // The Write/Edit Phase-B component-boundary path fires `ask` regardless of mode
    // (it is a likely-drift signal, not a hard pre-implementation block). Strict does
    // not promote that to deny; only the new Bash branch denies.
    fs.mkdirSync(path.join(tp.root, "src", "engine"), { recursive: true });
    writeStrictPostImpl(tp.paths, {
      slices: [{ id: "SLICE-1", status: "pending", components: ["src/engine"] }],
    });
    const input: PreToolHookInput = {
      tool_name: "Write",
      tool_input: { file_path: "src/engine/index.ts" },
      cwd: tp.root,
    };
    const out = runHookPretoolGate(tp.paths, input);
    expect(permissionDecision(out)).toBe("ask");
  });
});
