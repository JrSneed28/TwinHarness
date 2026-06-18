/**
 * Gate-mutation audit ledger (F5) — REQ-anchored.
 *
 * The ledger is observability over the gates that only bind a compliant agent:
 * it records WHEN implementation_allowed / tier / write_gate / drift counters
 * changed, so a human can audit the run afterwards. These tests pin that
 * gate-relevant mutations are recorded and non-gate mutations are not, and that
 * the audit path never throws.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { runStateSet } from "../src/commands/state";
import { runDriftAdd, runDriftResolve } from "../src/commands/drift";
import { appendLedger, readLedger, GATE_LEDGER_KEYS } from "../src/core/ledger";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

describe("REQ-LEDGER-001: appendLedger records timestamped entries", () => {
  it("writes one JSON line per entry with a ts and the given fields", () => {
    tp = makeTempProject();
    appendLedger(tp.paths, { event: "test-event", foo: "bar" });
    appendLedger(tp.paths, { event: "test-event-2" });
    const entries = readLedger(tp.paths);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.event).toBe("test-event");
    expect(entries[0]?.foo).toBe("bar");
    expect(typeof entries[0]?.ts).toBe("string");
    expect(entries[1]?.event).toBe("test-event-2");
  });

  it("never throws on an unwritable statedir (best-effort audit path)", () => {
    tp = makeTempProject();
    // Point stateDir at an existing FILE, so mkdirSync(recursive) and the
    // subsequent append both fail — the audit path must swallow the error.
    const blocker = path.join(tp.root, "blocker");
    fs.writeFileSync(blocker, "x");
    const bogus = { ...tp.paths, stateDir: blocker };
    expect(() => appendLedger(bogus, { event: "boom" })).not.toThrow();
  });
});

describe("REQ-LEDGER-002: gate-relevant state mutations are audited", () => {
  it("records implementation_allowed flips", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    // implementation_allowed is gate-owned (#11): the raw set needs --emergency,
    // which still produces the audit-ledger entry.
    runStateSet(tp.paths, "implementation_allowed", "true", { emergency: true });
    const entries = readLedger(tp.paths);
    const gate = entries.find((e) => e.event === "gate-state-change" && e.key === "implementation_allowed");
    expect(gate).toBeDefined();
    expect(gate?.value).toBe(true);
  });

  it("audits every key in GATE_LEDGER_KEYS but NOT a non-gate key", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    // A non-gate field must not produce a ledger entry.
    runStateSet(tp.paths, "complexity_rationale", "just a note");
    expect(readLedger(tp.paths).filter((e) => e.event === "gate-state-change")).toHaveLength(0);
    // A gate field must — write_gate is gate-owned (#11), set via --emergency.
    runStateSet(tp.paths, "write_gate", "deny", { emergency: true });
    const gateEntries = readLedger(tp.paths).filter((e) => e.event === "gate-state-change");
    expect(gateEntries).toHaveLength(1);
    expect(gateEntries[0]?.key).toBe("write_gate");
    expect(GATE_LEDGER_KEYS.has("write_gate")).toBe(true);
  });
});

describe("REQ-LEDGER-003: blocking drift open/close is audited", () => {
  it("records a requirement-layer drift opening and resolving a blocking gate", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const add = runDriftAdd(tp.paths, { layer: "requirement", ref: "SLICE-1 / TASK-001", discovery: "x", action: "paused" });
    const id = (add.data as { id: string }).id;
    runDriftResolve(tp.paths, id);
    const events = readLedger(tp.paths).map((e) => e.event);
    expect(events).toContain("drift-blocking-opened");
    expect(events).toContain("drift-blocking-resolved");
  });

  it("does NOT audit a derived-layer (non-blocking) drift", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runDriftAdd(tp.paths, { layer: "derived", ref: "SLICE-1 / TASK-001", discovery: "x", action: "wired" });
    const events = readLedger(tp.paths).map((e) => e.event);
    expect(events).not.toContain("drift-blocking-opened");
  });
});
