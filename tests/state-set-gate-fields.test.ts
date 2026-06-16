/**
 * `th state set` field-policy enforcement (F-5, H-2 + C-1 write-path).
 *
 * - current_stage is enum-normalized: near-miss spellings canonicalize and persist;
 *   non-pipeline values are refused (closes the C-1 gate-bypass at the source).
 * - the drift/debate counters stay refused (regression guard #2).
 * - gate-owned fields (implementation_allowed/tier/write_gate) remain settable on
 *   the CLI (the documented unlock path) but are validated; the MCP refusal lives
 *   in F-7 (mcp-schema-enforcement.test.ts).
 */

import { describe, it, expect, afterEach } from "vitest";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { runStateSet } from "../src/commands/state";
import { readState } from "../src/core/state-store";
import { GATE_OWNED } from "../src/core/state-fields";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

describe("F-5/C-1: current_stage is enum-normalized at the write path", () => {
  it("normalizes a casing near-miss and persists the canonical id", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const res = runStateSet(tp.paths, "current_stage", "Final-Verification");
    expect(res.ok).toBe(true);
    expect(readState(tp.paths).state?.current_stage).toBe("final-verification");
  });

  it("strips a leading NN- prefix and persists the canonical id", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    expect(runStateSet(tp.paths, "current_stage", "10-final-verification").ok).toBe(true);
    expect(readState(tp.paths).state?.current_stage).toBe("final-verification");
  });

  it.each(["bogus-stage", "done", "complete"])("refuses non-pipeline stage %j", (bad) => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const res = runStateSet(tp.paths, "current_stage", bad);
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("unknown_stage");
    // State is untouched (still the init default).
    expect(readState(tp.paths).state?.current_stage).toBe("init");
  });
});

describe("F-5/H-2: managed-counter refusal (regression guard #2)", () => {
  it.each(["drift_open_blocking", "debate_open_blocking"])("refuses %j", (field) => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const res = runStateSet(tp.paths, field, "5");
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("managed_field");
  });
});

describe("F-5: gate-owned fields settable on the CLI but validated", () => {
  it("implementation_allowed=true succeeds (documented unlock path)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    expect(runStateSet(tp.paths, "implementation_allowed", "true").ok).toBe(true);
    expect(readState(tp.paths).state?.implementation_allowed).toBe(true);
  });

  it("tier accepts a valid value and rejects an invalid one", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    expect(runStateSet(tp.paths, "tier", "\"T1\"").ok).toBe(true);
    expect(readState(tp.paths).state?.tier).toBe("T1");
    expect(runStateSet(tp.paths, "tier", "\"T9\"").ok).toBe(false);
  });

  it("write_gate accepts a valid enum and rejects an invalid one", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    expect(runStateSet(tp.paths, "write_gate", "deny").ok).toBe(true);
    expect(runStateSet(tp.paths, "write_gate", "bogus").ok).toBe(false);
  });
});

describe("F-5: GATE_OWNED registry surface (consumed by the MCP refusal in F-7)", () => {
  it("contains exactly the four gate-security fields", () => {
    expect([...GATE_OWNED].sort()).toEqual(
      ["current_stage", "implementation_allowed", "tier", "write_gate"].sort(),
    );
  });
});
