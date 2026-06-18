/**
 * `th state set` field-policy enforcement (F-5, H-2 + C-1 write-path) AFTER the
 * #11 gate-owned demotion.
 *
 * - gate-owned fields (tier / current_stage / implementation_allowed / write_gate /
 *   blast_radius_flags) are now REFUSED by a raw `state set` (error
 *   `gate_owned_requires_emergency`) — the typed gate commands (`th tier record`,
 *   `th stage advance`, `th implementation unlock`) are the gate-checked path.
 *   Passing `{ emergency: true }` forces the raw write (still validated + ledgered).
 * - under `{ emergency: true }` the write still validates: tier "T9" is rejected,
 *   write_gate "bogus" is rejected, and current_stage is enum-normalized (near-miss
 *   spellings canonicalize and persist; non-pipeline values are refused as
 *   `unknown_stage`, closing the C-1 gate-bypass at the source).
 * - the drift/debate counters stay refused (regression guard #2).
 * - the MCP refusal for gate-owned fields lives in F-7 (mcp-schema-enforcement.test.ts).
 */

import { describe, it, expect, afterEach } from "vitest";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { runStateSet } from "../src/commands/state";
import { readState } from "../src/core/state-store";
import { GATE_OWNED } from "../src/core/state-fields";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

describe("#11: a raw `state set` of a gate-owned field is refused without --emergency", () => {
  it.each([
    ["tier", "\"T1\""],
    ["current_stage", "\"requirements\""],
    ["implementation_allowed", "true"],
    ["write_gate", "\"deny\""],
    ["blast_radius_flags", "[\"money\"]"],
  ])("refuses raw set of gate-owned field %j", (field, raw) => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const res = runStateSet(tp.paths, field, raw);
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("gate_owned_requires_emergency");
    expect(res.data?.field).toBe(field);
  });
});

describe("#11: with { emergency: true } the raw write proceeds but still validates", () => {
  it("implementation_allowed=true succeeds under emergency", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    expect(runStateSet(tp.paths, "implementation_allowed", "true", { emergency: true }).ok).toBe(true);
    expect(readState(tp.paths).state?.implementation_allowed).toBe(true);
  });

  it("tier accepts a valid value and rejects an invalid one under emergency", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    expect(runStateSet(tp.paths, "tier", "\"T1\"", { emergency: true }).ok).toBe(true);
    expect(readState(tp.paths).state?.tier).toBe("T1");
    const bad = runStateSet(tp.paths, "tier", "\"T9\"", { emergency: true });
    expect(bad.ok).toBe(false);
    expect(bad.data?.error).toBe("would_be_invalid");
  });

  it("write_gate accepts a valid enum and rejects an invalid one under emergency", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    expect(runStateSet(tp.paths, "write_gate", "deny", { emergency: true }).ok).toBe(true);
    expect(runStateSet(tp.paths, "write_gate", "bogus", { emergency: true }).ok).toBe(false);
  });
});

describe("F-5/C-1: current_stage is enum-normalized at the (emergency) write path", () => {
  it("normalizes a casing near-miss and persists the canonical id", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const res = runStateSet(tp.paths, "current_stage", "Final-Verification", { emergency: true });
    expect(res.ok).toBe(true);
    expect(readState(tp.paths).state?.current_stage).toBe("final-verification");
  });

  it("strips a leading NN- prefix and persists the canonical id", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    expect(runStateSet(tp.paths, "current_stage", "10-final-verification", { emergency: true }).ok).toBe(true);
    expect(readState(tp.paths).state?.current_stage).toBe("final-verification");
  });

  it.each(["bogus-stage", "done", "complete"])("refuses non-pipeline stage %j as unknown_stage", (bad) => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const res = runStateSet(tp.paths, "current_stage", bad, { emergency: true });
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

describe("F-5: GATE_OWNED registry surface (consumed by the MCP refusal in F-7)", () => {
  it("contains exactly the five gate-security fields", () => {
    expect([...GATE_OWNED].sort()).toEqual(
      ["blast_radius_flags", "current_stage", "implementation_allowed", "tier", "write_gate"].sort(),
    );
  });
});
