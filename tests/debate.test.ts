import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { runDebateAdd, runDebateList, runDebateResolve } from "../src/commands/debate";
import { parseDebateEntries } from "../src/core/debate-log";
import { readState } from "../src/core/state-store";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

/** Read the raw debate-log.md (mirrors drift tests reading driftLog). */
function debateLog(t: TempProject): string {
  return fs.readFileSync(path.join(t.paths.root, "debate-log.md"), "utf8");
}

describe("REQ-PCO-042: debate add mints DEBATE-001 and increments debate_open_blocking", () => {
  it("first add → DEBATE-001, open, blocking counter incremented", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const before = readState(tp.paths).state!.debate_open_blocking ?? 0;

    const res = runDebateAdd(tp.paths, {
      topic: "Should ThemeContext own persistence?",
      positions: "A: yes; B: no",
    });
    expect(res.ok).toBe(true);
    expect(res.data?.id).toBe("DEBATE-001");
    expect(res.data?.status).toBe("open");
    expect(res.data?.debate_open_blocking).toBe(before + 1);

    expect(readState(tp.paths).state?.debate_open_blocking).toBe(before + 1);
    expect(debateLog(tp)).toContain("## DEBATE-001");
    expect(debateLog(tp)).toContain("— open");
  });
});

describe("REQ-PCO-042: debate ids auto-increment DEBATE-001 → DEBATE-002", () => {
  it("a second add gets the next id and increments the counter again", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const a = runDebateAdd(tp.paths, { topic: "first" });
    const b = runDebateAdd(tp.paths, { topic: "second" });
    expect(a.data?.id).toBe("DEBATE-001");
    expect(b.data?.id).toBe("DEBATE-002");
    expect(readState(tp.paths).state?.debate_open_blocking).toBe(2);
  });
});

describe("REQ-PCO-042: debate list returns both entries sorted by numeric id", () => {
  it("list returns parsed entries plus the open blocking count", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runDebateAdd(tp.paths, { topic: "alpha", positions: "p1", links: "REQ-1" });
    runDebateAdd(tp.paths, { topic: "beta", positions: "p2" });

    const res = runDebateList(tp.paths);
    expect(res.ok).toBe(true);
    const entries = res.data?.entries as Array<Record<string, string>>;
    expect(entries).toHaveLength(2);
    expect(entries[0]!.id).toBe("DEBATE-001");
    expect(entries[0]!.topic).toBe("alpha");
    expect(entries[0]!.status).toBe("open");
    expect(entries[1]!.id).toBe("DEBATE-002");
    expect(entries[1]!.topic).toBe("beta");
    expect(res.data?.open_blocking).toBe(2);
  });
});

describe("REQ-PCO-042: debate resolve clears the entry and decrements the counter (floor 0)", () => {
  it("resolve an open debate → status resolved, count back to 0, reconciliation recorded", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runDebateAdd(tp.paths, { topic: "cache the registry?" });
    expect(readState(tp.paths).state?.debate_open_blocking).toBe(1);

    const res = runDebateResolve(tp.paths, { id: "DEBATE-001", resolution: "agreed: LRU cache" });
    expect(res.ok).toBe(true);
    expect(res.data?.status).toBe("resolved");
    expect(res.data?.debate_open_blocking).toBe(0);
    expect(readState(tp.paths).state?.debate_open_blocking).toBe(0);

    // List now reports the entry as resolved (effective status, last block wins).
    const list = runDebateList(tp.paths);
    const entries = list.data?.entries as Array<Record<string, string>>;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.status).toBe("resolved");
    expect(entries[0]!.resolution).toBe("agreed: LRU cache");
  });

  it("resolving a non-existent id returns debate_not_found and leaves the counter unchanged", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const res = runDebateResolve(tp.paths, { id: "DEBATE-001" });
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("debate_not_found");
    expect(readState(tp.paths).state?.debate_open_blocking ?? 0).toBe(0);
  });

  it("double-resolve is rejected with already_resolved", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runDebateAdd(tp.paths, { topic: "x" });
    runDebateResolve(tp.paths, { id: "DEBATE-001", resolution: "done" });

    const res = runDebateResolve(tp.paths, { id: "DEBATE-001", resolution: "again" });
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("already_resolved");
    expect(readState(tp.paths).state?.debate_open_blocking).toBe(0);
  });
});

describe("REQ-PCO-042: the debate ledger is append-only and resumable", () => {
  it("a second add does not erase the first entry", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runDebateAdd(tp.paths, { topic: "first topic" });
    runDebateAdd(tp.paths, { topic: "second topic" });

    const log = debateLog(tp);
    expect(log).toContain("## DEBATE-001");
    expect(log).toContain("first topic");
    expect(log).toContain("## DEBATE-002");
    expect(log).toContain("second topic");
  });

  it("the ledger is resumable: parsing after writes recovers every turn + reconciliation", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runDebateAdd(tp.paths, { topic: "persistent debate", positions: "A vs B" });
    runDebateAdd(tp.paths, { topic: "second debate" });
    runDebateResolve(tp.paths, { id: "DEBATE-001", resolution: "B wins" });

    // Re-parse the on-disk ledger as a fresh process would on resume.
    const parsed = parseDebateEntries(debateLog(tp));
    const ids = parsed.map((e) => e.id);
    expect(ids).toContain("DEBATE-001");
    expect(ids).toContain("DEBATE-002");
    // The reconciliation turn for DEBATE-001 is recorded in the ledger.
    const resolvedBlock = parsed.find((e) => e.id === "DEBATE-001" && e.status === "resolved");
    expect(resolvedBlock).toBeDefined();
    expect(resolvedBlock!.resolution).toBe("B wins");

    // The open debate counter survives the writes (1 of 2 resolved).
    expect(readState(tp.paths).state?.debate_open_blocking).toBe(1);
  });
});

describe("REQ-PCO-042: input/init guards", () => {
  it("add without a topic → missing_topic failure", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const res = runDebateAdd(tp.paths, {});
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("missing_topic");
  });

  it("add before init → not_initialized", () => {
    tp = makeTempProject();
    const res = runDebateAdd(tp.paths, { topic: "x" });
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("not_initialized");
  });

  it("resolve without an id → failure", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    expect(runDebateResolve(tp.paths, {}).ok).toBe(false);
  });
});
