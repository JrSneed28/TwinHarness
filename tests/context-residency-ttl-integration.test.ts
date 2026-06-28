/**
 * context-residency-ttl-integration.test.ts — issue #1 + #10 regression.
 *
 * Composes the FULL live suppression path that the two unit suites each test in
 * isolation:
 *
 *     bounded tail read (readShardRecordsTail, ≤256 records)
 *       → absolute-seq LedgerRecords
 *       → hook-computed nowTurn (runHookPostToolContext)
 *       → deriveResidency TTL check
 *       → suppress / FULL decision
 *
 * The previous code set `nowTurn = shardRecs.length`. On a shard longer than the
 * tail window the tail's records carry absolute seq values far above the tail
 * length (e.g. seq≈280 with shardRecs.length=256), so `nowTurn - seq` went
 * NEGATIVE and an expired page stayed "resident" — and, with TH_EXACT_SUPPRESS=1,
 * got suppressed. nowTurn is now the absolute seq of the newest tail record.
 *
 * These tests build a shard LONGER than the tail window and place the matching
 * page more than RESIDENCY_TTL_TURNS behind the latest absolute seq, then drive
 * the real hook. The expired page must be delivered FULL with no attestation.
 * The fresh / at-boundary controls prove suppression still fires, so a green
 * "expired ⇒ FULL" result cannot be an artifact of globally-broken suppression.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveProjectPaths, type ProjectPaths } from "../src/core/paths";
import {
  appendLedgerRecord,
  readShardRecords,
  type LedgerScope,
} from "../src/core/context-ledger";
import { hashContent } from "../src/core/hash";
import { RESIDENCY_TTL_TURNS } from "../src/core/context-residency";
import { runHookPostToolContext } from "../src/commands/hook";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpPaths(): { paths: ProjectPaths; root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "th-ttl-int-"));
  const paths = resolveProjectPaths(root);
  return { paths, root: paths.root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** Append one deliver record. appendLedgerRecord assigns the absolute seq. */
function appendDeliver(
  paths: ProjectPaths,
  scope: LedgerScope,
  logicalKey: string,
  contentHash: string,
): void {
  appendLedgerRecord(paths, scope, {
    seq: 0, // overridden by appendLedgerRecord with last.seq + 1
    ts: "2026-06-27T00:00:00.000Z",
    session_id: scope.session_id,
    agent_id: scope.agentOrRoot,
    agent_type: "claude",
    epoch: 0,
    op: "deliver",
    page_id: "p",
    logical_key: logicalKey,
    content_hash: contentHash,
    base_hash: undefined,
    complete: true,
    est_tokens: 10,
    reduction_kind: "FULL",
  });
}

/**
 * Seed a shard with `before` filler records (unique keys), then the matching
 * page, then `after` filler records. The matching page lands at absolute
 * seq=`before`; the newest record is at seq=`before + after`, so the page's true
 * age == `after`. Total records = before + 1 + after.
 */
function seedShard(
  paths: ProjectPaths,
  scope: LedgerScope,
  matchKey: string,
  matchHash: string,
  before: number,
  after: number,
): void {
  for (let i = 0; i < before; i++) {
    appendDeliver(paths, scope, `src/filler-pre-${i}.ts`, "f".repeat(64));
  }
  appendDeliver(paths, scope, matchKey, matchHash);
  for (let i = 0; i < after; i++) {
    appendDeliver(paths, scope, `src/filler-post-${i}.ts`, "f".repeat(64));
  }
}

function makeInput(
  session_id: string,
  agent_id: string,
  filePath: string,
  content: string,
  root: string,
) {
  return {
    session_id,
    agent_id,
    agent_type: "claude",
    tool_name: "Read",
    tool_input: { file_path: filePath },
    tool_response: content,
    cwd: root,
  };
}

