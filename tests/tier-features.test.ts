/**
 * Phase 5 / P5-1 — feature-activation layer (REQ-PCO-060).
 *
 * Advanced coordination (collab, debate, section-lease, sub-lease) is OFF by
 * default and activates at tier ≥T2 OR when the run is already doing parallel
 * authorship (>1 slice in flight). These tests pin the activation predicate and
 * the `th tier features` surface, with an emphasis on the CONSERVATIVE default:
 * a T0/T1 single-writer run never loads the coordination plane, and an existing
 * T2/T3 run keeps every capability (no silent capability loss).
 */

import { describe, it, expect, afterEach } from "vitest";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { runStateSet } from "../src/commands/state";
import {
  ADVANCED_FEATURES,
  FEATURE_CATALOG,
  featureActive,
  featureActiveForState,
  featureSpec,
  parallelAuthorshipDetected,
  runTierFeatures,
  type AdvancedFeature,
} from "../src/commands/tier";
import { readState } from "../src/core/state-store";
import type { TwinHarnessState } from "../src/core/state-schema";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

const NO_SLICES = { slices: [] } as Pick<TwinHarnessState, "slices">;
function slicesInProgress(n: number): Pick<TwinHarnessState, "slices"> {
  return {
    slices: Array.from({ length: n }, (_, i) => ({
      id: `SLICE-${i + 1}`,
      status: "in-progress" as const,
      components: [`c${i}`],
    })),
  } as unknown as Pick<TwinHarnessState, "slices">;
}

describe("REQ-PCO-060: feature-activation catalog", () => {
  it("REQ-PCO-060: every advanced feature has a catalog entry with a 'use when'", () => {
    expect(ADVANCED_FEATURES.length).toBe(FEATURE_CATALOG.length);
    for (const feature of ADVANCED_FEATURES) {
      const spec = featureSpec(feature);
      expect(spec, `catalog missing ${feature}`).toBeDefined();
      expect(spec!.title.length).toBeGreaterThan(0);
      expect(spec!.useWhen.toLowerCase()).toContain("use when");
    }
  });

  it("REQ-PCO-060: catalog covers exactly the four gated features in stable order", () => {
    expect(FEATURE_CATALOG.map((f) => f.feature)).toEqual([
      "collab",
      "debate",
      "section-lease",
      "sub-lease",
    ]);
  });
});

describe("REQ-PCO-060: activation predicate — conservative default", () => {
  for (const feature of ADVANCED_FEATURES) {
    it(`REQ-PCO-060: ${feature} is OFF at T0/T1/unclassified with no parallel authorship`, () => {
      expect(featureActive(feature, null, NO_SLICES)).toBe(false);
      expect(featureActive(feature, "T0", NO_SLICES)).toBe(false);
      expect(featureActive(feature, "T1", NO_SLICES)).toBe(false);
    });

    it(`REQ-PCO-060: ${feature} is ON at T2 and T3 (no capability loss for existing flows)`, () => {
      expect(featureActive(feature, "T2", NO_SLICES)).toBe(true);
      expect(featureActive(feature, "T3", NO_SLICES)).toBe(true);
    });
  }
});

describe("REQ-PCO-060: parallel-authorship escape hatch", () => {
  it("REQ-PCO-060: a single in-flight slice is NOT parallel authorship", () => {
    expect(parallelAuthorshipDetected(slicesInProgress(1))).toBe(false);
    expect(parallelAuthorshipDetected(NO_SLICES)).toBe(false);
  });

  it("REQ-PCO-060: >1 in-flight slice trips parallel-authorship detection", () => {
    expect(parallelAuthorshipDetected(slicesInProgress(2))).toBe(true);
    expect(parallelAuthorshipDetected(slicesInProgress(5))).toBe(true);
  });

  it("REQ-PCO-060: parallel authorship activates features even below T2 (never turns them off)", () => {
    for (const feature of ADVANCED_FEATURES) {
      // Below T2 but parallel → ON.
      expect(featureActive(feature, "T1", slicesInProgress(2))).toBe(true);
      // High tier without parallel still ON (escape hatch never demotes).
      expect(featureActive(feature, "T3", slicesInProgress(1))).toBe(true);
    }
  });
});

describe("REQ-PCO-060: th tier features command surface", () => {
  it("REQ-PCO-060: reports every feature OFF on a fresh (unclassified) project", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const res = runTierFeatures(tp.paths);
    expect(res.ok).toBe(true);
    expect(res.data?.tier).toBe("unclassified");
    expect(res.data?.parallel_authorship).toBe(false);
    const features = res.data?.features as Array<{ feature: AdvancedFeature; active: boolean; useWhen: string }>;
    expect(features.length).toBe(FEATURE_CATALOG.length);
    expect(features.every((f) => f.active === false)).toBe(true);
    // The human surface documents the activation rule + per-feature "use when".
    expect(res.human).toContain("OFF by default");
    for (const f of features) expect(f.useWhen.length).toBeGreaterThan(0);
  });

  it("REQ-PCO-060: reports every feature ON at tier T2", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runStateSet(tp.paths, "tier", "T2", { emergency: true });
    const res = runTierFeatures(tp.paths);
    expect(res.ok).toBe(true);
    expect(res.data?.tier).toBe("T2");
    const features = res.data?.features as Array<{ active: boolean }>;
    expect(features.every((f) => f.active === true)).toBe(true);
  });

  it("REQ-PCO-060: tolerates an absent state.json (conservative OFF, never throws)", () => {
    tp = makeTempProject();
    // No runInit — state.json absent.
    const res = runTierFeatures(tp.paths);
    expect(res.ok).toBe(true);
    expect(res.data?.tier).toBe("unclassified");
    const features = res.data?.features as Array<{ active: boolean }>;
    expect(features.every((f) => f.active === false)).toBe(true);
  });

  it("REQ-PCO-060: featureActiveForState reads tier+slices straight off whole state", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runStateSet(tp.paths, "tier", "T3", { emergency: true });
    const r = readState(tp.paths);
    expect(r.state).toBeDefined();
    for (const feature of ADVANCED_FEATURES) {
      expect(featureActiveForState(feature, r.state!)).toBe(true);
    }
  });
});
