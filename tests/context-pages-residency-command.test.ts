/**
 * context-pages-residency-command.test.ts — finding #3 regression.
 *
 * `th context-pages residency` must report ACTUAL live residency: it runs the
 * same deriveResidency logic the PostToolUse hook runs (current epoch, TTL,
 * absolute sequence, agent/root scope, content-hash match), not a raw
 * "op === deliver" projection. A page beyond TTL, in a prior epoch, in the root
 * shard, or superseded by a newer content hash must NOT be reported "resident".
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveProjectPaths, type ProjectPaths } from "../src/core/paths";
import {
  appendLedgerRecord,
  readShardRecordsTail,
  type LedgerScope,
  type LedgerOp,
} from "../src/core/context-ledger";
import {
  deriveResidency,
  currentEpoch,
  RESIDENCY_TTL_TURNS,
} from "../src/core/context-residency";
import { runContextPagesCommand } from "../src/commands/context-pages";

function makeTmpPaths(): { paths: ProjectPaths; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "th-residency-cmd-"));
  return { paths: resolveProjectPaths(root), root };
}

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; });

interface SeedRec {
  scope: LedgerScope;
  agent_id: string;
  logical_key: string;
  content_hash: string;
  epoch?: number;
  op?: LedgerOp;
  complete?: boolean;
}

/** Append a deliver record (seq is auto-assigned per shard). */
function seed(paths: ProjectPaths, r: SeedRec) {
  return appendLedgerRecord(paths, r.scope, {
    seq: 0,
    ts: "2026-06-27T00:00:00.000Z",
    session_id: r.scope.session_id,
    agent_id: r.agent_id,
    agent_type: "claude",
    epoch: r.epoch ?? 0,
    op: r.op ?? "deliver",
    page_id: `${r.logical_key}@${r.content_hash.slice(0, 6)}`,
    logical_key: r.logical_key,
    content_hash: r.content_hash,
    base_hash: undefined,
    complete: r.complete ?? true,
    est_tokens: 10,
    reduction_kind: "FULL",
  });
}

function residency(paths: ProjectPaths, args: Record<string, unknown> = {}) {
  const res = runContextPagesCommand("residency", args, paths);
  const data = res.data as { resident_count: number; pages: Array<Record<string, unknown>> };
  return { res, data };
}

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const AGENT_SCOPE: LedgerScope = { session_id: "s1", agentOrRoot: "agent-A" };

