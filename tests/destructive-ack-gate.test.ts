/**
 * Deferred #3 — destructive-op confirmation gate
 * (spec/DEFERRED-ITEMS-PLAN.md §"Deferred #3 — destructive-op confirmation gate").
 *
 * A SECOND gate, DISTINCT from the tier gate (assertTierAllows) and
 * tier-INDEPENDENT by construction: every `destructiveHint:true` tool's `run`
 * closure now refuses with a structured `confirmation_required` result unless the
 * caller passed an explicit `confirm:true`. This catches any FUTURE destructive
 * tool that forgets the ack — the contract is BEHAVIORAL (we drive each tool's
 * opaque `run` closure), never a static set-equality over the source.
 *
 * The three covered tools today: th_verify_clear, th_interview_start,
 * th_collab_fragment (the last keeps BOTH gates — tier for availability, ack for
 * data-loss). th_repo_map is `destructive:false` + idempotent and is explicitly
 * OUT of scope (no ack gate there).
 */

import { describe, it, expect, afterEach } from "vitest";
import { makeTempProject, expectedToolDefsCount, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { runStateSet } from "../src/commands/state";
import { TOOL_DEFS, TOOL_ANNOTATIONS } from "../src/mcp-server";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

/** Names of every tool the annotation layer marks as destructive. */
const destructiveToolNames = (): string[] =>
  Object.entries(TOOL_ANNOTATIONS)
    .filter(([, ann]) => ann.destructiveHint === true)
    .map(([name]) => name)
    .sort();

/** Minimal valid args (sans `confirm`) so a tool can proceed PAST the ack gate. */
const VALID_ARGS: Readonly<Record<string, Record<string, unknown>>> = {
  th_verify_clear: {},
  th_interview_start: { idea: "an idea" },
  th_collab_fragment: { stage: "architecture", round: "r1", name: "a.md", text: "REQ-001 x" },
};

function defFor(name: string) {
  const def = TOOL_DEFS.find((t) => t.name === name);
  expect(def, `tool ${name} must be advertised`).toBeDefined();
  return def!;
}

describe("Deferred #3: destructive tools require an explicit ack (behavioral contract)", () => {
  it("Deferred #3: there IS at least one destructive tool to gate (guards an empty sweep)", () => {
    expect(destructiveToolNames().length).toBeGreaterThan(0);
  });

  // Deferred #3: iterate the annotation layer so a FUTURE destructive tool that
  // forgets the ack is caught — no confirm => confirmation_required, never a throw.
  for (const name of destructiveToolNames()) {
    it(`Deferred #3: ${name} refuses with confirmation_required when confirm is absent (no throw)`, () => {
      tp = makeTempProject();
      runInit(tp.paths, {});
      const def = defFor(name);
      const args = VALID_ARGS[name] ?? {};
      // Async tools expose the sync guard on `run`; we only assert it never throws
      // and returns the ack refusal. (If a destructive tool is added without an
      // entry in VALID_ARGS, `{}` still exercises the ack gate, which fires first.)
      const res = def.run(tp.paths, args);
      expect(res.ok).toBe(false);
      expect(res.data?.error).toBe("confirmation_required");
    });
  }
});

describe("Deferred #3: confirm:true lets the destructive op proceed past the ack gate", () => {
  for (const name of destructiveToolNames()) {
    it(`Deferred #3: ${name} does NOT return confirmation_required when confirm:true`, () => {
      tp = makeTempProject();
      runInit(tp.paths, {});
      // T2 so the tier gate (on th_collab_fragment) is transparent — isolates the
      // ack gate from the availability gate.
      runStateSet(tp.paths, "tier", "T2", { emergency: true });
      const def = defFor(name);
      const args = { ...(VALID_ARGS[name] ?? {}), confirm: true };
      const res = def.run(tp.paths, args);
      // The underlying handler may pass or fail on its own merits, but the ack gate
      // must NOT be the reason — it has been acknowledged.
      expect(res.data?.error).not.toBe("confirmation_required");
    });
  }
});

describe("Deferred #3: the ack gate is tier-INDEPENDENT (T0/T1 with confirm are NOT locked out)", () => {
  for (const tier of ["T0", "T1"] as const) {
    it(`Deferred #3: at ${tier}, confirm:true is honored for every destructive tool (no confirmation_required)`, () => {
      tp = makeTempProject();
      runInit(tp.paths, {});
      runStateSet(tp.paths, "tier", tier, { emergency: true });
      for (const name of destructiveToolNames()) {
        const def = defFor(name);
        const args = { ...(VALID_ARGS[name] ?? {}), confirm: true };
        const res = def.run(tp.paths, args);
        // Tier-independence: the ack gate never refuses a confirmed T0/T1 caller.
        // (th_collab_fragment may still be tier_locked at T0/T1 — that is the
        // SEPARATE availability gate, not the ack gate under test here.)
        expect(
          res.data?.error,
          `${name} at ${tier} must not be ack-refused when confirmed`,
        ).not.toBe("confirmation_required");
      }
    });
  }

  it("Deferred #3: at T0, omitting confirm STILL yields confirmation_required (tier never substitutes for the ack)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runStateSet(tp.paths, "tier", "T0", { emergency: true });
    // th_verify_clear / th_interview_start are tier-ungated, so the ONLY gate is ack.
    for (const name of ["th_verify_clear", "th_interview_start"]) {
      const def = defFor(name);
      const res = def.run(tp.paths, VALID_ARGS[name] ?? {});
      expect(res.ok).toBe(false);
      expect(res.data?.error).toBe("confirmation_required");
    }
  });
});

describe("Deferred #3: parity unchanged (count + names/order)", () => {
  it("Deferred #3: TOOL_DEFS.length is still 62", () => {
    expect(TOOL_DEFS.length).toBe(expectedToolDefsCount());
  });

  it("Deferred #3: th_collab_fragment keeps BOTH gates — ack fires even at a locked tier", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runStateSet(tp.paths, "tier", "T0", { emergency: true }); // collab feature locked at T0
    const def = defFor("th_collab_fragment");
    // No confirm: the ack gate is composed FIRST, so the refusal is the ack one.
    const res = def.run(tp.paths, VALID_ARGS.th_collab_fragment);
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("confirmation_required");
  });
});
