/**
 * ARCH-004 — canonical-serialize byte-stability round-trip (P3-3).
 *
 * Three hand-maintained canonical orderings silently gate content-hash stability
 * (spec §18, pre-mortem #1): if any of them reorders a field, changes indentation,
 * or stops omitting an undefined optional, every existing state file / decision
 * hash-chain / lease ledger changes bytes and breaks. These tests are the
 * anti-regression backstop: they pin the EXACT serialized bytes for representative
 * inputs and assert the three invariants that keep them stable —
 *   1. fields appear in the fixed canonical order regardless of input key order,
 *   2. undefined optional fields are omitted, and
 *   3. indentation / newline / link-sort discipline is preserved.
 *
 * Reordering any field in STATE_FIELD_ORDER / CANONICAL_FIELD_ORDER /
 * LEASE_FIELD_ORDER, or changing the indent, MUST make a test here FAIL.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import {
  serializeState,
  STATE_FIELD_ORDER,
  type TwinHarnessState,
} from "../src/core/state-schema";
import {
  canonicalText,
  computeRecordHash,
  GENESIS_PREV_HASH,
  type DecisionEvent,
} from "../src/core/decisions";
import {
  serializeLeaseEvent,
  appendLeaseEvent,
  readLeaseEvents,
  leasesPath,
  LEASE_FIELD_ORDER,
  type LeaseEvent,
} from "../src/core/leases";
import { makeTempProject, type TempProject } from "./helpers";

let tp: TempProject | undefined;
afterEach(() => {
  tp?.cleanup();
  tp = undefined;
});

// ---------------------------------------------------------------------------
// 1. serializeState (state.json) — STATE_FIELD_ORDER, indent-2, trailing \n
// ---------------------------------------------------------------------------

describe("ARCH-004: serializeState byte-stability", () => {
  /**
   * A fully-populated state with EVERY optional field present, constructed with
   * keys in a DELIBERATELY scrambled order so the test proves the serializer
   * imposes canonical order rather than echoing insertion order.
   */
  function fullStateScrambled(): TwinHarnessState {
    return {
      interview_required: true,
      has_ui: false,
      delivery_mode: "no-code",
      interview_threshold: 0.2,
      project_mode: "brownfield",
      write_gate: "deny",
      revise_loop_counts: { "STAGE-A": 2 },
      debate_open_blocking: 1,
      drift_open_blocking: 0,
      open_questions: ["q1"],
      implementation_allowed: true,
      slices: [{ id: "SLICE-1", status: "pending", components: ["api"] }],
      summaries_index: "00-project-summary.md",
      approved_artifacts: [{ file: "docs/x.md", version: 1, hash: "abc" }],
      current_stage: "build",
      blast_radius_flags: ["money"],
      complexity_rationale: "rationale",
      tier: "T1",
      schema_version: 1,
    } as TwinHarnessState;
  }

  /** The EXACT canonical bytes for fullStateScrambled() — pinned (indent-2, \n). */
  const FULL_STATE_PINNED =
    `{
  "schema_version": 1,
  "tier": "T1",
  "complexity_rationale": "rationale",
  "blast_radius_flags": [
    "money"
  ],
  "current_stage": "build",
  "approved_artifacts": [
    {
      "file": "docs/x.md",
      "version": 1,
      "hash": "abc"
    }
  ],
  "summaries_index": "00-project-summary.md",
  "slices": [
    {
      "id": "SLICE-1",
      "status": "pending",
      "components": [
        "api"
      ]
    }
  ],
  "implementation_allowed": true,
  "open_questions": [
    "q1"
  ],
  "drift_open_blocking": 0,
  "debate_open_blocking": 1,
  "revise_loop_counts": {
    "STAGE-A": 2
  },
  "write_gate": "deny",
  "project_mode": "brownfield",
  "interview_threshold": 0.2,
  "delivery_mode": "no-code",
  "has_ui": false,
  "interview_required": true
}
`;

  it("serializes a fully-populated state to the EXACT canonical bytes regardless of input key order", () => {
    expect(serializeState(fullStateScrambled())).toBe(FULL_STATE_PINNED);
  });

  it("places keys in STATE_FIELD_ORDER even though the input keys are scrambled", () => {
    const keys = Object.keys(JSON.parse(serializeState(fullStateScrambled())));
    expect(keys).toEqual(STATE_FIELD_ORDER as string[]);
  });

  it("omits every undefined optional field (hash-stability for legacy files)", () => {
    // Only the required fields set; all four optionals (schema_version,
    // debate_open_blocking, write_gate, project_mode) absent.
    const minimal: TwinHarnessState = {
      tier: null,
      complexity_rationale: "",
      blast_radius_flags: [],
      current_stage: "init",
      approved_artifacts: [],
      summaries_index: "00-project-summary.md",
      slices: [],
      implementation_allowed: false,
      open_questions: [],
      drift_open_blocking: 0,
      revise_loop_counts: {},
    };
    const out = serializeState(minimal);
    const keys = Object.keys(JSON.parse(out));
    expect(keys).not.toContain("schema_version");
    expect(keys).not.toContain("debate_open_blocking");
    expect(keys).not.toContain("write_gate");
    expect(keys).not.toContain("project_mode");
    expect(keys).not.toContain("interview_threshold");
    expect(keys).not.toContain("delivery_mode");
    expect(keys).not.toContain("has_ui");
    expect(keys).not.toContain("interview_required");
    // Required fields, in canonical order, no optionals interleaved.
    expect(keys).toEqual(
      (STATE_FIELD_ORDER as string[]).filter(
        (k) =>
          ![
            "schema_version",
            "debate_open_blocking",
            "write_gate",
            "project_mode",
            "interview_threshold",
            "delivery_mode",
            "has_ui",
            "interview_required",
          ].includes(k),
      ),
    );
  });

  it("uses indent-2 and a single trailing newline", () => {
    const out = serializeState(fullStateScrambled());
    expect(out.endsWith("\n")).toBe(true);
    expect(out.endsWith("\n\n")).toBe(false);
    // indent-2: nested keys are prefixed with exactly two spaces of indent per level.
    expect(out).toContain('\n  "tier": "T1"');
    expect(out).not.toContain('\n   "tier"'); // not 3-space
    expect(out).not.toContain('\n "tier"'); // not 1-space
  });

  it("round-trips: JSON.parse(serializeState(s)) deep-equals the defined fields", () => {
    const s = fullStateScrambled();
    expect(JSON.parse(serializeState(s))).toEqual(s);
  });
});

