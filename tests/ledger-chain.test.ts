/**
 * Gate-ledger tamper-evidence / hash chain (GOV-2, P3-1b) — REQ-anchored.
 *
 * The gate ledger is now SHA-256 hash-chained (mirroring `decisions.jsonl`): each
 * appended entry seals a `recordHash` over its own canonical content plus the
 * prior sealed entry's `recordHash`. These tests pin that:
 *   - appending seals a verifiable chain (each recordHash + prevHash matches);
 *   - editing/backdating, deleting, or reordering a SEALED entry is detected;
 *   - a LEGACY (pre-migration, unsealed) prefix is NOT a tamper signal, while the
 *     sealed run that follows is still fully verified (back-compat round-trip);
 *   - the canonical hash is deterministic and payload-key-order independent;
 *   - the append path stays best-effort (never throws on an unwritable stateDir).
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import {
  appendLedger,
  readLedger,
  ledgerPath,
  verifyLedgerChain,
  computeLedgerRecordHash,
  GENESIS_PREV_HASH,
  type LedgerEntry,
} from "../src/core/ledger";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

/** Read the raw JSONL lines (so a test can tamper at the byte level). */
function rawLines(t: TempProject): string[] {
  return fs.readFileSync(ledgerPath(t.paths), "utf8").split(/\r?\n/).filter((l) => l.trim());
}

