/**
 * `th doctor` — self-diagnostic (Phase 3) — REQ-anchored.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import { makeTempProject, type TempProject } from "./helpers";
import * as path from "node:path";
import { runInit } from "../src/commands/init";
import { runStateSet } from "../src/commands/state";
import { runDriftAdd } from "../src/commands/drift";
import { runMigrate } from "../src/commands/migrate";
import { runArtifactRegister } from "../src/commands/artifact";
import { runReviseBump } from "../src/commands/revise";
import { readState, writeState } from "../src/core/state-store";
import { runDoctor } from "../src/commands/doctor";
import { appendLedger, readLedger, ledgerPath } from "../src/core/ledger";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

interface Check {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}
const checks = (data: unknown): Check[] => (data as { checks: Check[] }).checks;
const byName = (data: unknown, name: string): Check | undefined => checks(data).find((c) => c.name === name);

describe("REQ-DOCTOR-001: environment + project health", () => {
  it("reports node ok and 'no run' on an uninitialized dir", () => {
    tp = makeTempProject();
    const res = runDoctor(tp.paths);
    expect(res.ok).toBe(true);
    expect(byName(res.data, "node")?.status).toBe("ok");
    expect(byName(res.data, "project")?.detail).toMatch(/no TwinHarness run/);
  });

  it("reports a healthy initialized project at the current schema", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const res = runDoctor(tp.paths);
    expect(res.ok).toBe(true);
    expect(byName(res.data, "state.json")?.status).toBe("ok");
    expect(byName(res.data, "schema")?.status).toBe("ok");
  });

  it("warns when state is legacy (unversioned)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const s = readState(tp.paths).state!;
    const legacy = { ...s };
    delete legacy.schema_version;
    writeState(tp.paths, legacy);
    const res = runDoctor(tp.paths);
    expect(byName(res.data, "schema")?.status).toBe("warn");
    // ...and migrate clears the warning.
    runMigrate(tp.paths);
    expect(byName(runDoctor(tp.paths).data, "schema")?.status).toBe("ok");
  });

  it("warns on open blocking drift", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    // drift_open_blocking is a managed field — open it through the owning flow.
    runDriftAdd(tp.paths, { layer: "requirement", ref: "SLICE-1 / TASK-001", discovery: "x", action: "paused" });
    const res = runDoctor(tp.paths);
    expect(byName(res.data, "blocking drift")?.status).toBe("warn");
  });

  it("fails (non-zero) on an invalid state.json", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    fs.writeFileSync(tp.paths.stateFile, "{ not valid json");
    const res = runDoctor(tp.paths);
    expect(res.ok).toBe(false);
    expect(byName(res.data, "state.json")?.status).toBe("fail");
  });

  it("reports the Claude Code compatibility expectation as a non-fatal note", () => {
    tp = makeTempProject();
    const res = runDoctor(tp.paths);
    const cc = byName(res.data, "claude code");
    expect(cc?.status).toBe("warn"); // informational, surfaced as a warning
    expect(cc?.detail).toMatch(/Claude Code >=1\.0\.0/);
    expect(res.human).toMatch(/plugin targets Claude Code >=1\.0\.0/);
    // The note must not change the exit code: a fresh uninitialized dir is still ok.
    expect(res.ok).toBe(true);
  });
});

describe("REQ-DOCTOR-002: run-health audit (artifacts, slices, coverage, revise loops)", () => {
  function writeFile(t: TempProject, rel: string, content: string): void {
    const abs = path.join(t.root, ...rel.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }

  it("a healthy fresh project reports ok on every run-health check", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const res = runDoctor(tp.paths);
    expect(res.ok).toBe(true);
    expect(byName(res.data, "artifacts")?.status).toBe("ok");
    expect(byName(res.data, "slices")?.status).toBe("ok");
    expect(byName(res.data, "revise loops")?.status).toBe("ok");
  });

  it("warns when a registered artifact has changed on disk (silent drift)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeFile(tp, "docs/01-requirements.md", "REQ-001.\n");
    runArtifactRegister(tp.paths, "docs/01-requirements.md", 1);
    expect(byName(runDoctor(tp.paths).data, "artifacts")?.status).toBe("ok");
    // Edit after registration → drift surfaces as a warning.
    writeFile(tp, "docs/01-requirements.md", "REQ-001 edited.\n");
    const after = runDoctor(tp.paths);
    expect(after.ok).toBe(true); // run-health findings are warnings, not failures
    expect(byName(after.data, "artifacts")?.status).toBe("warn");
  });

  it("warns when a revise loop is at its cap", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runReviseBump(tp.paths, "architecture");
    runReviseBump(tp.paths, "architecture");
    runReviseBump(tp.paths, "architecture");
    expect(byName(runDoctor(tp.paths).data, "revise loops")?.status).toBe("warn");
  });
});

describe("REQ-DOCTOR-003 (GOV-2): gate-ledger hash-chain verification", () => {
  it("reports an intact ledger chain as ok", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    appendLedger(tp.paths, { event: "gate-state-change", key: "write_gate", value: "deny" });
    appendLedger(tp.paths, { event: "gate-state-change", key: "write_gate", value: "off" });
    expect(byName(runDoctor(tp.paths).data, "ledger chain")?.status).toBe("ok");
  });

  it("WARNS by default on a broken chain (best-effort review aid — does not fail the run)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    appendLedger(tp.paths, { event: "gate-state-change", key: "write_gate", value: "deny" });
    appendLedger(tp.paths, { event: "gate-state-change", key: "write_gate", value: "off" });
    // Tamper: forge a sealed field without re-hashing.
    const entries = readLedger(tp.paths);
    entries[0]!.value = "strict";
    fs.writeFileSync(ledgerPath(tp.paths), entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");

    const res = runDoctor(tp.paths);
    expect(res.ok).toBe(true); // default: a broken chain warns, never fails the process
    expect(byName(res.data, "ledger chain")?.status).toBe("warn");
    expect(byName(res.data, "ledger chain")?.detail).toMatch(/BROKEN at entry 0 \(edited\)/);
  });

  it("ESCALATES a broken chain to a hard fail under strict", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    appendLedger(tp.paths, { event: "e1" });
    appendLedger(tp.paths, { event: "e2" });
    const entries = readLedger(tp.paths);
    // Delete the middle line → the survivor's prevHash no longer matches.
    fs.writeFileSync(ledgerPath(tp.paths), JSON.stringify(entries[1]) + "\n", "utf8");

    const strict = runDoctor(tp.paths, { strict: true });
    expect(strict.ok).toBe(false); // strict: a broken chain is a hard failure
    expect(byName(strict.data, "ledger chain")?.status).toBe("fail");
  });
});