// ---------------------------------------------------------------------------
// 2. canonicalText / computeRecordHash (decisions hash-chain) — links sorted,
//    no indent, recordHash excluded, undefined optionals omitted.
// ---------------------------------------------------------------------------

describe("ARCH-004: decisions canonicalText byte-stability (hash-chain pin)", () => {
  it("sorts links lexicographically regardless of input order, with EXACT bytes", () => {
    const ev: Omit<DecisionEvent, "recordHash"> = {
      // keys deliberately scrambled + links deliberately unsorted
      prevHash: GENESIS_PREV_HASH,
      proposedAt: "2026-06-15T00:00:00.000Z",
      proposer: "orchestrator",
      links: ["zeta", "alpha", "mid"],
      rationale: "r",
      title: "t",
      event: "proposed",
      id: "DECISION-001",
    };
    expect(canonicalText(ev)).toBe(
      '{"id":"DECISION-001","event":"proposed","title":"t","rationale":"r",' +
        '"links":["alpha","mid","zeta"],"proposer":"orchestrator",' +
        '"proposedAt":"2026-06-15T00:00:00.000Z",' +
        '"prevHash":"0000000000000000000000000000000000000000000000000000000000000000"}',
    );
  });

  it("yields the SAME hash for two events differing only in links order or key insertion order", () => {
    const a: Omit<DecisionEvent, "recordHash"> = {
      id: "DECISION-001",
      event: "proposed",
      title: "t",
      rationale: "r",
      links: ["zeta", "alpha", "mid"],
      proposer: "orchestrator",
      proposedAt: "2026-06-15T00:00:00.000Z",
      prevHash: GENESIS_PREV_HASH,
    };
    // Same content; links pre-sorted and keys re-inserted in a different order.
    const b: Omit<DecisionEvent, "recordHash"> = {
      prevHash: GENESIS_PREV_HASH,
      links: ["alpha", "mid", "zeta"],
      proposedAt: "2026-06-15T00:00:00.000Z",
      proposer: "orchestrator",
      rationale: "r",
      title: "t",
      event: "proposed",
      id: "DECISION-001",
    };
    expect(canonicalText(a)).toBe(canonicalText(b));
    expect(computeRecordHash(a)).toBe(computeRecordHash(b));
  });

  it("does NOT mutate the caller's links array (sorts a copy)", () => {
    const links = ["zeta", "alpha", "mid"];
    canonicalText({
      id: "DECISION-001",
      event: "proposed",
      title: "t",
      rationale: "r",
      links,
      prevHash: GENESIS_PREV_HASH,
    });
    expect(links).toEqual(["zeta", "alpha", "mid"]); // original order preserved
  });

  it("excludes recordHash and omits undefined optional fields, with EXACT bytes", () => {
    // An approval event: title/rationale/links/supersededBy/proposer/proposedAt all absent.
    const ev: Omit<DecisionEvent, "recordHash"> = {
      id: "DECISION-001",
      event: "approved",
      approver: "human",
      approvedAt: "2026-06-15T00:05:00.000Z",
      prevHash: "a".repeat(64),
    };
    const text = canonicalText(ev);
    expect(text).toBe(
      '{"id":"DECISION-001","event":"approved","approver":"human",' +
        '"approvedAt":"2026-06-15T00:05:00.000Z",' +
        '"prevHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}',
    );
    // recordHash must never appear in the canonical text even if present on the object.
    const withRecord = { ...ev, recordHash: "f".repeat(64) } as DecisionEvent;
    expect(canonicalText(withRecord)).toBe(text);
  });

  it("uses NO indentation (single-line JSON)", () => {
    const text = canonicalText({
      id: "DECISION-001",
      event: "proposed",
      title: "t",
      rationale: "r",
      links: [],
      prevHash: GENESIS_PREV_HASH,
    });
    expect(text).not.toContain("\n");
    expect(text).not.toContain("  ");
  });
});