// before=260 guarantees total > 256 (tail truncates) AND the matching record
// stays inside the 256-record tail window for every `after` value used below —
// so the buggy `nowTurn = shardRecs.length` (256) is always exercised.
const BEFORE = 260;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("issue #1/#10 — absolute-seq TTL through the live hook + bounded tail", () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => { cleanup?.(); cleanup = undefined; });

  it("an EXPIRED page (age ≫ TTL, but inside the tail) is delivered FULL — not suppressed", () => {
    const { paths, root } = makeTmpPaths();
    cleanup = () => fs.rmSync(root, { recursive: true, force: true });

    const session_id = "sess-ttl";
    const agent_id = "agent-ttl";
    const scope: LedgerScope = { session_id, agentOrRoot: agent_id };
    const content = "expired page body";
    const matchKey = "src/expired.ts";
    const matchHash = hashContent(content);

    // age = 20 (≫ TTL=12). matchSeq=260, newest seq=280, tail length=256.
    // Old code: nowTurn=256 → age = 256-260 = -4 ≤ 12 → falsely resident → suppress.
    // Fixed:    nowTurn=280 → age = 280-260 = 20 > 12 → expired → FULL.
    seedShard(paths, scope, matchKey, matchHash, BEFORE, 20);

    const result = runHookPostToolContext(
      root,
      makeInput(session_id, agent_id, matchKey, content, root),
      { TH_EXACT_SUPPRESS: "1" },
    );

    // FULL delivery: pure passthrough, no replacement emitted.
    expect(JSON.parse(result.stdout)).toEqual({});
    expect(result.exitCode).toBe(0);
    // No attestation was written for an expired page.
    const records = readShardRecords(paths, scope);
    expect(records.some((r) => r.op === "attest")).toBe(false);
  });

  it("a page exactly AT the TTL boundary (age == TTL) is still resident ⇒ suppressed", () => {
    const { paths, root } = makeTmpPaths();
    cleanup = () => fs.rmSync(root, { recursive: true, force: true });

    const session_id = "sess-ttl-edge";
    const agent_id = "agent-ttl-edge";
    const scope: LedgerScope = { session_id, agentOrRoot: agent_id };
    const content = "boundary page body";
    const matchKey = "src/boundary.ts";
    const matchHash = hashContent(content);

    // age == RESIDENCY_TTL_TURNS → resident (the `>` comparison keeps the edge in).
    seedShard(paths, scope, matchKey, matchHash, BEFORE, RESIDENCY_TTL_TURNS);

    const result = runHookPostToolContext(
      root,
      makeInput(session_id, agent_id, matchKey, content, root),
      { TH_EXACT_SUPPRESS: "1" },
    );

    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    // Default capability (no capability.json) → Mode B → systemMessage replacement.
    expect(parsed).toHaveProperty("systemMessage");
    const records = readShardRecords(paths, scope);
    expect(records.some((r) => r.op === "attest")).toBe(true);
  });

  it("a page ONE turn past the TTL boundary (age == TTL+1) is expired ⇒ FULL", () => {
    const { paths, root } = makeTmpPaths();
    cleanup = () => fs.rmSync(root, { recursive: true, force: true });

    const session_id = "sess-ttl-past";
    const agent_id = "agent-ttl-past";
    const scope: LedgerScope = { session_id, agentOrRoot: agent_id };
    const content = "one past boundary";
    const matchKey = "src/past.ts";
    const matchHash = hashContent(content);

    // age == TTL+1 → expired. Old code falsely resident (negative age); fixed → FULL.
    seedShard(paths, scope, matchKey, matchHash, BEFORE, RESIDENCY_TTL_TURNS + 1);

    const result = runHookPostToolContext(
      root,
      makeInput(session_id, agent_id, matchKey, content, root),
      { TH_EXACT_SUPPRESS: "1" },
    );

    expect(JSON.parse(result.stdout)).toEqual({});
    const records = readShardRecords(paths, scope);
    expect(records.some((r) => r.op === "attest")).toBe(false);
  });

  it("control: a FRESH page on a long shard (age 0) is still suppressed", () => {
    // Proves suppression genuinely fires on a >tail-window shard, so the
    // "expired ⇒ FULL" results above are TTL decisions, not broken suppression.
    const { paths, root } = makeTmpPaths();
    cleanup = () => fs.rmSync(root, { recursive: true, force: true });

    const session_id = "sess-fresh";
    const agent_id = "agent-fresh";
    const scope: LedgerScope = { session_id, agentOrRoot: agent_id };
    const content = "fresh page body";
    const matchKey = "src/fresh.ts";
    const matchHash = hashContent(content);

    // Matching page is the newest record (age 0) on a 281-record shard.
    seedShard(paths, scope, matchKey, matchHash, 280, 0);

    const result = runHookPostToolContext(
      root,
      makeInput(session_id, agent_id, matchKey, content, root),
      { TH_EXACT_SUPPRESS: "1" },
    );

    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed).toHaveProperty("systemMessage");
    const records = readShardRecords(paths, scope);
    expect(records.some((r) => r.op === "attest")).toBe(true);
  });
});
