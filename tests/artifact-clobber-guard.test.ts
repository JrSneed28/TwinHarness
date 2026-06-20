/**
 * R-14 / DR-04(a) — approved-artifact clobber guard.
 *
 * Invariant: a path registered in `approved_artifacts` (via `th artifact register`)
 * must NOT be silently overwritten when a stage agent / CLI / MCP re-runs. The guard
 * is keyed STRICTLY on `approved_artifacts` membership and is wired with an explicit
 * escape (the PreToolUse `ask` confirmation for tool writes; `--force` / `force:true`
 * for the direct `th repo map` writer) so a deliberate re-author still works and the
 * normal stage-re-run flow is unaffected.
 *
 * Matrix (per the deep-dive required test):
 *   - tool write to a REGISTERED artifact, no escape       → held (`ask`, no silent clobber)
 *   - tool write to an UNREGISTERED `docs/` path           → still allowed (no regression)
 *   - `th repo map` whose target is REGISTERED, no --force → refused
 *   - `th repo map` whose target is REGISTERED, with force → allowed (overwrite)
 *   - `th repo map` whose targets are UNREGISTERED         → allowed (the common case)
 *   - a non-artifact write (state.json) is completely unaffected
 *   - directory artifact (e.g. docs/05-adrs/) protects nested files
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { runArtifactRegister } from "../src/commands/artifact";
import { runRepoMap } from "../src/commands/repo";
import { runHookPretoolGate, type PreToolHookInput } from "../src/commands/hook";
import { readState, writeState } from "../src/core/state-store";
import { initialState } from "../src/core/state-schema";
import { matchApprovedArtifact, isApprovedArtifactPath } from "../src/core/artifact-guard";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

/** Write a file (relative to the temp project root) and return its root-relative key. */
function writeFile(t: TempProject, rel: string, content: string): string {
  const abs = path.join(t.root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  return rel;
}

function parseOut(out: { stdout: string }): Record<string, unknown> {
  return JSON.parse(out.stdout) as Record<string, unknown>;
}
function isAllow(out: { stdout: string }): boolean {
  return Object.keys(parseOut(out)).length === 0;
}
function permissionDecision(out: { stdout: string }): string | undefined {
  const hso = parseOut(out)["hookSpecificOutput"] as Record<string, unknown> | undefined;
  return hso?.["permissionDecision"] as string | undefined;
}
function permissionReason(out: { stdout: string }): string | undefined {
  const hso = parseOut(out)["hookSpecificOutput"] as Record<string, unknown> | undefined;
  return hso?.["permissionDecisionReason"] as string | undefined;
}
/** A Write tool input targeting `filePath` (Phase B — implementation allowed). */
function writeInput(filePath: string): PreToolHookInput {
  return { tool_name: "Write", tool_input: { file_path: filePath } };
}
/** A Bash tool input running `command`, resolved against `cwd` (R-24 vector). */
function bashInput(command: string, cwd: string): PreToolHookInput {
  return { tool_name: "Bash", tool_input: { command }, cwd };
}

// ---------------------------------------------------------------------------
// REQ-R14-CLOBBER-001 — tool-write vector (PreToolUse gate)
// ---------------------------------------------------------------------------

describe("REQ-R14-CLOBBER-001: a tool write to a REGISTERED artifact is held for confirmation (no silent clobber)", () => {
  it("registered docs/NN-*.md → ask (even though docs/ is otherwise whitelisted)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const rel = writeFile(tp, "docs/01-requirements.md", "# Requirements\nv1\n");
    runArtifactRegister(tp.paths, rel, 1);

    const abs = path.join(tp.root, "docs", "01-requirements.md");
    const out = runHookPretoolGate(tp.paths, writeInput(abs));
    expect(permissionDecision(out)).toBe("ask");
    expect(permissionReason(out)).toContain("approved-artifact overwrite");
    expect(permissionReason(out)).toContain("docs/01-requirements.md v1");
  });

  it("UNregistered docs/ path → still allowed (no regression)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    // Register a DIFFERENT doc; the target below is not registered.
    runArtifactRegister(tp.paths, writeFile(tp, "docs/01-requirements.md", "x\n"), 1);

    const abs = path.join(tp.root, "docs", "99-scratch.md");
    const out = runHookPretoolGate(tp.paths, writeInput(abs));
    expect(isAllow(out)).toBe(true);
  });

  it("no artifacts registered at all → every docs/ write is allowed (gate inert)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const abs = path.join(tp.root, "docs", "01-requirements.md");
    const out = runHookPretoolGate(tp.paths, writeInput(abs));
    expect(isAllow(out)).toBe(true);
  });

  it("a registered DIRECTORY artifact protects files nested under it", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    // Register the ADR directory as a single artifact (mirrors `docs/05-adrs/`).
    writeFile(tp, "docs/05-adrs/0001-choice.md", "adr\n");
    runArtifactRegister(tp.paths, "docs/05-adrs/", 1);

    const nested = path.join(tp.root, "docs", "05-adrs", "0001-choice.md");
    const out = runHookPretoolGate(tp.paths, writeInput(nested));
    expect(permissionDecision(out)).toBe("ask");
    expect(permissionReason(out)).toContain("docs/05-adrs");
  });
});

