/**
 * Component 6 (Failure-injection / negative proof) — plan §11; AC #11. Every
 * enumerated fault is injected into a real isolated temp project and must fail
 * SAFELY: a structured rejection (never an uncaught crash) plus the correct
 * gate-block. Each injector cleans up its own sandbox.
 */

import { describe, it, expect } from "vitest";
import { ALL_FAULTS, injectAndAssert, runAllFaults } from "../src/core/proof/faults";

describe("proof/faults — negative proof (AC #11)", () => {
  it("runAllFaults exercises every enumerated fault and all fail safely", () => {
    const results = runAllFaults();
    expect(results.length).toBe(ALL_FAULTS.length);
    for (const r of results) {
      expect(r.pass, `${r.fault}: expected=${r.expected} observed=${r.observed}`).toBe(true);
    }
  });

  it.each([...ALL_FAULTS])("fault '%s' is handled safely (no crash, expectation met)", (fault) => {
    const r = injectAndAssert(fault);
    expect(r.fault).toBe(fault);
    expect(r.observed).not.toMatch(/^threw:/); // never an uncaught crash
    expect(r.pass, `observed=${r.observed}`).toBe(true);
  });

  it("gate-blocking faults report the blocking gate", () => {
    for (const fault of ["corrupt-state", "open-drift-debate", "unapproved-decision"] as const) {
      const r = injectAndAssert(fault);
      expect(r.gateBlocked, `${fault} should record a gate block`).toBe("stop-gate");
    }
  });

  it("dangling/cyclic deps stall the wave rather than spin forever", () => {
    const r = injectAndAssert("dangling-cyclic-deps");
    expect(r.observed).toMatch(/dangling=[1-9]/);
    expect(r.observed).toMatch(/cycles=[1-9]/);
    expect(r.observed).toMatch(/stalled=true/);
  });
});
