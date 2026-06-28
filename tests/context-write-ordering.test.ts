/**
 * context-write-ordering.test.ts — PF-i: record-first ordering contract.
 *
 * Guarantees:
 *   PF-i-1: When exact_suppress is ON and a page is resident, the hook WRITES
 *            an ATTEST record BEFORE emitting any replacement output.
 *   PF-i-2: When the ATTEST write FAILS, the hook returns the original output
 *            (contextPassthrough = `{}`), and NO attest record is present in
 *            the shard.
 *   PF-i-3: When suppress is OFF (shadow), the hook always returns `{}` and
 *            only DELIVER records are written regardless of residency.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveProjectPaths, type ProjectPaths } from "../src/core/paths";
import { appendLedgerRecord, readShardRecords, type LedgerScope } from "../src/core/context-ledger";
import { hashContent } from "../src/core/hash";
import {
  runHookPostToolContext,
  _setAppendLedgerOverride,
} from "../src/commands/hook";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpPaths(): { paths: ProjectPaths; root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "th-pfi-test-"));
  const paths = resolveProjectPaths(root);
  return { paths, root: paths.root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** Build a standard PostToolUse input that maps to source_kind="file". */
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

/** Pre-populate the shard so deriveResidency finds a prior deliver record. */
function preSeed(
  paths: ProjectPaths,
  scope: LedgerScope,
  logicalKey: string,
  contentHash: string,
): void {
  appendLedgerRecord(paths, scope, {
    seq: 0,
    ts: "2026-06-27T00:00:00.000Z",
    session_id: scope.session_id,
    agent_id: scope.agentOrRoot,
    agent_type: "claude",
    epoch: 0,
    op: "deliver",
    page_id: "seeded",
    logical_key: logicalKey,
    content_hash: contentHash,
    base_hash: undefined,
    complete: true,
    est_tokens: 10,
    reduction_kind: "FULL",
  });
}

// ---------------------------------------------------------------------------
// PF-i-1: suppress ON + resident → attest record written before replacement emitted
// ---------------------------------------------------------------------------

describe("PF-i-1: when suppress is ON and page is resident, ATTEST is written first", () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => { cleanup?.(); cleanup = undefined; });

  it("writes an attest record and returns updatedToolOutput (Mode A confirmed) on suppress", () => {
    const { paths, root } = makeTmpPaths();
    cleanup = () => fs.rmSync(path.dirname(paths.stateDir), { recursive: true, force: true });
    // Correct cleanup reference
    cleanup = () => fs.rmSync(root, { recursive: true, force: true });

    const session_id = "sess-pfi";
    const agent_id = "agent-pfi";
    const scope: LedgerScope = { session_id, agentOrRoot: agent_id };
    const content = "hello from foo.ts";
    const contentHash = hashContent(content);
    // logical_key for Read + file_path="src/foo.ts" is "src/foo.ts"
    const logicalKey = "src/foo.ts";

    // Seed with a prior deliver record so residency check returns true
    preSeed(paths, scope, logicalKey, contentHash);

    // Confirm Mode A so the hook uses updatedToolOutput
    const capPath = path.join(paths.stateDir, "context-pages", "capability.json");
    fs.mkdirSync(path.dirname(capPath), { recursive: true });
    fs.writeFileSync(capPath, JSON.stringify({
      mode: "A",
      session_id,
      confirmed_at: "2026-06-27T00:00:00.000Z",
    }), "utf8");

    const input = makeInput(session_id, agent_id, "src/foo.ts", content, root);
    const result = runHookPostToolContext(root, input, {
      TH_EXACT_SUPPRESS: "1",
    });

    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    // Should have updatedToolOutput (replacement was emitted)
    expect(parsed).toHaveProperty("updatedToolOutput");
    expect(result.exitCode).toBe(0);

    // ATTEST record must be in the shard
    const records = readShardRecords(paths, scope);
    expect(records.some((r) => r.op === "attest")).toBe(true);
    // No deliver record appended by this call (suppress path skips deliver)
    const delivers = records.filter((r) => r.op === "deliver");
    // Only the seeded deliver exists (from preSeed), not a new one
    expect(delivers).toHaveLength(1);
    expect(delivers[0]?.logical_key).toBe(logicalKey);
  });

  it("returns Mode B systemMessage when capability.json is absent (default)", () => {
    const { paths, root } = makeTmpPaths();
    cleanup = () => fs.rmSync(root, { recursive: true, force: true });

    const session_id = "sess-pfi-b";
    const agent_id = "agent-pfi-b";
    const scope: LedgerScope = { session_id, agentOrRoot: agent_id };
    const content = "hello from bar.ts";
    const contentHash = hashContent(content);

    preSeed(paths, scope, "src/bar.ts", contentHash);

    const input = makeInput(session_id, agent_id, "src/bar.ts", content, root);
    const result = runHookPostToolContext(root, input, {
      TH_EXACT_SUPPRESS: "1",
    });

    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    // Mode B: systemMessage, not updatedToolOutput
    expect(parsed).toHaveProperty("systemMessage");
    expect(parsed).not.toHaveProperty("updatedToolOutput");
  });
});

