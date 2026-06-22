/**
 * BSC-4 (Axis-B slice-1a) — decision-approve receipt grounding.
 *
 * `th decision approve` mints a build-coordinate `decision-approve` terminal
 * receipt ONLY on the `approved` disposition, inside the existing approval lock,
 * after the approval event is sealed (execution doc §6). These tests prove:
 *   - an approve mints a `valid` receipt for the id;
 *   - a reject mints NO `decision-approve` receipt;
 *   - a barrier-blocked approval (no TTY) mints NO receipt AND runs no migration
 *     side effects that would create one;
 *   - migration is marked done after a successful approve.
 *
 * Setup mirrors decision.test.ts: scratch projects via makeTempProject (fs.mkdtemp
 * under it), the TTY barrier injected through `opts.tty = { isTTY, stdinLine }`, and
 * a fixed clock for deterministic audit timestamps. The scratch project is NOT a
 * git checkout, so snapshot coordinates are null — irrelevant here, since
 * decision-approve is build-coordinate-only (no target/staleness discrimination).
 */

import { describe, it, expect, afterEach } from "vitest";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { runDecisionAdd, runDecisionApprove } from "../src/commands/decision";
import {
  readReceiptValidated,
  readTerminalReceipts,
  receiptMigrationDone,
} from "../src/core/receipts";

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

/** A fixed clock so audit timestamps are deterministic in tests. */
const clock = (iso: string) => () => new Date(iso);

/** Count of `decision-approve` receipts whose refId matches `id`. */
function approveReceiptCount(p: TempProject, id: string): number {
  return readTerminalReceipts(p.paths).filter(
    (r) => r.kind === "decision-approve" && r.refId === id,
  ).length;
}

describe("BSC-4 — th decision approve mints a build-coordinate receipt", () => {
  it("approve a proposed decision → a valid decision-approve receipt exists for the id", () => {
    tp = initProject();
    runDecisionAdd(tp.paths, { title: "t", rationale: "r", now: clock("2026-06-15T00:00:00.000Z") });
    const r = runDecisionApprove(tp.paths, "DECISION-001", {
      as: "alice",
      tty: { isTTY: true, stdinLine: "y" },
      now: clock("2026-06-15T00:05:00.000Z"),
    });
    expect(r.exitCode).toBe(0);
    expect(r.ok).toBe(true);

    // Exactly one decision-approve receipt for the id, and it validates as `valid`.
    expect(approveReceiptCount(tp, "DECISION-001")).toBe(1);
    const validated = readReceiptValidated(tp.paths, "decision-approve", "DECISION-001");
    expect(validated.status).toBe("valid");
    // Build-coordinate-only: no target was bound, and it is a REAL receipt (the
    // just-approved decision is not grandfathered).
    expect(validated.receipt?.legacy).toBeUndefined();
    expect(validated.receipt?.target_resolves_in_source).toEqual({ path: "", digest: "" });
    expect(validated.receipt?.producer_identity).toBe("cli:th decision approve");
  });

  it("after an approve, receiptMigrationDone(paths) is true", () => {
    tp = initProject();
    runDecisionAdd(tp.paths, { title: "t", rationale: "r", now: clock("2026-06-15T00:00:00.000Z") });
    expect(receiptMigrationDone(tp.paths)).toBe(false); // never ran the producer yet
    runDecisionApprove(tp.paths, "DECISION-001", {
      tty: { isTTY: true, stdinLine: "y" },
      now: clock("2026-06-15T00:05:00.000Z"),
    });
    expect(receiptMigrationDone(tp.paths)).toBe(true);
  });

  it("reject a proposed decision → NO decision-approve receipt is minted", () => {
    tp = initProject();
    runDecisionAdd(tp.paths, { title: "t", rationale: "r", now: clock("2026-06-15T00:00:00.000Z") });
    const r = runDecisionApprove(tp.paths, "DECISION-001", {
      reject: true,
      tty: { isTTY: true, stdinLine: "y" },
      now: clock("2026-06-15T00:05:00.000Z"),
    });
    expect(r.exitCode).toBe(0);
    expect(r.data?.to).toBe("rejected");

    // No receipt minted for the rejected decision (reject is not an approval claim).
    expect(approveReceiptCount(tp, "DECISION-001")).toBe(0);
    // Reject does not run migration, so the validator reports the absent receipt as
    // `legacy` (genuinely-pre-upgrade: no marker present), never `valid`.
    const validated = readReceiptValidated(tp.paths, "decision-approve", "DECISION-001");
    expect(validated.status).not.toBe("valid");
    expect(receiptMigrationDone(tp.paths)).toBe(false);
  });

  it("supersede an approved decision → NO new decision-approve receipt for the superseded id", () => {
    tp = initProject();
    // DECISION-001 approved (mints its own receipt), DECISION-002 proposed.
    runDecisionAdd(tp.paths, { title: "t1", rationale: "r", now: clock("2026-06-15T00:00:00.000Z") });
    runDecisionAdd(tp.paths, { title: "t2", rationale: "r", now: clock("2026-06-15T00:01:00.000Z") });
    runDecisionApprove(tp.paths, "DECISION-001", {
      tty: { isTTY: true, stdinLine: "y" },
      now: clock("2026-06-15T00:05:00.000Z"),
    });
    expect(approveReceiptCount(tp, "DECISION-001")).toBe(1); // from the approve

    // Supersede DECISION-001 by DECISION-002 → no NEW receipt for either id.
    const r = runDecisionApprove(tp.paths, "DECISION-001", {
      supersede: "DECISION-002",
      tty: { isTTY: true, stdinLine: "y" },
      now: clock("2026-06-15T00:06:00.000Z"),
    });
    expect(r.exitCode).toBe(0);
    expect(r.data?.to).toBe("superseded");
    // Still exactly one receipt for DECISION-001 (supersede minted nothing); none
    // for the superseding id.
    expect(approveReceiptCount(tp, "DECISION-001")).toBe(1);
    expect(approveReceiptCount(tp, "DECISION-002")).toBe(0);
  });

  it("a no-TTY blocked approval mints NO receipt and runs no migration side effects", () => {
    tp = initProject();
    runDecisionAdd(tp.paths, { title: "t", rationale: "r", now: clock("2026-06-15T00:00:00.000Z") });
    const r = runDecisionApprove(tp.paths, "DECISION-001", { tty: { isTTY: false } });
    expect(r.exitCode).toBe(1);
    expect(r.data?.error).toBe("no_tty");

    // Barrier fired before any lock/migration/mint: zero receipts, no marker.
    expect(readTerminalReceipts(tp.paths)).toHaveLength(0);
    expect(approveReceiptCount(tp, "DECISION-001")).toBe(0);
    expect(receiptMigrationDone(tp.paths)).toBe(false);
  });

  it("a declined approval (TTY but 'n') mints NO receipt and runs no migration", () => {
    tp = initProject();
    runDecisionAdd(tp.paths, { title: "t", rationale: "r", now: clock("2026-06-15T00:00:00.000Z") });
    const r = runDecisionApprove(tp.paths, "DECISION-001", { tty: { isTTY: true, stdinLine: "n" } });
    expect(r.exitCode).toBe(1);
    expect(r.data?.error).toBe("confirmation_declined");
    expect(readTerminalReceipts(tp.paths)).toHaveLength(0);
    expect(receiptMigrationDone(tp.paths)).toBe(false);
  });
});
