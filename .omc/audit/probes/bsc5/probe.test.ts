/**
 * BSC-5 (Axis-B slice-7) NEGATIVE-CONTROL probe — the dimension-SET-coverage gate.
 *
 * This is a SELF-CONTAINED, REPRODUCIBLE probe spec (run with vitest, the repo's TS runtime — no
 * `dist/` build required) that demonstrates, through the REAL gate (`checkProductionReality`) and
 * the REAL committed declared set (`src/core/declared-dimensions.ts`) + observed re-derivation
 * (`observedDimensionsFromReport`), that a run which DECLARES a required dimension it never OBSERVED
 * — the exact BSC-5 blind spot: completion clears on a verify-report that says "ok" with NO check
 * that the DECLARED dimension set was covered — is:
 *
 *   RED   (completes)  when enforcement is OFF  — `TH_BSC5_ENFORCE=0`: the gate observes the
 *                      coverage gap but does not block (a non-blocking NOTICE), so the run would be
 *                      certified complete with `build` declared-but-never-observed.
 *   GREEN (blocked)    when enforcement is ON   — default: the gate RECOMPUTES declared ⊆ observed
 *                      from the LIVE committed constant + the LIVE verify-report, finds `build`
 *                      uncovered, and BLOCKS with the stable token `dimension_set_uncovered`, naming
 *                      `build` in `detail.missing`.
 *
 * It asserts BOTH flag states (this doubles as the ship-dark guard for the BSC-5 enforcement flag).
 * The gate recomputes the verdict FRESH from the committed declared constant + the live report — it
 * does NOT trust any receipt's stored `covered`/declared/observed fields. `console.log` lines are
 * the captured evidence in `evidence.md`; the `expect`s make the probe a self-verifying RED→GREEN pair.
 *
 * Run:  npx vitest run .omc/audit/probes/bsc5/probe.test.ts   (via an ephemeral config — the repo
 *       vitest.config.ts scopes `include` to tests/**, so this gitignored probe is run explicitly.)
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, mintRequiredApprovals, mintAssertionPresenceForFixture, ASSERTED_COV_TEST, type TempProject } from "../../../../tests/helpers";
import { writeState, readState } from "../../../../src/core/state-store";
import { initialState, type TwinHarnessState } from "../../../../src/core/state-schema";
import { runArtifactRegister } from "../../../../src/commands/artifact";
import { runTesterRecord } from "../../../../src/commands/tester";
import { checkProductionReality } from "../../../../src/core/gate-preconditions";
import { writeVerifyReport } from "../../../../src/core/verify";
import { appendCoverageReceipt } from "../../../../src/core/receipts";
import { declaredDimensionSet, declaredDimensionSetDigest } from "../../../../src/core/declared-dimensions";
import type { ProjectPaths } from "../../../../src/core/paths";

const SAVED = process.env.TH_BSC5_ENFORCE;
let tp: TempProject | undefined;
afterEach(() => {
  if (SAVED === undefined) delete process.env.TH_BSC5_ENFORCE;
  else process.env.TH_BSC5_ENFORCE = SAVED;
  tp?.cleanup();
  tp = undefined;
});

function state(paths: ProjectPaths): TwinHarnessState {
  return readState(paths).state!;
}

/**
 * A GREEN-at-final-verification project (slices settled, coverage clean, report registered, Tester
 * record attached, the closed human-approval required-set satisfied, no repo-map ⇒ realization
 * PASSes, no driver receipt ⇒ driver grandfathered PASSes, assertion-presence minted) whose
 * verify-report OBSERVES `tests-executed` + `typecheck` but NOT `build`. The committed declared set
 * REQUIRES `build`. A coverage receipt SELF-ATTESTS full coverage (claims all three observed) — the
 * claim under test — so the BSC-5 coverage rung is the only remaining lever: the gate RE-DERIVES
 * observed from the live report (never the stored set), finds `build` unobserved, and blocks.
 */
