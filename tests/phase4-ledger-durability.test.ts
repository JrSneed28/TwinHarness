/**
 * R-15 — `drift-log.md` / `debate-log.md` appends are crash-durable + governed.
 *
 * The two markdown ledgers (`drift-log.md`, `debate-log.md`) are human-readable
 * append-only records that mirror the atomic `state.json` blocking counters. Before
 * this fix, `init` wrote the header with a bare `fs.writeFileSync`, and the
 * `appendDriftLog`/`appendDebateLog` helpers READ THE WHOLE FILE then
 * `writeFileSync`'d the WHOLE FILE back — a non-atomic whole-file rewrite. A crash
 * mid-rewrite can truncate the log, desyncing it from the atomic counter. Neither
 * append path went through `assertGovernedWriteSurface`, the chokepoint every other
 * governed writer honors (the path IS in `GOVERNED_WRITE_SURFACES`, only the
 * assertion was skipped).
 *
 * The fix: init's header → `atomicWriteFile(..., { root })`; the two append helpers →
 * a TRUE `fs.appendFileSync` of ONLY the new block (prior history is never rewritten,
 * so a crash can never truncate it) THREADED through `assertGovernedWriteSurface`.
 * Output stays byte-for-byte identical (the separating `\n` rule is preserved).
 *
 * These tests exercise the two append helpers (via the public commands) + init. The
 * `atomicWriteFile` durability/atomicity itself is already covered by atomic-io tests;
 * here we focus on (a) append-only durability — prior blocks survive every later
 * append, byte-for-byte — and (b) the governed-surface chokepoint is now enforced on
 * the append path (an out-of-surface ledger target is REFUSED).
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import { type ProjectPaths, WriteSurfaceError } from "../src/core/paths";
import { runInit } from "../src/commands/init";
import { runStateSet } from "../src/commands/state";
import { runDriftAdd, runDriftResolve } from "../src/commands/drift";
import { runDebateAdd, runDebateResolve } from "../src/commands/debate";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

const driftLog = (t: TempProject) => fs.readFileSync(t.paths.driftLog, "utf8");
const debateLog = (t: TempProject) => fs.readFileSync(path.join(t.paths.root, "debate-log.md"), "utf8");

describe("R-15: init writes the drift-log header atomically + in-surface", () => {
  it("init creates drift-log.md with the canonical header (atomic writer, no temp leak)", () => {
    tp = makeTempProject();
    const res = runInit(tp.paths, {});
    expect(res.ok).toBe(true);
    const log = driftLog(tp);
    expect(log.startsWith("# Drift Log")).toBe(true);
    expect(log.endsWith("```\n")).toBe(true); // header's trailing fence + newline intact
    // The atomic writer renames a temp into place — no stray temp file is left behind.
    const leftovers = fs.readdirSync(tp.paths.root).filter((f) => f.startsWith("drift-log.md.tmp-"));
    expect(leftovers).toEqual([]);
  });
});

describe("R-15: drift appends are append-only — prior blocks survive every later append", () => {
  it("two adds + a resolve never lose earlier content; the header is preserved verbatim", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const headerBytes = driftLog(tp); // the exact header init wrote

    runDriftAdd(tp.paths, { layer: "requirement", ref: "SLICE-1 / TASK-001", discovery: "first discovery", action: "a1" });
    const afterFirst = driftLog(tp);
    runDriftAdd(tp.paths, { layer: "derived", ref: "SLICE-2 / TASK-002", discovery: "second discovery", action: "a2" });
    const afterSecond = driftLog(tp);
    runDriftResolve(tp.paths, "DRIFT-001");
    const afterResolve = driftLog(tp);

    // Append-only: every earlier state is a strict PREFIX of the next (true append —
    // a whole-file rewrite would not guarantee a byte-exact prefix relationship).
    expect(afterFirst.startsWith(headerBytes)).toBe(true);
    expect(afterSecond.startsWith(afterFirst)).toBe(true);
    expect(afterResolve.startsWith(afterSecond)).toBe(true);

    // And all the human-readable content is still present at the end.
    expect(afterResolve).toContain("## DRIFT-001");
    expect(afterResolve).toContain("first discovery");
    expect(afterResolve).toContain("## DRIFT-002");
    expect(afterResolve).toContain("second discovery");
    expect(afterResolve).toContain("## DRIFT-001 — resolved");
  });

  it("appended bytes equal header + concatenated blocks (byte-compatible with the old rewrite)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    // Each block already ends with a newline, and the header ends with a newline, so
    // the byte-compatible result is plain concatenation (the separator rule adds a
    // newline only when the existing tail lacks one — never the case here).
    runDriftAdd(tp.paths, { layer: "derived", action: "x" });
    const oneBlock = driftLog(tp);
    runDriftAdd(tp.paths, { layer: "derived", action: "y" });
    const twoBlocks = driftLog(tp);
    // The second append must have added exactly the new block onto the first state,
    // with no rewrite of, or gap before, the prior bytes.
    const appended = twoBlocks.slice(oneBlock.length);
    expect(twoBlocks).toBe(oneBlock + appended);
    expect(appended).toContain("## DRIFT-002");
    expect(appended.endsWith("\n")).toBe(true);
  });
});

describe("R-15: debate appends are append-only — prior blocks survive every later append", () => {
  it("add + resolve never lose earlier content; the header is preserved verbatim", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    // The debate ledger is an advanced feature gated at tier <T2 (SG3 P1-C / C-14);
    // record T2 so the debate add/resolve reach the ledger instead of tier_locked.
    runStateSet(tp.paths, "tier", "T2", { emergency: true });
    runDebateAdd(tp.paths, { topic: "Cache the registry?", positions: "LRU vs none" });
    const afterAdd = debateLog(tp);
    expect(afterAdd.startsWith("# Debate Log")).toBe(true);

    runDebateResolve(tp.paths, { id: "DEBATE-001", resolution: "use an LRU" });
    const afterResolve = debateLog(tp);

    // Append-only: the post-add bytes are a strict prefix of the post-resolve bytes.
    expect(afterResolve.startsWith(afterAdd)).toBe(true);
    expect(afterResolve).toContain("## DEBATE-001");
    expect(afterResolve).toContain("Cache the registry?");
    expect(afterResolve).toContain("use an LRU");
    expect(afterResolve).toContain("## DEBATE-001 — resolved");
  });
});

describe("R-15: the append path is REFUSED when the ledger target is out-of-surface", () => {
  // Direct proof the append now threads the governed-surface chokepoint: point the
  // ledger at a path whose first segment is NOT in GOVERNED_WRITE_SURFACES while
  // keeping a valid governed root/stateDir, and the append must throw WriteSurfaceError
  // (pre-fix the bare writeFileSync wrote anywhere the OS allowed).
  function outOfSurfacePaths(t: TempProject, badRel: string): ProjectPaths {
    return { ...t.paths, driftLog: path.join(t.paths.root, badRel) };
  }

  it("drift add against an out-of-surface drift-log target throws WriteSurfaceError", () => {
    tp = makeTempProject();
    runInit(tp.paths, {}); // valid state.json + stateDir so the lock + readState pass
    const evil = outOfSurfacePaths(tp, "not-governed/evil.md");
    // runDriftAdd serializes under withStateLock then appends — the append's surface
    // assertion (or the self-heal atomicWriteFile, which also asserts) must reject it.
    expect(() => runDriftAdd(evil, { layer: "derived", action: "x" })).toThrow(WriteSurfaceError);
    // Nothing was written outside the surface.
    expect(fs.existsSync(path.join(tp.paths.root, "not-governed"))).toBe(false);
  });
});
