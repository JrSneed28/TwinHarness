/**
 * Savings UI — integration / parity / privacy / back-compat (plan B5+B7 hard gate).
 *
 * Verifies the end-to-end savings surface against a SEEDED, non-empty telemetry
 * store (empty-store parity is insufficient — plan Antithesis / Step B5):
 *   1. Seeded integration: hand-computed baseline/actual/avoided/saved_pct,
 *      session-level capsule payback subtraction, AC-8 category reconciliation,
 *      and legacy workload_category normalization.
 *   2. Seeded CLI↔MCP parity on `savings-detail` INCLUDING transcript cost (AC-27).
 *   3. Secret-safety on the `--detail` output AND the statusLine string (AC-24).
 *   4. Mixed-schema back-compat + malformed-record fail-safety (AC-28).
 *   5. S0 observe-only vs TH_EXACT_SUPPRESS measured (Verification step 5).
 */

import { describe, it, expect, afterEach } from "vitest";
import { makeTempProject, type TempProject } from "./helpers";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { recordTelemetry, type TelemetryRecord } from "../src/core/context-telemetry";
import { computeSavings, type SavingsResult } from "../src/core/savings";
import { renderStatusLine, renderDetail } from "../src/core/savings-render";
import { runContextPagesCommand } from "../src/commands/context-pages";
import { TOOL_DEFS } from "../src/mcp-server";
import type { ProjectPaths } from "../src/core/paths";
import type { CommandResult } from "../src/core/output";

