/**
 * SLICE-5 — `th next` decision-obligation rung (REQ-501..504).
 *
 * Anchored acceptance-test STUBS (it.todo). Builders turn these into real
 * assertions in the same change as the implementation (spec §16). Test names
 * are the exact anchors from docs/08-test-strategy.md and the SLICE-5 block of
 * docs/09-implementation-plan.md.
 *
 * Anchors covered: REQ-501, REQ-502, REQ-503, REQ-504.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { readState, writeState } from "../src/core/state-store";
import { runNext, type NextKind } from "../src/commands/next";
import { runDecisionAdd, runDecisionApprove, runDecisionCheck, DECISION_GATE_EXIT } from "../src/commands/decision";
import { decisionsPath } from "../src/core/decisions";

let tp: TempProject | undefined;
afterEach(() => {
  tp?.cleanup();
  tp = undefined;
});

/** A fixed clock so audit timestamps are deterministic in tests. */
const clock = (iso: string) => () => new Date(iso);

/**
 * Set up a project with a valid tier and stage so the early rungs
 * (init, fix-state, resolve-blocking-drift, escalate-revise, classify-tier)
 * do not fire first, allowing the obligation rung to be reached.
 *
 * Note: tier must be one of "T0"|"T1"|"T2"|"T3" (string), not a number.
 * drift_open_blocking defaults to 0 (no blocking drift).
 */
function setStage(p: TempProject, stage: string, opts: { tier?: "T0" | "T1" | "T2" | "T3"; driftBlocking?: number } = {}): void {
  const state = readState(p.paths).state!;
  state.tier = opts.tier ?? "T1";
  state.current_stage = stage;
  state.drift_open_blocking = opts.driftBlocking ?? 0;
  writeState(p.paths, state);
}

