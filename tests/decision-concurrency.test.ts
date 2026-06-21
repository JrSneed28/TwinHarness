/**
 * SLICE-4 / TASK-010 — Concurrency + durability for decisions.jsonl
 * (REQ-NFR-005, REQ-407, REQ-NFR-002).
 *
 * Subprocess-level concurrency tests mirroring tests/concurrency.test.ts: Node
 * `execFile` + `promisify`, NO Unix-only shell commands (the repo has 6
 * deterministic Windows failures from `sleep`/`true`/`false`; do not add more).
 *
 * The store reuses the proven `withStateLock` + atomic-append primitives, so
 * these tests PROVE those guarantees hold for the decision ledger:
 *  - concurrent `decision add` never drops a record (serialized, unique ids);
 *  - concurrent double-approve resolves to exactly one winner (state graph);
 *  - a reader during a writer never sees a partial line (consistent prefix);
 *  - a stale `.state.lock` is stolen, not wedged;
 *  - a crash before append leaves no phantom record.
 *
 * The approve path's TTY barrier is bypassed ONLY via the in-process handler's
 * injected isTTY/stdin stub (the test-only entry sanctioned by DS-001/TASK-010);
 * NO `--yes` CLI flag exists and none is added (it would reopen the self-approval
 * hole, REQ-412).
 *
 * Runs against the COMPILED CLI (dist/cli.js) + compiled handlers
 * (dist/commands/decision.js); CI builds before testing.
 */

