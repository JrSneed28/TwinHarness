/**
 * SLICE-4 — Decision-governance CLI handlers (REQ-401..407, 412, 413).
 *
 * Anchored acceptance tests for the handler contracts: runDecisionAdd /
 * runDecisionApprove / runDecisionCheck / runDecisionDetect / runDecisionList.
 * Test names are the exact anchors from docs/08-test-strategy.md (§Slice 4
 * handler integration tests) and the SLICE-4 block of
 * docs/09-implementation-plan.md.
 *
 * Anchors covered: REQ-402, REQ-403, REQ-404, REQ-405, REQ-406, REQ-407,
 * REQ-412, REQ-413, REQ-NFR-005. (REQ-401 store coverage lives in
 * decision-store.test.ts.)
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { readState, writeState } from "../src/core/state-store";
import {
  runDecisionAdd,
  runDecisionApprove,
  runDecisionCheck,
  runDecisionDetect,
  runDecisionList,
  DECISION_GATE_EXIT,
} from "../src/commands/decision";
import { decisionsPath, readDecisionEvents } from "../src/core/decisions";

let tp: TempProject | undefined;
afterEach(() => {
  tp?.cleanup();
  tp = undefined;
});

/** Init a project and return its temp handle (state dir present). */
function initProject(): TempProject {
  const p = makeTempProject();
  runInit(p.paths, {});
  return p;
}

/** Number of JSONL lines currently in decisions.jsonl (0 when absent). */
function lineCount(p: TempProject): number {
  const f = decisionsPath(p.paths);
  if (!fs.existsSync(f)) return 0;
  return fs.readFileSync(f, "utf8").split(/\r?\n/).filter((l) => l.trim()).length;
}

/** A fixed clock so audit timestamps are deterministic in tests. */
const clock = (iso: string) => () => new Date(iso);

/** Set state.current_stage (write the validated state back). */
function setStage(p: TempProject, stage: string): void {
  const state = readState(p.paths).state!;
  state.current_stage = stage;
  writeState(p.paths, state);
}

