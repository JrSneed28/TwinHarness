/**
 * T2 — context-ledger.ts audit tests (D-09).
 *
 * Covers:
 *  - verifyLedgerChain returns { ok:true } for an intact chain.
 *  - verifyLedgerChain returns { ok:false, reason:"edited" } when a record's
 *    content is tampered after appending (recordHash no longer matches).
 *  - verifyLedgerChain returns { ok:false, reason:"prev_mismatch" } when the
 *    chain is forked (two records share the same prevHash, signaling a
 *    concurrent-writer fork).
 *  - verifyLedgerChain returns { ok:true } for an empty chain.
 *  - AUDIT-ONLY contract: verifyLedgerChain does NOT run on the live read path.
 *    readShardRecords is tolerant and never throws, even when the chain is broken.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import { makeTempProject, type TempProject } from "./helpers";
import {
  appendLedgerRecord,
  readShardRecords,
  verifyLedgerChain,
  ledgerShardPath,
  computeLedgerRecordHash,
  type LedgerRecord,
  type LedgerScope,
} from "../src/core/context-ledger";
import { GENESIS_PREV_HASH } from "../src/core/hash";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const TEST_SCOPE: LedgerScope = { session_id: "sess-audit", agentOrRoot: "agent-a" };

function makeRec(
  overrides: Partial<Omit<LedgerRecord, "prevHash" | "recordHash">> = {},
): Omit<LedgerRecord, "prevHash" | "recordHash"> {
  return {
    seq: 0,
    ts: "2026-01-01T00:00:00.000Z",
    session_id: TEST_SCOPE.session_id,
    agent_id: "agent-a",
    agent_type: "claude",
    epoch: 1,
    op: "deliver",
    page_id: "aabbcc001122",
    logical_key: "src/foo.ts",
    content_hash: "a".repeat(64),
    complete: true,
    est_tokens: 10,
    reduction_kind: "full",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let tp: TempProject | undefined;
afterEach(() => {
  tp?.cleanup();
  tp = undefined;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("context-ledger — verifyLedgerChain (audit-only)", () => {
  it("returns { ok:true } for an empty chain", () => {
    expect(verifyLedgerChain([])).toEqual({ ok: true });
  });

  it("returns { ok:true } for a single valid record", () => {
    tp = makeTempProject();
    const r0 = appendLedgerRecord(tp.paths, TEST_SCOPE, makeRec({ seq: 0 }));
    expect(verifyLedgerChain([r0])).toEqual({ ok: true });
  });

  it("returns { ok:true } for a valid multi-record chain", () => {
    tp = makeTempProject();
    const r0 = appendLedgerRecord(tp.paths, TEST_SCOPE, makeRec({ seq: 0 }));
    const r1 = appendLedgerRecord(tp.paths, TEST_SCOPE, makeRec({ seq: 1 }));
    const r2 = appendLedgerRecord(tp.paths, TEST_SCOPE, makeRec({ seq: 2 }));
    const records = readShardRecords(tp.paths, TEST_SCOPE);
    expect(records).toHaveLength(3);
    expect(verifyLedgerChain(records)).toEqual({ ok: true });
    // Sanity: chain fields are linked
    expect(r1.prevHash).toBe(r0.recordHash);
    expect(r2.prevHash).toBe(r1.recordHash);
  });

  it("returns { ok:false, reason:'edited' } when a record's field is tampered", () => {
    tp = makeTempProject();
    const r0 = appendLedgerRecord(tp.paths, TEST_SCOPE, makeRec({ seq: 0 }));
    const r1 = appendLedgerRecord(tp.paths, TEST_SCOPE, makeRec({ seq: 1 }));

    // Tamper: mutate a field in r0 without updating its recordHash
    const tampered: LedgerRecord = { ...r0, logical_key: "TAMPERED" };

    const result = verifyLedgerChain([tampered, r1]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.brokenAt).toBe(0);
      expect(result.reason).toBe("edited");
    }
  });

  it("returns { ok:false, reason:'edited' } at the correct index when a later record is tampered", () => {
    tp = makeTempProject();
    const r0 = appendLedgerRecord(tp.paths, TEST_SCOPE, makeRec({ seq: 0 }));
    const r1 = appendLedgerRecord(tp.paths, TEST_SCOPE, makeRec({ seq: 1 }));
    const r2 = appendLedgerRecord(tp.paths, TEST_SCOPE, makeRec({ seq: 2 }));

    // Tamper r2 only
    const tampered2: LedgerRecord = { ...r2, est_tokens: 9999 };

    const result = verifyLedgerChain([r0, r1, tampered2]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.brokenAt).toBe(2);
      expect(result.reason).toBe("edited");
    }
  });

  it("returns { ok:false, reason:'prev_mismatch' } for a forked chain", () => {
    tp = makeTempProject();
    // Build a forked scenario: two records both have prevHash = GENESIS
    const body0: Omit<LedgerRecord, "recordHash"> = {
      ...makeRec({ seq: 0 }),
      prevHash: GENESIS_PREV_HASH,
    };
    const r0: LedgerRecord = { ...body0, recordHash: computeLedgerRecordHash(body0) };

    const body1: Omit<LedgerRecord, "recordHash"> = {
      ...makeRec({ seq: 1, page_id: "bbccdd001122" }),
      prevHash: GENESIS_PREV_HASH, // fork: same prevHash as r0
    };
    const r1: LedgerRecord = { ...body1, recordHash: computeLedgerRecordHash(body1) };

    const result = verifyLedgerChain([r0, r1]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.brokenAt).toBe(1);
      expect(result.reason).toBe("prev_mismatch");
    }
  });

  it("stops at the FIRST broken link and does not continue", () => {
    tp = makeTempProject();
    const r0 = appendLedgerRecord(tp.paths, TEST_SCOPE, makeRec({ seq: 0 }));
    const r1 = appendLedgerRecord(tp.paths, TEST_SCOPE, makeRec({ seq: 1 }));
    const r2 = appendLedgerRecord(tp.paths, TEST_SCOPE, makeRec({ seq: 2 }));

    // Tamper r1 (index 1) — r2 is also now broken (prevHash points to unmodified r1)
    const tampered1: LedgerRecord = { ...r1, seq: 999 };

    const result = verifyLedgerChain([r0, tampered1, r2]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.brokenAt).toBe(1); // stops at first break
      expect(result.reason).toBe("edited");
    }
  });

  // AUDIT-ONLY contract: the live read path (readShardRecords) must never throw
  // even when the shard contains a broken chain or forked records.
  it("live read path never throws on a shard with a forked chain", () => {
    tp = makeTempProject();

    appendLedgerRecord(tp.paths, TEST_SCOPE, makeRec({ seq: 0 }));
    // Manually inject a forked record (same prevHash as the first record)
    const forked: Omit<LedgerRecord, "recordHash"> = {
      ...makeRec({ seq: 1, page_id: "fork001122334" }),
      prevHash: GENESIS_PREV_HASH,
    };
    const forkedSealed: LedgerRecord = { ...forked, recordHash: computeLedgerRecordHash(forked) };
    const shardFile = ledgerShardPath(tp.paths, TEST_SCOPE);
    fs.appendFileSync(shardFile, JSON.stringify(forkedSealed) + "\n", "utf8");

    // readShardRecords is the LIVE reader — it must NOT throw regardless of chain state
    let records!: LedgerRecord[];
    expect(() => {
      records = readShardRecords(tp.paths, TEST_SCOPE);
    }).not.toThrow();

    // Both records are returned (tolerant; chain check is audit-only)
    expect(records).toHaveLength(2);

    // The audit walk DOES flag the fork, confirming verifyLedgerChain is separate
    const auditResult = verifyLedgerChain(records);
    expect(auditResult.ok).toBe(false);
  });

  it("live read path never throws on a shard with a tampered record", () => {
    tp = makeTempProject();
    const r0 = appendLedgerRecord(tp.paths, TEST_SCOPE, makeRec({ seq: 0 }));

    // Overwrite the shard with a tampered version of r0
    const tampered: LedgerRecord = { ...r0, logical_key: "TAMPERED_KEY" };
    const shardFile = ledgerShardPath(tp.paths, TEST_SCOPE);
    fs.writeFileSync(shardFile, JSON.stringify(tampered) + "\n", "utf8");

    // readShardRecords (tolerant, shape-only) returns the tampered record without throwing
    let records!: LedgerRecord[];
    expect(() => {
      records = readShardRecords(tp.paths, TEST_SCOPE);
    }).not.toThrow();
    expect(records).toHaveLength(1);

    // verifyLedgerChain catches the tamper (audit-only)
    const auditResult = verifyLedgerChain(records);
    expect(auditResult.ok).toBe(false);
    if (!auditResult.ok) {
      expect(auditResult.reason).toBe("edited");
    }
  });
});