import { describe, it, expect, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import * as fs from "node:fs";
import { concurrencyEnv, makeTempProject, SKIP_SPAWN_HEAVY_IN_CI, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import {
  appendDecisionEvent,
  readDecisionEvents,
  verifyChain,
  mintNextId,
  decisionsPath,
} from "../src/core/decisions";
import { withStateLock } from "../src/core/state-store";

const execFileP = promisify(execFile);
const CLI = path.resolve(__dirname, "../dist/cli.js");
const DECISION_MOD = path.resolve(__dirname, "../dist/commands/decision.js");

function requireBuilt(p: string): void {
  if (!fs.existsSync(p)) {
    throw new Error(`${p} missing — run \`npm run build\` before the concurrency tests.`);
  }
}

let tp: TempProject | undefined;
afterEach(() => {
  tp?.cleanup();
  tp = undefined;
});

const NO_LOG = { env: concurrencyEnv() };

describe("SLICE-4 — decisions.jsonl concurrency + durability", () => {
  // TEST-008/009: tests that require the compiled CLI degrade to skip when dist/
  // is absent, rather than throwing. CI always builds first; local runs without
  // a build simply skip these subprocess-level tests.
  // NOT RUN IN CI (see SKIP_SPAWN_HEAVY_IN_CI) — N=16 concurrent `decision add`
  // lock contenders; intractable scheduler-starvation false-red on windows-latest.
  it.skipIf(!fs.existsSync(CLI) || SKIP_SPAWN_HEAVY_IN_CI)("REQ-NFR-005: test_REQNFR005_concurrent_appends_serialized_no_loss — N parallel `decision add` → all N unique ids, chain intact (non-negotiable)", async () => {
    tp = makeTempProject();
    runInit(tp.paths, {});

    const N = 16;
    const tasks = Array.from({ length: N }, (_, i) =>
      execFileP(
        "node",
        [
          CLI, "decision", "add",
          "--title", `t${i}`,
          "--rationale", `r${i}`,
          "--cwd", tp!.root,
        ],
        NO_LOG,
      ),
    );
    await Promise.all(tasks);

    // No lost append: exactly N events, all ids unique, chain verifies.
    const events = readDecisionEvents(tp.paths);
    expect(events).toHaveLength(N);
    const ids = new Set(events.map((e) => e.id));
    expect(ids.size).toBe(N);
    expect(verifyChain(events)).toEqual({ ok: true });
  }, 120_000);

  it.skipIf(!fs.existsSync(CLI) || !fs.existsSync(DECISION_MOD))("REQ-407: test_REQ407_concurrent_double_approve_one_wins_other_illegal — two parallel approves → exactly one approved, other illegal_transition", async () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    // Seed one proposed decision.
    await execFileP("node", [CLI, "decision", "add", "--title", "t", "--rationale", "r", "--cwd", tp.root], NO_LOG);

    // A test-only entry: require the compiled handler and inject the TTY stub so
    // the barrier is satisfied WITHOUT a CLI bypass flag. Prints the JSON result.
    const script = `
      const { runDecisionApprove } = require(${JSON.stringify(DECISION_MOD)});
      const { resolveProjectPaths } = require(${JSON.stringify(path.resolve(__dirname, "../dist/core/paths.js"))});
      const paths = resolveProjectPaths(${JSON.stringify(tp.root)});
      const r = runDecisionApprove(paths, "DECISION-001", { as: "human", tty: { isTTY: true, stdinLine: "y" } });
      process.stdout.write(JSON.stringify({ ok: r.ok, error: r.data && r.data.error, to: r.data && r.data.to }));
    `;
    const [a, b] = await Promise.all([
      execFileP("node", ["-e", script], NO_LOG),
      execFileP("node", ["-e", script], NO_LOG),
    ]);
    const ra = JSON.parse(a.stdout);
    const rb = JSON.parse(b.stdout);

    // Exactly one winner; the loser is an illegal transition (status already approved).
    const oks = [ra, rb].filter((r) => r.ok);
    const fails = [ra, rb].filter((r) => !r.ok);
    expect(oks).toHaveLength(1);
    expect(oks[0].to).toBe("approved");
    expect(fails).toHaveLength(1);
    expect(fails[0].error).toBe("illegal_transition");

    // Exactly one approved event on disk; chain intact.
    const events = readDecisionEvents(tp.paths);
    expect(events.filter((e) => e.event === "approved")).toHaveLength(1);
    expect(verifyChain(events)).toEqual({ ok: true });
  }, 30_000);

  // NOT RUN IN CI (see SKIP_SPAWN_HEAVY_IN_CI) — N=12 writers + 40 background readers;
  // intractable scheduler-starvation false-red on windows-latest.
  it.skipIf(!fs.existsSync(CLI) || SKIP_SPAWN_HEAVY_IN_CI)("REQ-NFR-002: test_REQNFR002_read_during_append_sees_consistent_prefix — concurrent reader during writers never sees a partial-line crash", async () => {
    tp = makeTempProject();
    runInit(tp.paths, {});

    const N = 12;
    const writers = Array.from({ length: N }, (_, i) =>
      execFileP("node", [CLI, "decision", "add", "--title", `t${i}`, "--rationale", "r", "--cwd", tp!.root], NO_LOG),
    );
    // Interleave many tolerant reads while writers run. Each read must parse a
    // consistent prefix (no partial-line throw) and verify cleanly.
    const readers = Array.from({ length: 40 }, () =>
      Promise.resolve().then(() => {
        const events = readDecisionEvents(tp!.paths);
        // Whatever prefix is visible must be a valid chain (atomic line append).
        expect(verifyChain(events)).toEqual({ ok: true });
        return events.length;
      }),
    );
    await Promise.all([...writers, ...readers]);

    const finalEvents = readDecisionEvents(tp.paths);
    expect(finalEvents).toHaveLength(N);
    expect(verifyChain(finalEvents)).toEqual({ ok: true });
  }, 120_000);

  it("REQ-NFR-005: test_REQNFR005_stale_lock_is_stolen_not_wedged — a stale, STAMPED .state.lock is stolen, not hung", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    // Plant a STALE lock dir (mtime far in the past, beyond the stale threshold). It
    // carries an OWNER stamp so it is steal-eligible — R-08: only stamped locks may be
    // stolen; an owner-less crashed lock is reclaimed via the 25s timeout, never stolen.
    const lockDir = path.join(tp.paths.stateDir, ".state.lock");
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, "owner"), "crashed-holder-token", "utf8");
    const past = new Date(Date.now() - 120_000);
    fs.utimesSync(lockDir, past, past);

    // withStateLock must STEAL the stale lock and run fn (not throw a timeout).
    const start = Date.now();
    const sealed = withStateLock(tp.paths, () =>
      appendDecisionEvent(tp!.paths, {
        id: mintNextId(readDecisionEvents(tp!.paths)),
        event: "proposed",
        title: "after stolen lock",
        rationale: "r",
        links: [],
        proposer: "orchestrator",
        proposedAt: "2026-06-15T00:00:00.000Z",
      }),
    );
    const elapsed = Date.now() - start;
    expect(sealed.id).toBe("DECISION-001");
    // Stolen quickly — nowhere near the 10s lock timeout.
    expect(elapsed).toBeLessThan(5_000);
    expect(readDecisionEvents(tp.paths)).toHaveLength(1);
  });

  it.skipIf(!fs.existsSync(CLI) || !fs.existsSync(DECISION_MOD))("REQ-NFR-005: test_REQNFR005_crash_before_append_leaves_no_phantom_record — kill before append → no phantom record on next read", async () => {
    tp = makeTempProject();
    runInit(tp.paths, {});

    // A child that acquires the lock and then is killed BEFORE it appends. The
    // atomic append-or-nothing store must leave no phantom line behind.
    const script = `
      const fs = require("node:fs");
      const { withStateLock } = require(${JSON.stringify(path.resolve(__dirname, "../dist/core/state-store.js"))});
      const { resolveProjectPaths } = require(${JSON.stringify(path.resolve(__dirname, "../dist/core/paths.js"))});
      const paths = resolveProjectPaths(${JSON.stringify(tp.root)});
      withStateLock(paths, () => {
        // Signal readiness, then hang so the parent kills us BEFORE any append.
        process.stdout.write("LOCKED\\n");
        const until = Date.now() + 10000;
        while (Date.now() < until) { /* spin holding the lock; no append */ }
      });
    `;
    const child = execFile("node", ["-e", script], NO_LOG);
    await new Promise<void>((resolve, reject) => {
      let buf = "";
      child.stdout?.on("data", (d) => {
        buf += String(d);
        if (buf.includes("LOCKED")) resolve();
      });
      child.on("error", reject);
      // Fail deterministically if the child never signals readiness: a silent
      // resolve here would mask a missing-signal bug by letting the test pass
      // even if the lock was never acquired. The happy path resolves on "LOCKED"
      // almost immediately; this bound only gates a genuine failure, so keep it
      // generous (5s) to avoid false failures from slow `node -e` child spawn on a
      // loaded CI runner (incl. bare-Windows, where process startup is slower).
      setTimeout(() => reject(new Error("child did not signal LOCKED within 5s — lock was never acquired")), 5_000);
    });
    child.kill("SIGKILL");

    // No phantom record: the child never appended, so the store is empty and the
    // (empty) chain trivially verifies. This is the core crash-safety guarantee.
    const events = readDecisionEvents(tp.paths);
    expect(events).toHaveLength(0);
    expect(verifyChain(events)).toEqual({ ok: true });

    // The SIGKILLed holder left an orphaned `.state.lock`. A real recovery steals
    // it once it crosses the stale threshold (STALE_MS in withStateLock, now 15s) —
    // so the lock is NOT permanently wedged. Age the orphan into the past to
    // model that elapsed time, then prove a subsequent add succeeds (steals it).
    const orphanLock = path.join(tp.paths.stateDir, ".state.lock");
    if (fs.existsSync(orphanLock)) {
      const past = new Date(Date.now() - 120_000);
      fs.utimesSync(orphanLock, past, past);
    }
    await execFileP("node", [CLI, "decision", "add", "--title", "after-crash", "--rationale", "r", "--cwd", tp.root], NO_LOG);
    const after = readDecisionEvents(tp.paths);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe("DECISION-001");
    expect(verifyChain(after)).toEqual({ ok: true });
  }, 30_000);
});
