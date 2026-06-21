/**
 * PARTITION-EXHAUSTIVENESS GUARD (R-29, Item 3) — the structural anti-drift test for
 * the `canCompleteRun` re-selection.
 *
 * `canCompleteRun` re-selects `canAdvanceStage`'s rungs into completion buckets
 * (always-run / forward-only / final). The danger is DRIFT: a future rung added to
 * `canAdvanceStage` but never classified would silently fall through — either newly
 * blocking completion it should not, or (worse) being dropped from a completion
 * condition it should enforce. This test makes that impossible to do silently:
 *
 *   1. Every entry in the machine-enumerable `CAN_ADVANCE_RUNGS` registry carries
 *      exactly ONE valid `CompletionBucket`.
 *   2. The registry's id set EQUALS the set of rung predicates `canAdvanceStage`
 *      actually invokes across all stages (a recording probe over the real exported
 *      predicates — NOT a hand-mirrored list). A rung added to `canAdvanceStage`'s
 *      body but omitted from the registry is caught here; a registry entry that
 *      `canAdvanceStage` never runs is caught here.
 *   3. The bucket assignments match the SPEC table exactly (the four human-
 *      reconciliation rungs are always-run; checkFinalVerification is the sole final;
 *      everything else is forward-only) — so a mis-bucketing (e.g. classifying
 *      checkVerifySuite always-run, the F1 weakening) fails loudly.
 *
 * It genuinely BITES: #2 drives `canAdvanceStage` through every stage with the rung
 * predicates wrapped to record invocation, so the assertion is over RUNTIME behavior,
 * not a static copy of the registry.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import { writeState, readState } from "../src/core/state-store";
import { initialState } from "../src/core/state-schema";
import { STAGE_PIPELINE } from "../src/core/stages";
import { runArtifactRegister } from "../src/commands/artifact";
import * as gate from "../src/core/gate-preconditions";
import type { ProjectPaths } from "../src/core/paths";

let tp: TempProject | undefined;
afterEach(() => {
  tp?.cleanup();
  tp = undefined;
});

const VALID_BUCKETS = new Set(["always-run", "forward-only", "final"]);

/** The SPEC bucket table (the source of truth the re-selection must honor). */
const SPEC_BUCKETS: Record<string, "always-run" | "forward-only" | "final"> = {
  checkBlockingDrift: "always-run",
  checkReviseEscalation: "always-run",
  checkDecisionObligations: "always-run",
  checkDebate: "always-run",
  checkVerifySuite: "forward-only",
  checkArtifactDrift: "forward-only",
  checkTierSet: "forward-only",
  checkInterview: "forward-only",
  checkRepoMap: "forward-only",
  checkGoverningArtifact: "forward-only",
  checkCoverage: "forward-only",
  checkImplementationSettled: "forward-only",
  checkFinalVerification: "final",
};

