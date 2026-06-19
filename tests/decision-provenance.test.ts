/**
 * Phase 6 (#17, D3) — human-only audit provenance + decision-UX clarity (#16).
 *
 * The TTY gate stays a compliant-agent guardrail (no crypto). These tests pin the
 * HARDENING: every approval seals the real observed invocation provenance into the
 * hash chain; an unattributed approval is marked suspect (not laundered to
 * "human"); every approval attempt (including barrier-blocked ones) lands in the
 * durable approval-audit log; and rejected/superseded decisions are surfaced as
 * STILL GATING at the read surfaces.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { readState, writeState } from "../src/core/state-store";
import {
  runDecisionAdd,
  runDecisionApprove,
  runDecisionCheck,
  runDecisionList,
} from "../src/commands/decision";
import {
  readDecisionEvents,
  verifyChain,
  approvalAuditPath,
  type ApprovalProvenance,
} from "../src/core/decisions";

let tp: TempProject | undefined;
afterEach(() => {
  tp?.cleanup();
  tp = undefined;
  delete process.env.TH_APPROVAL_ACTOR;
});

const clock = (iso: string) => () => new Date(iso);

function initProject(): TempProject {
  const p = makeTempProject();
  runInit(p.paths, {});
  return p;
}

function setStage(p: TempProject, stage: string): void {
  const state = readState(p.paths).state!;
  state.current_stage = stage;
  writeState(p.paths, state);
}

describe("REQ-DEC-PROV-001 (P6-1): an approval seals real invocation provenance into the chain", () => {
  it("records isTTY/ppid/parentComm/hostname/pid and keeps the chain valid", () => {
    tp = initProject();
    runDecisionAdd(tp.paths, { title: "t", rationale: "r", now: clock("2026-06-15T00:00:00.000Z") });
    const r = runDecisionApprove(tp.paths, "DECISION-001", {
      as: "alice",
      tty: { isTTY: true, stdinLine: "y" },
      provenance: { isTTY: true, ppid: 4242, parentComm: "bash", hostname: "host-x", pid: 9999 },
      now: clock("2026-06-15T00:05:00.000Z"),
    });
    expect(r.ok).toBe(true);
    const prov = (r.data?.provenance as ApprovalProvenance);
    expect(prov.isTTY).toBe(true);
    expect(prov.ppid).toBe(4242);
    expect(prov.parentComm).toBe("bash");
    expect(prov.hostname).toBe("host-x");
    expect(prov.pid).toBe(9999);

    const approved = readDecisionEvents(tp.paths).find((e) => e.event === "approved")!;
    expect(approved.provenance).toEqual({
      isTTY: true,
      ppid: 4242,
      parentComm: "bash",
      hostname: "host-x",
      pid: 9999,
      attributionSuspect: false,
    });
    // Provenance is SEALED — the chain still verifies, and editing it would break it.
    expect(verifyChain(readDecisionEvents(tp.paths))).toEqual({ ok: true });
  });
});

describe("REQ-DEC-PROV-002 (P6-1): an unattributed approval is marked suspect, not laundered to human", () => {
  it("no --as / no TH_APPROVAL_ACTOR → approver human but attributionSuspect true", () => {
    tp = initProject();
    runDecisionAdd(tp.paths, { title: "t", rationale: "r", now: clock("2026-06-15T00:00:00.000Z") });
    const r = runDecisionApprove(tp.paths, "DECISION-001", {
      tty: { isTTY: true, stdinLine: "y" },
      provenance: { isTTY: true, ppid: 1, parentComm: "x", hostname: "h", pid: 2 },
      now: clock("2026-06-15T00:05:00.000Z"),
    });
    expect(r.ok).toBe(true);
    expect(r.data?.approver).toBe("human");
    expect((r.data?.provenance as ApprovalProvenance).attributionSuspect).toBe(true);
    expect(r.human).toContain("UNATTRIBUTED");
  });

  it("an explicit TH_APPROVAL_ACTOR is NOT suspect", () => {
    tp = initProject();
    process.env.TH_APPROVAL_ACTOR = "ci-bot";
    runDecisionAdd(tp.paths, { title: "t", rationale: "r", now: clock("2026-06-15T00:00:00.000Z") });
    const r = runDecisionApprove(tp.paths, "DECISION-001", {
      tty: { isTTY: true, stdinLine: "y" },
      provenance: { isTTY: true, ppid: 1, parentComm: "x", hostname: "h", pid: 2 },
      now: clock("2026-06-15T00:05:00.000Z"),
    });
    expect(r.data?.approver).toBe("ci-bot");
    expect((r.data?.provenance as ApprovalProvenance).attributionSuspect).toBe(false);
  });
});

describe("REQ-DEC-PROV-003 (P6-1): every approval attempt lands in the durable audit log", () => {
  it("a barrier-blocked (no_tty) attempt is recorded even though decisions.jsonl is untouched", () => {
    tp = initProject();
    runDecisionAdd(tp.paths, { title: "t", rationale: "r", now: clock("2026-06-15T00:00:00.000Z") });
    const r = runDecisionApprove(tp.paths, "DECISION-001", {
      tty: { isTTY: false },
      provenance: { isTTY: false, ppid: 1, parentComm: "x", hostname: "h", pid: 2 },
      now: clock("2026-06-15T00:05:00.000Z"),
    });
    expect(r.data?.error).toBe("no_tty");
    const audit = fs.readFileSync(approvalAuditPath(tp.paths), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(audit).toHaveLength(1);
    expect(audit[0].outcome).toBe("no_tty");
    expect(audit[0].disposition).toBe("approve");
    expect(audit[0].provenance.isTTY).toBe(false);
  });

  it("a sealed approval records outcome=appended", () => {
    tp = initProject();
    runDecisionAdd(tp.paths, { title: "t", rationale: "r", now: clock("2026-06-15T00:00:00.000Z") });
    runDecisionApprove(tp.paths, "DECISION-001", {
      as: "bob",
      tty: { isTTY: true, stdinLine: "y" },
      provenance: { isTTY: true, ppid: 1, parentComm: "x", hostname: "h", pid: 2 },
      now: clock("2026-06-15T00:05:00.000Z"),
    });
    const audit = fs.readFileSync(approvalAuditPath(tp.paths), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(audit[audit.length - 1].outcome).toBe("appended");
    expect(audit[audit.length - 1].approver).toBe("bob");
  });
});

describe("REQ-DEC-UX-001 (P6-6): rejected/superseded decisions are surfaced as STILL GATING", () => {
  it("list flags a rejected stage-linked decision as still gating", () => {
    tp = initProject();
    setStage(tp, "architecture");
    runDecisionAdd(tp.paths, {
      title: "gates arch",
      rationale: "r",
      links: ["stage:architecture"],
      now: clock("2026-06-15T00:00:00.000Z"),
    });
    runDecisionApprove(tp.paths, "DECISION-001", {
      reject: true,
      tty: { isTTY: true, stdinLine: "y" },
      provenance: { isTTY: true, ppid: 1, parentComm: "x", hostname: "h", pid: 2 },
      now: clock("2026-06-15T00:05:00.000Z"),
    });
    const list = runDecisionList(tp.paths, {});
    expect(list.data?.stillGating).toEqual(["DECISION-001"]);
    expect(list.human).toContain("STILL GATES");
  });

  it("check still gates a rejected decision (exit 6) and says so per line", () => {
    tp = initProject();
    setStage(tp, "architecture");
    runDecisionAdd(tp.paths, {
      title: "gates arch",
      rationale: "r",
      links: ["stage:architecture"],
      now: clock("2026-06-15T00:00:00.000Z"),
    });
    runDecisionApprove(tp.paths, "DECISION-001", {
      reject: true,
      tty: { isTTY: true, stdinLine: "y" },
      provenance: { isTTY: true, ppid: 1, parentComm: "x", hostname: "h", pid: 2 },
      now: clock("2026-06-15T00:05:00.000Z"),
    });
    const r = runDecisionCheck(tp.paths, {});
    expect(r.exitCode).toBe(6);
    expect(r.human).toContain("still gating");
  });
});

describe("REQ-DEC-UX-002 (P6-6): add discourages stage: links on (reversible) choices", () => {
  it("a stage link surfaces an advisory; a REQ link does not", () => {
    tp = initProject();
    const withStage = runDecisionAdd(tp.paths, {
      title: "t",
      rationale: "r",
      links: ["stage:architecture"],
      now: clock("2026-06-15T00:00:00.000Z"),
    });
    expect((withStage.data?.stageLinks as string[]).length).toBe(1);
    expect(withStage.human).toContain("advisory");

    const withReq = runDecisionAdd(tp.paths, {
      title: "t2",
      rationale: "r",
      links: ["REQ-001"],
      now: clock("2026-06-15T00:01:00.000Z"),
    });
    expect((withReq.data?.stageLinks as string[]).length).toBe(0);
    expect(withReq.human).not.toContain("advisory");
  });
});
