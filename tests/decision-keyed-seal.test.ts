/**
 * Opt-in keyed seal (F-6, C-3b) — HMAC-SHA256 on approval transitions, verified
 * ONLY when TH_DECISION_KEY is explicitly set, warn-only on mismatch.
 *
 * verifyChain (chain continuity) catches naive edits/inserts/reorders but NOT a
 * competently re-sealed chain. The keyed seal catches that reseal — but only with
 * the explicit key (no auto-generated key), and a mismatch is surfaced as a
 * warning, never a fail-closed chain_broken (a per-environment key difference must
 * not turn a clean ledger red).
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { runDecisionAdd, runDecisionApprove, runDecisionCheck } from "../src/commands/decision";
import { decisionsPath, readDecisionEvents, verifyApprovalSeals, computeRecordHash } from "../src/core/decisions";

const KEY = "test-key-deterministic";
let tp: TempProject | undefined;
afterEach(() => {
  tp?.cleanup();
  tp = undefined;
  delete process.env.TH_DECISION_KEY;
});

function addAndApprove(p: TempProject): void {
  runDecisionAdd(p.paths, {
    title: "t",
    rationale: "r",
    links: ["REQ-1"],
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });
  runDecisionApprove(p.paths, "DECISION-001", {
    tty: { isTTY: true, stdinLine: "y" },
    as: "human",
    now: () => new Date("2026-01-02T00:00:00.000Z"),
  });
}

describe("F-6/C-3b: opt-in keyed seal", () => {
  it("seals the approval event deterministically given the same key + content", () => {
    process.env.TH_DECISION_KEY = KEY;
    tp = makeTempProject();
    runInit(tp.paths, {});
    addAndApprove(tp);
    const sealed1 = readDecisionEvents(tp.paths).find((e) => e.event === "approved")!;
    expect(typeof sealed1.keyedHash).toBe("string");

    const tp2 = makeTempProject();
    runInit(tp2.paths, {});
    addAndApprove(tp2);
    const sealed2 = readDecisionEvents(tp2.paths).find((e) => e.event === "approved")!;
    tp2.cleanup();

    expect(sealed2.keyedHash).toBe(sealed1.keyedHash); // byte-stable (REQ-NFR-001)
  });

  it("verifyApprovalSeals passes with the sealing key and fails with a different key", () => {
    process.env.TH_DECISION_KEY = KEY;
    tp = makeTempProject();
    runInit(tp.paths, {});
    addAndApprove(tp);
    const events = readDecisionEvents(tp.paths);
    expect(verifyApprovalSeals(events, KEY).ok).toBe(true);
    expect(verifyApprovalSeals(events, "a-different-key").ok).toBe(false);
  });

  it("no key set → no seal added (default behavior unchanged)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    addAndApprove(tp);
    const ev = readDecisionEvents(tp.paths).find((e) => e.event === "approved")!;
    expect(ev.keyedHash).toBeUndefined();
  });

  it("competent reseal passes verifyChain but the stale keyed seal is caught (warn-only sealWarning)", () => {
    process.env.TH_DECISION_KEY = KEY;
    tp = makeTempProject();
    runInit(tp.paths, {});
    addAndApprove(tp);

    // Flip the approver, then re-seal the keyless chain (recompute recordHash) but
    // leave the stale keyedHash — what an attacker without the key can do.
    const f = decisionsPath(tp.paths);
    const lines = fs.readFileSync(f, "utf8").split(/\r?\n/).filter((l) => l.trim());
    const idx = lines.findIndex((l) => (JSON.parse(l) as { event: string }).event === "approved");
    const obj = JSON.parse(lines[idx]!) as Record<string, unknown>;
    obj.approver = "attacker";
    const { recordHash: _rh, keyedHash: _kh, ...rest } = obj;
    obj.recordHash = computeRecordHash(rest as never); // keyless reseal → verifyChain passes
    lines[idx] = JSON.stringify(obj);
    fs.writeFileSync(f, lines.join("\n") + "\n", "utf8");

    const events = readDecisionEvents(tp.paths);
    expect(verifyApprovalSeals(events, KEY).ok).toBe(false); // the reseal is caught by the seal

    // Command-level: warn-only. The chain itself still verifies, so check does NOT
    // fail-close on the seal; it surfaces a sealWarning marker instead.
    const r = runDecisionCheck(tp.paths, {});
    expect(r.data?.error).not.toBe("chain_broken");
    expect(r.data?.sealWarning).toBeDefined();
  });
});