// ---------------------------------------------------------------------------
// REQ-R24-CLOBBER-BASH — Bash-mediated write vector (the R-14 hole closed by R-24)
//
// A Bash tool call carries `command` and no `file_path`, so it short-circuits at step d
// (`!filePath → allow`) BEFORE ever reaching the step-e3 R-14 guard — and the doc/state
// allowlist blanket-allows `docs/` for Bash. So `echo x > docs/01-requirements.md`
// silently clobbered a REGISTERED approved artifact. R-24 mirrors the Write/Edit guard
// for Bash (same matcher, same `ask` disposition). Closure is PARSEABLE targets only
// (metachar-obscured targets like `> $f` are dropped by extractBashWriteTargets — the
// honest M-4/R-19 caveat).
// ---------------------------------------------------------------------------

describe("REQ-R24-CLOBBER-BASH: a Bash redirection over a REGISTERED artifact is held for confirmation", () => {
  it("echo > a registered docs/NN-*.md (Phase B) → ask (the bypass the R-14 guard missed)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    // Phase B (implementation allowed) so the gate runs past the Phase-A blanket gate.
    writeState(tp.paths, { ...readState(tp.paths).state!, implementation_allowed: true, current_stage: "stage-10" });
    const rel = writeFile(tp, "docs/01-requirements.md", "# Requirements\nv1\n");
    runArtifactRegister(tp.paths, rel, 1);

    const out = runHookPretoolGate(tp.paths, bashInput("echo x > docs/01-requirements.md", tp.root));
    expect(permissionDecision(out)).toBe("ask");
    expect(permissionReason(out)).toContain("R-24");
    expect(permissionReason(out)).toContain("docs/01-requirements.md v1");
  });

  it("a relative redirect resolved against cwd=root still matches → ask (tee form too)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeState(tp.paths, { ...readState(tp.paths).state!, implementation_allowed: true, current_stage: "stage-10" });
    runArtifactRegister(tp.paths, writeFile(tp, "docs/01-requirements.md", "v1\n"), 1);

    const out = runHookPretoolGate(tp.paths, bashInput("echo x | tee docs/01-requirements.md", tp.root));
    expect(permissionDecision(out)).toBe("ask");
  });

  it("a Bash write to an UNregistered docs/ path is still allowed (no regression)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeState(tp.paths, { ...readState(tp.paths).state!, implementation_allowed: true, current_stage: "stage-10" });
    runArtifactRegister(tp.paths, writeFile(tp, "docs/01-requirements.md", "v1\n"), 1);

    const out = runHookPretoolGate(tp.paths, bashInput("echo x > docs/99-scratch.md", tp.root));
    expect(isAllow(out)).toBe(true);
  });

  it("a registered DIRECTORY artifact is protected against a nested Bash write → ask", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeState(tp.paths, { ...readState(tp.paths).state!, implementation_allowed: true, current_stage: "stage-10" });
    writeFile(tp, "docs/05-adrs/0001-choice.md", "adr\n");
    runArtifactRegister(tp.paths, "docs/05-adrs/", 1);

    const out = runHookPretoolGate(tp.paths, bashInput("echo x > docs/05-adrs/0001-choice.md", tp.root));
    expect(permissionDecision(out)).toBe("ask");
    expect(permissionReason(out)).toContain("docs/05-adrs");
  });
});

// ---------------------------------------------------------------------------
// REQ-R14-CLOBBER-002 — direct-write vector (`th repo map`)
// ---------------------------------------------------------------------------

