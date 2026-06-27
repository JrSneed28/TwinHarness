/**
 * Cross-process approval-write concurrency (Axis-B slice-3a / BSC-7 — plan §12
 * acceptance item 4). `th approve` performs a read-modify-append against the shared
 * hash-chained `<stateDir>/approval-receipts.jsonl` under `withStateLock`
 * (commands/approve.ts:runApprove). During a parallel humanGate sign-off wave several
 * `th approve` invocations can race the SAME chain at once: each reads the tail for its
 * `prevHash`, computes a `recordHash`, and appends. Without the lock serializing that
 * read→append span, racing writers would seed the same `prevHash` and either lose all
 * but one append (last-writer-wins) or fork the chain so `verifyApprovalChain` breaks.
 *
 * This test spawns N real `node dist/cli.js approve <stage>` processes at once — one per
 * humanGate stage, all appending to the one shared ledger — and asserts the serialized
 * path holds: every approval persists (none lost), the hash chain verifies end-to-end
 * (no broken/forked link), and `readApprovalValidated` still classifies each stage
 * `valid` afterward.
 *
 * It exercises (does NOT fix) the lock-theft exposure the plan names as a tracked Axis-A
 * companion: the normal serialized path is proven green here; a stale-lock steal past
 * STALE_MS remains a separate tracked item, not addressed in this commit.
 *
 * Mirrors the racing-writers discipline of tests/concurrency.test.ts: runs against the
 * COMPILED CLI (dist/cli.js), gates the HEAVY wave on SKIP_SPAWN_HEAVY_IN_CI (so the
 * starvation-prone wave is local-only), keeps a LIGHT wave that runs EVERYWHERE (incl.
 * CI), and adds NO platform-conditional skip (the suite's single intentional skip count
 * is unchanged). Deterministic + Windows-safe (path.join, no shell).
 */

import { describe, it, expect, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import * as fs from "node:fs";
import { concurrencyEnv, makeTempProject, SKIP_SPAWN_HEAVY_IN_CI, LIGHT_SPAWN_CONCURRENCY, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { stageContract } from "../src/core/stages";
import {
  HUMAN_GATE_STAGES,
  readApprovalReceipts,
  verifyApprovalChain,
  readApprovalValidated,
} from "../src/core/approvals";

const execFileP = promisify(execFile);
const CLI = path.resolve(__dirname, "../dist/cli.js");

let tp: TempProject | undefined;
afterEach(() => {
  tp?.cleanup();
  tp = undefined;
});

/**
 * Lay down the governing artifact (`produces`) for `stage` in source so `th approve`'s
 * refuse-at-creation gate resolves the mandatory `governing_artifact_digest` and a later
 * `readApprovalValidated` re-reads the SAME artifact → `valid` (R3).
 */
function writeStageArtifact(root: string, stage: string): void {
  const rel = stageContract(stage)!.produces.replace(/\/$/, "");
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `# ${stage}\n\n- REQ-001 covered.\n`, "utf8");
}

describe("REQ-APPROVAL-LOCK-001: concurrent `th approve` writes serialize under withStateLock (BSC-7 §12)", () => {
  // NOT RUN IN CI (see SKIP_SPAWN_HEAVY_IN_CI) — this spawns the full N=8 humanGate-stage
  // wave of concurrent `node dist/cli.js approve` lock contenders, a scheduler-starvation
  // false-red on windows-latest exactly like the drift/verify heavy waves. Runs on every
  // local `npm test`. (skipIf dist absent → degrade gracefully, TEST-008/009.)
  it.skipIf(!fs.existsSync(CLI) || SKIP_SPAWN_HEAVY_IN_CI)(
    "N parallel `th approve <stage>` writes all persist with an intact hash-chain (no lost/forked approval)",
    async () => {
      tp = makeTempProject();
      runInit(tp.paths, {});

      // One approval per humanGate stage — N distinct stages racing the ONE shared chain.
      const stages = [...HUMAN_GATE_STAGES];
      const N = stages.length; // 8
      for (const stage of stages) writeStageArtifact(tp.root, stage);

      await Promise.all(
        stages.map((stage) =>
          execFileP("node", [CLI, "approve", stage, "--cwd", tp!.root], { env: concurrencyEnv() }),
        ),
      );

      // No lost append: every racing writer's approval landed on the shared ledger.
      const receipts = readApprovalReceipts(tp.paths);
      expect(receipts).toHaveLength(N);
      expect(new Set(receipts.map((r) => r.stage)).size).toBe(N); // each distinct stage present

      // The serialized appends sealed ONE intact chain — no fork, no duplicate prevHash.
      expect(verifyApprovalChain(receipts)).toEqual({ ok: true });

      // And the validator still classifies every stage `valid` (content + chain pass).
      for (const stage of stages) {
        expect(readApprovalValidated(tp.paths, stage).status).toBe("valid");
      }
    },
    120_000,
  );

  // LIGHT cross-process wave that runs EVERYWHERE (incl. CI): LIGHT_SPAWN_CONCURRENCY (3)
  // concurrent `th approve` processes — low enough that even an oversubscribed CI runner
  // cannot scheduler-starve a waiter past the 90s TH_LOCK_TIMEOUT_MS, yet it still
  // exercises the COMPILED CLI + real OS file lock serializing concurrent appends to the
  // shared approval chain. Proves the same no-lost-update / intact-chain invariant the
  // heavy wave does, without the starvation exposure. (skipIf dist absent → TEST-008/009.)
  it.skipIf(!fs.existsSync(CLI))(
    "a few parallel `th approve` writes each land with an intact chain (CI-safe)",
    async () => {
      tp = makeTempProject();
      runInit(tp.paths, {});

      const stages = [...HUMAN_GATE_STAGES].slice(0, LIGHT_SPAWN_CONCURRENCY); // 3 distinct stages
      const N = stages.length;
      for (const stage of stages) writeStageArtifact(tp.root, stage);

      await Promise.all(
        stages.map((stage) =>
          execFileP("node", [CLI, "approve", stage, "--cwd", tp!.root], { env: concurrencyEnv() }),
        ),
      );

      const receipts = readApprovalReceipts(tp.paths);
      expect(receipts).toHaveLength(N); // none lost through the real OS lock + compiled CLI
      expect(new Set(receipts.map((r) => r.stage)).size).toBe(N);
      expect(verifyApprovalChain(receipts)).toEqual({ ok: true }); // one intact chain, no fork
      for (const stage of stages) {
        expect(readApprovalValidated(tp.paths, stage).status).toBe("valid");
      }
    },
    120_000,
  );
});