describe("SLICE-4 — th decision add / list / detect", () => {
  it("REQ-402: test_REQ402_add_happy_path_proposed_status — exit 0, status proposed, id DECISION-001, one JSONL line", () => {
    tp = initProject();
    const r = runDecisionAdd(tp.paths, {
      title: "Use sidecar JSONL",
      rationale: "no schema bump",
      links: ["REQ-401"],
      now: clock("2026-06-15T00:00:00.000Z"),
    });
    expect(r.exitCode).toBe(0);
    expect(r.ok).toBe(true);
    expect(r.data?.status).toBe("proposed");
    expect(r.data?.id).toMatch(/^DECISION-001$/);
    expect(r.data?.links).toEqual(["REQ-401"]);
    expect(lineCount(tp)).toBe(1);
  });

  it("REQ-402: test_REQ402_add_missing_field_errors — no title → exit 1, missing_field title, no append", () => {
    tp = initProject();
    const r = runDecisionAdd(tp.paths, { rationale: "r" });
    expect(r.exitCode).toBe(1);
    expect(r.ok).toBe(false);
    expect(r.data?.error).toBe("missing_field");
    expect(r.data?.field).toBe("title");
    expect(lineCount(tp)).toBe(0);
    // Also: missing rationale.
    const r2 = runDecisionAdd(tp.paths, { title: "t" });
    expect(r2.data?.error).toBe("missing_field");
    expect(r2.data?.field).toBe("rationale");
    expect(lineCount(tp)).toBe(0);
  });

  it("REQ-402: test_REQ402_add_is_not_idempotent_mints_new_id — two adds → two distinct ids", () => {
    tp = initProject();
    const a = runDecisionAdd(tp.paths, { title: "a", rationale: "ra", now: clock("2026-06-15T00:00:00.000Z") });
    const b = runDecisionAdd(tp.paths, { title: "b", rationale: "rb", now: clock("2026-06-15T00:01:00.000Z") });
    expect(a.data?.id).toBe("DECISION-001");
    expect(b.data?.id).toBe("DECISION-002");
    expect(lineCount(tp)).toBe(2);
  });

  it("REQ-413: test_REQ413_audit_fields_present_on_proposed_event — proposed line carries proposer + ISO-8601 proposedAt", () => {
    tp = initProject();
    runDecisionAdd(tp.paths, {
      title: "t",
      rationale: "r",
      proposer: "alice",
      now: clock("2026-06-15T12:00:00.000Z"),
    });
    const ev = readDecisionEvents(tp.paths)[0]!;
    expect(ev.proposer).toBe("alice");
    expect(ev.proposedAt).toBe("2026-06-15T12:00:00.000Z");
    expect(new Date(ev.proposedAt!).toISOString()).toBe(ev.proposedAt);
  });

  it("REQ-405: test_REQ405_detect_returns_candidates_from_adr_source — ADR with # Title → one adr candidate", () => {
    tp = initProject();
    const adrDir = path.join(tp.paths.docsDir, "05-adrs");
    fs.mkdirSync(adrDir, { recursive: true });
    fs.writeFileSync(path.join(adrDir, "ADR-001-foo.md"), "# ADR-001 — Foo Decision\n\nbody\n", "utf8");
    const r = runDecisionDetect(tp.paths, {});
    expect(r.exitCode).toBe(0);
    const cands = r.data?.candidates as Array<Record<string, unknown>>;
    const adr = cands.find((c) => c.source === "adr");
    expect(adr).toBeDefined();
    expect(adr!.sourceRef).toBe("docs/05-adrs/ADR-001-foo.md");
    expect(adr!.title).toBe("ADR-001 — Foo Decision");
  });

  it("REQ-405: test_REQ405_detect_returns_empty_when_no_sources — no sources → candidates:[]", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    // Remove the scaffolded drift-log so there are zero candidate sources.
    if (fs.existsSync(tp.paths.driftLog)) fs.rmSync(tp.paths.driftLog);
    const r = runDecisionDetect(tp.paths, {});
    expect(r.exitCode).toBe(0);
    expect(r.data?.candidates).toEqual([]);
  });

  it("REQ-405: test_REQ405_detect_is_readonly_never_appends — decisions.jsonl absent/unchanged after detect", () => {
    tp = initProject();
    const before = lineCount(tp);
    expect(before).toBe(0);
    runDecisionDetect(tp.paths, {});
    expect(fs.existsSync(decisionsPath(tp.paths))).toBe(false);
    expect(lineCount(tp)).toBe(0);
  });

  it("REQ-406: test_REQ406_list_returns_sorted_decisions — three adds, middle approved → sorted; audit only on approved", () => {
    tp = initProject();
    for (let i = 1; i <= 3; i++) {
      runDecisionAdd(tp.paths, { title: `t${i}`, rationale: `r${i}`, now: clock(`2026-06-15T00:0${i}:00.000Z`) });
    }
    // Approve the middle (DECISION-002).
    runDecisionApprove(tp.paths, "DECISION-002", {
      as: "jane",
      tty: { isTTY: true, stdinLine: "y" },
      now: clock("2026-06-15T01:00:00.000Z"),
    });
    const r = runDecisionList(tp.paths, {});
    const decisions = r.data?.decisions as Array<Record<string, unknown>>;
    expect(decisions.map((d) => d.id)).toEqual(["DECISION-001", "DECISION-002", "DECISION-003"]);
    expect(decisions[0]!.status).toBe("proposed");
    expect(decisions[0]!.approver).toBeUndefined();
    expect(decisions[1]!.status).toBe("approved");
    expect(decisions[1]!.approver).toBe("jane");
    expect(decisions[1]!.approvedAt).toBe("2026-06-15T01:00:00.000Z");
    expect(decisions[2]!.approver).toBeUndefined();
  });

  it("REQ-406: test_REQ406_list_empty_when_no_decisions — fresh project → decisions:[], exit 0", () => {
    tp = initProject();
    const r = runDecisionList(tp.paths, {});
    expect(r.exitCode).toBe(0);
    expect(r.data?.decisions).toEqual([]);
  });

  it("REQ-413: test_REQ413_audit_fields_present_on_approved_event — approved line carries approver + approvedAt", () => {
    tp = initProject();
    runDecisionAdd(tp.paths, { title: "t", rationale: "r", now: clock("2026-06-15T00:00:00.000Z") });
    runDecisionApprove(tp.paths, "DECISION-001", {
      as: "bob",
      tty: { isTTY: true, stdinLine: "yes" },
      now: clock("2026-06-15T00:05:00.000Z"),
    });
    const events = readDecisionEvents(tp.paths);
    const approved = events.find((e) => e.event === "approved")!;
    expect(approved.approver).toBe("bob");
    expect(approved.approvedAt).toBe("2026-06-15T00:05:00.000Z");
  });
});

