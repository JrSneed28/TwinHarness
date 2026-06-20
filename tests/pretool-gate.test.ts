/**
 * PreToolUse write-gate test suite — REQ-anchored against spec/write-gate-design.md.
 *
 * Test matrix mirrors the design doc §Test matrix:
 *   no state → allow
 *   TH_DISABLE_WRITE_GATE=1 / write_gate off → allow
 *   invalid state → allow + systemMessage warning
 *   doc paths → allow in all phases
 *   code path pre-implementation → ask (deny when configured)
 *   Tier-0 (implementation_allowed immediately true) → never fires
 *   mid-build write inside in-progress slice → allow
 *   mid-build write to pending/done slice's path-like component → ask
 *   abstract component names → no Phase-B effect
 *   legacy .agentic-sdlc projects → identical behaviour
 *   reason text contains stage + unlock path
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import {
  runHookPretoolGate,
  extractBashWriteTargets,
  type PreToolHookInput,
} from "../src/commands/hook";
import { writeState } from "../src/core/state-store";
import { initialState, serializeState } from "../src/core/state-schema";
import { resolveProjectPaths } from "../src/core/paths";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

// ---------------------------------------------------------------------------
// Helpers
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

function systemMessage(out: { stdout: string; exitCode: number }): string | undefined {
  const j = parseOut(out);
  return j["systemMessage"] as string | undefined;
}

/** Write a pre-implementation state (implementation_allowed=false). */
function writePreImplState(paths: ReturnType<typeof resolveProjectPaths>, override = {}) {
  writeState(paths, { ...initialState(), current_stage: "stage-05", ...override });
}

/** Write a post-implementation state (implementation_allowed=true). */
function writePostImplState(paths: ReturnType<typeof resolveProjectPaths>, override = {}) {
  writeState(paths, {
    ...initialState(),
    implementation_allowed: true,
    current_stage: "stage-10",
    ...override,
  });
}

/** Build an input payload for a given file path. */
function inputFor(filePath: string, cwd?: string): PreToolHookInput {
  return { tool_name: "Write", tool_input: { file_path: filePath }, cwd };
}

// ---------------------------------------------------------------------------
// REQ-WGATE-001: fast-path allows (no state / bypass / invalid)
// ---------------------------------------------------------------------------

