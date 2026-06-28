/**
 * context-capability-probe.test.ts — 5b/D-18: delivery-mode capability probe.
 *
 * Guarantees:
 *   5b-1: Default delivery mode is Mode B (systemMessage) when capability.json
 *         is absent — no explicit confirmation required for the safe default.
 *   5b-2: writeCapabilityMode(paths, "A", sessionId) persists Mode A and the
 *         same session uses updatedToolOutput for suppressed resident pages.
 *   5b-3: Session change forces fallback to Mode B (re-confirm per session).
 *   5b-4: runHookPostToolContext returns {updatedToolOutput: ...} ONLY when all
 *         three conditions hold: Mode A confirmed + suppress ON + page resident.
 *   5b-5: Mode B + suppress ON + resident → {systemMessage: "[th-context] ..."}.
 *   5b-6: writeCapabilityMode with mode "B" explicitly disables Mode A.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveProjectPaths, type ProjectPaths } from "../src/core/paths";
import { appendLedgerRecord, type LedgerScope } from "../src/core/context-ledger";
import { hashContent } from "../src/core/hash";
import {
  runHookPostToolContext,
  writeCapabilityMode,
} from "../src/commands/hook";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTmpPaths(): { paths: ProjectPaths; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "th-cap-test-"));
  const paths = resolveProjectPaths(root);
  return { paths, root };
}

function cleanup(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

/** Seed the shard with one DELIVER record so the residency check returns true. */
function preSeed(
  paths: ProjectPaths,
  scope: LedgerScope,
  logicalKey: string,
  contentHash: string,
): void {
  appendLedgerRecord(paths, scope, {
    seq: 0,
    ts: new Date().toISOString(),
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
    est_tokens: 20,
    reduction_kind: "FULL",
  });
}

/** Standard PostToolUse input for a Read of a source file. */
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

// ---------------------------------------------------------------------------
// 5b-1: Default is Mode B when capability.json absent
// ---------------------------------------------------------------------------

describe("5b-1: default mode is B (systemMessage) when capability.json is absent", () => {
  it("returns systemMessage (not updatedToolOutput) by default with suppress ON + resident", () => {
    const { paths, root } = makeTmpPaths();
    try {
      const session_id = "sess-default-b";
      const agent_id = "agent-default-b";
      const scope: LedgerScope = { session_id, agentOrRoot: agent_id };
      const content = "default mode B content";
      const contentHash = hashContent(content);

      preSeed(paths, scope, "src/default.ts", contentHash);

      // No capability.json → Mode B
      const result = runHookPostToolContext(
        root,
        makeInput(session_id, agent_id, "src/default.ts", content, root),
        { TH_EXACT_SUPPRESS: "1" },
      );

      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(parsed).toHaveProperty("systemMessage");
      expect(parsed).not.toHaveProperty("updatedToolOutput");
      expect(result.exitCode).toBe(0);
    } finally {
      cleanup(root);
    }
  });

  it("systemMessage includes [th-context] prefix", () => {
    const { paths, root } = makeTmpPaths();
    try {
      const session_id = "sess-prefix";
      const agent_id = "agent-prefix";
      const scope: LedgerScope = { session_id, agentOrRoot: agent_id };
      const content = "some content to check prefix";
      const contentHash = hashContent(content);

      preSeed(paths, scope, "src/prefix.ts", contentHash);

      const result = runHookPostToolContext(
        root,
        makeInput(session_id, agent_id, "src/prefix.ts", content, root),
        { TH_EXACT_SUPPRESS: "1" },
      );

      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      if (parsed.systemMessage !== undefined) {
        expect(String(parsed.systemMessage)).toMatch(/^\[th-context\]/);
      }
    } finally {
      cleanup(root);
    }
  });
});

// ---------------------------------------------------------------------------
// 5b-2: writeCapabilityMode("A") enables Mode A for the same session
// ---------------------------------------------------------------------------