describe("finding #3 — residency reflects live suppression, not a deliver projection", () => {
  it("delivered page within TTL appears resident", () => {
    const { paths, root } = makeTmpPaths();
    cleanup = () => fs.rmSync(root, { recursive: true, force: true });

    seed(paths, { scope: AGENT_SCOPE, agent_id: "agent-A", logical_key: "src/a.ts", content_hash: HASH_A });

    const { data } = residency(paths);
    expect(data.pages.length).toBe(1);
    expect(data.pages[0]!.status).toBe("resident");
    expect(data.resident_count).toBe(1);
  });

  it("page one turn beyond TTL is NOT resident (expired_ttl)", () => {
    const { paths, root } = makeTmpPaths();
    cleanup = () => fs.rmSync(root, { recursive: true, force: true });

    // The page under test (seq 0), then enough filler appends to push nowTurn
    // (= max seq) strictly more than RESIDENCY_TTL_TURNS beyond seq 0.
    seed(paths, { scope: AGENT_SCOPE, agent_id: "agent-A", logical_key: "src/a.ts", content_hash: HASH_A });
    for (let i = 0; i < RESIDENCY_TTL_TURNS + 1; i++) {
      seed(paths, { scope: AGENT_SCOPE, agent_id: "agent-A", logical_key: `src/filler-${i}.ts`, content_hash: "c".repeat(64) });
    }

    const { data } = residency(paths);
    const page = data.pages.find((p) => p.logical_key === "src/a.ts")!;
    expect(page.status).toBe("expired_ttl");
    expect(data.resident_count).toBe(RESIDENCY_TTL_TURNS + 1); // the in-window fillers stay resident
  });

  it("prior-epoch page is NOT resident (prior_epoch)", () => {
    const { paths, root } = makeTmpPaths();
    cleanup = () => fs.rmSync(root, { recursive: true, force: true });

    // Record stamped epoch 5; current epoch (no epoch.json) is 0 → mismatch.
    seed(paths, { scope: AGENT_SCOPE, agent_id: "agent-A", logical_key: "src/a.ts", content_hash: HASH_A, epoch: 5 });
    expect(currentEpoch(paths).epoch).toBe(0);

    const { data } = residency(paths);
    expect(data.pages[0]!.status).toBe("prior_epoch");
    expect(data.resident_count).toBe(0);
  });

  it("root-shard page is observed but NOT suppressible", () => {
    const { paths, root } = makeTmpPaths();
    cleanup = () => fs.rmSync(root, { recursive: true, force: true });

    // Root scope: agentOrRoot "root", agent_id "" (as the live hook writes it).
    seed(paths, {
      scope: { session_id: "s1", agentOrRoot: "root" },
      agent_id: "",
      logical_key: "src/a.ts",
      content_hash: HASH_A,
    });

    const { data } = residency(paths);
    expect(data.pages[0]!.scope).toBe("root");
    expect(data.pages[0]!.status).toBe("root_not_suppressible");
    expect(data.resident_count).toBe(0); // not suppressible → not counted resident
  });

  it("agent A's page is not resident for agent B (scope isolation)", () => {
    const { paths, root } = makeTmpPaths();
    cleanup = () => fs.rmSync(root, { recursive: true, force: true });

    seed(paths, { scope: { session_id: "s1", agentOrRoot: "agent-A" }, agent_id: "agent-A", logical_key: "src/a.ts", content_hash: HASH_A });
    seed(paths, { scope: { session_id: "s1", agentOrRoot: "agent-B" }, agent_id: "agent-B", logical_key: "src/b.ts", content_hash: HASH_B });

    const { data } = residency(paths);
    const aPage = data.pages.find((p) => p.logical_key === "src/a.ts")!;
    const bPage = data.pages.find((p) => p.logical_key === "src/b.ts")!;
    expect(aPage.agent_or_root).toBe("agent-A");
    expect(bPage.agent_or_root).toBe("agent-B");
    // A's page never appears under B's scope and vice-versa.
    expect(data.pages.filter((p) => p.logical_key === "src/a.ts").every((p) => p.agent_or_root === "agent-A")).toBe(true);
  });

  it("newer content hash invalidates the older logical-key version", () => {
    const { paths, root } = makeTmpPaths();
    cleanup = () => fs.rmSync(root, { recursive: true, force: true });

    seed(paths, { scope: AGENT_SCOPE, agent_id: "agent-A", logical_key: "src/a.ts", content_hash: HASH_A });
    seed(paths, { scope: AGENT_SCOPE, agent_id: "agent-A", logical_key: "src/a.ts", content_hash: HASH_B });

    const { data } = residency(paths);
    const older = data.pages.find((p) => p.content_hash === HASH_A)!;
    const newer = data.pages.find((p) => p.content_hash === HASH_B)!;
    expect(newer.status).toBe("resident");
    expect(older.status).toBe("invalidated");
  });

  it("command resident decision matches a direct live deriveResidency call", () => {
    const { paths, root } = makeTmpPaths();
    cleanup = () => fs.rmSync(root, { recursive: true, force: true });

    const rec = seed(paths, { scope: AGENT_SCOPE, agent_id: "agent-A", logical_key: "src/a.ts", content_hash: HASH_A });

    // Reproduce the EXACT inputs runHookPostToolContext feeds deriveResidency.
    const tail = readShardRecordsTail(paths, AGENT_SCOPE, 256);
    const nowTurn = tail.length > 0 ? tail[tail.length - 1]!.seq : 0;
    const live = deriveResidency(tail, AGENT_SCOPE, rec.logical_key, rec.content_hash, currentEpoch(paths).epoch, nowTurn);

    const { data } = residency(paths);
    const page = data.pages.find((p) => p.logical_key === "src/a.ts")!;
    expect(page.status === "resident").toBe(live.resident);
  });
});
