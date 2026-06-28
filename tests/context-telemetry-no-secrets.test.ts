/**
 * T3 — context-telemetry: no secrets in telemetry.jsonl (S0 probe counters).
 *
 * Key invariants:
 *  - A TelemetryRecord built from secret-bearing input contains no raw secret
 *    substring in its serialized form (only hashes/counts).
 *  - recordTelemetry writes a valid JSONL line containing no raw secret.
 *  - recordTelemetry is fail-safe: I/O errors never throw.
 *  - S0 probe counters (a/b/c) increment and reset correctly.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import {
  estimateTokens,
  recordTelemetry,
  transcriptActuals,
  readS0Probes,
  resetS0Probes,
  probeAgentIdPresentOnToolHook,
  probeSessionIdShared,
  probeSubagentStartFired,
  telemetryFilePath,
  contextPagesDir,
  type TelemetryRecord,
} from "../src/core/context-telemetry";
import { hashContent } from "../src/core/hash";
import type { ProjectPaths } from "../src/core/paths";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpPaths(): { paths: ProjectPaths; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "th-telem-"));
  const stateDir = path.join(dir, ".twinharness");
  fs.mkdirSync(stateDir, { recursive: true });
  const paths: ProjectPaths = {
    root: dir,
    stateDir,
    stateFile: path.join(stateDir, "state.json"),
    docsDir: path.join(dir, "docs"),
    driftLog: path.join(dir, "drift-log.md"),
    interviewFile: path.join(stateDir, "interview.json"),
  };
  return { paths, dir };
}

/** A realistic fake secret that must never appear verbatim in telemetry.jsonl. */
const SECRET = "AKIA_FAKE_SECRET_KEY_12345_DO_NOT_LOG";

/**
 * Build a TelemetryRecord whose content originated from the SECRET string but
 * stores ONLY a derived hash (the page_id) and a token count — never the raw secret.
 */
function buildRecordFromSecretInput(): TelemetryRecord {
  return {
    ts: new Date().toISOString(),
    session_id: "sess-test-001",
    epoch: 0,
    tier: "s0",
    // page_id is a hash of the secret — NOT the secret itself.
    page_id: hashContent(SECRET).slice(0, 12),
    orig_tokens: estimateTokens(SECRET),
    returned_tokens: 0,
    dup_detected: false,
    dup_avoided: false,
    delta_tokens: 0,
    reduction_kind: "none",
  };
}

// ---------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------