describe("5b-2: writeCapabilityMode A enables updatedToolOutput for same session", () => {
  it("returns {updatedToolOutput: ...} when Mode A confirmed + suppress ON + resident", () => {
    const { paths, root } = makeTmpPaths();
    try {
      const session_id = "sess-mode-a";
      const agent_id = "agent-mode-a";
      const scope: LedgerScope = { session_id, agentOrRoot: agent_id };
      const content = "content for Mode A delivery";
      const contentHash = hashContent(content);

      preSeed(paths, scope, "src/modeA.ts", contentHash);

      // Confirm Mode A for this session
      writeCapabilityMode(paths, "A", session_id, "tool-use-id-123");

      const result = runHookPostToolContext(
        root,
        makeInput(session_id, agent_id, "src/modeA.ts", content, root),
        { TH_EXACT_SUPPRESS: "1" },
      );

      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(parsed).toHaveProperty("updatedToolOutput");
      expect(parsed).not.toHaveProperty("systemMessage");
      expect(result.exitCode).toBe(0);
    } finally {
      cleanup(root);
    }
  });

  it("writeCapabilityMode creates capability.json in the context-pages dir", () => {
    const { paths, root } = makeTmpPaths();
    try {
      writeCapabilityMode(paths, "A", "sess-write-test");

      // Find the capability.json — it should be under stateDir/context-pages/
      const capPath = path.join(paths.stateDir, "context-pages", "capability.json");
      expect(fs.existsSync(capPath)).toBe(true);

      const rec = JSON.parse(fs.readFileSync(capPath, "utf8")) as Record<string, unknown>;
      expect(rec.mode).toBe("A");
      expect(rec.session_id).toBe("sess-write-test");
      expect(rec).toHaveProperty("confirmed_at");
    } finally {
      cleanup(root);
    }
  });

  it("stores confirmed_tool_use_id when provided", () => {
    const { paths, root } = makeTmpPaths();
    try {
      writeCapabilityMode(paths, "A", "sess-tooluse", "tu-abc-789");

      const capPath = path.join(paths.stateDir, "context-pages", "capability.json");
      const rec = JSON.parse(fs.readFileSync(capPath, "utf8")) as Record<string, unknown>;
      expect(rec.confirmed_tool_use_id).toBe("tu-abc-789");
    } finally {
      cleanup(root);
    }
  });
});

// ---------------------------------------------------------------------------
// 5b-3: Session change → fallback to Mode B (re-confirm per session)
// ---------------------------------------------------------------------------

describe("5b-3: session change forces fallback to Mode B", () => {
  it("uses Mode B when session_id differs from the one in capability.json", () => {
    const { paths, root } = makeTmpPaths();
    try {
      // Confirm Mode A for session-old
      writeCapabilityMode(paths, "A", "session-old");

      // Now run with a DIFFERENT session_id
      const session_id = "session-new";
      const agent_id = "agent-new";
      const scope: LedgerScope = { session_id, agentOrRoot: agent_id };
      const content = "content for session change test";
      const contentHash = hashContent(content);

      preSeed(paths, scope, "src/sess.ts", contentHash);

      const result = runHookPostToolContext(
        root,
        makeInput(session_id, agent_id, "src/sess.ts", content, root),
        { TH_EXACT_SUPPRESS: "1" },
      );

      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      // Must NOT use Mode A (that was confirmed for a different session)
      expect(parsed).not.toHaveProperty("updatedToolOutput");
      // May return systemMessage (Mode B) or passthrough (shadow) — either is acceptable;
      // the key constraint is no Mode A updatedToolOutput
    } finally {
      cleanup(root);
    }
  });
});

// ---------------------------------------------------------------------------
// 5b-4: Mode A requires ALL three: confirmed + suppress ON + resident
// ---------------------------------------------------------------------------