describe("REQ-R14-CLOBBER-002: `th repo map` refuses to clobber a registered target without --force", () => {
  function seedRepo(t: TempProject): void {
    writeFile(t, "package.json", JSON.stringify({ name: "x" }));
    writeFile(t, "src/a.ts", "1\n");
  }

  it("registered docs/00-repo-map.md, no --force → refused (REQ: no silent clobber)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    seedRepo(tp);
    // Produce + register the repo-map md so it is an approved artifact.
    expect(runRepoMap(tp.paths, {}).ok).toBe(true);
    runArtifactRegister(tp.paths, "docs/00-repo-map.md", 1);

    const res = runRepoMap(tp.paths, {});
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("approved_artifact_clobber");
    expect(res.data?.file).toBe("docs/00-repo-map.md");
    expect(res.human).toContain("--force");
  });

  it("registered docs/00-repo-map.md, WITH force → allowed (deliberate re-author)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    seedRepo(tp);
    expect(runRepoMap(tp.paths, {}).ok).toBe(true);
    runArtifactRegister(tp.paths, "docs/00-repo-map.md", 1);

    const res = runRepoMap(tp.paths, { force: true });
    expect(res.ok).toBe(true);
    expect(res.data?.wrote).toBe(true);
    expect(fs.existsSync(path.join(tp.paths.docsDir, "00-repo-map.md"))).toBe(true);
  });

  it("registered repo-map.json (the state-dir target) is also guarded without --force", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    seedRepo(tp);
    expect(runRepoMap(tp.paths, {}).ok).toBe(true);
    runArtifactRegister(tp.paths, ".twinharness/repo-map.json", 1);

    const refused = runRepoMap(tp.paths, {});
    expect(refused.ok).toBe(false);
    expect(refused.data?.file).toBe(".twinharness/repo-map.json");
    // --force still lets it through.
    expect(runRepoMap(tp.paths, { force: true }).ok).toBe(true);
  });

  it("UNregistered repo-map targets → re-run allowed (the normal flow, no regression)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    seedRepo(tp);
    // Two back-to-back writes with nothing registered: both succeed (idempotent re-run).
    expect(runRepoMap(tp.paths, {}).ok).toBe(true);
    const second = runRepoMap(tp.paths, {});
    expect(second.ok).toBe(true);
    expect(second.data?.wrote).toBe(true);
  });

  it("pre-init project (no state) → repo map still writes (guard inert without approved_artifacts)", () => {
    tp = makeTempProject();
    seedRepo(tp);
    // No `th init`: readState().state is undefined → no approved artifacts → guard inert.
    const res = runRepoMap(tp.paths, {});
    expect(res.ok).toBe(true);
    expect(res.data?.wrote).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// REQ-R14-CLOBBER-003 — scope: non-artifact writes are completely unaffected
// ---------------------------------------------------------------------------

describe("REQ-R14-CLOBBER-003: the guard is keyed strictly on approved_artifacts — non-artifact writes unaffected", () => {
  it("a state.json write is never matched by the artifact guard (even when artifacts exist)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runArtifactRegister(tp.paths, writeFile(tp, "docs/01-requirements.md", "x\n"), 1);

    // writeState updates state.json repeatedly with no clobber error.
    const r = readState(tp.paths);
    expect(r.state).toBeTruthy();
    writeState(tp.paths, { ...r.state!, drift_open_blocking: 0 });
    writeState(tp.paths, { ...r.state!, drift_open_blocking: 0 });

    // And the predicate itself says state.json is NOT an approved-artifact path.
    expect(isApprovedArtifactPath(r.state!.approved_artifacts, tp.paths.root, tp.paths.stateFile)).toBe(false);
  });

  it("matchApprovedArtifact returns null for an out-of-root path and for an empty registry", () => {
    tp = makeTempProject();
    expect(matchApprovedArtifact([], tp.paths.root, path.join(tp.root, "docs/x.md"))).toBeNull();
    const approved = [{ file: "docs/01-requirements.md", version: 1, hash: "abc" }];
    // A sibling key that merely shares a prefix segment must NOT match (boundary check).
    expect(matchApprovedArtifact(approved, tp.paths.root, path.join(tp.root, "docs/01-requirements.md.bak"))).toBeNull();
    // Outside-root absolute path → null.
    expect(matchApprovedArtifact(approved, tp.paths.root, path.join(tp.root, "..", "elsewhere.md"))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// REQ-R14-CLOBBER-004 — the escape preserves the normal stage-re-run flow
// ---------------------------------------------------------------------------

describe("REQ-R14-CLOBBER-004: a deliberate re-author still works under the guard", () => {
  it("write-gate=off short-circuits before the artifact gate (no friction when the gate is disabled)", () => {
    tp = makeTempProject();
    writeState(tp.paths, { ...initialState(), write_gate: "off", implementation_allowed: true });
    runArtifactRegister(tp.paths, writeFile(tp, "docs/01-requirements.md", "x\n"), 1);
    const abs = path.join(tp.root, "docs", "01-requirements.md");
    expect(isAllow(runHookPretoolGate(tp.paths, writeInput(abs)))).toBe(true);
  });

  it("re-register with a bumped version after a forced overwrite keeps a single entry", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeFile(tp, "package.json", JSON.stringify({ name: "x" }));
    writeFile(tp, "src/a.ts", "1\n");
    expect(runRepoMap(tp.paths, {}).ok).toBe(true);
    runArtifactRegister(tp.paths, "docs/00-repo-map.md", 1);

    // Deliberate re-author: --force overwrites, then re-register at v2.
    expect(runRepoMap(tp.paths, { force: true }).ok).toBe(true);
    expect(runArtifactRegister(tp.paths, "docs/00-repo-map.md", 2).ok).toBe(true);

    const r = readState(tp.paths);
    const entries = r.state!.approved_artifacts.filter((a) => a.file === "docs/00-repo-map.md");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.version).toBe(2);
  });
});
