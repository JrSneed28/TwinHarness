/**
 * #14 — lifting GENESIS_PREV_HASH + HEX64 into core/hash.ts must be a NO-OP for the
 * two hash chains. These goldens snapshot recordHashes computed by the PRE-refactor
 * code (captured against the build at HEAD~ before the lift) and assert the
 * POST-refactor code reproduces them BYTE-IDENTICALLY — the safety net for "no hash
 * drift from moving the shared constants".
 */

import { describe, it, expect } from "vitest";
import { GENESIS_PREV_HASH as HASH_GENESIS, HEX64 } from "../src/core/hash";
import {
  GENESIS_PREV_HASH as LEDGER_GENESIS,
  ledgerCanonicalText,
  computeLedgerRecordHash,
  verifyLedgerChain,
  type LedgerEntry,
} from "../src/core/ledger";
import {
  GENESIS_PREV_HASH as DECISION_GENESIS,
  canonicalText,
  computeRecordHash,
  verifyChain,
  type DecisionEvent,
} from "../src/core/decisions";

// Pre-refactor golden recordHashes (computed from the build BEFORE the const lift).
const LEDGER_GOLDEN = "e6f4228f0ca4d8a4b7abe1835526a8d2837c9131958be43e1b615b4ef94deb21";
const DECISION_GOLDEN = "27a9875764c3c10b6e3551b368f5656892f691b1a2c1b89ff6ccfe16cbc572be";

describe("#14: GENESIS_PREV_HASH + HEX64 are shared via core/hash.ts (one definition, re-exported)", () => {
  it("GENESIS_PREV_HASH is identical across hash / ledger / decisions (64 hex zeros)", () => {
    expect(HASH_GENESIS).toBe("0".repeat(64));
    // The ledger + decision re-exports are the SAME value (back-compat preserved).
    expect(LEDGER_GENESIS).toBe(HASH_GENESIS);
    expect(DECISION_GENESIS).toBe(HASH_GENESIS);
  });

  it("HEX64 matches a 64-hex digest and rejects non-digests", () => {
    expect(HEX64.test("a".repeat(64))).toBe(true);
    expect(HEX64.test("A".repeat(64))).toBe(false); // lowercase only
    expect(HEX64.test("a".repeat(63))).toBe(false);
    expect(HEX64.test("g".repeat(64))).toBe(false);
  });
});

describe("#14: byte-identical golden — the const lift does not perturb either chain", () => {
  it("ledger recordHash for a fixed entry equals the pre-refactor golden", () => {
    const entry: Omit<LedgerEntry, "recordHash"> = {
      ts: "2026-01-01T00:00:00.000Z",
      event: "e1",
      key: "write_gate",
      value: "deny",
      prevHash: LEDGER_GENESIS,
    };
    // Canonical text (sorted keys) is stable, and its hash matches the snapshot.
    expect(ledgerCanonicalText(entry)).toBe(
      '{"event":"e1","key":"write_gate","prevHash":"' + "0".repeat(64) + '","ts":"2026-01-01T00:00:00.000Z","value":"deny"}',
    );
    expect(computeLedgerRecordHash(entry)).toBe(LEDGER_GOLDEN);
  });

  it("decision recordHash for a fixed event equals the pre-refactor golden", () => {
    const event: Omit<DecisionEvent, "recordHash"> = {
      id: "DECISION-001",
      event: "proposed",
      title: "Pick a queue",
      rationale: "bounded",
      links: ["stage:architecture", "REQ-001"],
      proposer: "alice",
      proposedAt: "2026-01-01T00:00:00.000Z",
      prevHash: DECISION_GENESIS,
    };
    expect(computeRecordHash(event)).toBe(DECISION_GOLDEN);
    // links are sorted lexicographically in the canonical text (REQ-001 before stage:…).
    expect(canonicalText(event)).toContain('"links":["REQ-001","stage:architecture"]');
  });

  it("verifyLedgerChain round-trips a 2-entry sealed fixture → ok:true", () => {
    const e1: Omit<LedgerEntry, "recordHash"> = { ts: "2026-01-01T00:00:00.000Z", event: "e1", prevHash: LEDGER_GENESIS };
    const e1h = computeLedgerRecordHash(e1);
    const e2: Omit<LedgerEntry, "recordHash"> = { ts: "2026-01-01T00:00:01.000Z", event: "e2", prevHash: e1h };
    const e2h = computeLedgerRecordHash(e2);
    const chain: LedgerEntry[] = [
      { ...e1, recordHash: e1h },
      { ...e2, recordHash: e2h },
    ];
    expect(verifyLedgerChain(chain)).toEqual({ ok: true });
  });

  it("verifyChain round-trips a 2-event sealed decision fixture → ok:true", () => {
    const d1: Omit<DecisionEvent, "recordHash"> = { id: "DECISION-001", event: "proposed", title: "t", prevHash: DECISION_GENESIS };
    const d1h = computeRecordHash(d1);
    const d2: Omit<DecisionEvent, "recordHash"> = { id: "DECISION-001", event: "approved", approver: "human", prevHash: d1h };
    const d2h = computeRecordHash(d2);
    const chain: DecisionEvent[] = [
      { ...d1, recordHash: d1h },
      { ...d2, recordHash: d2h },
    ];
    expect(verifyChain(chain)).toEqual({ ok: true });
  });
});