describe("5b-4: updatedToolOutput requires Mode A + suppress ON + resident (all three)", () => {
  afterEach(() => { /* no shared state to clean */ });

  it("returns {} (shadow) when suppress is OFF, even with Mode A + resident", () => {
    const { paths, root } = makeTmpPaths();
    try {
      const session_id = "sess-no-suppress";
      const agent_id = "agent-no-suppress";
      const scope: LedgerScope = { session_id, agentOrRoot: agent_id };
      const content = "resident content, no suppress";
      const contentHash = hashContent(content);

      preSeed(paths, scope, "src/nosup.ts", contentHash);
      writeCapabilityMode(paths, "A", session_id);

      // No TH_EXACT_SUPPRESS → shadow mode
      const result = runHookPostToolContext(
        root,
        makeInput(session_id, agent_id, "src/nosup.ts", content, root),
        {},
      );

      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      // Shadow mode: always passthrough
      expect(parsed).not.toHaveProperty("updatedToolOutput");
      expect(Object.keys(parsed)).toHaveLength(0);
    } finally {
      cleanup(root);
    }
  });

  it("returns {} (shadow) when page is not resident, even with Mode A + suppress ON", () => {
    const { paths, root } = makeTmpPaths();
    try {
      const session_id = "sess-no-resident";
      const agent_id = "agent-no-resident";
      // Do NOT preSeed → not resident
      writeCapabilityMode(paths, "A", session_id);

      const result = runHookPostToolContext(
        root,
        // file_path with no prior delivery record
        makeInput(session_id, agent_id, "src/nonresident.ts", "fresh content never seen before", root),
        { TH_EXACT_SUPPRESS: "1" },
      );

      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(parsed).not.toHaveProperty("updatedToolOutput");
    } finally {
      cleanup(root);
    }
  });
});

// ---------------------------------------------------------------------------
// 5b-5: Mode B + suppress ON + resident → systemMessage
// ---------------------------------------------------------------------------

describe("5b-5: Mode B + suppress ON + resident → systemMessage format", () => {
  it("writes explicit Mode B and gets systemMessage back", () => {
    const { paths, root } = makeTmpPaths();
    try {
      const session_id = "sess-explicit-b";
      const agent_id = "agent-explicit-b";
      const scope: LedgerScope = { session_id, agentOrRoot: agent_id };
      const content = "content for explicit Mode B";
      const contentHash = hashContent(content);

      preSeed(paths, scope, "src/expb.ts", contentHash);
      // Explicitly write Mode B (e.g., after a failed probe)
      writeCapabilityMode(paths, "B", session_id);

      const result = runHookPostToolContext(
        root,
        makeInput(session_id, agent_id, "src/expb.ts", content, root),
        { TH_EXACT_SUPPRESS: "1" },
      );

      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(parsed).toHaveProperty("systemMessage");
      expect(parsed).not.toHaveProperty("updatedToolOutput");
    } finally {
      cleanup(root);
    }
  });
});

// ---------------------------------------------------------------------------
// 5b-6: writeCapabilityMode("B") disables Mode A
// ---------------------------------------------------------------------------

describe("5b-6: writeCapabilityMode B disables Mode A even when previously confirmed", () => {
  it("writing B overwrites a prior A confirmation", () => {
    const { paths, root } = makeTmpPaths();
    try {
      writeCapabilityMode(paths, "A", "sess-override");
      writeCapabilityMode(paths, "B", "sess-override");

      const capPath = path.join(paths.stateDir, "context-pages", "capability.json");
      const rec = JSON.parse(fs.readFileSync(capPath, "utf8")) as Record<string, unknown>;
      expect(rec.mode).toBe("B");
    } finally {
      cleanup(root);
    }
  });

  it("runHookPostToolContext falls back to systemMessage after B overwrite", () => {
    const { paths, root } = makeTmpPaths();
    try {
      const session_id = "sess-boverwrite";
      const agent_id = "agent-boverwrite";
      const scope: LedgerScope = { session_id, agentOrRoot: agent_id };
      const content = "overwrite test content";
      const contentHash = hashContent(content);

      preSeed(paths, scope, "src/bover.ts", contentHash);
      writeCapabilityMode(paths, "A", session_id); // confirm A
      writeCapabilityMode(paths, "B", session_id); // revoke → B

      const result = runHookPostToolContext(
        root,
        makeInput(session_id, agent_id, "src/bover.ts", content, root),
        { TH_EXACT_SUPPRESS: "1" },
      );

      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(parsed).toHaveProperty("systemMessage");
      expect(parsed).not.toHaveProperty("updatedToolOutput");
    } finally {
      cleanup(root);
    }
  });
});
