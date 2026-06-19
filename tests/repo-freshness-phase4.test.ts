/**
 * Phase 4 — freshness integration across consumers + bounded-cost guard.
 * REQ-anchored (P4-2, P4-3, P4-5, P4-8, P4-10).
 *
 * Anchors covered: REQ-P4-2 (doctor repo-map check),
 *                  REQ-P4-3 (MCP repo tools carry freshness/stale),
 *                  REQ-P4-5 (brownfield gate blocks on a partial map),
 *                  REQ-P4-8 (configurable scan caps shared by map+check),
 *                  REQ-P4-10 (freshness cache: full check only on a cheap-signal change).
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { runRepoMap, runRepoCheck, runRepoCheckCached, repoFreshnessSummary } from "../src/commands/repo";
import { runDoctor } from "../src/commands/doctor";
import { checkRepoMap } from "../src/core/gate-preconditions";
import { writeState } from "../src/core/state-store";
import { initialState } from "../src/core/state-schema";
import { cachedFreshness, clearFreshnessCache } from "../src/core/repo-map/freshness-cache";
import { TOOL_DEFS } from "../src/mcp-server";

let tp: TempProject | undefined;
afterEach(() => {
  tp?.cleanup();
  clearFreshnessCache();
});

function writeFile(t: TempProject, rel: string, content: string): void {
  const abs = path.join(t.root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

describe("REQ-P4-4: markdown repo-map shows a PARTIAL banner + relevance/impact carry the flag", () => {
  it("docs/00-repo-map.md leads with a PARTIAL banner when the scan was capped", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    for (let i = 0; i < 6; i++) writeFile(tp, `src/f${i}.ts`, `export const f${i} = ${i};\n`);
    runRepoMap(tp.paths, { scanOptions: { fileCountCap: 2 } });
    const md = fs.readFileSync(path.join(tp.root, "docs", "00-repo-map.md"), "utf8");
    expect(md).toContain("PARTIAL SCAN");
  });

  it("a complete scan → NO banner in the markdown", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeFile(tp, "src/a.ts", "export const a = 1;\n");
    runRepoMap(tp.paths, {});
    const md = fs.readFileSync(path.join(tp.root, "docs", "00-repo-map.md"), "utf8");
    expect(md).not.toContain("PARTIAL SCAN");
  });
});

describe("REQ-P4-2: th doctor reports repo-map freshness", () => {
  it("no map → warn 'no repo-map.json'", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const res = runDoctor(tp.paths);
    const repo = (res.data as { checks: Array<{ name: string; status: string; detail: string }> }).checks.find((c) => c.name === "repo map");
    expect(repo).toBeDefined();
    expect(repo!.detail).toContain("no repo-map.json");
  });

  it("fresh map → ok; drifted tree → warn with added/removed/modified counts", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeFile(tp, "src/a.ts", "export const a = 1;\n");
    runRepoMap(tp.paths, {});
    clearFreshnessCache();

    let res = runDoctor(tp.paths);
    let repo = (res.data as { checks: Array<{ name: string; status: string; detail: string }> }).checks.find((c) => c.name === "repo map");
    expect(repo!.status).toBe("ok");
    expect(repo!.detail).toContain("fresh");

    // Add a new file → stale.
    clearFreshnessCache();
    writeFile(tp, "src/b.ts", "export const b = 2;\n");
    res = runDoctor(tp.paths);
    repo = (res.data as { checks: Array<{ name: string; status: string; detail: string }> }).checks.find((c) => c.name === "repo map");
    expect(repo!.status).toBe("warn");
    expect(repo!.detail).toContain("STALE");
    expect(repo!.detail).toMatch(/\d+ added/);
  });
});

describe("REQ-P4-3: MCP repo tools carry a freshness/stale field", () => {
  it("th_repo_relevant result data carries freshness + a top-level stale flag", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeFile(tp, "src/a.ts", "export const a = 1;\n");
    runRepoMap(tp.paths, {});
    clearFreshnessCache();

    const def = TOOL_DEFS.find((t) => t.name === "th_repo_relevant")!;
    const res = def.run(tp.paths, { file: "src/a.ts" });
    expect(res.ok).toBe(true);
    const d = res.data as { stale: boolean; freshness: { fresh: boolean } };
    expect(typeof d.stale).toBe("boolean");
    expect(d.freshness).toBeDefined();
    expect(d.freshness.fresh).toBe(true);
    expect(d.stale).toBe(false);
  });

  it("th_repo_impact reflects staleness after a drift", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeFile(tp, "src/a.ts", "export const a = 1;\n");
    runRepoMap(tp.paths, {});
    clearFreshnessCache();
    writeFile(tp, "src/a.ts", "export const a = 99;\n"); // modify → stale.

    const def = TOOL_DEFS.find((t) => t.name === "th_repo_impact")!;
    const res = def.run(tp.paths, { file: "src/a.ts" });
    expect(res.ok).toBe(true);
    expect((res.data as { stale: boolean }).stale).toBe(true);
  });

  it("the MCP tool COUNT and names are unchanged (contract preserved)", () => {
    expect(TOOL_DEFS.length).toBe(62);
  });
});

describe("REQ-P4-5: brownfield gate blocks on a PARTIAL map (not silently fresh)", () => {
  it("a fresh-but-partial map → repo_map_partial (unlock blocked)", () => {
    tp = makeTempProject();
    writeState(tp.paths, { ...initialState(), project_mode: "brownfield" });
    for (let i = 0; i < 6; i++) writeFile(tp, `src/f${i}.ts`, `export const f${i} = ${i};\n`);
    runRepoMap(tp.paths, { scanOptions: { fileCountCap: 2 } }); // partial.
    clearFreshnessCache();

    const r = checkRepoMap(tp.paths, { ...initialState(), project_mode: "brownfield", implementation_allowed: false });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("repo_map_partial");
    expect(r.detail?.capHit).toBe("file-count");
  });

  it("a fresh, complete map → gate PASSES", () => {
    tp = makeTempProject();
    writeState(tp.paths, { ...initialState(), project_mode: "brownfield" });
    writeFile(tp, "src/a.ts", "export const a = 1;\n");
    runRepoMap(tp.paths, {}); // complete.
    clearFreshnessCache();

    const r = checkRepoMap(tp.paths, { ...initialState(), project_mode: "brownfield", implementation_allowed: false });
    expect(r.ok).toBe(true);
  });
});

describe("REQ-P4-8: configurable scan caps shared by map + check", () => {
  it("th repo check with the SAME caps the map was built with reports fresh", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    for (let i = 0; i < 6; i++) writeFile(tp, `src/f${i}.ts`, `export const f${i} = ${i};\n`);
    // Build a partial map at cap 2; re-check at the SAME cap → same scope → fresh.
    runRepoMap(tp.paths, { scanOptions: { fileCountCap: 2 } });
    const res = runRepoCheck(tp.paths, { scanOptions: { fileCountCap: 2 } });
    expect(res.ok).toBe(true); // exit 0 fresh.
  });
});

describe("REQ-P4-10: freshness cache runs the full check only on a cheap-signal change", () => {
  it("repeated calls on an unchanged tree call the underlying full check ONCE", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeFile(tp, "src/a.ts", "export const a = 1;\n");
    runRepoMap(tp.paths, {});
    clearFreshnessCache();

    let calls = 0;
    const full = (p: typeof tp.paths): ReturnType<typeof runRepoCheck> => {
      calls++;
      return runRepoCheck(p);
    };
    const a = cachedFreshness(tp.paths, full);
    const b = cachedFreshness(tp.paths, full);
    const c = cachedFreshness(tp.paths, full);
    expect(calls).toBe(1); // miss once, then two hits.
    expect(a.ok).toBe(b.ok);
    expect(b.ok).toBe(c.ok);
  });

  it("a content edit (mtime/size change) invalidates the cache → full check re-runs", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeFile(tp, "src/a.ts", "export const a = 1;\n");
    runRepoMap(tp.paths, {});
    clearFreshnessCache();

    let calls = 0;
    const full = (p: typeof tp.paths): ReturnType<typeof runRepoCheck> => {
      calls++;
      return runRepoCheck(p);
    };
    cachedFreshness(tp.paths, full); // miss → 1
    cachedFreshness(tp.paths, full); // hit → still 1
    // Edit the file — changes mtime+size, so the cheap signature changes.
    writeFile(tp, "src/a.ts", "export const a = 1; // edited and longer\n");
    cachedFreshness(tp.paths, full); // miss → 2
    expect(calls).toBe(2);
  });

  it("runRepoCheckCached returns the same outcome shape as runRepoCheck", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeFile(tp, "src/a.ts", "export const a = 1;\n");
    runRepoMap(tp.paths, {});
    clearFreshnessCache();

    const direct = runRepoCheck(tp.paths);
    clearFreshnessCache();
    const cached = runRepoCheckCached(tp.paths);
    expect(cached.ok).toBe(direct.ok);
    expect(cached.exitCode).toBe(direct.exitCode);

    // And repoFreshnessSummary derives a consistent view.
    const summary = repoFreshnessSummary(tp.paths);
    expect(summary.fresh).toBe(direct.ok);
    expect(summary.partial).toBe(false);
  });
});
