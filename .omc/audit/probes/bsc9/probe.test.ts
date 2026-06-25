/**
 * BSC-9 (Axis-B slice-7) NEGATIVE-CONTROL probe — the toToolResult projection oracle +
 * interview-readiness grounding.
 *
 * This is a SELF-CONTAINED, REPRODUCIBLE probe spec (run with vitest, the repo's TS runtime —
 * no `dist/` build required for the readiness leg) that demonstrates, through the REAL gate
 * (`checkProductionReality`) and the REAL readiness store/oracle (`src/core/interview-readiness.ts`
 * + `src/core/projection-oracle.ts`), that the two BSC-9 blind spots are caught:
 *
 *   BLIND SPOT (readiness): the soft interview gate's `interviewReady` is SELF-ASSERTED — a run
 *   can report `ready:true` by writing the interview store, with no correspondence artifact. The
 *   BSC-9 rung requires a backing InterviewReadinessReceipt.
 *
 *   BLIND SPOT (projection): the ONLY authentic CLI↔MCP divergence surface is `toToolResult`; a
 *   projection that drops/alters ok/exitCode/data is otherwise silent. The BSC-9 rung runs the
 *   projection oracle over a committed twin-call fixture set.
 *
 * RED   (completes)  when enforcement is OFF — `TH_BSC9_ENFORCE=0`: the gate observes the anomaly
 *                    but does not block (a non-blocking NOTICE `bsc9_unverified`), so the run would
 *                    be certified complete on an ungrounded readiness / infidel projection.
 * GREEN (blocked)    when enforcement is ON  — default: the gate BLOCKS with `bsc9_unverified`.
 *
 * It asserts BOTH flag states (this doubles as the fail-open guard for the BSC-9 enforcement flag).
 *
 * Run:  npx vitest run .omc/audit/probes/bsc9/probe.test.ts
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
import { appendReadinessReceipt, readinessRefId } from "../../../../src/core/interview-readiness";
import type { ProjectPaths } from "../../../../src/core/paths";

const SAVED = process.env.TH_BSC9_ENFORCE;
let tp: TempProject | undefined;
afterEach(() => {
  if (SAVED === undefined) delete process.env.TH_BSC9_ENFORCE;
  else process.env.TH_BSC9_ENFORCE = SAVED;
  tp?.cleanup();
  tp = undefined;
});

function state(paths: ProjectPaths): TwinHarnessState {
  return readState(paths).state!;
}

const write = (paths: ProjectPaths, rel: string, body: string) => {
  const abs = path.resolve(paths.root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, "utf8");
};

/** A faithful (zero-infidelity) committed-style fixture set, written into the temp project. */
const FAITHFUL_FIXTURES = {
  fixtures: [
    { tool: "th_state_get", result: { ok: true, exitCode: 0, data: { tier: "T1" }, human: "state" }, projected: { isError: false, text: "state", structuredContent: { tier: "T1", exitCode: 0 } } },
    { tool: "th_next", result: { ok: false, exitCode: 1 }, projected: { isError: true, text: "FAILED", structuredContent: { exitCode: 1 } } },
  ],
};

function writeFixtures(paths: ProjectPaths, set: unknown): void {
  write(paths, ".omc/audit/probes/bsc9/projection-fixtures.json", JSON.stringify(set, null, 2));
}

/**
 * A GREEN-at-final-verification project (slices settled, coverage clean, report registered, Tester
 * record attached, the closed human-approval required-set satisfied, no repo-map ⇒ realization
 * PASSes, no driver receipt ⇒ driver grandfathered PASSes, faithful projection fixtures) whose
 * interview is REQUIRED and asserted READY. The BSC-9 rung is the only remaining lever; whether it
 * passes depends on the readiness receipt + fixtures handed to this builder.
 */