// ---------------------------------------------------------------------------
// PF-i-2: attest write failure → return original, NO attest in shard
// ---------------------------------------------------------------------------

describe("PF-i-2: ATTEST write failure → original output returned, no attest record", () => {
  let cleanup: (() => void) | undefined;
  let reset: (() => void) | undefined;

  afterEach(() => {
    reset?.();
    reset = undefined;
    cleanup?.();
    cleanup = undefined;
  });

  it("returns {} (passthrough) when the attest write throws", () => {
    const { paths, root } = makeTmpPaths();
    cleanup = () => fs.rmSync(root, { recursive: true, force: true });

    const session_id = "sess-pfi-fail";
    const agent_id = "agent-pfi-fail";
    const scope: LedgerScope = { session_id, agentOrRoot: agent_id };
    const content = "content that is resident";
    const contentHash = hashContent(content);

    // Seed a deliver record so residency = true
    preSeed(paths, scope, "src/baz.ts", contentHash);

    // Inject a failing attest (throws on op="attest")
    reset = _setAppendLedgerOverride((_paths, _scope, rec) => {
      if (rec.op === "attest") throw new Error("simulated disk-full for PF-i test");
      // Pass through for deliver (the pre-seed already ran, but just in case)
      return appendLedgerRecord(_paths, _scope, rec);
    });

    const input = makeInput(session_id, agent_id, "src/baz.ts", content, root);
    const result = runHookPostToolContext(root, input, {
      TH_EXACT_SUPPRESS: "1",
    });

    // PF-i: write failed → passthrough (original output), NOT a replacement
    expect(JSON.parse(result.stdout)).toEqual({});
    expect(result.exitCode).toBe(0);

    // No attest record in the shard
    const records = readShardRecords(paths, scope);
    expect(records.some((r) => r.op === "attest")).toBe(false);
  });

  it("does NOT emit updatedToolOutput when attest fails", () => {
    const { paths, root } = makeTmpPaths();
    cleanup = () => fs.rmSync(root, { recursive: true, force: true });

    const session_id = "sess-pfi-noout";
    const agent_id = "agent-pfi-noout";
    const scope: LedgerScope = { session_id, agentOrRoot: agent_id };
    const content = "another resident page";
    const contentHash = hashContent(content);

    preSeed(paths, scope, "src/qux.ts", contentHash);

    // Confirm Mode A to ensure we'd normally get updatedToolOutput
    const capPath = path.join(paths.stateDir, "context-pages", "capability.json");
    fs.mkdirSync(path.dirname(capPath), { recursive: true });
    fs.writeFileSync(capPath, JSON.stringify({
      mode: "A", session_id, confirmed_at: new Date().toISOString(),
    }), "utf8");

    reset = _setAppendLedgerOverride((_paths, _scope, rec) => {
      if (rec.op === "attest") throw new Error("disk full");
      return appendLedgerRecord(_paths, _scope, rec);
    });

    const input = makeInput(session_id, agent_id, "src/qux.ts", content, root);
    const result = runHookPostToolContext(root, input, { TH_EXACT_SUPPRESS: "1" });

    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty("updatedToolOutput");
    expect(parsed).not.toHaveProperty("systemMessage");
    expect(Object.keys(parsed)).toHaveLength(0); // pure passthrough = {}
  });
});

// ---------------------------------------------------------------------------
// PF-i-3: shadow mode (suppress OFF) → always passthrough, only deliver records
// ---------------------------------------------------------------------------

describe("PF-i-3: shadow mode (TH_EXACT_SUPPRESS not set) → always passthrough", () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => { cleanup?.(); cleanup = undefined; });

  it("returns {} and writes DELIVER (not ATTEST) even when page is resident", () => {
    const { paths, root } = makeTmpPaths();
    cleanup = () => fs.rmSync(root, { recursive: true, force: true });

    const session_id = "sess-shadow";
    const agent_id = "agent-shadow";
    const scope: LedgerScope = { session_id, agentOrRoot: agent_id };
    const content = "resident page in shadow mode";
    const contentHash = hashContent(content);

    preSeed(paths, scope, "src/shadow.ts", contentHash);

    const input = makeInput(session_id, agent_id, "src/shadow.ts", content, root);
    // No TH_EXACT_SUPPRESS → shadow mode
    const result = runHookPostToolContext(root, input, {});

    expect(JSON.parse(result.stdout)).toEqual({});
    expect(result.exitCode).toBe(0);

    // Should have TWO deliver records: the seeded one + the new shadow deliver
    const records = readShardRecords(paths, scope);
    expect(records.filter((r) => r.op === "deliver")).toHaveLength(2);
    expect(records.some((r) => r.op === "attest")).toBe(false);
  });

  it("returns {} when TH_DISABLE_CONTEXT_PAGES=1 (kill-switch)", () => {
    const { root } = makeTmpPaths();
    cleanup = () => fs.rmSync(root, { recursive: true, force: true });

    const result = runHookPostToolContext(
      root,
      makeInput("s", "a", "src/x.ts", "content", root),
      { TH_DISABLE_CONTEXT_PAGES: "1", TH_EXACT_SUPPRESS: "1" },
    );
    expect(JSON.parse(result.stdout)).toEqual({});
  });
});
