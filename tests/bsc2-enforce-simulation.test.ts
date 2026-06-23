/**
 * Axis-B slice-6 (BSC-2) — the ENFORCE-SIMULATION guard (Lane D, deliverable 6 / plan step 13).
 *
 * The persistent form of the binding precondition for flipping `TH_BSC2_ENFORCE` to default-ON:
 * before the assertion-presence rung becomes a HARD production-reality block, the TwinHarness repo
 * itself must have ZERO assertion offenders, or `npm run verify` (which dogfoods nothing here — see
 * below) would red the whole suite. This test runs the REAL sensor over the repo's OWN `tests/`
 * dir and proves the GATE offender set is EMPTY:
 *
 *     offenders = (computeBreakdown(REPO_ROOT) tested REQs) ∩ (assertionFree REQs from the sensor)
 *
 * Two facts make this empty (the team-lead verified both):
 *   1. TwinHarness has NO `docs/01-requirements.md`, so `computeBreakdown` returns
 *      `{ error }` ⇒ the CHECKED `tested` set is EMPTY ⇒ no REQ is ever an offender. The BSC-2 rung
 *      short-circuits to PASS for exactly this reason (`evaluateAssertionPresence` returns null on a
 *      missing req file). So the enforce flip cannot red this repo via the gate.
 *   2. Independently, the raw sensor's assertionFree set over the repo's tests is also reported, so
 *      a future req file appearing does not silently turn on a latent offender without this guard
 *      catching it first.
 *
 * BLAST-RADIUS BOUND (documented): CI does NOT run `th gate` against the TwinHarness repo (no
 * `docs/01-requirements.md` ⇒ the project is not a TwinHarness-managed project), so the enforce
 * default flip never gates TwinHarness's own CI on its own test bodies. This guard is the standing
 * proof of that precondition; if it ever goes RED, the enforce default must NOT ship until the named
 * offenders carry a non-trivial assertion (or a signed waiver).
 *
 * No `dist/` build required — runs against `src/` via vitest.
 */

import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { resolveProjectPaths } from "../src/core/paths";
import { computeBreakdown } from "../src/core/coverage";
import { computeAssertionPresenceGround } from "../src/core/assertion-presence";

const REPO_ROOT = path.resolve(__dirname, "..");

describe("BSC-2 enforce-simulation guard — the repo's OWN gate offender set is EMPTY", () => {
  it("the GATE offender set (checked-tested ∩ assertionFree) over the repo is EMPTY (the enforce-flip precondition)", () => {
    const paths = resolveProjectPaths(REPO_ROOT);

    // The CHECKED tested set: exactly what the BSC-2 rung enumerates over.
    const bd = computeBreakdown(REPO_ROOT);
    const checkedTested = new Set<string>(
      "error" in bd ? [] : bd.rows.filter((r) => r.tested).map((r) => r.req),
    );

    // The raw assertion-free set the sensor sees over the repo's REAL tests/ dir.
    const ground = computeAssertionPresenceGround(paths);
    const assertionFree = new Set(ground.filter((s) => s.assertionFree).map((s) => s.reqId));

    // The gate offender set is the INTERSECTION — must be empty for the enforce default to ship.
    const offenders = [...checkedTested].filter((req) => assertionFree.has(req)).sort();
    expect(offenders, `enforce-flip precondition violated — assertion-free tested REQs: ${offenders.join(", ")}`).toEqual([]);
  });

  it("documents the blast-radius bound: the repo has NO docs/01-requirements.md, so the checked set is empty", () => {
    // This is the FIRST of the two reasons the gate offender set is empty (see file header). If a
    // requirements file is ever added, this assertion flips and forces a conscious re-evaluation of
    // the enforce precondition (the checked-tested set would then become non-empty).
    const bd = computeBreakdown(REPO_ROOT);
    expect("error" in bd, "TwinHarness has no docs/01-requirements.md ⇒ computeBreakdown errors ⇒ checked set empty").toBe(true);
  });

  it("independently: the raw sensor reports ZERO assertion-free REQs over the repo's tests/ dir", () => {
    // The SECOND reason (independent of the missing req file): even the raw sensor sees no
    // assertion-free REQ over the repo's own tests. (TwinHarness anchors REQ-IDs in its test files
    // via the standard `// REQ-xxx` comments, and those files carry real assertions.) A future
    // assertion-free test body would surface here BEFORE it could become a latent gate offender.
    const paths = resolveProjectPaths(REPO_ROOT);
    const ground = computeAssertionPresenceGround(paths);
    const assertionFree = ground.filter((s) => s.assertionFree).map((s) => s.reqId).sort();
    expect(assertionFree, `raw assertion-free REQs over repo tests: ${assertionFree.join(", ")}`).toEqual([]);
  });
});
