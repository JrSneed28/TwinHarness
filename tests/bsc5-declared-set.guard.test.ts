/**
 * Axis-B slice-7 (BSC-5) — the COMMITTED declared-dimension-set guard (consensus plan §5/§6,
 * negative-control d). The keystone BSC-5 invariant (Interp A): the declared required dimension
 * set is a COMMITTED SOURCE ARTIFACT the gate READS — never minted at attestation time, never a
 * runtime self-attest. NARROWING it (dropping a required dimension to hide an unobserved one) must
 * be a REVIEWABLE code + `dist/` diff, not a silent runtime move.
 *
 * This guard turns that invariant on the source of truth itself:
 *   - The declared set is the LITERAL `DECLARED_DIMENSION_SET` constant (a committed `core/` source
 *     module), so a narrowing is a `src/` diff (and, after `npm run build`, a `dist/` diff CI's
 *     committed-`dist/` invariant blocks).
 *   - The constant is the SINGLE source the gate's digest + the gate's coverage check read — there
 *     is no parallel on-disk declared-set file an agent could rewrite between mint and gate.
 *   - Every declared dimension is OBSERVABLE by the BSC-3 sensor (a member of the seed vocabulary),
 *     so a declared name can never be an always-absent always-blocking mis-declaration.
 *   - The canonical form + digest are order- and duplicate-independent (the SET identity), so a
 *     reorder/dupe edit that does not change the set does not change the digest.
 */

import { describe, it, expect } from "vitest";
import {
  DECLARED_DIMENSION_SET,
  declaredDimensionSet,
  declaredDimensionSetCanonical,
  declaredDimensionSetDigest,
  assertDeclaredDimensionsObservable,
} from "../src/core/declared-dimensions";
import { SEED_DIMENSION_NAMES } from "../src/core/verification-driver";
import { hashContent } from "../src/core/hash";

describe("BSC-5 declared set — committed source artifact (Interp A)", () => {
  it("the declared set is the seed required trio (the committed required dimensions)", () => {
    // The gate READS this constant directly. Narrowing it (removing a name) is a reviewable
    // src/ + dist/ diff — exactly what this assertion pins as the source of truth.
    expect([...DECLARED_DIMENSION_SET].sort()).toEqual(["build", "tests-executed", "typecheck"]);
  });

  it("declaredDimensionSet() returns a fresh COPY (callers cannot mutate the constant)", () => {
    const a = declaredDimensionSet();
    a.push("injected");
    expect(declaredDimensionSet()).not.toContain("injected");
  });

  it("every declared dimension is OBSERVABLE by the BSC-3 sensor (declared ⊆ seed vocabulary)", () => {
    const seed = new Set(SEED_DIMENSION_NAMES);
    for (const d of DECLARED_DIMENSION_SET) {
      expect(seed.has(d), `declared dimension ${d} must be observable (in SEED_DIMENSION_NAMES)`).toBe(true);
    }
    // The load-time guard agrees (does not throw on the committed set).
    expect(() => assertDeclaredDimensionsObservable()).not.toThrow();
  });
});

describe("BSC-5 declared set — canonical form + digest (set identity)", () => {
  it("canonical form is sorted, de-duplicated, newline-joined (order/dupe independent)", () => {
    expect(declaredDimensionSetCanonical()).toBe(["build", "tests-executed", "typecheck"].join("\n"));
  });

  it("digest is SHA-256 of the canonical form (the committed set's stable identity)", () => {
    expect(declaredDimensionSetDigest()).toBe(hashContent(declaredDimensionSetCanonical()));
    expect(declaredDimensionSetDigest()).toMatch(/^[0-9a-f]{64}$/);
  });
});