describe("REQ-WGATE-001: fast-path allow cases", () => {
  it("no state.json → allow", () => {
    tp = makeTempProject();
    const out = runHookPretoolGate(tp.paths, inputFor("src/index.ts"));
    expect(isAllow(out)).toBe(true);
    expect(out.exitCode).toBe(0);
  });

  it("TH_DISABLE_WRITE_GATE=1 → allow (before reading state)", () => {
    tp = makeTempProject();
    writePreImplState(tp.paths);
    const out = runHookPretoolGate(tp.paths, inputFor("src/index.ts"), {
      TH_DISABLE_WRITE_GATE: "1",
    });
    expect(isAllow(out)).toBe(true);
  });

  it("write_gate=off in state → allow", () => {
    tp = makeTempProject();
    writePreImplState(tp.paths, { write_gate: "off" });
    const out = runHookPretoolGate(tp.paths, inputFor("src/index.ts"));
    expect(isAllow(out)).toBe(true);
  });

  it("invalid state.json → allow + systemMessage warning", () => {
    tp = makeTempProject();
    fs.mkdirSync(tp.paths.stateDir, { recursive: true });
    fs.writeFileSync(tp.paths.stateFile, "{ not valid json", "utf8");
    const out = runHookPretoolGate(tp.paths, inputFor("src/index.ts"));
    expect(isAllow(out)).toBe(false); // Has a systemMessage key.
    expect(systemMessage(out)).toBeTruthy();
    expect(systemMessage(out)).toContain("standing down");
    expect(out.exitCode).toBe(0);
  });

  it("no tool_input.file_path → allow", () => {
    tp = makeTempProject();
    writePreImplState(tp.paths);
    const out = runHookPretoolGate(tp.paths, { tool_name: "Write", tool_input: {} });
    expect(isAllow(out)).toBe(true);
  });

  it("no input at all → allow", () => {
    tp = makeTempProject();
    writePreImplState(tp.paths);
    const out = runHookPretoolGate(tp.paths, undefined);
    expect(isAllow(out)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// REQ-WGATE-002: allowlist paths (doc/state territory)
// ---------------------------------------------------------------------------

describe("REQ-WGATE-002: allowlist paths always allowed", () => {
  const docPaths = [
    "docs/01-requirements.md",
    "docs/subdir/foo.md",
    ".twinharness/custom.json",
    ".agentic-sdlc/state.json",
    ".claude/settings.json",
    "drift-log.md",
    ".gitignore",
    "README.md",
    "CHANGELOG.md",
    "my-notes.md",
  ];

  for (const p of docPaths) {
    it(`allows ${p} in pre-implementation phase`, () => {
      tp = makeTempProject();
      writePreImplState(tp.paths);
      const out = runHookPretoolGate(tp.paths, inputFor(p, tp.root));
      expect(isAllow(out)).toBe(true);
    });
  }

  it("allows docs/ paths in Phase B (post-implementation)", () => {
    tp = makeTempProject();
    writePostImplState(tp.paths, {
      slices: [{ id: "SLICE-1", status: "pending", components: ["src/"] }],
    });
    const out = runHookPretoolGate(tp.paths, inputFor("docs/design.md", tp.root));
    expect(isAllow(out)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// REQ-WGATE-003: Phase A — pre-implementation gating
// ---------------------------------------------------------------------------

describe("REQ-WGATE-003: Phase A — pre-implementation gating", () => {
  it("code path with implementation_allowed=false → ask (default)", () => {
    tp = makeTempProject();
    writePreImplState(tp.paths, { current_stage: "stage-05" });
    const out = runHookPretoolGate(tp.paths, inputFor("src/core/engine.ts", tp.root));
    expect(out.exitCode).toBe(0);
    expect(permissionDecision(out)).toBe("ask");
  });

  it("reason text includes current_stage", () => {
    tp = makeTempProject();
    writePreImplState(tp.paths, { current_stage: "stage-07" });
    const out = runHookPretoolGate(tp.paths, inputFor("src/a.ts", tp.root));
    expect(permissionReason(out)).toContain("stage-07");
  });

  it("reason text includes the target path", () => {
    tp = makeTempProject();
    writePreImplState(tp.paths, { current_stage: "stage-05" });
    const out = runHookPretoolGate(tp.paths, inputFor("src/a.ts", tp.root));
    expect(permissionReason(out)).toContain("src/a.ts");
  });

  it("reason text mentions implementation_allowed", () => {
    tp = makeTempProject();
    writePreImplState(tp.paths);
    const out = runHookPretoolGate(tp.paths, inputFor("src/a.ts", tp.root));
    expect(permissionReason(out)).toContain("implementation_allowed");
  });

  it("reason text contains the unlock path (th state set implementation_allowed true)", () => {
    tp = makeTempProject();
    writePreImplState(tp.paths);
    const out = runHookPretoolGate(tp.paths, inputFor("src/a.ts", tp.root));
    expect(permissionReason(out)).toContain("implementation_allowed true");
  });

  it("reason text contains the TH_DISABLE_WRITE_GATE escape hatch", () => {
    tp = makeTempProject();
    writePreImplState(tp.paths);
    const out = runHookPretoolGate(tp.paths, inputFor("src/a.ts", tp.root));
    expect(permissionReason(out)).toContain("TH_DISABLE_WRITE_GATE");
  });

  it("reason text contains escalate instruction", () => {
    tp = makeTempProject();
    writePreImplState(tp.paths);
    const out = runHookPretoolGate(tp.paths, inputFor("src/a.ts", tp.root));
    expect(permissionReason(out)?.toLowerCase()).toContain("escalate");
  });

  it("write_gate=deny → deny in Phase A", () => {
    tp = makeTempProject();
    writePreImplState(tp.paths, { write_gate: "deny" });
    const out = runHookPretoolGate(tp.paths, inputFor("src/a.ts", tp.root));
    expect(permissionDecision(out)).toBe("deny");
  });

  it("write_gate=ask → ask in Phase A (explicit)", () => {
    tp = makeTempProject();
    writePreImplState(tp.paths, { write_gate: "ask" });
    const out = runHookPretoolGate(tp.paths, inputFor("src/a.ts", tp.root));
    expect(permissionDecision(out)).toBe("ask");
  });

  it("always exits 0", () => {
    tp = makeTempProject();
    writePreImplState(tp.paths);
    const out = runHookPretoolGate(tp.paths, inputFor("src/a.ts", tp.root));
    expect(out.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// REQ-WGATE-004: Tier-0 (implementation_allowed=true immediately) — never fires
// ---------------------------------------------------------------------------

describe("REQ-WGATE-004: Tier-0 / implementation_allowed=true with no slices → never fires", () => {
  it("allows any code path when implementation_allowed=true and slices is empty", () => {
    tp = makeTempProject();
    writePostImplState(tp.paths, { slices: [] });
    const out = runHookPretoolGate(tp.paths, inputFor("src/engine.ts", tp.root));
    expect(isAllow(out)).toBe(true);
  });

  it("allows even tests/ paths with implementation_allowed=true and empty slices", () => {
    tp = makeTempProject();
    writePostImplState(tp.paths, { slices: [] });
    const out = runHookPretoolGate(tp.paths, inputFor("tests/engine.test.ts", tp.root));
    expect(isAllow(out)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// REQ-WGATE-005: Phase B — slice-boundary enforcement
// ---------------------------------------------------------------------------

describe("REQ-WGATE-005: Phase B — component-boundary enforcement", () => {
  it("target under a path-like component of a pending slice → ask, names the slice", () => {
    tp = makeTempProject();
    // Create the component dir so it resolves as path-like.
    fs.mkdirSync(path.join(tp.root, "src", "engine"), { recursive: true });
    writePostImplState(tp.paths, {
      slices: [{ id: "SLICE-1", status: "pending", components: ["src/engine"] }],
    });
    const out = runHookPretoolGate(tp.paths, inputFor("src/engine/index.ts", tp.root));
    expect(permissionDecision(out)).toBe("ask");
    expect(permissionReason(out)).toContain("SLICE-1");
    expect(permissionReason(out)).toContain("pending");
  });

  it("target under a path-like component of a done slice → ask", () => {
    tp = makeTempProject();
    fs.mkdirSync(path.join(tp.root, "src", "engine"), { recursive: true });
    writePostImplState(tp.paths, {
      slices: [{ id: "SLICE-2", status: "done", components: ["src/engine"] }],
    });
    const out = runHookPretoolGate(tp.paths, inputFor("src/engine/core.ts", tp.root));
    expect(permissionDecision(out)).toBe("ask");
  });

  it("same path with that slice in-progress → allow", () => {
    tp = makeTempProject();
    fs.mkdirSync(path.join(tp.root, "src", "engine"), { recursive: true });
    writePostImplState(tp.paths, {
      slices: [{ id: "SLICE-1", status: "in-progress", components: ["src/engine"] }],
    });
    const out = runHookPretoolGate(tp.paths, inputFor("src/engine/index.ts", tp.root));
    expect(isAllow(out)).toBe(true);
  });

  it("path owned by no slice → allow", () => {
    tp = makeTempProject();
    fs.mkdirSync(path.join(tp.root, "src", "utils"), { recursive: true });
    writePostImplState(tp.paths, {
      slices: [{ id: "SLICE-1", status: "pending", components: ["src/engine"] }],
    });
    // src/utils is not owned by SLICE-1.
    const out = runHookPretoolGate(tp.paths, inputFor("src/utils/helper.ts", tp.root));
    expect(isAllow(out)).toBe(true);
  });

  it("path-like component with forward-slash in token → path-like without disk check", () => {
    tp = makeTempProject();
    // No directory created — the token itself contains "/" so it is path-like.
    writePostImplState(tp.paths, {
      slices: [{ id: "SLICE-3", status: "pending", components: ["src/api"] }],
    });
    const out = runHookPretoolGate(tp.paths, inputFor("src/api/routes.ts", tp.root));
    expect(permissionDecision(out)).toBe("ask");
    expect(permissionReason(out)).toContain("SLICE-3");
  });

  it("abstract component names (e.g. SyncEngine) → no Phase-B effect → allow", () => {
    tp = makeTempProject();
    writePostImplState(tp.paths, {
      slices: [{ id: "SLICE-4", status: "pending", components: ["SyncEngine", "UI"] }],
    });
    // "SyncEngine" has no slash and doesn't exist on disk → abstract, ignored.
    const out = runHookPretoolGate(tp.paths, inputFor("src/sync.ts", tp.root));
    expect(isAllow(out)).toBe(true);
  });

  it("reason text contains escalate instruction in Phase B", () => {
    tp = makeTempProject();
    writePostImplState(tp.paths, {
      slices: [{ id: "SLICE-5", status: "pending", components: ["src/sync"] }],
    });
    const out = runHookPretoolGate(tp.paths, inputFor("src/sync/main.ts", tp.root));
    expect(permissionReason(out)?.toLowerCase()).toContain("escalate");
  });

  it("Phase B gate always exits 0", () => {
    tp = makeTempProject();
    writePostImplState(tp.paths, {
      slices: [{ id: "SLICE-6", status: "pending", components: ["src/"] }],
    });
    const out = runHookPretoolGate(tp.paths, inputFor("src/foo.ts", tp.root));
    expect(out.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// REQ-WGATE-006: path resolution edge cases
// ---------------------------------------------------------------------------

describe("REQ-WGATE-006: path resolution edge cases", () => {
  it("absolute path outside project root → allow", () => {
    tp = makeTempProject();
    writePreImplState(tp.paths);
    // Use an absolute path that is definitely outside the temp root.
    const externalPath = path.resolve(tp.root, "..", "other-project", "src", "foo.ts");
    const out = runHookPretoolGate(tp.paths, inputFor(externalPath, tp.root));
    expect(isAllow(out)).toBe(true);
  });

  it("relative path resolved against payload cwd", () => {
    tp = makeTempProject();
    writePreImplState(tp.paths, { current_stage: "stage-05" });
    // Provide cwd = project root; file_path is relative.
    const out = runHookPretoolGate(
      tp.paths,
      { tool_name: "Write", tool_input: { file_path: "src/index.ts" }, cwd: tp.root },
    );
    expect(permissionDecision(out)).toBe("ask");
  });

  it("absolute path inside project root is gated (Phase A)", () => {
    tp = makeTempProject();
    writePreImplState(tp.paths);
    const absPath = path.join(tp.root, "src", "main.ts");
    const out = runHookPretoolGate(tp.paths, inputFor(absPath, tp.root));
    expect(permissionDecision(out)).toBe("ask");
  });
});

// ---------------------------------------------------------------------------
// REQ-WGATE-008: NotebookEdit — notebook_path is read by the write-gate
// ---------------------------------------------------------------------------

describe("REQ-WGATE-008: NotebookEdit tool uses notebook_path, not file_path", () => {
  it("Phase A: notebook_path to an implementation path → gate FIRES (ask)", () => {
    tp = makeTempProject();
    writePreImplState(tp.paths, { current_stage: "stage-05" });
    const input: PreToolHookInput = {
      tool_name: "NotebookEdit",
      tool_input: { notebook_path: "src/analysis.ipynb" },
      cwd: tp.root,
    };
    const out = runHookPretoolGate(tp.paths, input);
    expect(out.exitCode).toBe(0);
    expect(permissionDecision(out)).toBe("ask");
  });

  it("Phase A: notebook_path under docs/ → allow (doc allowlist)", () => {
    tp = makeTempProject();
    writePreImplState(tp.paths, { current_stage: "stage-05" });
    const input: PreToolHookInput = {
      tool_name: "NotebookEdit",
      tool_input: { notebook_path: "docs/exploration.ipynb" },
      cwd: tp.root,
    };
    const out = runHookPretoolGate(tp.paths, input);
    expect(isAllow(out)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// REQ-WGATE-009: Phase A Bash-mediated write defense-in-depth
// ---------------------------------------------------------------------------

describe("REQ-WGATE-009: Phase A Bash-mediated write defense-in-depth", () => {
  it("Phase A + echo redirect into src/ → gate FIRES (ask)", () => {
    tp = makeTempProject();
    writePreImplState(tp.paths, { current_stage: "stage-05" });
    const input: PreToolHookInput = {
      tool_name: "Bash",
      tool_input: { command: "echo hi > src/foo.ts" },
      cwd: tp.root,
    };
    const out = runHookPretoolGate(tp.paths, input);
    expect(out.exitCode).toBe(0);
    expect(permissionDecision(out)).toBe("ask");
  });

  it("Phase A + echo redirect into docs/ → allow (doc allowlist)", () => {
    tp = makeTempProject();
    writePreImplState(tp.paths, { current_stage: "stage-05" });
    const input: PreToolHookInput = {
      tool_name: "Bash",
      tool_input: { command: "echo hi > docs/notes.md" },
      cwd: tp.root,
    };
    const out = runHookPretoolGate(tp.paths, input);
    expect(isAllow(out)).toBe(true);
  });

  it("Phase A + no write redirection → allow (fail-open)", () => {
    tp = makeTempProject();
    writePreImplState(tp.paths, { current_stage: "stage-05" });
    const input: PreToolHookInput = {
      tool_name: "Bash",
      tool_input: { command: "npm test && ls" },
      cwd: tp.root,
    };
    const out = runHookPretoolGate(tp.paths, input);
    expect(isAllow(out)).toBe(true);
  });

  it("Phase A + redirect to /etc/passwd (outside root) → allow (fail-open, not our concern)", () => {
    tp = makeTempProject();
    writePreImplState(tp.paths, { current_stage: "stage-05" });
    const input: PreToolHookInput = {
      tool_name: "Bash",
      tool_input: { command: "echo hi > /etc/passwd" },
      cwd: tp.root,
    };
    const out = runHookPretoolGate(tp.paths, input);
    expect(isAllow(out)).toBe(true);
  });

  it("Phase B (implementation_allowed=true) + echo redirect into src/ → allow (no Bash gating in Phase B)", () => {
    tp = makeTempProject();
    writePostImplState(tp.paths, {
      slices: [{ id: "SLICE-1", status: "in-progress", components: ["src/"] }],
    });
    const input: PreToolHookInput = {
      tool_name: "Bash",
      tool_input: { command: "echo hi > src/foo.ts" },
      cwd: tp.root,
    };
    const out = runHookPretoolGate(tp.paths, input);
    expect(isAllow(out)).toBe(true);
  });

  it("write_gate=deny + Phase A + sed -i on src/foo.ts → fires with deny", () => {
    tp = makeTempProject();
    writePreImplState(tp.paths, { current_stage: "stage-05", write_gate: "deny" });
    const input: PreToolHookInput = {
      tool_name: "Bash",
      tool_input: { command: "sed -i s/a/b/ src/foo.ts" },
      cwd: tp.root,
    };
    const out = runHookPretoolGate(tp.paths, input);
    expect(out.exitCode).toBe(0);
    expect(permissionDecision(out)).toBe("deny");
  });

  // M-4: copy/move family destination heuristic + metachar false-positive guard.
  it("Phase A + cp into src/ → gate FIRES (ask) [M-4 copy-command dest]", () => {
    tp = makeTempProject();
    writePreImplState(tp.paths, { current_stage: "stage-05" });
    const input: PreToolHookInput = {
      tool_name: "Bash",
      tool_input: { command: "cp templates/base.ts src/foo.ts" },
      cwd: tp.root,
    };
    const out = runHookPretoolGate(tp.paths, input);
    expect(out.exitCode).toBe(0);
    expect(permissionDecision(out)).toBe("ask");
  });

  it("Phase A + touch on an impl path → gate FIRES (ask) [M-4]", () => {
    tp = makeTempProject();
    writePreImplState(tp.paths, { current_stage: "stage-05" });
    const input: PreToolHookInput = {
      tool_name: "Bash",
      tool_input: { command: "touch src/new.ts" },
      cwd: tp.root,
    };
    const out = runHookPretoolGate(tp.paths, input);
    expect(permissionDecision(out)).toBe("ask");
  });

  it("Phase A + mv into src/ (chained after a build) → gate FIRES (ask) [M-4 per-segment]", () => {
    tp = makeTempProject();
    writePreImplState(tp.paths, { current_stage: "stage-05" });
    const input: PreToolHookInput = {
      tool_name: "Bash",
      tool_input: { command: "npm run build && mv build/out.js src/bundle.ts" },
      cwd: tp.root,
    };
    const out = runHookPretoolGate(tp.paths, input);
    expect(permissionDecision(out)).toBe("ask");
  });

  it("Phase A + redirect to a metachar target ($f) → no false-positive (allow) [M-4]", () => {
    tp = makeTempProject();
    writePreImplState(tp.paths, { current_stage: "stage-05" });
    const input: PreToolHookInput = {
      tool_name: "Bash",
      tool_input: { command: "echo hi > $f" },
      cwd: tp.root,
    };
    const out = runHookPretoolGate(tp.paths, input);
    expect(isAllow(out)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// REQ-WGATE-007: legacy .agentic-sdlc project — identical behaviour
// ---------------------------------------------------------------------------

describe("REQ-WGATE-007: legacy .agentic-sdlc project — identical behaviour", () => {
  it("gates a code path in a legacy project (pre-implementation)", () => {
    tp = makeTempProject();
    // Scaffold a legacy project: write state.json directly into .agentic-sdlc
    // so that resolveProjectPaths detects the legacy dir when called next.
    const legacyDir = path.join(tp.root, ".agentic-sdlc");
    fs.mkdirSync(legacyDir, { recursive: true });
    const legacyState = { ...initialState(), current_stage: "stage-03" };
    // Write state.json manually so the file exists before resolveProjectPaths runs.
    fs.writeFileSync(path.join(legacyDir, "state.json"), serializeState(legacyState), "utf8");

    // Now resolveProjectPaths should detect .agentic-sdlc.
    const legacyPaths = resolveProjectPaths(tp.root);
    expect(legacyPaths.stateDir).toContain(".agentic-sdlc");

    const out = runHookPretoolGate(legacyPaths, inputFor("src/legacy.ts", tp.root));
    expect(permissionDecision(out)).toBe("ask");
    expect(permissionReason(out)).toContain("stage-03");
  });

  it("allows doc paths in a legacy project", () => {
    tp = makeTempProject();
    const legacyDir = path.join(tp.root, ".agentic-sdlc");
    fs.mkdirSync(legacyDir, { recursive: true });
    const legacyState = { ...initialState() };
    fs.writeFileSync(path.join(legacyDir, "state.json"), serializeState(legacyState), "utf8");

    const legacyPaths = resolveProjectPaths(tp.root);
    const out = runHookPretoolGate(legacyPaths, inputFor("docs/spec.md", tp.root));
    expect(isAllow(out)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// BYPASS-KNOWN regression suite (TEST-007)
//
// Each case documents a deliberate fail-open in the write-gate decision ladder
// (spec/write-gate-design.md §Decision ladder). The label "BYPASS-KNOWN-*"
// makes it easy to grep for all intentional bypasses and catch a future
// half-parse regression that accidentally promotes one into a hard block.
//
// Contract: isAllow(out) must remain true for every case below. A test
// failure here means a previously-documented safe bypass now fires the gate,
// which is a regression.
// ---------------------------------------------------------------------------

describe("BYPASS-KNOWN: documented fail-open cases must stay isAllow===true", () => {
  // BYPASS-KNOWN-A: no state.json → gate has no opinion; non-TH projects unaffected.
  it("BYPASS-KNOWN-A: no state.json → allow", () => {
    tp = makeTempProject();
    // No init, no state file written.
    const out = runHookPretoolGate(tp.paths, inputFor("src/index.ts"));
    expect(isAllow(out)).toBe(true);
    expect(out.exitCode).toBe(0);
  });

  // BYPASS-KNOWN-B: TH_DISABLE_WRITE_GATE=1 is the documented emergency escape hatch.
  it("BYPASS-KNOWN-B: TH_DISABLE_WRITE_GATE=1 → allow (escape hatch, checked before reading state)", () => {
    tp = makeTempProject();
    writePreImplState(tp.paths);
    const out = runHookPretoolGate(tp.paths, inputFor("src/index.ts"), {
      TH_DISABLE_WRITE_GATE: "1",
    });
    expect(isAllow(out)).toBe(true);
  });

  // BYPASS-KNOWN-C: write_gate=off is the operator-declared "gate inactive" mode.
  it("BYPASS-KNOWN-C: write_gate=off → allow (operator declared gate inactive)", () => {
    tp = makeTempProject();
    writePreImplState(tp.paths, { write_gate: "off" });
    const out = runHookPretoolGate(tp.paths, inputFor("src/index.ts"));
    expect(isAllow(out)).toBe(true);
  });

  // BYPASS-KNOWN-D: no file_path in tool_input → gate cannot determine a target; fail-open.
  it("BYPASS-KNOWN-D: no tool_input.file_path → allow (gate cannot determine target)", () => {
    tp = makeTempProject();
    writePreImplState(tp.paths);
    const out = runHookPretoolGate(tp.paths, { tool_name: "Write", tool_input: {} });
    expect(isAllow(out)).toBe(true);
  });

  // BYPASS-KNOWN-E: no input at all → gate has nothing to evaluate; fail-open.
  it("BYPASS-KNOWN-E: no input at all → allow (nothing to evaluate)", () => {
    tp = makeTempProject();
    writePreImplState(tp.paths);
    const out = runHookPretoolGate(tp.paths, undefined);
    expect(isAllow(out)).toBe(true);
  });

  // BYPASS-KNOWN-F: target outside project root → not TH's concern; fail-open.
  it("BYPASS-KNOWN-F: absolute path outside project root → allow (not our concern)", () => {
    tp = makeTempProject();
    writePreImplState(tp.paths);
    const externalPath = path.resolve(tp.root, "..", "other-project", "src", "foo.ts");
    const out = runHookPretoolGate(tp.paths, inputFor(externalPath, tp.root));
    expect(isAllow(out)).toBe(true);
  });

  // BYPASS-KNOWN-G: doc/state allowlist paths are always allowed in all phases.
  it("BYPASS-KNOWN-G: docs/ path in Phase A → allow (doc/state allowlist)", () => {
    tp = makeTempProject();
    writePreImplState(tp.paths);
    const out = runHookPretoolGate(tp.paths, inputFor("docs/01-requirements.md", tp.root));
    expect(isAllow(out)).toBe(true);
  });

  // BYPASS-KNOWN-H: Bash with no write redirection in Phase A → fail-open (no offending target).
  it("BYPASS-KNOWN-H: Phase A Bash with no write redirection → allow (fail-open, no target found)", () => {
    tp = makeTempProject();
    writePreImplState(tp.paths, { current_stage: "stage-05" });
    const out = runHookPretoolGate(tp.paths, {
      tool_name: "Bash",
      tool_input: { command: "npm test && ls -la" },
      cwd: tp.root,
    });
    expect(isAllow(out)).toBe(true);
  });

  // BYPASS-KNOWN-I: Phase B with implementation_allowed + slice in-progress → allow.
  it("BYPASS-KNOWN-I: Phase B write into an in-progress slice's component → allow", () => {
    tp = makeTempProject();
    fs.mkdirSync(path.join(tp.root, "src", "engine"), { recursive: true });
    writePostImplState(tp.paths, {
      slices: [{ id: "SLICE-1", status: "in-progress", components: ["src/engine"] }],
    });
    const out = runHookPretoolGate(tp.paths, inputFor("src/engine/index.ts", tp.root));
    expect(isAllow(out)).toBe(true);
  });

  // BYPASS-KNOWN-J: Phase B with implementation_allowed + path owned by no slice → allow.
  it("BYPASS-KNOWN-J: Phase B write to an unowned path → allow (no slice claims this path)", () => {
    tp = makeTempProject();
    writePostImplState(tp.paths, {
      slices: [{ id: "SLICE-1", status: "pending", components: ["src/engine"] }],
    });
    const out = runHookPretoolGate(tp.paths, inputFor("src/utils/helper.ts", tp.root));
    expect(isAllow(out)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// REQ-WGATE-009: extractBashWriteTargets operand heuristic (security regression)
// ---------------------------------------------------------------------------

describe("extractBashWriteTargets: touch flags every operand, dest-last cmds flag only the last", () => {
  it("touch treats every non-flag arg as a write target", () => {
    expect(extractBashWriteTargets("touch src/a.ts src/b.ts")).toEqual(
      expect.arrayContaining(["src/a.ts", "src/b.ts"]),
    );
  });

  it("cp flags only the destination (last arg), not the source", () => {
    const targets = extractBashWriteTargets("cp a.ts dst.ts");
    expect(targets).toEqual(expect.arrayContaining(["dst.ts"]));
    expect(targets).not.toContain("a.ts");
  });
});

// ---------------------------------------------------------------------------
// REQ-WGATE-010 (P1/R-02): the verify approval anchors are NOT silently writable
// by a tool call — verify.json / verify-approvals.jsonl are gated in BOTH phases,
// even though the rest of the state dir is doc/state-allowlisted. This closes the
// "forge an approval around the write-gate" vector (the records authorize which
// commands `th verify run` executes).
// ---------------------------------------------------------------------------

describe("REQ-WGATE-010: verify approval anchors are gated, not allowlisted", () => {
  const anchors = [".twinharness/verify.json", ".twinharness/verify-approvals.jsonl"];

  for (const anchor of anchors) {
    it(`pre-implementation: a Write to ${anchor} is gated (ask in default mode)`, () => {
      tp = makeTempProject();
      writePreImplState(tp.paths); // default write_gate (ask)
      const out = runHookPretoolGate(tp.paths, inputFor(anchor, tp.root));
      expect(isAllow(out)).toBe(false);
      expect(permissionDecision(out)).toBe("ask");
      expect(permissionReason(out)).toContain("verify approval anchor");
    });

    it(`deny mode: a Write to ${anchor} is DENIED`, () => {
      tp = makeTempProject();
      writePreImplState(tp.paths, { write_gate: "deny" });
      const out = runHookPretoolGate(tp.paths, inputFor(anchor, tp.root));
      expect(permissionDecision(out)).toBe("deny");
    });

    it(`Phase B (post-implementation): a Write to ${anchor} is STILL gated (phase-independent)`, () => {
      tp = makeTempProject();
      writePostImplState(tp.paths, {
        slices: [{ id: "SLICE-1", status: "in-progress", components: ["src/"] }],
      });
      const out = runHookPretoolGate(tp.paths, inputFor(anchor, tp.root));
      expect(isAllow(out)).toBe(false);
      expect(permissionDecision(out)).toBe("ask");
    });
  }

  it("a non-anchor file in the same state dir (.twinharness/custom.json) stays allowed", () => {
    tp = makeTempProject();
    writePreImplState(tp.paths);
    const out = runHookPretoolGate(tp.paths, inputFor(".twinharness/custom.json", tp.root));
    expect(isAllow(out)).toBe(true);
  });

  it("the legacy .agentic-sdlc state dir gates its verify.json too", () => {
    // The anchor is derived from paths.stateDir, so it holds for either dir name.
    // A project whose stateDir basename is .agentic-sdlc resolves the anchor there.
    tp = makeTempProject();
    writePreImplState(tp.paths);
    const stateRel = path.basename(tp.paths.stateDir);
    const out = runHookPretoolGate(tp.paths, inputFor(`${stateRel}/verify.json`, tp.root));
    expect(isAllow(out)).toBe(false);
    expect(permissionDecision(out)).toBe("ask");
  });
});
