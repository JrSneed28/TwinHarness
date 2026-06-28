/**
 * Context epoch + compaction tests (S1; AC-4).
 *
 * Covers:
 *   AC-4: after an epoch bump, ALL prior-epoch pages are non-resident.
 *   Signal bumps: PreCompact, clear, resume each increment the epoch.
 *   Watermark bump: token total ≥ DEFAULT_WATERMARK_TOKENS ⇒ epoch bumped;
 *                   prior pages non-resident.
 *   currentEpoch: missing file returns safe default epoch 0.
 *   bumpEpoch: monotonically increments; reason is recorded.
 *   maybeCheckEpoch: session_start with new session_id bumps epoch.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveProjectPaths, type ProjectPaths } from "../src/core/paths";
import { GENESIS_PREV_HASH } from "../src/core/hash";
import {
  computeLedgerRecordHash,
  type LedgerRecord,
  type LedgerScope,
} from "../src/core/context-ledger";
import {
  deriveResidency,
  currentEpoch,
  bumpEpoch,
  maybeCheckEpoch,
  DEFAULT_WATERMARK_TOKENS,
} from "../src/core/context-residency";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpPaths(): { paths: ProjectPaths; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "th-epoch-test-"));
  const paths = resolveProjectPaths(root);
  return { paths, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function makeRecord(overrides: Partial<Omit<LedgerRecord, "recordHash">> = {}): LedgerRecord {
  const base: Omit<LedgerRecord, "recordHash"> = {
    seq: 1,
    ts: "2026-06-27T00:00:00.000Z",
    session_id: "sess-abc",
    agent_id: "agent-1",
    agent_type: "claude",
    epoch: 0,
    op: "deliver",
    page_id: "aabbccddeeff",
    logical_key: "file|src/foo.ts",
    content_hash: "a".repeat(64),
    complete: true,
    est_tokens: 100,
    reduction_kind: "FULL",
    prevHash: GENESIS_PREV_HASH,
    ...overrides,
  };
  return { ...base, recordHash: computeLedgerRecordHash(base) };
}

const DEFAULT_SCOPE: LedgerScope = { session_id: "sess-abc", agentOrRoot: "agent-1" };

// ---------------------------------------------------------------------------
// currentEpoch — safe defaults
// ---------------------------------------------------------------------------

describe("currentEpoch — file absence and defaults", () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => { cleanup?.(); });

  it("returns epoch 0 when epoch.json does not exist (fresh project)", () => {
    const tmp = makeTmpPaths();
    cleanup = tmp.cleanup;
    const rec = currentEpoch(tmp.paths);
    expect(rec.epoch).toBe(0);
    expect(rec.reason).toBe("init");
  });

  it("returns safe default when epoch.json contains malformed JSON", () => {
    const tmp = makeTmpPaths();
    cleanup = tmp.cleanup;
    const pagesRoot = path.join(tmp.paths.stateDir, "context-pages");
    fs.mkdirSync(pagesRoot, { recursive: true });
    fs.writeFileSync(path.join(pagesRoot, "epoch.json"), "{{bad json", "utf8");
    const rec = currentEpoch(tmp.paths);
    expect(rec.epoch).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// bumpEpoch — monotonic increments + reason recording
// ---------------------------------------------------------------------------

describe("bumpEpoch — monotonic increments", () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => { cleanup?.(); });

  it("increments epoch from 0 to 1 on first bump", () => {
    const tmp = makeTmpPaths();
    cleanup = tmp.cleanup;
    const newEpoch = bumpEpoch(tmp.paths, "test-bump");
    expect(newEpoch).toBe(1);
    expect(currentEpoch(tmp.paths).epoch).toBe(1);
    expect(currentEpoch(tmp.paths).reason).toBe("test-bump");
  });

  it("successive bumps are monotonically increasing", () => {
    const tmp = makeTmpPaths();
    cleanup = tmp.cleanup;
    const e1 = bumpEpoch(tmp.paths, "first");
    const e2 = bumpEpoch(tmp.paths, "second");
    const e3 = bumpEpoch(tmp.paths, "third");
    expect(e1).toBe(1);
    expect(e2).toBe(2);
    expect(e3).toBe(3);
    expect(currentEpoch(tmp.paths).epoch).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// AC-4 — after bump, ALL prior-epoch pages are non-resident
// ---------------------------------------------------------------------------

describe("AC-4 — prior-epoch pages become non-resident after bump", () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => { cleanup?.(); });

  it("page delivered at epoch 0 is resident before bump, non-resident after", () => {
    const tmp = makeTmpPaths();
    cleanup = tmp.cleanup;

    const epoch0 = currentEpoch(tmp.paths).epoch; // 0
    const rec = makeRecord({ epoch: epoch0, seq: 1 });

    // Before bump: resident
    const before = deriveResidency([rec], DEFAULT_SCOPE, "file|src/foo.ts", "a".repeat(64), epoch0, 1);
    expect(before.resident).toBe(true);
    expect(before.reason).toBe("ok");

    // Bump epoch
    bumpEpoch(tmp.paths, "compact");
    const epoch1 = currentEpoch(tmp.paths).epoch; // 1
    expect(epoch1).toBe(1);

    // After bump: the record's epoch (0) no longer matches the current epoch (1)
    const after = deriveResidency([rec], DEFAULT_SCOPE, "file|src/foo.ts", "a".repeat(64), epoch1, 1);
    expect(after.resident).toBe(false);
    expect(after.reason).toBe("epoch_mismatch");
  });

  it("multiple pages from epoch 0 are all non-resident after bump", () => {
    const tmp = makeTmpPaths();
    cleanup = tmp.cleanup;

    const epoch0 = 0;
    const records = [
      makeRecord({ epoch: epoch0, seq: 1, logical_key: "file|src/a.ts", content_hash: "a".repeat(64) }),
      makeRecord({ epoch: epoch0, seq: 2, logical_key: "file|src/b.ts", content_hash: "b".repeat(64) }),
      makeRecord({ epoch: epoch0, seq: 3, logical_key: "file|src/c.ts", content_hash: "c".repeat(64) }),
    ];

    bumpEpoch(tmp.paths, "compact");
    const epoch1 = 1;

    for (const rec of records) {
      const result = deriveResidency(
        [rec],
        DEFAULT_SCOPE,
        rec.logical_key,
        rec.content_hash,
        epoch1,
        rec.seq,
      );
      expect(result.resident).toBe(false);
      expect(result.reason).toBe("epoch_mismatch");
    }
  });

  it("new page at epoch 1 is resident after bump", () => {
    const tmp = makeTmpPaths();
    cleanup = tmp.cleanup;

    bumpEpoch(tmp.paths, "compact");
    const epoch1 = 1;

    const rec = makeRecord({ epoch: epoch1, seq: 5 });
    const result = deriveResidency([rec], DEFAULT_SCOPE, "file|src/foo.ts", "a".repeat(64), epoch1, 5);
    expect(result.resident).toBe(true);
    expect(result.reason).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// maybeCheckEpoch — signal bumps (PreCompact, clear, resume)
// ---------------------------------------------------------------------------

describe("maybeCheckEpoch — signal triggers", () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => { cleanup?.(); });

  it("PreCompact trigger bumps epoch with reason SessionStart{compact}", () => {
    const tmp = makeTmpPaths();
    cleanup = tmp.cleanup;
    const newEpoch = maybeCheckEpoch(tmp.paths, "PreCompact");
    expect(newEpoch).toBe(1);
    expect(currentEpoch(tmp.paths).reason).toBe("SessionStart{compact}");
  });

  it("clear trigger bumps epoch with reason clear", () => {
    const tmp = makeTmpPaths();
    cleanup = tmp.cleanup;
    maybeCheckEpoch(tmp.paths, "clear");
    expect(currentEpoch(tmp.paths).epoch).toBe(1);
    expect(currentEpoch(tmp.paths).reason).toBe("clear");
  });

  it("resume trigger bumps epoch with reason resume", () => {
    const tmp = makeTmpPaths();
    cleanup = tmp.cleanup;
    maybeCheckEpoch(tmp.paths, "resume");
    expect(currentEpoch(tmp.paths).epoch).toBe(1);
    expect(currentEpoch(tmp.paths).reason).toBe("resume");
  });
});

// ---------------------------------------------------------------------------
// maybeCheckEpoch — session_start (new session_id ⇒ bump)
// ---------------------------------------------------------------------------

describe("maybeCheckEpoch — session_start trigger", () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => { cleanup?.(); });

  it("does not bump on first session_start (no prior session_id)", () => {
    const tmp = makeTmpPaths();
    cleanup = tmp.cleanup;
    const epoch = maybeCheckEpoch(tmp.paths, "session_start", { session_id: "sess-001" });
    // No prior session_id stored → no bump
    expect(epoch).toBe(0);
    // session_id is now persisted
    expect(currentEpoch(tmp.paths).session_id).toBe("sess-001");
  });

  it("bumps when session_id changes", () => {
    const tmp = makeTmpPaths();
    cleanup = tmp.cleanup;
    // Establish session-001
    maybeCheckEpoch(tmp.paths, "session_start", { session_id: "sess-001" });
    expect(currentEpoch(tmp.paths).epoch).toBe(0);

    // New session — should bump
    const newEpoch = maybeCheckEpoch(tmp.paths, "session_start", { session_id: "sess-002" });
    expect(newEpoch).toBe(1);
    expect(currentEpoch(tmp.paths).reason).toBe("new_session");
  });

  it("does not bump when same session_id arrives again", () => {
    const tmp = makeTmpPaths();
    cleanup = tmp.cleanup;
    maybeCheckEpoch(tmp.paths, "session_start", { session_id: "sess-001" });
    const epoch = maybeCheckEpoch(tmp.paths, "session_start", { session_id: "sess-001" });
    expect(epoch).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// maybeCheckEpoch — watermark trigger (AC-4, token-based compaction)
// ---------------------------------------------------------------------------

describe("maybeCheckEpoch — watermark trigger", () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => { cleanup?.(); cleanup = undefined; });

  it("does not bump when transcript file is absent", () => {
    const tmp = makeTmpPaths();
    cleanup = tmp.cleanup;
    const epoch = maybeCheckEpoch(tmp.paths, "watermark", {
      transcript_path: path.join(tmp.paths.root, "nonexistent.jsonl"),
    });
    expect(epoch).toBe(0);
  });

  it("bumps when transcript tokens >= DEFAULT_WATERMARK_TOKENS", () => {
    const tmp = makeTmpPaths();
    cleanup = tmp.cleanup;

    // Write a fake transcript that sums to above the watermark
    const transcriptPath = path.join(tmp.paths.root, "transcript.jsonl");
    const line = JSON.stringify({ usage: { input_tokens: DEFAULT_WATERMARK_TOKENS, output_tokens: 1 } });
    fs.writeFileSync(transcriptPath, line + "\n", "utf8");

    const epoch = maybeCheckEpoch(tmp.paths, "watermark", { transcript_path: transcriptPath });
    expect(epoch).toBe(1);
    expect(currentEpoch(tmp.paths).reason).toMatch(/watermark/);
  });

  it("does not bump when transcript tokens < DEFAULT_WATERMARK_TOKENS", () => {
    const tmp = makeTmpPaths();
    cleanup = tmp.cleanup;

    const transcriptPath = path.join(tmp.paths.root, "transcript.jsonl");
    const line = JSON.stringify({ usage: { input_tokens: DEFAULT_WATERMARK_TOKENS - 1000, output_tokens: 0 } });
    fs.writeFileSync(transcriptPath, line + "\n", "utf8");

    const epoch = maybeCheckEpoch(tmp.paths, "watermark", { transcript_path: transcriptPath });
    expect(epoch).toBe(0);
  });

  it("respects watermark_tokens override", () => {
    const tmp = makeTmpPaths();
    cleanup = tmp.cleanup;

    const transcriptPath = path.join(tmp.paths.root, "transcript.jsonl");
    // Total = 500 tokens
    const line = JSON.stringify({ usage: { input_tokens: 300, output_tokens: 200 } });
    fs.writeFileSync(transcriptPath, line + "\n", "utf8");

    // Override watermark to 400 → should bump (500 >= 400)
    const epoch = maybeCheckEpoch(tmp.paths, "watermark", {
      transcript_path: transcriptPath,
      watermark_tokens: 400,
    });
    expect(epoch).toBe(1);

    // Reset and test non-bump at higher override
    bumpEpoch(tmp.paths, "reset-for-test");
    const epoch2 = maybeCheckEpoch(tmp.paths, "watermark", {
      transcript_path: transcriptPath,
      watermark_tokens: 1000, // 500 < 1000 → no bump
    });
    // Should be 2 (the bump we just did) — no additional bump
    expect(epoch2).toBe(2);
  });

  it("prior-epoch pages are non-resident after watermark bump", () => {
    const tmp = makeTmpPaths();
    cleanup = tmp.cleanup;

    const transcriptPath = path.join(tmp.paths.root, "transcript.jsonl");
    const line = JSON.stringify({ usage: { input_tokens: DEFAULT_WATERMARK_TOKENS, output_tokens: 1 } });
    fs.writeFileSync(transcriptPath, line + "\n", "utf8");

    // Deliver a page at epoch 0
    const rec = makeRecord({ epoch: 0, seq: 1 });
    const beforeEpoch = 0;
    const before = deriveResidency([rec], DEFAULT_SCOPE, "file|src/foo.ts", "a".repeat(64), beforeEpoch, 1);
    expect(before.resident).toBe(true);

    // Watermark bump
    const newEpoch = maybeCheckEpoch(tmp.paths, "watermark", { transcript_path: transcriptPath });
    expect(newEpoch).toBe(1);

    // Same record is now non-resident at the new epoch
    const after = deriveResidency([rec], DEFAULT_SCOPE, "file|src/foo.ts", "a".repeat(64), newEpoch, 1);
    expect(after.resident).toBe(false);
    expect(after.reason).toBe("epoch_mismatch");
  });
});
