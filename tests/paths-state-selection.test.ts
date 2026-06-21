/**
 * R-34 / finding F5 — state-location selection by VALID state-FILE presence, with
 * a both-exist HARD CONFLICT and NO fail-open.
 *
 * The resolver must select the location that has a VALID `state.json` FILE — never
 * a mere directory. The fail-open vector being closed: a `.twinharness` directory
 * that holds only `templates/` (no `state.json`) used to be picked as "the project"
 * while the real run lived in the legacy `.agentic-sdlc` location.
 *
 * Selection parity: CLI (`resolveProjectPaths`), the hook path (also
 * `resolveProjectPaths` via `resolveHookPaths`), and MCP (`resolvePathsForCall` →
 * `resolveProjectPaths`) all route through the ONE shared resolver, so the same
 * input yields the same selection on every surface.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  resolveProjectPaths,
  resolveStateCandidates,
  StateLocationConflictError,
} from "../src/core/paths";
import { resolvePathsForCall, callTool } from "../src/mcp-server";
import { initialState, serializeState } from "../src/core/state-schema";
import { runStateAdopt } from "../src/commands/state";

let tmp: string | undefined;
afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
  delete process.env.CLAUDE_PROJECT_DIR;
});

const real = (p: string): string => fs.realpathSync.native(p);

/** Write a VALID `state.json` under `<root>/<dir>`. */
function writeValidState(root: string, dir: string): void {
  const d = path.join(root, dir);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "state.json"), serializeState(initialState()), "utf8");
}

/** Write a present-but-INVALID `state.json` under `<root>/<dir>`. */
function writeInvalidState(root: string, dir: string): void {
  const d = path.join(root, dir);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "state.json"), '{ "tier": "NOT-A-TIER"', "utf8"); // unparseable
}

function mkroot(label: string): string {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), `th-f5-${label}-`));
  const root = path.join(tmp, "proj");
  fs.mkdirSync(root, { recursive: true });
  return root;
}

describe("R-34 / F5 — select by valid state FILE (not directory existence)", () => {
  it("legacy state present + EMPTY .twinharness dir → LEGACY selected", () => {
    const root = mkroot("legacy-empty-new");
    writeValidState(root, ".agentic-sdlc");
    fs.mkdirSync(path.join(root, ".twinharness"), { recursive: true }); // empty — no state.json

    const paths = resolveProjectPaths(root);
    expect(paths.stateDir).toBe(path.join(real(root), ".agentic-sdlc"));
  });

  it("legacy state present + .twinharness/templates but NO state.json → LEGACY selected", () => {
    const root = mkroot("legacy-templates-only");
    writeValidState(root, ".agentic-sdlc");
    fs.mkdirSync(path.join(root, ".twinharness", "templates"), { recursive: true });
    fs.writeFileSync(path.join(root, ".twinharness", "templates", "x.md"), "# t", "utf8");

    const paths = resolveProjectPaths(root);
    expect(paths.stateDir).toBe(path.join(real(root), ".agentic-sdlc"));
  });

  it("only .twinharness/state.json valid → .twinharness selected", () => {
    const root = mkroot("new-only");
    writeValidState(root, ".twinharness");

    const paths = resolveProjectPaths(root);
    expect(paths.stateDir).toBe(path.join(real(root), ".twinharness"));
  });

  it("no state file anywhere → fresh project defaults to .twinharness", () => {
    const root = mkroot("fresh");
    const paths = resolveProjectPaths(root);
    expect(paths.stateDir).toBe(path.join(real(root), ".twinharness"));
  });
});

