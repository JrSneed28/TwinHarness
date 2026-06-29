/**
 * privacy-docs.doc-truth.test.ts — finding #5 guard.
 *
 * The user-facing privacy docs must describe the SAFER current implementation,
 * not the prior raw-by-default behavior. This guard couples the prose to the
 * code (default caps, the two raw-store opt-ins recognised by
 * rawColdStoreEnabled), so the docs can never drift back to claiming raw output
 * is persisted by default.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  COLD_STORE_DEFAULT_MAX_BYTES,
  COLD_STORE_DEFAULT_MAX_AGE_DAYS,
} from "../src/core/context-page";

const REPO_ROOT = path.resolve(__dirname, "..");
const README = fs.readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");
const ADVANCED = fs.readFileSync(path.join(REPO_ROOT, "docs", "guide", "advanced.md"), "utf8");

describe("finding #5 — privacy docs match the metadata-only-by-default implementation", () => {
  it("README states OBSERVE is metadata-only by default", () => {
    expect(README).toContain("metadata-only by default");
  });

  it("README does NOT claim raw output is persisted by default", () => {
    // The old stale phrasing claimed the on-by-default hook persists tool outputs
    // as local plaintext. That must not reappear.
    expect(README).not.toMatch(/persist tool outputs[^.]*local plaintext/i);
    expect(README).not.toMatch(/does persist tool outputs/i);
  });

  it("README documents the raw-store opt-in", () => {
    expect(README).toContain("TH_CONTEXT_RAW_STORE");
  });

  it("advanced guide describes BOTH raw-store opt-in mechanisms (rawColdStoreEnabled semantics)", () => {
    // rawColdStoreEnabled() returns true for either env var; both must be documented.
    expect(ADVANCED).toContain("TH_CONTEXT_RAW_STORE");
    expect(ADVANCED).toContain("TH_EXACT_SUPPRESS");
    expect(ADVANCED).toContain("metadata-only");
  });

  it("default cap values in the advanced guide match the code", () => {
    const maxMiB = COLD_STORE_DEFAULT_MAX_BYTES / (1024 * 1024); // 256
    expect(ADVANCED).toContain(`${maxMiB} MiB`);
    expect(ADVANCED).toContain(`${COLD_STORE_DEFAULT_MAX_AGE_DAYS} days`);
  });
});
