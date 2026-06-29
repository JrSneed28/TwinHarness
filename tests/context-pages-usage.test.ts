/**
 * context-pages-usage.test.ts — finding #4 regression.
 *
 * The storage report and the new `usage` op must account for the FULL
 * context-pages footprint — cold objects PLUS the append-only ledger and
 * telemetry metadata — against an AGGREGATE cap. Metadata-only mode (0 cold
 * bytes) must no longer report an effectively-empty store while ledger/telemetry
 * grow unbounded.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveProjectPaths, type ProjectPaths } from "../src/core/paths";
import { appendLedgerRecord, type LedgerScope } from "../src/core/context-ledger";
import { recordTelemetry, TELEMETRY_SCHEMA_VERSION } from "../src/core/context-telemetry";
import { runContextPagesCommand, storageReport } from "../src/commands/context-pages";

function makeTmp(): { paths: ProjectPaths; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "th-usage-"));
  return { paths: resolveProjectPaths(root), root };
}

const SCOPE: LedgerScope = { session_id: "s1", agentOrRoot: "agent-A" };

function seedMetadata(paths: ProjectPaths, n: number) {
  for (let i = 0; i < n; i++) {
    appendLedgerRecord(paths, SCOPE, {
      seq: 0, ts: "2026-06-27T00:00:00.000Z", session_id: "s1", agent_id: "agent-A",
      agent_type: "claude", epoch: 0, op: "deliver", page_id: `p${i}`,
      logical_key: `src/file-${i}.ts`, content_hash: "a".repeat(64), base_hash: undefined,
      complete: true, est_tokens: 10, reduction_kind: "FULL",
    });
    recordTelemetry(paths, {
      schema_version: TELEMETRY_SCHEMA_VERSION, ts: "2026-06-27T00:00:00.000Z",
      session_id: "s1", epoch: 0, tool_type: "Read", orig_tokens: 100,
    });
  }
}

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; });

describe("finding #4 — aggregate storage accounting includes append-only metadata", () => {
  it("metadata-only mode reports ledger + telemetry bytes (not an empty store)", () => {
    const { paths, root } = makeTmp();
    cleanup = () => fs.rmSync(root, { recursive: true, force: true });

    seedMetadata(paths, 20);
    const s = storageReport(paths);

    expect(s.cold_bytes).toBe(0); // metadata-only: nothing in the cold store
    expect(s.ledger_bytes).toBeGreaterThan(0);
    expect(s.telemetry_bytes).toBeGreaterThan(0);
    // The aggregate total is NOT zero even though cold storage is empty (#4).
    expect(s.total_bytes).toBeGreaterThan(0);
    expect(s.metadata_bytes).toBeGreaterThanOrEqual(s.ledger_bytes + s.telemetry_bytes);
    expect(s.total_bytes).toBeGreaterThanOrEqual(s.metadata_bytes);
  });

  it("usage op surfaces aggregate cap, breakdown, and append-only disclosure", () => {
    const { paths, root } = makeTmp();
    cleanup = () => fs.rmSync(root, { recursive: true, force: true });

    seedMetadata(paths, 5);
    const res = runContextPagesCommand("usage", {}, paths);
    expect(res.ok).toBe(true);
    const data = res.data as { storage: Record<string, number>; append_only: string[]; guidance: string };

    expect(data.storage.aggregate_max_bytes).toBeGreaterThan(0);
    expect(data.storage.total_bytes).toBeGreaterThan(0);
    // Honest disclosure that ledger/telemetry are append-only (GC won't reclaim them).
    expect(data.append_only).toContain("ledger-*.jsonl");
    expect(data.append_only).toContain("telemetry.jsonl");
    expect(typeof data.guidance).toBe("string");
  });

  it("aggregate_over_cap flips when the tree exceeds a small aggregate cap", () => {
    const { paths, root } = makeTmp();
    cleanup = () => fs.rmSync(root, { recursive: true, force: true });
    const prev = process.env.TH_CONTEXT_TOTAL_MAX_BYTES;
    process.env.TH_CONTEXT_TOTAL_MAX_BYTES = "100"; // 100 bytes — easily exceeded
    try {
      seedMetadata(paths, 10);
      const s = storageReport(paths);
      expect(s.total_bytes).toBeGreaterThan(100);
      expect(s.aggregate_over_cap).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.TH_CONTEXT_TOTAL_MAX_BYTES;
      else process.env.TH_CONTEXT_TOTAL_MAX_BYTES = prev;
    }
  });
});