describe("SLICE-4 — th decision approve (TTY barrier + state machine)", () => {
  it("REQ-403: test_REQ403_approve_happy_path_tty_confirmed — isTTY:true + 'y' → exit 0, to:approved, approver, one approved event", () => {
    tp = initProject();
    runDecisionAdd(tp.paths, { title: "t", rationale: "r", now: clock("2026-06-15T00:00:00.000Z") });
    const r = runDecisionApprove(tp.paths, "DECISION-001", {
      as: "alice",
      tty: { isTTY: true, stdinLine: "y" },
      now: clock("2026-06-15T00:05:00.000Z"),
    });
    expect(r.exitCode).toBe(0);
    expect(r.ok).toBe(true);
    expect(r.data?.to).toBe("approved");
    expect(r.data?.approver).toBe("alice");
    const events = readDecisionEvents(tp.paths);
    expect(events.filter((e) => e.event === "approved")).toHaveLength(1);
  });

  it("REQ-403: test_REQ403_approve_unknown_id_errors — DECISION-999 on empty store → unknown_decision", () => {
    tp = initProject();
    const r = runDecisionApprove(tp.paths, "DECISION-999", { tty: { isTTY: true, stdinLine: "y" } });
    expect(r.exitCode).toBe(1);
    expect(r.data?.error).toBe("unknown_decision");
    expect(lineCount(tp)).toBe(0);
  });

  it("REQ-403: test_REQ403_approve_ambiguous_disposition — both --reject and --supersede → ambiguous_disposition", () => {
    tp = initProject();
    runDecisionAdd(tp.paths, { title: "t", rationale: "r", now: clock("2026-06-15T00:00:00.000Z") });
    const r = runDecisionApprove(tp.paths, "DECISION-001", {
      reject: true,
      supersede: "DECISION-002",
      tty: { isTTY: true, stdinLine: "y" },
    });
    expect(r.exitCode).toBe(1);
    expect(r.data?.error).toBe("ambiguous_disposition");
    expect(lineCount(tp)).toBe(1); // only the original proposed line
  });

  it("REQ-412: test_REQ412_approve_no_tty_fails_closed_no_append — isTTY:false → exit 1, no_tty, file unchanged (non-negotiable)", () => {
    tp = initProject();
    runDecisionAdd(tp.paths, { title: "t", rationale: "r", now: clock("2026-06-15T00:00:00.000Z") });
    const before = lineCount(tp);
    const r = runDecisionApprove(tp.paths, "DECISION-001", { tty: { isTTY: false } });
    expect(r.exitCode).toBe(1);
    expect(r.data?.error).toBe("no_tty");
    expect(lineCount(tp)).toBe(before);
  });

  it("REQ-412: test_REQ412_approve_declined_fails_closed_no_append — isTTY:true + 'n' → exit 1, confirmation_declined, no append (non-negotiable)", () => {
    tp = initProject();
    runDecisionAdd(tp.paths, { title: "t", rationale: "r", now: clock("2026-06-15T00:00:00.000Z") });
    const before = lineCount(tp);
    const r = runDecisionApprove(tp.paths, "DECISION-001", { tty: { isTTY: true, stdinLine: "n" } });
    expect(r.exitCode).toBe(1);
    expect(r.data?.error).toBe("confirmation_declined");
    expect(lineCount(tp)).toBe(before);
    // Empty line and EOF likewise decline.
    expect(runDecisionApprove(tp.paths, "DECISION-001", { tty: { isTTY: true, stdinLine: "" } }).data?.error).toBe(
      "confirmation_declined",
    );
    expect(lineCount(tp)).toBe(before);
  });

  it("REQ-412: test_REQ412_approve_failure_paths_leave_no_append — every pre-append failure path leaves the file untouched", () => {
    tp = initProject();
    runDecisionAdd(tp.paths, { title: "t", rationale: "r", now: clock("2026-06-15T00:00:00.000Z") });
    const before = lineCount(tp);
    // no_tty
    runDecisionApprove(tp.paths, "DECISION-001", { tty: { isTTY: false } });
    // declined
    runDecisionApprove(tp.paths, "DECISION-001", { tty: { isTTY: true, stdinLine: "n" } });
    // unknown id
    runDecisionApprove(tp.paths, "DECISION-999", { tty: { isTTY: true, stdinLine: "y" } });
    // illegal transition (supersede a proposed)
    runDecisionApprove(tp.paths, "DECISION-001", {
      supersede: "DECISION-001",
      tty: { isTTY: true, stdinLine: "y" },
    });
    expect(lineCount(tp)).toBe(before);
  });

  it("REQ-407: test_REQ407_approve_non_proposed_illegal_transition — re-approve approved → illegal_transition, currentStatus approved", () => {
    tp = initProject();
    runDecisionAdd(tp.paths, { title: "t", rationale: "r", now: clock("2026-06-15T00:00:00.000Z") });
    runDecisionApprove(tp.paths, "DECISION-001", { tty: { isTTY: true, stdinLine: "y" }, now: clock("2026-06-15T00:05:00.000Z") });
    const r = runDecisionApprove(tp.paths, "DECISION-001", { tty: { isTTY: true, stdinLine: "y" } });
    expect(r.exitCode).toBe(1);
    expect(r.data?.error).toBe("illegal_transition");
    expect(r.data?.currentStatus).toBe("approved");
  });

  it("REQ-407: test_REQ407_supersede_non_approved_illegal_transition — supersede a proposed → illegal_transition", () => {
    tp = initProject();
    runDecisionAdd(tp.paths, { title: "t1", rationale: "r", now: clock("2026-06-15T00:00:00.000Z") });
    runDecisionAdd(tp.paths, { title: "t2", rationale: "r", now: clock("2026-06-15T00:01:00.000Z") });
    const r = runDecisionApprove(tp.paths, "DECISION-001", {
      supersede: "DECISION-002",
      tty: { isTTY: true, stdinLine: "y" },
    });
    expect(r.data?.error).toBe("illegal_transition");
  });

  it("REQ-407: test_REQ407_supersede_unknown_superseding_id — --supersede DECISION-999 → unknown_superseding_id", () => {
    tp = initProject();
    runDecisionAdd(tp.paths, { title: "t", rationale: "r", now: clock("2026-06-15T00:00:00.000Z") });
    runDecisionApprove(tp.paths, "DECISION-001", { tty: { isTTY: true, stdinLine: "y" }, now: clock("2026-06-15T00:05:00.000Z") });
    const r = runDecisionApprove(tp.paths, "DECISION-001", {
      supersede: "DECISION-999",
      tty: { isTTY: true, stdinLine: "y" },
    });
    expect(r.data?.error).toBe("unknown_superseding_id");
    expect(r.data?.supersededBy).toBe("DECISION-999");
  });

  it("REQ-407: test_REQ407_illegal_transition_graph_enforced — every illegal transition → illegal_transition", () => {
    tp = initProject();
    // DECISION-001: reject it → status rejected.
    runDecisionAdd(tp.paths, { title: "t", rationale: "r", now: clock("2026-06-15T00:00:00.000Z") });
    runDecisionApprove(tp.paths, "DECISION-001", { reject: true, tty: { isTTY: true, stdinLine: "y" }, now: clock("2026-06-15T00:01:00.000Z") });
    // rejected → approved is illegal.
    expect(runDecisionApprove(tp.paths, "DECISION-001", { tty: { isTTY: true, stdinLine: "y" } }).data?.error).toBe(
      "illegal_transition",
    );
    // rejected → superseded is illegal (supersede needs approved).
    runDecisionAdd(tp.paths, { title: "t2", rationale: "r", now: clock("2026-06-15T00:02:00.000Z") });
    expect(
      runDecisionApprove(tp.paths, "DECISION-001", {
        supersede: "DECISION-002",
        tty: { isTTY: true, stdinLine: "y" },
      }).data?.error,
    ).toBe("illegal_transition");
    // proposed → superseded is illegal.
    expect(
      runDecisionApprove(tp.paths, "DECISION-002", {
        supersede: "DECISION-001",
        tty: { isTTY: true, stdinLine: "y" },
      }).data?.error,
    ).toBe("illegal_transition");
  });

  it("REQ-407: test_REQ407_reapprove_is_illegal_transition_not_duplicate — second approve illegal; one approved line", () => {
    tp = initProject();
    runDecisionAdd(tp.paths, { title: "t", rationale: "r", now: clock("2026-06-15T00:00:00.000Z") });
    runDecisionApprove(tp.paths, "DECISION-001", { tty: { isTTY: true, stdinLine: "y" }, now: clock("2026-06-15T00:05:00.000Z") });
    const r = runDecisionApprove(tp.paths, "DECISION-001", { tty: { isTTY: true, stdinLine: "y" } });
    expect(r.data?.error).toBe("illegal_transition");
    const approvedLines = readDecisionEvents(tp.paths).filter((e) => e.event === "approved");
    expect(approvedLines).toHaveLength(1);
  });

  it("REQ-NFR-005: test_REQNFR005_approve_refuses_on_broken_tail — corrupt last line → exit 1, chain_broken, no append (non-negotiable)", () => {
    tp = initProject();
    runDecisionAdd(tp.paths, { title: "t1", rationale: "r", now: clock("2026-06-15T00:00:00.000Z") });
    runDecisionAdd(tp.paths, { title: "t2", rationale: "r", now: clock("2026-06-15T00:01:00.000Z") });
    // Corrupt the LAST line's recordHash in place (a forged edit) so the tail
    // chain no longer verifies, but the line still parses (so the tolerant reader
    // returns it and verifyChain catches it).
    const file = decisionsPath(tp.paths);
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim());
    const last = JSON.parse(lines[lines.length - 1]!);
    last.title = "tampered-title"; // edited field; recordHash no longer matches
    lines[lines.length - 1] = JSON.stringify(last);
    fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
    const before = lineCount(tp);
    const r = runDecisionApprove(tp.paths, "DECISION-001", { tty: { isTTY: true, stdinLine: "y" } });
    expect(r.exitCode).toBe(1);
    expect(r.data?.error).toBe("chain_broken");
    expect(lineCount(tp)).toBe(before); // no append on a broken chain
  });
});

