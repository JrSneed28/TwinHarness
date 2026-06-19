/**
 * Phase 4 — freshness, partial-scan integration & context budgeting for
 * `th context pack`. REQ-anchored (P4-1, P4-4, P4-6, P4-7, P4-9).
 *
 * Anchors covered: REQ-P4-1 (freshness label + repoMapFresh field),
 *                  REQ-P4-4 (partial/scanIncomplete flag),
 *                  REQ-P4-6 (--max-tokens budget + omission report),
 *                  REQ-P4-7 (REQ-/file-specific packs),
 *                  REQ-P4-9 (additive pack-shape contract).
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { runArtifactRegister } from "../src/commands/artifact";
import { runRepoMap } from "../src/commands/repo";
import { runContextPack } from "../src/commands/context";
import { clearFreshnessCache } from "../src/core/repo-map/freshness-cache";

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

describe("REQ-P4-9: context-pack shape is additive (contract pin)", () => {
  it("carries the new repoMapFresh/partial/scanIncomplete/truncated/omitted fields without dropping existing ones", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeFile(tp, "docs/01-requirements.md", "# Req\n\n## Summary\n\nReading-list CLI.\n");
    runArtifactRegister(tp.paths, "docs/01-requirements.md", 1);

    const res = runContextPack(tp.paths);
    expect(res.ok).toBe(true);
    const d = res.data as Record<string, unknown>;
    // Pre-existing fields (agents depend on these — must not be renamed/removed).
    expect(d).toHaveProperty("artifacts");
    expect(d).toHaveProperty("totalTokens");
    expect(d).toHaveProperty("repoRelevantFiles");
    expect(d).toHaveProperty("repoRelevantNote");
    // New ADDITIVE Phase-4 fields.
    expect(d).toHaveProperty("repoMapFresh");
    expect(d).toHaveProperty("partial");
    expect(d).toHaveProperty("scanIncomplete");
    expect(d).toHaveProperty("truncated");
    expect(d).toHaveProperty("omitted");
    expect(d).toHaveProperty("maxTokens");
    expect(Array.isArray(d.omitted)).toBe(true);
  });
});

describe("REQ-P4-1: freshness label + repoMapFresh field", () => {
  it("a fresh, complete repo-map → repoMapFresh:true, no STALE banner", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeFile(tp, "src/a.ts", "export const a = 1;\n");
    runRepoMap(tp.paths, {}); // builds + persists the map matching the tree.
    clearFreshnessCache();

    const res = runContextPack(tp.paths);
    expect(res.ok).toBe(true);
    expect((res.data as Record<string, unknown>).repoMapFresh).toBe(true);
    expect(res.human).not.toContain("STALE repo-map");
  });

  it("a drifted tree → repoMapFresh:false + a STALE label in human output", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeFile(tp, "src/a.ts", "export const a = 1;\n");
    runRepoMap(tp.paths, {});
    clearFreshnessCache();
    // Mutate a tracked file AFTER the map was built → stale.
    writeFile(tp, "src/a.ts", "export const a = 2; // changed\n");

    const res = runContextPack(tp.paths);
    expect(res.ok).toBe(true);
    expect((res.data as Record<string, unknown>).repoMapFresh).toBe(false);
    expect(res.human).toContain("STALE repo-map");
  });
});

describe("REQ-P4-4: partial-scan flag surfaced in the pack", () => {
  it("a partial (capped) repo-map → partial:true, scanIncomplete:true + PARTIAL banner", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    // Several files so a tiny file-count cap forces a partial scan.
    for (let i = 0; i < 6; i++) writeFile(tp, `src/f${i}.ts`, `export const f${i} = ${i};\n`);
    runRepoMap(tp.paths, { scanOptions: { fileCountCap: 2 } });
    clearFreshnessCache();

    const res = runContextPack(tp.paths);
    expect(res.ok).toBe(true);
    const d = res.data as Record<string, unknown>;
    expect(d.partial).toBe(true);
    expect(d.scanIncomplete).toBe(true);
    expect(d.repoMapFresh).toBe(false); // partial is never "fresh".
    expect(res.human).toContain("PARTIAL repo-map");
  });
});

describe("REQ-P4-6: --max-tokens budget + omission report", () => {
  it("drops the lowest-priority artifacts past the budget and reports omissions", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    // Three artifacts; each Summary block is sized so two fit a tight budget but not all three.
    const body = "x".repeat(400); // ~100 tokens.
    writeFile(tp, "docs/01-requirements.md", `# A\n\n## Summary\n\n${body}\n`);
    writeFile(tp, "docs/02-design.md", `# B\n\n## Summary\n\n${body}\n`);
    writeFile(tp, "docs/03-plan.md", `# C\n\n## Summary\n\n${body}\n`);
    runArtifactRegister(tp.paths, "docs/01-requirements.md", 1);
    runArtifactRegister(tp.paths, "docs/02-design.md", 1);
    runArtifactRegister(tp.paths, "docs/03-plan.md", 1);

    const res = runContextPack(tp.paths, { maxTokens: 250 });
    expect(res.ok).toBe(true);
    const d = res.data as { artifacts: unknown[]; truncated: boolean; omitted: Array<{ file: string; reason: string }>; totalTokens: number };
    expect(d.truncated).toBe(true);
    expect(d.omitted.length).toBeGreaterThan(0);
    expect(d.totalTokens).toBeLessThanOrEqual(250);
    expect(d.omitted[0]!.reason).toContain("budget");
    expect(res.human).toContain("Omitted");
  });

  it("no --max-tokens → nothing omitted, truncated:false (back-compat)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeFile(tp, "docs/01-requirements.md", "# A\n\n## Summary\n\nshort.\n");
    runArtifactRegister(tp.paths, "docs/01-requirements.md", 1);

    const res = runContextPack(tp.paths);
    const d = res.data as { truncated: boolean; omitted: unknown[] };
    expect(d.truncated).toBe(false);
    expect(d.omitted).toHaveLength(0);
  });
});

describe("REQ-P4-7: artifact-register validates the Summary block to bound head-fallback bloat", () => {
  it("a markdown artifact WITHOUT a Summary block → non-blocking summaryWarning", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeFile(tp, "docs/01-requirements.md", "# Requirements\n\nNo summary heading here, just body.\n");
    const res = runArtifactRegister(tp.paths, "docs/01-requirements.md", 1);
    expect(res.ok).toBe(true); // never blocks registration.
    expect((res.data as { summaryWarning: string | null }).summaryWarning).toContain("Summary");
    expect(res.human).toContain("⚠");
  });

  it("a markdown artifact WITH a Summary block → no warning", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeFile(tp, "docs/01-requirements.md", "# Requirements\n\n## Summary\n\nTight summary.\n");
    const res = runArtifactRegister(tp.paths, "docs/01-requirements.md", 1);
    expect(res.ok).toBe(true);
    expect((res.data as { summaryWarning: string | null }).summaryWarning).toBeNull();
  });
});

describe("REQ-P4-7: REQ-/file-specific context packs", () => {
  it("--file frames the repo-relevant layer without requiring a slice", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeFile(tp, "src/a.ts", "export const a = 1;\n");
    runRepoMap(tp.paths, {});
    clearFreshnessCache();

    const res = runContextPack(tp.paths, { file: "src/a.ts" });
    expect(res.ok).toBe(true);
    // The repo-relevant section appears for a file selector (was slice-only before P4-7).
    expect(res.human).toContain("Repo-relevant");
  });
});