function declaredBuildButUnobserved(): ProjectPaths {
  tp = makeTempProject();
  const paths = tp.paths;
  const write = (rel: string, body: string) => {
    const abs = path.resolve(paths.root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, "utf8");
  };
  write("docs/01-requirements.md", "# Requirements\n\n- REQ-001 the only requirement.\n");
  write("docs/09-implementation-plan.md", "# Plan\n\nSLICE-0 covers REQ-001.\n");
  write("tests/cov.test.ts", ASSERTED_COV_TEST);
  write("docs/10-verification-report.md", "# Verification Report\n\nREQ-001 verified.\n");
  writeState(paths, {
    ...initialState(),
    tier: "T1",
    current_stage: "final-verification",
    implementation_allowed: true,
    slices: [{ id: "SLICE-0", status: "done", components: [] }],
  });
  runArtifactRegister(paths, "docs/10-verification-report.md", 1);
  runTesterRecord(paths, { driver: "cli-e2e", provider: "sandbox", passed: true });
  mintRequiredApprovals(paths, state(paths));
  mintAssertionPresenceForFixture(paths);
  // The BSC-5 blind spot: the report observes tests + typecheck but the declared `build` was
  // never observed (no matching build command in verify-report.json).
  writeVerifyReport(paths, {
    ok: true,
    ranAt: new Date().toISOString(),
    results: [
      { command: "vitest run", exitCode: 0, ok: true, durationMs: 1, outputTail: "" },
      { command: "tsc --noEmit", exitCode: 0, ok: true, durationMs: 1, outputTail: "" },
    ],
  });
  // The coverage CLAIM under test: a receipt self-attesting all-observed (including the unobserved
  // `build`). The gate re-derives observed from the live report, never the receipt's stored set.
  appendCoverageReceipt(paths, {
    producerIdentity: "probe:runner",
    declaredSetDigest: declaredDimensionSetDigest(),
    declaredSet: declaredDimensionSet(),
    observedSet: ["tests-executed", "typecheck", "build"],
  });
  return paths;
}

describe("BSC-5 negative-control probe — a DECLARED-but-unobserved dimension (build)", () => {
  it("RED leg (TH_BSC5_ENFORCE=0): the run COMPLETES (non-blocking notice) — the uncovered dimension slips through", () => {
    process.env.TH_BSC5_ENFORCE = "0";
    const paths = declaredBuildButUnobserved();
    const res = checkProductionReality(paths, state(paths));
    console.log(
      "[RED  OFF] " +
        JSON.stringify({
          "res.ok": res.ok,
          "res.error": res.error ?? null,
          "res.notice.token": res.notice?.token ?? null,
          "res.coverage.status": res.coverage?.status ?? null,
          "res.coverage.declared": res.coverage?.declared ?? null,
          "res.coverage.observed": res.coverage?.observed ?? null,
        }),
    );
    // RED: enforcement off ⇒ the gate does NOT block; the run would be certified complete.
    expect(res.ok).toBe(true);
    expect(res.notice?.token).toBe("dimension_set_uncovered");
    expect(res.coverage?.status).toBe("uncovered"); // observability sees it, enforcement does not act
    expect(res.coverage?.observed).not.toContain("build");
  });

  it("GREEN leg (enforcement ON, default): the gate BLOCKS — recomputed declared ⊄ observed", () => {
    delete process.env.TH_BSC5_ENFORCE; // defaults ON
    const paths = declaredBuildButUnobserved();
    const res = checkProductionReality(paths, state(paths));
    const missing = (res.detail as { missing?: string[] } | undefined)?.missing ?? [];
    console.log(
      "[GREEN ON] " +
        JSON.stringify({
          "res.ok": res.ok,
          "res.error": res.error ?? null,
          "res.detail.reason": (res.detail as { reason?: string } | undefined)?.reason ?? null,
          "res.detail.missing": missing,
        }),
    );
    // GREEN: enforcement on ⇒ the coverage rung blocks the declared-but-unobserved dimension.
    expect(res.ok).toBe(false);
    expect(res.error).toBe("dimension_set_uncovered");
    expect(missing).toContain("build");
  });
});
