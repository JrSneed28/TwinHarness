/**
 * Shared stage predicate (F-1) — the single source of truth for canonicalizing a
 * free-form `current_stage` and answering "is this final-verification?". Both the
 * stop-gate (hook.ts) and `th next` (next.ts) consume these so they never disagree
 * on near-miss spellings (C-1, M-2).
 */

import { describe, it, expect } from "vitest";
import { canonicalizeStage, isFinalVerification, isKnownStage, STAGE_PIPELINE } from "../src/core/stages";

describe("canonicalizeStage", () => {
  it("returns canonical ids unchanged", () => {
    expect(canonicalizeStage("final-verification")).toBe("final-verification");
    expect(canonicalizeStage("requirements")).toBe("requirements");
  });

  it("trims and lowercases", () => {
    expect(canonicalizeStage("  Final-Verification  ")).toBe("final-verification");
    expect(canonicalizeStage("FINAL-VERIFICATION")).toBe("final-verification");
  });

  it("strips a leading NN- prefix only when it yields a known stage", () => {
    expect(canonicalizeStage("10-final-verification")).toBe("final-verification");
    expect(canonicalizeStage("01-requirements")).toBe("requirements");
    // Deprefix that does NOT yield a known stage is left as the trimmed string.
    expect(canonicalizeStage("10-foo")).toBe("10-foo");
  });

  it("passes through unknown/non-pipeline stages unchanged (lowercased)", () => {
    expect(canonicalizeStage("init")).toBe("init");
    expect(canonicalizeStage("stage-05")).toBe("stage-05");
    expect(canonicalizeStage("done")).toBe("done");
    expect(canonicalizeStage("")).toBe("");
    expect(canonicalizeStage("   ")).toBe("");
  });
});

describe("isFinalVerification", () => {
  it.each([
    "final-verification",
    "Final-Verification",
    "FINAL-VERIFICATION",
    " final-verification ",
    "10-final-verification",
  ])("is true for the near-miss %j", (value) => {
    expect(isFinalVerification(value)).toBe(true);
  });

  it.each(["done", "complete", "implementation", "", "verification", "final"])(
    "is false for the non-final stage %j",
    (value) => {
      expect(isFinalVerification(value)).toBe(false);
    },
  );
});

describe("isKnownStage", () => {
  it("is true for every canonical pipeline stage (and its NN- prefixed form)", () => {
    for (const s of STAGE_PIPELINE) {
      expect(isKnownStage(s.stage)).toBe(true);
      expect(isKnownStage(`05-${s.stage}`)).toBe(true);
    }
  });

  it("is false for non-pipeline stages", () => {
    expect(isKnownStage("bogus-stage")).toBe(false);
    expect(isKnownStage("init")).toBe(false);
    expect(isKnownStage("")).toBe(false);
  });
});
