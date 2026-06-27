/**
 * BSC-2 (Axis-B slice-6) NEGATIVE-CONTROL probe — the assertion-presence gate.
 *
 * This is a SELF-CONTAINED, REPRODUCIBLE probe spec (run with vitest, the repo's TS runtime — no
 * `dist/` build required) that demonstrates, through the REAL gate (`checkProductionReality`) and
 * the REAL assertion-presence sensor/store (`src/core/assertion-presence.ts`), that a run whose
 * test for a `tested` REQ-ID carries ONLY a TRIVIAL (cannot-fail) assertion — the exact BSC-2
 * blind spot: `th coverage check` counts the REQ "tested" on anchor presence alone — is:
 *
 *   RED   (completes)  when enforcement is OFF  — `TH_BSC2_ENFORCE=0` (presence-trusting): the
 *                      gate observes the anomaly but does not block (a non-blocking NOTICE), so the
 *                      run would be certified complete on a trivially-asserted "tested" REQ.
 *   GREEN (blocked)    when enforcement is ON   — default: the sensor RECOMPUTES the per-REQ
 *                      assertion ground from the test files, finds REQ-001 assertion-free, and
 *                      BLOCKS with the stable token `assertion_presence_unverified`, naming REQ-001
 *                      in `detail.offenders`.
 *
 * It asserts BOTH flag states (this doubles as the fail-open guard for the BSC-2 enforcement
 * flag). The gate recomputes the offender set FRESH from the test bodies — it does NOT trust the
 * receipt's stored ground for the offender decision (the receipt is the F8 correspondence artifact,
 * the live recompute is the verdict). `console.log` lines are the captured evidence in
 * `evidence.md`; the `expect`s make the probe a self-verifying RED→GREEN pair.
 *
 * Run:  npx vitest run .omc/audit/probes/bsc2/probe.test.ts   (via an ephemeral config — the repo
 *       vitest.config.ts scopes `include` to tests/**, so this gitignored probe is run explicitly.)
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, mintRequiredApprovals, type TempProject } from "../../../../tests/helpers";
import { writeState, readState } from "../../../../src/core/state-store";
import { initialState, type TwinHarnessState } from "../../../../src/core/state-schema";
import { runArtifactRegister } from "../../../../src/commands/artifact";
import { runTesterRecord } from "../../../../src/commands/tester";
import { checkProductionReality } from "../../../../src/core/gate-preconditions";
import { appendAssertionPresenceReceipt } from "../../../../src/core/assertion-presence";
import type { ProjectPaths } from "../../../../src/core/paths";

const SAVED = process.env.TH_BSC2_ENFORCE;
let tp: TempProject | undefined;
afterEach(() => {
  if (SAVED === undefined) delete process.env.TH_BSC2_ENFORCE;
  else process.env.TH_BSC2_ENFORCE = SAVED;
  tp?.cleanup();
  tp = undefined;
});

function state(paths: ProjectPaths): TwinHarnessState {
  return readState(paths).state!;
}

/**
 * A GREEN-at-final-verification project (slices settled, coverage clean, report registered,
 * Tester record attached, the closed human-approval required-set satisfied, no repo-map ⇒
 * realization PASSes, no driver receipt ⇒ driver grandfathered PASSes) whose ONLY test for
 * REQ-001 carries a TRIVIAL assertion (`expect(true).toBe(true)`). An assertion-presence receipt
 * is minted recording that trivial ground — so the rung reaches the offender check (not the
 * no-receipt fail-closed). The BSC-2 assertion rung is the only remaining lever.
 */
function trivialAssertedReq(): ProjectPaths {
  tp = makeTempProject();
  const paths = tp.paths;
  const write = (rel: string, body: string) => {
    const abs = path.resolve(paths.root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, "utf8");
  };
  write("docs/01-requirements.md", "# Requirements\n\n- REQ-001 the only requirement.\n");
  write("docs/09-implementation-plan.md", "# Plan\n\nSLICE-0 covers REQ-001.\n");
  // The BSC-2 blind spot: a test that anchors REQ-001 but only asserts a tautology.
  write(
    "tests/x.test.ts",
    `// REQ-001\nimport { it, expect } from "vitest";\nit("x", () => { expect(true).toBe(true); });\n`,
  );
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
  // SENSOR: mint an honest in-process receipt recording the (trivial) ground for REQ-001.
  appendAssertionPresenceReceipt(paths, { producerIdentity: "probe:runner" });
  return paths;
}

describe("BSC-2 negative-control probe — a TRIVIALLY-asserted tested REQ (REQ-001)", () => {
  it("RED leg (TH_BSC2_ENFORCE=0): the run COMPLETES (non-blocking notice) — the trivial assertion slips through", () => {
    process.env.TH_BSC2_ENFORCE = "0";
    const paths = trivialAssertedReq();
    const res = checkProductionReality(paths, state(paths));
    const req001 = (res.assertionPresence ?? []).find((s) => s.reqId === "REQ-001");
    console.log(
      "[RED  OFF] " +
        JSON.stringify({
          "res.ok": res.ok,
          "res.error": res.error ?? null,
          "res.notice.token": res.notice?.token ?? null,
          "req001.assertionFree": req001?.assertionFree ?? null,
          "req001.nonTrivial": req001?.nonTrivialAssertions ?? null,
        }),
    );
    // RED: enforcement off ⇒ the gate does NOT block; the run would be certified complete.
    expect(res.ok).toBe(true);
    expect(res.notice?.token).toBe("assertion_presence_unverified");
    expect(req001?.assertionFree).toBe(true); // observability sees it, enforcement does not act
    expect(req001?.nonTrivialAssertions).toBe(0);
  });

  it("GREEN leg (enforcement ON, default): the gate BLOCKS — the sensor recomputes the offender set", () => {
    delete process.env.TH_BSC2_ENFORCE; // defaults ON
    const paths = trivialAssertedReq();
    const res = checkProductionReality(paths, state(paths));
    const offenders = (res.detail as { offenders?: string[] } | undefined)?.offenders ?? [];
    console.log(
      "[GREEN ON] " +
        JSON.stringify({
          "res.ok": res.ok,
          "res.error": res.error ?? null,
          "res.detail.offenders": offenders,
        }),
    );
    // GREEN: enforcement on ⇒ the assertion-presence sensor blocks the trivially-asserted REQ.
    expect(res.ok).toBe(false);
    expect(res.error).toBe("assertion_presence_unverified");
    expect(offenders).toContain("REQ-001");
  });
});