function greenExceptBsc9(opts: { mintReadiness: boolean; fixtures?: unknown }): ProjectPaths {
  tp = makeTempProject();
  const paths = tp.paths;
  write(paths, "docs/01-requirements.md", "# Requirements\n\n- REQ-001 the only requirement.\n");
  write(paths, "docs/09-implementation-plan.md", "# Plan\n\nSLICE-0 covers REQ-001.\n");
  write(paths, "tests/cov.test.ts", `// REQ-001\n${ASSERTED_COV_TEST}`);
  write(paths, "docs/10-verification-report.md", "# Verification Report\n\nREQ-001 verified.\n");
  // Interview REQUIRED + asserted READY (confidence ≥ cutoff) — the self-asserted readiness.
  write(
    paths,
    ".twinharness/interview.json",
    JSON.stringify({ idea: "probe", cutoff: 0.8, rounds: [{ question: "q", answer: "a", scores: { goal: 1, constraints: 1, criteria: 1 }, confidence: 0.95, entities: [] }], confidence: 0.95, status: "in-progress" }, null, 2) + "\n",
  );
  writeFixtures(paths, opts.fixtures ?? FAITHFUL_FIXTURES);
  writeState(paths, {
    ...initialState(),
    tier: "T1",
    current_stage: "final-verification",
    implementation_allowed: true,
    interview_required: true,
    slices: [{ id: "SLICE-0", status: "done", components: [] }],
  });
  runArtifactRegister(paths, "docs/10-verification-report.md", 1);
  runTesterRecord(paths, { driver: "cli-e2e", provider: "sandbox", passed: true });
  mintRequiredApprovals(paths, state(paths));
  mintAssertionPresenceForFixture(paths);
  // Mint the backing readiness receipt LAST (after interview.json is final) when the green path
  // wants it — the receipt binds the interview-store digest at this moment.
  if (opts.mintReadiness) {
    appendReadinessReceipt(paths, {
      refId: readinessRefId(paths),
      confidence: 0.95,
      cutoff: 0.8,
      storePath: ".twinharness/interview.json",
      producerIdentity: "probe:runner",
    });
  }
  return paths;
}

describe("BSC-9 negative-control probe — readiness asserted without a backing receipt", () => {
  it("RED leg (TH_BSC9_ENFORCE=0): the run COMPLETES (non-blocking notice) — ungrounded readiness slips through", () => {
    process.env.TH_BSC9_ENFORCE = "0";
    const paths = greenExceptBsc9({ mintReadiness: false });
    const res = checkProductionReality(paths, state(paths));
    console.log(
      "[RED  OFF] " +
        JSON.stringify({ "res.ok": res.ok, "res.error": res.error ?? null, "res.notice.token": res.notice?.token ?? null, "readinessStatus": (res.notice?.detail as { readinessStatus?: string } | undefined)?.readinessStatus ?? null }),
    );
    expect(res.ok).toBe(true);
    expect(res.notice?.token).toBe("bsc9_unverified");
    expect((res.notice?.detail as { readinessStatus?: string }).readinessStatus).toBe("absent");
  });

  it("GREEN leg (enforcement ON, default): the gate BLOCKS — readiness has no backing receipt", () => {
    delete process.env.TH_BSC9_ENFORCE; // defaults ON
    const paths = greenExceptBsc9({ mintReadiness: false });
    const res = checkProductionReality(paths, state(paths));
    console.log("[GREEN ON] " + JSON.stringify({ "res.ok": res.ok, "res.error": res.error ?? null, "readinessStatus": (res.detail as { readinessStatus?: string } | undefined)?.readinessStatus ?? null }));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("bsc9_unverified");
    expect((res.detail as { readinessStatus?: string }).readinessStatus).toBe("absent");
  });

  it("GREEN+receipt: a backing readiness receipt + faithful projection ⇒ the gate PASSES (non-vacuous)", () => {
    delete process.env.TH_BSC9_ENFORCE; // enforcement ON
    const paths = greenExceptBsc9({ mintReadiness: true });
    const res = checkProductionReality(paths, state(paths));
    console.log("[PASS recpt] " + JSON.stringify({ "res.ok": res.ok, "res.error": res.error ?? null }));
    expect(res.ok).toBe(true);
  });
});
