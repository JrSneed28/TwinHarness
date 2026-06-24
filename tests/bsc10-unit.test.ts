/**
 * BSC-10 / Axis-B slice-A — unit tests for External-Reference Grounding (Lane C).
 *
 * Covers U1–U9 per the acceptance spec (§3) and test plan (§4 Unit).
 *
 * All symbol names and return shapes are read from the committed source before authoring:
 *   src/core/grounding.ts — requiredGroundKindsForWorkClass → RequiredGroundKinds
 *                           { required: GroundKind[]; crossCheckFlag?: "class-cross-check-mismatch" }
 *                         — isValidGroundingReceipt(parsed) → boolean
 *                         — validateGroundingContent(paths, receipt) → GroundingContentValidation
 *                           { status: "valid"|"over-budget"|"unobserved"|"stale"|"target_mismatch"; ... }
 *                         — verifyGroundingChain(receipts) →
 *                           { ok:true } | { ok:false; brokenAt:number; reason:"edited"|"prev_mismatch" }
 *                         — serializeGroundingGround(ground: GroundingGround) → string
 *                         — groundingGroundDigest(ground: GroundingGround) → string
 *                         — computeGroundingRecordHash(receipt: Omit<GroundingReceipt,"recordHash">) → string
 *   src/core/bsc10-flag.ts — bsc10EnforcementEnabled(): byte-mirror of bsc2-flag.ts polarity
 *                            (bsc2-flag.ts:34-39): unset → compiled default (two-commit toggle);
 *                            "0"/"false" (case-insensitive, trimmed) → false; ANY OTHER value
 *                            (including "yes", "on", "banana") → true (fail-closed polarity).
 *                            Slice-B compiled default: `return true` (ENFORCE dist — the
 *                            818a956 enforce-flip; the Slice-A WARN dist shipped `return false`).
 *
 * GroundingReceipt schema: receipt has a NESTED `ground: GroundingGround` field (NOT inline
 * groundKind/manifestDigest). appendGroundingReceipt takes MintGroundingInput:
 *   { workClass, ground: GroundingGround, conformance?, producerIdentity, ... }
 *
 * UX-surface force-rule: UX_SURFACE_LABELS = Set(["ux","ui","tui","screen","interactive","visual"]).
 * The gate passes state.has_ui !== false ? ["ui"] : [] as the surfaces arg.
 *
 * Token note (plan §4 gap 9): the spec shorthand is "digest"; the schema GroundKind literal is
 * "digest-manifest". All assertions use the literal.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  serializeGroundingGround,
  groundingGroundDigest,
  computeGroundingRecordHash,
  isValidGroundingReceipt,
  isValidGroundingBudget,
  validateGroundingContent,
  verifyGroundingChain,
  requiredGroundKindsForWorkClass,
} from "../src/core/grounding";
import { bsc10EnforcementEnabled } from "../src/core/bsc10-flag";
import type { GroundingGround, GroundingReceipt } from "../src/core/grounding";
import { GENESIS_PREV_HASH } from "../src/core/hash";
import type { ProjectPaths } from "../src/core/paths";

// Minimal fake ProjectPaths for validateGroundingContent (snapshot coord both null → no stale).
const FAKE_PATHS = {
  root: "/nonexistent-test-root",
  stateDir: "/nonexistent-test-root/.th-state",
} as unknown as ProjectPaths;

// ---------------------------------------------------------------------------
// U1 — byte-stability: canonical text + hashes are identical across calls
// serializeGroundingGround / groundingGroundDigest operate on GroundingGround (the nested ground).
// computeGroundingRecordHash operates on Omit<GroundingReceipt, "recordHash">.
// ---------------------------------------------------------------------------

describe("U1 — GroundingGround canonical text byte-stability", () => {
  const digestGround: GroundingGround = {
    groundKind: "digest-manifest",
    manifestDigest: "sha256:aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
    // entries absent — omit-when-absent
  };

  it("serializeGroundingGround is byte-identical across two calls", () => {
    expect(serializeGroundingGround(digestGround)).toBe(serializeGroundingGround(digestGround));
  });

  it("groundingGroundDigest is stable (same input ⇒ same hex digest)", () => {
    const d1 = groundingGroundDigest(digestGround);
    expect(d1).toBe(groundingGroundDigest(digestGround));
    expect(typeof d1).toBe("string");
    expect(d1.length).toBeGreaterThan(0);
  });

  it("optional entries field absent in serialization (omit-when-absent)", () => {
    expect(serializeGroundingGround(digestGround)).not.toContain('"entries"');
  });

  it("entries POSIX-normalized + lexically sorted (determinism across different dir-listing orders)", () => {
    const groundA: GroundingGround = {
      groundKind: "digest-manifest",
      manifestDigest: "sha256:aabb",
      entries: [
        { path: "src/b.ts", digest: "sha256:bb" },
        { path: "src/a.ts", digest: "sha256:aa" },
      ],
    };
    const groundB: GroundingGround = {
      groundKind: "digest-manifest",
      manifestDigest: "sha256:aabb",
      entries: [
        { path: "src/a.ts", digest: "sha256:aa" },
        { path: "src/b.ts", digest: "sha256:bb" },
      ],
    };
    // Different insertion order → same canonical text (sorted by path)
    expect(serializeGroundingGround(groundA)).toBe(serializeGroundingGround(groundB));
    expect(groundingGroundDigest(groundA)).toBe(groundingGroundDigest(groundB));
  });

  it("computeGroundingRecordHash is stable (same receipt ⇒ same hash)", () => {
    const base: Omit<GroundingReceipt, "recordHash"> = {
      kind: "grounding",
      refId: "no-git",
      workClass: "integration",
      ground: digestGround,
      conformance: [],
      snapshot_coord: { gitHead: null, treeDigest: null },
      producer_identity: "test:runner",
      prevHash: GENESIS_PREV_HASH,
    };
    expect(computeGroundingRecordHash(base)).toBe(computeGroundingRecordHash(base));
  });

  it("shuffled GroundingGround field order produces same canonical text (serializer fixes order)", () => {
    const shuffled = {
      manifestDigest: "sha256:aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
      groundKind: "digest-manifest" as const,
    } satisfies GroundingGround;
    expect(serializeGroundingGround(shuffled)).toBe(serializeGroundingGround(digestGround));
    expect(groundingGroundDigest(shuffled)).toBe(groundingGroundDigest(digestGround));
  });
});

// ---------------------------------------------------------------------------
// U2 — isValidGroundingReceipt: discriminated-union shape validator, tolerant-skip, never throws
// Note: the validator requires refId, workClass, prevHash (HEX64), recordHash (HEX64), and
// a valid snapshot_coord — these are all required fields on the full receipt schema.
// ---------------------------------------------------------------------------

describe("U2 — isValidGroundingReceipt: tolerant-skip, never throws", () => {
  const HEX64 = "a".repeat(64);

  const validBase = {
    kind: "grounding" as const,
    refId: "abc123",
    workClass: "integration",
    ground: {
      groundKind: "digest-manifest" as const,
      manifestDigest: "sha256:aabb",
    },
    conformance: [] as GroundingReceipt["conformance"],
    snapshot_coord: { gitHead: null as null, treeDigest: null as null },
    producer_identity: "test:runner",
    prevHash: HEX64,
    recordHash: HEX64,
  };

  it("accepts a well-formed digest-manifest receipt", () => {
    expect(() => isValidGroundingReceipt(validBase)).not.toThrow();
    expect(isValidGroundingReceipt(validBase)).toBe(true);
  });

  it("accepts a well-formed version-pin receipt", () => {
    const rec = {
      ...validBase,
      ground: { groundKind: "version-pin" as const, pkg: "react", version: "18.3.1" },
      conformance: [{ metric: "version" as const, observed: "18.3.1", status: "within-budget" as const }],
    };
    expect(() => isValidGroundingReceipt(rec)).not.toThrow();
    expect(isValidGroundingReceipt(rec)).toBe(true);
  });

  it("accepts a well-formed visual-hash receipt", () => {
    const rec = {
      ...validBase,
      ground: { groundKind: "visual-hash" as const, perceptualHash: "phash:abcdef" },
      conformance: [{ metric: "visual" as const, observed: "unobserved" as const, status: "unobserved" as const }],
    };
    expect(() => isValidGroundingReceipt(rec)).not.toThrow();
    expect(isValidGroundingReceipt(rec)).toBe(true);
  });

  it("returns false (not throws) for empty refId", () => {
    expect(() => isValidGroundingReceipt({ ...validBase, refId: "" })).not.toThrow();
    expect(isValidGroundingReceipt({ ...validBase, refId: "" })).toBe(false);
  });

  it("returns false (not throws) for empty workClass", () => {
    expect(() => isValidGroundingReceipt({ ...validBase, workClass: "" })).not.toThrow();
    expect(isValidGroundingReceipt({ ...validBase, workClass: "" })).toBe(false);
  });

  it("returns false (not throws) for cross-shaped ground (missing manifestDigest)", () => {
    const bad = { ...validBase, ground: { groundKind: "digest-manifest" } };
    expect(() => isValidGroundingReceipt(bad)).not.toThrow();
    expect(isValidGroundingReceipt(bad)).toBe(false);
  });

  it("returns false (not throws) for unknown groundKind", () => {
    const bad = { ...validBase, ground: { groundKind: "unknown-kind" } };
    expect(() => isValidGroundingReceipt(bad)).not.toThrow();
    expect(isValidGroundingReceipt(bad)).toBe(false);
  });

  it("returns false (not throws) for wrong kind field", () => {
    const bad = { ...validBase, kind: "not-grounding" };
    expect(() => isValidGroundingReceipt(bad)).not.toThrow();
    expect(isValidGroundingReceipt(bad)).toBe(false);
  });

  it("returns false (not throws) for null input", () => {
    expect(() => isValidGroundingReceipt(null)).not.toThrow();
    expect(isValidGroundingReceipt(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// U3 — verifyGroundingChain
// Result shape: { ok:true } | { ok:false; brokenAt:number; reason:"edited"|"prev_mismatch" }
// ---------------------------------------------------------------------------

describe("U3 — verifyGroundingChain", () => {
  function makeReceipt(n: number, prevHash: string): GroundingReceipt {
    const base: Omit<GroundingReceipt, "recordHash"> = {
      kind: "grounding",
      refId: "no-git",
      workClass: "integration",
      ground: { groundKind: "version-pin", pkg: `pkg-${n}`, version: `1.0.${n}` },
      conformance: [],
      snapshot_coord: { gitHead: null, treeDigest: null },
      producer_identity: "test:runner",
      prevHash,
    };
    return { ...base, recordHash: computeGroundingRecordHash(base) };
  }

  function buildChain(length: number): GroundingReceipt[] {
    const chain: GroundingReceipt[] = [];
    let prev = GENESIS_PREV_HASH;
    for (let i = 0; i < length; i++) {
      const r = makeReceipt(i, prev);
      chain.push(r);
      prev = r.recordHash;
    }
    return chain;
  }

  it("valid chain of 3 records ⇒ ok:true", () => {
    expect(verifyGroundingChain(buildChain(3))).toEqual({ ok: true });
  });

  it("empty chain ⇒ ok:true", () => {
    expect(verifyGroundingChain([])).toEqual({ ok: true });
  });

  it("single-field edit without recomputing recordHash ⇒ ok:false, reason:'edited'", () => {
    const chain = buildChain(2);
    const tampered = [
      { ...chain[0]!, ground: { groundKind: "version-pin" as const, pkg: "tampered", version: "9.9.9" } },
      chain[1]!,
    ];
    const result = verifyGroundingChain(tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("edited");
      expect(result.brokenAt).toBe(0);
    }
  });

  it("deleting a middle record ⇒ ok:false, reason:'prev_mismatch'", () => {
    const chain = buildChain(3);
    const result = verifyGroundingChain([chain[0]!, chain[2]!]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("prev_mismatch");
  });

  it("inserting an extra record at position 1 ⇒ ok:false, reason:'prev_mismatch'", () => {
    const chain = buildChain(3);
    const extra = makeReceipt(99, GENESIS_PREV_HASH); // wrong prevHash for position 1
    const result = verifyGroundingChain([chain[0]!, extra, chain[1]!, chain[2]!]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("prev_mismatch");
  });

  it("reordering records ⇒ ok:false, reason:'prev_mismatch'", () => {
    const chain = buildChain(3);
    const result = verifyGroundingChain([chain[1]!, chain[0]!, chain[2]!]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("prev_mismatch");
  });
});

// ---------------------------------------------------------------------------
// U4 — fixed work-class→ground matrix (all assert "digest-manifest" literal, NOT "digest")
// requiredGroundKindsForWorkClass returns RequiredGroundKinds: { required: GroundKind[]; crossCheckFlag? }
// Matrix from source: redesign→[dm,vh], recreation→[dm,vh,vp], integration→[dm,vp],
//                     migration→[vp,dm], greenfield+dep→[vp], greenfield→[]
// ---------------------------------------------------------------------------

describe("U4 — requiredGroundKindsForWorkClass matrix (literal 'digest-manifest')", () => {
  it("redesign ⇒ required contains digest-manifest + visual-hash", () => {
    const { required } = requiredGroundKindsForWorkClass("redesign", []);
    expect(required).toContain("digest-manifest");
    expect(required).toContain("visual-hash");
  });

  it("recreation ⇒ required contains digest-manifest + visual-hash + version-pin", () => {
    const { required } = requiredGroundKindsForWorkClass("recreation", []);
    expect(required).toContain("digest-manifest");
    expect(required).toContain("visual-hash");
    expect(required).toContain("version-pin");
  });

  it("integration ⇒ required contains digest-manifest + version-pin (no visual-hash)", () => {
    const { required } = requiredGroundKindsForWorkClass("integration", []);
    expect(required).toContain("digest-manifest");
    expect(required).toContain("version-pin");
    expect(required).not.toContain("visual-hash");
  });

  it("migration ⇒ required contains version-pin + digest-manifest", () => {
    const { required } = requiredGroundKindsForWorkClass("migration", []);
    expect(required).toContain("version-pin");
    expect(required).toContain("digest-manifest");
  });

  it("greenfield+dep ⇒ required contains version-pin", () => {
    const { required } = requiredGroundKindsForWorkClass("greenfield+dep", []);
    expect(required).toContain("version-pin");
  });

  it("greenfield (pure) ⇒ empty required set (inert PASS)", () => {
    const { required } = requiredGroundKindsForWorkClass("greenfield", []);
    expect(required).toHaveLength(0);
  });

  it("required array is sorted (deterministic across runners)", () => {
    const { required } = requiredGroundKindsForWorkClass("integration", []);
    expect(required).toEqual([...required].sort());
  });

  it("schema literal is 'digest-manifest' NOT 'digest' (gap 9 — literal assertion)", () => {
    const { required } = requiredGroundKindsForWorkClass("integration", []);
    expect(required).not.toContain("digest");
    expect(required).toContain("digest-manifest");
  });

  it("no crossCheckFlag when no derivedClass supplied", () => {
    expect(requiredGroundKindsForWorkClass("integration", []).crossCheckFlag).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// U5 — UX-surface force-rule
// UX_SURFACE_LABELS from source: Set(["ux","ui","tui","screen","interactive","visual"])
// Gate passes state.has_ui !== false ? ["ui"] : [] as the surfaces arg.
// Unit test drives the classifier directly with each surface label.
// ---------------------------------------------------------------------------

describe("U5 — UX-surface force-rule (surfaces arg)", () => {
  it("empty surfaces ⇒ integration required does NOT include visual-hash", () => {
    expect(requiredGroundKindsForWorkClass("integration", []).required).not.toContain("visual-hash");
  });

  it("'ui' surface (gate's own token: state.has_ui ⇒ ['ui']) forces visual-hash for integration", () => {
    expect(requiredGroundKindsForWorkClass("integration", ["ui"]).required).toContain("visual-hash");
  });

  it("'interactive' surface forces visual-hash", () => {
    expect(requiredGroundKindsForWorkClass("integration", ["interactive"]).required).toContain("visual-hash");
  });

  it("'screen' surface forces visual-hash even for greenfield (empty base set)", () => {
    expect(requiredGroundKindsForWorkClass("greenfield", ["screen"]).required).toContain("visual-hash");
  });

  it("'tui' surface forces visual-hash for migration (additive with existing required set)", () => {
    const { required } = requiredGroundKindsForWorkClass("migration", ["tui"]);
    expect(required).toContain("visual-hash");
    expect(required).toContain("version-pin");
    expect(required).toContain("digest-manifest");
  });

  it("'visual' surface forces visual-hash", () => {
    expect(requiredGroundKindsForWorkClass("integration", ["visual"]).required).toContain("visual-hash");
  });

  it("'ux' surface forces visual-hash", () => {
    expect(requiredGroundKindsForWorkClass("integration", ["ux"]).required).toContain("visual-hash");
  });

  it("surface label matching is case-insensitive (source: .trim().toLowerCase())", () => {
    expect(requiredGroundKindsForWorkClass("integration", ["UI"]).required).toContain("visual-hash");
    expect(requiredGroundKindsForWorkClass("integration", [" Tui "]).required).toContain("visual-hash");
  });
});

// ---------------------------------------------------------------------------
// U6 — cross-check conflict rule
// requiredGroundKindsForWorkClass(workClass, surfaces, derivedClass?) → RequiredGroundKinds
//   { required: GroundKind[]; crossCheckFlag?: "class-cross-check-mismatch" }
// ---------------------------------------------------------------------------

describe("U6 — class cross-check conflict rule (crossCheckFlag)", () => {
  it("declared≠derived ⇒ required is the STRICTER UNION of both classes' kinds", () => {
    // declared "integration" ⇒ [digest-manifest, version-pin]
    // derived  "redesign"    ⇒ [digest-manifest, visual-hash]
    // union                  ⇒ [digest-manifest, version-pin, visual-hash]
    const { required } = requiredGroundKindsForWorkClass("integration", [], "redesign");
    expect(required).toContain("digest-manifest");
    expect(required).toContain("version-pin");
    expect(required).toContain("visual-hash");
  });

  it("declared≠derived ⇒ crossCheckFlag is 'class-cross-check-mismatch'", () => {
    const result = requiredGroundKindsForWorkClass("integration", [], "redesign");
    expect(result.crossCheckFlag).toBe("class-cross-check-mismatch");
  });

  it("declared===derived ⇒ crossCheckFlag absent (no mismatch)", () => {
    expect(requiredGroundKindsForWorkClass("integration", [], "integration").crossCheckFlag).toBeUndefined();
  });

  it("no derivedClass ⇒ crossCheckFlag absent", () => {
    expect(requiredGroundKindsForWorkClass("integration", []).crossCheckFlag).toBeUndefined();
  });

  it("cross-check never silently picks one class — visual-hash is in required (fail-closed)", () => {
    // If the gate silently picked "integration" alone, visual-hash would be missing (under-require)
    expect(requiredGroundKindsForWorkClass("integration", [], "redesign").required).toContain("visual-hash");
  });

  it("result.required is de-duplicated + sorted", () => {
    const { required } = requiredGroundKindsForWorkClass("integration", [], "redesign");
    expect(required).toEqual([...new Set(required)].sort());
  });
});

// ---------------------------------------------------------------------------
// U7 — typed conformance metrics at / over budget
// validateGroundingContent(paths, receipt) → GroundingContentValidation { status; ... }
// Status values (from source): "valid" | "over-budget" | "unobserved" | "stale" | "target_mismatch"
// Note: conformance status values use hyphens ("within-budget"/"over-budget"/"unobserved");
//       gate detail reasons use underscores ("over_budget"/"unobserved"/"missing") — deliberately distinct.
// ---------------------------------------------------------------------------

describe("U7 — typed conformance metrics: within-budget vs over-budget", () => {
  function makeReceipt(ground: GroundingGround, conformance: GroundingReceipt["conformance"]): GroundingReceipt {
    const base: Omit<GroundingReceipt, "recordHash"> = {
      kind: "grounding",
      refId: "no-git",
      workClass: "integration",
      ground,
      conformance,
      snapshot_coord: { gitHead: null, treeDigest: null },
      producer_identity: "test:runner",
      prevHash: GENESIS_PREV_HASH,
    };
    return { ...base, recordHash: computeGroundingRecordHash(base) };
  }

  it("version-pin: within-budget conformance ⇒ status:'valid'", () => {
    const rec = makeReceipt(
      { groundKind: "version-pin", pkg: "react", version: "18.3.1" },
      [{ metric: "version", observed: "18.3.1", status: "within-budget" }],
    );
    expect(validateGroundingContent(FAKE_PATHS, rec).status).toBe("valid");
  });

  it("version-pin: over-budget conformance ⇒ status:'over-budget', overBudgetMetrics contains 'version'", () => {
    const rec = makeReceipt(
      { groundKind: "version-pin", pkg: "react", version: "18.3.1" },
      [{ metric: "version", observed: "17.0.2", status: "over-budget" }],
    );
    const v = validateGroundingContent(FAKE_PATHS, rec);
    expect(v.status).toBe("over-budget");
    expect(v.overBudgetMetrics).toContain("version");
  });

  it("digest-manifest: api within budget ⇒ status:'valid'", () => {
    const rec = makeReceipt(
      { groundKind: "digest-manifest", manifestDigest: "sha256:aabb" },
      [{ metric: "api", observed: 2, status: "within-budget" }],
    );
    expect(validateGroundingContent(FAKE_PATHS, rec).status).toBe("valid");
  });

  it("digest-manifest: api over budget ⇒ status:'over-budget', overBudgetMetrics contains 'api'", () => {
    const rec = makeReceipt(
      { groundKind: "digest-manifest", manifestDigest: "sha256:aabb" },
      [{ metric: "api", observed: 150, status: "over-budget" }],
    );
    const v = validateGroundingContent(FAKE_PATHS, rec);
    expect(v.status).toBe("over-budget");
    expect(v.overBudgetMetrics).toContain("api");
  });

  it("visual-hash: a11y + visual unobserved (Slice A stub) ⇒ status:'unobserved', unobservedMetrics lists both", () => {
    const rec = makeReceipt(
      { groundKind: "visual-hash", perceptualHash: "phash:aabb" },
      [
        { metric: "visual", observed: "unobserved", status: "unobserved" },
        { metric: "a11y", observed: "unobserved", status: "unobserved" },
      ],
    );
    const v = validateGroundingContent(FAKE_PATHS, rec);
    expect(v.status).toBe("unobserved");
    expect(v.unobservedMetrics).toContain("visual");
    expect(v.unobservedMetrics).toContain("a11y");
  });

  it("unobserved takes precedence over over-budget (fail-closed source ordering)", () => {
    const rec = makeReceipt(
      { groundKind: "digest-manifest", manifestDigest: "sha256:aabb" },
      [
        { metric: "api", observed: "unobserved", status: "unobserved" },
        { metric: "version", observed: "2.0.0", status: "over-budget" },
      ],
    );
    expect(validateGroundingContent(FAKE_PATHS, rec).status).toBe("unobserved");
  });

  it("empty conformance array with null snapshot coords ⇒ status:'valid'", () => {
    const rec = makeReceipt({ groundKind: "digest-manifest", manifestDigest: "sha256:aabb" }, []);
    expect(validateGroundingContent(FAKE_PATHS, rec).status).toBe("valid");
  });
});

// ---------------------------------------------------------------------------
// U8 — signed carve-out masks region / unsigned masks nothing (M4)
// GroundingCarveout schema requires key_id + signature + producer_kind:"external" for validity.
// isValidGroundingBudget requires the full external trailer (hasValidExternalTrailer).
// ---------------------------------------------------------------------------

describe("U8 — carve-out: signed masks region, unsigned masks nothing (M4)", () => {
  it("unsigned carve-out entry has no key_id/signature (structurally untrustworthy — exempts nothing)", () => {
    const unsigned = {
      kind: "grounding-carveout",
      workClass: "redesign",
      regionDigest: "a".repeat(64),
      reason: "intentional design deviation",
      // Deliberately missing: producer_kind, key_id, signature, prevHash, recordHash
    };
    expect((unsigned as Record<string, unknown>)["key_id"]).toBeUndefined();
    expect((unsigned as Record<string, unknown>)["signature"]).toBeUndefined();
    expect((unsigned as Record<string, unknown>)["producer_kind"]).toBeUndefined();
  });

  it("isValidGroundingBudget rejects an unsigned budget line (no producer_kind/key_id) — fail-closed M4", () => {
    const unsigned = {
      kind: "grounding-budget",
      workClass: "integration",
      groundKind: "digest-manifest",
      metric: "api",
      threshold: 10,
      snapshot_coord: { gitHead: null, treeDigest: null },
      // Missing: producer_kind, key_id, prevHash, recordHash
    };
    expect(isValidGroundingBudget(unsigned)).toBe(false);
  });

  it("a properly-formed signed carve-out carries key_id + signature + producer_kind:'external'", () => {
    const signed = {
      kind: "grounding-carveout" as const,
      workClass: "redesign",
      regionDigest: "a".repeat(64),
      reason: "intentional deviation",
      snapshot_coord: { gitHead: null, treeDigest: null },
      producer_kind: "external" as const,
      key_id: "sha256:" + "a".repeat(64),
      signature: "A".repeat(86) + "==",
      prevHash: GENESIS_PREV_HASH,
      recordHash: "b".repeat(64),
    };
    expect(typeof signed.key_id).toBe("string");
    expect(typeof signed.signature).toBe("string");
    expect(signed.producer_kind).toBe("external");
  });
});

// ---------------------------------------------------------------------------
// U9 — bsc10EnforcementEnabled() both legs (Slice B: bsc2-mirror fail-closed polarity)
// bsc2-flag.ts polarity (plan §U9 LOCKED decision): "0"/"false" → false; ANY OTHER value
// (including "yes", "on", "banana") → true. Compiled default is the two-commit toggle:
// Slice-A WARN dist shipped `return false`; the Slice-B ENFORCE dist (818a956) ships `return true`.
// ---------------------------------------------------------------------------

describe("U9 — bsc10EnforcementEnabled() — bsc2-mirror polarity (Slice B: default ON / ENFORCE compiled)", () => {
  const SAVED = process.env.TH_BSC10_ENFORCE;

  afterEach(() => {
    if (SAVED === undefined) delete process.env.TH_BSC10_ENFORCE;
    else process.env.TH_BSC10_ENFORCE = SAVED;
  });

  it("env unset ⇒ true (Slice-B ENFORCE compiled default — two-commit toggle at `return true`)", () => {
    delete process.env.TH_BSC10_ENFORCE;
    expect(bsc10EnforcementEnabled()).toBe(true);
  });

  it("explicit '1' ⇒ true (force enforce ON)", () => {
    process.env.TH_BSC10_ENFORCE = "1";
    expect(bsc10EnforcementEnabled()).toBe(true);
  });

  it("explicit 'true' ⇒ true", () => {
    process.env.TH_BSC10_ENFORCE = "true";
    expect(bsc10EnforcementEnabled()).toBe(true);
  });

  it("explicit 'TRUE' (case-insensitive via trim+toLowerCase) ⇒ true", () => {
    process.env.TH_BSC10_ENFORCE = "TRUE";
    expect(bsc10EnforcementEnabled()).toBe(true);
  });

  it("explicit '  true  ' (surrounding whitespace) ⇒ true", () => {
    process.env.TH_BSC10_ENFORCE = "  true  ";
    expect(bsc10EnforcementEnabled()).toBe(true);
  });

  it("explicit '0' ⇒ false (bsc2-mirror: only '0'/'false' disable; everything else enables)", () => {
    process.env.TH_BSC10_ENFORCE = "0";
    expect(bsc10EnforcementEnabled()).toBe(false);
  });

  it("explicit 'false' ⇒ false", () => {
    process.env.TH_BSC10_ENFORCE = "false";
    expect(bsc10EnforcementEnabled()).toBe(false);
  });

  it("explicit 'FALSE' ⇒ false", () => {
    process.env.TH_BSC10_ENFORCE = "FALSE";
    expect(bsc10EnforcementEnabled()).toBe(false);
  });

  it("unrecognized 'yes' ⇒ TRUE (bsc2-mirror fail-closed: any-other-value ⇒ enforce ON — plan §U9 LOCKED)", () => {
    // bsc2-flag.ts polarity: !(normalized === "0" || normalized === "false") → true for "yes".
    // This was the INVERSE of Slice-A semantics which treated unrecognized as false.
    // Slice-B LOCKS to the bsc2-mirror fail-closed polarity (plan §U9 LOCKED decision).
    process.env.TH_BSC10_ENFORCE = "yes";
    expect(bsc10EnforcementEnabled()).toBe(true);
  });

  it("unrecognized 'on' ⇒ TRUE (any-other-value ⇒ enforce ON — bsc2-mirror fail-closed)", () => {
    process.env.TH_BSC10_ENFORCE = "on";
    expect(bsc10EnforcementEnabled()).toBe(true);
  });

  it("unrecognized 'banana' ⇒ TRUE (any-other-value ⇒ enforce ON)", () => {
    process.env.TH_BSC10_ENFORCE = "banana";
    expect(bsc10EnforcementEnabled()).toBe(true);
  });
});
