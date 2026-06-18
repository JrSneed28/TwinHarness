/**
 * REGRESSION TEST — Finding #2 (FIXED)
 *
 * Previously `th next` and the gate `checkImplementationSettled` DISAGREED about an
 * empty slice set during the `implementation` stage:
 *   - `th next` returned a "sync-slices" obligation, and
 *   - `checkImplementationSettled` returned `{ ok: true }` ("vacuously settled"),
 * so a direct `th advance` could push past implementation with zero slice work.
 *
 * FIX (audit fix pass): a SINGLE shared predicate `implementationRequiresSlices(state)`
 * is now consumed by BOTH subsystems. For a CODE project (the default — absent
 * `delivery_mode` ⇒ "code"), an EMPTY slice set during implementation is INVALID:
 *   - `checkImplementationSettled` returns `{ ok:false, error:"no_slices_defined" }`, and
 *   - `th next` still returns "sync-slices".
 * They AGREE. For an explicit "no-code" / "documentation-only" project an empty set
 * stays vacuously settled and `th next` falls through to the stage advance.
 */

import { describe, it, expect, afterEach } from "vitest";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { writeState } from "../src/core/state-store";
import { initialState } from "../src/core/state-schema";
import { checkImplementationSettled, implementationRequiresSlices } from "../src/core/gate-preconditions";
import { runNext } from "../src/commands/next";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

describe("Finding #2 — empty slices at implementation: gate and `th next` now AGREE (regression)", () => {
  it("CODE project (default): checkImplementationSettled refuses empty slices", () => {
    const s = { ...initialState(), current_stage: "implementation", slices: [] };
    const result = checkImplementationSettled(s);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("no_slices_defined");
    expect(result.detail).toMatchObject({ delivery_mode: "code" });
  });

  it("CODE project: th next still returns kind=sync-slices at implementation with empty slices", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});

    writeState(tp.paths, {
      ...initialState(),
      tier: "T1",
      current_stage: "implementation",
      slices: [],
    });

    const result = runNext(tp.paths);
    expect(result.ok).toBe(true);
    const action = result.data as { kind: string };
    expect(action.kind).toBe("sync-slices");
  });

  it("the disagreement is CLOSED — gate refuses AND next signals the same obligation", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});

    const stateWithNoSlices = {
      ...initialState(),
      tier: "T1" as const,
      current_stage: "implementation",
      slices: [] as [],
    };
    writeState(tp.paths, stateWithNoSlices);

    const gateResult = checkImplementationSettled(stateWithNoSlices);
    const nextResult = runNext(tp.paths);
    const action = nextResult.data as { kind: string };

    // Both now agree this is NOT a clean advance: the gate refuses and the oracle
    // surfaces the sync-slices obligation.
    expect(gateResult.ok).toBe(false);
    expect(action.kind).toBe("sync-slices");
  });

  it("NO-CODE project: empty slices stay vacuously settled (gate passes, next does NOT sync-slices)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});

    const noCode = {
      ...initialState(),
      tier: "T1" as const,
      current_stage: "implementation",
      slices: [] as [],
      delivery_mode: "no-code" as const,
    };
    writeState(tp.paths, noCode);

    expect(implementationRequiresSlices(noCode)).toBe(false);
    expect(checkImplementationSettled(noCode)).toEqual({ ok: true });

    const action = runNext(tp.paths).data as { kind: string };
    expect(action.kind).not.toBe("sync-slices");
  });

  it("implementationRequiresSlices: true by default and for explicit code, false for no-code/doc-only", () => {
    expect(implementationRequiresSlices({})).toBe(true);
    expect(implementationRequiresSlices({ delivery_mode: "code" })).toBe(true);
    expect(implementationRequiresSlices({ delivery_mode: "no-code" })).toBe(false);
    expect(implementationRequiresSlices({ delivery_mode: "documentation-only" })).toBe(false);
  });
});
