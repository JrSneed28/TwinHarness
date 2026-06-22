# Probe new-A — dist-scan size-cap blindspot in the production-reality gate

**Reproduced: DEFECT CLOSED — the gate now REFUSES.** The old RED (a >2 MB `dist/` file
carrying an unledgered `placeholder` token, silently skipped at the legacy `sim.ts:484`,
gate `{ok:true}` exit 0) no longer reproduces. Against the NEW two-tier scan the SAME
2.64 MB fixture is now DEEP-INSPECTED (it is under the 8 MB per-file cap), its token is
FOUND, and the gate BLOCKS via `unledgered_simulation_in_dist`. Separately, any file the
scan genuinely cannot deep-inspect is now `unobserved` (≠ clean) and BLOCKS via the NEW
`scan_coverage_incomplete` rung — the old silent-skip path is gone.

Driver: `node A:/TwinHarness/dist/cli.js <args>` with `cwd = $SCRATCH`
(`/tmp/thprobe-scancap-v3j5aC`, throwaway, since removed). The dist is freshly built and
reflects the slice-2a/2b behavior.

---

## Mechanism (source, exact NEW lines)

The legacy single per-file cap (`SCAN_FILE_MAX_BYTES = 2 MB`) and its silent `continue`
(old `sim.ts:484`) are RETIRED. The scan is now two-tier and fail-closed:

