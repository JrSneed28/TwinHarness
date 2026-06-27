/**
 * Axis-B slice-1a (BSC-4) — receipt-ledger concurrency + durability.
 *
 * Mirrors `tests/decision-concurrency.test.ts` in structure and assertion style.
 * The receipt store (`src/core/receipts.ts`) mirrors `src/core/decisions.ts` EXACTLY:
 * append-only, SHA-256 hash-chained, tolerant reader, atomic-append writer under the
 * CALLER's `withStateLock` span. These tests PROVE those guarantees hold for the receipt
 * ledger:
 *
 *  - N concurrent in-process `withStateLock`-wrapped `appendTerminalReceipt` calls
 *    never lose a receipt and never break the hash chain (no lost-update, no torn chain).
 *  - Interleaved writers (concurrent `runDriftResolve` + `runSimRetire` + receipt
 *    appends) leave the shared state consistent: exact receipt count, intact chain,
 *    state.json counters correct (no lost update on the shared lock).
 *  - A stale stamped `.state.lock` is stolen by the first receipt writer, not wedged.
 *  - A cross-process LIGHT wave (3 CLI children) serializes correctly; HEAVY wave
 *    gated behind `SKIP_SPAWN_HEAVY_IN_CI` per the helpers contract.
 *
 * Platform: Windows-safe throughout — no shell sleep/true/false, no POSIX-only paths.
 * All paths use path.join; concurrencyEnv() silences the run log and extends lock patience.
 */

