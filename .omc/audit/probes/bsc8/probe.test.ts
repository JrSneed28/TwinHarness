/**
 * BSC-8 (Axis-B slice-7) NEGATIVE-CONTROL probe — the tier-correspondence gate.
 *
 * A SELF-CONTAINED, REPRODUCIBLE probe spec (run with vitest, the repo's TS runtime — no
 * `dist/` build required) that demonstrates, through the REAL gate (`checkProductionReality`)
 * and the REAL sensor (`core/tier-classify.classifyBrief` + the tier-correspondence receipt
 * store in `core/receipts.ts`), that a run whose declared `tier` does NOT correspond to the
 * brief's mechanically-computed minimum tier — the exact BSC-8 blind spot: `tier` is
 * GATE_OWNED, but nothing at the completion gate re-checks it against the brief — is:
 *
 *   RED   (completes) when enforcement is OFF — `TH_BSC8_ENFORCE=0` (claim-trusting): the gate
 *                     observes the anomaly but does not block (a non-blocking NOTICE), so the
 *                     run would be certified complete on an under-declared tier.
 *   GREEN (blocked)   when enforcement is ON  — default: the sensor RE-DERIVES the min-tier
 *                     from the brief via `classifyBrief`, finds `claimed T0 < computed-min T1`,
 *                     and BLOCKS with the stable token `tier_correspondence_unverified`
 *                     (`detail.reason: "under_declared"`).
 *
 * It asserts BOTH flag states (this doubles as the fail-open guard for the BSC-8 enforcement
 * flag). The gate recomputes the min-tier FRESH from the brief — it does NOT trust a stored
 * value. `console.log` lines are the captured evidence in `evidence.md`; the `expect`s make
 * the probe a self-verifying RED→GREEN pair.
 *
 * Run:  npx vitest run .omc/audit/probes/bsc8/probe.test.ts   (via an ephemeral config — the
 *       repo vitest.config.ts scopes `include` to tests/**, so this gitignored probe is run
 *       explicitly.)
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  makeTempProject,
  mintRequiredApprovals,
  mintAssertionPresenceForFixture,
  ASSERTED_COV_TEST,
  type TempProject,
} from "../../../../tests/helpers";
import { writeState, readState } from "../../../../src/core/state-store";
import { initialState, type TwinHarnessState } from "../../../../src/core/state-schema";
import { runArtifactRegister } from "../../../../src/commands/artifact";
import { runTesterRecord } from "../../../../src/commands/tester";
import { checkProductionReality } from "../../../../src/core/gate-preconditions";
import { TASK_BRIEF_RELPATH } from "../../../../src/core/receipts";
import type { ProjectPaths } from "../../../../src/core/paths";

const SAVED = process.env.TH_BSC8_ENFORCE;
let tp: TempProject | undefined;
afterEach(() => {
  if (SAVED === undefined) delete process.env.TH_BSC8_ENFORCE;
  else process.env.TH_BSC8_ENFORCE = SAVED;
  tp?.cleanup();
  tp = undefined;
});

function state(paths: ProjectPaths): TwinHarnessState {
  return readState(paths).state!;
}

/**
 * A GREEN-at-final-verification project DECLARING `tier:T0` (which engages NO stages, so the
 * closed human-approval required-set is empty and every prior production-reality rung passes)
 * whose brief carries a blast-radius flag (`money`) — so `classifyBrief` computes min-tier T1.
 * `claimed T0 < computed-min T1` is the BSC-8 under-declared blind spot, and the
 * tier-correspondence rung is the only remaining lever. The brief is written FIRST so the
 * sensor has its ground.
 */
function underDeclaredT0(): ProjectPaths {
  tp = makeTempProject();
  const paths = tp.paths;
  const write = (rel: string, body: string) => {
    const abs = path.resolve(paths.root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, "utf8");
  };
  // A brief whose blast-radius veto forces ≥T1 (so classifyBrief is NOT T0-eligible).
  write(
    TASK_BRIEF_RELPATH,
    JSON.stringify(
      {
        single_file_or_local: true,
        changes_public_interface: false,
        adds_dependency: false,
        obvious_testable_answer: true,
        blast_radius_flags: ["money"],
      },
      null,
      2,
    ) + "\n",
  );
  write("docs/01-requirements.md", "# Requirements\n\n- REQ-001 the only requirement.\n");
  write("docs/09-implementation-plan.md", "# Plan\n\nSLICE-0 covers REQ-001.\n");
  write("docs/10-verification-report.md", "# Verification Report\n\nREQ-001 verified.\n");
  writeState(paths, {
    ...initialState(),
    tier: "T0",
    has_ui: false,
    current_stage: "final-verification",
    implementation_allowed: true,
    slices: [{ id: "SLICE-0", status: "done", components: [] }],
  });
  runArtifactRegister(paths, "docs/10-verification-report.md", 1);
  runTesterRecord(paths, { driver: "cli-e2e", provider: "sandbox", passed: true });
  mintRequiredApprovals(paths, state(paths)); // T0 ⇒ empty required-set, a no-op
  write("tests/cov.test.ts", `// REQ-001\n${ASSERTED_COV_TEST}`);
  mintAssertionPresenceForFixture(paths);
  return paths;
}

describe("BSC-8 negative-control probe — an UNDER-DECLARED tier (T0 over a ≥T1-forcing brief)", () => {
  it("RED leg (TH_BSC8_ENFORCE=0): the run COMPLETES (non-blocking notice) — the under-declared tier slips through", () => {
    process.env.TH_BSC8_ENFORCE = "0";
    const paths = underDeclaredT0();
    const res = checkProductionReality(paths, state(paths));
    console.log(
      "[RED  OFF] " +
        JSON.stringify({
          "res.ok": res.ok,
          "res.error": res.error ?? null,
          "res.notice.token": res.notice?.token ?? null,
          "res.notice.reason":
            (res.notice?.detail as { reason?: string } | undefined)?.reason ?? null,
        }),
    );
    // RED: enforcement off ⇒ the gate does NOT block; the run would be certified complete.
    expect(res.ok).toBe(true);
    expect(res.notice?.token).toBe("tier_correspondence_unverified");
    expect((res.notice?.detail as { reason?: string } | undefined)?.reason).toBe("under_declared");
  });

  it("GREEN leg (enforcement ON, default): the gate BLOCKS — the sensor recomputes the min-tier from the brief", () => {
    delete process.env.TH_BSC8_ENFORCE; // defaults ON
    const paths = underDeclaredT0();
    const res = checkProductionReality(paths, state(paths));
    console.log(
      "[GREEN ON] " +
        JSON.stringify({
          "res.ok": res.ok,
          "res.error": res.error ?? null,
          "res.detail.reason": (res.detail as { reason?: string } | undefined)?.reason ?? null,
          "res.detail.computedMinTier":
            (res.detail as { computedMinTier?: string } | undefined)?.computedMinTier ?? null,
        }),
    );
    // GREEN: enforcement on ⇒ the tier-correspondence sensor blocks the under-declared tier.
    expect(res.ok).toBe(false);
    expect(res.error).toBe("tier_correspondence_unverified");
    expect((res.detail as { reason?: string }).reason).toBe("under_declared");
    expect((res.detail as { computedMinTier?: string }).computedMinTier).toBe("T1");
  });
});
