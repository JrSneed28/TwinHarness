/**
 * Multi-process writer-under-concurrent-readers harness (C-2).
 *
 * Writers hold the state lock; READERS do not. On Windows, `rename` over a file a
 * reader holds open throws EPERM — so before the fix a write could be lost under
 * background readers, leaving `drift_open_blocking` too low (and the Stop hook
 * would then pass a run it should block). The atomic-write retry must survive the
 * contention: every `drift add` lands, so the final count equals N (0 lost
 * writes) and no writer crashes with a raw error.
 *
 * Runs against the COMPILED CLI (dist/cli.js), so CI builds before testing. This
 * is timing-sensitive; windows-latest CI runs it with more readers / a longer
 * writer loop than the local default.
 */

import { describe, it, expect, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import * as fs from "node:fs";
import { concurrencyEnv, makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { readState } from "../src/core/state-store";

const execFileP = promisify(execFile);
const CLI = path.resolve(__dirname, "../dist/cli.js");
const NO_LOG = { env: concurrencyEnv() } as const;

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

describe("REQ-STATE-LOCK-002: writes survive concurrent readers (C-2)", () => {
  // TEST-008/009: skipIf dist is absent so the suite degrades gracefully instead
  // of throwing. CI always builds first; local runs without a build simply skip.
  it.skipIf(!fs.existsSync(CLI))("N concurrent `drift add` under background `state get` readers → 0 lost writes, no crash", async () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const root = tp.root;

    // Background readers: each loops `th state get`, holding the state file open
    // during writes (the C-2 rename-EPERM trigger on Windows). They self-terminate
    // after a safety deadline and are also killed explicitly once writers finish.
    const READERS = 6;
    const readerScript = `
      const { execFileSync } = require("node:child_process");
      const CLI = ${JSON.stringify(CLI)};
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        try {
          execFileSync("node", [CLI, "state", "get", "--cwd", ${JSON.stringify(root)}],
            { stdio: "ignore", env: { ...process.env, TH_NO_LOG: "1" } });
        } catch { /* a transient read failure is fine; keep hammering */ }
      }
    `;
    const readers = Array.from({ length: READERS }, () =>
      execFile("node", ["-e", readerScript], NO_LOG),
    );

    const N = 20;
    const writers = Array.from({ length: N }, (_, i) =>
      execFileP(
        "node",
        [
          CLI, "drift", "add",
          "--layer", "requirement",
          "--ref", `R-${i}`,
          "--discovery", `concurrent ${i}`,
          "--action", "build paused",
          "--cwd", root,
        ],
        NO_LOG,
      ),
    );

    const results = await Promise.allSettled(writers);
    readers.forEach((r) => r.kill("SIGKILL"));

    // No writer crashed or exhausted its retry budget: the atomic-write retry
    // absorbs the reader-induced EPERM, so every writer exits 0.
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toEqual([]);

    // 0 lost writes: every requirement-layer drift incremented the gate.
    const state = readState(tp.paths).state;
    expect(state?.drift_open_blocking).toBe(N);

    // No id collision under contention either.
    const log = fs.readFileSync(tp.paths.driftLog, "utf8");
    const ids = new Set([...log.matchAll(/DRIFT-(\d+)/g)].map((m) => m[1]));
    expect(ids.size).toBe(N);
  }, 120_000);
});
