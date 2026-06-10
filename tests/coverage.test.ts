import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { runCoverageCheck } from "../src/commands/coverage";
import { extractReqIds } from "../src/core/anchors";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

/** Write a file (relative to the temp project root) and return its root-relative path. */
function writeFile(t: TempProject, rel: string, content: string): string {
  const abs = path.join(t.root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  return rel;
}

describe("REQ-COVERAGE-ANCHOR-001: extractReqIds finds, dedupes, and ignores non-matches", () => {
  it("finds REQ-001/REQ-NFR-002/REQ-HASH-003 and the multi-segment shape", () => {
    const text = "REQ-001 and REQ-NFR-002, plus REQ-HASH-003.";
    expect(extractReqIds(text)).toEqual(["REQ-001", "REQ-NFR-002", "REQ-HASH-003"]);
  });

  it("dedupes (first-seen stable order) and ignores non-REQ tokens", () => {
    const text = "REQ-002 then REQ-001 then REQ-002 again. REQUEST, REQ- alone, prose.";
    expect(extractReqIds(text)).toEqual(["REQ-002", "REQ-001"]);
  });

  it("returns an empty array when there are no anchors", () => {
    expect(extractReqIds("nothing here, lowercase req-001 does not match")).toEqual([]);
  });
});

describe("REQ-COVERAGE-001: full coverage → success, no gaps, exit 0 (§15.8/§15.9)", () => {
  it("every requirement mapped to a slice and a test", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeFile(tp, "docs/01-requirements.md", "REQ-001 the system shall.\nREQ-002 it must too.\n");
    writeFile(tp, "docs/09-implementation-plan.md", "Slice A covers REQ-001 and REQ-002.\n");
    writeFile(tp, "tests/feature.test.ts", "// REQ-001 REQ-002 are exercised here\n");

    const res = runCoverageCheck(tp.paths);
    expect(res.ok).toBe(true);
    expect(res.exitCode).toBe(0);
    expect(res.data?.ok).toBe(true);
    expect(res.data?.total).toBe(2);
    expect(res.data?.covered).toBe(2);
    expect(res.data?.gaps).toEqual([]);
    expect(res.human).toContain("2/2");
  });
});

describe("REQ-COVERAGE-002: an unmapped requirement is reported as a gap, exit 1", () => {
  it("REQ-002 missing from both plan and tests → gap inSlice=false inTest=false", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeFile(tp, "docs/01-requirements.md", "REQ-001 and REQ-002.\n");
    writeFile(tp, "docs/09-implementation-plan.md", "Slice A covers REQ-001 only.\n");
    writeFile(tp, "tests/feature.test.ts", "// REQ-001 tested\n");

    const res = runCoverageCheck(tp.paths);
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(1);
    expect(res.data?.total).toBe(2);
    expect(res.data?.covered).toBe(1);
    expect(res.data?.gaps).toEqual([{ req: "REQ-002", inSlice: false, inTest: false }]);
    expect(res.human).toContain("REQ-002");
  });
});

describe("REQ-COVERAGE-003: partial gap — slice present, test missing", () => {
  it("REQ-002 in plan but not in any test → gap inSlice=true inTest=false", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeFile(tp, "docs/01-requirements.md", "REQ-001 and REQ-002.\n");
    writeFile(tp, "docs/09-implementation-plan.md", "Slice A covers REQ-001 and REQ-002.\n");
    writeFile(tp, "tests/feature.test.ts", "// only REQ-001 is tested\n");

    const res = runCoverageCheck(tp.paths);
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(1);
    expect(res.data?.gaps).toEqual([{ req: "REQ-002", inSlice: true, inTest: false }]);
  });
});

describe("REQ-COVERAGE-004: a missing requirements file fails clearly", () => {
  it("no requirements file → failure with reqs_file_not_found", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const res = runCoverageCheck(tp.paths);
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(1);
    expect(res.data?.error).toBe("reqs_file_not_found");
  });
});

describe("REQ-COVERAGE-005: a missing plan file means every REQ is a gap (no crash)", () => {
  it("plan absent → all requirements reported as inSlice=false", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeFile(tp, "docs/01-requirements.md", "REQ-001 only.\n");
    writeFile(tp, "tests/feature.test.ts", "// REQ-001 tested\n");

    const res = runCoverageCheck(tp.paths);
    expect(res.ok).toBe(false);
    expect(res.data?.gaps).toEqual([{ req: "REQ-001", inSlice: false, inTest: true }]);
  });
});