describe("T3 — estimateTokens = ceil(len / 4)", () => {
  it("empty string → 0", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("1 char → 1", () => {
    expect(estimateTokens("a")).toBe(1);
  });

  it("4 chars → 1", () => {
    expect(estimateTokens("abcd")).toBe(1);
  });

  it("5 chars → 2 (ceiling)", () => {
    expect(estimateTokens("abcde")).toBe(2);
  });

  it("100 chars → 25", () => {
    expect(estimateTokens("a".repeat(100))).toBe(25);
  });

  it("101 chars → 26 (ceiling)", () => {
    expect(estimateTokens("a".repeat(101))).toBe(26);
  });
});

// ---------------------------------------------------------------------------
// Secret-free guarantee
// ---------------------------------------------------------------------------

describe("T3 — no secrets in TelemetryRecord or telemetry.jsonl", () => {
  it("a record built from secret-bearing input contains no raw secret substring", () => {
    const rec = buildRecordFromSecretInput();
    expect(JSON.stringify(rec)).not.toContain(SECRET);
  });

  it("recordTelemetry writes a JSONL line that contains no raw secret", () => {
    const { paths, dir } = makeTmpPaths();
    recordTelemetry(paths, buildRecordFromSecretInput());
    const file = telemetryFilePath(paths);
    expect(fs.existsSync(file)).toBe(true);
    const content = fs.readFileSync(file, "utf8");
    expect(content).not.toContain(SECRET);
  });

  it("written line is valid JSON with required fields", () => {
    const { paths } = makeTmpPaths();
    recordTelemetry(paths, buildRecordFromSecretInput());
    const content = fs.readFileSync(telemetryFilePath(paths), "utf8");
    const lines = content.split("\n").filter((l) => l.trim());
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(typeof parsed["ts"]).toBe("string");
    expect(parsed["session_id"]).toBe("sess-test-001");
    expect(parsed["epoch"]).toBe(0);
  });

  it("multiple records: none contain the secret; each appended as a separate line", () => {
    const { paths } = makeTmpPaths();
    for (let i = 0; i < 3; i++) {
      recordTelemetry(paths, buildRecordFromSecretInput());
    }
    const content = fs.readFileSync(telemetryFilePath(paths), "utf8");
    expect(content).not.toContain(SECRET);
    const lines = content.split("\n").filter((l) => l.trim());
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Directory creation + fail-safe
// ---------------------------------------------------------------------------

describe("T3 — recordTelemetry infrastructure", () => {
  it("creates the context-pages directory if it does not exist", () => {
    const { paths, dir } = makeTmpPaths();
    const cpDir = contextPagesDir(paths);
    expect(fs.existsSync(cpDir)).toBe(false);
    recordTelemetry(paths, buildRecordFromSecretInput());
    expect(fs.existsSync(cpDir)).toBe(true);
  });

  it("fail-safe: a FILE blocking the context-pages dir path does not throw", () => {
    const { paths, dir } = makeTmpPaths();
    // Create a FILE where the context-pages directory would be, so mkdirSync throws.
    const cpDir = contextPagesDir(paths);
    fs.writeFileSync(cpDir, "blocking-file");
    expect(() =>
      recordTelemetry(paths, { ts: new Date().toISOString(), session_id: "x", epoch: 0 }),
    ).not.toThrow();
  });

  it("fail-safe: appending to a read-only path does not throw", () => {
    // Construct a ProjectPaths that points into a dir we deliberately never create.
    const root = path.join(os.tmpdir(), `th-telem-nonexistent-${Date.now()}`);
    // Do NOT create the root — mkdirSync(recursive) will succeed creating it,
    // so instead point stateDir at a child of a file (guaranteed ENOTDIR).
    const blocker = path.join(os.tmpdir(), `th-blocker-${Date.now()}`);
    fs.writeFileSync(blocker, "block");
    const badPaths: ProjectPaths = {
      root,
      stateDir: path.join(blocker, "nope"),
      stateFile: path.join(blocker, "nope", "state.json"),
      docsDir: path.join(root, "docs"),
      driftLog: path.join(root, "drift-log.md"),
      interviewFile: path.join(blocker, "nope", "interview.json"),
    };
    expect(() =>
      recordTelemetry(badPaths, { ts: new Date().toISOString(), session_id: "y", epoch: 0 }),
    ).not.toThrow();
    fs.unlinkSync(blocker);
  });
});

// ---------------------------------------------------------------------------
// transcriptActuals — tolerant parser
// ---------------------------------------------------------------------------

describe("T3 — transcriptActuals (tolerant)", () => {
  it("returns undefined for a missing file", () => {
    expect(transcriptActuals(path.join(os.tmpdir(), "no-such-transcript-xyz.jsonl"))).toBeUndefined();
  });

  it("returns undefined for a file with no token fields", () => {
    const f = path.join(os.tmpdir(), `th-transcript-${Date.now()}.jsonl`);
    fs.writeFileSync(f, '{"type":"message","role":"user"}\n');
    expect(transcriptActuals(f)).toBeUndefined();
    fs.unlinkSync(f);
  });

  it("returns undefined for a fully garbled file", () => {
    const f = path.join(os.tmpdir(), `th-transcript-garbled-${Date.now()}.jsonl`);
    fs.writeFileSync(f, "not json at all\n{broken\n");
    expect(transcriptActuals(f)).toBeUndefined();
    fs.unlinkSync(f);
  });

  it("sums input_tokens and output_tokens from top-level fields", () => {
    const f = path.join(os.tmpdir(), `th-transcript-tok-${Date.now()}.jsonl`);
    fs.writeFileSync(
      f,
      [
        JSON.stringify({ input_tokens: 100, output_tokens: 50 }),
        JSON.stringify({ input_tokens: 200, output_tokens: 80 }),
        "",
      ].join("\n"),
    );
    const result = transcriptActuals(f);
    expect(result).not.toBeUndefined();
    expect(result!.input_tokens).toBe(300);
    expect(result!.output_tokens).toBe(130);
    fs.unlinkSync(f);
  });

  it("reads tokens from nested usage object", () => {
    const f = path.join(os.tmpdir(), `th-transcript-usage-${Date.now()}.jsonl`);
    fs.writeFileSync(
      f,
      JSON.stringify({ type: "message", usage: { input_tokens: 42, output_tokens: 17 } }) + "\n",
    );
    const result = transcriptActuals(f);
    expect(result).not.toBeUndefined();
    expect(result!.input_tokens).toBe(42);
    expect(result!.output_tokens).toBe(17);
    fs.unlinkSync(f);
  });

  it("records the maximum context_window seen", () => {
    const f = path.join(os.tmpdir(), `th-transcript-cw-${Date.now()}.jsonl`);
    fs.writeFileSync(
      f,
      [
        JSON.stringify({ input_tokens: 10, output_tokens: 5, context_window: 100000 }),
        JSON.stringify({ input_tokens: 20, output_tokens: 8, context_window: 200000 }),
        "",
      ].join("\n"),
    );
    const result = transcriptActuals(f);
    expect(result!.context_window).toBe(200000);
    fs.unlinkSync(f);
  });

  it("tolerates garbled lines mixed with valid lines", () => {
    const f = path.join(os.tmpdir(), `th-transcript-mixed-${Date.now()}.jsonl`);
    fs.writeFileSync(
      f,
      [
        "{broken json",
        JSON.stringify({ input_tokens: 55, output_tokens: 22 }),
        "also garbage",
        "",
      ].join("\n"),
    );
    const result = transcriptActuals(f);
    expect(result!.input_tokens).toBe(55);
    expect(result!.output_tokens).toBe(22);
    fs.unlinkSync(f);
  });
});

// ---------------------------------------------------------------------------
// S0 probe counters
// ---------------------------------------------------------------------------

describe("T3 — S0 probe counters", () => {
  beforeEach(() => {
    resetS0Probes();
  });

  it("all counters start at zero after resetS0Probes", () => {
    const p = readS0Probes();
    expect(p.agentIdPresentOnToolHooks).toBe(0);
    expect(p.sessionIdSharedAmongSubagents).toBe(0);
    expect(p.subagentStartFired).toBe(0);
  });

  it("(a) probeAgentIdPresentOnToolHook increments agentIdPresentOnToolHooks", () => {
    probeAgentIdPresentOnToolHook();
    probeAgentIdPresentOnToolHook();
    expect(readS0Probes().agentIdPresentOnToolHooks).toBe(2);
  });

  it("(b) probeSessionIdShared increments sessionIdSharedAmongSubagents", () => {
    probeSessionIdShared();
    expect(readS0Probes().sessionIdSharedAmongSubagents).toBe(1);
    probeSessionIdShared();
    expect(readS0Probes().sessionIdSharedAmongSubagents).toBe(2);
  });

  it("(c) probeSubagentStartFired increments subagentStartFired", () => {
    probeSubagentStartFired();
    probeSubagentStartFired();
    probeSubagentStartFired();
    expect(readS0Probes().subagentStartFired).toBe(3);
  });

  it("counters are independent of each other", () => {
    probeAgentIdPresentOnToolHook();
    probeSubagentStartFired();
    probeSubagentStartFired();
    const p = readS0Probes();
    expect(p.agentIdPresentOnToolHooks).toBe(1);
    expect(p.sessionIdSharedAmongSubagents).toBe(0);
    expect(p.subagentStartFired).toBe(2);
  });

  it("readS0Probes returns a snapshot (mutation does not affect the internal state)", () => {
    probeAgentIdPresentOnToolHook();
    const snap = readS0Probes() as { agentIdPresentOnToolHooks: number };
    snap.agentIdPresentOnToolHooks = 999;
    expect(readS0Probes().agentIdPresentOnToolHooks).toBe(1);
  });

  it("resetS0Probes clears all counters", () => {
    probeAgentIdPresentOnToolHook();
    probeSessionIdShared();
    probeSubagentStartFired();
    resetS0Probes();
    const p = readS0Probes();
    expect(p.agentIdPresentOnToolHooks).toBe(0);
    expect(p.sessionIdSharedAmongSubagents).toBe(0);
    expect(p.subagentStartFired).toBe(0);
  });
});
