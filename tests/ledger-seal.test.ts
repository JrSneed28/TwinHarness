/**
 * #8 (GOV-2, SECURITY) — opt-in HMAC keyed seal + sealed in-chain high-water anchor
 * for the gate ledger. Mirrors the decision ledger's keyed-seal pattern.
 *
 * The fixture key is an OBVIOUS throwaway constant, NEVER read from the environment
 * (a committed real key would be the leak the threat model warns about).
 */

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import * as fs from "node:fs";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { runDoctor } from "../src/commands/doctor";
import {
  appendLedger,
  appendHighWater,
  readLedger,
  ledgerPath,
  verifyLedgerChain,
  verifyLedgerSeals,
  computeLedgerRecordHash,
  computeLedgerKeyedHash,
  ledgerCanonicalText,
  GENESIS_PREV_HASH,
  type LedgerEntry,
} from "../src/core/ledger";

const KEY = "throwaway-test-ledger-key-not-a-real-secret";

let tp: TempProject | undefined;
let savedKey: string | undefined;
beforeEach(() => {
  savedKey = process.env.TH_LEDGER_KEY;
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.TH_LEDGER_KEY;
  else process.env.TH_LEDGER_KEY = savedKey;
  tp?.cleanup();
  tp = undefined;
});

function writeRaw(t: TempProject, entries: LedgerEntry[]): void {
  fs.mkdirSync(t.paths.stateDir, { recursive: true });
  fs.writeFileSync(ledgerPath(t.paths), entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
}
const checks = (data: unknown): { name: string; status: string; detail: string }[] =>
  (data as { checks: { name: string; status: string; detail: string }[] }).checks;
const byName = (data: unknown, name: string) => checks(data).find((c) => c.name === name);

describe("#8 keyed seal: opt-in via TH_LEDGER_KEY, warn-only verification", () => {
  it("seals each entry when TH_LEDGER_KEY is set; verifyLedgerSeals(key) ok; tampering a sealed field flags a mismatch", () => {
    tp = makeTempProject();
    process.env.TH_LEDGER_KEY = KEY;
    appendLedger(tp.paths, { event: "gate-state-change", key: "write_gate", value: "deny" });
    appendLedger(tp.paths, { event: "gate-state-change", key: "write_gate", value: "off" });

    const entries = readLedger(tp.paths);
    expect(entries.every((e) => typeof e.keyedHash === "string")).toBe(true);
    expect(verifyLedgerSeals(entries, KEY).ok).toBe(true);

    // Tamper a sealed field but LEAVE the (now stale) keyedHash → seal mismatch.
    entries[0]!.value = "strict";
    const res = verifyLedgerSeals(entries, KEY);
    expect(res.ok).toBe(false);
    expect(res.mismatches[0]!.index).toBe(0);

    // The WRONG key also mismatches (surfaced warn-only at the doctor layer).
    expect(verifyLedgerSeals(readLedger(tp.paths), "wrong-key").ok).toBe(false);
  });

  it("without TH_LEDGER_KEY no keyedHash is attached (opt-in); verifyLedgerSeals finds nothing → ok", () => {
    tp = makeTempProject();
    delete process.env.TH_LEDGER_KEY;
    appendLedger(tp.paths, { event: "e1" });
    const entries = readLedger(tp.paths);
    expect(entries[0]!.keyedHash).toBeUndefined();
    expect(verifyLedgerSeals(entries, KEY).ok).toBe(true); // no seals present → not a mismatch
  });

  it("an empty TH_LEDGER_KEY seals nothing (treated as unset)", () => {
    tp = makeTempProject();
    process.env.TH_LEDGER_KEY = "";
    appendLedger(tp.paths, { event: "e1" });
    expect(readLedger(tp.paths)[0]!.keyedHash).toBeUndefined();
  });
});

describe("#8 byte-identity + determinism (the seal/anchor must not perturb the keyless chain)", () => {
  it("keyless recordHash is byte-identical with and without a keyedHash, and for a high-water entry", () => {
    const base: Omit<LedgerEntry, "recordHash"> = {
      ts: "2026-01-01T00:00:00.000Z",
      event: "gate-state-change",
      value: "deny",
      prevHash: GENESIS_PREV_HASH,
    };
    const withSeal = { ...base, keyedHash: "de".repeat(32) };
    expect(ledgerCanonicalText(base)).toBe(ledgerCanonicalText(withSeal));
    expect(computeLedgerRecordHash(base)).toBe(computeLedgerRecordHash(withSeal));

    const hw: Omit<LedgerEntry, "recordHash"> = { ts: "2026-01-01T00:00:00.000Z", event: "high-water", count: 3, prevHash: GENESIS_PREV_HASH };
    expect(computeLedgerRecordHash(hw)).toBe(computeLedgerRecordHash({ ...hw, keyedHash: "ab".repeat(32) }));
  });

  it("determinism: same entry + same key → identical keyedHash (no nonce); different key → different seal", () => {
    const entry: Omit<LedgerEntry, "recordHash" | "keyedHash"> = {
      ts: "2026-01-01T00:00:00.000Z",
      event: "e1",
      value: "deny",
      prevHash: GENESIS_PREV_HASH,
    };
    const h1 = computeLedgerKeyedHash(entry, KEY);
    expect(h1).toBe(computeLedgerKeyedHash(entry, KEY));
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(computeLedgerKeyedHash(entry, "another-key")).not.toBe(h1);
  });
});

describe("#8 high-water anchor: sealed in-chain entry; edit/reorder/mid-delete breaks the chain", () => {
  it("appends a sealed high-water{count} anchor and the whole chain verifies", () => {
    tp = makeTempProject();
    process.env.TH_LEDGER_KEY = KEY;
    appendLedger(tp.paths, { event: "e1" });
    appendLedger(tp.paths, { event: "e2" });
    appendHighWater(tp.paths); // count = 2 sealed entries before it
    appendLedger(tp.paths, { event: "e3" });

    const entries = readLedger(tp.paths);
    const hw = entries.find((e) => e.event === "high-water");
    expect(hw).toBeDefined();
    expect(hw!.count).toBe(2); // excludes itself
    expect(typeof hw!.recordHash).toBe("string"); // sealed like any entry
    expect(typeof hw!.keyedHash).toBe("string"); // and keyed (TH_LEDGER_KEY set)
    expect(verifyLedgerChain(entries)).toEqual({ ok: true });
  });

  it("EDITING the anchor's count breaks the keyless chain (an edit, not a truncation)", () => {
    tp = makeTempProject();
    appendLedger(tp.paths, { event: "e1" });
    appendHighWater(tp.paths);
    appendLedger(tp.paths, { event: "e2" });
    const edited = readLedger(tp.paths);
    const i = edited.findIndex((e) => e.event === "high-water");
    edited[i]!.count = 99;
    expect(verifyLedgerChain(edited).ok).toBe(false);
  });

  it("REORDERING two sealed entries breaks the chain (prev_mismatch)", () => {
    tp = makeTempProject();
    appendLedger(tp.paths, { event: "e1" });
    appendLedger(tp.paths, { event: "e2" });
    appendHighWater(tp.paths);
    const r = readLedger(tp.paths);
    [r[0], r[1]] = [r[1]!, r[0]!];
    expect(verifyLedgerChain(r).ok).toBe(false);
  });

  it("MID-DELETING a sealed entry breaks the chain at the survivor", () => {
    tp = makeTempProject();
    appendLedger(tp.paths, { event: "e1" });
    appendLedger(tp.paths, { event: "e2" });
    appendHighWater(tp.paths);
    appendLedger(tp.paths, { event: "e3" });
    const full = readLedger(tp.paths);
    const midDeleted = full.filter((_, idx) => idx !== 1); // drop e2
    expect(verifyLedgerChain(midDeleted).ok).toBe(false);
  });
});

describe("#8 documented residual (3b): TAIL TRUNCATION past the last anchor is NOT detected", () => {
  it("truncating the tail past the last high-water anchor still verifies ok:true (a valid prefix)", () => {
    tp = makeTempProject();
    appendLedger(tp.paths, { event: "e1" });
    appendHighWater(tp.paths); // anchor{count:1}
    appendLedger(tp.paths, { event: "e2" });
    appendLedger(tp.paths, { event: "e3" });

    const full = readLedger(tp.paths);
    const anchorIdx = full.findIndex((e) => e.event === "high-water");
    const truncated = full.slice(0, anchorIdx + 1); // drop the trailing e2, e3

    // LOCKS the limitation: verifyLedgerChain is a length-agnostic forward walk, so a
    // truncated tail is a valid PREFIX → ok. The anchor does NOT close truncation; a
    // future "fix" claiming it does MUST update this characterization.
    expect(verifyLedgerChain(truncated)).toEqual({ ok: true });
  });
});

describe("#8 back-compat: a legacy/unsealed ledger never turns red", () => {
  it("legacy lines (no recordHash, no key, no high-water) verify clean", () => {
    tp = makeTempProject();
    writeRaw(tp, [
      { ts: "t1", event: "legacy-1" } as LedgerEntry,
      { ts: "t2", event: "legacy-2" } as LedgerEntry,
    ]);
    const entries = readLedger(tp.paths);
    expect(verifyLedgerChain(entries)).toEqual({ ok: true }); // fully-legacy → nothing to verify
    expect(verifyLedgerSeals(entries, KEY).ok).toBe(true); // no keyedHash anywhere → no mismatch
  });
});

describe("#8 doctor wiring: keyed-seal mismatch surfaces as WARN even under --strict", () => {
  it("an attacker who re-hashes the keyless chain but lacks the key is caught by the seal (chain ok, seals warn)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    process.env.TH_LEDGER_KEY = KEY;
    appendLedger(tp.paths, { event: "gate-state-change", key: "write_gate", value: "deny" });

    // Tamper a sealed field, then RE-HASH the keyless recordHash (what an attacker
    // WITHOUT the key can do) — but the keyedHash is left stale (they can't forge it).
    const entries = readLedger(tp.paths);
    entries[0]!.value = "strict";
    const { recordHash: _rh, ...rest } = entries[0]!;
    entries[0]!.recordHash = computeLedgerRecordHash(rest); // re-seal the keyless chain
    writeRaw(tp, entries);

    const res = runDoctor(tp.paths, { strict: true });
    // The keyless chain now PASSES (attacker re-hashed it)…
    expect(byName(res.data, "ledger chain")?.status).toBe("ok");
    // …but the keyed seal does NOT — surfaced WARN-only even under --strict.
    expect(byName(res.data, "ledger seals")?.status).toBe("warn");
    expect(byName(res.data, "ledger seals")?.detail).toMatch(/MISMATCH/);
  });

  it("with a valid key and intact seals, doctor reports `ledger seals: ok`", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    process.env.TH_LEDGER_KEY = KEY;
    appendLedger(tp.paths, { event: "gate-state-change", key: "write_gate", value: "deny" });
    const res = runDoctor(tp.paths);
    expect(byName(res.data, "ledger seals")?.status).toBe("ok");
  });

  it("without TH_LEDGER_KEY, doctor emits NO `ledger seals` check (opt-in)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    delete process.env.TH_LEDGER_KEY;
    appendLedger(tp.paths, { event: "gate-state-change", key: "write_gate", value: "deny" });
    const res = runDoctor(tp.paths);
    expect(byName(res.data, "ledger seals")).toBeUndefined();
  });
});