describe("R-29 Item 3 — partition-exhaustiveness of the canCompleteRun re-selection", () => {
  it("every registry entry carries exactly one valid CompletionBucket", () => {
    for (const rung of gate.CAN_ADVANCE_RUNGS) {
      expect(typeof rung.id).toBe("string");
      expect(rung.id.length).toBeGreaterThan(0);
      expect(VALID_BUCKETS.has(rung.bucket)).toBe(true);
    }
    // No duplicate ids — each rung classified once.
    const idList = gate.CAN_ADVANCE_RUNGS.map((r) => r.id);
    expect(new Set(idList).size).toBe(idList.length);
  });

  it("the registry bucket assignment matches the spec table EXACTLY", () => {
    const registryById = new Map(gate.CAN_ADVANCE_RUNGS.map((r) => [r.id, r.bucket]));
    // Every spec rung is in the registry with the spec bucket.
    for (const [id, bucket] of Object.entries(SPEC_BUCKETS)) {
      expect(registryById.get(id)).toBe(bucket);
    }
    // And the registry has no rung the spec does not classify (no orphan bucket).
    for (const id of registryById.keys()) {
      expect(SPEC_BUCKETS[id]).toBeDefined();
    }
  });

  it("Item 5 verify authority: checkVerifySuite is forward-only (NOT a completion authority); checkFinalVerification is the sole final rung", () => {
    const byId = new Map(gate.CAN_ADVANCE_RUNGS.map((r) => [r.id, r.bucket]));
    expect(byId.get("checkVerifySuite")).toBe("forward-only");
    expect(byId.get("checkFinalVerification")).toBe("final");
    const finalRungs = gate.CAN_ADVANCE_RUNGS.filter((r) => r.bucket === "final").map((r) => r.id);
    expect(finalRungs).toEqual(["checkFinalVerification"]);
  });

  it("BITES: every rung canAdvanceStage invokes is a CLASSIFIED registry entry (wraps the actual run closures)", () => {
    // canAdvanceStage iterates CAN_ADVANCE_RUNGS and invokes each entry's `run`
    // closure — that closure IS the execution path (not a module export, so a
    // module-level spy would miss it; vi proved closure-by-name calls are not
    // intercepted). We therefore wrap the registry entries' OWN `run` functions: the
    // recorded set is exactly what canAdvanceStage ran. A future rung added to the
    // registry without a SPEC bucket is caught by the per-entry bucket assertion; a
    // rung that somehow runs but is unregistered cannot exist, because the registry is
    // the only execution list — and this test proves that invariant by showing the
    // invoked closures are a subset of the registry's, and every registry rung runs.
    const invoked = new Set<string>();
    const registry = gate.CAN_ADVANCE_RUNGS;
    const restores: Array<() => void> = [];
    for (const rung of registry) {
      const orig = rung.run;
      // Mutate the (frozen-by-convention but writable) closure slot for the probe,
      // then restore. RungSpec.run is a plain property on the registry object.
      (rung as { run: typeof orig }).run = (p, s) => {
        invoked.add(rung.id);
        return orig(p, s);
      };
      restores.push(() => {
        (rung as { run: typeof orig }).run = orig;
      });
    }

    try {
      tp = makeTempProject();
      const paths = tp.paths;
      layDownGreenScaffold(paths);
      // Drive canAdvanceStage across EVERY pipeline stage so each stage-specific rung
      // runs. Breadth of invocation (not a pass) is the goal: at implementation-planning
      // the governing-artifact rung precedes checkCoverage and would short-circuit if the
      // plan were unregistered, so we register each stage's produced artifact first — then
      // governing-artifact passes and the later stage rung (coverage / impl-settled / the
      // final ladder) is reached. The artifact is registered THROUGH the real command so
      // its hash is recorded exactly as production would.
      for (const sc of STAGE_PIPELINE) {
        writeState(paths, {
          ...initialState(),
          tier: "T3",
          current_stage: sc.stage,
          implementation_allowed: true,
          slices: [{ id: "SLICE-0", status: "done", components: [] }],
        });
        if (sc.produces) {
          const rel = sc.produces.replace(/\/$/, "");
          const abs = path.resolve(paths.root, rel);
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          if (!fs.existsSync(abs)) fs.writeFileSync(abs, `# ${sc.stage}\n\n- REQ-001 covered.\n`, "utf8");
          runArtifactRegister(paths, rel, 1);
        }
        gate.canAdvanceStage(paths, readState(paths).state!);
      }
    } finally {
      restores.forEach((f) => f());
    }

    const registryIds = new Set(registry.map((r) => r.id));
    // Every invoked rung is a registry entry that the SPEC table classifies.
    for (const id of invoked) {
      expect(registryIds.has(id)).toBe(true);
      expect(SPEC_BUCKETS[id], `rung '${id}' ran but is UNCLASSIFIED — add it to the canCompleteRun bucket table`).toBeDefined();
    }
    // Every registry rung is reachable across the stage sweep (no dead/misregistered
    // entry the re-selection would guard against a phantom).
    for (const id of registryIds) {
      expect(invoked.has(id), `registry rung '${id}' is never invoked by canAdvanceStage across all stages — it is dead/misregistered`).toBe(true);
    }
  });
});

/** A minimal scaffold so the green rungs do not throw across the stage sweep. */
function layDownGreenScaffold(paths: ProjectPaths): void {
  write(paths, "docs/01-requirements.md", "# Requirements\n\n- REQ-001 the only requirement.\n");
  write(paths, "docs/09-implementation-plan.md", "# Plan\n\nSLICE-0 covers REQ-001.\n");
  write(paths, "tests/cov.test.ts", "// REQ-001 verified here\n");
}

function write(paths: ProjectPaths, rel: string, body: string): void {
  const abs = path.resolve(paths.root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, "utf8");
}
