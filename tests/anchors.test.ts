import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { scanDirForReqIds } from "../src/core/anchors";
import { runAnchorsScan } from "../src/commands/anchors";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

/** Write a file (relative to the temp project root) and return its root-relative path. */
function writeFile(t: TempProject, rel: string, content: string): string {
  const abs = path.join(t.root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  return rel;
}

describe("REQ-ANCHORS-001: scanDirForReqIds maps anchors to files in a nested tree", () => {
  it("finds anchors in nested files and skips node_modules/dist/.git", () => {
    tp = makeTempProject();
    writeFile(tp, "src/a.ts", "// REQ-001 here\n");
    writeFile(tp, "src/nested/b.ts", "// REQ-001 and REQ-002\n");
    writeFile(tp, "src/node_modules/dep.ts", "// REQ-999 must be ignored\n");
    writeFile(tp, "src/dist/out.js", "// REQ-998 must be ignored\n");

    const m = scanDirForReqIds(path.join(tp.root, "src"));
    expect(m.get("REQ-001")).toEqual(["a.ts", "nested/b.ts"]);
    expect(m.get("REQ-002")).toEqual(["nested/b.ts"]);
    expect(m.has("REQ-999")).toBe(false);
    expect(m.has("REQ-998")).toBe(false);
  });

  it("honors an extension predicate and returns an empty map for a missing dir", () => {
    tp = makeTempProject();
    writeFile(tp, "code/keep.ts", "// REQ-010\n");
    writeFile(tp, "code/skip.md", "REQ-011\n");

    const onlyTs = scanDirForReqIds(path.join(tp.root, "code"), (n) => n.endsWith(".ts"));
    expect(onlyTs.has("REQ-010")).toBe(true);
    expect(onlyTs.has("REQ-011")).toBe(false);

    expect(scanDirForReqIds(path.join(tp.root, "does-not-exist")).size).toBe(0);
  });
});

describe("REQ-ANCHORS-002: scan reports per-category maps for selected categories", () => {
  it("default (no flags) scans requirements/tests/code", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeFile(tp, "docs/01-requirements.md", "REQ-001 and REQ-002.\n");
    writeFile(tp, "tests/x.test.ts", "// REQ-001\n");
    writeFile(tp, "src/x.ts", "// REQ-002\n");

    const res = runAnchorsScan(tp.paths);
    expect(res.ok).toBe(true);
    expect(res.exitCode).toBe(0);
    const data = res.data as Record<string, Record<string, string[]>>;
    expect(data.requirements).toEqual({ "REQ-001": ["01-requirements.md"], "REQ-002": ["01-requirements.md"] });
    expect(data.tests).toEqual({ "REQ-001": ["x.test.ts"] });
    expect(data.code).toEqual({ "REQ-002": ["x.ts"] });
  });

  it("only requested categories are included in the data", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeFile(tp, "docs/01-requirements.md", "REQ-001.\n");
    writeFile(tp, "tests/x.test.ts", "// REQ-001\n");
    writeFile(tp, "src/x.ts", "// REQ-001\n");

    const res = runAnchorsScan(tp.paths, { tests: true });
    expect(res.data?.tests).toBeDefined();
    expect(res.data?.requirements).toBeUndefined();
    expect(res.data?.code).toBeUndefined();
  });
});

describe("REQ-ANCHORS-003: orphan detection — a REQ in tests/ not in docs/01-requirements.md is an orphan", () => {
  it("flags anchors in tests/ and src/ that are not defined requirements", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeFile(tp, "docs/01-requirements.md", "REQ-001 only.\n");
    writeFile(tp, "tests/x.test.ts", "// REQ-001 and REQ-404\n");
    writeFile(tp, "src/x.ts", "// REQ-500\n");

    const res = runAnchorsScan(tp.paths);
    expect(res.data?.orphans).toEqual([
      { req: "REQ-404", where: "tests/x.test.ts" },
      { req: "REQ-500", where: "code/x.ts" },
    ]);
  });

  it("no orphans when every tested/coded anchor is a defined requirement", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeFile(tp, "docs/01-requirements.md", "REQ-001 and REQ-002.\n");
    writeFile(tp, "tests/x.test.ts", "// REQ-001\n");
    writeFile(tp, "src/x.ts", "// REQ-002\n");

    const res = runAnchorsScan(tp.paths);
    expect(res.data?.orphans).toEqual([]);
  });
});

describe("REQ-ANCHORS-004: --strict exits 1 on orphans, 0 otherwise", () => {
  it("strict + orphans → failure exit 1", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeFile(tp, "docs/01-requirements.md", "REQ-001.\n");
    writeFile(tp, "tests/x.test.ts", "// REQ-404\n");

    const res = runAnchorsScan(tp.paths, { strict: true });
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(1);
    expect(res.data?.orphans).toEqual([{ req: "REQ-404", where: "tests/x.test.ts" }]);
  });

  it("strict + no orphans → success exit 0", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeFile(tp, "docs/01-requirements.md", "REQ-001.\n");
    writeFile(tp, "tests/x.test.ts", "// REQ-001\n");

    const res = runAnchorsScan(tp.paths, { strict: true });
    expect(res.ok).toBe(true);
    expect(res.exitCode).toBe(0);
  });
});