describe("SLICE-4 — th decision check (gating predicate)", () => {
  it("REQ-404: test_REQ404_decision_check_fails_on_unapproved_gating — linked to current_stage, unapproved → exit 6, gating non-empty", () => {
    tp = initProject();
    setStage(tp, "architecture");
    runDecisionAdd(tp.paths, {
      title: "gates arch",
      rationale: "r",
      links: ["stage:architecture"],
      now: clock("2026-06-15T00:00:00.000Z"),
    });
    const r = runDecisionCheck(tp.paths, {});
    expect(r.exitCode).toBe(DECISION_GATE_EXIT);
    expect(r.exitCode).toBe(6);
    expect(r.ok).toBe(false);
    const gating = r.data?.gating as Array<Record<string, unknown>>;
    expect(gating).toHaveLength(1);
    expect(gating[0]).toEqual({ decisionId: "DECISION-001", blockedStage: "architecture" });
  });

  it("REQ-404: test_REQ404_decision_check_passes_when_all_approved — same but approved first → exit 0, gating:[]", () => {
    tp = initProject();
    setStage(tp, "architecture");
    runDecisionAdd(tp.paths, {
      title: "gates arch",
      rationale: "r",
      links: ["stage:architecture"],
      now: clock("2026-06-15T00:00:00.000Z"),
    });
    runDecisionApprove(tp.paths, "DECISION-001", { tty: { isTTY: true, stdinLine: "y" }, now: clock("2026-06-15T00:05:00.000Z") });
    const r = runDecisionCheck(tp.paths, {});
    expect(r.exitCode).toBe(0);
    expect(r.ok).toBe(true);
    expect(r.data?.gating).toEqual([]);
  });
});