- `src/commands/sim.ts:792` — `scanForSimulationHits(paths, opts?): ScanCoverage` is the
  shared core (used by BOTH `th sim scan` and the gate's condition 4/5). Precedence:
  `opts.limits` > env override > `DEFAULT_SCAN_LIMITS`.
- `src/commands/sim.ts:640` — `enumerateAndHash`: Pass A ALWAYS streaming-content-hashes
  EVERY `dist/` path (`hashFileStreaming`), sorted by relpath; a Pass-A read failure →
  `unobserved{read_error}` (digest null). Nothing is ever silently dropped.
- `src/commands/sim.ts:683` — `deepInspect`: Pass B token-scans each enumerated file UNDER
  the layered budget. The four fail-closed reasons (NO silent `continue`):
  watchdog (`:707`), read_error (`:715/:723/:742`), per-file `file_limit` (`:727`,
  `size > DEEP_INSPECT_FILE_MAX_BYTES = 8 MB` at `:401`), aggregate `aggregate_limit`
  (`:732`, `DEEP_INSPECT_AGGREGATE_MAX_BYTES = 64 MB` at `:403`).
- `src/commands/sim.ts:822` — `uncoveredAfterExceptions(paths, unobserved)`: the residual
  `unobserved` set minus any path exonerated by a VALID external-signed exception ack
  (`readScanExceptionValidated(...).status === "accepted"`). A `null`-digest entry can
  never be scoped by an ack, so it always stays uncovered (fail-closed). SHARED by scan
  AND gate, so they can never disagree.
- `src/core/gate-preconditions.ts:449-457` — condition 4 (unchanged intent):
  `const scan = scanForSimulationHits(paths); const unledgered =
  computeUnledgeredDistHitsReceiptAware(paths, entries, scan.distHits);` → block
  `unledgered_simulation_in_dist`. The 2.64 MB fixture's token is now IN `scan.distHits`
  (it was deep-inspected), so this rung bites.
- `src/core/gate-preconditions.ts:459-482` — condition 5 (NEW, BSC-6):
  `const uncovered = uncoveredAfterExceptions(paths, scan.unobserved);` → block
  `scan_coverage_incomplete` with `detail.unobserved[≤20]`, `total`, `reasons`. The gate
  RECOMPUTES this fresh every run and MUST NOT read `scan-completeness.jsonl` to decide —
  trusting a persisted "complete" summary is the exact bug class BSC-6 closes.
- `src/core/gate-preconditions.ts:360` — `if (!isFinalVerification(state.current_stage))
  return PASS;` The whole gate only enforces at `current_stage == final-verification`.

### Isolated UNGROUNDED symbol (now grounded)
The OLD defect: `scan.distHits` was consumed as "every simulation token in dist/" even
though a >2 MB file was absent from it (skipped, indistinguishable from clean) with no
coverage signal on either surface. The NEW design grounds that symbol two ways: (a) the
budget is sized so the 2.64 MB file is actually inspected, so `distHits` IS exhaustive for
it; and (b) for any file that genuinely cannot be inspected, `scan.unobserved` (≠ clean)
is a first-class fail-closed coverage signal the gate consults at condition 5. "Not in
`distHits`" no longer means "clean" — it means EITHER deep-inspected-and-clean OR
`unobserved` (blocking).

---

## Scenario

Fresh `th init --no-ui` project in $SCRATCH whose ENTIRE final-verification ladder is GREEN
EXCEPT the dist scan, so conditions 4 and 5 are the only levers (mirrors the
`greenAtFinalVerification` baseline used by `tests/sim-scan-coverage-gate.test.ts`):
- requirements/plan/test/report docs written; `th artifact register
  docs/10-verification-report.md --version 1`; `th tester record --driver cli-e2e
  --provider sandbox --passed`; `current_stage` forced to `final-verification` via the
  documented `--emergency` raw write so condition 4/5 are live.
- cond 1 (`simulation_unretired`): ledger empty → passes.
- cond 2 (`production_verify_not_green`): no verify commands configured → the
  `verifyCfg.commands.length > 0` guard (gate-preconditions.ts:423) is false → skipped.
- cond 3 (`tester_record_missing`): the Tester record above → passes.

Baseline proof the ladder is green with an EMPTY dist (so big.js / unseen.js are the SOLE
variable below):
```
$ node A:/TwinHarness/dist/cli.js gate production-reality --json
{"ok":true,"gate":"production-reality"}                                 # exit 0
```

---

## Commands + decisive output

### RED→GREEN headline — the ORIGINAL 2.64 MB fixture now BLOCKS (deep-inspect → unledgered)
The identical fixture from the old RED: a 2,640,039-byte file with exactly ONE `placeholder`
token on line 1. Old build: skipped at sim.ts:484, gate `{ok:true}`. NEW build:
```
$ { printf 'const marker = 1; // placeholder value\n'; \
    yes 'const v = 0xABCDEF01;' | head -n 120000; } > dist/big.js
$ wc -c dist/big.js
2640039                                                                 # > 2 MB, < 8 MB cap
$ grep -niE 'mock|fake|stub|fixture|placeholder|demo|todo|canned|hardcoded' dist/big.js
1:const marker = 1; // placeholder value                                # exactly ONE token

$ node A:/TwinHarness/dist/cli.js sim scan --json
{"cmd":"sim scan","distHits":1,"testHits":0,"unledgered":1,"enumerated":1,"unobserved":0,"limitHit":false}
                                       # DEEP-INSPECTED (enumerated:1, unobserved:0); token FOUND

$ node A:/TwinHarness/dist/cli.js gate production-reality --json
{"ok":false,"gate":"production-reality","error":"unledgered_simulation_in_dist",
 "hits":[{"file":"dist/big.js","line":1,"token":"placeholder",
          "text":"const marker = 1; // placeholder value"}],"total":1}   # exit 1 — BLOCKS
```
The old silent-skip is GONE: the 2.64 MB file is observed, the token surfaces in
`scan.distHits`, and condition 4 refuses. (Old RED at this exact step: `{"ok":true}` exit 0.)

### NEW coverage rung — a genuinely un-deep-inspectable file BLOCKS via `scan_coverage_incomplete`
To exhibit the NEW fail-closed coverage block, drive a tiny TOKEN-FREE file `unobserved`
via the fail-safe env seam (`TH_SCAN_FILE_MAX_BYTES=10`; smaller budget ⇒ more unobserved,
never lets a file pass — see slice2-EXECUTION-PROGRESS.md env-seam note). A >8 MB real file
reaches the same `file_limit` reason without the env override.
```
$ rm -f dist/big.js
$ printf 'const a = 1;\n' > dist/unseen.js          # 13 bytes, NO simulation token
$ grep -niE 'mock|fake|stub|...' dist/unseen.js     # (no tokens)

$ TH_SCAN_FILE_MAX_BYTES=10 node A:/TwinHarness/dist/cli.js sim scan
{"cmd":"sim scan","distHits":0,"testHits":0,"unledgered":0,"enumerated":1,"unobserved":1,"limitHit":true}
No simulation patterns found in dist/.
SCAN COVERAGE INCOMPLETE — 1 dist/ file(s) could not be deep-inspected (the gate BLOCKS on these):
  dist/unseen.js  [file_limit]                       # human surface NAMES the gap (no silent skip)

$ TH_SCAN_FILE_MAX_BYTES=10 node A:/TwinHarness/dist/cli.js gate production-reality --json
{"ok":false,"gate":"production-reality","error":"scan_coverage_incomplete",
 "unobserved":[{"path":"dist/unseen.js","reason":"file_limit"}],"total":1,
 "reasons":["file_limit"]}                            # exit 1 — BLOCKS on coverage
```

### Isolation — the env override is the SOLE rung-5 lever
```
# SAME file, NO override → it is deep-inspected (13 B < 8 MB default) and the gate is GREEN:
$ node A:/TwinHarness/dist/cli.js gate production-reality --json
{"ok":true,"gate":"production-reality"}              # exit 0
```
With the default 8 MB budget the file is observed and clean, so the gate passes; the ONLY
reason it blocks above is the forced 10-byte cap making it `unobserved{file_limit}`. The
green ladder (tester record, registered report, empty sim ledger) held throughout — the
dist scan was the single variable.

---

## Result classification
**DEFECT CLOSED.** The old RED — a >2 MB token-bearing `dist/` file silently skipped, gate
`{ok:true}` exit 0 — is unreachable on the new build. The identical 2.64 MB fixture is now
deep-inspected and BLOCKS (`unledgered_simulation_in_dist`, exit 1). Any file the scan
cannot deep-inspect is `unobserved` and BLOCKS via the NEW `scan_coverage_incomplete` rung
(exit 1), surfaced on BOTH the machine gate AND the human `th sim scan`. "Not in
`distHits`" no longer certifies "clean": it is either inspected-clean or a named,
gate-blocking coverage gap. The companion reasons (aggregate / watchdog / read_error) and
the external-signed exception independence control are reproduced in the sibling probes
(`new-b2-aggregate`, `new-c-watchdog`, `new-d-readerror`, `new-e-forged-exception`).

---

## Byte-clean assertion
This probe runs the REAL CLI read-only against a throwaway scratch project OUTSIDE the repo
and writes ONLY this `.omc/audit/probes/...` evidence file (the `.omc/audit/probes/` tree is
gitignored). It modifies NOTHING under `src/`, `dist/`, `tests/`, `agents/`, `templates/`,
or `schemas/`.
```
$ git -C A:/TwinHarness status --porcelain -- src dist tests agents templates schemas
 M dist/cli.js
 M dist/commands/sim.js
 M dist/core/gate-preconditions.js
 M dist/core/hash.js
 M dist/core/tool-catalog.js
 M dist/mcp-server.js
 M src/cli.ts
 M src/commands/sim.ts
 M src/core/gate-preconditions.ts
 M src/core/hash.ts
 M src/core/tool-catalog.ts
 M src/mcp-server.ts
 M tests/mcp-write-surface-audit.test.ts
?? dist/core/scan-completeness.js
?? src/core/scan-completeness.ts
?? tests/scan-completeness-concurrency.test.ts
?? tests/scan-completeness.test.ts
?? tests/scan-exception-validate.test.ts
?? tests/sim-scan-coverage-gate.test.ts
?? tests/sim-scan-coverage.test.ts
?? tests/sim-scan-determinism.test.ts
```
The entries listed are the slice-2a/2b BSC-6 FEATURE implementation (source + rebuilt dist +
its test suites) that pre-dates and is the SUBJECT of this probe — every one has an mtime of
~01:16–01:49 today, BEFORE this probe session (~07:05). Running this probe added ZERO new
entries to that set: the diff is byte-identical before and after the reproduction. The only
artifacts this session produced are the evidence.md files under the gitignored
`.omc/audit/probes/`.

## Cleanup
Scratch directory removed: `/tmp/thprobe-scancap-v3j5aC` (verified absent).