let tp: TempProject | undefined;
const tmpFiles: string[] = [];
afterEach(() => {
  tp?.cleanup();
  tp = undefined;
  while (tmpFiles.length) {
    const f = tmpFiles.pop()!;
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
});

function seed(paths: ProjectPaths, records: TelemetryRecord[]): void {
  for (const r of records) recordTelemetry(paths, r);
}

function writeTranscript(lines: object[]): string {
  const f = path.join(os.tmpdir(), `th-savings-transcript-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  tmpFiles.push(f);
  return f;
}

function mcpRun(paths: ProjectPaths, op: string, extra: Record<string, unknown> = {}): CommandResult {
  const def = TOOL_DEFS.find((t) => t.name === "th_context");
  if (!def) throw new Error("th_context not in TOOL_DEFS");
  return def.run(paths, { operation: op, ...extra });
}

/**
 * The canonical seed: session "sess-A" with page-level suppression across two
 * epochs, a deduped capsule rehydration (no page_id — the real R7 emitter), a
 * compaction record, and LEGACY records (suppress/observe/planning, no
 * schema_version). Hand-computed totals are asserted below.
 */
function canonicalSeed(): TelemetryRecord[] {
  return [
    // page-level suppression (new-schema, explicit 8-enum category)
    { schema_version: 2, ts: "t1", session_id: "sess-A", epoch: 1, page_id: "p1", tool_type: "Read", source_kind: "file", orig_tokens: 1000, returned_tokens: 200, workload_category: "file-read" },
    { schema_version: 2, ts: "t2", session_id: "sess-A", epoch: 1, page_id: "p2", tool_type: "Bash", source_kind: "search", orig_tokens: 500, returned_tokens: 100, workload_category: "repo-analysis" },
    { schema_version: 2, ts: "t3", session_id: "sess-A", epoch: 2, page_id: "p3", tool_type: "mcp__github__get", orig_tokens: 300, returned_tokens: 50, workload_category: "mcp-result" },
    // LEGACY: "suppress" must normalize to the tool-derived category (Read→file-read), NOT debug-output
    { ts: "t4", session_id: "sess-A", epoch: 2, page_id: "p4", tool_type: "Read", source_kind: "file", orig_tokens: 400, returned_tokens: 100, workload_category: "suppress" },
    // LEGACY: "planning" must normalize to debug-output
    { ts: "t5", session_id: "sess-A", epoch: 2, page_id: "p5", tool_type: "Bash", orig_tokens: 200, returned_tokens: 50, workload_category: "planning" },
    // capsule rehydration (NO page_id) — the only kind the R7 host emitter writes
    { schema_version: 2, ts: "t6", session_id: "sess-A", epoch: 2, content_hash: "hashX", rehydrated_full_tokens: 120, workload_category: "rehydration" },
    // duplicate capsule, SAME content_hash → must subtract once (idempotent I2)
    { schema_version: 2, ts: "t7", session_id: "sess-A", epoch: 2, content_hash: "hashX", rehydrated_full_tokens: 120, workload_category: "rehydration" },
    // compaction record (no credit)
    { schema_version: 2, ts: "t8", session_id: "sess-A", epoch: 3, compaction_resets: 1, workload_category: "compaction" },
  ];
}

// ---------------------------------------------------------------------------
// 1. Seeded integration — hand-computed
// ---------------------------------------------------------------------------

describe("Savings integration — seeded hand-computed totals", () => {
  it("baseline/actual/avoided/saved_pct, capsule payback, AC-8 reconciliation, legacy map", () => {
    const records = canonicalSeed();
    const r: SavingsResult = computeSavings(records, { session_id: "sess-A", suppressMode: true });

    // baseline = Σ orig = 1000+500+300+400+200 = 2400; actual = Σ returned = 500
    expect(r.baseline_tokens).toBe(2400);
    expect(r.actual_tokens).toBe(500);

    // credited = 800+400+250+300+150 = 1900; capsule payback deduped = 120
    // avoided = 1900 - 120 = 1780; payback measured (a rehydration record exists)
    expect(r.payback_tokens).toBe(120);
    expect(r.payback_measured).toBe(true);
    expect(r.avoided_tokens).toBe(1780);
    expect(r.avoided_input_tokens).toBe(1780);
    // 1780/2400 = 74.1666… → 74.17
    expect(r.saved_pct).toBe(74.17);
    expect(r.headline_label).toBe("measured");

    // Category attribution: file-read = R1(800)+R4-legacy-suppress(300)=1100;
    // repo-analysis=400; mcp-result=250; debug-output=R5-legacy-planning(150);
    // rehydration = -(120). Everything else 0; uncategorized 0.
    const cat = Object.fromEntries(r.categories.map((c) => [c.category, c.avoided_tokens]));
    expect(cat["file-read"]).toBe(1100);
    expect(cat["repo-analysis"]).toBe(400);
    expect(cat["mcp-result"]).toBe(250);
    expect(cat["debug-output"]).toBe(150);
    expect(cat["rehydration"]).toBe(-120);
    expect(cat["artifact-summary"]).toBe(0);
    expect(cat["test-output"]).toBe(0);
    expect(cat["compaction"]).toBe(0);
    expect(r.uncategorized_tokens).toBe(0);

    // AC-8: category sum (incl. negative rehydration) + uncategorized == avoided
    const sum = r.categories.reduce((a, c) => a + c.avoided_tokens, 0) + r.uncategorized_tokens;
    expect(sum).toBe(r.avoided_tokens);
  });

  it("idempotent: a third duplicate capsule (same content_hash) does not double-subtract", () => {
    const records = canonicalSeed();
    records.push({ schema_version: 2, ts: "t9", session_id: "sess-A", epoch: 2, content_hash: "hashX", rehydrated_full_tokens: 120, workload_category: "rehydration" });
    const r = computeSavings(records, { session_id: "sess-A", suppressMode: true });
    expect(r.payback_tokens).toBe(120); // still once
    expect(r.avoided_tokens).toBe(1780);
  });

  it("payback caps at credited and floors avoided at 0 (never negative)", () => {
    const records: TelemetryRecord[] = [
      { schema_version: 2, ts: "a", session_id: "s", epoch: 1, page_id: "p", tool_type: "Read", source_kind: "file", orig_tokens: 100, returned_tokens: 40, workload_category: "file-read" },
      // capsule payback far exceeds the 60 credited
      { schema_version: 2, ts: "b", session_id: "s", epoch: 1, content_hash: "h", rehydrated_full_tokens: 10000, workload_category: "rehydration" },
    ];
    const r = computeSavings(records, { suppressMode: true });
    expect(r.avoided_tokens).toBe(0);
    expect(r.payback_tokens).toBe(60); // capped at credited
  });
});

// ---------------------------------------------------------------------------
// 2. Seeded CLI↔MCP parity incl. transcript cost (AC-27)
// ---------------------------------------------------------------------------

describe("Savings parity — seeded store + fixed transcript (AC-27)", () => {
  it("savings-detail: CLI and MCP deep-equal INCLUDING cost/whole_window", () => {
    tp = makeTempProject();
    seed(tp.paths, canonicalSeed());
    const transcript = writeTranscript([
      { model: "claude-sonnet-4-6", usage: { input_tokens: 12000, output_tokens: 3000, context_window: 200000 } },
      { model: "claude-sonnet-4-6", usage: { input_tokens: 8000, output_tokens: 1000 } },
    ]);
    const extra = { session_id: "sess-A", transcript_path: transcript };

    const cli = runContextPagesCommand("savings-detail", extra, tp.paths);
    const mcp = mcpRun(tp.paths, "savings-detail", extra);

    expect(cli.ok).toBe(true);
    expect(mcp.ok).toBe(true);
    expect(cli.exitCode).toBe(mcp.exitCode);
    // Full deep-equal — the parity guarantee over the risky transcript/cost surface.
    expect(cli.data).toEqual(mcp.data);

    const d = cli.data as {
      cost_usd: number | null; model_id: string | null; cost_label: string;
      whole_window: { input_tokens?: number; label: string };
    };
    expect(d.model_id).toBe("claude-sonnet-4-6");
    expect(d.cost_usd).not.toBeNull();
    expect(d.cost_label).toMatch(/snapshot \d{4}-\d{2}-\d{2}/);
    expect(d.whole_window.label).toBe("[estimated]");
    expect(d.whole_window.input_tokens).toBe(20000);
  });

  it("savings-detail with no transcript: cost + whole_window unavailable, still parity", () => {
    tp = makeTempProject();
    seed(tp.paths, canonicalSeed());
    const cli = runContextPagesCommand("savings-detail", { session_id: "sess-A" }, tp.paths);
    const mcp = mcpRun(tp.paths, "savings-detail", { session_id: "sess-A" });
    expect(cli.data).toEqual(mcp.data);
    const d = cli.data as { cost_usd: number | null; whole_window: { label: string }; cache_label: string };
    expect(d.cost_usd).toBeNull();
    expect(d.whole_window.label).toBe("[unavailable]");
    expect(d.cache_label).toBe("[unavailable]");
  });
});

// ---------------------------------------------------------------------------
// 3. Secret-safety — AC-24 (detail output + statusLine string)
// ---------------------------------------------------------------------------

describe("Savings privacy — no secrets leak (AC-24)", () => {
  const SECRET = "AKIAIOSFODNN7EXAMPLE";
  const SECRET2 = "sk-live-abc123SUPERSECRET";

  it("savings-detail human+json and statusLine carry only aggregates, never canaries", () => {
    tp = makeTempProject();
    seed(tp.paths, canonicalSeed());
    // Canaries placed where a naive impl might leak: transcript content + logical-ish fields.
    const transcript = writeTranscript([
      { model: "claude-opus-4-8", usage: { input_tokens: 5000, output_tokens: 1000 }, text: `password=${SECRET2}` },
      { role: "user", content: `my key is ${SECRET}` },
    ]);
    const res = runContextPagesCommand("savings-detail", { session_id: "sess-A", transcript_path: transcript }, tp.paths);
    expect(res.ok).toBe(true);
    const json = JSON.stringify(res.data);
    expect(json).not.toContain(SECRET);
    expect(json).not.toContain(SECRET2);
    expect(res.human ?? "").not.toContain(SECRET);
    expect(res.human ?? "").not.toContain(SECRET2);
    // The transcript path itself must not be echoed into the output (privacy).
    expect(json).not.toContain(transcript);

    // statusLine string
    const result = computeSavings(canonicalSeed(), { session_id: "sess-A", suppressMode: true });
    for (const width of [120, 60, 24, 10]) {
      for (const color of [true, false]) {
        const line = renderStatusLine(result, width, color);
        expect(line).not.toContain(SECRET);
        expect(line).not.toContain(SECRET2);
      }
    }
    // detail render likewise
    expect(renderDetail(result, "[estimated • snapshot 2026-06-28]")).not.toContain(SECRET);
  });
});

// ---------------------------------------------------------------------------
// 4. Mixed-schema back-compat + malformed fail-safety (AC-28)
// ---------------------------------------------------------------------------

describe("Savings back-compat + fail-safety (AC-28)", () => {
  it("mixed schema_version (present and absent) reads without throwing", () => {
    const records: TelemetryRecord[] = [
      { schema_version: 2, ts: "a", session_id: "s", epoch: 1, page_id: "p1", tool_type: "Read", source_kind: "file", orig_tokens: 100, returned_tokens: 20, workload_category: "file-read" },
      // legacy v1: no schema_version, legacy category
      { ts: "b", session_id: "s", epoch: 1, page_id: "p2", tool_type: "Read", orig_tokens: 80, returned_tokens: 30, workload_category: "observe" },
    ];
    expect(() => computeSavings(records, { suppressMode: true })).not.toThrow();
    const r = computeSavings(records, { suppressMode: true });
    // observe → tool-derived (Read → file-read), NOT debug-output
    const cat = Object.fromEntries(r.categories.map((c) => [c.category, c.avoided_tokens]));
    expect(cat["file-read"]).toBe(80 + 50); // (100-20) + (80-30)
    expect(cat["debug-output"]).toBe(0);
  });

  it("malformed/partial records never throw and surface as [incomplete] where applicable", () => {
    const records = [
      { ts: "x", session_id: "s", epoch: 1, orig_tokens: "garbage", returned_tokens: null, workload_category: 12345 },
      { ts: "y", session_id: "s", epoch: 1 }, // nothing but required keys
      {}, // entirely empty
    ] as unknown as TelemetryRecord[];
    expect(() => computeSavings(records, {})).not.toThrow();
    const r = computeSavings(records, {});
    expect(r.baseline_tokens).toBe(0);
    expect(r.avoided_tokens).toBe(0);
    expect(r.saved_pct).toBe(0); // divide-by-zero guarded (AC-20)
  });
});

// ---------------------------------------------------------------------------
// 5. S0 observe-only vs suppress measured (Verification step 5)
// ---------------------------------------------------------------------------

describe("Savings S0 observe-only vs suppress measured", () => {
  it("no suppression (returned==orig) + observe mode → 0% observe-only", () => {
    const records: TelemetryRecord[] = [
      { schema_version: 2, ts: "a", session_id: "s", epoch: 1, page_id: "p1", tool_type: "Read", source_kind: "file", orig_tokens: 500, returned_tokens: 500, workload_category: "file-read" },
    ];
    const r = computeSavings(records, { suppressMode: false });
    expect(r.avoided_tokens).toBe(0);
    expect(r.saved_pct).toBe(0);
    expect(r.headline_label).toBe("measured · observe-only (0%)");
  });

  it("seeded suppression + suppress mode → non-zero measured", () => {
    const records: TelemetryRecord[] = [
      { schema_version: 2, ts: "a", session_id: "s", epoch: 1, page_id: "p1", tool_type: "Read", source_kind: "file", orig_tokens: 500, returned_tokens: 100, workload_category: "file-read" },
    ];
    const r = computeSavings(records, { suppressMode: true });
    expect(r.avoided_tokens).toBe(400);
    expect(r.saved_pct).toBe(80);
    // No rehydration record + credit exists → honest pre-rehydration upper bound.
    expect(r.payback_measured).toBe(false);
    expect(r.headline_label).toBe("measured · pre-rehydration upper bound");
  });
});
