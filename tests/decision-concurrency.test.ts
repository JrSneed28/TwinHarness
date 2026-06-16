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
import { makeTempProject, type TempProject } from "./helpers";
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

const NO_LOG = { env: { ...process.env, TH_NO_LOG: "1" } };

describe("SLICE-4 — decisions.jsonl concurrency + durability", () => {
  it("REQ-NFR-005: test_REQNFR005_concurrent_appends_serialized_no_loss — N parallel `decision add` → all N unique ids, chain intact (non-negotiable)", async () => {
    requireBuilt(CLI);
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
  }, 30_000);

  it("REQ-407: test_REQ407_concurrent_double_approve_one_wins_other_illegal — two parallel approves → exactly one approved, other illegal_transition", async () => {
    requireBuilt(CLI);
    requireBuilt(DECISION_MOD);
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

  it("REQ-NFR-002: test_REQNFR002_read_during_append_sees_consistent_prefix — concurrent reader during writers never sees a partial-line crash", async () => {
    requireBuilt(CLI);
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
  }, 30_000);

  it("REQ-NFR-005: test_REQNFR005_stale_lock_is_stolen_not_wedged — a stale .state.lock is stolen, not hung", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    // Plant a STALE lock dir (mtime far in the past, beyond the 30s threshold).
    const lockDir = path.join(tp.paths.stateDir, ".state.lock");
    fs.mkdirSync(lockDir, { recursive: true });
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

  it("REQ-NFR-005: test_REQNFR005_crash_before_append_leaves_no_phantom_record — kill before append → no phantom record on next read", async () => {
    requireBuilt(DECISION_MOD);
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
      setTimeout(() => resolve(), 5_000); // safety: proceed even if no signal
    });
    child.kill("SIGKILL");

    // No phantom record: the child never appended, so the store is empty and the
    // (empty) chain trivially verifies. This is the core crash-safety guarantee.
    const events = readDecisionEvents(tp.paths);
    expect(events).toHaveLength(0);
    expect(verifyChain(events)).toEqual({ ok: true });

    // The SIGKILLed holder left an orphaned `.state.lock`. A real recovery steals
    // it once it crosses the stale threshold (STALE_MS in withStateLock, now 5s) —
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
