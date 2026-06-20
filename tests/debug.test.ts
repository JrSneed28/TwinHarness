/**
 * `th debug` — evidence pack + append-only evidence ledger — REQ-anchored.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { runSlicesSync } from "../src/commands/slices";
import { runVerifyAdd, runVerifyRun, runVerifyApprove } from "../src/commands/verify";
import { runDebugPack, runDebugLogAdd, runDebugLogList } from "../src/commands/debug";
import { formatDebugEntry, parseDebugEntries, nextDebugId } from "../src/core/debug-log";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

function writeFile(t: TempProject, rel: string, content: string): void {
  const abs = path.join(t.root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

describe("REQ-DEBUGLOG-001: format/parse round-trip and id sequencing", () => {
  it("formats a block that parses back to the same fields", () => {
    const block = formatDebugEntry({ id: "DEBUG-001", ref: "REQ-007 / SLICE-2", symptom: "x", evidence: "src/a.ts:1", rootCause: "y", status: "open" });
    const [e] = parseDebugEntries(block);
    expect(e).toMatchObject({ id: "DEBUG-001", ref: "REQ-007 / SLICE-2", symptom: "x", evidence: "src/a.ts:1", rootCause: "y", status: "open" });
  });

  it("nextDebugId increments the max", () => {
    expect(nextDebugId("## DEBUG-001 ...\n## DEBUG-004 ...")).toBe("DEBUG-005");
    expect(nextDebugId("")).toBe("DEBUG-001");
  });
});

describe("REQ-DEBUG-001: debug log add appends and list reports open/total", () => {
  it("add creates DEBUG-001, list shows 1 open", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const res = runDebugLogAdd(tp.paths, { ref: "REQ-007 / SLICE-2", symptom: "CSV export missing newline" });
    expect(res.ok).toBe(true);
    expect(res.data?.id).toBe("DEBUG-001");

    const list = runDebugLogList(tp.paths);
    expect(list.data?.open).toBe(1);
    expect(list.data?.total).toBe(1);
    expect(fs.existsSync(path.join(tp.root, "debug-log.md"))).toBe(true);
  });

  it("add requires --ref and --symptom", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    expect(runDebugLogAdd(tp.paths, { ref: "REQ-1" }).ok).toBe(false);
    expect(runDebugLogAdd(tp.paths, { symptom: "x" }).ok).toBe(false);
  });
});

describe("REQ-DEBUG-002: debug pack assembles failing-suite + slice evidence", () => {
  it("includes the failing command and the target slice's components", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeFile(tp, "docs/09-implementation-plan.md", "### SLICE-1\nComponents touched: export, store\n");
    runSlicesSync(tp.paths, { planFile: "docs/09-implementation-plan.md" });
    runVerifyAdd(tp.paths, "false");
    runVerifyApprove(tp.paths, { as: "test", tty: { isTTY: true, stdinLine: "y" } });
    runVerifyRun(tp.paths);

    const res = runDebugPack(tp.paths, { slice: "SLICE-1" });
    expect(res.ok).toBe(true);
    const failing = res.data?.failing as Array<{ command: string }>;
    expect(failing.length).toBe(1);
    expect(failing[0]?.command).toBe("false");
    const slice = res.data?.slice as { id: string; components: string[] };
    expect(slice.id).toBe("SLICE-1");
    expect(slice.components).toEqual(["export", "store"]);
  });

  it("--req reports the REQ-ID's code/test anchors", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeFile(tp, "src/export.ts", "// REQ-007 implemented\n");
    writeFile(tp, "tests/export.test.ts", "// REQ-007 tested\n");
    const res = runDebugPack(tp.paths, { req: "REQ-007" });
    const req = res.data?.req as { req: string; files: string[] };
    expect(req.req).toBe("REQ-007");
    expect(req.files.some((f) => f.includes("export.ts"))).toBe(true);
  });

  it("unknown slice → failure", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    expect(runDebugPack(tp.paths, { slice: "SLICE-99" }).ok).toBe(false);
  });
});