describe("REQ-COVERAGE-006: custom --reqs/--plan/--tests locations are honored", () => {
  it("resolves overrides against the project root", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeFile(tp, "spec/reqs.md", "REQ-001.\n");
    writeFile(tp, "spec/plan.md", "REQ-001.\n");
    writeFile(tp, "qa/feature.test.ts", "// REQ-001\n");

    const res = runCoverageCheck(tp.paths, {
      reqsFile: "spec/reqs.md",
      planFile: "spec/plan.md",
      testsDir: "qa",
    });
    expect(res.ok).toBe(true);
    expect(res.data?.covered).toBe(1);
  });
});

describe("REQ-COVERAGE-007: MVP scope filtering via docs/02-scope.md", () => {
  it("applies MVP filter when scope file has ## MVP Scope section", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    // Requirements: REQ-001 and REQ-002.
    writeFile(tp, "docs/01-requirements.md", "REQ-001 and REQ-002.\n");
    // Scope file: MVP only includes REQ-001.
    writeFile(
      tp,
      "docs/02-scope.md",
      "# Scope\n\n## MVP Scope\n\nREQ-001 is MVP.\n\n## Out of Scope\n\nREQ-002 is post-MVP.\n",
    );
    writeFile(tp, "docs/09-implementation-plan.md", "Slice covers REQ-001.\n");
    writeFile(tp, "tests/feature.test.ts", "// REQ-001\n");

    const res = runCoverageCheck(tp.paths);
    expect(res.ok).toBe(true);
    // Only REQ-001 is checked (MVP filter applied).
    expect(res.data?.total).toBe(1);
    expect(res.data?.covered).toBe(1);
    expect(res.human).toContain("MVP filter: applied");
  });

  it("falls back to all REQ-IDs when no ## MVP Scope section exists", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeFile(tp, "docs/01-requirements.md", "REQ-001 and REQ-002.\n");
    writeFile(tp, "docs/02-scope.md", "# Scope\n\nNo MVP section here.\n");
    writeFile(tp, "docs/09-implementation-plan.md", "REQ-001 REQ-002.\n");
    writeFile(tp, "tests/feature.test.ts", "// REQ-001 REQ-002\n");

    const res = runCoverageCheck(tp.paths);
    expect(res.ok).toBe(true);
    expect(res.data?.total).toBe(2);
    expect(res.human).toContain("MVP filter: none");
  });

  it("falls back when scope file is absent", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeFile(tp, "docs/01-requirements.md", "REQ-001.\n");
    writeFile(tp, "docs/09-implementation-plan.md", "REQ-001.\n");
    writeFile(tp, "tests/feature.test.ts", "// REQ-001\n");

    const res = runCoverageCheck(tp.paths);
    expect(res.ok).toBe(true);
    expect(res.human).toContain("MVP filter: none");
  });
});

describe("REQ-COVERAGE-008: multi-language test files are scanned (full recursion)", () => {
  it("Python test file (test_*.py) is scanned for REQ-IDs", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeFile(tp, "docs/01-requirements.md", "REQ-001.\n");
    writeFile(tp, "docs/09-implementation-plan.md", "REQ-001.\n");
    // Python test file.
    writeFile(tp, "tests/test_req001_feature.py", "# REQ-001 is tested here\n");

    const res = runCoverageCheck(tp.paths);
    expect(res.ok).toBe(true);
    expect(res.data?.covered).toBe(1);
  });

  it("Go test file (*_test.go) is scanned for REQ-IDs", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeFile(tp, "docs/01-requirements.md", "REQ-001.\n");
    writeFile(tp, "docs/09-implementation-plan.md", "REQ-001.\n");
    // Go test file.
    writeFile(tp, "tests/feature_test.go", "// REQ-001 tested\n");

    const res = runCoverageCheck(tp.paths);
    expect(res.ok).toBe(true);
    expect(res.data?.covered).toBe(1);
  });

  it("deeply nested test file (tests/a/b/c.test.ts) is scanned (full recursion)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeFile(tp, "docs/01-requirements.md", "REQ-001.\n");
    writeFile(tp, "docs/09-implementation-plan.md", "REQ-001.\n");
    // Deeply nested test.
    writeFile(tp, "tests/a/b/c.test.ts", "// REQ-001\n");

    const res = runCoverageCheck(tp.paths);
    expect(res.ok).toBe(true);
    expect(res.data?.covered).toBe(1);
  });
});
