import { describe, it, expect } from "vitest";
import { initialState, validateState, serializeState, STATE_FIELD_ORDER } from "../src/core/state-schema";

describe("REQ-STATE-SCHEMA: state.json validation (§18)", () => {
  it("accepts the initial state", () => {
    expect(validateState(initialState()).ok).toBe(true);
  });

  it("rejects an invalid tier", () => {
    const r = validateState({ ...initialState(), tier: "T9" });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.path === "tier")).toBe(true);
  });

  it("rejects an invalid slice status", () => {
    const r = validateState({ ...initialState(), slices: [{ id: "SLICE-0", status: "wat", components: [] }] });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.path.startsWith("slices[0]"))).toBe(true);
  });

  it("rejects a negative drift_open_blocking", () => {
    expect(validateState({ ...initialState(), drift_open_blocking: -1 }).ok).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(validateState(null).ok).toBe(false);
    expect(validateState(42).ok).toBe(false);
  });

  it("accepts a blast-radius flag from the allowed set", () => {
    expect(validateState({ ...initialState(), tier: "T1", blast_radius_flags: ["authentication"] }).ok).toBe(true);
  });

  it("rejects an unknown blast-radius flag", () => {
    expect(validateState({ ...initialState(), blast_radius_flags: ["bogus"] }).ok).toBe(false);
  });

  it("REQ-VETO-FLOOR: rejects tier T0 when a blast-radius flag is present (§5)", () => {
    const r = validateState({ ...initialState(), tier: "T0", blast_radius_flags: ["money"] });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.path === "tier")).toBe(true);
  });

  it("REQ-VETO-FLOOR: accepts tier T1 with the same blast-radius flag", () => {
    expect(validateState({ ...initialState(), tier: "T1", blast_radius_flags: ["money"] }).ok).toBe(true);
  });
});

describe("REQ-STATE-SERIALIZE: deterministic serialization", () => {
  it("serializes in canonical field order with a trailing newline", () => {
    const out = serializeState(initialState());
    expect(out.endsWith("\n")).toBe(true);
    // Only required fields appear (optional write_gate is absent from initialState()).
    const requiredOrder = STATE_FIELD_ORDER.filter((k) => k !== "write_gate");
    expect(Object.keys(JSON.parse(out))).toEqual(requiredOrder);
  });

  it("is stable across calls (clock-free)", () => {
    expect(serializeState(initialState())).toBe(serializeState(initialState()));
  });

  it("REQ-WRITE-GATE-SCHEMA: omits write_gate from serialization when absent (hash-stability)", () => {
    const out = serializeState(initialState());
    expect(Object.keys(JSON.parse(out))).not.toContain("write_gate");
  });

  it("REQ-WRITE-GATE-SCHEMA: includes write_gate in serialization when present", () => {
    const state = { ...initialState(), write_gate: "deny" as const };
    const out = serializeState(state);
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed["write_gate"]).toBe("deny");
    // write_gate should be the last key (end of STATE_FIELD_ORDER).
    const keys = Object.keys(parsed);
    expect(keys[keys.length - 1]).toBe("write_gate");
  });

  it("REQ-WRITE-GATE-SCHEMA: validates accepted write_gate values", () => {
    for (const v of ["ask", "deny", "off"] as const) {
      expect(validateState({ ...initialState(), write_gate: v }).ok).toBe(true);
    }
  });

  it("REQ-WRITE-GATE-SCHEMA: validates absence of write_gate", () => {
    expect(validateState(initialState()).ok).toBe(true);
  });

  it("REQ-WRITE-GATE-SCHEMA: rejects bogus write_gate values", () => {
    const r = validateState({ ...initialState(), write_gate: "never" });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.path === "write_gate")).toBe(true);
  });
});
