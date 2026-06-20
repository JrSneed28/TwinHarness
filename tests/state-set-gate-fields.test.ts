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
import { readLedger } from "../src/core/ledger";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

describe("#11: a raw `state set` of a gate-owned field is refused without --emergency", () => {
  it.each([
    ["tier", "\"T1\""],
    ["current_stage", "\"requirements\""],
    ["implementation_allowed", "true"],
    ["write_gate", "\"deny\""],
    ["blast_radius_flags", "[\"money\"]"],
    // R-04 / DR-02 — the four gate-DEFINING config fields are now gate-owned too.
    ["delivery_mode", "\"no-code\""],
    ["has_ui", "false"],
    ["interview_required", "false"],
    ["interview_cutoff", "0.1"],
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
  it("contains exactly the nine gate-security fields (5 original + the 4 gate-defining config fields, R-04)", () => {
    expect([...GATE_OWNED].sort()).toEqual(
      [
        "blast_radius_flags",
        "current_stage",
        "implementation_allowed",
        "tier",
        "write_gate",
        // R-04 / DR-02 additions:
        "delivery_mode",
        "has_ui",
        "interview_required",
        "interview_cutoff",
      ].sort(),
    );
  });
});

describe("R-04: --emergency raw write of a gate-defining field succeeds AND seals a gate-ledger entry", () => {
  it.each([
    ["delivery_mode", "\"no-code\"", "no-code"],
    ["has_ui", "false", false],
    ["interview_required", "false", false],
    ["interview_cutoff", "0.25", 0.25],
  ])("emergency-writes %j and ledgers it", (field, raw, expected) => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const res = runStateSet(tp.paths, field, raw, { emergency: true });
    expect(res.ok).toBe(true);
    // The value persisted.
    const s = readState(tp.paths).state as unknown as Record<string, unknown>;
    expect(s[field]).toEqual(expected);
    // A gate-state-change entry for this field is sealed in the gate ledger
    // (GATE_LEDGER_KEYS now covers the four gate-defining fields).
    const ledger = readLedger(tp.paths);
    const entry = ledger.find((e) => e.event === "gate-state-change" && e.key === field);
    expect(entry, `expected a gate-ledger entry for ${field}`).toBeTruthy();
    expect(typeof entry!.recordHash).toBe("string"); // sealed into the chain
  });

  it("a raw write of a gate-defining field WITHOUT --emergency seals nothing", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    expect(runStateSet(tp.paths, "delivery_mode", "\"no-code\"").ok).toBe(false);
    const entry = readLedger(tp.paths).find((e) => e.key === "delivery_mode");
    expect(entry).toBeUndefined();
  });
});

describe("R-04: the typed capture path (`th init` flags) sets the fields without --emergency", () => {
  it("init --delivery-mode / --no-ui / --no-interview-required / --interview-cutoff stamps each field", () => {
    tp = makeTempProject();
    const res = runInit(tp.paths, {
      deliveryMode: "no-code",
      hasUi: false,
      interviewRequired: false,
      interviewCutoff: 0.6,
    });
    expect(res.ok).toBe(true);
    const s = readState(tp.paths).state!;
    expect(s.delivery_mode).toBe("no-code");
    expect(s.has_ui).toBe(false);
    expect(s.interview_required).toBe(false);
    expect(s.interview_cutoff).toBe(0.6);
  });

  it("an unset gate-defining flag leaves the field absent (safe default), preserving byte-identical serialization", () => {
    tp = makeTempProject();
    expect(runInit(tp.paths, {}).ok).toBe(true);
    const s = readState(tp.paths).state as unknown as Record<string, unknown>;
    expect("delivery_mode" in s).toBe(false);
    expect("has_ui" in s).toBe(false);
    expect("interview_required" in s).toBe(false);
    expect("interview_cutoff" in s).toBe(false);
  });

  it("init refuses an invalid --delivery-mode (clean failure, no state.json clobber concerns)", () => {
    tp = makeTempProject();
    const res = runInit(tp.paths, { deliveryMode: "bogus" });
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("invalid_delivery_mode");
  });

  it("init refuses an out-of-range --interview-cutoff via validateState", () => {
    tp = makeTempProject();
    const res = runInit(tp.paths, { interviewCutoff: 1.5 });
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("would_be_invalid");
  });
});
