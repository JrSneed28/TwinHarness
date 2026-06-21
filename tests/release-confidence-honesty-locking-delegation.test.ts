/**
 * R-37 — release-confidence backstop: READ-ONLY HONESTY (F3), FRESH-ROOT LOCKING
 * (F6, CI-safe), and PARALLEL DELEGATION recovery (F7) — the gaps the per-finding
 * suites leave.
 *
 *   F3: a doc-truth guard that the `--no-obvious-writes` help text carries the HONEST
 *       caveat (best-effort heuristic, NOT a security boundary) and does NOT make a
 *       false-safety claim (no "read-only"/"sandbox"/"prevents all writes" wording).
 *       Complements security-doc-lint.test.ts (SECURITY.md) and write-gate-honesty.ts
 *       (doctor/state surfacing) by pinning the CLI HELP surface specifically.
 *
 *   F6: an IN-PROCESS fresh-root locking wave for `verify clear` (the per-finding
 *       concurrency.test.ts spawns real processes for `verify add` only, gated off CI).
 *       Here we serialize an add-wave THEN a clear through the SAME withStateLock that
 *       the pre-init path engages, in-process, so it runs EVERYWHERE (incl. CI) without
 *       a new spawn-heavy/Windows-flaky wave. Asserts the lock dir engages on a fresh
 *       root and the read-modify-write set is consistent.
 *
 *   F7: a crash-recovery backstop — an armed per-delegation scope whose owner crashed
 *       (TTL already elapsed) is GC'd on the next gate read, so a crash can never wedge
 *       the write-gate forever; and a live peer's scope SURVIVES that GC.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { runVerifyAdd, runVerifyClear } from "../src/commands/verify";
import { readVerifyConfig } from "../src/core/verify";
import { withStateLock } from "../src/core/state-store";
import {
  writeDelegationScope,
  readActiveDelegationScopes,
  delegationScopeFile,
} from "../src/core/delegation-scope";

let tp: TempProject | undefined;
afterEach(() => {
  tp?.cleanup();
  tp = undefined;
});

// ---------------------------------------------------------------------------
// F3 — read-only honesty (the CLI HELP surface)
// ---------------------------------------------------------------------------
describe("R-37 F3 — `--no-obvious-writes` help text is HONEST (no false-safety phrasing)", () => {
  const cliHelp = fs.readFileSync(path.resolve(__dirname, "../src/cli.ts"), "utf8");

  it("the help line carries the honest best-effort / not-a-security-boundary caveat", () => {
    // The exact shipped phrasing (R-32). A paraphrase is not asserted — the literal
    // string that ships is pinned so a softening edit is caught.
    expect(cliHelp).toContain("best-effort heuristic, NOT a security boundary or real containment");
    expect(cliHelp).toContain("unrecognized write shapes still execute");
  });

  it("the flag is named --no-obvious-writes and --read-only is only a DEPRECATED alias (not the promoted name)", () => {
    expect(cliHelp).toContain("--no-obvious-writes");
    // The deprecation warning exists (the alias is not silently first-class).
    expect(cliHelp).toContain("--read-only is deprecated; use --no-obvious-writes");
  });

  it("the help text makes NO false-safety claim about the flag (no 'read-only mode', 'sandbox', 'prevents all writes')", () => {
    // Scope the search to the verify-run help line so we don't trip on unrelated prose.
    const line = cliHelp.split("\n").find((l) => l.includes("th verify run [--no-obvious-writes]")) ?? "";
    expect(line).not.toMatch(/sandbox/i);
    expect(line).not.toMatch(/prevents all writes/i);
    expect(line).not.toMatch(/fully read-only/i);
    expect(line).not.toMatch(/cannot write/i);
  });
});

// ---------------------------------------------------------------------------
// F6 — fresh-root locking, in-process (CI-safe; no spawn-heavy wave)
// ---------------------------------------------------------------------------
describe("R-37 F6 — fresh-root pre-init lock engages for an add-then-clear sequence (in-process, CI-safe)", () => {
  it("the lock dir is created on a FRESH root the first time a governed write engages", () => {
    tp = makeTempProject();
    const lockDir = path.join(tp.paths.stateDir, ".state.lock");
    // Fresh root: nothing exists yet.
    expect(fs.existsSync(tp.paths.stateDir)).toBe(false);
    // Drive ONE governed critical section through the pre-init lock path.
    withStateLock(tp.paths, () => {
      // While we hold it, the lock dir MUST exist (the pre-init window is locked, R-35/F6).
      expect(fs.existsSync(lockDir)).toBe(true);
    });
    // The state dir was materialized (mkdir -p) by the lock engagement.
    expect(fs.existsSync(tp.paths.stateDir)).toBe(true);
  });

  it("a serialized add-wave THEN clear lands consistently (read-modify-write through the lock)", () => {
    tp = makeTempProject();
    // Sequential governed writes against a fresh-then-init'd root: each is a RMW of
    // verify.json under the state lock. This is the in-process analogue of the
    // spawn-heavy fresh-root wave (concurrency.test.ts) — it pins the lock-serialized
    // RMW correctness WITHOUT a Windows-flaky multi-process spawn.
    runInit(tp.paths, {});
    for (let i = 0; i < 8; i++) {
      expect(runVerifyAdd(tp.paths, `cmd-${i}`).ok).toBe(true);
    }
    expect(readVerifyConfig(tp.paths).commands).toHaveLength(8);
    // The CLEAR mutator (the add/clear pair the spec calls out) empties the set.
    expect(runVerifyClear(tp.paths).ok).toBe(true);
    expect(readVerifyConfig(tp.paths).commands).toHaveLength(0);
    // A re-add after clear lands (the config is consistent, not corrupted by the clear).
    expect(runVerifyAdd(tp.paths, "after-clear").ok).toBe(true);
    expect(readVerifyConfig(tp.paths).commands).toEqual(["after-clear"]);
  });
});

// ---------------------------------------------------------------------------
// F7 — parallel-delegation crash recovery (TTL GC) + peer survival
// ---------------------------------------------------------------------------
describe("R-37 F7 — a crashed delegation's scope self-expires (TTL GC) without wedging a live peer", () => {
  it("an already-expired scope is GC'd on the next read; a live peer's scope survives", () => {
    tp = makeTempProject();
    // DEL-crashed: armed with an already-elapsed TTL (models a crash whose SubagentStop
    // never fired — the file would otherwise wedge the gate forever).
    writeDelegationScope(tp.paths, "DEL-crashed", ["src/a"], { ttlMs: 1 });
    // DEL-live: a healthy peer with a normal TTL.
    writeDelegationScope(tp.paths, "DEL-live", ["src/b"], {});

    const crashedFile = delegationScopeFile(tp.paths, "DEL-crashed")!;
    const liveFile = delegationScopeFile(tp.paths, "DEL-live")!;
    expect(fs.existsSync(crashedFile)).toBe(true);

    // The next read GCs the expired one (lazy TTL recovery) and keeps the live one.
    const active = readActiveDelegationScopes(tp.paths, Date.now() + 1000);
    const ids = active.active.map((a) => a.delegationId).sort();
    expect(ids).toEqual(["DEL-live"]);
    // The crashed scope file is physically removed; the live one remains.
    expect(fs.existsSync(crashedFile)).toBe(false);
    expect(fs.existsSync(liveFile)).toBe(true);
    // The surviving union is exactly the live peer's scope.
    expect(active.union).toEqual(["src/b"]);
  });

  it("an EMPTY scope is a no-op (never gates), distinct from an absent scope", () => {
    tp = makeTempProject();
    writeDelegationScope(tp.paths, "DEL-empty", []); // empty allowed-files
    const active = readActiveDelegationScopes(tp.paths);
    // An empty scope contributes nothing to the active set or the union.
    expect(active.active.map((a) => a.delegationId)).not.toContain("DEL-empty");
    expect(active.union).toEqual([]);
  });
});
