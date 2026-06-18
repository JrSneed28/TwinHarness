/**
 * FIX TEST — Finding #11 (typed CLI gate commands + raw `state set` demotion).
 *
 * Adds typed CLI gate commands that mirror the MCP gate tools and route through
 * the shared locked+ledgered `applyGateMutation`:
 *   - `th tier record <T>`            → validateTierTransition + write tier
 *   - `th stage advance`              → canAdvanceStage + write next stage
 *   - `th implementation unlock`      → canUnlockImplementation + write the flag
 *
 * And DEMOTES a raw `th state set` of a gate-owned field: it is now refused unless
 * `--emergency` is passed, pointing operators at the typed commands. With
 * `--emergency` the write proceeds but is flagged loudly + audit-ledgered.
 */

import { describe, it, expect, afterEach } from "vitest";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { readState } from "../src/core/state-store";
import { runStateSet } from "../src/commands/state";
import { runTierRecord } from "../src/commands/tier";
import { runStageAdvance, runImplementationUnlock } from "../src/commands/stage";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

describe("Finding #11 — typed gate commands", () => {
  it("`th tier record` validates and records the tier through the gate path", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});

    const res = runTierRecord(tp.paths, "T2");
    expect(res.ok).toBe(true);

    const stored = readState(tp.paths).state!;
    expect(stored.tier).toBe("T2");
  });

  it("`th tier record` refuses an invalid tier with a stable error", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});

    const res = runTierRecord(tp.paths, "T9");
    expect(res.ok).toBe(false);
    expect((res.data as { error?: string }).error).toBe("invalid_tier");
  });

  it("`th implementation unlock` refuses when the gate ladder is not met (tier unclassified)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});

    const res = runImplementationUnlock(tp.paths);
    expect(res.ok).toBe(false);
    expect((res.data as { error?: string }).error).toBe("tier_unclassified");
    // The flag must not have been flipped.
    expect(readState(tp.paths).state!.implementation_allowed).toBe(false);
  });

  it("`th implementation unlock --lock` (re-lock) is always permitted", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});

    const res = runImplementationUnlock(tp.paths, { lock: true });
    expect(res.ok).toBe(true);
    expect(readState(tp.paths).state!.implementation_allowed).toBe(false);
  });

  it("`th stage advance` from the pre-pipeline init stage advances to the first engaged stage", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runTierRecord(tp.paths, "T1");

    // From init (pre-pipeline) the ladder clears (no artifact owed yet) and the
    // next engaged stage for T1 is requirements — the typed command performs the
    // gate-checked mutation.
    const res = runStageAdvance(tp.paths);
    expect(res.ok).toBe(true);
    expect(readState(tp.paths).state!.current_stage).toBe("requirements");
  });

  it("`th stage advance` refuses once a stage owes an unregistered governing artifact", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runTierRecord(tp.paths, "T1");
    runStageAdvance(tp.paths); // init → requirements

    // requirements produces docs/01-requirements.md, which is not produced/registered;
    // the governing-artifact rung blocks the next advance.
    const res = runStageAdvance(tp.paths);
    expect(res.ok).toBe(false);
    expect((res.data as { error?: string }).error).toBe("artifact_not_produced");
  });
});

describe("Finding #11 — raw `state set` of a gate-owned field is demoted", () => {
  it("refuses `state set tier` without --emergency and points to the typed command", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});

    const res = runStateSet(tp.paths, "tier", "T2");
    expect(res.ok).toBe(false);
    expect((res.data as { error?: string }).error).toBe("gate_owned_requires_emergency");
    expect(res.human).toContain("th tier record");
    // The write was refused.
    expect(readState(tp.paths).state!.tier).toBe(null);
  });

  it("refuses `state set implementation_allowed` without --emergency", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});

    const res = runStateSet(tp.paths, "implementation_allowed", "true");
    expect(res.ok).toBe(false);
    expect((res.data as { error?: string }).error).toBe("gate_owned_requires_emergency");
  });

  it("with --emergency, writes the gate-owned field and warns loudly", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});

    const res = runStateSet(tp.paths, "tier", "T2", { emergency: true });
    expect(res.ok).toBe(true);
    expect((res.data as { emergency?: boolean }).emergency).toBe(true);
    expect(res.human).toContain("EMERGENCY");
    expect(readState(tp.paths).state!.tier).toBe("T2");
  });

  it("a NON-gate-owned raw `state set` is unaffected by the demotion", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});

    // summaries_index is a plain field — no --emergency required.
    const res = runStateSet(tp.paths, "summaries_index", "custom-summary.md");
    expect(res.ok).toBe(true);
    expect(readState(tp.paths).state!.summaries_index).toBe("custom-summary.md");
  });
});
