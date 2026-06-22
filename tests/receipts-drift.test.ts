/**
 * Axis-B slice-1a (BSC-4) — the drift-resolve receipt producer
 * (`src/commands/drift.ts` `runDriftResolve`).
 *
 * A requirement-layer (BLOCKING) drift resolution now mints a content-bound
 * `drift-resolve` {@link import("../src/core/receipts").TerminalTransitionReceipt}
 * grounded in a real source path, so the flip is recomputable at gate time. These
 * tests pin the producer's contract:
 *  - requirement-layer resolve WITHOUT `--target` → refused (`drift_resolve_target_required`),
 *    counter unchanged, no resolution note appended (no partial flip).
 *  - requirement-layer resolve WITH a non-resolving `--target` → refused
 *    (`receipt_target_unresolved`, negative-control c), no flip.
 *  - requirement-layer resolve WITH a real `--target` → succeeds, counter decremented,
 *    a VALID `drift-resolve` receipt exists for the id.
 *  - derived-layer resolve with no target → still succeeds (unchanged), no receipt minted.
 *  - after a requirement-layer resolve the migration marker is present.
 *
 * Deterministic + Windows-safe (path.join, no shell); scratch projects via
 * `makeTempProject()` + `runInit` (the standard drift-test fixture).
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { runDriftAdd, runDriftResolve } from "../src/commands/drift";
import { readState } from "../src/core/state-store";
import {
  readReceiptValidated,
  readTerminalReceipts,
  receiptMigrationDone,
  collectTerminalEntities,
} from "../src/core/receipts";

let tp: TempProject | undefined;
afterEach(() => {
  tp?.cleanup();
  tp = undefined;
});

/** A fresh, initialized scratch project (the standard drift-test setup). */
function freshProject(): TempProject {
  const p = makeTempProject();
  runInit(p.paths, {});
  return p;
}

/** Read the drift log text (it always exists post-init). */
function driftLog(t: TempProject): string {
  return fs.readFileSync(t.paths.driftLog, "utf8");
}

/** Write a real in-root source file the receipt can ground in; return its rel path. */
function writeSourceFile(root: string, rel: string, content: string): string {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  return rel;
}