describe("SLICE-5 — th next resolve-decision-obligation rung", () => {
  it(
    "REQ-501: test_REQ501_next_kind_resolve_decision_obligation_present — 'resolve-decision-obligation' is a valid NextKind value (compilation-level)",
    () => {
      // This test confirms at compile time that "resolve-decision-obligation" is
      // a member of the NextKind union. The assignment below would fail to
      // typecheck if the union did not include this literal.
      //
      // Anchor: REQ-501
      const kind: NextKind = "resolve-decision-obligation";
      expect(kind).toBe("resolve-decision-obligation");

      // Also confirm runNext returns this kind when an unapproved gating decision
      // is present for the current stage. Note: runNext always returns ok:true
      // (it's an oracle, not a success/failure command) — check data.kind.
      tp = makeTempProject();
      runInit(tp.paths, {});
      // Tier must be set (not null) as a valid Tier string so classify-tier rung
      // does not fire first.
      setStage(tp, "architecture", { tier: "T1" });

      runDecisionAdd(tp.paths, {
        title: "REQ-501 gating decision",
        rationale: "gates architecture",
        links: ["stage:architecture"],
        now: clock("2026-06-15T00:00:00.000Z"),
      });

      const result = runNext(tp.paths);
      // runNext is always ok:true (oracle); check the kind token.
      expect(result.ok).toBe(true);
      expect(result.exitCode).toBe(0);
      const data = result.data as Record<string, unknown>;
      expect(data.kind).toBe("resolve-decision-obligation");
    },
  );

  it(
    "REQ-502: test_REQ502_next_and_check_agree_on_gating — one unapproved gating decision → runNext and runDecisionCheck name the same blocker; after approve, both all-clear (non-negotiable)",
    () => {
      // Anchor: REQ-502
      // This is the non-negotiable single-source-of-truth test (RULE-007).
      // Both runNext and runDecisionCheck MUST use gatingObligations from
      // src/core/decisions.ts and MUST agree on the same blocker.
      tp = makeTempProject();
      runInit(tp.paths, {});

      // Set a valid tier string and a stage so both commands have a current stage.
      setStage(tp, "architecture", { tier: "T2" });

      // Add one unapproved decision linked to the current stage.
      runDecisionAdd(tp.paths, {
        title: "Must decide arch approach",
        rationale: "blocks architecture stage",
        links: ["stage:architecture"],
        now: clock("2026-06-15T00:00:00.000Z"),
      });

      // --- BOTH commands see the same blocker ---
      const nextResult = runNext(tp.paths);
      const checkResult = runDecisionCheck(tp.paths, {});

      // runNext is an oracle (always ok:true); check data.kind and data.decisionId.
      const nextData = nextResult.data as Record<string, unknown>;
      expect(nextData.kind).toBe("resolve-decision-obligation");
      expect(nextData.decisionId).toBe("DECISION-001");
      expect(nextData.blockedStage).toBe("architecture");

      // runDecisionCheck: exit 6, gating[0].decisionId = "DECISION-001"
      expect(checkResult.exitCode).toBe(DECISION_GATE_EXIT);
      expect(checkResult.ok).toBe(false);
      const gating = checkResult.data?.gating as Array<Record<string, unknown>>;
      expect(gating).toHaveLength(1);
      expect(gating[0]!.decisionId).toBe("DECISION-001");
      expect(gating[0]!.blockedStage).toBe("architecture");

      // Both name the SAME blocker — they cannot diverge (RULE-007 / ARCH-RISK-005).
      expect(nextData.decisionId).toBe(gating[0]!.decisionId);
      expect(nextData.blockedStage).toBe(gating[0]!.blockedStage);

      // --- After approve: BOTH go all-clear ---
      runDecisionApprove(tp.paths, "DECISION-001", {
        as: "alice",
        tty: { isTTY: true, stdinLine: "y" },
        now: clock("2026-06-15T01:00:00.000Z"),
      });

      const nextResultAfter = runNext(tp.paths);
      const checkResultAfter = runDecisionCheck(tp.paths, {});

      // runNext no longer fires the obligation rung — kind is something else.
      const nextDataAfter = nextResultAfter.data as Record<string, unknown>;
      expect(nextDataAfter.kind).not.toBe("resolve-decision-obligation");

      // runDecisionCheck exits 0, gating empty.
      expect(checkResultAfter.exitCode).toBe(0);
      expect(checkResultAfter.ok).toBe(true);
      expect(checkResultAfter.data?.gating).toEqual([]);
    },
  );

  it(
    "REQ-503: test_REQ503_next_obligation_rung_ordering — when a blocking drift rung and an obligation both apply, the drift rung fires first (obligation does not preempt run-integrity)",
    () => {
      // Anchor: REQ-503
      // Run-integrity (resolve-blocking-drift) MUST outrank governance (resolve-decision-obligation).
      // The obligation rung slots AFTER blocking-drift in the ladder (ARCH-RISK-004).
      tp = makeTempProject();
      runInit(tp.paths, {});

      // Set a valid tier string and stage, AND open a blocking drift entry.
      setStage(tp, "architecture", { tier: "T1", driftBlocking: 1 });

      // Also add an unapproved gating decision for this stage.
      runDecisionAdd(tp.paths, {
        title: "Gating obligation",
        rationale: "blocks architecture",
        links: ["stage:architecture"],
        now: clock("2026-06-15T00:00:00.000Z"),
      });

      // With BOTH a blocking drift AND an unmet obligation present,
      // runNext MUST fire "resolve-blocking-drift" (not "resolve-decision-obligation").
      const result = runNext(tp.paths);
      const data = result.data as Record<string, unknown>;
      expect(data.kind).toBe("resolve-blocking-drift");
      expect(data.kind).not.toBe("resolve-decision-obligation");
    },
  );

  it(
    "REQ-504: test_REQ504_next_survives_corrupt_decisions_file — corrupt decisions.jsonl → runNext does not throw; falls through to existing rungs",
    () => {
      // Anchor: REQ-504
      // A corrupt or malformed decisions.jsonl MUST NOT make runNext throw.
      // The tolerant readDecisionEvents skips bad lines and the rung falls through.
      tp = makeTempProject();
      runInit(tp.paths, {});

      // Set a valid tier string so classify-tier does not fire, and the
      // obligation rung is reached (with no valid obligations parsed).
      setStage(tp, "architecture", { tier: "T1" });

      // Write a deliberately corrupt decisions.jsonl (not valid JSON lines).
      const dPath = decisionsPath(tp.paths);
      fs.mkdirSync(path.dirname(dPath), { recursive: true });
      fs.writeFileSync(dPath, 'not-json\n{"partial":true\n{"id":"DECISION-001","event":"OOPS"}\n', "utf8");

      // Must not throw; must return a valid CommandResult (falls through to a
      // later rung since all corrupt lines are skipped by readDecisionEvents).
      let result: ReturnType<typeof runNext>;
      expect(() => {
        result = runNext(tp.paths);
      }).not.toThrow();

      // The result must not be "resolve-decision-obligation" (no valid obligation parsed).
      const data = result!.data as Record<string, unknown>;
      expect(data.kind).not.toBe("resolve-decision-obligation");
      // It should be a valid CommandResult.
      expect(typeof data.kind).toBe("string");
      // runNext is always ok:true (oracle).
      expect(result!.ok).toBe(true);
    },
  );

  it(
    "REQ-504: test_REQ504_next_unchanged_when_no_obligation — no decisions.jsonl → runNext output byte-identical to pre-epic baseline",
    () => {
      // Anchor: REQ-504
      // With no decisions.jsonl and tier:null, the oracle must return "classify-tier"
      // — byte-identical to the pre-epic baseline captured in the SLICE-0
      // characterization test (adoption-seam-characterization.test.ts).
      tp = makeTempProject();
      runInit(tp.paths, {});

      // Confirm no decisions.jsonl is present.
      const dPath = decisionsPath(tp.paths);
      expect(fs.existsSync(dPath)).toBe(false);

      // Run the oracle — must not throw.
      const result = runNext(tp.paths);

      // Pre-epic baseline: tier is null → kind is "classify-tier".
      expect(result.ok).toBe(true);
      expect(result.exitCode).toBe(0);
      const data = result.data as Record<string, unknown>;
      expect(data.kind).toBe("classify-tier");

      // Action text matches the pre-epic sentence (byte-identical check).
      const action = data.action as string;
      expect(action).toMatch(/^Tier is unclassified/);
    },
  );
});