// ---------------------------------------------------------------------------
// 3. serializeLeaseEvent (build-leases.jsonl) — LEASE_FIELD_ORDER, no indent,
//    parent omitted when absent. Proven byte-identical to the historical spread.
// ---------------------------------------------------------------------------

describe("ARCH-004: lease event byte-stability", () => {
  const TS = "2026-06-15T00:00:00.000Z";

  it("serializes a top-level lease (no parent) to the EXACT historical bytes", () => {
    const top: LeaseEvent = { ts: TS, event: "claim", slice: "SLICE-1", components: ["api", "db"] };
    expect(serializeLeaseEvent(top)).toBe(
      '{"ts":"2026-06-15T00:00:00.000Z","event":"claim","slice":"SLICE-1","components":["api","db"]}',
    );
  });

  it("serializes a sub-lease (parent present) with parent LAST", () => {
    const sub: LeaseEvent = {
      ts: TS,
      event: "claim",
      slice: "SLICE-1#sub-1",
      components: ["api"],
      parent: "SLICE-1",
    };
    expect(serializeLeaseEvent(sub)).toBe(
      '{"ts":"2026-06-15T00:00:00.000Z","event":"claim","slice":"SLICE-1#sub-1",' +
        '"components":["api"],"parent":"SLICE-1"}',
    );
  });

  it("is byte-identical whether parent is absent or explicitly undefined (omit-undefined)", () => {
    const absent: LeaseEvent = { ts: TS, event: "release", slice: "SLICE-1", components: [] };
    const undef = { ts: TS, event: "release", slice: "SLICE-1", components: [], parent: undefined } as LeaseEvent;
    const expected = '{"ts":"2026-06-15T00:00:00.000Z","event":"release","slice":"SLICE-1","components":[]}';
    expect(serializeLeaseEvent(absent)).toBe(expected);
    expect(serializeLeaseEvent(undef)).toBe(expected);
  });

  it("imposes LEASE_FIELD_ORDER regardless of input key order", () => {
    // Keys scrambled — output must still be ts, event, slice, components, parent.
    const scrambled = {
      parent: "SLICE-1",
      components: ["api"],
      slice: "SLICE-1#sub-1",
      event: "claim",
      ts: TS,
    } as LeaseEvent;
    expect(Object.keys(JSON.parse(serializeLeaseEvent(scrambled)))).toEqual(
      LEASE_FIELD_ORDER as string[],
    );
    expect(serializeLeaseEvent(scrambled)).toBe(
      '{"ts":"2026-06-15T00:00:00.000Z","event":"claim","slice":"SLICE-1#sub-1",' +
        '"components":["api"],"parent":"SLICE-1"}',
    );
  });

  it("PROVES byte-identity to the historical `{ ts, ...event }` spread for every shape", () => {
    // The exact pre-ARCH-004 serialization, reproduced inline as the oracle.
    const historical = (ts: string, event: Omit<LeaseEvent, "ts">): string =>
      JSON.stringify({ ts, ...event });
    const shapes: Omit<LeaseEvent, "ts">[] = [
      { event: "claim", slice: "SLICE-1", components: ["api", "db"] },
      { event: "release", slice: "SLICE-1", components: [] },
      { event: "claim", slice: "SLICE-1#sub-1", components: ["api"], parent: "SLICE-1" },
      { event: "release", slice: "SLICE-1#sub-1", components: ["api"], parent: "SLICE-1" },
      { event: "claim", slice: "docs/x.md#intro", components: ["holder-1"] }, // section lease
    ];
    for (const ev of shapes) {
      expect(serializeLeaseEvent({ ts: TS, ...ev })).toBe(historical(TS, ev));
    }
  });

  it("appendLeaseEvent writes the canonical line that readLeaseEvents round-trips", () => {
    tp = makeTempProject();
    appendLeaseEvent(
      tp.paths,
      { event: "claim", slice: "SLICE-1", components: ["api", "db"] },
      () => new Date(TS),
    );
    appendLeaseEvent(
      tp.paths,
      { event: "claim", slice: "SLICE-1#sub-1", components: ["api"], parent: "SLICE-1" },
      () => new Date(TS),
    );
    const raw = fs.readFileSync(leasesPath(tp.paths), "utf8");
    expect(raw).toBe(
      '{"ts":"2026-06-15T00:00:00.000Z","event":"claim","slice":"SLICE-1","components":["api","db"]}\n' +
        '{"ts":"2026-06-15T00:00:00.000Z","event":"claim","slice":"SLICE-1#sub-1","components":["api"],"parent":"SLICE-1"}\n',
    );
    const events = readLeaseEvents(tp.paths);
    expect(events).toEqual([
      { ts: TS, event: "claim", slice: "SLICE-1", components: ["api", "db"] },
      { ts: TS, event: "claim", slice: "SLICE-1#sub-1", components: ["api"], parent: "SLICE-1" },
    ]);
  });

  it("uses NO indentation (single-line JSONL)", () => {
    const line = serializeLeaseEvent({ ts: TS, event: "claim", slice: "SLICE-1", components: ["api"] });
    expect(line).not.toContain("\n");
    expect(line).not.toContain("  ");
  });
});