/** Initialize and commit the complete fixture, or return false when git is unavailable. */
function commitFixture(root: string): boolean {
  const run = (args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (run(["init"]).error) return false;
  run(["config", "user.email", "t@t.t"]);
  run(["config", "user.name", "t"]);
  run(["config", "commit.gpgsign", "false"]);
  run(["add", "-A"]);
  const committed = run(["commit", "-m", "fixture", "--no-gpg-sign"]);
  return !(typeof committed.status === "number" && committed.status !== 0);
}

describe("REQ-RECEIPT-DRIFT-001: requirement-layer resolve WITHOUT --target is refused", () => {
  it("fails drift_resolve_target_required; counter unchanged; no resolution note", () => {
    tp = freshProject();
    runDriftAdd(tp.paths, { layer: "requirement", action: "blocked" });
    expect(readState(tp.paths).state?.drift_open_blocking).toBe(1);

    const res = runDriftResolve(tp.paths, "DRIFT-001");
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("drift_resolve_target_required");
    expect(res.data?.id).toBe("DRIFT-001");

    // No partial flip: counter is still 1 and no resolution note was appended.
    expect(readState(tp.paths).state?.drift_open_blocking).toBe(1);
    expect(driftLog(tp)).not.toContain("## DRIFT-001 — resolved");
    // And no receipt was minted for the (refused) flip.
    expect(readReceiptValidated(tp.paths, "drift-resolve", "DRIFT-001").status).not.toBe("valid");
  });
});

describe("REQ-RECEIPT-DRIFT-002: requirement-layer resolve with a non-resolving --target is refused (negative-control c)", () => {
  it("fails receipt_target_unresolved; no flip", () => {
    tp = freshProject();
    runDriftAdd(tp.paths, { layer: "requirement", action: "blocked" });
    expect(readState(tp.paths).state?.drift_open_blocking).toBe(1);

    const missing = "src/does-not-exist.ts";
    const res = runDriftResolve(tp.paths, "DRIFT-001", { target: missing });
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("receipt_target_unresolved");
    expect(res.data?.id).toBe("DRIFT-001");
    expect(res.data?.target).toBe(missing);

    // No partial flip.
    expect(readState(tp.paths).state?.drift_open_blocking).toBe(1);
    expect(driftLog(tp)).not.toContain("## DRIFT-001 — resolved");
    // The minting throw happened before any receipt line landed.
    expect(readTerminalReceipts(tp.paths).some((r) => r.refId === "DRIFT-001" && !r.legacy)).toBe(
      false,
    );
  });
});

describe("REQ-RECEIPT-DRIFT-003: requirement-layer resolve with a real --target succeeds and grounds the flip", () => {
  it("decrements the counter, appends the note, and mints a VALID drift-resolve receipt", () => {
    tp = freshProject();
    runDriftAdd(tp.paths, { layer: "requirement", action: "blocked" });
    expect(readState(tp.paths).state?.drift_open_blocking).toBe(1);

    const rel = writeSourceFile(tp.root, "src/foo.ts", "export const foo = 1;\n");
    const res = runDriftResolve(tp.paths, "DRIFT-001", { target: rel });
    expect(res.ok).toBe(true);
    expect(res.data?.drift_open_blocking).toBe(0);

    // The flip landed.
    expect(readState(tp.paths).state?.drift_open_blocking).toBe(0);
    expect(driftLog(tp)).toContain("## DRIFT-001 — resolved");

    // A content-bound, recomputable-at-gate receipt now backs the flip.
    const validated = readReceiptValidated(tp.paths, "drift-resolve", "DRIFT-001");
    expect(validated.status).toBe("valid");
    expect(validated.receipt?.target_resolves_in_source.path).toBe(rel);
  });

  it("stays valid when drift-log.md and the state directory are tracked", () => {
    tp = freshProject();
    runDriftAdd(tp.paths, { layer: "requirement", action: "blocked" });
    const rel = writeSourceFile(tp.root, "src/tracked.ts", "export const tracked = true;\n");
    if (!commitFixture(tp.root)) return;

    expect(runDriftResolve(tp.paths, "DRIFT-001", { target: rel }).ok).toBe(true);
    expect(readReceiptValidated(tp.paths, "drift-resolve", "DRIFT-001").status).toBe("valid");
  });
});

describe("REQ-RECEIPT-DRIFT-004: derived-layer resolve is unchanged — no target, no receipt", () => {
  it("succeeds with no --target and mints no receipt", () => {
    tp = freshProject();
    runDriftAdd(tp.paths, { layer: "derived", action: "auto-applied" });
    const before = readState(tp.paths).state!.drift_open_blocking;

    const res = runDriftResolve(tp.paths, "DRIFT-001");
    expect(res.ok).toBe(true);
    // Derived resolves never touch the blocking counter.
    expect(readState(tp.paths).state?.drift_open_blocking).toBe(before);
    expect(driftLog(tp)).toContain("## DRIFT-001 — resolved");

    // No real (non-legacy) drift-resolve receipt was minted for a derived flip.
    expect(
      readTerminalReceipts(tp.paths).some(
        (r) => r.kind === "drift-resolve" && r.refId === "DRIFT-001" && !r.legacy,
      ),
    ).toBe(false);
    expect(collectTerminalEntities(tp.paths)).not.toContainEqual({
      kind: "drift-resolve",
      refId: "DRIFT-001",
    });
  });
});

describe("REQ-RECEIPT-DRIFT-005: migration runs as part of a requirement-layer resolve", () => {
  it("receiptMigrationDone is true after a requirement-layer resolve", () => {
    tp = freshProject();
    runDriftAdd(tp.paths, { layer: "requirement", action: "blocked" });
    expect(receiptMigrationDone(tp.paths)).toBe(false);

    const rel = writeSourceFile(tp.root, "src/bar.ts", "export const bar = 2;\n");
    const res = runDriftResolve(tp.paths, "DRIFT-001", { target: rel });
    expect(res.ok).toBe(true);

    expect(receiptMigrationDone(tp.paths)).toBe(true);
  });
});
