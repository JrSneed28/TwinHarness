/**
 * `th context pack` — §9 handoff bundle assembly — REQ-anchored.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { runArtifactRegister } from "../src/commands/artifact";
import { runSlicesSync } from "../src/commands/slices";
import { runContextPack } from "../src/commands/context";
import { extractSummary } from "../src/core/summary";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

function writeFile(t: TempProject, rel: string, content: string): void {
  const abs = path.join(t.root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

describe("REQ-SUMMARY-001: extractSummary pulls the Summary block, else a head fallback", () => {
  it("extracts the ## Summary section up to the next heading", () => {
    const md = "# Requirements\n\n## Summary\n\nThis builds X for Y.\n\n## Details\n\nlots of detail\n";
    const { summary } = extractSummary(md);
    expect(summary).toBe("This builds X for Y.");
  });

  it("no Summary heading → summary null, head holds the opening lines", () => {
    const md = "# Title\n\nfirst line\nsecond line\n";
    const { summary, head } = extractSummary(md);
    expect(summary).toBeNull();
    expect(head).toContain("# Title");
  });
});

describe("REQ-CONTEXT-PACK-001: pack assembles approved-artifact Summary blocks", () => {
  it("includes each registered artifact's Summary block + a token estimate", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeFile(tp, "docs/01-requirements.md", "# Requirements\n\n## Summary\n\nReading-list CLI.\n\n## Body\n\nREQ-001…\n");
    runArtifactRegister(tp.paths, "docs/01-requirements.md", 1);

    const res = runContextPack(tp.paths);
    expect(res.ok).toBe(true);
    const artifacts = res.data?.artifacts as Array<{ file: string; summary: string | null }>;
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.summary).toBe("Reading-list CLI.");
    expect(res.human).toContain("docs/01-requirements.md");
    expect(typeof res.data?.totalTokens).toBe("number");
  });
});

describe("REQ-CONTEXT-PACK-002: --slice frames the pack with component-overlap awareness", () => {
  it("reports the slice's status, components, and which slices share components (§16)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeFile(
      tp,
      "docs/09-implementation-plan.md",
      [
        "# Plan",
        "",
        "### SLICE-1",
        "Components touched: api, db",
        "",
        "### SLICE-2",
        "Components touched: db",
        "",
        "### SLICE-3",
        "Components touched: ui",
      ].join("\n"),
    );
    runSlicesSync(tp.paths, { planFile: "docs/09-implementation-plan.md" });

    const res = runContextPack(tp.paths, { slice: "SLICE-1" });
    expect(res.ok).toBe(true);
    const slice = res.data?.slice as { id: string; components: string[]; sharesWith: Array<{ id: string; shared: string[] }> };
    expect(slice.id).toBe("SLICE-1");
    // SLICE-2 shares "db"; SLICE-3 (ui) does not overlap.
    const sharedIds = slice.sharesWith.map((x) => x.id);
    expect(sharedIds).toContain("SLICE-2");
    expect(sharedIds).not.toContain("SLICE-3");
  });

  it("unknown slice → failure unknown_slice", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const res = runContextPack(tp.paths, { slice: "SLICE-99" });
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("unknown_slice");
  });
});

describe("REQ-CONTEXT-PACK-003: not_initialized on an empty project", () => {
  it("pack before init → failure not_initialized", () => {
    tp = makeTempProject();
    const res = runContextPack(tp.paths);
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("not_initialized");
  });
});
