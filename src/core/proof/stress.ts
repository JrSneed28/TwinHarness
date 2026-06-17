/**
 * Component 3 (Stress) — real, multi-process lock contention + large-repo scanner
 * load (plan Step 3). These are the SOLE source of the stress/concurrency verdict:
 * concurrent LIVE agentic pipelines are out of scope (live scenarios run
 * serialized), so the genuine concurrency proof is mechanical and process-level.
 *
 * {@link runLockContention} spawns N real `node dist/cli.js drift add` OS processes
 * (the exact pattern of `tests/concurrency.test.ts:32-61`) that all contend the
 * real `mkdir` state lock, then asserts no update was lost (final blocking count
 * === N), every id is unique, nothing deadlocked, and the contended batch finished
 * within a bound. {@link runScannerLoad} times a real `scanRepo` walk over a large
 * generated tree (respecting the scanner's FILE_COUNT/TOTAL_BYTES caps) and records
 * completion + a within-bound flag.
 *
 * R7: this module NEVER imports `src/mcp-server.ts`. It spawns the compiled CLI by
 * path (injected, default `dist/cli.js` resolved relative to this module) so it adds
 * no bundle coupling.
 */

import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import { resolveProjectPaths, type ProjectPaths } from "../paths";
import { readState } from "../state-store";
import { scanRepo } from "../repo-map/scanner";
import { runInit } from "../../commands/init";
import type { StressResult, ScannerLoadResult } from "./types";

const execFileP = promisify(execFile);

/** Default compiled CLI path: `<repo>/dist/cli.js`, resolved relative to this module. */
export function defaultCliPath(): string {
  // Compiled: dist/core/proof/stress.js → dist/cli.js. Source (vitest): callers pass
  // an explicit path, so this best-effort default targets the dist layout.
  return path.resolve(__dirname, "..", "..", "cli.js");
}

export interface LockContentionOptions {
  /** Number of concurrent real writer processes (PS-Q1 provisional default = 8). */
  writers?: number;
  /** Path to the compiled CLI to spawn (default {@link defaultCliPath}). */
  cliPath?: string;
  /**
   * An already-initialized project to contend. When absent, an isolated temp
   * project is created (and deleted) internally so the proof is self-contained.
   */
  paths?: ProjectPaths;
  /** Per-process spawn timeout (ms) — bounds the proof so a wedged lock can't hang. */
  timeoutMs?: number;
}

/**
 * Spawn N real `node <cli> drift add` processes against ONE project and assert the
 * `withStateLock` serialization holds: every requirement-layer drift increments the
 * blocking counter and mints a unique `DRIFT-NNN` id (no lost read-modify-write).
 *
 * Returns a {@link StressResult}; never throws on contention — a spawn failure /
 * lock timeout surfaces as `deadlock:true` (a failed proof), not an exception.
 */
export async function runLockContention(opts: LockContentionOptions = {}): Promise<StressResult> {
  const writers = Math.max(1, Math.floor(opts.writers ?? 8));
  const cliPath = opts.cliPath ?? defaultCliPath();
  const timeoutMs = opts.timeoutMs ?? 45_000;

  // Self-contained isolation: create+init a temp project unless one was supplied.
  let paths = opts.paths;
  let ownTemp: string | null = null;
  if (!paths) {
    ownTemp = fs.mkdtempSync(path.join(os.tmpdir(), "th-proof-stress-"));
    paths = resolveProjectPaths(ownTemp);
    runInit(paths, {});
  }

  const started = performance.now();
  let deadlock = false;
  try {
    const tasks = Array.from({ length: writers }, (_, i) =>
      execFileP(
        "node",
        [
          cliPath, "drift", "add",
          "--layer", "requirement",
          "--ref", `SLICE-${i}`,
          "--discovery", `stress discovery ${i}`,
          "--action", "build paused",
          "--cwd", paths!.root,
        ],
        { env: { ...process.env, TH_NO_LOG: "1" }, timeout: timeoutMs },
      ),
    );
    const settled = await Promise.allSettled(tasks);
    // A rejected spawn means a process timed out / lock never released / CLI errored
    // — i.e. the contention was NOT bounded-and-resolved → a deadlock for the proof.
    deadlock = settled.some((r) => r.status === "rejected");
  } catch {
    deadlock = true;
  }
  const elapsedMs = performance.now() - started;

  // No lost increment: every requirement-layer drift must have counted.
  const finalCount = readState(paths).state?.drift_open_blocking ?? 0;

  // No id collision: the serialized id minter produced `writers` distinct ids.
  let uniqueIds = 0;
  try {
    const log = fs.readFileSync(paths.driftLog, "utf8");
    uniqueIds = new Set([...log.matchAll(/DRIFT-(\d+)/g)].map((m) => m[1])).size;
  } catch {
    uniqueIds = 0;
  }

  if (ownTemp) {
    try {
      fs.rmSync(ownTemp, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }

  const lostUpdates = finalCount < writers;
  const pass = !lostUpdates && !deadlock && finalCount === writers && uniqueIds === writers;

  return {
    name: "lock-contention",
    writers,
    finalCount,
    uniqueIds,
    lostUpdates,
    deadlock,
    elapsedMs,
    pass,
  };
}

export interface ScannerLoadOptions {
  /**
   * Generous provisional wall-clock bound (ms) for the walk (PS-Q1). The proof does
   * NOT hard-fail tightly — `withinBound` is reported as evidence, and a cap hit is
   * NOT an error (the scanner returns a partial map by design).
   */
  boundMs?: number;
}

/** Sum the byte size of every regular file under `root` (best-effort; skips the
 *  scanner's generated/producer dirs so the total mirrors what the walk accounted). */
function sumFileBytes(root: string): number {
  const SKIP = new Set([
    "node_modules", "dist", "build", "target", "out", ".git", ".cache",
    ".twinharness", ".agentic-sdlc", "coverage", "vendor",
  ]);
  let total = 0;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP.has(e.name)) continue;
        stack.push(path.join(dir, e.name));
      } else if (e.isFile()) {
        try {
          total += fs.statSync(path.join(dir, e.name)).size;
        } catch {
          /* unreadable — skip */
        }
      }
    }
  }
  return total;
}

/**
 * Walk a large generated tree through the REAL `scanRepo` (respecting its
 * FILE_COUNT_CAP/TOTAL_BYTES_CAP), recording files scanned, bytes, elapsed time,
 * completion (no cap hit), and whether it finished within the provisional bound.
 */
export function runScannerLoad(largeFixtureRoot: string, opts: ScannerLoadOptions = {}): ScannerLoadResult {
  const boundMs = opts.boundMs ?? 30_000;
  const started = performance.now();
  const map = scanRepo(largeFixtureRoot);
  const ms = performance.now() - started;

  return {
    files: map.files.length,
    bytes: sumFileBytes(largeFixtureRoot),
    ms,
    completed: map.scanReport.capHit === null,
    withinBound: ms <= boundMs,
  };
}
