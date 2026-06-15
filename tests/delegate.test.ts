/**
 * `th delegate` — Context Preservation / Delegation Layer.
 *
 * Covers the pure policy (computeDelegation / validateCapsule / capsuleTemplate),
 * the four command handlers (plan / pack / capsule / check), and the new CLI flags.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { runSlicesSync } from "../src/commands/slices";
import {
  runDelegatePlan,
  runDelegatePack,
  runDelegateCapsule,
  runDelegateCheck,
} from "../src/commands/delegate";
import {
  computeDelegation,
  validateCapsule,
  capsuleTemplate,
  CAPSULE_SECTIONS,
  FILE_THRESHOLD,
} from "../src/core/delegation";
import { parseArgs } from "../src/cli";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

function writeFile(t: TempProject, rel: string, content: string): void {
  const abs = path.join(t.root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

describe("REQ-DELEGATE-POLICY-001: computeDelegation keeps small read-scoped tasks in main", () => {
  it("keep-main for a tiny read (intent read, 1 file)", () => {
    const rec = computeDelegation({ intent: "read", files: 1 });
    expect(rec.recommendation).toBe("keep-main");
    expect(rec.capsuleRequired).toBe(false);
    expect(rec.packRecommended).toBe(false);
    expect(rec.suggestedAgent).toBeNull();
  });

  it("keep-main with no signals at all", () => {
    expect(computeDelegation({}).recommendation).toBe("keep-main");
  });

  it(`file count at the threshold (${FILE_THRESHOLD}) stays in main; one over delegates`, () => {
    expect(computeDelegation({ files: FILE_THRESHOLD }).recommendation).toBe("keep-main");
    expect(computeDelegation({ files: FILE_THRESHOLD + 1 }).recommendation).toBe("delegate");
  });
});

describe("REQ-DELEGATE-POLICY-002: computeDelegation delegates high-context work", () => {
  it("delegates when expected file reads exceed the threshold", () => {
    const rec = computeDelegation({ intent: "read", files: 5 });
    expect(rec.recommendation).toBe("delegate");
    expect(rec.packRecommended).toBe(true);
    expect(rec.capsuleRequired).toBe(true);
    expect(rec.reasons.join(" ")).toContain("threshold");
  });

  it("delegates for writes and noisy signals", () => {
    expect(computeDelegation({ writes: true }).recommendation).toBe("delegate");
    expect(computeDelegation({ noisy: true }).recommendation).toBe("delegate");
  });

  it.each([
    ["write", "builder"],
    ["debug", "debugger"],
    ["review", "critic"],
    ["artifact", "spec"],
    ["repo-analysis", "codebase-inspector"],
  ] as const)("intent %s → delegate, suggested agent %s", (intent, agent) => {
    const rec = computeDelegation({ intent });
    expect(rec.recommendation).toBe("delegate");
    expect(rec.suggestedAgent).toBe(agent);
  });
});

describe("REQ-DELEGATE-PLAN-001: th delegate plan renders the recommendation", () => {
  it("keep-main task: no handoff, capsule not required, task echoed", () => {
    const res = runDelegatePlan({ intent: "read", files: 2, task: "peek at config" });
    expect(res.ok).toBe(true);
    expect(res.data?.recommendation).toBe("keep-main");
    expect(res.data?.suggestedHandoff).toEqual([]);
    expect(res.human).toContain("recommendation: keep-main");
    expect(res.human).toContain("task: peek at config");
    expect(res.human).toContain("capsule required: no");
  });

  it("delegate task: handoff references only real commands + capsule required", () => {
    const res = runDelegatePlan({ intent: "repo-analysis", slice: "SLICE-3" });
    expect(res.ok).toBe(true);
    expect(res.data?.recommendation).toBe("delegate");
    expect(res.data?.suggestedAgent).toBe("codebase-inspector");
    const handoff = res.data?.suggestedHandoff as string[];
    expect(handoff.some((h) => h.includes("th context pack --slice SLICE-3"))).toBe(true);
    expect(handoff.some((h) => h.startsWith("th delegate pack"))).toBe(true);
    // Does NOT reference the not-yet-built `th repo` commands.
    expect(handoff.join(" ")).not.toContain("th repo");
  });

  it("unknown intent → failure", () => {
    const res = runDelegatePlan({ intent: "frobnicate" });
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("unknown_intent");
  });
});

describe("REQ-DELEGATE-PACK-001: th delegate pack assembles a bounded handoff", () => {
  it("includes the envelope sections and the full capsule skeleton", () => {
    tp = makeTempProject();
    const res = runDelegatePack(tp.paths, { agent: "debugger", task: "trace the failing suite", intent: "debug" });
    expect(res.ok).toBe(true);
    expect(res.human).toContain("DELEGATED AGENT HANDOFF");
    expect(res.human).toContain("Agent: debugger");
    expect(res.human).toContain("Required Delegation Capsule format:");
    expect(res.data?.hasContextPack).toBe(false);
    for (const s of CAPSULE_SECTIONS) expect(res.human).toContain(`${s}:`);
  });

  it("--slice reuses context pack (slice framing + component overlap)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeFile(
      tp,
      "docs/09-implementation-plan.md",
      ["# Plan", "", "### SLICE-1", "Components touched: api, db", "", "### SLICE-2", "Components touched: db"].join("\n"),
    );
    runSlicesSync(tp.paths, { planFile: "docs/09-implementation-plan.md" });
    const res = runDelegatePack(tp.paths, { agent: "builder", slice: "SLICE-1" });
    expect(res.ok).toBe(true);
    expect(res.data?.hasContextPack).toBe(true);
    expect(res.human).toContain("SLICE-1");
    // SLICE-2 shares the db component — the reused context pack surfaces it.
    expect(res.human).toContain("SLICE-2");
  });

  it("--slice with an unknown slice propagates context pack's failure", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const res = runDelegatePack(tp.paths, { agent: "builder", slice: "SLICE-99" });
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("unknown_slice");
  });

  it("unknown intent → failure", () => {
    tp = makeTempProject();
    const res = runDelegatePack(tp.paths, { intent: "frobnicate" });
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("unknown_intent");
  });
});

describe("REQ-DELEGATE-CAPSULE-001: th delegate capsule emits the strict template", () => {
  it("prints the title and all 14 section labels", () => {
    const res = runDelegateCapsule();
    expect(res.ok).toBe(true);
    expect(res.human).toContain("DELEGATION CAPSULE");
    expect((res.data?.sections as string[]).length).toBe(14);
    for (const s of CAPSULE_SECTIONS) expect(res.human).toContain(`${s}:`);
  });

  it("the emitted template validates clean (round-trip)", () => {
    const v = validateCapsule(capsuleTemplate());
    expect(v.ok).toBe(true);
    expect(v.missing).toEqual([]);
    expect(v.present.length).toBe(14);
  });
});

describe("REQ-DELEGATE-CHECK-001: th delegate check validates required sections", () => {
  it("passes a complete capsule file", () => {
    tp = makeTempProject();
    writeFile(tp, "cap.txt", capsuleTemplate());
    const res = runDelegateCheck(tp.paths, { file: "cap.txt" });
    expect(res.ok).toBe(true);
    expect(res.data?.missing).toEqual([]);
  });

  it("fails a capsule missing headings and lists them", () => {
    tp = makeTempProject();
    writeFile(tp, "partial.txt", "DELEGATION CAPSULE\nAgent: x\nTask: y\nResult: done\n");
    const res = runDelegateCheck(tp.paths, { file: "partial.txt" });
    expect(res.ok).toBe(false);
    const missing = res.data?.missing as string[];
    expect(missing).toContain("Risks");
    expect(missing).toContain("Findings");
    expect(missing).not.toContain("Agent");
    expect(missing).not.toContain("Result");
  });

  it("validates inline text (the MCP path) without a file", () => {
    tp = makeTempProject();
    const res = runDelegateCheck(tp.paths, { text: capsuleTemplate() });
    expect(res.ok).toBe(true);
  });

  it("rejects a missing file, a path outside root, and no capsule at all", () => {
    tp = makeTempProject();
    expect(runDelegateCheck(tp.paths, { file: "nope.txt" }).data?.error).toBe("capsule_not_found");
    expect(runDelegateCheck(tp.paths, { file: "../escape.txt" }).data?.error).toBe("path_outside_root");
    expect(runDelegateCheck(tp.paths, {}).data?.error).toBe("no_capsule");
  });
});

describe("REQ-DELEGATE-VALIDATE-001: validateCapsule presence semantics", () => {
  it("accepts markdown headings and bullets for the labels", () => {
    const ok = [
      "## Agent",
      "- Task: t",
      "Intent",
      "Inputs used:",
      "Files read:",
      "Files changed:",
      "Commands run:",
      "Findings:",
      "Risks:",
      "Tests/checks:",
      "Result:",
      "Open questions:",
      "Recommended next action:",
      "Artifacts produced:",
    ].join("\n");
    expect(validateCapsule(ok).ok).toBe(true);
  });

  it("a partial label (Taskmaster) does not satisfy Task", () => {
    const v = validateCapsule("Taskmaster: nope");
    expect(v.missing).toContain("Task");
  });
});

describe("REQ-DELEGATE-CLI-001: the new delegate flags are recognized by the parser", () => {
  it("parses --intent/--files/--writes/--noisy/--task/--capsule without errors", () => {
    const p = parseArgs([
      "delegate",
      "plan",
      "--intent",
      "debug",
      "--files",
      "5",
      "--writes",
      "--noisy",
      "--task",
      "x",
      "--capsule",
      "c.txt",
    ]);
    expect(p.unknownFlags).toEqual([]);
    expect(p.errors).toEqual([]);
    expect(p.flags.intent).toBe("debug");
    expect(p.flags.files).toBe(5);
    expect(p.flags.writes).toBe(true);
    expect(p.flags.noisy).toBe(true);
    expect(p.flags.task).toBe("x");
    expect(p.flags.capsule).toBe("c.txt");
    expect(p.positionals).toEqual(["delegate", "plan"]);
  });

  it("--files requires a numeric value", () => {
    const p = parseArgs(["delegate", "plan", "--files", "notanumber"]);
    expect(p.errors.some((e) => e.includes("--files"))).toBe(true);
  });
});
