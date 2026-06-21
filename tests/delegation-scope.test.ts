/**
 * SG3 P1-B (C-11) + R-36 (F7) — the delegate allowed-files scope must REACH the
 * out-of-process PreToolUse write-gate, and OVERLAPPING delegations must not clobber
 * each other.
 *
 * C-11 (the wiring fix): `th delegate pack --allowed-files` only RETURNED the scope;
 * nothing persisted it, and the installed hook reads only host stdin (no `allowed_files`),
 * so enforcement never activated. The fix ARMS a durable scope the gate reads.
 *
 * R-36 (F7): the durable scope WAS a SINGLETON — two concurrent delegations clobbered each
 * other (last pack won) and ANY SubagentStop lifted the one shared file (dropping a peer's
 * scope → fail-open). The fix is PER-DELEGATION-ID scope files with TTL recovery, the
 * no-id XOR partition, and clear-own-id-only.
 */

import { describe, it, expect, afterEach } from "vitest";
import { makeTempProject, type TempProject } from "./helpers";
import { writeState } from "../src/core/state-store";
import { initialState } from "../src/core/state-schema";
import {
  writeDelegationScope,
  clearDelegationScope,
  clearAllDelegationScopes,
  readActiveDelegationScopes,
  delegationScopeFile,
  delegationScopesDir,
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

function writeInput(filePath: string, root: string, extra: Partial<PreToolHookInput> = {}): PreToolHookInput {
  return { tool_name: "Write", tool_input: { file_path: filePath }, cwd: root, ...extra };
}

describe("delegation-scope persistence round-trip (per-id, R-36)", () => {
  it("write arms a non-empty per-id scope; read returns it; empty disarms (removes the file)", () => {
    tp = makeTempProject();
    seedPhaseB(tp);

    writeDelegationScope(tp.paths, "DEL-a", ["src/auth", "src/db/conn.ts"], { agent: "builder", slice: "SLICE-1" });
    const file = delegationScopeFile(tp.paths, "DEL-a")!;
    expect(fs.existsSync(file)).toBe(true);
    const { active, union } = readActiveDelegationScopes(tp.paths);
    expect(active).toHaveLength(1);
    expect(active[0].allowedFiles).toEqual(["src/auth", "src/db/conn.ts"]);
    expect(active[0].delegationId).toBe("DEL-a");
    expect(union).toEqual(["src/auth", "src/db/conn.ts"]);

    // Empty list disarms THAT id.
    writeDelegationScope(tp.paths, "DEL-a", []);
    expect(fs.existsSync(file)).toBe(false);
    expect(readActiveDelegationScopes(tp.paths).active).toHaveLength(0);
  });

  it("a corrupt scope file reads as empty (no-op) and is GC'd, never throws", () => {
    tp = makeTempProject();
    seedPhaseB(tp);
    fs.mkdirSync(delegationScopesDir(tp.paths), { recursive: true });
    const f = delegationScopeFile(tp.paths, "DEL-corrupt")!;
    fs.writeFileSync(f, "}{ not json", "utf8");
    expect(readActiveDelegationScopes(tp.paths).active).toHaveLength(0);
    expect(fs.existsSync(f)).toBe(false); // corrupt → GC'd on read
  });
});

describe("PreToolUse write-gate enforces the PERSISTED per-id scope (the C-11 wiring fix)", () => {
  it("DENIES an in-root write OUTSIDE the armed scope", () => {
    tp = makeTempProject();
    seedPhaseB(tp);
    writeDelegationScope(tp.paths, "DEL-1", ["src/auth"], {});

    const out = runHookPretoolGate(tp.paths, writeInput("src/other/x.ts", tp.root));
    expect(decision(out)).toBe("deny");
    expect(reason(out)).toContain("delegate scope");
  });

  it("ALLOWS a write INSIDE the armed scope (the C-11 rung does not fire)", () => {
    tp = makeTempProject();
    seedPhaseB(tp);
    writeDelegationScope(tp.paths, "DEL-1", ["src/auth"], {});

    const out = runHookPretoolGate(tp.paths, writeInput("src/auth/login.ts", tp.root));
    expect(isAllow(out)).toBe(true);
  });

  it("the scope also applies to a parseable Bash-mediated write (C-11 Bash rung)", () => {
    tp = makeTempProject();
    seedPhaseB(tp);
    writeDelegationScope(tp.paths, "DEL-1", ["src/auth"], {});
    const out = runHookPretoolGate(tp.paths, {
      tool_name: "Bash",
      tool_input: { command: "echo x > src/other/y.ts" },
      cwd: tp.root,
    });
    expect(decision(out)).toBe("deny");
    expect(reason(out)).toContain("delegate scope");
  });
});

describe("F7 no-id XOR PARTITION (Item 2 — the DECISION)", () => {
  // ARM 1: {0 active scopes ⇒ NO-OP, write never gated} — the empty-union no-op preserved.
  it("ARM 1: with ZERO active scopes, a write is ALLOWED (no-op preserved)", () => {
    tp = makeTempProject();
    seedPhaseB(tp);
    const out = runHookPretoolGate(tp.paths, writeInput("src/anything/x.ts", tp.root));
    expect(reason(out)).not.toContain("delegate scope"); // scope rung never fired
    expect(isAllow(out)).toBe(true); // Phase B + no slices ⇒ unowned ⇒ allow
  });

  // ARM 2: {>=1 active scope + NO per-delegation id ⇒ UNION enforcement (fail-tighter)}.
  it("ARM 2: with an active scope and NO id on the payload, a write OUTSIDE the union is BLOCKED", () => {
    tp = makeTempProject();
    seedPhaseB(tp);
    writeDelegationScope(tp.paths, "DEL-sibling", ["src/auth"], {});

    // No delegation_id on this payload, but a scope is armed ⇒ constrained to the union.
    const out = runHookPretoolGate(tp.paths, writeInput("src/other/x.ts", tp.root));
    expect(decision(out)).toBe("deny");
    expect(reason(out)).toContain("delegate scope");
  });

  it("ARM 2: a write INSIDE the union of active scopes is allowed even with no id", () => {
    tp = makeTempProject();
    seedPhaseB(tp);
    writeDelegationScope(tp.paths, "DEL-sibling", ["src/auth"], {});
    const out = runHookPretoolGate(tp.paths, writeInput("src/auth/login.ts", tp.root));
    expect(isAllow(out)).toBe(true);
  });
});

describe("review fix (PR #29) — host session_id/tool_use_id are NOT delegation/scope keys", () => {
  // P1: a REAL PreToolUse payload always carries host ids (session_id/tool_use_id) but no
  // minted delegation_id. Treating a host id as the writer id made writerId truthy → the
  // per-id branch returned an empty (unfettered) scope, SUPPRESSING the active-scope union.
  // The union (ARM 2) must still bite when only host ids are present (RED before the fix:
  // the out-of-union write was ALLOWED).
  it("P1: ARM 2 still BLOCKS an out-of-union write when the payload carries host ids but no delegation_id", () => {
    tp = makeTempProject();
    seedPhaseB(tp);
    writeDelegationScope(tp.paths, "DEL-sibling", ["src/auth"], {});

    const out = runHookPretoolGate(
      tp.paths,
      writeInput("src/other/x.ts", tp.root, { session_id: "sess-abc", tool_use_id: "tuid-123" }),
    );
    expect(decision(out)).toBe("deny");
    expect(reason(out)).toContain("delegate scope");
  });

  it("P1: a host-id-only payload writing INSIDE the union is still allowed", () => {
    tp = makeTempProject();
    seedPhaseB(tp);
    writeDelegationScope(tp.paths, "DEL-sibling", ["src/auth"], {});
    const out = runHookPretoolGate(
      tp.paths,
      writeInput("src/auth/login.ts", tp.root, { session_id: "sess-abc", tool_use_id: "tuid-123" }),
    );
    expect(isAllow(out)).toBe(true);
  });

  // P2: a SubagentStop must clear a scope ONLY by its actual minted key (delegation_id). A
  // host id — even one crafted to equal a scope's id — must never clear it (RED before the
  // fix: the tool_use_id fallback cleared DEL-A).
  it("P2: a SubagentStop carrying only host ids (no delegation_id) does NOT clear a scope", () => {
    tp = makeTempProject();
    seedPhaseB(tp);
    writeDelegationScope(tp.paths, "DEL-A", ["src/a"], {});

    runHookSubagentStop(tp.paths, { tool_use_id: "DEL-A", session_id: "sess-xyz" });
    expect(fs.existsSync(delegationScopeFile(tp.paths, "DEL-A")!)).toBe(true); // survives

    // Only the explicit minted key clears it.
    runHookSubagentStop(tp.paths, { delegation_id: "DEL-A" });
    expect(fs.existsSync(delegationScopeFile(tp.paths, "DEL-A")!)).toBe(false);
  });
});

describe("F7 per-id independence + lifecycle (R-36)", () => {
  it("two overlapping delegations with DISJOINT scopes are each enforced independently (per-id)", () => {
    tp = makeTempProject();
    seedPhaseB(tp);
    writeDelegationScope(tp.paths, "DEL-A", ["src/a"], {});
    writeDelegationScope(tp.paths, "DEL-B", ["src/b"], {});

    // DEL-A may write src/a, not src/b (its OWN scope enforced precisely by its id).
    expect(isAllow(runHookPretoolGate(tp.paths, writeInput("src/a/f.ts", tp.root, { delegation_id: "DEL-A" })))).toBe(true);
    const aIntoB = runHookPretoolGate(tp.paths, writeInput("src/b/f.ts", tp.root, { delegation_id: "DEL-A" }));
    expect(decision(aIntoB)).toBe("deny");

    // DEL-B may write src/b, not src/a.
    expect(isAllow(runHookPretoolGate(tp.paths, writeInput("src/b/f.ts", tp.root, { delegation_id: "DEL-B" })))).toBe(true);
    const bIntoA = runHookPretoolGate(tp.paths, writeInput("src/a/f.ts", tp.root, { delegation_id: "DEL-B" }));
    expect(decision(bIntoA)).toBe("deny");
  });

  it("an UNRELATED SubagentStop does NOT clear a peer's scope (clear-own-id-only)", () => {
    tp = makeTempProject();
    seedPhaseB(tp);
    writeDelegationScope(tp.paths, "DEL-A", ["src/a"], {});
    writeDelegationScope(tp.paths, "DEL-B", ["src/b"], {});

    // DEL-A stops. DEL-B's scope must survive.
    runHookSubagentStop(tp.paths, { delegation_id: "DEL-A" });
    expect(fs.existsSync(delegationScopeFile(tp.paths, "DEL-A")!)).toBe(false); // own id cleared
    expect(fs.existsSync(delegationScopeFile(tp.paths, "DEL-B")!)).toBe(true); // PEER survives

    // The peer's scope is still enforced.
    const stillEnforced = runHookPretoolGate(tp.paths, writeInput("src/other/x.ts", tp.root, { delegation_id: "DEL-B" }));
    expect(decision(stillEnforced)).toBe("deny");
  });

  it("a SubagentStop with NO id clears nothing (a peer is never lifted by an unidentified stop)", () => {
    tp = makeTempProject();
    seedPhaseB(tp);
    writeDelegationScope(tp.paths, "DEL-A", ["src/a"], {});
    runHookSubagentStop(tp.paths, {}); // no id
    expect(fs.existsSync(delegationScopeFile(tp.paths, "DEL-A")!)).toBe(true); // not cleared
  });

  it("a crashed delegate's scope SELF-EXPIRES via TTL and is GC'd on the next read", () => {
    tp = makeTempProject();
    seedPhaseB(tp);
    // Arm with an already-elapsed TTL to model a crash whose SubagentStop never fired.
    writeDelegationScope(tp.paths, "DEL-crashed", ["src/a"], { ttlMs: 1 });
    const file = delegationScopeFile(tp.paths, "DEL-crashed")!;
    expect(fs.existsSync(file)).toBe(true);

    // A read far enough in the future sees it as expired → GC'd → no longer enforced.
    const future = Date.now() + 10_000;
    const { active } = readActiveDelegationScopes(tp.paths, future);
    expect(active).toHaveLength(0);
    expect(fs.existsSync(file)).toBe(false); // TTL GC removed it

    // With the crashed scope gone, an out-of-(former-)scope write is no longer gated.
    const out = runHookPretoolGate(tp.paths, writeInput("src/other/x.ts", tp.root));
    expect(reason(out)).not.toContain("delegate scope");
  });

  it("per-id enforcement holds on BOTH Bash and Write/Edit", () => {
    tp = makeTempProject();
    seedPhaseB(tp);
    writeDelegationScope(tp.paths, "DEL-A", ["src/a"], {});

    const bash = runHookPretoolGate(tp.paths, {
      tool_name: "Bash",
      tool_input: { command: "echo x > src/b/y.ts" },
      cwd: tp.root,
      delegation_id: "DEL-A",
    });
    expect(decision(bash)).toBe("deny");

    const write = runHookPretoolGate(tp.paths, writeInput("src/b/y.ts", tp.root, { delegation_id: "DEL-A" }));
    expect(decision(write)).toBe("deny");
  });
});

describe("F7 Tier-1 KNOWN LIMITATION — orchestrator-write-during-sibling false-block (PINNED)", () => {
  // Tier 1: a session-level id cannot distinguish the orchestrator's OWN non-delegated
  // write from a sibling delegation's write in the SAME session. So with >=1 active sibling
  // delegation and no per-delegation id, a legitimate non-delegated orchestrator write is
  // constrained to the union → a LOUD, recoverable false-block (escapable via
  // TH_DISABLE_WRITE_GATE). We PIN the CURRENT Tier-1 behavior so a future Tier-2 fix
  // (host-supplied per-subagent id) flips it DELIBERATELY rather than a regression sneaking
  // the fail-open back in.
  it("an orchestrator write OUTSIDE a sibling's scope is BLOCKED when no per-delegation id is supplied (current Tier-1 behavior)", () => {
    tp = makeTempProject();
    seedPhaseB(tp);
    // A sibling delegation is active (scope = src/auth). The orchestrator wants to write
    // src/orchestrator/notes.ts — legitimate, non-delegated — but carries no delegation_id.
    writeDelegationScope(tp.paths, "DEL-sibling", ["src/auth"], {});

    const orchestratorWrite = runHookPretoolGate(tp.paths, writeInput("src/orchestrator/notes.ts", tp.root));
    // PINNED: constrained to the union (fail-tighter) → blocked. This is the documented,
    // bounded, recoverable Tier-1 false-block, NOT a silent fail-open.
    expect(decision(orchestratorWrite)).toBe("deny");
    expect(reason(orchestratorWrite)).toContain("delegate scope");

    // The documented escape: TH_DISABLE_WRITE_GATE=1 lets the orchestrator write through.
    const escaped = runHookPretoolGate(
      tp.paths,
      writeInput("src/orchestrator/notes.ts", tp.root),
      { TH_DISABLE_WRITE_GATE: "1" },
    );
    expect(isAllow(escaped)).toBe(true);
  });

  it("Tier-2 path: supplying the orchestrator's OWN id (no active scope under it) is NOT union-gated", () => {
    tp = makeTempProject();
    seedPhaseB(tp);
    writeDelegationScope(tp.paths, "DEL-sibling", ["src/auth"], {});

    // A host that supplies a per-writer id with NO armed scope under it (the orchestrator's
    // own id) is enforcing THAT id's scope = none → not constrained to the sibling union.
    // This is the Tier-2 behavior a host id unlocks; documented as host-id-conditional.
    const out = runHookPretoolGate(
      tp.paths,
      writeInput("src/orchestrator/notes.ts", tp.root, { delegation_id: "DEL-orchestrator-own" }),
    );
    expect(isAllow(out)).toBe(true);
  });
});

describe("th delegate pack mints an id and emits the normalized scope the CLI persists", () => {
  it("data.delegationId is minted and data.allowedFiles is the deduped/trimmed list", () => {
    tp = makeTempProject();
    const res = runDelegatePack(tp.paths, { agent: "builder", allowedFiles: [" src/auth ", "src/auth", "src/db.ts", ""] });
    expect(res.ok).toBe(true);
    expect(res.data!.allowedFiles).toEqual(["src/auth", "src/db.ts"]);
    expect(typeof res.data!.delegationId).toBe("string");
    expect((res.data!.delegationId as string).length).toBeGreaterThan(0);

    // Sanity: arming under that id then reading back matches.
    clearAllDelegationScopes(tp.paths);
    writeDelegationScope(tp.paths, res.data!.delegationId as string, res.data!.allowedFiles as string[], {});
    const { union } = readActiveDelegationScopes(tp.paths);
    expect(union).toEqual(["src/auth", "src/db.ts"]);
  });
});

describe("clearDelegationScope (per-id) + clearAllDelegationScopes", () => {
  it("clearDelegationScope removes only the named id; clearAll wipes the dir + legacy", () => {
    tp = makeTempProject();
    seedPhaseB(tp);
    writeDelegationScope(tp.paths, "DEL-A", ["src/a"], {});
    writeDelegationScope(tp.paths, "DEL-B", ["src/b"], {});
    clearDelegationScope(tp.paths, "DEL-A");
    expect(fs.existsSync(delegationScopeFile(tp.paths, "DEL-A")!)).toBe(false);
    expect(fs.existsSync(delegationScopeFile(tp.paths, "DEL-B")!)).toBe(true);

    clearAllDelegationScopes(tp.paths);
    expect(readActiveDelegationScopes(tp.paths).active).toHaveLength(0);
  });
});
