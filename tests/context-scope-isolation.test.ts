/**
 * context-scope-isolation.test.ts — issue #2 + #11 regression.
 *
 * Proves cross-agent isolation of the EXACT-suppression path in the live hook,
 * not just at the deriveResidency content layer.
 *
 * The "phantom root" hazard: a subagent tool result can arrive with no agent_id
 * (and may share the root session_id). resolveScope records such an event under
 * `root` scope for OBSERVE, so a phantom record can land in the root shard. If
 * root scope were suppressible, the real root could then be made "resident" by a
 * page only the subagent ever saw, and have that content omitted.
 *
 * The fix restricts suppression to a POSITIVELY-attributed `agent` scope (one
 * carrying an explicit agent_id). Agent shards are keyed by agent_id, so they
 * only ever hold that agent's own deliveries — immune to phantom contamination —
 * while `root` scope is recorded but never suppressed. That makes hook-order
 * races (SubagentStart vs PostToolUse) moot for suppression: no matter how a
 * record reached the root shard, the root is never suppressed against it.
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
import { runHookPostToolContext } from "../src/commands/hook";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpPaths(): { paths: ProjectPaths; root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "th-scope-iso-"));
  const paths = resolveProjectPaths(root);
  return { paths, root: paths.root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** Seed a single resident deliver record into the given scope's shard. */
function seedResident(
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

/**
 * PostToolUse input. A missing `agent_id` is left undefined, which the hook
 * treats identically to an absent key — `resolveScope` maps it to `root`.
 */
function makeInput(
  opts: { session_id: string; agent_id?: string; filePath: string; content: string; root: string },
) {
  return {
    session_id: opts.session_id,
    agent_id: opts.agent_id,
    agent_type: "claude",
    tool_name: "Read",
    tool_input: { file_path: opts.filePath },
    tool_response: opts.content,
    cwd: opts.root,
  };
}

// ---------------------------------------------------------------------------
// Root scope: recorded but never suppressed
// ---------------------------------------------------------------------------

describe("issue #2/#11 — root scope is never suppressed (phantom-root safe)", () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => { cleanup?.(); cleanup = undefined; });

  it("a resident page in the root shard does NOT suppress a bare-session (no agent_id) request", () => {
    const { paths, root } = makeTmpPaths();
    cleanup = () => fs.rmSync(root, { recursive: true, force: true });

    const session_id = "sess-root";
    const rootScope: LedgerScope = { session_id, agentOrRoot: "root" };
    const content = "root-visible content";
    const key = "src/root.ts";
    seedResident(paths, rootScope, key, hashContent(content));

    // No agent_id → resolveScope returns `root`. Page is resident in the root
    // shard, yet suppression must NOT fire for a non-agent scope.
    const result = runHookPostToolContext(
      root,
      makeInput({ session_id, filePath: key, content, root }),
      { TH_EXACT_SUPPRESS: "1" },
    );

    expect(JSON.parse(result.stdout)).toEqual({}); // FULL delivery
    expect(readShardRecords(paths, rootScope).some((r) => r.op === "attest")).toBe(false);
  });

  it("a phantom subagent page (no agent_id, shared session) written to the root shard cannot suppress the root", () => {
    const { paths, root } = makeTmpPaths();
    cleanup = () => fs.rmSync(root, { recursive: true, force: true });

    const session_id = "sess-shared"; // root and child share this id
    const rootScope: LedgerScope = { session_id, agentOrRoot: "root" };
    const content = "content only the subagent saw";
    const key = "src/shared-doc.ts";

    // Simulate the phantom: a subagent tool result with no agent_id landed in
    // the root shard (exactly what OBSERVE recording does for a bare-session id).
    seedResident(paths, rootScope, key, hashContent(content));

    // The real root later reads the same logical content (still no agent_id).
    const result = runHookPostToolContext(
      root,
      makeInput({ session_id, filePath: key, content, root }),
      { TH_EXACT_SUPPRESS: "1" },
    );

    expect(JSON.parse(result.stdout)).toEqual({}); // root receives FULL
    expect(readShardRecords(paths, rootScope).some((r) => r.op === "attest")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Agent scope: positively attributed, isolated per agent_id
// ---------------------------------------------------------------------------

describe("issue #2/#11 — agent shards are isolated and immune to cross-agent residency", () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => { cleanup?.(); cleanup = undefined; });

  it("agent A's resident page does NOT make agent B resident (different agent_id)", () => {
    const { paths, root } = makeTmpPaths();
    cleanup = () => fs.rmSync(root, { recursive: true, force: true });

    const session_id = "sess-ab";
    const scopeA: LedgerScope = { session_id, agentOrRoot: "agent-A" };
    const scopeB: LedgerScope = { session_id, agentOrRoot: "agent-B" };
    const content = "page A delivered";
    const key = "src/shared.ts";
    seedResident(paths, scopeA, key, hashContent(content));

    // Agent B requests the same logical content; B's shard is empty → FULL.
    const result = runHookPostToolContext(
      root,
      makeInput({ session_id, agent_id: "agent-B", filePath: key, content, root }),
      { TH_EXACT_SUPPRESS: "1" },
    );

    expect(JSON.parse(result.stdout)).toEqual({}); // B gets FULL
    expect(readShardRecords(paths, scopeB).some((r) => r.op === "attest")).toBe(false);
    // A's shard is untouched by B's request (still just the seed, no attest).
    expect(readShardRecords(paths, scopeA).some((r) => r.op === "attest")).toBe(false);
  });

  it("reverse direction: a page in the root shard does NOT make a subagent (agent scope) resident", () => {
    const { paths, root } = makeTmpPaths();
    cleanup = () => fs.rmSync(root, { recursive: true, force: true });

    const session_id = "sess-rev";
    const rootScope: LedgerScope = { session_id, agentOrRoot: "root" };
    const childScope: LedgerScope = { session_id, agentOrRoot: "agent-C" };
    const content = "root delivered this";
    const key = "src/y.ts";
    seedResident(paths, rootScope, key, hashContent(content));

    const result = runHookPostToolContext(
      root,
      makeInput({ session_id, agent_id: "agent-C", filePath: key, content, root }),
      { TH_EXACT_SUPPRESS: "1" },
    );

    expect(JSON.parse(result.stdout)).toEqual({}); // child gets FULL
    expect(readShardRecords(paths, childScope).some((r) => r.op === "attest")).toBe(false);
  });

  it("positive control: an agent IS suppressed against its OWN resident page", () => {
    const { paths, root } = makeTmpPaths();
    cleanup = () => fs.rmSync(root, { recursive: true, force: true });

    const session_id = "sess-self";
    const scope: LedgerScope = { session_id, agentOrRoot: "agent-self" };
    const content = "my own delivered page";
    const key = "src/self.ts";
    seedResident(paths, scope, key, hashContent(content));

    const result = runHookPostToolContext(
      root,
      makeInput({ session_id, agent_id: "agent-self", filePath: key, content, root }),
      { TH_EXACT_SUPPRESS: "1" },
    );

    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed).toHaveProperty("systemMessage"); // suppressed (Mode B default)
    expect(readShardRecords(paths, scope).some((r) => r.op === "attest")).toBe(true);
  });
});
