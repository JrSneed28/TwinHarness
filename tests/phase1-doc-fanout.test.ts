import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * REQ-PCO-010 — Concurrent documentation fan-out (Stage 10.5).
 *
 * The Doc-Writer is one agent parameterized by MODE. After `readme` runs first
 * and alone, the remaining T2/T3 modes (`user-guide`, `api-reference`,
 * `developer-guide`, `changelog`) write DISJOINT output files, so they are a
 * zero-conflict fan-out and MUST be dispatched concurrently (one message),
 * each gated independently by its own Critic in `documentation` mode.
 *
 * These are prose-level coordination truths, so they are asserted by code:
 * the agent prompt and the Stage 10.5 playbook must actually say "concurrent"
 * (not serial) and must name the four fanned-out modes.
 */

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

const DOC_WRITER = "agents/doc-writer.md";
const BUILD_VERIFY = "skills/twinharness/reference/build-and-verify.md";

const CONCURRENT = /concurrent|parallel|disjoint/i;
const FANOUT_MODES = ["user-guide", "api-reference", "developer-guide", "changelog"];

describe("REQ-PCO-010: doc-writer advertises the concurrent T2/T3 fan-out", () => {
  it("REQ-PCO-010: doc-writer.md names all four T2/T3 fan-out modes", () => {
    const content = read(DOC_WRITER);
    for (const mode of FANOUT_MODES) {
      expect(content, `doc-writer.md should mention the ${mode} mode`).toContain(mode);
    }
  });

  it("REQ-PCO-010: doc-writer.md indicates the modes run concurrently / write disjoint files", () => {
    const content = read(DOC_WRITER);
    expect(content).toMatch(CONCURRENT);
  });

  it("REQ-PCO-010: doc-writer.md ties the concurrency language to the fan-out modes", () => {
    const content = read(DOC_WRITER);
    // The concurrency assertion is meaningful only if it co-occurs with the
    // fan-out modes: find a window that contains both a fan-out mode reference
    // and the concurrent/parallel/disjoint language.
    const lines = content.split(/\r?\n/);
    const hasJointWindow = lines.some((line, i) => {
      const window = lines.slice(Math.max(0, i - 6), i + 7).join("\n");
      return CONCURRENT.test(window) && FANOUT_MODES.some((m) => window.includes(m));
    });
    expect(
      hasJointWindow,
      "doc-writer.md should describe the user-guide/api-reference/developer-guide/changelog modes as concurrent/disjoint",
    ).toBe(true);
  });
});

describe("REQ-PCO-010: Stage 10.5 playbook dispatches doc modes concurrently", () => {
  it("REQ-PCO-010: build-and-verify.md has a Stage 10.5 documentation section", () => {
    const content = read(BUILD_VERIFY);
    expect(content).toMatch(/Stage 10\.5/);
  });

  it("REQ-PCO-010: Stage 10.5 instructs concurrent dispatch in one message", () => {
    const content = read(BUILD_VERIFY);
    expect(content).toMatch(CONCURRENT);
    // "one message" / "single turn" — the dispatch must not be serialized.
    expect(content).toMatch(/one message|single turn/i);
  });

  it("REQ-PCO-010: Stage 10.5 gates each mode with a per-mode Critic in documentation mode", () => {
    const content = read(BUILD_VERIFY);
    expect(content).toMatch(/documentation/);
    expect(content).toMatch(/Critic/);
  });
});
