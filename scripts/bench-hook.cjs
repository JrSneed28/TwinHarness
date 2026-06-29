/**
 * bench-hook.cjs — in-process latency benchmark for the ContextPages PostToolUse hook.
 *
 * Measures runHookPostToolContext() call latency in two scenarios:
 *   (a) OBSERVE default (metadata-only, no cold-store write) — env = {}
 *   (b) Raw-store enabled (TH_CONTEXT_RAW_STORE=1) — persists raw objects + retention
 *
 * Usage:
 *   node scripts/bench-hook.cjs
 *   npm run bench:hook
 *
 * NOTE: This measures IN-PROCESS call overhead only. The real Claude Code plugin
 * spawns a fresh `node` process on every PostToolUse hook, adding a per-call
 * Node.js cold-start cost that typically dominates real-world latency (tens to
 * hundreds of ms per hook invocation). That per-spawn cost is NOT measured here.
 */

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { runHookPostToolContext } = require("../dist/commands/hook.js");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const N = 2000; // iterations per scenario

// ---------------------------------------------------------------------------
// Statistics helpers
// ---------------------------------------------------------------------------

/** Convert an array of BigInt nanosecond values to sorted millisecond floats. */
function toSortedMs(samples) {
  return samples.map((ns) => Number(ns) / 1e6).sort((a, b) => a - b);
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(Math.floor((p / 100) * sorted.length), sorted.length - 1);
  return sorted[idx];
}

function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function computeStats(nsArr) {
  const sorted = toSortedMs(nsArr);
  const count = sorted.length;
  return {
    count,
    min: sorted[0] ?? 0,
    median: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    mean: mean(sorted),
    max: sorted[count - 1] ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Disk measurement helpers
// ---------------------------------------------------------------------------

/** Recursively sum file sizes under a directory; returns {count, bytes}. */
function dirStats(dir) {
  let count = 0;
  let bytes = 0;
  if (!fs.existsSync(dir)) return { count, bytes };
  const stack = [dir];
  while (stack.length > 0) {
    const d = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.isFile()) {
        count++;
        try {
          bytes += fs.statSync(full).size;
        } catch {
          /* skip unreadable */
        }
      }
    }
  }
  return { count, bytes };
}

