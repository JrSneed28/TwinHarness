/**
 * SLICE-4 — Decision-governance store algorithms (REQ-401, REQ-407, REQ-413).
 *
 * Anchored acceptance tests for the pure store algorithms in
 * src/core/decisions.ts: hash chain, verifyChain, reduceDecisions,
 * gatingObligations, id-minting. Test names are the exact anchors from
 * docs/08-test-strategy.md (§Unit Tests / Slice 4 store unit tests) and the
 * SLICE-4 block of docs/09-implementation-plan.md.
 *
 * Anchors covered: REQ-401, REQ-407, REQ-413 (store side), plus the
 * REQ-NFR-005 tamper/durability store algorithms.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import { makeTempProject, type TempProject } from "./helpers";
import {
  GENESIS_PREV_HASH,
  appendDecisionEvent,
  readDecisionEvents,
  verifyChain,
  reduceDecisions,
  mintNextId,
  gatingObligations,
  canonicalStageLink,
  decisionsPath,
  type DecisionEvent,
} from "../src/core/decisions";

let tp: TempProject | undefined;
afterEach(() => {
  tp?.cleanup();
  tp = undefined;
});

/** Ensure the state dir exists so appends land in a real .twinharness/. */
function freshProject(): TempProject {
  const p = makeTempProject();
  fs.mkdirSync(p.paths.stateDir, { recursive: true });
  return p;
}

