/**
 * T2 — context-ledger.ts shard append tests (D-09).
 *
 * Covers:
 *  - Basic append writes a sealed, hash-chained record.
 *  - Sequential appends form a valid linked chain (prevHash of N+1 = recordHash of N).
 *  - Forked prevHash (simulated parallel append): both records land in the shard;
 *    readShardRecords returns them all without throwing (tolerant reader).
 *  - Unparseable / partial-tail line is skipped; reader never throws; the parseable
 *    records before and after it are still returned.
 *  - Missing shard → readShardRecords returns [] and readLastShardRecordHash returns
 *    GENESIS_PREV_HASH.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import {
  appendLedgerRecord,
  readShardRecords,
  readLastShardRecordHash,
  ledgerShardPath,
  computeLedgerRecordHash,
  type LedgerRecord,
  type LedgerScope,
} from "../src/core/context-ledger";
import { GENESIS_PREV_HASH } from "../src/core/hash";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const TEST_SCOPE: LedgerScope = { session_id: "sess-abc", agentOrRoot: "agent-1" };

/** Build a minimal valid record body (all fields except prevHash + recordHash). */
function makeRec(
  overrides: Partial<Omit<LedgerRecord, "prevHash" | "recordHash">> = {},
): Omit<LedgerRecord, "prevHash" | "recordHash"> {
  return {
    seq: 0,
    ts: new Date().toISOString(),
    session_id: TEST_SCOPE.session_id,
    agent_id: "agent-1",
    agent_type: "claude",
    epoch: 1,
    op: "deliver",
    page_id: "aabbcc001122",
    logical_key: "path/to/file.ts",
    content_hash: "a".repeat(64),
    complete: true,
    est_tokens: 42,
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

describe("context-ledger — shard append", () => {
  it("appends a sealed record with correct recordHash and GENESIS prevHash on first write", () => {
    tp = makeTempProject();
    const rec = makeRec({ seq: 0 });

    const sealed = appendLedgerRecord(tp.paths, TEST_SCOPE, rec);

    expect(sealed.prevHash).toBe(GENESIS_PREV_HASH);
    // recordHash must match the canonical hash of the record without recordHash
    const { recordHash, ...rest } = sealed;
    expect(recordHash).toBe(computeLedgerRecordHash(rest));
    // The shard file must exist and contain the record
    const shardFile = ledgerShardPath(tp.paths, TEST_SCOPE);
    expect(fs.existsSync(shardFile)).toBe(true);
    const lines = fs.readFileSync(shardFile, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual(sealed);
  });

  it("sequential appends form a linked hash chain", () => {
    tp = makeTempProject();

    const r0 = appendLedgerRecord(tp.paths, TEST_SCOPE, makeRec({ seq: 0 }));
    const r1 = appendLedgerRecord(tp.paths, TEST_SCOPE, makeRec({ seq: 1 }));
    const r2 = appendLedgerRecord(tp.paths, TEST_SCOPE, makeRec({ seq: 2 }));

    // Chain: GENESIS → r0 → r1 → r2
    expect(r0.prevHash).toBe(GENESIS_PREV_HASH);
    expect(r1.prevHash).toBe(r0.recordHash);
    expect(r2.prevHash).toBe(r1.recordHash);

    // readShardRecords returns all three in order
    const records = readShardRecords(tp.paths, TEST_SCOPE);
    expect(records).toHaveLength(3);
    expect(records[0]).toEqual(r0);
    expect(records[1]).toEqual(r1);
    expect(records[2]).toEqual(r2);
  });

  it("readLastShardRecordHash returns GENESIS_PREV_HASH for a missing shard", () => {
    tp = makeTempProject();
    const hash = readLastShardRecordHash(tp.paths, TEST_SCOPE);
    expect(hash).toBe(GENESIS_PREV_HASH);
  });

  it("readShardRecords returns [] for a missing shard", () => {
    tp = makeTempProject();
    const records = readShardRecords(tp.paths, TEST_SCOPE);
    expect(records).toEqual([]);
  });

  it("forked prevHash (simulated parallel append) is tolerated by the reader", () => {
    // Simulate two concurrent writers both reading GENESIS_PREV_HASH as their
    // prevHash seed and appending independently. Both records land in the shard
    // (neither is dropped). The tolerant reader returns both without throwing.
    tp = makeTempProject();

    const r0 = appendLedgerRecord(tp.paths, TEST_SCOPE, makeRec({ seq: 0 }));
    // Simulate a second writer that forked: it also read GENESIS as prevHash.
    // We replicate this by manually writing a record with prevHash = GENESIS.
    const forkedRec: Omit<LedgerRecord, "prevHash" | "recordHash"> = makeRec({ seq: 1, page_id: "bbccdd002233" });
    const forkedWithPrev: Omit<LedgerRecord, "recordHash"> = { ...forkedRec, prevHash: GENESIS_PREV_HASH };
    const forkedSealed: LedgerRecord = {
      ...forkedWithPrev,
      recordHash: computeLedgerRecordHash(forkedWithPrev),
    };
    const shardFile = ledgerShardPath(tp.paths, TEST_SCOPE);
    fs.appendFileSync(shardFile, JSON.stringify(forkedSealed) + "\n", "utf8");

    // Reader must return both records without throwing (tolerant — chain not checked)
    let records!: LedgerRecord[];
    expect(() => {
      records = readShardRecords(tp.paths, TEST_SCOPE);
    }).not.toThrow();
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual(r0);
    expect(records[1]).toEqual(forkedSealed);
  });

  it("unparseable line is skipped — reader never throws, surrounding records are returned", () => {
    tp = makeTempProject();

    const r0 = appendLedgerRecord(tp.paths, TEST_SCOPE, makeRec({ seq: 0 }));
    // Inject a corrupted / partial-tail line between two valid records
    const shardFile = ledgerShardPath(tp.paths, TEST_SCOPE);
    fs.appendFileSync(shardFile, "NOT VALID JSON {{{{\n", "utf8");
    const r2 = appendLedgerRecord(tp.paths, TEST_SCOPE, makeRec({ seq: 2 }));

    let records!: LedgerRecord[];
    expect(() => {
      records = readShardRecords(tp.paths, TEST_SCOPE);
    }).not.toThrow();

    // The bad line is silently skipped; the two valid records are present
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual(r0);
    expect(records[1]).toEqual(r2);
  });

  it("schema-invalid JSON line (valid JSON but bad shape) is skipped", () => {
    tp = makeTempProject();

    appendLedgerRecord(tp.paths, TEST_SCOPE, makeRec({ seq: 0 }));
    const shardFile = ledgerShardPath(tp.paths, TEST_SCOPE);
    // Valid JSON but missing required fields
    fs.appendFileSync(shardFile, JSON.stringify({ op: "deliver" }) + "\n", "utf8");
    appendLedgerRecord(tp.paths, TEST_SCOPE, makeRec({ seq: 2 }));

    const records = readShardRecords(tp.paths, TEST_SCOPE);
    expect(records).toHaveLength(2);
    // The middle schema-invalid line was skipped
    expect(records[0]!.seq).toBe(0);
    expect(records[1]!.seq).toBe(2);
  });

  it("different scopes write to separate shards", () => {
    tp = makeTempProject();
    const scope2: LedgerScope = { session_id: "sess-abc", agentOrRoot: "agent-2" };

    appendLedgerRecord(tp.paths, TEST_SCOPE, makeRec({ seq: 0 }));
    appendLedgerRecord(tp.paths, scope2, makeRec({ seq: 0, agent_id: "agent-2" }));

    const shard1 = ledgerShardPath(tp.paths, TEST_SCOPE);
    const shard2 = ledgerShardPath(tp.paths, scope2);
    expect(shard1).not.toBe(shard2);
    expect(readShardRecords(tp.paths, TEST_SCOPE)).toHaveLength(1);
    expect(readShardRecords(tp.paths, scope2)).toHaveLength(1);
  });
});
