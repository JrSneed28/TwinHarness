/**
 * Bundled corpus load + validation (plan Step 0 / AC #2 / §11).
 *
 * Loads the REAL bundled corpus under `proof/corpus/` and asserts the coverage
 * contract: every required tier is present and at least one brownfield brief
 * ships. The negative cases prove `validateCorpus` FAILS on a missing tier and on
 * a corpus with no brownfield brief.
 */

import { describe, it, expect } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import { loadCorpus, validateCorpus, CorpusLoadError } from "../src/core/proof/corpus";
import type { Corpus } from "../src/core/proof/types";

const CORPUS_ROOT = path.resolve(__dirname, "../proof/corpus");

describe("loadCorpus + validateCorpus over the bundled corpus", () => {
  it("loads every enumerated brief with resolved absolute paths", () => {
    const corpus = loadCorpus(CORPUS_ROOT);
    expect(corpus.briefs.length).toBe(4);

    const ids = corpus.briefs.map((b) => b.id).sort();
    expect(ids).toEqual([
      "medium-app-greenfield",
      "small-lib-brownfield",
      "small-lib-greenfield",
      "tiny-cli-greenfield",
    ]);

    // Each brief carries an absolute briefDir that exists.
    for (const b of corpus.briefs) {
      expect(b.briefDir && path.isAbsolute(b.briefDir)).toBe(true);
      expect(fs.existsSync(b.briefDir!)).toBe(true);
      expect(b.acceptanceCriteria.length).toBeGreaterThan(0);
    }
  });

  it("resolves the brownfield seed tree to an existing absolute path", () => {
    const corpus = loadCorpus(CORPUS_ROOT);
    const brown = corpus.briefs.find((b) => b.type === "brownfield");
    expect(brown).toBeDefined();
    expect(brown!.seedDir && path.isAbsolute(brown!.seedDir)).toBe(true);
    expect(fs.existsSync(brown!.seedDir!)).toBe(true);
    // The seed is a real existing-codebase tree to adopt.
    expect(fs.existsSync(path.join(brown!.seedDir!, "src", "slugify.js"))).toBe(true);
  });

  it("passes validation: all required tiers + a brownfield brief present", () => {
    const corpus = loadCorpus(CORPUS_ROOT);
    const result = validateCorpus(corpus);
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);

    const tiers = new Set(corpus.briefs.map((b) => b.tierHint));
    expect(tiers.has("T1")).toBe(true);
    expect(tiers.has("T2")).toBe(true);
    expect(tiers.has("T3")).toBe(true);
  });

  it("FAILS validation when a required tier is missing", () => {
    const corpus = loadCorpus(CORPUS_ROOT);
    // Drop every T3 brief (the medium-app) → tier coverage gap.
    const missingTier: Corpus = { root: corpus.root, briefs: corpus.briefs.filter((b) => b.tierHint !== "T3") };
    const result = validateCorpus(missingTier);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.includes("T3"))).toBe(true);
  });

  it("FAILS validation when no brownfield brief is present (tiers still covered)", () => {
    const corpus = loadCorpus(CORPUS_ROOT);
    // Keep only greenfields — T1/T2/T3 are still covered, but brownfield is gone.
    const noBrownfield: Corpus = { root: corpus.root, briefs: corpus.briefs.filter((b) => b.type === "greenfield") };
    const tiers = new Set(noBrownfield.briefs.map((b) => b.tierHint));
    expect(tiers.has("T1") && tiers.has("T2") && tiers.has("T3")).toBe(true); // tiers intact

    const result = validateCorpus(noBrownfield);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.toLowerCase().includes("brownfield"))).toBe(true);
  });

  it("throws CorpusLoadError when the corpus index is absent", () => {
    expect(() => loadCorpus(path.join(CORPUS_ROOT, "does-not-exist"))).toThrow(CorpusLoadError);
  });
});
