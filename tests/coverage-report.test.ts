/**
 * `th coverage report` — planned/implemented/tested/passing breakdown — REQ-anchored.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { runCoverageReport } from "../src/commands/coverage";
import { runVerifyAdd, runVerifyRun, runVerifyApprove } from "../src/commands/verify";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

// Portable, cross-platform stand-ins for POSIX `true`/`false` so these tests
// pass on a bare-Windows runner with no Git Bash on PATH (runCommands uses
// spawnSync(shell: true) → cmd.exe, which cannot resolve `true`/`false`).
// (P1-3 / DOC-003≡TEST-002)
const PASS_CMD = `node -e "process.exit(0)"`;
const FAIL_CMD = `node -e "process.exit(1)"`;

function writeFile(t: TempProject, rel: string, content: string): void {
  const abs = path.join(t.root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

describe("REQ-COVERAGE-REPORT-001: planned vs implemented vs tested are separate dimensions", () => {
  it("a REQ planned + tested but not in code is implemented=false", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeFile(tp, "docs/01-requirements.md", "REQ-001 and REQ-002.\n");
    writeFile(tp, "docs/09-implementation-plan.md", "Slice covers REQ-001 and REQ-002.\n");
    writeFile(tp, "tests/feature.test.ts", "// REQ-001 tested\n");
    // Only REQ-001 is anchored in code.
    writeFile(tp, "src/feature.ts", "// REQ-001 implemented here\n");

    const res = runCoverageReport(tp.paths);
    expect(res.ok).toBe(true);
    expect(res.data?.total).toBe(2);
    expect(res.data?.planned).toBe(2);
    expect(res.data?.implemented).toBe(1);
    expect(res.data?.tested).toBe(1);

    const rows = res.data?.rows as Array<{ req: string; planned: boolean; implemented: boolean; tested: boolean }>;
    const r1 = rows.find((r) => r.req === "REQ-001")!;
    expect(r1).toEqual({ req: "REQ-001", planned: true, implemented: true, tested: true });
    const r2 = rows.find((r) => r.req === "REQ-002")!;
    expect(r2).toEqual({ req: "REQ-002", planned: true, implemented: false, tested: false });
  });

  it("a custom --code directory is honored", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeFile(tp, "docs/01-requirements.md", "REQ-001.\n");
    writeFile(tp, "lib/impl.ts", "// REQ-001\n");
    const res = runCoverageReport(tp.paths, { codeDir: "lib" });
    expect(res.data?.implemented).toBe(1);
  });
});

describe("REQ-COVERAGE-REPORT-002: passing is whole-suite, sourced from the verify report", () => {
  it("no verify report → passing is null (unknown)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeFile(tp, "docs/01-requirements.md", "REQ-001.\n");
    writeFile(tp, "tests/a.test.ts", "// REQ-001\n");
    const res = runCoverageReport(tp.paths);
    expect(res.data?.passing).toBeNull();
    expect(res.human).toContain("no verify report");
  });

  it("green verify report → tested REQs count as passing", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeFile(tp, "docs/01-requirements.md", "REQ-001 and REQ-002.\n");
    writeFile(tp, "tests/a.test.ts", "// REQ-001 tested\n");
    runVerifyAdd(tp.paths, PASS_CMD);
    runVerifyApprove(tp.paths, { as: "test", tty: { isTTY: true, stdinLine: "y" } });
    runVerifyRun(tp.paths);

    const res = runCoverageReport(tp.paths);
    // Only REQ-001 is tested; suite is green → 1 passing.
    expect(res.data?.suitePassing).toBe(true);
    expect(res.data?.passing).toBe(1);
  });

  it("failing verify report → passing is 0 even for tested REQs", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeFile(tp, "docs/01-requirements.md", "REQ-001.\n");
    writeFile(tp, "tests/a.test.ts", "// REQ-001\n");
    runVerifyAdd(tp.paths, FAIL_CMD);
    runVerifyApprove(tp.paths, { as: "test", tty: { isTTY: true, stdinLine: "y" } });
    runVerifyRun(tp.paths);

    const res = runCoverageReport(tp.paths);
    expect(res.data?.suitePassing).toBe(false);
    expect(res.data?.passing).toBe(0);
  });
});

describe("REQ-COVERAGE-REPORT-003: a missing requirements file fails clearly", () => {
  it("no requirements file → failure reqs_file_not_found", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const res = runCoverageReport(tp.paths);
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("reqs_file_not_found");
  });
});

describe("REQ-COVERAGE-REPORT-SEC-001: path traversal is rejected", () => {
  it("codeDir escaping root → path_outside_root", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeFile(tp, "docs/01-requirements.md", "REQ-001.\n");
    const res = runCoverageReport(tp.paths, { codeDir: "../../etc" });
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("path_outside_root");
  });
});
