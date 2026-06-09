import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { runTraceRender, type TraceRow } from "../src/commands/trace";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

/** Write a file (relative to the temp project root) and return its root-relative path. */
function writeFile(t: TempProject, rel: string, content: string): string {
  const abs = path.join(t.root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  return rel;
}

/** Pull a row by REQ-ID out of the rendered data payload. */
function rowFor(res: { data?: Record<string, unknown> }, req: string): TraceRow {
  const rows = (res.data?.rows ?? []) as TraceRow[];
  const row = rows.find((r) => r.req === req);
  if (!row) throw new Error(`no row for ${req}`);
  return row;
}

describe("REQ-TRACE-001: a fully-anchored requirement renders every column (§17)", () => {
  it("REQ-001 has design/contract/sliceTask/test/code populated from anchors", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeFile(tp, "docs/01-requirements.md", "REQ-001 the system shall.\nREQ-002 it must too.\n");
    writeFile(tp, "docs/04-architecture.md", "Architecture covers REQ-001.\n");
    writeFile(tp, "docs/07-contracts.md", "Contract for REQ-001.\n");
    writeFile(tp, "docs/09-implementation-plan.md", "SLICE-2 / TASK-014 builds REQ-001.\n");
    writeFile(tp, "tests/feature.test.ts", "// REQ-001 is exercised here\n");
    writeFile(tp, "src/sync.ts", "// implements REQ-001\n");

    const res = runTraceRender(tp.paths);
    expect(res.ok).toBe(true);
    expect(res.exitCode).toBe(0);

    const row = rowFor(res, "REQ-001");
    expect(row.design).toEqual(["docs/04-architecture.md"]);
    expect(row.contract).toEqual(["docs/07-contracts.md"]);
    expect(row.sliceTask).toContain("docs/09-implementation-plan.md");
    expect(row.sliceTask).toContain("SLICE-2");
    expect(row.sliceTask).toContain("TASK-014");
    expect(row.test).toEqual(["tests/feature.test.ts"]);
    expect(row.code).toEqual(["src/sync.ts"]);
  });
});

describe("REQ-TRACE-002: an unanchored requirement renders empty cells (—)", () => {
  it("REQ-002 has empty design/contract/sliceTask/test/code and renders as — in the table", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeFile(tp, "docs/01-requirements.md", "REQ-001 here.\nREQ-002 untouched.\n");
    writeFile(tp, "docs/04-architecture.md", "Architecture covers REQ-001.\n");

    const res = runTraceRender(tp.paths);
    expect(res.ok).toBe(true);

    const row = rowFor(res, "REQ-002");
    expect(row.design).toEqual([]);
    expect(row.contract).toEqual([]);
    expect(row.sliceTask).toEqual([]);
    expect(row.test).toEqual([]);
    expect(row.code).toEqual([]);

    // The markdown table shows an em dash for empty cells.
    expect(res.human).toContain("| REQ-002 | — | — | — | — | — |");
  });
});

describe("REQ-TRACE-003: the Design column excludes 01-requirements itself (§17)", () => {
  it("a REQ defined only in 01-requirements has an empty Design column", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeFile(tp, "docs/01-requirements.md", "REQ-001 alone in requirements.\n");

    const res = runTraceRender(tp.paths);
    expect(res.ok).toBe(true);
    const row = rowFor(res, "REQ-001");
    expect(row.design).toEqual([]);
  });
});

describe("REQ-TRACE-004: the human render is a markdown table with the §17 columns", () => {
  it("emits the Requirement | Design ref | Contract | Slice / Task | Test | Code header", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeFile(tp, "docs/01-requirements.md", "REQ-001.\n");

    const res = runTraceRender(tp.paths);
    expect(res.human).toContain("| Requirement | Design ref | Contract | Slice / Task | Test | Code |");
    expect(res.human).toContain("| --- | --- | --- | --- | --- | --- |");
  });
});

describe("REQ-TRACE-005: nothing is persisted — rendered on demand (§17)", () => {
  it("rendering twice does not write any traceability file", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeFile(tp, "docs/01-requirements.md", "REQ-001.\n");

    runTraceRender(tp.paths);
    runTraceRender(tp.paths);

    const docs = fs.readdirSync(tp.paths.docsDir);
    expect(docs.some((f) => /trace|traceability|matrix/i.test(f))).toBe(false);
  });
});

describe("REQ-TRACE-006: missing requirements file fails clearly", () => {
  it("no requirements file → failure no_requirements", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const res = runTraceRender(tp.paths);
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(1);
    expect(res.data?.error).toBe("no_requirements");
    expect(res.human).toContain("no requirements to trace");
  });

  it("a requirements file with no REQ-IDs → failure no_requirements", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeFile(tp, "docs/01-requirements.md", "prose with no anchors at all.\n");
    const res = runTraceRender(tp.paths);
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("no_requirements");
  });
});