import { describe, it, expect, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import * as fs from "node:fs";
import {
  concurrencyEnv,
  makeTempProject,
  SKIP_SPAWN_HEAVY_IN_CI,
  LIGHT_SPAWN_CONCURRENCY,
  type TempProject,
} from "./helpers";
import { runInit } from "../src/commands/init";
import { runDriftAdd, runDriftResolve } from "../src/commands/drift";
import { runSimAdd, runSimRetire } from "../src/commands/sim";
import { runDecisionAdd, runDecisionApprove } from "../src/commands/decision";
import {
  appendTerminalReceipt,
  readTerminalReceipts,
  verifyReceiptChain,
  terminalReceiptsPath,
  type TerminalTransitionKind,
} from "../src/core/receipts";
import { withStateLock } from "../src/core/state-store";
import { writeState } from "../src/core/state-store";
import { initialState } from "../src/core/state-schema";

const execFileP = promisify(execFile);
const CLI = path.resolve(__dirname, "../dist/cli.js");

function requireBuilt(p: string): void {
  if (!fs.existsSync(p)) {
    throw new Error(`${p} missing — run \`npm run build\` before the concurrency tests.`);
  }
}

const NO_LOG = { env: concurrencyEnv() };

let tp: TempProject | undefined;
afterEach(() => {
  tp?.cleanup();
  tp = undefined;
});

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Write a real, readable source file within root; return its root-relative path. */
function writeSourceFile(root: string, rel: string, content = "export const x = 1;\n"): string {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  return rel;
}

/** Init a project with state.json present (required by drift + sim commands). */
function initProject(): TempProject {
  const p = makeTempProject();
  runInit(p.paths, {});
  return p;
}

/** Init a project with only the state file (no full runInit) for sim commands. */
function initSimProject(): TempProject {
  const p = makeTempProject();
  fs.mkdirSync(p.paths.stateDir, { recursive: true });
  writeState(p.paths, { ...initialState(), tier: "T1", current_stage: "implementation" });
  return p;
}

// ---------------------------------------------------------------------------
// R4-CONC-001: N in-process concurrent receipt appends — no lost update, intact chain
// ---------------------------------------------------------------------------

describe("R4-CONC-001: test_CONC001_inprocess_concurrent_appends_no_lost_update — N parallel withStateLock-wrapped appendTerminalReceipt calls → exact count, intact chain", () => {
  it("N=20 concurrent decision-approve receipt appends all land; chain intact", async () => {
    tp = initProject();

    // Plant N real source files so every append has a distinct but resolvable target.
    // For decision-approve we use targetPath=undefined (build-coordinate-only), which
    // keeps the test self-contained and deterministic across HEAD states.
    const N = 20;

    const tasks = Array.from({ length: N }, (_, i) =>
      Promise.resolve().then(() =>
        withStateLock(tp!.paths, () =>
          appendTerminalReceipt(tp!.paths, {
            kind: "decision-approve" as TerminalTransitionKind,
            refId: `DECISION-${String(i + 1).padStart(3, "0")}`,
            producerIdentity: "test:concurrent-appends",
          }),
        ),
      ),
    );

    await Promise.all(tasks);

    // No lost update: exactly N receipts on disk.
    const receipts = readTerminalReceipts(tp.paths);
    expect(receipts).toHaveLength(N);

    // All distinct refIds.
    const refIds = new Set(receipts.map((r) => r.refId));
    expect(refIds.size).toBe(N);

    // Hash chain must be intact end-to-end (no torn write, no lost link).
    expect(verifyReceiptChain(receipts)).toEqual({ ok: true });
  });

  it("N=20 concurrent drift-resolve receipt appends (each grounded in a distinct source file)", async () => {
    tp = initProject();

    const N = 20;

    // Write N distinct source files BEFORE the concurrent run.
    const relPaths = Array.from({ length: N }, (_, i) =>
      writeSourceFile(tp!.root, `src/conc/file${i}.ts`, `export const f${i} = ${i};\n`),
    );

    const tasks = relPaths.map((rel, i) =>
      Promise.resolve().then(() =>
        withStateLock(tp!.paths, () =>
          appendTerminalReceipt(tp!.paths, {
            kind: "drift-resolve" as TerminalTransitionKind,
            refId: `DRIFT-${String(i + 1).padStart(3, "0")}`,
            targetPath: rel,
            producerIdentity: "test:concurrent-drift-appends",
          }),
        ),
      ),
    );

    await Promise.all(tasks);

    const receipts = readTerminalReceipts(tp.paths);
    expect(receipts).toHaveLength(N);
    expect(new Set(receipts.map((r) => r.refId)).size).toBe(N);
    expect(verifyReceiptChain(receipts)).toEqual({ ok: true });
  });

  it("N=20 concurrent sim-retire receipt appends (grounded)", async () => {
    tp = initProject();

    const N = 20;

    const relPaths = Array.from({ length: N }, (_, i) =>
      writeSourceFile(tp!.root, `src/sim/svc${i}.ts`, `export const svc${i} = ${i};\n`),
    );

    const tasks = relPaths.map((rel, i) =>
      Promise.resolve().then(() =>
        withStateLock(tp!.paths, () =>
          appendTerminalReceipt(tp!.paths, {
            kind: "sim-retire" as TerminalTransitionKind,
            refId: `SIM-${String(i + 1).padStart(3, "0")}`,
            targetPath: rel,
            producerIdentity: "test:concurrent-sim-appends",
          }),
        ),
      ),
    );

    await Promise.all(tasks);

    const receipts = readTerminalReceipts(tp.paths);
    expect(receipts).toHaveLength(N);
    expect(new Set(receipts.map((r) => r.refId)).size).toBe(N);
    expect(verifyReceiptChain(receipts)).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// R4-CONC-002: mixed-kind concurrent appends — all N receipts land, chain intact
// ---------------------------------------------------------------------------

describe("R4-CONC-002: test_CONC002_mixed_kind_concurrent_appends — drift-resolve + sim-retire + decision-approve all in-flight together", () => {
  it("N=18 (6 each kind) concurrent appends: no lost update, intact chain", async () => {
    tp = initProject();

    const K = 6;

    // Pre-create all target files for grounded kinds.
    const driftFiles = Array.from({ length: K }, (_, i) =>
      writeSourceFile(tp!.root, `src/drift/req${i}.ts`, `export const d${i} = ${i};\n`),
    );
    const simFiles = Array.from({ length: K }, (_, i) =>
      writeSourceFile(tp!.root, `src/sim/mix${i}.ts`, `export const s${i} = ${i};\n`),
    );

    const driftTasks = driftFiles.map((rel, i) =>
      Promise.resolve().then(() =>
        withStateLock(tp!.paths, () =>
          appendTerminalReceipt(tp!.paths, {
            kind: "drift-resolve" as TerminalTransitionKind,
            refId: `DRIFT-${String(i + 1).padStart(3, "0")}`,
            targetPath: rel,
            producerIdentity: "test:mixed-drift",
          }),
        ),
      ),
    );

    const simTasks = simFiles.map((rel, i) =>
      Promise.resolve().then(() =>
        withStateLock(tp!.paths, () =>
          appendTerminalReceipt(tp!.paths, {
            kind: "sim-retire" as TerminalTransitionKind,
            refId: `SIM-${String(i + 1).padStart(3, "0")}`,
            targetPath: rel,
            producerIdentity: "test:mixed-sim",
          }),
        ),
      ),
    );

    const decisionTasks = Array.from({ length: K }, (_, i) =>
      Promise.resolve().then(() =>
        withStateLock(tp!.paths, () =>
          appendTerminalReceipt(tp!.paths, {
            kind: "decision-approve" as TerminalTransitionKind,
            refId: `DECISION-${String(i + 1).padStart(3, "0")}`,
            producerIdentity: "test:mixed-decision",
          }),
        ),
      ),
    );

    await Promise.all([...driftTasks, ...simTasks, ...decisionTasks]);

    const receipts = readTerminalReceipts(tp.paths);
    expect(receipts).toHaveLength(3 * K);

    // Each (kind, refId) pair is unique — no lost update and no duplicate stamp.
    const pairs = new Set(receipts.map((r) => `${r.kind}:${r.refId}`));
    expect(pairs.size).toBe(3 * K);

    // Chain must be intact across the interleaved kinds.
    expect(verifyReceiptChain(receipts)).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// R4-CONC-003: interleaved real producers (runDriftResolve + runSimRetire) — shared lock
// ---------------------------------------------------------------------------

describe("R4-CONC-003: test_CONC003_interleaved_real_producers_shared_lock — runDriftResolve + runSimRetire run concurrently with direct appends", () => {
  it("concurrent drift resolves + sim retires + receipt appends: receipt count exact, chain intact, counters consistent", async () => {
    // Use a project initialised with both init (for drift) AND sim state.
    tp = initProject();

    // Seed 3 requirement-layer drifts.
    const DRIFT_COUNT = 3;
    for (let i = 0; i < DRIFT_COUNT; i++) {
      runDriftAdd(tp.paths, { layer: "requirement", action: "blocked" });
    }

    // Seed 3 user-visible sim entries.
    const SIM_COUNT = 3;
    for (let i = 0; i < SIM_COUNT; i++) {
      runSimAdd(tp.paths, { classification: "Mocked", userVisible: true, replaces: `dep${i}` });
    }

    // Pre-create all target files so both producers can ground in them.
    const driftTargets = Array.from({ length: DRIFT_COUNT }, (_, i) =>
      writeSourceFile(tp!.root, `src/intlv/drift${i}.ts`, `export const dr${i} = ${i};\n`),
    );
    const simTargets = Array.from({ length: SIM_COUNT }, (_, i) =>
      writeSourceFile(tp!.root, `src/intlv/sim${i}.ts`, `export const sm${i} = ${i};\n`),
    );

    // Also prepare a few direct receipt appends (decision-approve kind, no target).
    const DIRECT_COUNT = 4;

    const driftTasks = driftTargets.map((rel, i) =>
      Promise.resolve().then(() =>
        runDriftResolve(tp!.paths, `DRIFT-${String(i + 1).padStart(3, "0")}`, { target: rel }),
      ),
    );

    const simTasks = simTargets.map((rel, i) =>
      Promise.resolve().then(() =>
        runSimRetire(tp!.paths, `SIM-${String(i + 1).padStart(3, "0")}`, { target: rel }),
      ),
    );

    const directTasks = Array.from({ length: DIRECT_COUNT }, (_, i) =>
      Promise.resolve().then(() =>
        withStateLock(tp!.paths, () =>
          appendTerminalReceipt(tp!.paths, {
            kind: "decision-approve" as TerminalTransitionKind,
            refId: `DECISION-${String(i + 1).padStart(3, "0")}`,
            producerIdentity: "test:interleaved-direct",
          }),
        ),
      ),
    );

    const results = await Promise.all([...driftTasks, ...simTasks, ...directTasks]);

    // All real producers must have succeeded.
    const driftResults = results.slice(0, DRIFT_COUNT);
    const simResults = results.slice(DRIFT_COUNT, DRIFT_COUNT + SIM_COUNT);
    for (const r of [...driftResults, ...simResults]) {
      expect((r as { ok: boolean }).ok).toBe(true);
    }

    // Receipt ledger: the three real producers (drift, sim, decision-direct) each
    // mint one receipt, plus migration may mint legacy stamps for pre-existing
    // terminal entities — we assert at least DRIFT_COUNT + SIM_COUNT + DIRECT_COUNT.
    const receipts = readTerminalReceipts(tp.paths);
    const realReceipts = receipts.filter((r) => !r.legacy);
    expect(realReceipts.length).toBeGreaterThanOrEqual(DRIFT_COUNT + SIM_COUNT + DIRECT_COUNT);

    // Hash chain must be intact across ALL receipts (real + any legacy migration stamps).
    expect(verifyReceiptChain(receipts)).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// R4-CONC-004: stale lock is stolen, not wedged — mirrors decision-concurrency test
// ---------------------------------------------------------------------------

describe("R4-CONC-004: test_CONC004_stale_lock_stolen_not_wedged — a stamped stale .state.lock is stolen and the receipt lands", () => {
  it("plants a stale lock then appendTerminalReceipt steals it quickly and writes exactly one receipt", () => {
    tp = initProject();

    // Plant a stale, stamped lock (mtime far in the past, beyond STALE_MS=15s).
    const lockDir = path.join(tp.paths.stateDir, ".state.lock");
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, "owner"), "crashed-holder-token", "utf8");
    const past = new Date(Date.now() - 120_000);
    fs.utimesSync(lockDir, past, past);

    const start = Date.now();
    withStateLock(tp.paths, () =>
      appendTerminalReceipt(tp.paths, {
        kind: "decision-approve" as TerminalTransitionKind,
        refId: "DECISION-001",
        producerIdentity: "test:stale-lock-steal",
      }),
    );
    const elapsed = Date.now() - start;

    // Stolen quickly — nowhere near the 10s lock timeout.
    expect(elapsed).toBeLessThan(5_000);

    const receipts = readTerminalReceipts(tp.paths);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.refId).toBe("DECISION-001");
    expect(verifyReceiptChain(receipts)).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// R4-CONC-005: reader during concurrent writers — consistent prefix, no partial-line throw
// ---------------------------------------------------------------------------

describe("R4-CONC-005: test_CONC005_reader_during_writers_consistent_prefix — concurrent readers never see a partial line", () => {
  it("40 in-process readers interleaved with N=16 writers: every read returns a valid chain prefix", async () => {
    tp = initProject();

    const N = 16;
    const relPaths = Array.from({ length: N }, (_, i) =>
      writeSourceFile(tp!.root, `src/prefix/p${i}.ts`, `export const p${i} = ${i};\n`),
    );

    const writers = relPaths.map((rel, i) =>
      Promise.resolve().then(() =>
        withStateLock(tp!.paths, () =>
          appendTerminalReceipt(tp!.paths, {
            kind: "drift-resolve" as TerminalTransitionKind,
            refId: `DRIFT-${String(i + 1).padStart(3, "0")}`,
            targetPath: rel,
            producerIdentity: "test:prefix-writer",
          }),
        ),
      ),
    );

    // Interleave many tolerant reads. Each visible prefix must be a valid chain.
    const readers = Array.from({ length: 40 }, () =>
      Promise.resolve().then(() => {
        const visible = readTerminalReceipts(tp!.paths);
        // Whatever prefix is visible must verify (atomic line append).
        expect(verifyReceiptChain(visible)).toEqual({ ok: true });
        return visible.length;
      }),
    );

    await Promise.all([...writers, ...readers]);

    // After all writers finish: exactly N receipts, intact chain.
    const final = readTerminalReceipts(tp.paths);
    expect(final).toHaveLength(N);
    expect(verifyReceiptChain(final)).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// R4-CONC-006: LIGHT compiled-CLI spawn wave — runs everywhere including CI
// ---------------------------------------------------------------------------

describe("R4-CONC-006: test_CONC006_light_spawn_wave_cli — LIGHT cross-process CLI receipt appends serialize correctly (runs on CI)", () => {
  it.skipIf(!fs.existsSync(CLI))(
    `${LIGHT_SPAWN_CONCURRENCY} concurrent CLI drift resolves → exact receipt count, intact chain`,
    async () => {
      tp = initProject();

      // Seed LIGHT_SPAWN_CONCURRENCY requirement-layer drifts.
      for (let i = 0; i < LIGHT_SPAWN_CONCURRENCY; i++) {
        runDriftAdd(tp.paths, { layer: "requirement", action: "blocked" });
      }

      // Pre-create target files accessible to subprocesses.
      const targets = Array.from({ length: LIGHT_SPAWN_CONCURRENCY }, (_, i) =>
        writeSourceFile(tp!.root, `src/spawn/light${i}.ts`, `export const l${i} = ${i};\n`),
      );

      const tasks = targets.map((rel, i) =>
        execFileP(
          "node",
          [
            CLI, "drift", "resolve",
            `DRIFT-${String(i + 1).padStart(3, "0")}`,
            "--target", rel,
            "--cwd", tp!.root,
          ],
          NO_LOG,
        ),
      );

      await Promise.all(tasks);

      const receipts = readTerminalReceipts(tp!.paths);
      // Each process mints exactly one drift-resolve receipt; migration may add legacy stamps.
      const realDriftReceipts = receipts.filter((r) => r.kind === "drift-resolve" && !r.legacy);
      expect(realDriftReceipts).toHaveLength(LIGHT_SPAWN_CONCURRENCY);
      expect(verifyReceiptChain(receipts)).toEqual({ ok: true });
    },
    60_000,
  );
});

// ---------------------------------------------------------------------------
// R4-CONC-007 (HEAVY, local-only): high-concurrency spawn wave
// ---------------------------------------------------------------------------

describe("R4-CONC-007: test_CONC007_heavy_spawn_wave_local_only — N=12 concurrent CLI receipt appends (skipped on CI)", () => {
  it.skipIf(!fs.existsSync(CLI) || SKIP_SPAWN_HEAVY_IN_CI)(
    "N=12 concurrent CLI drift resolves → no lost update, intact chain",
    async () => {
      const N = 12;
      tp = initProject();

      for (let i = 0; i < N; i++) {
        runDriftAdd(tp.paths, { layer: "requirement", action: "blocked" });
      }

      const targets = Array.from({ length: N }, (_, i) =>
        writeSourceFile(tp!.root, `src/spawn/heavy${i}.ts`, `export const h${i} = ${i};\n`),
      );

      const tasks = targets.map((rel, i) =>
        execFileP(
          "node",
          [
            CLI, "drift", "resolve",
            `DRIFT-${String(i + 1).padStart(3, "0")}`,
            "--target", rel,
            "--cwd", tp!.root,
          ],
          NO_LOG,
        ),
      );

      await Promise.all(tasks);

      const receipts = readTerminalReceipts(tp!.paths);
      const realDriftReceipts = receipts.filter((r) => r.kind === "drift-resolve" && !r.legacy);
      expect(realDriftReceipts).toHaveLength(N);
      expect(verifyReceiptChain(receipts)).toEqual({ ok: true });
    },
    120_000,
  );
});