describe("R-34 / F5 — both-exist HARD CONFLICT (no silent pick)", () => {
  it("BOTH locations valid → throws state_location_conflict with a recovery pointer", () => {
    const root = mkroot("both-valid");
    writeValidState(root, ".twinharness");
    writeValidState(root, ".agentic-sdlc");

    let thrown: unknown;
    try {
      resolveProjectPaths(root);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(StateLocationConflictError);
    const err = thrown as StateLocationConflictError;
    expect(err.code).toBe("state_location_conflict");
    expect(err.kind).toBe("both-valid");
    // The error points at the MUTATING recovery command (not th doctor).
    expect(err.message).toContain("th state adopt");
    expect(err.message).toContain(".twinharness");
    expect(err.message).toContain(".agentic-sdlc");
  });
});

describe("R-34 / F5 — both INVALID → clear error, NOT fail-open", () => {
  it("both locations present-but-invalid → throws (no fall-back to a fresh untracked project)", () => {
    const root = mkroot("both-invalid");
    writeInvalidState(root, ".twinharness");
    writeInvalidState(root, ".agentic-sdlc");

    let thrown: unknown;
    try {
      resolveProjectPaths(root);
    } catch (e) {
      thrown = e;
    }
    // Assert it did NOT fail open (would have returned paths with stateDir=.twinharness).
    expect(thrown).toBeInstanceOf(StateLocationConflictError);
    expect((thrown as StateLocationConflictError).kind).toBe("no-valid-location");
    expect((thrown as StateLocationConflictError).message).toContain("Refusing to fail open");
  });

  it("a SINGLE present-but-invalid .twinharness/state.json does NOT throw (selection unambiguous; existing diagnose/block path runs)", () => {
    // Regression guard: F5 must NOT break the existing "present but INVALID" handling
    // for a lone corrupt file — selection is unambiguous (that location), `readState`
    // reports `{exists:true, issues}`, doctor reports it, and the gates BLOCK. Only a
    // genuine both-invalid ambiguity (no safe location) is a hard error.
    const root = mkroot("single-invalid");
    writeInvalidState(root, ".twinharness");

    const paths = resolveProjectPaths(root);
    expect(paths.stateDir).toBe(path.join(real(root), ".twinharness"));
  });
});

describe("R-34 / F5 — hook / CLI / MCP selection parity", () => {
  it("the CLI resolver and the MCP resolver agree on the selected location (legacy fallback case)", () => {
    const root = mkroot("parity-legacy");
    writeValidState(root, ".agentic-sdlc");
    fs.mkdirSync(path.join(root, ".twinharness"), { recursive: true }); // empty

    // CLI / hook path: resolveProjectPaths(root).
    const cli = resolveProjectPaths(root);
    // MCP path: resolvePathsForCall reads CLAUDE_PROJECT_DIR → resolveProjectPaths.
    process.env.CLAUDE_PROJECT_DIR = root;
    const mcp = resolvePathsForCall();

    expect(mcp.stateDir).toBe(cli.stateDir);
    expect(mcp.stateFile).toBe(cli.stateFile);
    expect(mcp.root).toBe(cli.root);
    expect(cli.stateDir).toBe(path.join(real(root), ".agentic-sdlc"));
  });

  it("the CLI resolver and the MCP resolver agree on the HARD CONFLICT (both surfaces throw the same token)", () => {
    const root = mkroot("parity-conflict");
    writeValidState(root, ".twinharness");
    writeValidState(root, ".agentic-sdlc");

    // CLI / hook path throws.
    expect(() => resolveProjectPaths(root)).toThrow(StateLocationConflictError);

    // MCP path throws the SAME conflict (same shared resolver → same selection).
    process.env.CLAUDE_PROJECT_DIR = root;
    let mcpThrown: unknown;
    try {
      resolvePathsForCall();
    } catch (e) {
      mcpThrown = e;
    }
    expect(mcpThrown).toBeInstanceOf(StateLocationConflictError);
    expect((mcpThrown as StateLocationConflictError).code).toBe("state_location_conflict");
  });

  // P2 regression (PR #27): the MCP surface must report the SAME exit code the CLI
  // does for this client-correctable conflict. `mapDispatchError` maps it to exit 2;
  // `toToolResult` exposes the envelope exitCode in `structuredContent.exitCode`, so
  // a default `failure()` (exit 1) here would silently diverge from the CLI taxonomy.
  it("the MCP tool surfaces structuredContent.exitCode === 2 for the conflict (CLI parity)", async () => {
    const root = mkroot("mcp-exitcode");
    writeValidState(root, ".twinharness");
    writeValidState(root, ".agentic-sdlc");
    process.env.CLAUDE_PROJECT_DIR = root;

    // th_state_get has no required args, so it passes arg-validation and reaches
    // resolvePathsForCall, which throws the shared conflict the handler maps.
    const res = await callTool("th_state_get", {});
    expect(res.isError).toBe(true);
    const sc = res.structuredContent as { exitCode?: number; error?: string };
    expect(sc.exitCode).toBe(2);
    expect(sc.error).toBe("state_location_conflict");
  });
});

describe("R-34 / F5 — `th state adopt` resolves a both-valid conflict (mutating recovery)", () => {
  it("adopt --twinharness retires the legacy state.json so the next resolve selects .twinharness", () => {
    const root = mkroot("adopt-new");
    writeValidState(root, ".twinharness");
    writeValidState(root, ".agentic-sdlc");

    // Pre-condition: the conflict is live.
    expect(() => resolveProjectPaths(root)).toThrow(StateLocationConflictError);

    // Recover via the mutating command (operates on conflict-tolerant candidates).
    const candidates = resolveStateCandidates(root);
    const r = runStateAdopt(candidates, "twinharness");
    expect(r.ok).toBe(true);
    expect((r.data as { adopted?: string }).adopted).toBe("twinharness");

    // The legacy state.json is retired (renamed to a backup), not hard-deleted.
    expect(fs.existsSync(path.join(real(root), ".agentic-sdlc", "state.json"))).toBe(false);
    const backups = fs
      .readdirSync(path.join(real(root), ".agentic-sdlc"))
      .filter((n) => n.startsWith("state.json.retired-"));
    expect(backups.length).toBe(1);

    // The conflict is resolved → the next resolve selects .twinharness cleanly.
    const after = resolveProjectPaths(root);
    expect(after.stateDir).toBe(path.join(real(root), ".twinharness"));
  });

  it("adopt --legacy retires the .twinharness state.json so the next resolve selects legacy", () => {
    const root = mkroot("adopt-legacy");
    writeValidState(root, ".twinharness");
    writeValidState(root, ".agentic-sdlc");

    const candidates = resolveStateCandidates(root);
    const r = runStateAdopt(candidates, "legacy");
    expect(r.ok).toBe(true);

    const after = resolveProjectPaths(root);
    expect(after.stateDir).toBe(path.join(real(root), ".agentic-sdlc"));
  });

  it("adopt refuses if the location to KEEP has no state.json (would leave an empty project)", () => {
    const root = mkroot("adopt-empty-keep");
    writeValidState(root, ".agentic-sdlc"); // only legacy has state
    const candidates = resolveStateCandidates(root);
    const r = runStateAdopt(candidates, "twinharness"); // keep .twinharness — but it has no state
    expect(r.ok).toBe(false);
    expect((r.data as { error?: string }).error).toBe("adopt_keep_absent");
  });
});
