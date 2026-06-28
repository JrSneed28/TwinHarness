/**
 * tests/context-manifest.test.ts — StageManifest load / validate / pack tests.
 *
 * Verifies:
 *   - A well-formed manifest file loads and validates (REQ-MANIFEST-001).
 *   - Absent manifest ⟹ advisory default, no behaviour change (REQ-MANIFEST-002).
 *   - Malformed manifest ⟹ advisory default, passthrough (REQ-MANIFEST-003).
 *   - validateManifest rejects bad shapes with a reason string (REQ-MANIFEST-004).
 *   - Well-known agent packs (Critic/Builder/Debugger/Inspector) pass validation (REQ-MANIFEST-005).
 *   - manifestFilePath returns the expected path structure (REQ-MANIFEST-006).
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import {
  loadManifest,
  validateManifest,
  manifestFilePath,
  CRITIC_MANIFEST_PACK,
  BUILDER_MANIFEST_PACK,
  DEBUGGER_MANIFEST_PACK,
  INSPECTOR_MANIFEST_PACK,
  type StageManifest,
} from "../src/core/context-manifest";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeManifest(t: TempProject, tier: string, stage: string, content: unknown): void {
  const fp = manifestFilePath(t.paths, tier, stage);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(content), "utf8");
}

function writeRawManifest(t: TempProject, tier: string, stage: string, raw: string): void {
  const fp = manifestFilePath(t.paths, tier, stage);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, raw, "utf8");
}

const VALID_MANIFEST: StageManifest = {
  pinned: ["requirements", "scope"],
  upstream: ["domain-model"],
  optional: ["adr"],
  excluded: ["debug-log"],
  sections: { artifact: ["Summary", "Findings"] },
  selectors: [],
  critic_evidence: ["grounded-defect"],
  max_budget: 2000,
};

// ---------------------------------------------------------------------------
// REQ-MANIFEST-001: valid manifest loads and validates
// ---------------------------------------------------------------------------

describe("REQ-MANIFEST-001: valid manifest loads and validates", () => {
  it("loadManifest returns found:true, valid:true for a well-formed file", () => {
    tp = makeTempProject();
    writeManifest(tp, "T1", "architecture", VALID_MANIFEST);
    const result = loadManifest(tp.paths, "T1", "architecture");
    expect(result.found).toBe(true);
    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("loaded manifest fields match the written JSON", () => {
    tp = makeTempProject();
    writeManifest(tp, "T2", "code", VALID_MANIFEST);
    const { manifest } = loadManifest(tp.paths, "T2", "code");
    expect(manifest.pinned).toEqual(["requirements", "scope"]);
    expect(manifest.upstream).toEqual(["domain-model"]);
    expect(manifest.optional).toEqual(["adr"]);
    expect(manifest.excluded).toEqual(["debug-log"]);
    expect(manifest.sections.artifact).toEqual(["Summary", "Findings"]);
    expect(manifest.selectors).toEqual([]);
    expect(manifest.critic_evidence).toEqual(["grounded-defect"]);
    expect(manifest.max_budget).toBe(2000);
  });

  it("absent optional fields default to empty arrays and zero budget", () => {
    tp = makeTempProject();
    writeManifest(tp, "T1", "minimal", { pinned: ["req"] });
    const { manifest, valid } = loadManifest(tp.paths, "T1", "minimal");
    expect(valid).toBe(true);
    expect(manifest.pinned).toEqual(["req"]);
    expect(manifest.upstream).toEqual([]);
    expect(manifest.optional).toEqual([]);
    expect(manifest.excluded).toEqual([]);
    expect(manifest.sections.artifact).toEqual([]);
    expect(manifest.max_budget).toBe(0);
  });

  it("max_budget:0 is a valid explicit value", () => {
    tp = makeTempProject();
    writeManifest(tp, "T1", "zero-budget", { max_budget: 0 });
    const { valid, manifest } = loadManifest(tp.paths, "T1", "zero-budget");
    expect(valid).toBe(true);
    expect(manifest.max_budget).toBe(0);
  });

  it("extra unknown fields in the JSON are ignored (permissive)", () => {
    tp = makeTempProject();
    writeManifest(tp, "T1", "extra-fields", { ...VALID_MANIFEST, future_field: "ignored" });
    const { valid } = loadManifest(tp.paths, "T1", "extra-fields");
    expect(valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// REQ-MANIFEST-002: absent manifest ⟹ advisory default, passthrough
// ---------------------------------------------------------------------------

describe("REQ-MANIFEST-002: absent manifest ⟹ advisory default, passthrough", () => {
  it("returns found:false when the file does not exist", () => {
    tp = makeTempProject();
    const result = loadManifest(tp.paths, "T1", "nonexistent");
    expect(result.found).toBe(false);
    expect(result.valid).toBe(false);
  });

  it("absent manifest returns all-empty advisory default", () => {
    tp = makeTempProject();
    const { manifest } = loadManifest(tp.paths, "T3", "missing-stage");
    expect(manifest.pinned).toEqual([]);
    expect(manifest.upstream).toEqual([]);
    expect(manifest.optional).toEqual([]);
    expect(manifest.excluded).toEqual([]);
    expect(manifest.sections.artifact).toEqual([]);
    expect(manifest.selectors).toEqual([]);
    expect(manifest.critic_evidence).toEqual([]);
    expect(manifest.max_budget).toBe(0);
  });

  it("does not throw when the manifest directory is absent", () => {
    tp = makeTempProject();
    // stateDir exists but context-manifests/ subdir does not
    expect(() => loadManifest(tp.paths, "T1", "code")).not.toThrow();
  });

  it("does not throw when stateDir itself is absent", () => {
    tp = makeTempProject();
    // Use a paths object pointing at a completely absent root
    const fakePaths = { ...tp.paths, stateDir: path.join(tp.paths.stateDir, "does-not-exist") };
    expect(() => loadManifest(fakePaths, "T1", "code")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// REQ-MANIFEST-003: malformed manifest ⟹ advisory default, passthrough
// ---------------------------------------------------------------------------

describe("REQ-MANIFEST-003: malformed manifest ⟹ advisory default, ignored", () => {
  it("returns found:true, valid:false, reason for invalid JSON", () => {
    tp = makeTempProject();
    writeRawManifest(tp, "T1", "bad-json", "{ not valid json");
    const result = loadManifest(tp.paths, "T1", "bad-json");
    expect(result.found).toBe(true);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/JSON/i);
  });

  it("invalid JSON yields advisory default (all-empty, zero budget)", () => {
    tp = makeTempProject();
    writeRawManifest(tp, "T1", "bad-json2", "{ broken");
    const { manifest } = loadManifest(tp.paths, "T1", "bad-json2");
    expect(manifest.pinned).toEqual([]);
    expect(manifest.max_budget).toBe(0);
  });

  it("returns found:true, valid:false when pinned is not an array", () => {
    tp = makeTempProject();
    writeManifest(tp, "T1", "bad-pinned", { pinned: "not-an-array" });
    const result = loadManifest(tp.paths, "T1", "bad-pinned");
    expect(result.found).toBe(true);
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it("returns advisory default when root JSON value is an array, not an object", () => {
    tp = makeTempProject();
    writeManifest(tp, "T1", "array-root", [1, 2, 3]);
    const result = loadManifest(tp.paths, "T1", "array-root");
    expect(result.found).toBe(true);
    expect(result.valid).toBe(false);
  });

  it("returns advisory default when root JSON value is null", () => {
    tp = makeTempProject();
    writeRawManifest(tp, "T1", "null-root", "null");
    const result = loadManifest(tp.paths, "T1", "null-root");
    expect(result.found).toBe(true);
    expect(result.valid).toBe(false);
  });

  it("negative max_budget is rejected as malformed", () => {
    tp = makeTempProject();
    writeManifest(tp, "T1", "neg-budget", { max_budget: -1 });
    const result = loadManifest(tp.paths, "T1", "neg-budget");
    expect(result.found).toBe(true);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/max_budget/);
  });

  it("non-string element in critic_evidence is rejected", () => {
    tp = makeTempProject();
    writeManifest(tp, "T1", "bad-evidence", { critic_evidence: [42] });
    const result = loadManifest(tp.paths, "T1", "bad-evidence");
    expect(result.found).toBe(true);
    expect(result.valid).toBe(false);
  });

  it("non-object sections field is rejected", () => {
    tp = makeTempProject();
    writeManifest(tp, "T1", "bad-sections", { sections: "not-an-object" });
    const result = loadManifest(tp.paths, "T1", "bad-sections");
    expect(result.found).toBe(true);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/sections/);
  });

  it("does not throw on any malformed input (fail-safe, D-16)", () => {
    tp = makeTempProject();
    // null root
    writeRawManifest(tp, "T1", "null-json", "null");
    expect(() => loadManifest(tp.paths, "T1", "null-json")).not.toThrow();
    // non-string array element in pinned
    writeManifest(tp, "T1", "bad-element", { pinned: [123] });
    expect(() => loadManifest(tp.paths, "T1", "bad-element")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// REQ-MANIFEST-004: validateManifest direct unit tests
// ---------------------------------------------------------------------------

describe("REQ-MANIFEST-004: validateManifest rejects bad shapes with a reason", () => {
  it("rejects null", () => {
    const r = validateManifest(null);
    expect(r.ok).toBe(false);
  });

  it("rejects an array", () => {
    const r = validateManifest([]);
    expect(r.ok).toBe(false);
  });

  it("rejects a non-string in pinned", () => {
    const r = validateManifest({ pinned: [42] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("pinned");
  });

  it("rejects a non-string in upstream", () => {
    const r = validateManifest({ upstream: [null] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("upstream");
  });

  it("rejects non-object sections", () => {
    const r = validateManifest({ sections: "not-an-object" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("sections");
  });

  it("rejects non-string sections.artifact element", () => {
    const r = validateManifest({ sections: { artifact: [99] } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("sections.artifact");
  });

  it("rejects negative max_budget", () => {
    const r = validateManifest({ max_budget: -100 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("max_budget");
  });

  it("rejects non-finite max_budget (Infinity)", () => {
    const r = validateManifest({ max_budget: Infinity });
    expect(r.ok).toBe(false);
  });

  it("rejects non-number max_budget (string)", () => {
    const r = validateManifest({ max_budget: "1000" });
    expect(r.ok).toBe(false);
  });

  it("accepts a fully-absent optional field set (all defaults)", () => {
    const r = validateManifest({});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.pinned).toEqual([]);
      expect(r.manifest.max_budget).toBe(0);
      expect(r.manifest.sections.artifact).toEqual([]);
    }
  });

  it("accepts null sections (treated as absent, defaults to empty artifact)", () => {
    const r = validateManifest({ sections: null });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.manifest.sections.artifact).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// REQ-MANIFEST-005: well-known agent packs pass validateManifest
// ---------------------------------------------------------------------------

describe("REQ-MANIFEST-005: well-known agent packs pass validateManifest", () => {
  it("CRITIC_MANIFEST_PACK is valid", () => {
    const r = validateManifest(CRITIC_MANIFEST_PACK);
    expect(r.ok).toBe(true);
  });

  it("BUILDER_MANIFEST_PACK is valid", () => {
    const r = validateManifest(BUILDER_MANIFEST_PACK);
    expect(r.ok).toBe(true);
  });

  it("DEBUGGER_MANIFEST_PACK is valid", () => {
    const r = validateManifest(DEBUGGER_MANIFEST_PACK);
    expect(r.ok).toBe(true);
  });

  it("INSPECTOR_MANIFEST_PACK is valid", () => {
    const r = validateManifest(INSPECTOR_MANIFEST_PACK);
    expect(r.ok).toBe(true);
  });

  it("CRITIC_MANIFEST_PACK has a positive max_budget", () => {
    expect(CRITIC_MANIFEST_PACK.max_budget).toBeGreaterThan(0);
  });

  it("DEBUGGER_MANIFEST_PACK pinned includes requirements and contracts", () => {
    expect(DEBUGGER_MANIFEST_PACK.pinned).toContain("requirements");
    expect(DEBUGGER_MANIFEST_PACK.pinned).toContain("contracts");
  });
});

// ---------------------------------------------------------------------------
// REQ-MANIFEST-006: manifestFilePath returns the correct path
// ---------------------------------------------------------------------------

describe("REQ-MANIFEST-006: manifestFilePath returns the correct path structure", () => {
  it("path is <stateDir>/context-manifests/<tier>/<stage>.json", () => {
    tp = makeTempProject();
    const p = manifestFilePath(tp.paths, "T1", "architecture");
    expect(p).toContain("context-manifests");
    expect(p).toContain("T1");
    expect(p).toMatch(/architecture\.json$/);
  });

  it("tier and stage appear as separate path segments", () => {
    tp = makeTempProject();
    const p = manifestFilePath(tp.paths, "T2", "code-review");
    const parts = p.split(/[\\/]/);
    const idx = parts.indexOf("context-manifests");
    expect(idx).toBeGreaterThan(-1);
    expect(parts[idx + 1]).toBe("T2");
    expect(parts[idx + 2]).toBe("code-review.json");
  });

  it("different tier/stage pairs produce different paths", () => {
    tp = makeTempProject();
    const a = manifestFilePath(tp.paths, "T1", "arch");
    const b = manifestFilePath(tp.paths, "T2", "arch");
    const c = manifestFilePath(tp.paths, "T1", "code");
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(b).not.toBe(c);
  });
});
