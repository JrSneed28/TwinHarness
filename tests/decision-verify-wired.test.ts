/**
 * verifyChain wired into `decision check` + `decision list`, fail-closed (F-6, C-3a).
 *
 * Before the fix, verifyChain ran ONLY inside `approve` — so `check` (the routine
 * gate) and `list` reported a naively-edited ledger as clean. Now both verify the
 * keyless chain first and fail closed (no key required). This is the always-on
 * tamper-EVIDENCE primitive; the optional keyed seal (C-3b) is tested separately.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { runDecisionAdd, runDecisionCheck, runDecisionList, DECISION_GATE_EXIT } from "../src/commands/decision";
import { decisionsPath } from "../src/core/decisions";

let tp: TempProject | undefined;
afterEach(() => {
  tp?.cleanup();
  tp = undefined;
});

function seed(): void {
  tp = makeTempProject();
  runInit(tp.paths, {});
  runDecisionAdd(tp.paths, {
    title: "t",
    rationale: "r",
    links: ["REQ-1"],
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });
}

/** Edit the first ledger line via `mutate` WITHOUT recomputing recordHash. */
function tamperFirstLine(mutate: (o: Record<string, unknown>) => void): void {
  const f = decisionsPath(tp!.paths);
  const lines = fs.readFileSync(f, "utf8").split(/\r?\n/).filter((l) => l.trim());
  const obj = JSON.parse(lines[0]!) as Record<string, unknown>;
  mutate(obj);
  lines[0] = JSON.stringify(obj);
  fs.writeFileSync(f, lines.join("\n") + "\n", "utf8");
}

describe("F-6/C-3a: check and list fail closed on a broken chain (no key needed)", () => {
  it("a naive edit (recordHash left stale) → decision check exits 6 with chain_broken", () => {
    seed();
    tamperFirstLine((o) => {
      o.title = "FORGED";
    });
    const r = runDecisionCheck(tp!.paths, {});
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(DECISION_GATE_EXIT);
    expect(r.data?.error).toBe("chain_broken");
  });

  it("a naive edit → decision list fails (won't report a tampered ledger as clean)", () => {
    seed();
    tamperFirstLine((o) => {
      o.rationale = "FORGED";
    });
    const r = runDecisionList(tp!.paths, {});
    expect(r.ok).toBe(false);
    expect(r.data?.error).toBe("chain_broken");
  });

  it("an untampered ledger: check passes (exit 0) and list reports it clean", () => {
    seed();
    const c = runDecisionCheck(tp!.paths, {});
    expect(c.exitCode).toBe(0);
    expect(c.data?.error).toBeUndefined();
    const list = runDecisionList(tp!.paths, {});
    expect(list.ok).toBe(true);
    expect((list.data?.decisions as unknown[]).length).toBe(1);
  });
});
