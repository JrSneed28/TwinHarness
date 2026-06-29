# Context Pages Hook Performance

## Purpose and Methodology

This document records the measured in-process latency of the ContextPages
`PostToolUse` hook (`runHookPostToolContext`), benchmarked across two scenarios:

- **(a) OBSERVE default** — `env = {}`. No raw cold-store writes. The hook
  hashes the tool response, checks residency via a tail-bounded ledger read,
  and appends a single JSONL record to the ledger shard. This is the
  steady-state cost for most users.
- **(b) Raw-store enabled** — `env = { TH_CONTEXT_RAW_STORE: "1" }`. In
  addition to the ledger write, each unique content hash is persisted as a
  CAS object under `.twinharness/context-pages/objects/`.

The benchmark calls `runHookPostToolContext(root, input, env)` directly,
in-process, timing each call with `process.hrtime.bigint()`. Process startup
is **not** measured. 2000 iterations are run per scenario, each with a fresh
`~2 KB` `Read` tool response with varying file path and body content so that
content hashes differ across iterations and cold-store writes are exercised
when enabled. Each scenario uses its own `fs.mkdtempSync` temp directory,
cleaned up after the run.

**Important: this benchmark does not capture per-call Node.js process spawn
cost.** The real Claude Code plugin integration invokes `node
dist/cli.js hook posttool-context` as a subprocess on every `PostToolUse`
event. That per-call cold start typically adds tens to hundreds of milliseconds
per invocation and completely dominates real-world latency. The numbers below
measure only the in-process logic (hashing, ledger I/O, CAS write), which is
the contribution the hook code itself makes on top of the unavoidable spawn
cost (issue #6 risk item). The companion `scripts/bench-hook-subprocess.cjs`
measures the full end-to-end subprocess path — see
[End-to-End (subprocess) Latency](#end-to-end-subprocess-latency--the-number-users-actually-pay).

---

## Measured Numbers (Linux, in-process)

Environment: Linux 6.18.5, Node.js v22.22.2, x64. Single run of
`node scripts/bench-hook.cjs`, N = 2000 iterations per scenario.

### Latency (milliseconds)

| Scenario                              | Count | Min   | Median | Mean  | p95   | p99   | Max   |
|---------------------------------------|------:|------:|-------:|------:|------:|------:|------:|
| (a) OBSERVE default (metadata-only)   | 2000  | 0.333 | 2.608  | 2.536 | 4.019 | 5.650 | 6.303 |
| (b) Raw-store (TH_CONTEXT_RAW_STORE=1)| 2000  | 0.276 | 2.923  | 2.763 | 3.886 | 5.914 | 6.961 |

The default scenario (a) is broadly comparable to scenario (b). The small
median difference (~0.3 ms) reflects the additional CAS object write in (b);
the p95/p99 ordering can invert between runs due to OS I/O scheduling noise.

---

## Disk Growth per 1000 Calls

| Scenario                              | Cold Objects | Object Bytes | Ledger Bytes | Wall time / 1000 calls |
|---------------------------------------|-------------:|-------------:|-------------:|-----------------------:|
| (a) OBSERVE default (metadata-only)   | 0            | 0 B          | ~505 KB      | ~2,536 ms              |
| (b) Raw-store (TH_CONTEXT_RAW_STORE=1)| ~1000        | ~2.10 MB     | ~505 KB      | ~2,763 ms              |

Ledger growth in scenario (a) is ledger-only: each call appends one JSONL
record (~500 bytes) to a per-scope shard. No cold object files are written.

Scenario (b) additionally writes a CAS object (~2.1 KB each) for every unique
content hash. With 2000 unique hashes across the benchmark run this produces
~4.2 MB of cold-store data and ~2001 object files.

---

## Caveats

- **Single machine / single run.** Numbers were collected on one Linux host;
  variance across hardware will differ.
- **In-process only.** The dominant cost in production is the per-call
  `node` process spawn (tens to hundreds of ms), which this benchmark
  deliberately excludes. Real-world per-hook wall time is the in-process
  numbers above PLUS that spawn overhead.
- **Unmeasured configurations (issue #6 risk list):**
  - Windows — filesystem semantics, path separator handling, and antivirus
    on-access scanning can materially increase write latency.
  - Networked or encrypted filesystems (NFS, eCryptfs, BitLocker) add
    unpredictable I/O overhead per ledger append and CAS write.
  - Highly-parallel agents — concurrent writers to the same ledger shard may
    see contention on JSONL appends (atomic-append semantics are preserved but
    serialization delays are not measured).

---

## End-to-End (subprocess) Latency — the number users actually pay

The in-process numbers above are the hook code's own contribution. The real
Claude Code integration spawns a **fresh `node dist/cli.js hook
posttool-context` process per `PostToolUse` event**, so the cost the user pays
includes Node startup, module loading, CLI arg parsing, stdin read + JSON parse,
the hook work, stdout serialization, and process exit. `scripts/bench-hook-subprocess.cjs`
measures that full path by spawning the built CLI once per invocation.

Environment: Linux 6.18.5, Node.js v22.22.2, x64. `BENCH_N=60 BENCH_SEED=3000
node scripts/bench-hook-subprocess.cjs` (representative single run — absolute
values are host-dependent and will be higher on slower disks / cold caches):

| Scenario                          | Cold (ms) | Median (ms) | Mean (ms) | p95 (ms) | p99 (ms) |
|-----------------------------------|----------:|------------:|----------:|---------:|---------:|
| (a) metadata-only, empty history  |    ~161   |    ~162     |   ~163    |  ~177    |  ~186    |
| (b) metadata-only, large history  |    ~170   |    ~168     |   ~171    |  ~191    |  ~197    |
| (c) raw-store, empty history      |    ~164   |    ~165     |   ~165    |  ~173    |  ~183    |

**The headline finding:** end-to-end median (~162 ms) is roughly **60× the
in-process median (~2.6 ms)** on the same host. Node process startup, not the
hook logic, dominates — exactly the risk item #6 flags. A large pre-seeded
ledger (scenario b, 3,000 records) adds only a few ms over the empty case
(the tail-bounded reader is doing its job), and raw-store (scenario c) is within
noise of metadata-only. **Projected wall-clock for 1,000 PostToolUse events:
~160 s of cumulative subprocess time** — minutes of latency spread across a
session, almost all of it Node cold-start.

This confirms the optimization target: reduce per-call *process spawn* cost
(persistent daemon, long-lived MCP path, batched telemetry, or narrower hook
event matching), not the already-cheap in-process logic.

> **Still unmeasured (cross-platform).** These are Linux/CI numbers. Windows
> with Defender on-access scanning, macOS Gatekeeper/notarization checks,
> network/encrypted filesystems, and many concurrent agents can each add cost
> this single-host run cannot see. Treat the table as a floor.

## How to Reproduce

In-process (hook logic only):

```
node scripts/bench-hook.cjs
# or, if the npm script is available:
npm run bench:hook
```

End-to-end (real subprocess spawn per call; dist/ must be built):

```
npm run build
node scripts/bench-hook-subprocess.cjs
# tune iteration count / seeded history:
BENCH_N=200 BENCH_SEED=5000 node scripts/bench-hook-subprocess.cjs
# or, if the npm script is available:
npm run bench:hook:subprocess
```

The scripts create isolated temp directories, run with varying synthetic
inputs, and print a summary table plus a JSON summary line.

---

## Interpreting Results

Scenario (a) is the **default** for all users (issue #4 privacy-by-default).
It avoids the cold-store CAS write on every call, so ledger growth is
strictly append-only and object storage remains at zero. This is the
steady-state cost most agents will experience.

Scenario (b) (`TH_CONTEXT_RAW_STORE=1`) is opt-in and adds a CAS object write
per unique content hash. It is intended for use cases that require exact
suppression or offline rehydration of raw tool responses, and it incurs
proportional disk growth (roughly 2 KB per unique tool response).

The per-call process spawn cost (not measured here) is the real bottleneck for
interactive use. Efforts to reduce hook invocation latency should focus on
that layer first — for example, keeping a persistent daemon or using the MCP
server surface — rather than optimizing the in-process logic, which already
runs in low single-digit milliseconds.
