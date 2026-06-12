/**
 * Cross-process state-lock concurrency (audit finding F10) — REQ-anchored.
 *
 * Each `th` invocation is a separate OS process. During a parallel build wave,
 * multiple Builders mutate state concurrently. This test spawns N real
 * `node dist/cli.js drift add` processes at once and asserts no update is lost:
 * every requirement-layer drift must increment `drift_open_blocking` and receive
 * a unique DRIFT-NNN id. Without `withStateLock`, racing read-modify-write would
 * under-count the blocking gate and collide ids.
 *
 * Runs against the COMPILED CLI (dist/cli.js), so CI builds before testing.
 */

import { describe, it, expect, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import * as fs from "node:fs";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { readState } from "../src/core/state-store";

const execFileP = promisify(execFile);
const CLI = path.resolve(__dirname, "../dist/cli.js");

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

describe("REQ-STATE-LOCK-001: concurrent mutations do not lose updates (F10)", () => {
  it("N parallel `drift add` processes each increment the blocking count with a unique id", async () => {
    // Guard: this test needs the compiled CLI. CI builds before testing.
    if (!fs.existsSync(CLI)) {
      throw new Error(`dist/cli.js missing — run \`npm run build\` before the concurrency test (${CLI}).`);
    }
    tp = makeTempProject();
    runInit(tp.paths, {});

    const N = 20;
    const tasks = Array.from({ length: N }, (_, i) =>
      execFileP(
        "node",
        [
          CLI, "drift", "add",
          "--layer", "requirement",
          "--ref", `SLICE-${i}`,
          "--discovery", `concurrent discovery ${i}`,
          "--action", "build paused",
          "--cwd", tp!.root,
        ],
        { env: { ...process.env, TH_NO_LOG: "1" } },
      ),
    );
    await Promise.all(tasks);

    // No lost increment: every requirement-layer drift counted.
    const state = readState(tp.paths).state;
    expect(state?.drift_open_blocking).toBe(N);

    // No id collision: the serialized nextDriftId produced N distinct ids.
    const log = fs.readFileSync(tp.paths.driftLog, "utf8");
    const ids = new Set([...log.matchAll(/DRIFT-(\d+)/g)].map((m) => m[1]));
    expect(ids.size).toBe(N);
  }, 30_000);

  it("concurrent `slice set-status` updates all land (no lost slice writes)", async () => {
    if (!fs.existsSync(CLI)) {
      throw new Error(`dist/cli.js missing — run \`npm run build\` before the concurrency test.`);
    }
    tp = makeTempProject();
    runInit(tp.paths, {});
    // Seed N pending slices.
    const N = 12;
    const slices = Array.from({ length: N }, (_, i) => ({
      id: `SLICE-${i}`,
      status: "pending",
      components: [`src/mod${i}`],
    }));
    await execFileP("node", [CLI, "state", "set", "slices", JSON.stringify(slices), "--cwd", tp.root],
      { env: { ...process.env, TH_NO_LOG: "1" } });

    // Flip each to in-progress concurrently.
    await Promise.all(
      slices.map((s) =>
        execFileP("node", [CLI, "slice", "set-status", s.id, "in-progress", "--cwd", tp!.root],
          { env: { ...process.env, TH_NO_LOG: "1" } }),
      ),
    );

    const state = readState(tp.paths).state;
    const inProgress = state?.slices.filter((s) => s.status === "in-progress").length ?? 0;
    expect(inProgress).toBe(N);
  }, 30_000);
});
