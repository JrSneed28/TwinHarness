/**
 * bench-hook-subprocess.cjs — END-TO-END latency benchmark for the ContextPages
 * PostToolUse hook, measured the way Claude Code actually runs it: a FRESH
 * `node dist/cli.js hook posttool-context` process per invocation, fed the hook
 * payload on stdin.
 *
 * This is the companion to the in-process bench-hook.cjs. Where that one isolates
 * the call cost of runHookPostToolContext(), this one measures the FULL per-call
 * cost the user pays: Node startup, module loading, CLI arg parsing, stdin read +
 * JSON parse, the hook work, stdout serialization, and process exit. On most
 * machines the Node cold-start dominates and is exactly the cost the in-process
 * bench cannot see (finding #6).
 *
 * Scenarios:
 *   (a) metadata-only, empty ledger history
 *   (b) metadata-only, LARGE pre-seeded ledger history (tail-read cost under load)
 *   (c) raw-store enabled (TH_CONTEXT_RAW_STORE=1), empty history
 *
 * It reports cold (first call) vs warm (steady-state) median/p95/p99 and the
 * projected wall-clock for 1,000 calls.
 *
 * Usage:
 *   npm run build            # dist/ must exist and be current
 *   node scripts/bench-hook-subprocess.cjs
 *   BENCH_N=100 BENCH_SEED=5000 node scripts/bench-hook-subprocess.cjs
 *
 * NOTE: This measures THIS host only. Per the finding, Windows+Defender, macOS
 * Gatekeeper, network/encrypted filesystems, and concurrent agents can each add
 * cost not captured on a single Linux CI box — the numbers here are a floor, not
 * a cross-platform guarantee.
 */

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const CLI = path.join(__dirname, "..", "dist", "cli.js");
if (!fs.existsSync(CLI)) {
  console.error(`dist CLI not found at ${CLI} — run \`npm run build\` first.`);
  process.exit(1);
}

const N = Number(process.env.BENCH_N || 200); // subprocess invocations per scenario
const SEED = Number(process.env.BENCH_SEED || 5000); // records pre-seeded for the "large history" scenario

// In-process seeder (fast) so we can build a large ledger without paying N spawns.
let seeder;
try {
  seeder = require("../dist/commands/hook.js").runHookPostToolContext;
} catch {
  seeder = null;
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

function pct(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(Math.floor((p / 100) * sorted.length), sorted.length - 1)];
}
function mean(a) {
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
}
function stats(msArr) {
  const s = [...msArr].sort((a, b) => a - b);
  return {
    count: s.length,
    min: s[0] ?? 0,
    median: pct(s, 50),
    p95: pct(s, 95),
    p99: pct(s, 99),
    mean: mean(s),
    max: s[s.length - 1] ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

function makePayload(iter) {
  const filePath = `/home/user/project/src/module_${iter}.ts`;
  const body =
    `// File: ${filePath}\n// Iteration: ${iter}\n` +
    `// Representative TypeScript source read by the agent.\n`.repeat(30) +
    `// Unique marker: ${iter}\n`;
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
// One subprocess invocation → wall-clock ms (spawn → exit)
// ---------------------------------------------------------------------------

function invokeOnce(root, iter, env) {
  const input = JSON.stringify(makePayload(iter));
  const t0 = process.hrtime.bigint();
  const res = spawnSync(process.execPath, [CLI, "hook", "posttool-context", "--cwd", root], {
    input,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  const t1 = process.hrtime.bigint();
  return { ms: Number(t1 - t0) / 1e6, status: res.status, error: res.error };
}

function seedHistory(root, count, env) {
  if (!seeder || count <= 0) return;
  for (let i = 0; i < count; i++) {
    try {
      seeder(root, makePayload(100000 + i), env);
    } catch {
      /* ignore seed errors */
    }
  }
}

function runScenario(label, env, seedCount) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "th-bench-sp-"));
  try {
    if (seedCount > 0) seedHistory(root, seedCount, env);

    // Cold = the very first subprocess (caches unwarmed). Warm = the rest.
    const cold = invokeOnce(root, 0, env);
    const warm = [];
    let errors = 0;
    for (let i = 1; i <= N; i++) {
      const r = invokeOnce(root, i, env);
      if (r.error || r.status !== 0) errors++;
      else warm.push(r.ms);
    }
    const w = stats(warm);
    return {
      label,
      seedCount,
      cold_ms: cold.ms,
      warm: w,
      errors,
      per1000_ms: w.median * 1000,
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function fmt(n, d = 2) {
  return n.toFixed(d);
}

function main() {
  console.log("\nTwinHarness bench-hook-subprocess.cjs — END-TO-END PostToolUse hook latency");
  console.log(`Node ${process.version}  Platform: ${process.platform}  Arch: ${process.arch}`);
  console.log(`Subprocess invocations per scenario: ${N}   Large-history seed: ${SEED}`);
  if (!seeder) console.log("WARNING: could not load in-process seeder — large-history scenario will be unseeded.");

  const results = [
    runScenario("(a) metadata-only, empty history", {}, 0),
    runScenario("(b) metadata-only, large history", {}, SEED),
    runScenario("(c) raw-store, empty history", { TH_CONTEXT_RAW_STORE: "1" }, 0),
  ];

  console.log("\n" + "=".repeat(86));
  console.log("  ContextPages PostToolUse — Subprocess (end-to-end) Latency");
  console.log("=".repeat(86));
  console.log(
    `  ${"Scenario".padEnd(34)} ${"Cold".padStart(8)} ${"Median".padStart(8)} ` +
      `${"Mean".padStart(8)} ${"p95".padStart(8)} ${"p99".padStart(8)} ${"Max".padStart(8)}  (ms)`
  );
  console.log("-".repeat(86));
  for (const r of results) {
    const s = r.warm;
    console.log(
      `  ${r.label.padEnd(34)} ${fmt(r.cold_ms).padStart(8)} ${fmt(s.median).padStart(8)} ` +
        `${fmt(s.mean).padStart(8)} ${fmt(s.p95).padStart(8)} ${fmt(s.p99).padStart(8)} ${fmt(s.max).padStart(8)}`
    );
    if (r.errors > 0) console.log(`    *** ${r.errors} invocation(s) failed (excluded) ***`);
  }
  console.log("-".repeat(86));
  console.log("  Projected wall-clock for 1,000 calls (warm median × 1000):");
  for (const r of results) {
    console.log(`    ${r.label.padEnd(34)} ${fmt(r.per1000_ms / 1000, 2).padStart(8)} s`);
  }
  console.log("=".repeat(86) + "\n");

  console.log("JSON_SUMMARY=" + JSON.stringify(results.map((r) => ({
    label: r.label,
    seed: r.seedCount,
    cold_ms: r.cold_ms,
    warm_median_ms: r.warm.median,
    warm_mean_ms: r.warm.mean,
    warm_p95_ms: r.warm.p95,
    warm_p99_ms: r.warm.p99,
    warm_max_ms: r.warm.max,
    errors: r.errors,
    per_1000_calls_s: r.per1000_ms / 1000,
  }))));
}

main();