/** Sum bytes of all ledger-*.jsonl files under a directory. */
function ledgerBytes(dir) {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (e.isFile() && e.name.startsWith("ledger-") && e.name.endsWith(".jsonl")) {
      try {
        total += fs.statSync(path.join(dir, e.name)).size;
      } catch {
        /* skip */
      }
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Build a representative PostToolUse input (~2 KB response, varying per iter)
// ---------------------------------------------------------------------------

function makeInput(iter) {
  const filePath = `/home/user/project/src/module_${iter % 50}.ts`;
  // ~2 KB of varied text so content hashes differ across iterations
  const body =
    `// File: ${filePath}\n// Iteration: ${iter}\n` +
    `// This is a representative TypeScript source file read by the agent.\n`.repeat(30) +
    `// Unique marker: ${iter}-${Date.now()}\n`;

  return {
    session_id: "bench-session-001",
    agent_id: "bench-agent-001",
    agent_type: "claude",
    tool_name: "Read",
    tool_input: { file_path: filePath },
    tool_response: body,
    cwd: "/home/user/project",
  };
}

// ---------------------------------------------------------------------------
// Run one scenario
// ---------------------------------------------------------------------------

function runScenario(label, env, tempRoot) {
  console.log(`\n  Running scenario: ${label}  (N=${N})`);

  const samples = [];
  let errors = 0;

  for (let i = 0; i < N; i++) {
    const input = makeInput(i);
    const t0 = process.hrtime.bigint();
    try {
      runHookPostToolContext(tempRoot, input, env);
    } catch {
      errors++;
      // continue — a single failing iteration must not abort the run
      continue;
    }
    const t1 = process.hrtime.bigint();
    samples.push(t1 - t0);
  }

  const stats = computeStats(samples);
  const wallTotal = samples.reduce((s, ns) => s + Number(ns), 0) / 1e6; // ms

  // Measure disk state after the run
  const contextPagesDir = path.join(tempRoot, ".twinharness", "context-pages");
  const objectsDir = path.join(contextPagesDir, "objects");
  const objects = dirStats(objectsDir);
  const lBytes = ledgerBytes(contextPagesDir);

  return {
    label,
    stats,
    wallTotal,
    per1000: (wallTotal / stats.count) * 1000,
    objects,
    lBytes,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Table printing
// ---------------------------------------------------------------------------

function fmt(n, decimals = 3) {
  return n.toFixed(decimals);
}

function fmtBytes(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
}

function printResults(results) {
  console.log("\n");
  console.log("=".repeat(78));
  console.log("  ContextPages PostToolUse Hook — In-Process Latency Benchmark");
  console.log("=".repeat(78));
  console.log(
    `  ${"Scenario".padEnd(36)} ${"Count".padStart(6)} ${"Min".padStart(7)} ` +
      `${"Median".padStart(8)} ${"Mean".padStart(8)} ${"p95".padStart(8)} ` +
      `${"p99".padStart(8)} ${"Max".padStart(8)}  (ms)`
  );
  console.log("-".repeat(78));

  for (const r of results) {
    const s = r.stats;
    console.log(
      `  ${r.label.padEnd(36)} ${String(s.count).padStart(6)} ${fmt(s.min).padStart(7)} ` +
        `${fmt(s.median).padStart(8)} ${fmt(s.mean).padStart(8)} ${fmt(s.p95).padStart(8)} ` +
        `${fmt(s.p99).padStart(8)} ${fmt(s.max).padStart(8)}`
    );
  }

  console.log("=".repeat(78));
  console.log("\n  Disk usage after run (per scenario):");
  console.log("-".repeat(78));
  console.log(
    `  ${"Scenario".padEnd(36)} ${"Cold Objects".padStart(14)} ${"Object Bytes".padStart(14)} ` +
      `${"Ledger Bytes".padStart(14)} ${"Per-1000 wall (ms)".padStart(20)}`
  );
  console.log("-".repeat(78));

  for (const r of results) {
    console.log(
      `  ${r.label.padEnd(36)} ${String(r.objects.count).padStart(14)} ` +
        `${fmtBytes(r.objects.bytes).padStart(14)} ${fmtBytes(r.lBytes).padStart(14)} ` +
        `${fmt(r.per1000, 1).padStart(20)}`
    );
    if (r.errors > 0) {
      console.log(`    *** ${r.errors} iteration(s) threw errors (excluded from stats) ***`);
    }
  }

  console.log("=".repeat(78));
  console.log();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("\nTwinHarness bench-hook.cjs — ContextPages PostToolUse hook latency");
  console.log(`Node ${process.version}  Platform: ${process.platform}  Arch: ${process.arch}`);
  console.log(`Iterations per scenario: ${N}`);

  const results = [];

  // Scenario (a): OBSERVE default — no raw cold-store writes
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "th-bench-a-"));
    try {
      const result = runScenario("(a) OBSERVE default (metadata-only)", {}, tmpDir);
      results.push(result);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  // Scenario (b): Raw-store enabled — persists raw objects + lazy retention
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "th-bench-b-"));
    try {
      const result = runScenario(
        "(b) Raw-store (TH_CONTEXT_RAW_STORE=1)",
        { TH_CONTEXT_RAW_STORE: "1" },
        tmpDir
      );
      results.push(result);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  printResults(results);

  // Machine-readable summary for capture
  console.log("JSON_SUMMARY=" + JSON.stringify(results.map((r) => ({
    label: r.label,
    median_ms: r.stats.median,
    p95_ms: r.stats.p95,
    p99_ms: r.stats.p99,
    mean_ms: r.stats.mean,
    min_ms: r.stats.min,
    max_ms: r.stats.max,
    count: r.stats.count,
    errors: r.errors,
    cold_object_count: r.objects.count,
    cold_object_bytes: r.objects.bytes,
    ledger_bytes: r.lBytes,
    wall_per_1000_ms: r.per1000,
  }))));
}

main().catch((err) => {
  console.error("bench-hook fatal:", err);
  process.exit(1);
});