/** Overwrite the ledger file from a list of entries (one JSON object per line). */
function writeLines(t: TempProject, entries: unknown[]): void {
  fs.mkdirSync(t.paths.stateDir, { recursive: true });
  fs.writeFileSync(ledgerPath(t.paths), entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
}

const HEX64 = /^[0-9a-f]{64}$/;

describe("REQ-LEDGER-CHAIN-001: appending seals a verifiable hash chain", () => {
  it("each entry carries recordHash = computeLedgerRecordHash and chains by prevHash", () => {
    tp = makeTempProject();
    appendLedger(tp.paths, { event: "gate-state-change", key: "write_gate", value: "deny" });
    appendLedger(tp.paths, { event: "gate-state-change", key: "implementation_allowed", value: true });
    appendLedger(tp.paths, { event: "drift-blocking-opened", id: "DRIFT-1" });

    const entries = readLedger(tp.paths);
    expect(entries).toHaveLength(3);

    // First sealed entry anchors to GENESIS.
    expect(entries[0]!.prevHash).toBe(GENESIS_PREV_HASH);

    let expectedPrev = GENESIS_PREV_HASH;
    for (const e of entries) {
      expect(e.recordHash).toMatch(HEX64);
      expect(e.prevHash).toBe(expectedPrev);
      // recordHash is the canonical-text hash of the entry WITHOUT recordHash.
      const { recordHash, ...rest } = e;
      expect(computeLedgerRecordHash(rest)).toBe(recordHash);
      expectedPrev = recordHash!;
    }

    expect(verifyLedgerChain(entries)).toEqual({ ok: true });
  });
});

describe("REQ-LEDGER-CHAIN-002: tampering with a sealed entry is detected", () => {
  it('edits to a sealed field are caught ("edited")', () => {
    tp = makeTempProject();
    appendLedger(tp.paths, { event: "gate-state-change", key: "write_gate", value: "deny" });
    appendLedger(tp.paths, { event: "gate-state-change", key: "write_gate", value: "off" });

    const entries = readLedger(tp.paths);
    // Forge the value of the first entry WITHOUT recomputing its recordHash.
    entries[0]!.value = "off";
    writeLines(tp, entries);

    const res = verifyLedgerChain(readLedger(tp.paths));
    expect(res).toEqual({ ok: false, brokenAt: 0, reason: "edited" });
  });

  it('backdating ts on a sealed entry is caught ("edited" — ts is sealed content)', () => {
    tp = makeTempProject();
    appendLedger(tp.paths, { event: "gate-state-change", key: "tier", value: 2 });

    const entries = readLedger(tp.paths);
    entries[0]!.ts = "2000-01-01T00:00:00.000Z"; // backdate without re-sealing
    writeLines(tp, entries);

    const res = verifyLedgerChain(readLedger(tp.paths));
    expect(res).toEqual({ ok: false, brokenAt: 0, reason: "edited" });
  });

  it('deleting a sealed line breaks the chain ("prev_mismatch")', () => {
    tp = makeTempProject();
    appendLedger(tp.paths, { event: "e1" });
    appendLedger(tp.paths, { event: "e2" });
    appendLedger(tp.paths, { event: "e3" });

    const entries = readLedger(tp.paths);
    // Remove the middle (still-valid) line: entry[2]'s prevHash no longer matches.
    const without = [entries[0]!, entries[2]!];
    writeLines(tp, without);

    const res = verifyLedgerChain(readLedger(tp.paths));
    expect(res).toEqual({ ok: false, brokenAt: 1, reason: "prev_mismatch" });
  });

  it('reordering sealed lines breaks the chain ("prev_mismatch")', () => {
    tp = makeTempProject();
    appendLedger(tp.paths, { event: "e1" });
    appendLedger(tp.paths, { event: "e2" });

    const entries = readLedger(tp.paths);
    writeLines(tp, [entries[1]!, entries[0]!]); // swap order; hashes intact, prevHash wrong

    const res = verifyLedgerChain(readLedger(tp.paths));
    expect(res).toEqual({ ok: false, brokenAt: 0, reason: "prev_mismatch" });
  });
});

describe("REQ-LEDGER-CHAIN-003: back-compat round-trip (legacy prefix + sealed run)", () => {
  it("readLedger reads legacy+sealed; verifyLedgerChain treats the legacy prefix as non-tamper", () => {
    tp = makeTempProject();
    // Two LEGACY (pre-migration) lines: no prevHash, no recordHash — exactly what
    // an existing ledger written before P3-1b looks like.
    const legacy: LedgerEntry[] = [
      { ts: "2020-01-01T00:00:00.000Z", event: "gate-state-change", key: "tier", value: 1 },
      { ts: "2020-01-02T00:00:00.000Z", event: "drift-blocking-opened", id: "DRIFT-OLD" },
    ];
    writeLines(tp, legacy);

    // Now append NEW (sealed) entries onto the legacy ledger — the migration path.
    appendLedger(tp.paths, { event: "gate-state-change", key: "write_gate", value: "deny" });
    appendLedger(tp.paths, { event: "gate-state-change", key: "implementation_allowed", value: true });

    const entries = readLedger(tp.paths);
    expect(entries).toHaveLength(4); // all lines read, legacy + sealed

    // The legacy prefix is unsealed and is NOT a tamper signal; the sealed run
    // that follows is verified and anchored to GENESIS.
    expect(entries[2]!.prevHash).toBe(GENESIS_PREV_HASH);
    expect(entries[2]!.recordHash).toMatch(HEX64);
    expect(verifyLedgerChain(entries)).toEqual({ ok: true });
  });

  it("the first NEW append onto a legacy-only ledger anchors to GENESIS", () => {
    tp = makeTempProject();
    writeLines(tp, [{ ts: "2020-01-01T00:00:00.000Z", event: "legacy-only" }]);
    appendLedger(tp.paths, { event: "first-sealed" });

    const entries = readLedger(tp.paths);
    const sealed = entries.find((e) => e.event === "first-sealed")!;
    expect(sealed.prevHash).toBe(GENESIS_PREV_HASH);
    expect(verifyLedgerChain(entries)).toEqual({ ok: true });
  });

  it("tampering a sealed entry that follows a legacy prefix is STILL caught", () => {
    tp = makeTempProject();
    writeLines(tp, [{ ts: "2020-01-01T00:00:00.000Z", event: "legacy" }]);
    appendLedger(tp.paths, { event: "gate-state-change", key: "write_gate", value: "deny" });
    appendLedger(tp.paths, { event: "gate-state-change", key: "write_gate", value: "off" });

    const entries = readLedger(tp.paths);
    // Index 1 is the first SEALED entry (after the legacy line at index 0).
    entries[1]!.value = "strict"; // forge a sealed field
    writeLines(tp, entries);

    const res = verifyLedgerChain(readLedger(tp.paths));
    expect(res).toEqual({ ok: false, brokenAt: 1, reason: "edited" });
  });

  it("KNOWN LIMIT (SECURITY.md honest-limit 3): deleting the ENTIRE sealed run (revert to legacy-only) is NOT detected", () => {
    tp = makeTempProject();
    writeLines(tp, [{ ts: "2020-01-01T00:00:00.000Z", event: "legacy" }]);
    appendLedger(tp.paths, { event: "gate-state-change", key: "write_gate", value: "deny" });
    appendLedger(tp.paths, { event: "gate-state-change", key: "implementation_allowed", value: true });

    // An actor with write access truncates the file back to the legacy line,
    // erasing the whole sealed run. No sealed entry remains and there is no
    // expected count to compare against, so verification cannot distinguish this
    // from a never-sealed ledger — documented as honest limit (3) in SECURITY.md.
    writeLines(tp, [{ ts: "2020-01-01T00:00:00.000Z", event: "legacy" }]);
    expect(verifyLedgerChain(readLedger(tp.paths))).toEqual({ ok: true });
  });
});

describe("REQ-LEDGER-CHAIN-004: canonical hash is deterministic + key-order independent", () => {
  it("the same logical entry yields the same hash regardless of payload key order", () => {
    const a: Omit<LedgerEntry, "recordHash"> = {
      ts: "2026-06-16T00:00:00.000Z",
      event: "gate-state-change",
      key: "write_gate",
      value: "deny",
      prevHash: GENESIS_PREV_HASH,
    };
    // Same fields, different insertion order.
    const b: Omit<LedgerEntry, "recordHash"> = {
      value: "deny",
      prevHash: GENESIS_PREV_HASH,
      key: "write_gate",
      event: "gate-state-change",
      ts: "2026-06-16T00:00:00.000Z",
    };
    const h = computeLedgerRecordHash(a);
    expect(h).toMatch(HEX64);
    expect(computeLedgerRecordHash(b)).toBe(h);
    // A different value changes the hash (the seal is content-sensitive).
    expect(computeLedgerRecordHash({ ...a, value: "off" })).not.toBe(h);
  });

  it("recordHash is excluded from its own canonical input", () => {
    const base: Omit<LedgerEntry, "recordHash"> = {
      ts: "2026-06-16T00:00:00.000Z",
      event: "e",
      prevHash: GENESIS_PREV_HASH,
    };
    const h = computeLedgerRecordHash(base);
    // Passing a recordHash in must not change the computed hash.
    expect(computeLedgerRecordHash({ ...base, recordHash: "deadbeef".repeat(8) } as Omit<LedgerEntry, "recordHash">)).toBe(h);
  });
});

describe("REQ-LEDGER-CHAIN-005: append stays best-effort", () => {
  it("never throws when the stateDir is unwritable (audit path swallows errors)", () => {
    tp = makeTempProject();
    const blocker = path.join(tp.root, "blocker");
    fs.writeFileSync(blocker, "x"); // a FILE where a dir is expected → mkdir/append fail
    const bogus = { ...tp.paths, stateDir: blocker };
    expect(() => appendLedger(bogus, { event: "boom", key: "tier", value: 3 })).not.toThrow();
  });
});