describe("SLICE-4 — decisions.jsonl store algorithms (hash chain + reduce)", () => {
  it("REQ-401: test_REQ401_genesis_first_append_uses_zero_prevhash — first append → prevHash === GENESIS; recordHash 64-hex", () => {
    tp = freshProject();
    const sealed = appendDecisionEvent(tp.paths, {
      id: "DECISION-001",
      event: "proposed",
      title: "first",
      rationale: "because",
      links: [],
      proposer: "orchestrator",
      proposedAt: "2026-06-15T00:00:00.000Z",
    });
    expect(sealed.prevHash).toBe(GENESIS_PREV_HASH);
    expect(sealed.prevHash).toBe("0".repeat(64));
    expect(sealed.recordHash).toMatch(/^[0-9a-f]{64}$/);
    // It is persisted and the chain verifies.
    const events = readDecisionEvents(tp.paths);
    expect(events).toHaveLength(1);
    expect(verifyChain(events)).toEqual({ ok: true });
  });

  it("REQ-401: test_REQ401_missing_state_dir_reads_empty — readDecisionEvents on a path with no .twinharness/ → [] no throw", () => {
    tp = makeTempProject(); // NOTE: state dir intentionally NOT created
    expect(fs.existsSync(tp.paths.stateDir)).toBe(false);
    expect(readDecisionEvents(tp.paths)).toEqual([]);
  });

  it("REQ-407: test_REQ407_id_never_reused_after_reject_or_supersede — add, reject, add → second add one greater than the rejected id", () => {
    tp = freshProject();
    const first = mintNextId(readDecisionEvents(tp.paths));
    expect(first).toBe("DECISION-001");
    appendDecisionEvent(tp.paths, {
      id: first,
      event: "proposed",
      title: "t1",
      rationale: "r1",
      links: [],
      proposer: "orchestrator",
      proposedAt: "2026-06-15T00:00:00.000Z",
    });
    // Reject DECISION-001 (a transition is a NEW event; the proposed event is preserved).
    appendDecisionEvent(tp.paths, {
      id: first,
      event: "rejected",
      approver: "human",
      approvedAt: "2026-06-15T00:01:00.000Z",
    });
    // Minting now must NOT reuse 001.
    const next = mintNextId(readDecisionEvents(tp.paths));
    expect(next).toBe("DECISION-002");
  });

  it("REQ-413: test_REQ413_audit_fields_present_on_proposed_event — proposed event carries proposer + ISO-8601 proposedAt", () => {
    tp = freshProject();
    const sealed = appendDecisionEvent(tp.paths, {
      id: "DECISION-001",
      event: "proposed",
      title: "t",
      rationale: "r",
      links: ["REQ-401"],
      proposer: "alice",
      proposedAt: "2026-06-15T12:34:56.000Z",
    });
    expect(sealed.proposer).toBe("alice");
    expect(sealed.proposedAt).toBe("2026-06-15T12:34:56.000Z");
    expect(new Date(sealed.proposedAt!).toISOString()).toBe(sealed.proposedAt);
  });

  it("REQ-NFR-005: test_REQNFR005_verifychain_detects_edited_event — editing a field → verifyChain { ok:false, brokenAt:0 } (non-negotiable)", () => {
    tp = freshProject();
    appendDecisionEvent(tp.paths, {
      id: "DECISION-001",
      event: "proposed",
      title: "t1",
      rationale: "r1",
      links: [],
      proposer: "orchestrator",
      proposedAt: "2026-06-15T00:00:00.000Z",
    });
    appendDecisionEvent(tp.paths, {
      id: "DECISION-001",
      event: "approved",
      approver: "human",
      approvedAt: "2026-06-15T00:05:00.000Z",
    });
    // Tamper: edit a field on event 0 (the approver of the first record) WITHOUT
    // recomputing the hash — simulates a forged-in-place edit.
    const events = readDecisionEvents(tp.paths);
    expect(verifyChain(events)).toEqual({ ok: true }); // sanity: intact before tamper
    const tampered: DecisionEvent[] = events.map((e) => ({ ...e }));
    tampered[0]!.title = "forged-title";
    const result = verifyChain(tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.brokenAt).toBe(0);
  });

  it("REQ-NFR-005: test_REQNFR005_verifychain_detects_reorder_and_delete — delete the middle of three → { ok:false, brokenAt:1 } (non-negotiable)", () => {
    tp = freshProject();
    for (let i = 1; i <= 3; i++) {
      appendDecisionEvent(tp.paths, {
        id: `DECISION-00${i}`,
        event: "proposed",
        title: `t${i}`,
        rationale: `r${i}`,
        links: [],
        proposer: "orchestrator",
        proposedAt: `2026-06-15T00:0${i}:00.000Z`,
      });
    }
    const events = readDecisionEvents(tp.paths);
    expect(events).toHaveLength(3);
    expect(verifyChain(events)).toEqual({ ok: true });
    // Delete the middle line → the new index-1 line's prevHash points at the
    // deleted record, not the preceding one → prevHash mismatch at index 1.
    const withoutMiddle = [events[0]!, events[2]!];
    const result = verifyChain(withoutMiddle);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.brokenAt).toBe(1);
      expect(result.reason).toBe("prev_mismatch");
    }
  });

  it("REQ-NFR-005: test_REQNFR005_read_skips_malformed_line — valid / non-JSON / valid → returns 2 valid events, no throw", () => {
    tp = freshProject();
    // Build a valid two-event chain, then splice a garbage line in the middle of
    // the file. The reader must skip the garbage and return only valid events.
    const e1 = appendDecisionEvent(tp.paths, {
      id: "DECISION-001",
      event: "proposed",
      title: "t1",
      rationale: "r1",
      links: [],
    });
    const e2 = appendDecisionEvent(tp.paths, {
      id: "DECISION-002",
      event: "proposed",
      title: "t2",
      rationale: "r2",
      links: [],
    });
    const file = decisionsPath(tp.paths);
    fs.writeFileSync(
      file,
      `${JSON.stringify(e1)}\n}{ this is not json\n${JSON.stringify(e2)}\n`,
      "utf8",
    );
    let events: DecisionEvent[] = [];
    expect(() => {
      events = readDecisionEvents(tp!.paths);
    }).not.toThrow();
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.id)).toEqual(["DECISION-001", "DECISION-002"]);
  });

  it("REQ-NFR-005: test_REQNFR005_partial_tail_line_skipped_on_read — truncated final line → only complete events, no throw", () => {
    tp = freshProject();
    const e1 = appendDecisionEvent(tp.paths, {
      id: "DECISION-001",
      event: "proposed",
      title: "t1",
      rationale: "r1",
      links: [],
    });
    const e2 = appendDecisionEvent(tp.paths, {
      id: "DECISION-002",
      event: "proposed",
      title: "t2",
      rationale: "r2",
      links: [],
    });
    const file = decisionsPath(tp.paths);
    const truncated = JSON.stringify(e2).slice(0, 20); // half a JSON object, no newline
    fs.writeFileSync(file, `${JSON.stringify(e1)}\n${truncated}`, "utf8");
    let events: DecisionEvent[] = [];
    expect(() => {
      events = readDecisionEvents(tp!.paths);
    }).not.toThrow();
    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe("DECISION-001");
  });

  it("REQ-407: reduceDecisions — latest-event-wins; proposed content preserved across transition", () => {
    tp = freshProject();
    appendDecisionEvent(tp.paths, {
      id: "DECISION-001",
      event: "proposed",
      title: "use sidecar jsonl",
      rationale: "no schema bump",
      links: ["REQ-401"],
      proposer: "orchestrator",
      proposedAt: "2026-06-15T00:00:00.000Z",
    });
    appendDecisionEvent(tp.paths, {
      id: "DECISION-001",
      event: "approved",
      approver: "jane",
      approvedAt: "2026-06-15T00:05:00.000Z",
    });
    const reduced = reduceDecisions(readDecisionEvents(tp.paths));
    expect(reduced).toHaveLength(1);
    const d = reduced[0]!;
    expect(d.status).toBe("approved");
    expect(d.title).toBe("use sidecar jsonl"); // carried from proposed
    expect(d.rationale).toBe("no schema bump");
    expect(d.links).toEqual(["REQ-401"]);
    expect(d.proposer).toBe("orchestrator");
    expect(d.approver).toBe("jane");
    expect(d.approvedAt).toBe("2026-06-15T00:05:00.000Z");
  });

  it("REQ-404: gatingObligations — single predicate; stage-linked unapproved gates, approved does not", () => {
    tp = freshProject();
    appendDecisionEvent(tp.paths, {
      id: "DECISION-001",
      event: "proposed",
      title: "gates arch",
      rationale: "r",
      links: [canonicalStageLink("architecture"), "REQ-401"],
      proposer: "orchestrator",
      proposedAt: "2026-06-15T00:00:00.000Z",
    });
    const reduced = reduceDecisions(readDecisionEvents(tp.paths));
    // Unapproved + linked to current stage → gates.
    expect(gatingObligations(reduced, { current_stage: "architecture" })).toEqual([
      { decisionId: "DECISION-001", blockedStage: "architecture" },
    ]);
    // A REQ-ID-only link does NOT gate a different stage.
    expect(gatingObligations(reduced, { current_stage: "contracts" })).toEqual([]);
    // No current stage → no gate.
    expect(gatingObligations(reduced, undefined)).toEqual([]);
    // After approval the same decision no longer gates.
    appendDecisionEvent(tp.paths, {
      id: "DECISION-001",
      event: "approved",
      approver: "human",
      approvedAt: "2026-06-15T00:05:00.000Z",
    });
    const approved = reduceDecisions(readDecisionEvents(tp.paths));
    expect(gatingObligations(approved, { current_stage: "architecture" })).toEqual([]);
  });
});
