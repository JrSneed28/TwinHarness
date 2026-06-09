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
    expect(Object.keys(JSON.parse(out))).toEqual(STATE_FIELD_ORDER);
  });

  it("is stable across calls (clock-free)", () => {
    expect(serializeState(initialState())).toBe(serializeState(initialState()));
  });
});
